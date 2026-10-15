import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import { execPnpmForTest } from '../helpers/pnpm.js';
import { writeNodeScriptFixture } from '../support/plugin-scripts-node-fixture.js';
import {
  activateSmokeBuildSnapshot,
  cleanupSmokeBuildSnapshot,
  createSmokeBuildSnapshot,
  importSmokeSnapshotModule,
  type SmokeBuildSnapshot,
} from '../support/smoke-build-snapshot.js';
import {
  createSmokeStagingRunner,
  type SmokeStagingRunner,
} from '../support/smoke-staging-runner.js';
import {
  assertCompatibleRuntimeVersion,
  assertRunnerSkillBundle,
} from '../../../../scripts/verify-eval-runtime-owner.mjs';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
let buildSnapshot: SmokeBuildSnapshot | null = null;

const EXPECTED_PLUGIN_PLATFORMS = {
  'agent-content-toolkit': ['claude', 'codex'],
  'aw-skill-eval-runner': ['claude', 'codex'],
  'agent-skill-toolkit': ['claude', 'codex'],
  'decision-kit': ['claude', 'codex'],
  'aw-development-toolkit': ['claude', 'codex'],
  'browser-use': ['claude', 'codex'],
  'codex-enhance': ['codex'],
  'dev-workflow': ['claude', 'codex'],
  'frontend-design': ['claude', 'codex'],
  'git-toolkit': ['claude', 'codex'],
  'human-content': ['claude', 'codex'],
} as const;

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

function registerSmokeWritableRoot(rootPath: string, source: string): string {
  return registerCurrentTestWritableStateRoot(rootPath, source);
}

async function createSmokeTempRoot(prefix: string, source: string): Promise<string> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(rootPath);
  return registerSmokeWritableRoot(rootPath, source);
}

async function requireBuildSnapshot(): Promise<SmokeBuildSnapshot> {
  if (!buildSnapshot) {
    throw new Error('Build smoke snapshot is not initialized.');
  }
  return activateSmokeBuildSnapshot(buildSnapshot);
}

beforeAll(async () => {
  buildSnapshot = await createSmokeBuildSnapshot(repoRoot());
});

