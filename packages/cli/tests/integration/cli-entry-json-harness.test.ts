import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCliEntry } from '../helpers/cli-entry.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { writeInstallRecordFileAt } from '../../src/install-state/facade.js';
import {
  createHistoricalLifecycleRuntimePaths,
  getInstallRecordPath,
} from '../../src/install-state/paths.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../../src/utils/plugin-scripts.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{
  repoRoot: string;
  awHome: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-entry-json-gate-'));
  tempDirs.push(root);
  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');
  return {
    repoRoot,
    awHome,
    embeddedRoot,
    env: {
      ...process.env,
      AW_HOME: awHome,
    },
  };
}

async function setEmbeddedRootOverride(rootDir: string | null): Promise<void> {
  const paths = await import('../../src/utils/paths.js');
  paths.setEmbeddedPluginsRootOverrideForTests(rootDir);
}

interface MockStatusOptions {
  json?: boolean;
  verbose?: boolean;
}

interface MockStatusContext {
  diagnostics: {
    verbose: boolean;
    debug: boolean;
  };
  reporter: {
    notice: (notice: {
      level: 'info';
      message: string;
      identity: string;
      target: 'stderr';
    }) => void | Promise<void>;
  };
}

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('../../src/utils/plugin-catalog.js');
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await setEmbeddedRootOverride(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('cli entry JSON stdout harness', () => {
  it('parses CLI stdout JSON across json, verbose, and debug flag combinations', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-entry-json-'));
    tempDirs.push(tempDir);

    const statusCommand = vi.fn(async (
      _plugins: string[],
      options: MockStatusOptions,
      context: MockStatusContext,
    ) => {
      await context.reporter.notice({
        level: 'info',
        message: `diagnostic:${options.json ? 'json' : 'human'}:${context.diagnostics.debug ? 'debug' : 'nodebug'}`,
        identity: `diagnostic:${statusCommand.mock.calls.length}`,
        target: 'stderr',
      });

      return {
        reports: [],
        output: JSON.stringify({
          ok: true,
          json: options.json === true,
          optionsVerbose: options.verbose === true,
          diagnosticsVerbose: context.diagnostics.verbose,
          diagnosticsDebug: context.diagnostics.debug,
        }),
      };
    });
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand,
    }));

    const cases: Array<{
      label: string;
      flags: string[];
      expected: {
        json: boolean;
        optionsVerbose: boolean;
        diagnosticsVerbose: boolean;
        diagnosticsDebug: boolean;
      };
    }> = [
      {
        label: 'json',
        flags: ['--json'],
        expected: {
          json: true,
          optionsVerbose: false,
          diagnosticsVerbose: false,
          diagnosticsDebug: false,
        },
      },
      {
        label: 'verbose',
        flags: ['--verbose'],
        expected: {
          json: false,
          optionsVerbose: true,
          diagnosticsVerbose: true,
          diagnosticsDebug: false,
        },
      },
      {
        label: 'debug',
        flags: ['--debug'],
        expected: {
          json: false,
          optionsVerbose: false,
          diagnosticsVerbose: true,
          diagnosticsDebug: true,
        },
      },
      {
        label: 'json-verbose',
        flags: ['--json', '--verbose'],
        expected: {
          json: true,
          optionsVerbose: true,
          diagnosticsVerbose: true,
          diagnosticsDebug: false,
        },
      },
      {
        label: 'json-debug',
        flags: ['--json', '--debug'],
        expected: {
          json: true,
          optionsVerbose: false,
          diagnosticsVerbose: true,
          diagnosticsDebug: true,
        },
      },
      {
        label: 'json-verbose-debug',
        flags: ['--json', '--verbose', '--debug'],
        expected: {
          json: true,
          optionsVerbose: true,
          diagnosticsVerbose: true,
          diagnosticsDebug: true,
        },
      },
    ];

    for (const entry of cases) {
      const flags = [...entry.flags];
      if (flags.includes('--debug')) {
        flags.push('--log-file', path.join(tempDir, `${entry.label}.log`));
      }

      const result = await runCliEntry(
        ['status', 'git-commit', ...flags],
        {
          cwd: tempDir,
          env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv,
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('diagnostic:');
      expect(result.stdout).not.toContain('调试：');
      expect(result.stderr).toContain('diagnostic:');
      const payload = result.parseJsonStdout();
      expect(payload).toMatchObject({
        ok: true,
        ...entry.expected,
      });
    }
  });

  it('keeps status JSON on schema version 2 while carrying consoleItems schema version 3', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-entry-status-v2-'));
    tempDirs.push(tempDir);

    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand: vi.fn(async () => ({
        reports: [],
        output: JSON.stringify({
          ok: true,
          command: 'status',
          statusSchemaVersion: 2,
          consoleItemsSchemaVersion: 3,
          health: 'needsAttention',
          summaries: [],
          cells: [],
          reports: [],
          friendlySummaries: [],
          consoleItems: [{
            pluginName: 'git-commit',
            title: 'Git Commit',
            status: 'abnormal',
            statusLabel: '异常',
            installedLocations: [{
              platform: 'codex',
              scope: 'user',
              label: 'Codex（个人）',
              status: 'abnormal',
              statusLabel: '异常',
              reasonCodes: ['recordCorrupted'],
              nextStepsSchemaVersion: 1,
              nextSteps: [],
            }],
            features: [{ kind: 'repair', label: '修复安装', targetSelection: 'singleTarget' }],
            reasonCodes: ['recordCorrupted'],
            nextStepsSchemaVersion: 1,
            nextSteps: [],
          }],
        }),
      })),
    }));

    const result = await runCliEntry(
      ['status', 'git-commit', '--json'],
      {
        cwd: tempDir,
        env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const payload = result.parseJsonStdout<{
      ok: boolean;
      command: string;
      statusSchemaVersion: number;
      health: string;
      summaries: unknown[];
      cells: unknown[];
      reports: unknown[];
      friendlySummaries: unknown[];
      consoleItems: unknown[];
    }>();
    expect(payload).toMatchObject({
      ok: true,
      command: 'status',
      statusSchemaVersion: 2,
      consoleItemsSchemaVersion: 3,
      health: 'needsAttention',
    });
    expect(payload.summaries).toBeInstanceOf(Array);
    expect(payload.cells).toBeInstanceOf(Array);
    expect(payload.reports).toBeInstanceOf(Array);
    expect(payload.friendlySummaries).toBeInstanceOf(Array);
    expect(JSON.stringify(payload.consoleItems)).not.toMatch(
      /missingRecord|adoptExisting|ownerConflict|dependencyProtected|requiredConfigMissing|invalidConfig|unreadableConfig|nativeResidue|artifactDrift/,
    );
  });

  it('projects built-in SkillTrigger config through status --json consoleItems', async () => {
    const workspace = await makeWorkspace();
    await setEmbeddedRootOverride(workspace.embeddedRoot);
    vi.doUnmock('../../src/commands/status.js');
    await fs.outputJson(
      path.join(workspace.awHome, 'plugin-config', 'git-commit', 'config.json'),
      {
        $aw: {
          skillTriggers: {
            commit: {
              trigger: 'manual',
            },
          },
        },
      },
      { spaces: 2 },
    );
    await fs.outputJson(
      path.join(
        workspace.repoRoot,
        '.agent-workflows',
        'plugin-config.local',
        'git-commit',
        'config.json',
      ),
      {
        $aw: {
          skillTriggers: {
            commit: {
              trigger: 'manual',
            },
          },
        },
      },
      { spaces: 2 },
    );
    const recordPath = getInstallRecordPath(workspace.repoRoot, {
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
    }, workspace.env);
    const recordId = path.basename(recordPath, '.json');
    const sourceBundleRoot = path.join(workspace.embeddedRoot, 'plugins', 'git-commit');
    const sourceManifestPath = path.join(sourceBundleRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(sourceManifestPath) as { version: string };
    const sourceManifestDigest = await calculateFileDigest(sourceManifestPath);
    const sourceBundleFingerprint = await calculatePluginBundleFingerprint(sourceBundleRoot);
    const lifecyclePaths = createHistoricalLifecycleRuntimePaths({
      cwd: workspace.repoRoot,
      location: {
        plugin: 'git-commit',
        platform: 'codex',
        scope: 'user',
      },
      recordId,
      manifestDigest: sourceManifestDigest,
      bundleFingerprint: sourceBundleFingerprint,
      nonce: 'json-harness',
      env: workspace.env,
      manifestRelativePath: '.agents-plugin/plugin.json',
    });
    await fs.copy(sourceBundleRoot, lifecyclePaths.bundleRoot);
    const manifestDigest = await calculateFileDigest(lifecyclePaths.manifestPath);
    const bundleFingerprint = await calculatePluginBundleFingerprint(lifecyclePaths.bundleRoot);
    await writeInstallRecordFileAt(recordPath, {
      version: 2,
      recordId,
      record: {
        pluginName: 'git-commit',
        platform: 'codex',
        scope: 'user',
        installedAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
        source: {
          pluginVersion: manifest.version,
          manifestDigest,
          bundleFingerprint,
        },
        installSource: {
          kind: 'explicit',
          explicitlyRequested: true,
        },
        lifecycle: {
          runtimeRoot: lifecyclePaths.runtimeRoot,
          bundleRoot: lifecyclePaths.bundleRoot,
          manifestPath: lifecyclePaths.manifestPath,
          pluginVersion: manifest.version,
          sourceManifestDigest: manifestDigest,
          bundleFingerprint,
          events: ['install'],
          createdAt: '2026-05-18T00:00:00.000Z',
        },
        artifacts: [],
        dependencyEdges: [],
      },
    }, { env: workspace.env });

    const result = await runCliEntry(
      ['status', 'git-commit', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const payload = result.parseJsonStdout<{
      consoleItems: Array<{
        pluginName: string;
        config?: {
          configSchemaVersion: number;
          views: Array<{
            scope: 'effective' | 'user' | 'project';
            projectLayer: 'shared' | 'local';
            fields: Array<Record<string, unknown>>;
            legacyConfigStores: Array<Record<string, unknown>>;
          }>;
        };
      }>;
    }>();
    const gitCommit = payload.consoleItems.find((entry) => entry.pluginName === 'git-commit');
    expect(gitCommit?.config).toMatchObject({
      configSchemaVersion: 2,
      views: expect.arrayContaining([
        expect.objectContaining({
          scope: 'effective',
          projectLayer: 'shared',
          fields: expect.arrayContaining([
            expect.objectContaining({
              key: 'aw.skillTriggers.commit.trigger',
              kind: 'builtIn',
              reserved: true,
              valueState: 'configured',
              effectiveValue: 'manual',
              sourceLayer: 'user',
            }),
          ]),
        }),
        expect.objectContaining({
          scope: 'project',
          projectLayer: 'shared',
          fields: expect.arrayContaining([
            expect.objectContaining({
              key: 'aw.skillTriggers.commit.trigger',
              kind: 'builtIn',
              reserved: true,
              valueState: 'invalid',
              storedValue: 'manual',
              storedSourceLayer: 'local',
              invalidReason: 'unsupportedProjectLocalLayer',
            }),
          ]),
        }),
      ]),
    });
  });

  it('keeps install --json stdout parseable when warnings and diagnostics go to stderr', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-entry-install-json-'));
    tempDirs.push(tempDir);

    const installCommand = vi.fn(async (
      plugins: string[],
      options: { json?: boolean; verbose?: boolean },
      context: {
        diagnostics: {
          verbose: boolean;
          debug: boolean;
        };
        reporter: {
          notice: (notice: {
            level: 'info';
            message: string;
            identity: string;
            target: 'stderr';
          }) => void | Promise<void>;
        };
      },
    ) => {
      await context.reporter.notice({
        level: 'info',
        message: `install-diagnostic:${plugins.join(',')}:${context.diagnostics.debug ? 'debug' : 'nodebug'}`,
        identity: 'install-diagnostic',
        target: 'stderr',
      });

      return {
        plugins,
        platforms: ['codex'],
        warnings: ['dependency warning，请运行 `aw status workflow-parent -p codex`。'],
        receiptTargets: [
          {
            plugin: 'workflow-parent',
            platform: 'codex',
            scope: 'user',
            requested: true,
          },
          {
            plugin: 'workflow-child',
            platform: 'codex',
            scope: 'user',
            requested: false,
            dependencyOf: [{
              plugin: 'workflow-parent',
              platform: 'codex',
              scope: 'user',
            }],
          },
        ],
        receiptActions: [{
          type: 'installDependency',
          plugin: 'workflow-child',
          platform: 'codex',
          scope: 'user',
        }],
      };
    });
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand,
    }));

    const result = await runCliEntry(
      [
        'install',
        'workflow-parent',
        '--platform',
        'codex',
        '--json',
        '--verbose',
        '--debug',
        '--log-file',
        path.join(tempDir, 'install-debug.log'),
      ],
      {
        cwd: tempDir,
        env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('install-diagnostic:');
    expect(result.stdout).not.toContain('注意：dependency warning');
    expect(result.stdout).not.toContain('调试：');
    expect(result.stderr).toContain('install-diagnostic:workflow-parent:debug');
    expect(result.stderr).toContain('注意：dependency warning，请运行 `aw status workflow-parent -p codex`。');
    expect(result.stderr).toContain('调试日志：');
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'install',
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      nextStepsSchemaVersion: 1,
      plugins: ['workflow-parent', 'workflow-child'],
      targets: [
        {
          plugin: 'workflow-parent',
          platform: 'codex',
          scope: 'user',
          requested: true,
        },
        {
          plugin: 'workflow-child',
          platform: 'codex',
          scope: 'user',
          requested: false,
          dependencyOf: [{
            plugin: 'workflow-parent',
            platform: 'codex',
            scope: 'user',
          }],
        },
      ],
      nextSteps: [
        expect.objectContaining({
          label: expect.any(String),
          description: expect.any(String),
          command: expect.stringContaining('aw status workflow-parent'),
        }),
      ],
      targetResults: expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            pluginName: 'workflow-parent',
            platform: 'codex',
            scope: 'user',
          }),
          action: 'install',
          state: 'completed',
        }),
        expect.objectContaining({
          target: expect.objectContaining({
            pluginName: 'workflow-child',
            platform: 'codex',
            scope: 'user',
          }),
          action: 'installDependency',
          state: 'completed',
        }),
      ]),
      warnings: ['dependency warning，请运行 `aw status workflow-parent -p codex`。'],
    });
  });

  it('prints structured init --json failure receipts when current catalog resolution fails', async () => {
    const catalogFailureCases = [
      {
        name: 'catalogUnavailable',
        resolution: {
          selector: {
            kind: 'distTag',
            cliVersion: '1.4.0',
            defaultChannel: 'latest',
            requestedChannel: 'beta',
            overrideSource: 'option:channel-alias' as const,
          },
          channel: 'beta' as const,
          catalogVersion: '1.9.0-beta.2',
          minAwVersion: '1.4.0',
          latestCatalogBlocked: {
            channel: 'beta' as const,
            catalogVersion: '2.0.0-beta.3',
            minAwVersion: '2.0.0',
          },
          historySchemaVersion: 1,
          cacheFallback: {
            used: false,
          },
          reason: 'catalogUnavailable: test current catalog failure',
          reasonCode: 'catalogUnavailable' as const,
        },
      },
      {
        name: 'catalogHistoryUnavailable',
        resolution: {
          selector: {
            kind: 'default',
            cliVersion: '1.4.0',
            defaultChannel: 'latest',
          },
          channel: 'latest' as const,
          catalogVersion: '2.0.0',
          minAwVersion: '2.0.0',
          latestCatalogBlocked: {
            channel: 'latest' as const,
            catalogVersion: '2.0.0',
            minAwVersion: '2.0.0',
          },
          historySchemaVersion: 3,
          reason: 'catalogHistoryUnavailable: history schema 3 is unsupported',
          reasonCode: 'catalogHistoryUnavailable' as const,
        },
      },
      {
        name: 'awVersionTooLow',
        resolution: {
          selector: {
            kind: 'default',
            cliVersion: '1.4.0',
            defaultChannel: 'latest',
          },
          channel: 'latest' as const,
          catalogVersion: '2.0.0',
          minAwVersion: '2.0.0',
          latestCatalogBlocked: {
            channel: 'latest' as const,
            catalogVersion: '2.0.0',
            minAwVersion: '2.0.0',
          },
          historySchemaVersion: 1,
          reason: 'awVersionTooLow: compatible history catalog not found',
          reasonCode: 'awVersionTooLow' as const,
        },
      },
      {
        name: 'explicitCatalogIncompatible',
        resolution: {
          selector: {
            kind: 'exactVersion',
            cliVersion: '1.4.0',
            defaultChannel: 'latest',
            requestedCatalogVersion: '2.0.0',
            overrideSource: 'option:catalog-version' as const,
          },
          catalogVersion: '2.0.0',
          minAwVersion: '2.0.0',
          reason: 'explicitCatalogIncompatible: catalog 2.0.0 requires aw >= 2.0.0',
          reasonCode: 'explicitCatalogIncompatible' as const,
        },
      },
    ] as const;

    for (const testCase of catalogFailureCases) {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `aw-cli-entry-init-json-failure-${testCase.name}-`));
      tempDirs.push(tempDir);
      vi.doMock('../../src/utils/plugin-catalog.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/utils/plugin-catalog.js')>();
        return {
          ...actual,
          resolveCurrentCatalog: vi.fn(async () => {
            throw new actual.CatalogResolutionError(testCase.resolution);
          }),
        };
      });

      const result = await runCliEntry(
        ['init', '--json'],
        {
          cwd: tempDir,
          env: { AW_HOME: path.join(tempDir, 'aw-home') } as NodeJS.ProcessEnv,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toBe('');
      expect(result.parseJsonStdout()).toMatchObject({
        ok: false,
        command: 'init',
        receiptSchemaVersion: 2,
        receiptKind: 'catalogCacheWarmup',
        warnings: [],
        catalog: {
          selector: testCase.resolution.selector,
          reasonCode: testCase.resolution.reasonCode,
          ...(testCase.resolution.latestCatalogBlocked
            ? { latestCatalogBlocked: testCase.resolution.latestCatalogBlocked }
            : {}),
          ...(testCase.resolution.historySchemaVersion !== undefined
            ? { historySchemaVersion: testCase.resolution.historySchemaVersion }
            : {}),
        },
      });
      expect(result.stderr).toContain(testCase.resolution.reason);

      vi.resetModules();
      vi.doUnmock('../../src/utils/plugin-catalog.js');
    }
  });

  it('keeps init --json stdout pure when current catalog warmup succeeds', async () => {
    const workspace = await makeWorkspace();
    await setEmbeddedRootOverride(workspace.embeddedRoot);

    const result = await runCliEntry(
      ['init', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('注意：');
    expect(result.parseJsonStdout()).toMatchObject({
      ok: true,
      command: 'init',
      receiptSchemaVersion: 2,
      receiptKind: 'catalogCacheWarmup',
      catalog: expect.objectContaining({
        source: 'local',
        sidecarManifestPackage: expect.objectContaining({
          source: 'localFixture',
        }),
        fullCatalog: expect.objectContaining({
          source: 'local',
          freshness: 'localFixture',
        }),
      }),
    });
  });
});
