import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createFakeConsoleDriver, createFakePrompt } from '../helpers/fake-console.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-console-entry-'));
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

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('console entry', () => {
  it('runs bare aw through the feature-first console controller', async () => {
    vi.resetModules();
    const workspace = await makeWorkspace();

    const notInstalledSummary = {
      pluginName: 'git-commit',
      title: 'git-commit',
      status: 'notInstalled',
      statusLabel: '未安装',
      locationSummary: 'Codex（个人）',
      supportedPlatforms: ['codex'],
      installedLocations: [{
        platform: 'codex',
        scope: 'user',
        label: 'Codex（个人）',
        status: 'notInstalled',
        statusLabel: '未安装',
        reasonCodes: [],
        nextSteps: [],
      }],
      features: [
        { kind: 'install', label: '安装', targetSelection: 'singleTarget' },
        { kind: 'status', label: '查看状态', targetSelection: 'none' },
      ],
      reasonCodes: [],
      nextSteps: [],
    };
    const installedSummary = {
      pluginName: 'git-commit',
      title: 'git-commit',
      status: 'installed',
      statusLabel: '已安装',
      locationSummary: 'Codex（个人）',
      supportedPlatforms: ['codex'],
      installedLocations: [{
        platform: 'codex',
        scope: 'user',
        label: 'Codex（个人）',
        status: 'installed',
        statusLabel: '已安装',
        reasonCodes: [],
        nextSteps: [],
      }],
      features: [
        { kind: 'status', label: '查看状态', targetSelection: 'none' },
      ],
      reasonCodes: [],
      nextSteps: [],
    };
    const loadConsoleItems = vi.fn()
      .mockResolvedValueOnce([{
        summary: notInstalledSummary,
        pageItem: {
          summary: notInstalledSummary,
          statusSymbol: '○',
          statusTone: 'neutral',
          platformSummary: 'Codex（个人）',
          description: 'demo',
          version: '1.0.0',
          primaryActionLabel: '安装',
        },
        detailPage: {
          summary: notInstalledSummary,
          statusSymbol: '○',
          statusTone: 'neutral',
          platformSummary: 'Codex（个人）',
          platformDetails: [{
            label: 'Codex（个人）',
            status: 'notInstalled',
            statusLabel: '未安装',
            statusSymbol: '○',
            statusTone: 'neutral',
          }],
          featureMenu: notInstalledSummary.features,
          targetOptions: [],
        },
        locations: [{
          platform: 'codex',
          scope: 'user',
          locationLabel: 'Codex（个人）',
          status: 'notInstalled',
          statusLabel: '未安装',
          reasonCodes: [],
          nextSteps: [],
          actions: [{
            kind: 'openInstallWizard',
            label: '安装',
            target: { platform: 'codex', scope: 'user' },
          }],
        }],
        statusPage: {
          pluginName: 'git-commit',
          summary: notInstalledSummary,
          locations: [{
            key: 'codex:user:-',
            platform: 'codex',
            scope: 'user',
            label: 'Codex（个人）',
            status: 'notInstalled',
            statusLabel: '未安装',
            statusSymbol: '○',
            statusTone: 'neutral',
            hasEvidence: false,
            summary: '未安装',
            issues: [],
            suggestedFeatures: [],
            nextSteps: [],
            diagnostics: [],
          }],
        },
      }])
      .mockResolvedValueOnce([{
        summary: installedSummary,
        pageItem: {
          summary: installedSummary,
          statusSymbol: '✓',
          statusTone: 'success',
          platformSummary: 'Codex（个人）',
          description: 'demo',
          version: '1.0.0',
        },
        detailPage: {
          summary: installedSummary,
          statusSymbol: '✓',
          statusTone: 'success',
          platformSummary: 'Codex（个人）',
          platformDetails: [{
            label: 'Codex（个人）',
            status: 'installed',
            statusLabel: '已安装',
            statusSymbol: '✓',
            statusTone: 'success',
          }],
          featureMenu: installedSummary.features,
          targetOptions: [],
        },
        locations: [{
          platform: 'codex',
          scope: 'user',
          locationLabel: 'Codex（个人）',
          status: 'installed',
          statusLabel: '已安装',
          reasonCodes: [],
          nextSteps: [],
          actions: [],
        }],
        statusPage: {
          pluginName: 'git-commit',
          summary: installedSummary,
          locations: [{
            key: 'codex:user:-',
            platform: 'codex',
            scope: 'user',
            label: 'Codex（个人）',
            status: 'installed',
            statusLabel: '已安装',
            statusSymbol: '✓',
            statusTone: 'success',
            hasEvidence: true,
            summary: '已安装',
            issues: [],
            suggestedFeatures: [],
            nextSteps: [],
            diagnostics: [],
          }],
        },
      }]);
    const loadConsoleItemsResult = vi.fn(async (...args: Parameters<typeof loadConsoleItems>) => ({
      items: await loadConsoleItems(...args),
      catalog: {
        rootDir: workspace.embeddedRoot,
        source: 'embedded' as const,
        catalogVersion: '1.0.0',
      },
      catalogUnavailable: false,
    }));
    const statusCommand = vi.fn()
      .mockResolvedValueOnce({
        output: '',
        matrix: {
          cells: [{
            report: {
              currentCatalog: { available: true },
            },
          }],
        },
      })
      .mockResolvedValueOnce({
        output: '',
        matrix: {
          cells: [{
            report: {
              currentCatalog: { available: true },
            },
          }],
        },
      });
    const preparePluginTargetsForCommand = vi.fn().mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [{
        pluginName: 'git-commit',
        plugin: {
          rootDir: '/synthetic',
          manifestPath: '/synthetic/plugin.json',
          manifest: {
            name: 'git-commit',
            version: '1.0.0',
            description: 'demo',
            marketplace: {
              category: 'test',
              strict: false,
              policy: {
                installation: 'AVAILABLE',
                authentication: 'NONE',
              },
            },
          },
        },
      }],
    });
    const createInstallWizardDecision = vi.fn().mockResolvedValue({
      blockedReason: undefined,
      configPrompts: [],
      commandAction: 'install',
    });
    const planConsoleGraphWriteTargets = vi.fn().mockImplementation(async (options: {
      targets: Array<{ pluginName: string }>;
      platforms: string[];
    }) => ({
      requestedTargets: options.targets.map((target) => ({
        target,
        platform: options.platforms[0] ?? 'codex',
        scope: 'user',
        requested: true,
      })),
      writeTargets: options.targets.map((target) => ({
        target,
        platform: options.platforms[0] ?? 'codex',
        scope: 'user',
        requested: true,
        resolvedInstallOptions: undefined,
      })),
    }));
    const installCommand = vi.fn().mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });

    vi.doMock('../../src/commands/status.js', () => ({
      loadConsoleItems,
      loadConsoleItemsResult,
      statusCommand,
    }));
    vi.doMock('../../src/commands/common.js', () => ({ preparePluginTargetsForCommand }));
    vi.doMock('../../src/commands/console-wizard.js', () => ({
      createInstallWizardDecision,
      planConsoleGraphWriteTargets,
    }));
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));

    const prompt = createFakePrompt([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', action: 'exit' },
      { method: 'select', value: '__exit' },
    ]);
    const consoleDriver = createFakeConsoleDriver();
    const capture = createCapturedCliIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli([], {
      cwd: workspace.repoRoot,
      env: workspace.env,
      io: capture.io,
      prompt,
      consoleDriver,
    });

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
      }),
      expect.anything(),
    );
  });

  it('fails bare aw in CI without hanging or invoking the fake prompt', async () => {
    let promptCalled = false;
    const prompt = {
      select: vi.fn(async () => {
        promptCalled = true;
        return { action: 'cancel', cancelled: true } as const;
      }),
    };
    const capture = createCapturedCliIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli([], {
      cwd: '/tmp/workspace',
      env: { CI: 'true' } as NodeJS.ProcessEnv,
      io: capture.io,
      prompt,
      consoleDriver: createFakeConsoleDriver(),
    });

    expect(exitCode).toBe(1);
    expect(promptCalled).toBe(false);
    expect(capture.readStderr()).toContain('当前运行环境不可交互');
    expect(capture.readStderr()).toContain('`aw status --json`');
  });

  it('shows legacy config placeholders on bare-aw home inside the abnormal section only', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    vi.doUnmock('../../src/commands/status.js');
    vi.doUnmock('../../src/commands/common.js');
    vi.doUnmock('../../src/commands/console-wizard.js');
    vi.doUnmock('../../src/commands/install.js');
    await fs.outputJson(
      path.join(workspace.awHome, 'plugin-config', 'missing-plugin', 'config.json'),
      {
        token: 'legacy-secret',
      },
      { spaces: 2 },
    );

    const prompt = createFakePrompt([
      { method: 'select', value: '__exit' },
    ]);
    const consoleDriver = createFakeConsoleDriver();
    const capture = createCapturedCliIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli([], {
      cwd: workspace.repoRoot,
      env: workspace.env,
      io: capture.io,
      prompt,
      consoleDriver,
    });

    expect(exitCode, capture.readStderr()).toBe(0);
    const homeView = consoleDriver.views[0];
    expect(homeView).toBeDefined();
    const abnormalIndex = homeView!.lines.findIndex((line) => line.startsWith('异常（'));
    expect(abnormalIndex).toBeGreaterThanOrEqual(0);
    const legacyIndex = homeView!.lines.findIndex((line) => line.includes('! missing-plugin'));
    expect(legacyIndex).toBeGreaterThan(abnormalIndex);
    const notInstalledIndex = homeView!.lines.findIndex((line) => line.startsWith('未安装（'));
    if (notInstalledIndex >= 0) {
      expect(legacyIndex).toBeLessThan(notInstalledIndex);
    }
    const legacyBlock = homeView!.lines.slice(legacyIndex, legacyIndex + 4).join('\n');
    expect(legacyBlock).toContain('配置残留');
    expect(legacyBlock).not.toContain('主操作：安装');
    expect(legacyBlock).not.toContain('主操作：升级');
  });

  it('shows orphaned built-in config placeholders on bare-aw home', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    vi.doUnmock('../../src/commands/status.js');
    vi.doUnmock('../../src/commands/common.js');
    vi.doUnmock('../../src/commands/console-wizard.js');
    vi.doUnmock('../../src/commands/install.js');
    await fs.outputJson(
      path.join(workspace.awHome, 'plugin-config', 'missing-plugin', 'config.json'),
      {
        $aw: {
          skillTriggers: {
            retired: {
              trigger: 'manual',
            },
          },
        },
      },
      { spaces: 2 },
    );

    const prompt = createFakePrompt([
      { method: 'select', value: '__exit' },
    ]);
    const consoleDriver = createFakeConsoleDriver();
    const capture = createCapturedCliIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli([], {
      cwd: workspace.repoRoot,
      env: workspace.env,
      io: capture.io,
      prompt,
      consoleDriver,
    });

    expect(exitCode, capture.readStderr()).toBe(0);
    const homeView = consoleDriver.views[0];
    expect(homeView).toBeDefined();
    expect(homeView!.lines.some((line) => line.startsWith('异常（'))).toBe(true);
    const legacyIndex = homeView!.lines.findIndex((line) => line.includes('! missing-plugin'));
    expect(legacyIndex).toBeGreaterThanOrEqual(0);
    const legacyBlock = homeView!.lines
      .slice(legacyIndex, legacyIndex + 8)
      .join('\n');
    expect(legacyBlock).toContain('配置残留');
  });
});
