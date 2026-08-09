import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installCommand } from '../../src/commands/install.js';
import * as commonModule from '../../src/commands/common.js';
import {
  readDynamicArtifactDiagnosticCacheAt,
  readInstallRecordFileAt,
} from '../../src/install-state/facade.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PluginMeta,
  StatusReport,
} from '../../src/types.js';
import { calculateFileDigest, calculatePluginBundleFingerprint } from '../../src/utils/plugin-scripts.js';
import { createInstallStateFixtureEnv } from '../helpers/install-state-projection-fixtures.js';
import { writeMinimalPluginInstallStateFixture } from '../helpers/minimal-plugin-install-state-fixtures.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function digest(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function createPluginMeta(options: {
  rootDir: string;
  pluginName: string;
  version?: string;
  installLifecycleExitCode?: number;
}): Promise<PluginMeta> {
  const pluginRoot = path.join(options.rootDir, 'catalog', options.pluginName);
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = {
    name: options.pluginName,
    version: options.version ?? '1.0.0',
    description: `${options.pluginName} plugin`,
    compatibility: {
      aw: {
        minVersion: '0.0.0',
      },
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    },
    ...(options.installLifecycleExitCode === undefined
      ? {}
      : {
          scripts: {
            lifecycle: {
              install: {
                default: {
                  runner: 'node',
                  path: './scripts/install.mjs',
                },
              },
            },
          },
        }),
  };
  await fs.ensureDir(path.dirname(manifestPath));
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  if (options.installLifecycleExitCode !== undefined) {
    const lifecyclePath = path.join(pluginRoot, 'scripts', 'install.mjs');
    await fs.ensureDir(path.dirname(lifecyclePath));
    await fs.writeFile(
      lifecyclePath,
      `process.exit(${options.installLifecycleExitCode});\n`,
      'utf8',
    );
  }
  return {
    rootDir: pluginRoot,
    manifestPath,
    manifest,
  };
}

async function alignFixtureSourceToPlugin(options: {
  installRecordPath?: string;
  projectIdentityPath?: string;
  plugin: PluginMeta;
}): Promise<void> {
  const source = {
    pluginVersion: options.plugin.manifest.version,
    manifestDigest: await calculateFileDigest(options.plugin.manifestPath),
    bundleFingerprint: await calculatePluginBundleFingerprint(options.plugin.rootDir),
  };
  if (options.installRecordPath && await fs.pathExists(options.installRecordPath)) {
    const record = await fs.readJson(options.installRecordPath) as {
      record: { source: typeof source };
    } & Record<string, unknown>;
    record.record.source = source;
    await fs.writeJson(options.installRecordPath, record, { spaces: 2 });
  }
  if (options.projectIdentityPath && await fs.pathExists(options.projectIdentityPath)) {
    const identity = await fs.readJson(options.projectIdentityPath) as {
      source: typeof source;
    } & Record<string, unknown>;
    identity.source = source;
    await fs.writeJson(options.projectIdentityPath, identity, { spaces: 2 });
  }
}

class FakeRepairAdapter implements PlatformAdapter {
  readonly name = 'codex' as const;
  readonly installPlugin = vi.fn(async () => undefined);
  readonly installExtensions = vi.fn(async () => [] as GeneratedArtifact[]);

  async detect(): Promise<boolean> {
    return true;
  }

  async uninstallPlugin(): Promise<void> {}

  async uninstallExtensions(): Promise<void> {}

  async upgradePlugin(): Promise<void> {}

  async status(): Promise<StatusReport> {
    return {
      platform: 'codex',
      scope: 'user',
      initialized: true,
      plugins: [{
        name: 'synthetic',
        installed: true,
        managedArtifacts: [],
        driftWarnings: [],
      } as never],
    };
  }
}

class FakeClaudeRepairAdapter implements PlatformAdapter {
  readonly name = 'claude' as const;

  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(): Promise<void> {}

  async uninstallPlugin(): Promise<void> {}

  async installExtensions(): Promise<GeneratedArtifact[]> {
    return [];
  }

  async uninstallExtensions(): Promise<void> {}

  async upgradePlugin(): Promise<void> {}

