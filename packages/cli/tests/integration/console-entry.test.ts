import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createFakeConsoleDriver, createFakePrompt } from '../helpers/fake-console.js';

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('console entry', () => {
  it('runs bare aw through the feature-first console controller', async () => {
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
          statusIcon: 'circle',
          statusTone: 'neutral',
          platformBadges: [{ label: 'Codex', icon: 'square-terminal', tone: 'neutral' }],
          primaryActionLabel: '安装',
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
      }])
      .mockResolvedValueOnce([{
        summary: installedSummary,
        pageItem: {
          summary: installedSummary,
          statusIcon: 'check-circle',
          statusTone: 'success',
          platformBadges: [{ label: 'Codex', icon: 'square-terminal', tone: 'neutral' }],
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
      }]);
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
      cwd: '/tmp/workspace',
      env: {} as NodeJS.ProcessEnv,
      io: capture.io,
      prompt,
      consoleDriver,
    });

    expect(exitCode).toBe(0);
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
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
});
