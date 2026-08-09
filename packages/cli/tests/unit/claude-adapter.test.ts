import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ClaudeAdapter,
  applyClaudeInstallLedger,
  applyClaudeUninstallLedger,
  pruneClaudeTrackedArtifacts,
} from '../../src/adapters/claude.js';
import type {
  CatalogResolution,
  InstalledLedger,
  PluginMeta,
  StatusReport,
} from '../../src/types.js';
import {
  createAvailableLedger,
  initializeLocalMarketplace,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import * as pluginCatalogModule from '../../src/utils/plugin-catalog.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import {
  resolveClaudePaths,
  resolveClaudeProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { upsertTrackingRecord } from '../../src/utils/tracking.js';
import {
  writeInstallRecordFileAt,
  writeProjectArtifactIdentityFileAt,
} from '../../src/install-state/facade.js';
import { createRecordId, createSharedIdentityId } from '../../src/install-state/ids.js';
import {
  createProjectArtifactSharedLocator,
  getInstallRecordPath,
  getProjectArtifactSharedIdentityPath,
  resolveProjectArtifactProjectRoot,
  resolveProjectScopeRepoRoot,
} from '../../src/install-state/paths.js';
import type { PluginLocation } from '../../src/install-state/types.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{ repoRoot: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-claude-adapter-'));
  tempDirs.push(root);
  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  return {
    repoRoot,
    env: {
      ...process.env,
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    },
  };
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

async function setupLocalMarketplace(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
  await initializeLocalMarketplace({ force: true, env });
}

async function removePluginFromLocalMarketplace(
  awHome: string,
  pluginName: string,
): Promise<void> {
  await fs.remove(path.join(awHome, 'plugins', pluginName));
  for (const manifestPath of [
    path.join(awHome, '.claude-plugin', 'marketplace.json'),
    path.join(awHome, '.agents', 'plugins', 'marketplace.json'),
  ]) {
    const manifest = await fs.readJson(manifestPath);
    manifest.plugins = (manifest.plugins ?? []).filter(
      (entry: { name?: string }) => entry.name !== pluginName,
    );
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  }
}

async function createDynamicClaudePlugin(
  root: string,
  state: 'present' | 'disabled' = 'present',
): Promise<PluginMeta> {
  const sourceRoot = path.join(root, 'dynamic-claude-source');
  const bundleRoot = path.join(root, 'dynamic-claude-bundle');
  await fs.outputJson(path.join(sourceRoot, '.agents-plugin', 'plugin.json'), {
    name: 'dynamic-claude',
    version: '0.1.0',
    compatibility: { aw: { minVersion: '1.0.0-beta.30' } },
    description: 'Dynamic Claude skill fixture',
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CLAUDE'],
      },
    },
    scripts: {
      artifacts: {
        render: {
          runner: 'node',
          path: './scripts/render-artifacts.mjs',
        },
      },
    },
    artifacts: {
      targets: [{
        id: 'dynamic-claude-skill',
        platform: 'claude',
        scopes: ['user', 'project'],
        target: 'claude.skill',
        states: [state],
        refreshKeys: [],
        skillKey: 'dynamic-claude',
        sourceDirs: ['./templates/common', './templates/claude'],
      }],
    },
  }, { spaces: 2 });
  await fs.outputFile(
    path.join(sourceRoot, 'scripts', 'render-artifacts.mjs'),
    [
      'import { readFileSync } from "node:fs";',
      'const context = JSON.parse(readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'if (context.event === "refresh" && !context.previousArtifacts.some((artifact) => artifact.id === "dynamic-claude-skill")) {',
      '  throw new Error("missing previous dynamic Claude artifact");',
      '}',
      'console.log(JSON.stringify({',
      '  version: 2,',
      '  artifacts: [{',
      '    id: "dynamic-claude-skill",',
      '    platform: "claude",',
      '    target: "claude.skill",',
      '    kind: "skill",',
      `    state: ${JSON.stringify(state)},`,
      '    skillKey: "dynamic-claude",',
      '    refreshKeys: [],',
      ...(state === 'present'
        ? ['    content: { files: { "references/dynamic.md": "dynamic\\n" } }']
        : ['    disabledReason: "config"']),
      '  }]',
      '}));',
    ].join('\n'),
  );
  await fs.outputFile(
    path.join(sourceRoot, 'templates', 'common', 'SKILL.md'),
    '---\nname: dynamic-claude\ndescription: Dynamic Claude skill\ndisable-model-invocation: false\nuser-invocable: true\n---\nCommon\n',
  );
  await fs.outputFile(
    path.join(sourceRoot, 'templates', 'common', 'references', 'shared.md'),
    'common\n',
  );
  await fs.outputFile(
    path.join(sourceRoot, 'templates', 'common', 'assets', 'icon.bin'),
    Buffer.from([0, 255, 1]),
  );
  await fs.outputFile(
    path.join(sourceRoot, 'templates', 'claude', 'references', 'shared.md'),
    'claude\n',
  );

  const sourcePlugin = await readPluginManifest(sourceRoot);
  await bundleLocalPlugin(sourcePlugin, bundleRoot);
  return readPluginManifest(bundleRoot, { mode: 'bundle' });
}