  async status(): Promise<StatusReport> {
    return {
      platform: 'claude',
      scope: 'user',
      initialized: true,
      plugins: [],
    };
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('install --adopt-existing migration', () => {
  it('adopts existing project artifacts through install and records the first-local-record lifecycle reason', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-adopt-existing-'),
      scenario: 'freshCloneProject',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
      installLifecycleExitCode: 0,
    });
    const skillKey = 'commit';
    const bundledSkillRoot = path.join(plugin.rootDir, 'codex', 'skills', skillKey);
    const projectSkillRoot = path.join(fixture.paths.repoRoot, '.agents', 'skills', skillKey);
    const nativeMetadata = 'policy:\n  allow_implicit_invocation: false\n';
    await fs.outputFile(path.join(bundledSkillRoot, 'SKILL.md'), '# Commit\n');
    await fs.outputFile(path.join(bundledSkillRoot, 'agents', 'openai.yaml'), nativeMetadata);
    await fs.outputFile(path.join(projectSkillRoot, 'SKILL.md'), '# Commit\n');
    await fs.outputFile(path.join(projectSkillRoot, 'agents', 'openai.yaml'), nativeMetadata);
    const identityBeforeAdopt = await fs.readJson(fixture.files.projectIdentityPath);
    identityBeforeAdopt.artifacts.push({
      kind: 'skill',
      platform: 'codex',
      path: path.relative(fixture.paths.repoRoot, projectSkillRoot).split(path.sep).join('/'),
      artifactKey: skillKey,
      ownershipMarker: skillKey,
    });
    await fs.writeJson(fixture.files.projectIdentityPath, identityBeforeAdopt, { spaces: 2 });
    await alignFixtureSourceToPlugin({
      projectIdentityPath: fixture.files.projectIdentityPath,
      plugin,
    });

    const adapter = new FakeRepairAdapter();
    const catalogResolution = {
      rootDir: path.dirname(plugin.rootDir),
      source: 'embedded' as const,
    };
    const prepareTargets = vi.spyOn(commonModule, 'preparePluginTargetsForCommand')
      .mockResolvedValue({
        ledger: {} as never,
        targets: [{
          pluginName: plugin.manifest.name,
          plugin,
          currentPlugin: plugin,
          source: 'currentCatalog',
        }],
        warnings: [],
        catalog: catalogResolution,
      });
    adapter.installExtensions.mockImplementation(async () => {
      await fs.outputFile(fixture.target.repoArtifactPath, fixture.target.repoArtifactContent, 'utf8');
      return [{
        path: fixture.target.repoArtifactPath,
        kind: 'instruction',
        platform: 'codex',
        id: `${fixture.target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        artifactKey: `${fixture.target.pluginSlug}.skill`,
        contentDigest: digest(fixture.target.repoArtifactContent),
      }];
    });

    const result = await installCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
        adoptExisting: true,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: 'codex',
          scope: 'project',
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
          currentPlugin: plugin,
        }],
      } as never,
    );

    expect(result.receiptDetails?.adoptExistingLifecycleReason).toBe('adoptExistingFirstLocalRecord');
    expect(prepareTargets).toHaveBeenCalledTimes(1);
    expect(adapter.installExtensions.mock.calls[0]![2]?.catalogResolution).toBe(catalogResolution);
    expect(result.receiptTargets).toEqual([
      expect.objectContaining({
        plugin: fixture.target.location.plugin,
        platform: 'codex',
        scope: 'project',
        requested: true,
      }),
    ]);
    expect(result.targetResults).toEqual([
      expect.objectContaining({
        action: 'install',
        state: 'completed',
      }),
    ]);
    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(true);
    await expect(fs.pathExists(fixture.files.diagnosticCachePath)).resolves.toBe(true);
    await expect(fs.pathExists(fixture.files.projectIdentityPath)).resolves.toBe(true);
    const cacheRead = await readDynamicArtifactDiagnosticCacheAt(fixture.files.diagnosticCachePath, {
      expectedLocation: fixture.target.location,
    });
    expect(cacheRead).toMatchObject({
      status: 'ok',
      value: {
        artifacts: [
          {
            lastRefresh: {
              event: 'install',
            },
          },
        ],
      },
    });
    expect(JSON.stringify(cacheRead)).not.toContain('repair');
    const recordRead = await readInstallRecordFileAt(fixture.files.installRecordPath, {
      env: createInstallStateFixtureEnv(fixture.paths),
    });
    expect(recordRead).toMatchObject({
      status: 'ok',
      value: {
        record: {
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              kind: 'skill',
              platform: 'codex',
              path: projectSkillRoot,
              artifactKey: skillKey,
            }),
          ]),
        },
      },
    });
    await expect(
      fs.readFile(path.join(projectSkillRoot, 'agents', 'openai.yaml'), 'utf8'),
    ).resolves.toBe(nativeMetadata);
  });

  it('fails install --adopt-existing outside project scope before writing local state', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-adopt-user-'),
      scenario: 'freshCloneProject',
    });

    await expect(
      installCommand(
        [fixture.target.location.plugin],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
          adoptExisting: true,
        },
        {
          env: createInstallStateFixtureEnv(fixture.paths),
        } as never,
      ),
    ).rejects.toThrow('`install --adopt-existing` 只允许 `--scope project`。');

    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(false);
    await expect(fs.pathExists(fixture.files.diagnosticCachePath)).resolves.toBe(false);
  });

  it('fails install --adopt-existing when the project already has a local install record', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-adopt-installed-'),
      scenario: 'installed',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
    });
    await alignFixtureSourceToPlugin({
      installRecordPath: fixture.files.installRecordPath,
      projectIdentityPath: fixture.files.projectIdentityPath,
      plugin,
    });

    await expect(
      installCommand(
        [fixture.target.location.plugin],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
          adoptExisting: true,
        },
        {
          env: createInstallStateFixtureEnv(fixture.paths),
          adapters: {
            codex: new FakeRepairAdapter(),
            claude: new FakeClaudeRepairAdapter(),
          },
          p7Targets: [{
            pluginName: fixture.target.location.plugin,
            platform: 'codex',
            scope: 'project',
            projectKey: fixture.target.location.projectKey ?? undefined,
            executionCwd: fixture.paths.repoRoot,
            currentPlugin: plugin,
          }],
        } as never,
      ),
    ).rejects.toThrow('当前已经有本机 install record');

    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(true);
  });

  it('fails install --adopt-existing when ownership cannot be verified and keeps repo-visible artifacts untouched', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-adopt-unverifiable-'),
      scenario: 'freshCloneProject',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
    });
    await fs.remove(fixture.files.projectIdentityPath);
    await fs.writeFile(fixture.target.repoArtifactPath, `${fixture.target.repoArtifactContent}drifted\n`, 'utf8');
    const beforeArtifact = await fs.readFile(fixture.target.repoArtifactPath, 'utf8');
    const adapter = new FakeRepairAdapter();

    await expect(
      installCommand(
        [fixture.target.location.plugin],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
          adoptExisting: true,
        },
        {
          env: createInstallStateFixtureEnv(fixture.paths),
          adapters: {
            codex: adapter,
            claude: new FakeClaudeRepairAdapter(),
          },
          p7Targets: [{
            pluginName: fixture.target.location.plugin,
            platform: 'codex',
            scope: 'project',
            projectKey: fixture.target.location.projectKey ?? undefined,
            executionCwd: fixture.paths.repoRoot,
            currentPlugin: plugin,
          }],
          p7Collect: async () => ({
            target: {
              pluginName: fixture.target.location.plugin,
              platform: 'codex',
              scope: 'project',
              projectKey: fixture.target.location.projectKey ?? undefined,
              executionCwd: fixture.paths.repoRoot,
              currentPlugin: plugin,
            },
            location: fixture.target.location,
            evidence: {
              installRecord: {
                present: false,
              },
              projectSharedIdentity: {
                attempted: true,
                read: {
                  status: 'missing',
                  path: fixture.files.projectIdentityPath,
                  code: 'missing',
                  error: 'missing',
                },
              },
              adoptable: {
                possible: false,
                source: 'none',
                artifactEvidencePresent: true,
                blockers: ['artifactIdentityUnverifiable'],
              },
              residualEvidence: {
                repoVisibleArtifactPresent: true,
              },
            },
            projection: {
              adoptExistingAvailable: false,
            },
            currentCatalog: null,
            deepDiagnose: {
              attempted: false,
              rendered: false,
              artifacts: [],
            },
            summary: 'ownership unverifiable',
            nextSteps: [],
            findings: [],
            dependencyIndexActions: [],
            forceCleanup: {
              required: false,
              backupItems: [],
            },
          }),
        } as never,
      ),
    ).rejects.toThrow('归属无法验证');

    expect(adapter.installExtensions).not.toHaveBeenCalled();
    await expect(fs.readFile(fixture.target.repoArtifactPath, 'utf8')).resolves.toBe(beforeArtifact);
    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(false);
  });
});
