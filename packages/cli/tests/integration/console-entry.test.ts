import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createFakeConsoleDriver, createFakePrompt } from '../helpers/fake-console.js';

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('console entry', () => {
  it('runs bare aw through the console controller with a fake prompt', async () => {
    const statusCommand = vi.fn()
      .mockResolvedValueOnce({
        consoleItems: [{
          pluginName: 'git-commit',
          title: 'git-commit',
          status: 'notInstalled',
          statusLabel: '未安装',
          locationSummary: 'Codex（个人）',
          actions: [],
          reasonCodes: [],
          nextSteps: [],
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
        }],
      })
      .mockResolvedValueOnce({
        consoleItems: [{
          pluginName: 'git-commit',
          title: 'git-commit',
          status: 'installed',
          statusLabel: '已安装',
          locationSummary: 'Codex（个人）',
          actions: [],
          reasonCodes: [],
          nextSteps: [],
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
        }],
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
    const resolveSkillTriggerApplicabilityForPlugin = vi.fn().mockResolvedValue('fixed');
    const installCommand = vi.fn().mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });

    vi.doMock('../../src/commands/status.js', () => ({ statusCommand }));
    vi.doMock('../../src/commands/common.js', () => ({ preparePluginTargetsForCommand }));
    vi.doMock('../../src/commands/console-wizard.js', () => ({ createInstallWizardDecision }));
    vi.doMock('../../src/utils/skill-trigger-preferences.js', () => ({ resolveSkillTriggerApplicabilityForPlugin }));
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));

    const prompt = createFakePrompt([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'openInstallWizard' },
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
        return { cancelled: true } as const;
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