afterAll(async () => {
  await cleanupSmokeBuildSnapshot(buildSnapshot);
  buildSnapshot = null;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('build smoke', () => {
  const root = repoRoot();

  it.each(['claude', 'codex'])('ships the current %s Eval Runner bundle', async (platform) => {
    const snapshot = await requireBuildSnapshot();
    const runnerRoot = path.join(
      snapshot.catalogOutputRoot,
      'plugins',
      'aw-skill-eval-runner',
      platform,
      'skills',
      'run-aw-skill-evals',
    );
    const bundle = await assertRunnerSkillBundle(runnerRoot);

    expect(new Set(bundle.files)).toEqual(new Set([
      'README.md',
      'SKILL.md',
      'agents/openai.yaml',
      'aw-plugin-requirements.json',
      'assets/eval-audit-template.json',
      'references/aw-eval-profile.md',
      'references/execution-and-safety.md',
      'scripts/validate-eval-cases.mjs',
    ]));
    expect(() => assertCompatibleRuntimeVersion({
      packageVersion: '0.1.0',
      minimumPackageVersion: bundle.minimumPackageVersion,
    })).not.toThrow();
  });

  it('reports plugin development status through the built public entry', async () => {
    const snapshot = await requireBuildSnapshot();
    const tempRoot = await createSmokeTempRoot(
      'aw-authoring-version-gate-smoke-',
      'authoring version gate smoke temp root',
    );
    const tempRepo = path.join(tempRoot, 'repo');
    const pluginRoot = path.join(tempRepo, 'plugins', 'version-gate-smoke');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    await fs.ensureDir(path.dirname(manifestPath));
    await fs.ensureSymlink(
      snapshot.cliDistRoot,
      path.join(tempRepo, 'packages', 'cli', 'dist'),
      'dir',
    );
    await fs.writeJson(path.join(tempRepo, '.aw-workspace.json'), {
      schemaVersion: 1,
      kind: 'aw-catalog-workspace',
      workspaceIdentity: 'version-gate-smoke-fixture',
    }, { spaces: 2 });
    await fs.writeJson(path.join(tempRepo, 'plugins', 'marketplace-source.json'), {
      owner: {
        name: 'AW Test',
        url: 'https://example.invalid/aw-test',
      },
      interface: {
        displayName: 'Version Gate Smoke',
      },
      catalog: {
        version: '0.1.0',
      },
    }, { spaces: 2 });
    await fs.writeJson(manifestPath, {
      schemaVersion: 3,
      name: 'version-gate-smoke',
      version: '0.1.0',
      description: 'Baseline version gate smoke plugin.',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      requires: {
        aw: {
          capabilities: ['aw.plugin-manifest.v3'],
        },
      },
    }, { spaces: 2 });
    await fs.writeFile(path.join(pluginRoot, 'README.md'), '# Version Gate Smoke\n', 'utf8');

    await execFileAsync('git', ['init'], { cwd: tempRepo, env: process.env });
    await execFileAsync('git', ['add', '.aw-workspace.json', 'plugins'], {
      cwd: tempRepo,
      env: process.env,
    });
    await execFileAsync('git', [
      '-c',
      'user.name=AW Test',
      '-c',
      'user.email=aw-test@example.invalid',
      'commit',
      '-m',
      'baseline',
    ], { cwd: tempRepo, env: process.env });

    const manifest = await fs.readJson(manifestPath);
    manifest.description = 'Changed production version gate smoke plugin.';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const checkerPath = path.join(
      root,
      'packages',
      'cli',
      'dist',
      'index.js',
    );
    const development = await execFileAsync('node', [
        checkerPath,
        'plugin',
        'status',
        '--base',
        'HEAD',
        'version-gate-smoke',
        '--json',
        '--workspace-root',
        tempRepo,
      ], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(development.stdout)).toMatchObject({
      schemaVersion: 3,
      policy: 'development',
      checks: [expect.objectContaining({
        status: 'unreleasedChanges',
        productionChanged: true,
        currentTarget: '0.1.0',
      })],
    });

    manifest.version = '0.2.0';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const bumped = await execFileAsync('node', [
      checkerPath,
      'plugin',
      'status',
      '--base',
      'HEAD',
      'version-gate-smoke',
      '--json',
      '--workspace-root',
      tempRepo,
    ], { cwd: root, env: process.env, maxBuffer: 10 * 1024 * 1024 });
    expect(JSON.parse(bumped.stdout)).toMatchObject({
      schemaVersion: 3,
      checks: [expect.objectContaining({
        status: 'versionBumped',
        currentVersion: '0.2.0',
        productionChanged: true,
      })],
    });
  }, 120_000);

  it('ensures the build and produces plugins-dist through the compiled bundle script', async () => {
    const snapshot = await requireBuildSnapshot();
    const outputRoot = snapshot.catalogOutputRoot;
    const sourceMetadata = await fs.readJson(path.join(
      root,
      'plugins',
      'marketplace-source.json',
    ));

    expect(outputRoot).toBe(path.join(snapshot.root, 'packages', 'cli', 'plugins-dist'));
    if (snapshot.mode === 'release') {
      await expect(fs.readJson(path.join(root, '.release', 'cache', 'build-stamp.json')))
        .resolves.toMatchObject({
          generationId: snapshot.generationId,
          outputDigest: snapshot.outputDigest,
        });
    } else {
      for (const target of [
        'windows-job-x64',
        'windows-job-arm64',
        'agent-skill-eval',
        'plugin-core',
        'cli-typescript',
        'plugin-bundle',
      ]) {
        await expect(fs.readJson(path.join(
          root,
          '.release',
          'cache',
          'dev-build',
          `${target}.json`,
        ))).resolves.toMatchObject({
          schemaVersion: 1,
          target,
          outputDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });
      }
    }

    for (const arch of ['x64', 'arm64']) {
      const helperPath = path.join(
        snapshot.root,
        'packages',
        `aw-windows-job-win32-${arch}`,
        'dist',
        'aw-windows-job.exe',
      );
      const bytes = await fs.readFile(helperPath);
      expect(bytes.subarray(0, 2).toString('ascii')).toBe('MZ');
    }

    await expect(
      fs.pathExists(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-toolkit', '.codex-plugin', 'plugin.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'decision-kit', '.claude-plugin', 'plugin.json')),
    ).resolves.toBe(true);
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-toolkit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      name: 'git-toolkit',
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'decision-kit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      marketplace: {
        category: 'workflow',
        policy: {
          authentication: 'ON_INSTALL',
        },
      },
    });
    for (const pluginName of Object.keys(EXPECTED_PLUGIN_PLATFORMS)) {
      await expect(
        fs.pathExists(path.join(outputRoot, 'plugins', pluginName, 'evals')),
      ).resolves.toBe(false);
    }
    const { validateRuntimeSkillClosuresRoot } = await importSmokeSnapshotModule<{
      validateRuntimeSkillClosuresRoot: (skillsRoot: string) => Promise<void>;
    }>(path.join(snapshot.cliDistRoot, 'src', 'utils', 'runtime-skill-closure.js'));
    for (const [pluginName, platforms] of Object.entries(EXPECTED_PLUGIN_PLATFORMS)) {
      for (const platform of platforms) {
        const skillsRoot = path.join(
          outputRoot,
          'plugins',
          pluginName,
          platform,
          'skills',
        );
        if (await fs.pathExists(skillsRoot)) {
          await expect(
            validateRuntimeSkillClosuresRoot(skillsRoot),
            `${pluginName}/${platform}`,
          ).resolves.toBeUndefined();
        }
      }
    }
    for (const [pluginName, skillName] of [
      ['decision-kit', 'decision-grill'],
      ['decision-kit', 'project-context'],
      ['dev-workflow', 'dev-design'],
      ['git-toolkit', 'git-commit'],
    ]) {
      for (const platform of ['claude', 'codex']) {
        await expect(fs.pathExists(path.join(
          outputRoot, 'plugins', pluginName, platform, 'skills', skillName, 'SKILL.md',
        ))).resolves.toBe(true);
        for (const authorDirectory of ['evals', 'reports']) {
          await expect(fs.pathExists(path.join(
            outputRoot,
            'plugins',
            pluginName,
            platform,
            'skills',
            skillName,
            authorDirectory,
          ))).resolves.toBe(false);
        }
      }
    }
    for (const [pluginName, artifactId] of [
      ['codex-enhance', 'codex-explore-skill'],
      ['codex-enhance', 'codex-subagent-guide-skill'],
    ]) {
      await expect(fs.pathExists(path.join(
        outputRoot,
        'plugins',
        pluginName,
        '.agents-plugin',
        'artifact-sources',
        'codex',
        artifactId,
        '0',
        'SKILL.md',
      ))).resolves.toBe(true);
      for (const authorDirectory of ['evals', 'reports']) {
        await expect(fs.pathExists(path.join(
          outputRoot,
          'plugins',
          pluginName,
          '.agents-plugin',
          'artifact-sources',
          'codex',
          artifactId,
          '0',
          authorDirectory,
        ))).resolves.toBe(false);
      }
    }
    const [claudeMarketplace, codexMarketplace] = await Promise.all([
      fs.readJson(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
      fs.readJson(path.join(outputRoot, '.agents', 'plugins', 'marketplace.json')),
    ]);
    const catalogManifest = await fs.readJson(path.join(outputRoot, 'catalog-manifest.json')) as {
      requires: { aw: { capabilities: string[] } };
      entries: Array<{
        name: string;
        source: string;
        artifactDigest: string;
        manifestDigest: string;
        contentDigest: string;
        dependencies: string[];
        requires: { aw: { capabilities: string[] } };
      }>;
    };
    expect(claudeMarketplace.plugins.map((plugin: { name: string }) => plugin.name).sort()).toEqual([
      'agent-content-toolkit',
      'agent-skill-toolkit',
      'aw-development-toolkit',
      'aw-skill-eval-runner',
      'browser-use',
      'decision-kit',
      'dev-workflow',
      'frontend-design',
      'git-toolkit',
      'human-content',
    ]);
    expect(codexMarketplace.plugins.map((plugin: { name: string }) => plugin.name).sort()).toEqual([
      'agent-content-toolkit',
      'agent-skill-toolkit',
      'aw-development-toolkit',
      'aw-skill-eval-runner',
      'browser-use',
      'codex-enhance',
      'decision-kit',
      'dev-workflow',
      'frontend-design',
      'git-toolkit',
      'human-content',
    ]);
    for (const [pluginName, platforms] of Object.entries(EXPECTED_PLUGIN_PLATFORMS)) {
      for (const platform of ['claude', 'codex'] as const) {
        const supported = (platforms as readonly string[]).includes(platform);
        if (!supported) {
          await expect(fs.pathExists(path.join(
            outputRoot,
            'plugins',
            pluginName,
            platform,
          ))).resolves.toBe(false);
        }
        await expect(fs.pathExists(path.join(
          outputRoot,
          'plugins',
          pluginName,
          platform === 'claude' ? '.claude-plugin' : '.codex-plugin',
          'plugin.json',
        ))).resolves.toBe(supported);
      }
    }
    expect(codexMarketplace).toMatchObject({
      owner: claudeMarketplace.owner,
      interface: claudeMarketplace.interface,
      plugins: expect.arrayContaining([
        expect.objectContaining({
          name: 'decision-kit',
          source: './plugins/decision-kit',
          policy: expect.objectContaining({
            authentication: 'ON_INSTALL',
          }),
        }),
        expect.objectContaining({
          name: 'codex-enhance',
          source: './plugins/codex-enhance',
          policy: expect.objectContaining({
            products: ['CODEX'],
          }),
        }),
      ]),
    });
    expect(claudeMarketplace.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'decision-kit',
        source: './plugins/decision-kit',
        policy: expect.objectContaining({
          authentication: 'ON_INSTALL',
        }),
      }),
    ]));
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'decision-kit', 'codex', 'skills', 'decision-kit')),
    ).resolves.toBe(false);
    await Promise.all([
      path.join(
        outputRoot,
        'plugins',
        'codex-enhance',
        '.codex-plugin',
        'plugin.json',
      ),
      path.join(
        outputRoot,
        'plugins',
        'codex-enhance',
        '.agents-plugin',
        'artifact-sources',
        'codex',
        'codex-explore-skill',
        '0',
        'SKILL.md',
      ),
      path.join(
        outputRoot,
        'plugins',
        'codex-enhance',
        '.agents-plugin',
        'artifact-sources',
        'codex',
        'codex-explore-skill',
        '0',
        'agents',
        'openai.yaml',
      ),
      path.join(
        outputRoot,
        'plugins',
        'codex-enhance',
        '.agents-plugin',
        'artifact-sources',
        'codex',
        'codex-subagent-guide-skill',
        '0',
        'SKILL.md',
      ),
      path.join(
        outputRoot,
        'plugins',
        'codex-enhance',
        '.agents-plugin',
        'artifact-sources',
        'codex',
        'codex-subagent-guide-skill',
        '0',
        'agents',
        'openai.yaml',
      ),
      path.join(
        outputRoot,
        'plugins',
        'codex-enhance',
        'scripts',
        'render-artifacts.mjs',
      ),
    ].map(async (requiredPath) => {
      await expect(fs.pathExists(requiredPath)).resolves.toBe(true);
    }));
    await expect(
      fs.pathExists(
        path.join(
          outputRoot,
          'plugins',
          'codex-enhance',
          '.claude-plugin',
          'plugin.json',
        ),
      ),
    ).resolves.toBe(false);
    await expect(
      fs.readJson(
        path.join(
          outputRoot,
          'plugins',
          'codex-enhance',
          '.agents-plugin',
          'plugin.json',
        ),
      ),
    ).resolves.toMatchObject({
      name: 'codex-enhance',
      interface: {
        capabilities: ['Skills', 'Agents'],
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
        targets: expect.arrayContaining([
          expect.objectContaining({
            target: 'codex.skill',
          }),
          expect.objectContaining({
            target: 'codex.agentRole',
          }),
        ]),
      },
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'codex-enhance', '.codex-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      name: 'codex-enhance',
    });
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'codex-enhance', 'claude')),
    ).resolves.toBe(false);
    expect(catalogManifest).toMatchObject({
      schemaVersion: 7,
      catalogVersion: sourceMetadata.catalog.version,
      channel: String(sourceMetadata.catalog.version).includes('-') ? 'beta' : 'latest',
      release: { state: 'development' },
      entries: expect.arrayContaining(Object.keys(EXPECTED_PLUGIN_PLATFORMS).map((pluginName) =>
        expect.objectContaining({
          name: pluginName,
          source: `./plugins/${pluginName}`,
          artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          manifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        }))),
    });
    expect(catalogManifest.requires.aw.capabilities).toEqual(['aw.catalog-snapshot.v7']);
    expect(catalogManifest.entries.every((entry) =>
      entry.requires.aw.capabilities.includes('aw.plugin-manifest.v3'))).toBe(true);
    expect(catalogManifest).not.toHaveProperty('history');
    expect(catalogManifest).not.toHaveProperty('packages');
    expect((await fs.readdir(outputRoot)).sort()).toEqual([
      '.agents',
      '.claude-plugin',
      'catalog-manifest.json',
      'plugins',
    ]);
    expect(await fs.readdir(outputRoot)).not.toContain('plugin-release-ledger.json');
  });

  it('uses strict requirements for the official compiled bundle entry', async () => {
    const snapshot = await requireBuildSnapshot();
    const tempRoot = await createSmokeTempRoot(
      'aw-smoke-strict-requirements-',
      'build smoke strict requirements temp root',
    );
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    const pluginRoot = path.join(tempRepo, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.config = {
      fields: {
        mode: { type: 'string', default: 'standard' },
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const skillPath = path.join(pluginRoot, 'skills', 'commit', 'SKILL.md');
    await fs.appendFile(skillPath, '\n```bash\naw config list\n```\n', 'utf8');

    const { bundlePlugins } = await importSmokeSnapshotModule<{
      bundlePlugins: (options: {
        repoRoot: string;
        outputRoot: string;
        strictRequirements: boolean;
      }) => Promise<unknown>;
    }>(path.join(snapshot.cliDistRoot, 'scripts', 'bundle-plugins.js'));
    await expect(bundlePlugins({
      repoRoot: tempRepo,
      outputRoot,
      strictRequirements: true,
    })).resolves.toBeDefined();

    await fs.appendFile(
      skillPath,
      '\n```bash\naw catalog publish plan --json\n```\n',
      'utf8',
    );
    await expect(bundlePlugins({
      repoRoot: tempRepo,
      outputRoot,
      strictRequirements: true,
    })).rejects.toThrow(
      /plugin="git-commit" path="skills\/commit\/SKILL\.md" command="aw catalog publish" capability="aw\.catalog-publication\.v1"/u,
    );

    manifest.requires = { aw: { capabilities: ['aw.catalog-publication.v1'] } };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.appendFile(
      skillPath,
      '\n```bash\naw future command\naw "$GROUP" status\n```\n',
      'utf8',
    );
    const warningError = await bundlePlugins({
      repoRoot: tempRepo,
      outputRoot,
      strictRequirements: true,
    }).catch((cause: unknown) => cause) as Error & { code?: string };
    expect(warningError.code).toBe('awCapabilityStrictRequirements');
    expect(warningError.message).toContain(
      'plugin="git-commit" path="skills/commit/SKILL.md" command="aw future command" capability="<unmapped>"',
    );
    expect(warningError.message).toContain('$GROUP');
    expect(warningError.message).toContain('capability="<dynamic>"');
  });

  it('reuses a warm build without changing key output mtimes', async () => {
    const snapshot = await requireBuildSnapshot();
    const keyOutputs = [
      path.join(root, 'packages', 'cli', 'dist', 'index.js'),
      path.join(root, 'packages', 'cli', 'dist', 'scripts', 'bundle-plugins.js'),
      path.join(root, 'packages', 'cli', 'plugins-dist', 'catalog-manifest.json'),
    ];
    const before = await Promise.all(keyOutputs.map((outputPath) => fs.stat(outputPath)));

    await execPnpmForTest([snapshot.mode === 'release' ? 'build:ensure' : 'build:dev'], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    const after = await Promise.all(keyOutputs.map((outputPath) => fs.stat(outputPath)));
    expect(after.map((stats) => stats.mtimeMs)).toEqual(before.map((stats) => stats.mtimeMs));
  });

  it('materializes and completely validates schema 7 from real build bundles', async () => {
    const snapshot = await requireBuildSnapshot();
    const outputRoot = snapshot.catalogOutputRoot;
    const { validateCatalogSnapshotComplete } = await importSmokeSnapshotModule<{
      validateCatalogSnapshotComplete: (rootDir: string) => Promise<{
        manifest: { schemaVersion: number; entries: Array<{ name: string; contentDigest: string }> };
      }>;
    }>(path.join(snapshot.cliDistRoot, 'src', 'utils', 'catalog-snapshot.js'));
    const validated = await validateCatalogSnapshotComplete(outputRoot);
    expect(validated.manifest.schemaVersion).toBe(7);
    expect(validated.manifest.entries.map((entry) => entry.name).sort())
      .toEqual(Object.keys(EXPECTED_PLUGIN_PLATFORMS).sort());
    expect(validated.manifest.entries.every((entry) =>
      /^sha256:[0-9a-f]{64}$/u.test(entry.contentDigest))).toBe(true);
  });

  it('starts the real dist entry', async () => {
    const snapshot = await requireBuildSnapshot();
    const cliEntry = path.join(snapshot.cliDistRoot, 'index.js');

    await expect(
      execFileAsync('node', [cliEntry, '--help'], {
        cwd: root,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining('Usage: aw'),
    });

    for (const command of ['init', 'add-skill']) {
      const help = await execFileAsync('node', [cliEntry, 'plugin', command, '--help'], {
        cwd: root,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
      expect(help.stdout).toContain('aw plugin validate');
      expect(help.stdout).toContain('aw catalog build');
      expect(help.stdout).toContain('aw catalog publish plan --help');
      expect(help.stdout).not.toContain('pnpm release');
    }
  });

  it('bundles declared MCP, app and native hook assets through the compiled bundle script', async () => {
    const snapshot = await requireBuildSnapshot();

    const tempRoot = await createSmokeTempRoot('aw-smoke-assets-', 'build smoke assets temp root');
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    registerSmokeWritableRoot(tempRepo, 'build smoke assets repo root');
    registerSmokeWritableRoot(outputRoot, 'build smoke assets output root');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    const manifestPath = path.join(tempRepo, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo smoke claude notification',
        },
      ],
      codex: [
        {
          event: 'Stop',
          command: 'echo smoke codex stop',
        },
      ],
    };
    manifest.slashCommands = './slash-commands';
    manifest.buildConfig = {
      ...(manifest.buildConfig ?? {}),
      manifestOverrides: {
        ...(manifest.buildConfig?.manifestOverrides ?? {}),
        claude: {
          ...(manifest.buildConfig?.manifestOverrides?.claude ?? {}),
          outputStyles: './output-styles',
          lspServers: './config/lsp.json',
          userConfig: {
            awSmokeMode: {
              type: 'string',
              default: 'standard',
            },
          },
          channels: {
            stable: {
              description: 'Smoke stable channel',
            },
          },
        },
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.outputFile(
      path.join(tempRepo, 'plugins', 'git-commit', 'slash-commands', 'review.md'),
      [
        '---',
        'description: Smoke review command',
        '---',
        '',
        'Run smoke review.',
      ].join('\n'),
      'utf8',
    );
    await fs.outputFile(
      path.join(tempRepo, 'plugins', 'git-commit', 'output-styles', 'smoke.md'),
      '# Smoke Style\n',
      'utf8',
    );
    await fs.outputJson(
      path.join(tempRepo, 'plugins', 'git-commit', 'config', 'lsp.json'),
      {
        smokeLsp: {
          command: 'node',
          args: ['server.mjs'],
        },
      },
      { spaces: 2 },
    );

    const { bundlePlugins } = await importSmokeSnapshotModule<{
      bundlePlugins: (options: { repoRoot: string; outputRoot: string }) => Promise<unknown>;
    }>(path.join(snapshot.cliDistRoot, 'scripts', 'bundle-plugins.js'));
    await bundlePlugins({ repoRoot: tempRepo, outputRoot });

    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', 'claude', '.mcp.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', 'codex', '.app.json')),
    ).resolves.toBe(true);
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      extensions: {
        nativeHooks: {
          claude: [
            {
              event: 'Notification',
              matcher: '*',
              command: 'echo smoke claude notification',
            },
          ],
          codex: [
            {
              event: 'Stop',
              command: 'echo smoke codex stop',
            },
          ],
        },
      },
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', 'claude', 'hooks', 'hooks.json')),
    ).resolves.toMatchObject({
      hooks: {
        Notification: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo smoke claude notification' }],
          },
        ],
      },
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      hooks: {
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: 'echo smoke codex stop' }],
            },
          ],
        },
      },
    });
    await expect(
      fs.readJson(path.join(outputRoot, 'plugins', 'git-commit', '.claude-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      hooks: './claude/hooks/hooks.json',
      commands: './claude/commands',
      agents: expect.arrayContaining(['./claude/agents/aw-git-commit-commit-reviewer.md']),
      outputStyles: './claude/output-styles',
      lspServers: './claude/config/lsp.json',
      userConfig: {
        awSmokeMode: {
          type: 'string',
          default: 'standard',
        },
      },
      channels: {
        stable: {
          description: 'Smoke stable channel',
        },
      },
    });
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', 'claude', 'commands', 'review.md')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(outputRoot, 'plugins', 'git-commit', 'claude', 'output-styles', 'smoke.md')),
    ).resolves.toBe(true);

    const { validateBundleLayout } = await importSmokeSnapshotModule<{
      validateBundleLayout: (rootDir: string) => Promise<void>;
    }>(path.join(snapshot.cliDistRoot, 'src', 'utils', 'bundle-layout.js'));
    await expect(validateBundleLayout(outputRoot)).resolves.toBeUndefined();
  });

  it('bundles scripts.node plugins through the compiled staging bundle path', async () => {
    const snapshot = await requireBuildSnapshot();

    const tempRoot = await createSmokeTempRoot(
      'aw-smoke-scripts-node-',
      'build smoke scripts.node temp root',
    );
    const tempRepo = path.join(tempRoot, 'repo');
    const outputRoot = path.join(tempRoot, 'plugins-dist');
    registerSmokeWritableRoot(tempRepo, 'build smoke scripts.node repo root');
    registerSmokeWritableRoot(outputRoot, 'build smoke scripts.node output root');
    await fs.copy(fixturePath('repo-template'), tempRepo);
    await writeNodeScriptFixture(tempRepo);

    const { bundlePlugins } = await importSmokeSnapshotModule<{
      bundlePlugins: (options: {
        repoRoot: string;
        outputRoot: string;
        buildMode: 'staging';
        stagingRunner?: SmokeStagingRunner;
      }) => Promise<unknown>;
    }>(path.join(snapshot.cliDistRoot, 'scripts', 'bundle-plugins.js'));
    await bundlePlugins({
      repoRoot: tempRepo,
      outputRoot,
      buildMode: 'staging',
      stagingRunner: createSmokeStagingRunner(),
    });

    const pluginRoot = path.join(outputRoot, 'plugins', 'git-commit');
    const bundleManifest = await fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'));
    expect(bundleManifest).toMatchObject({
      description: 'Built smoke description',
      marketplace: {
        policy: {
          products: ['CODEX'],
        },
      },
      scripts: {
        preApply: {
          path: './scripts/runtime.mjs',
        },
        node: {
          packageRoot: './scripts',
        },
      },
    });
    expect(bundleManifest.scripts.tests).toBeUndefined();
    expect(bundleManifest.scripts.node.build).toBeUndefined();

    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'generated.test.mjs')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'node_modules', 'yaml', 'package.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(pluginRoot, 'scripts', 'node_modules', 'fs-extra')),
    ).resolves.toBe(false);
    const productionStoreEntries = await fs.readdir(
      path.join(pluginRoot, 'scripts', 'node_modules', '.pnpm'),
    ).catch(() => []);
    expect(productionStoreEntries.some((entry) => (
      entry.startsWith('fs-extra@') || entry.startsWith('universalify@')
    ))).toBe(false);

    const runtime = (await import(
      pathToFileURL(path.join(pluginRoot, 'scripts', 'runtime.mjs')).href
    )) as { parseSmokeConfig: (source: string) => string };
    expect(runtime.parseSmokeConfig('name: bundle\n')).toBe(
      'bundle:runtime-helper:directory-helper',
    );

    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'git-commit', 'scripts', 'generated.test.mjs')),
    ).resolves.toBe(false);
    await expect(
      fs.readJson(path.join(tempRepo, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      description: expect.not.stringContaining('Built smoke description'),
      marketplace: {
        policy: {
          products: ['CLAUDE'],
        },
      },
      scripts: {
        tests: {
          node: ['./scripts/source-only.test.mjs'],
        },
      },
    });
    const [claudeMarketplace, codexMarketplace] = await Promise.all([
      fs.readJson(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
      fs.readJson(path.join(outputRoot, '.agents', 'plugins', 'marketplace.json')),
    ]);
    expect(claudeMarketplace.plugins).toEqual([]);
    expect(codexMarketplace.plugins).toEqual([
      expect.objectContaining({
        name: 'git-commit',
        description: 'Built smoke description',
        source: './plugins/git-commit',
        policy: expect.objectContaining({
          products: ['CODEX'],
        }),
      }),
    ]);

    await fs.writeFile(
      path.join(tempRepo, 'plugins', 'git-commit', 'scripts', 'runtime.mjs'),
      'require.resolve("left-pad");\n',
      'utf8',
    );
    await expect(bundlePlugins({
      repoRoot: tempRepo,
      outputRoot,
      buildMode: 'staging',
      stagingRunner: createSmokeStagingRunner(),
    })).rejects.toThrow('Runtime import "left-pad"');
  }, 120_000);
});