function createStatusReport(catalogCompatibility?: 'current' | 'missing' | 'capabilityChanged'): StatusReport {
  return {
    platform: 'claude',
    scope: 'project',
    initialized: true,
    plugins: [
      {
        pluginName: 'git-commit',
        native: {
          marketplaceRegistered: true,
          pluginAvailable: true,
          pluginInstalled: true,
          version: '0.1.0',
        },
        generatedArtifacts: [],
        driftWarnings: [],
        scopeInitialized: 'yes',
        catalogCompatibility,
        platformRuntimeEvidence: {
          present: false,
        },
        platformNativeFallbackEvidence: {
          present: false,
        },
        scopeManagedEvidence: {
          ledger: true,
          tracking: false,
          sharedNativeRef: false,
        },
        currentCatalog: {
          rootDir: '/synthetic',
          source: 'embedded',
          available: true,
        },
        artifactsInitialized: true,
        repoManagedSessionState: {
          instructions: 'visible',
          rules: 'visible',
          hooks: 'not_applicable',
          agents: 'not_applicable',
          diagnostics: [],
        },
        projectTrust: 'not_applicable',
      },
    ],
  };
}

describe('ClaudeAdapter', () => {
  it('reuses an explicit catalog resolution for Claude status', async () => {
    const { repoRoot, env } = await makeWorkspace();
    env.AW_HOME = path.join(path.dirname(repoRoot), 'aw-home');
    await setupLocalMarketplace(repoRoot, env);
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const catalogResolution = await pluginCatalogModule.resolveCurrentCatalog(env);
    const resolveCurrentCatalogSpy = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog');

    const legacyReport = await adapter.status(plugin, 'project');
    expect(resolveCurrentCatalogSpy).toHaveBeenCalledTimes(1);

    resolveCurrentCatalogSpy.mockClear();
    const explicitReport = await adapter.status(plugin, 'project', { catalogResolution });

    expect(resolveCurrentCatalogSpy).not.toHaveBeenCalled();
    expect(explicitReport.plugins[0]?.catalogCompatibility).toBe(
      legacyReport.plugins[0]?.catalogCompatibility,
    );
    expect(explicitReport.plugins[0]?.currentCatalog).toEqual(
      legacyReport.plugins[0]?.currentCatalog,
    );
  });

  it('honors prepared Claude marketplaces and preserves direct initialization', async () => {
    const { repoRoot, env } = await makeWorkspace();
    env.AW_HOME = path.join(path.dirname(repoRoot), 'aw-home');
    await setupLocalMarketplace(repoRoot, env);
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const adapter = new ClaudeAdapter(repoRoot, nativeCliRunner, env);
    const catalogResolution: CatalogResolution = {
      rootDir: env.AW_HOME,
      source: 'local',
    };
    const ensureLocalMarketplaceSpy = vi.spyOn(localMarketplaceModule, 'ensureLocalMarketplace');
    const resolveCurrentCatalogSpy = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog');

    await adapter.installPlugin(plugin, 'project', {
      catalogResolution,
      marketplacePrepared: true,
    });

    expect(ensureLocalMarketplaceSpy).not.toHaveBeenCalled();
    expect(resolveCurrentCatalogSpy).not.toHaveBeenCalled();

    ensureLocalMarketplaceSpy.mockClear();
    resolveCurrentCatalogSpy.mockClear();
    await adapter.installPlugin(plugin, 'project', { catalogResolution });

    expect(ensureLocalMarketplaceSpy).toHaveBeenCalledWith(env, undefined, catalogResolution);
    expect(resolveCurrentCatalogSpy).not.toHaveBeenCalled();

    ensureLocalMarketplaceSpy.mockClear();
    resolveCurrentCatalogSpy.mockClear();
    await adapter.installPlugin(plugin, 'project');

    expect(ensureLocalMarketplaceSpy).toHaveBeenCalledWith(env, undefined, undefined);
    expect(resolveCurrentCatalogSpy).toHaveBeenCalledTimes(1);
  });

  it('uses recovered artifacts for refresh renderer context, ownership, and drift status', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await createDynamicClaudePlugin(path.dirname(repoRoot));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const initialArtifacts = await adapter.installExtensions(plugin, 'project');

    const refreshedArtifacts = await adapter.installExtensions(plugin, 'project', {
      event: 'refresh',
      dynamicOnly: true,
      changedConfigKeys: ['mode'],
      previousArtifacts: initialArtifacts,
    });
    expect(refreshedArtifacts).toEqual([
      expect.objectContaining({
        id: 'dynamic-claude-skill',
        target: 'claude.skill',
      }),
    ]);

    await setupLocalMarketplace(repoRoot, env);
    const skillRoot = refreshedArtifacts[0]!.path;
    await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\nUser drift.\n');
    const status = await adapter.status(plugin, 'project', {
      previousArtifacts: refreshedArtifacts,
    });
    expect(status.plugins[0]?.driftWarnings).toContain(
      'Claude 动态 skill 文件树与 tracking contentDigest 不一致。',
    );
  });

  it('materializes project dynamic skills from ordered static sources and renderer overrides', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await createDynamicClaudePlugin(path.dirname(repoRoot));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    const skill = artifacts.find((artifact) => artifact.target === 'claude.skill');
    expect(skill).toMatchObject({
      platform: 'claude',
      kind: 'skill',
      artifactKey: 'dynamic-claude',
      state: 'present',
    });
    const skillRoot = path.join(paths.configDir, 'skills', 'dynamic-claude');
    await expect(fs.readFile(path.join(skillRoot, 'references', 'shared.md'), 'utf8'))
      .resolves.toBe('claude\n');
    await expect(fs.readFile(path.join(skillRoot, 'references', 'dynamic.md'), 'utf8'))
      .resolves.toBe('dynamic\n');
    await expect(fs.readFile(path.join(skillRoot, 'assets', 'icon.bin')))
      .resolves.toEqual(Buffer.from([0, 255, 1]));
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('disable-model-invocation: false');

    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    await setupLocalMarketplace(repoRoot, env);
    await fs.symlink('../SKILL.md', path.join(skillRoot, 'assets', 'skill-link'));
    const symlinkStatus = await adapter.status(plugin, 'project');
    const symlinkArtifact = symlinkStatus.plugins[0]?.generatedArtifacts.find((entry) =>
      entry.target === 'claude.skill');
    expect(symlinkArtifact).toMatchObject({
      target: 'claude.skill',
      exists: true,
    });
    expect(symlinkArtifact).not.toHaveProperty('currentContentDigest');
    expect(symlinkStatus.plugins[0]?.driftWarnings.join('\n')).toContain(
      '包含无法读取的文件树',
    );
    await fs.remove(path.join(skillRoot, 'assets', 'skill-link'));
    await adapter.uninstallExtensions(plugin, 'project');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
  });

  it('refuses to overwrite an unmanaged Claude skill directory', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await createDynamicClaudePlugin(path.dirname(repoRoot));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const skillRoot = path.join(
      resolveClaudePaths(repoRoot, 'user', env).configDir,
      'skills',
      'dynamic-claude',
    );
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# unmanaged\n');

    await expect(adapter.installExtensions(plugin, 'user')).rejects.toThrow('不由 AW 管理');
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# unmanaged\n');
  });

  it('accepts project identity or an install record when Claude skill tracking is missing', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await createDynamicClaudePlugin(path.dirname(repoRoot));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const artifacts = await adapter.installExtensions(plugin, 'project');
    const skill = artifacts.find((artifact) => artifact.target === 'claude.skill');
    if (!skill?.artifactKey || !skill.id || !skill.contentDigest) {
      throw new Error('expected a complete Claude dynamic skill artifact');
    }

    const projectKey = await resolveClaudeProjectKey(repoRoot);
    const location: PluginLocation = {
      plugin: plugin.manifest.name,
      platform: 'claude',
      scope: 'project',
      projectKey,
    };
    const scopedRepoRoot = resolveProjectScopeRepoRoot(repoRoot);
    const locator = createProjectArtifactSharedLocator({
      plugin: plugin.manifest.name,
      platform: 'claude',
      repoRoot: scopedRepoRoot,
      projectRoot: resolveProjectArtifactProjectRoot(repoRoot, location),
    });
    const identityPath = getProjectArtifactSharedIdentityPath({
      repoRoot: scopedRepoRoot,
      locator,
      access: 'write',
    });
    const source = {
      pluginVersion: plugin.manifest.version,
      manifestDigest: 'test-manifest-digest',
      bundleFingerprint: 'test-bundle-fingerprint',
    };
    await writeProjectArtifactIdentityFileAt(identityPath, {
      version: 1,
      sharedIdentityId: createSharedIdentityId(locator),
      locator,
      source,
      generatedAt: '2026-08-08T00:00:00.000Z',
      artifacts: [{
        kind: 'skill',
        platform: 'claude',
        path: path.relative(scopedRepoRoot, skill.path),
        artifactKey: skill.artifactKey,
        id: skill.id,
        target: 'claude.skill',
        state: 'present',
        ownershipMarker: skill.artifactKey,
        contentDigest: skill.contentDigest,
      }],
    });

    await expect(adapter.installExtensions(plugin, 'project')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'claude.skill' })]),
    );

    const disabledPlugin = await createDynamicClaudePlugin(
      path.join(path.dirname(repoRoot), 'disabled-owner'),
      'disabled',
    );
    await expect(adapter.installExtensions(disabledPlugin, 'project')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'claude.skill', state: 'disabled' }),
      ]),
    );
    await expect(fs.pathExists(skill.path)).resolves.toBe(false);
    await adapter.installExtensions(plugin, 'project');

    await fs.remove(identityPath);
    const recordPath = getInstallRecordPath(repoRoot, location, env, 'write');
    await writeInstallRecordFileAt(recordPath, {
      version: 2,
      recordId: createRecordId(location),
      record: {
        pluginName: plugin.manifest.name,
        platform: 'claude',
        scope: 'project',
        projectKey,
        installedAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
        source,
        installSource: {
          kind: 'explicit',
          explicitlyRequested: true,
        },
        artifacts: [{
          kind: 'skill',
          platform: 'claude',
          path: skill.path,
          artifactKey: skill.artifactKey,
          id: skill.id,
          target: 'claude.skill',
          state: 'present',
          ownershipMarker: skill.artifactKey,
          contentDigest: skill.contentDigest,
        }],
        dependencyEdges: [],
      },
    }, { env });

    await expect(adapter.installExtensions(plugin, 'project')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'claude.skill' })]),
    );
    await expect(adapter.installExtensions(disabledPlugin, 'project')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'claude.skill', state: 'disabled' }),
      ]),
    );
    await expect(fs.pathExists(skill.path)).resolves.toBe(false);
  });

  it('does not claim or remove an unmanaged Claude directory for a disabled artifact', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const pluginRoot = path.dirname(repoRoot);
    const disabledPlugin = await createDynamicClaudePlugin(pluginRoot, 'disabled');
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);
    const skillRoot = path.join(paths.configDir, 'skills', 'dynamic-claude');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# unmanaged\n');

    const artifacts = await adapter.installExtensions(disabledPlugin, 'project');
    expect(artifacts).toContainEqual(expect.objectContaining({
      target: 'claude.skill',
      state: 'disabled',
    }));
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# unmanaged\n');

    await upsertTrackingRecord(paths.trackingDir, disabledPlugin.manifest.name, artifacts);
    await setupLocalMarketplace(repoRoot, env);
    const disabledStatus = await adapter.status(disabledPlugin, 'project');
    expect(disabledStatus.plugins[0]?.generatedArtifacts).toContainEqual(expect.objectContaining({
      target: 'claude.skill',
      state: 'disabled',
      exists: false,
    }));
    expect(disabledStatus.plugins[0]?.driftWarnings.join('\n')).not.toContain('disabled');
    await adapter.uninstallExtensions(disabledPlugin, 'project');
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# unmanaged\n');

    const presentPlugin = await createDynamicClaudePlugin(pluginRoot, 'present');
    await expect(adapter.installExtensions(presentPlugin, 'project')).rejects.toThrow('不由 AW 管理');
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# unmanaged\n');
  });

  it('prunes only stale tracked Claude dynamic skill directories', async () => {
    const { repoRoot } = await makeWorkspace();
    const stalePath = path.join(repoRoot, '.claude', 'skills', 'old-skill');
    const preservedPath = path.join(repoRoot, '.claude', 'skills', 'new-skill');
    const disabledPath = path.join(repoRoot, '.claude', 'skills', 'disabled-skill');
    await fs.outputFile(path.join(stalePath, 'SKILL.md'), '# old\n');
    await fs.outputFile(path.join(preservedPath, 'SKILL.md'), '# new\n');
    await fs.outputFile(path.join(disabledPath, 'SKILL.md'), '# disabled unmanaged\n');

    await pruneClaudeTrackedArtifacts({
      configDir: path.join(repoRoot, '.claude'),
      artifacts: [{
        path: stalePath,
        kind: 'skill',
        platform: 'claude',
        target: 'claude.skill',
        id: 'old',
        artifactKey: 'old-skill',
        state: 'present',
      }, {
        path: disabledPath,
        kind: 'skill',
        platform: 'claude',
        target: 'claude.skill',
        id: 'disabled',
        artifactKey: 'disabled-skill',
        state: 'disabled',
      }],
      preservedArtifacts: [{
        path: preservedPath,
        kind: 'skill',
        platform: 'claude',
        target: 'claude.skill',
        id: 'new',
        artifactKey: 'new-skill',
      }],
    });

    await expect(fs.pathExists(stalePath)).resolves.toBe(false);
    await expect(fs.pathExists(preservedPath)).resolves.toBe(true);
    await expect(fs.pathExists(disabledPath)).resolves.toBe(true);
  });

  it('tracks Claude hook-only capabilities in the ledger without emitting hook artifacts', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const basePlugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const hookOnlyPlugin: PluginMeta = {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        extensions: {
          nativeHooks: {
            claude: [
              {
                event: 'Stop',
                command: 'echo claude stop',
              },
            ],
          },
        },
      },
    };

    const ledger = await applyClaudeInstallLedger(
      createAvailableLedger(),
      hookOnlyPlugin,
      'user',
      repoRoot,
    );

    expect(ledger.plugins['git-commit'].platforms.claude?.userScope?.capabilitySnapshot).toEqual({
      managedExtensions: ['hooks'],
    });

    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    await expect(adapter.installExtensions(hookOnlyPlugin, 'project')).resolves.toEqual([]);
  });

  it('writes and removes Claude scope records in the installed ledger', async () => {
    const { repoRoot } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const projectKey = await resolveClaudeProjectKey(repoRoot);
    const degradedLedger: InstalledLedger = {
      version: 1,
      ledgerState: {
        status: 'degraded',
        degradedAt: '2026-04-25T00:00:00.000Z',
        reason: 'rebuilt_from_missing_or_invalid',
      },
      plugins: {},
    };

    const afterProjectInstall = await applyClaudeInstallLedger(
      degradedLedger,
      plugin,
      'project',
      repoRoot,
    );
    expect(afterProjectInstall.ledgerState).toEqual({
      status: 'available',
      degradedAt: null,
      reason: null,
    });
    expect(afterProjectInstall.plugins['git-commit'].platforms.claude).toMatchObject({
      lastRequestedScope: 'project',
      projectScopes: {
        [projectKey]: {
          managed: true,
          resolvedVersion: '0.1.0',
          capabilitySnapshot: {
            managedExtensions: ['instructions', 'permissions', 'hooks'],
          },
        },
      },
    });

    const afterUserInstall = await applyClaudeInstallLedger(
      afterProjectInstall,
      plugin,
      'user',
      repoRoot,
    );
    expect(afterUserInstall.plugins['git-commit'].platforms.claude).toMatchObject({
      lastRequestedScope: 'user',
      userScope: {
        managed: true,
        resolvedVersion: '0.1.0',
        capabilitySnapshot: {
          managedExtensions: ['instructions', 'permissions', 'hooks'],
        },
      },
    });

    const afterProjectUninstall = await applyClaudeUninstallLedger(
      afterUserInstall,
      'git-commit',
      'project',
      repoRoot,
    );
    expect(
      afterProjectUninstall.plugins['git-commit'].platforms.claude?.projectScopes,
    ).toBeUndefined();

    const afterUserUninstall = await applyClaudeUninstallLedger(
      afterProjectUninstall,
      'git-commit',
      'user',
      repoRoot,
    );
    expect(afterUserUninstall.plugins['git-commit']).toBeUndefined();
  });

  it('merges manual and generated Claude permissions, then restores manual state on uninstall', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);

    await fs.ensureDir(paths.configDir);
    await fs.writeJson(
      paths.settingsPath,
      {
        permissions: {
          allow: ['manual:allow', 'old:allow'],
          ask: ['manual:ask', 'old:ask'],
          deny: ['manual:deny'],
        },
        awGenerated: {
          permissions: {
            'existing-plugin': {
              allow: ['old:allow'],
              ask: ['old:ask'],
              deny: [],
            },
          },
        },
      },
      { spaces: 2 },
    );

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    const instructionArtifact = artifacts.find((artifact) => artifact.kind === 'instruction');
    expect(instructionArtifact?.path).toBeTruthy();
    await expect(fs.pathExists(instructionArtifact!.path)).resolves.toBe(true);

    await expect(fs.readJson(paths.settingsPath)).resolves.toMatchObject({
      permissions: {
        allow: ['Bash(git diff)', 'Bash(git status)', 'manual:allow', 'old:allow'],
        ask: ['Bash(git commit)', 'manual:ask', 'old:ask'],
        deny: ['manual:deny'],
      },
      awGenerated: {
        permissions: {
          'existing-plugin': {
            allow: ['old:allow'],
            ask: ['old:ask'],
            deny: [],
          },
          'git-commit': {
            allow: ['Bash(git status)', 'Bash(git diff)'],
            ask: ['Bash(git commit)'],
            deny: [],
          },
        },
        manualPermissions: {
          allow: ['manual:allow'],
          ask: ['manual:ask'],
          deny: ['manual:deny'],
        },
      },
    });

    await adapter.uninstallExtensions(plugin, 'project');

    await expect(fs.pathExists(instructionArtifact!.path)).resolves.toBe(false);
    await expect(fs.readJson(paths.settingsPath)).resolves.toMatchObject({
      permissions: {
        allow: ['manual:allow', 'old:allow'],
        ask: ['manual:ask', 'old:ask'],
        deny: ['manual:deny'],
      },
      awGenerated: {
        permissions: {
          'existing-plugin': {
            allow: ['old:allow'],
            ask: ['old:ask'],
            deny: [],
          },
        },
        manualPermissions: {
          allow: ['manual:allow'],
          ask: ['manual:ask'],
          deny: ['manual:deny'],
        },
      },
    });
  });

  it('removes empty generated Claude permission state after uninstalling the last plugin', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const permissionOnlyPlugin: PluginMeta = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        extensions: {
          permissions: plugin.manifest.extensions?.permissions,
        },
      },
    };
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);

    const artifacts = await adapter.installExtensions(permissionOnlyPlugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, permissionOnlyPlugin.manifest.name, artifacts);
    await adapter.uninstallExtensions(permissionOnlyPlugin, 'project');

    await expect(fs.readJson(paths.settingsPath)).resolves.toEqual({});
  });

  it('removes Claude generated artifacts without relying on tracking records', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    const instructionArtifact = artifacts.find((artifact) => artifact.kind === 'instruction');

    expect(instructionArtifact?.path).toBeTruthy();
    await expect(fs.pathExists(instructionArtifact!.path)).resolves.toBe(true);
    await expect(fs.readJson(paths.settingsPath)).resolves.toMatchObject({
      awGenerated: {
        permissions: {
          'git-commit': {
            allow: ['Bash(git status)', 'Bash(git diff)'],
            ask: ['Bash(git commit)'],
            deny: [],
          },
        },
      },
    });

    await adapter.uninstallExtensions(plugin, 'project', artifacts);

    await expect(fs.pathExists(instructionArtifact!.path)).resolves.toBe(false);
    await expect(fs.readJson(paths.settingsPath)).resolves.toEqual({});
  });

  it('applies Claude upgrade guardrails before reinstalling changed capabilities', async () => {
    const { repoRoot } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new ClaudeAdapter(repoRoot);

    vi.spyOn(adapter, 'status').mockResolvedValueOnce(createStatusReport('missing'));
    await expect(adapter.upgradePlugin(plugin, 'project')).rejects.toThrow(
      'git-commit 当前 catalog 已缺失，请先执行 uninstall。',
    );

    vi.spyOn(adapter, 'status').mockResolvedValueOnce(createStatusReport('capabilityChanged'));
    const uninstallExtensionsSpy = vi.spyOn(adapter, 'uninstallExtensions').mockResolvedValue();
    const installPluginSpy = vi.spyOn(adapter, 'installPlugin').mockResolvedValue();
    const installExtensionsSpy = vi.spyOn(adapter, 'installExtensions').mockResolvedValue([]);
    const catalogResolution: CatalogResolution = {
      rootDir: '/catalog',
      source: 'embedded',
    };
    const options = { catalogResolution, marketplacePrepared: true };

    await expect(adapter.upgradePlugin(plugin, 'project', options)).resolves.toBeUndefined();
    expect(adapter.status).toHaveBeenLastCalledWith(plugin, 'project', options);
    expect(uninstallExtensionsSpy).toHaveBeenCalledWith(plugin, 'project');
    expect(installPluginSpy).toHaveBeenCalledWith(plugin, 'project', options);
    expect(installExtensionsSpy).toHaveBeenCalledWith(plugin, 'project', {
      event: 'upgrade',
      catalogResolution,
      marketplacePrepared: true,
    });
  });

  it('keeps available ledgers unchanged when adding Claude scope records', async () => {
    const { repoRoot } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));

    const nextLedger = await applyClaudeInstallLedger(
      createAvailableLedger(),
      plugin,
      'user',
      repoRoot,
    );

    expect(nextLedger.ledgerState).toEqual({
      status: 'available',
      degradedAt: null,
      reason: null,
    });
  });

  it('detects Claude via injected env and adds the marketplace when local native state is missing', async () => {
    const { repoRoot, env } = await makeWorkspace();
    env.AW_HOME = path.join(path.dirname(repoRoot), 'aw-home');
    env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    await setupLocalMarketplace(repoRoot, env);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const adapter = new ClaudeAdapter(repoRoot, nativeCliRunner, env);

    await expect(adapter.detect(repoRoot)).resolves.toBe(true);
    await adapter.installPlugin(plugin, 'project');
    await adapter.uninstallPlugin(plugin, 'project');

    expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args)).toEqual([
      ['plugin', 'marketplace', 'add', env.AW_HOME, '--scope', 'project'],
      ['plugin', 'install', 'git-commit@aw', '--scope', 'project'],
      ['plugin', 'uninstall', 'git-commit@aw', '--scope', 'project'],
    ]);
  });

  it('skips Claude marketplace add when the active local bundle already matches AW_HOME', async () => {
    const { repoRoot, env } = await makeWorkspace();
    env.AW_HOME = path.join(path.dirname(repoRoot), 'aw-home');
    await setupLocalMarketplace(repoRoot, env);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const adapter = new ClaudeAdapter(repoRoot, nativeCliRunner, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);

    await fs.ensureDir(paths.configDir);
    await fs.ensureDir(path.dirname(paths.knownMarketplacesPath));
    await fs.writeJson(
      paths.settingsPath,
      {
        extraKnownMarketplaces: {
          aw: {
            source: env.AW_HOME,
          },
        },
      },
      { spaces: 2 },
    );
    await fs.writeJson(
      paths.knownMarketplacesPath,
      {
        marketplaces: {
          aw: {
            installLocation: env.AW_HOME,
          },
        },
      },
      { spaces: 2 },
    );

    await adapter.installPlugin(plugin, 'project');

    expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args)).toEqual([
      ['plugin', 'install', 'git-commit@aw', '--scope', 'project'],
    ]);
  });

  it('reports Claude drift while resolving current catalog from the injected local marketplace env', async () => {
    const { repoRoot, env } = await makeWorkspace();
    env.AW_HOME = path.join(path.dirname(repoRoot), 'aw-home');
    await setupLocalMarketplace(repoRoot, env);
    await removePluginFromLocalMarketplace(env.AW_HOME, 'git-commit');

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);
    const projectKey = await resolveClaudeProjectKey(repoRoot);
    const driftedSource = path.join(path.dirname(repoRoot), 'drifted-aw');
    const driftedInstallLocation = path.join(path.dirname(repoRoot), 'materialized-aw');

    await fs.ensureDir(paths.configDir);
    await fs.ensureDir(path.join(driftedInstallLocation, '.claude-plugin'));
    await fs.writeJson(
      path.join(driftedInstallLocation, '.claude-plugin', 'marketplace.json'),
      {
        name: 'aw',
        plugins: [],
      },
      { spaces: 2 },
    );
    await fs.ensureDir(path.dirname(paths.knownMarketplacesPath));
    await fs.writeJson(
      paths.settingsPath,
      {
        extraKnownMarketplaces: {
          aw: {
            source: driftedSource,
          },
        },
        plugins: {
          installed: {
            'git-commit': {
              marketplace: 'aw',
              version: '0.1.0',
              installedAt: '2026-04-25T00:00:00.000Z',
              scope: 'project',
              projectPath: projectKey,
            },
          },
        },
      },
      { spaces: 2 },
    );
    await fs.writeJson(
      paths.knownMarketplacesPath,
      {
        marketplaces: {
          aw: {
            installLocation: driftedInstallLocation,
          },
        },
      },
      { spaces: 2 },
    );

    const ledger = await applyClaudeInstallLedger(
      createAvailableLedger(),
      plugin,
      'project',
      repoRoot,
    );
    await writeInstalledLedger(ledger, env);
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, [
      {
        path: path.join(paths.configDir, 'instructions', 'missing.md'),
        kind: 'instruction',
        platform: 'claude',
      },
      {
        path: paths.settingsPath,
        kind: 'permission',
        platform: 'claude',
      },
    ]);

    const status = await adapter.status(plugin, 'project');
    const pluginStatus = status.plugins[0];

    expect(status.initialized).toBe(true);
    expect(pluginStatus).toMatchObject({
      catalogCompatibility: 'current',
      artifactsInitialized: false,
      native: {
        marketplaceRegistered: true,
        pluginAvailable: true,
        pluginInstalled: false,
        declaredSource: driftedSource,
        materializedInstallLocation: driftedInstallLocation,
      },
      currentCatalog: {
        rootDir: expect.any(String),
        source: 'local',
        available: true,
      },
      platformRuntimeEvidence: {
        present: false,
        details: 'materialized marketplace 缺少 git-commit 的 source。',
      },
      platformNativeFallbackEvidence: {
        present: false,
        details: 'installed_plugins.json 未命中 project scope 的 git-commit@aw 记录。',
      },
      scopeManagedEvidence: {
        ledger: true,
        tracking: true,
        sharedNativeRef: false,
      },
      repoManagedSessionState: {
        instructions: 'visible',
        rules: 'absent',
      },
    });
    expect(pluginStatus?.driftWarnings).toEqual(expect.arrayContaining([
      'tracking manifest 记录的 Claude 受管产物存在缺失。',
      'marketplace 已声明，但 declared source 已漂移。',
      'known_marketplaces.json 中的 installLocation 已漂移。',
      'runtime evidence 不完整：materialized marketplace 缺少 git-commit 的 source。',
      'native fallback evidence 不完整：installed_plugins.json 未命中 project scope 的 git-commit@aw 记录。',
    ]));
  });
});
