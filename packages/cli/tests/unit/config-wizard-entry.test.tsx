import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const mocks = vi.hoisted(() => ({
  applyPluginConfigWrite: vi.fn(),
  resetPluginConfigWithHelper: vi.fn(),
}));

vi.mock('../../src/utils/plugin-config-write.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/plugin-config-write.js')>(
    '../../src/utils/plugin-config-write.js',
  );
  return { ...actual, ...mocks };
});

describe('config mutation runtime entry', () => {
  // Test Value Gate: source resolution failure must produce a receipt before any config write or wizard.
  it.each([
    ['set', ['team/demo', 'key', '--value-json', '"value"', '--platform', 'cursor']],
    ['unset', ['team/demo', 'key']],
  ] as const)('reports a resolver failure before plugin config %s writes', async (command, args) => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli(['plugin', 'config', command, ...args, '--context', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(3);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      schemaVersion: 1, command: `plugin.config.${command}`, status: 'blocked',
      data: { plugin: 'team/demo', configWrite: 'notStarted' },
    });
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(mocks.resetPluginConfigWithHelper).not.toHaveBeenCalled();
  });

  it('requires confirmation before resetting a platform profile outside a TTY', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli([
      'plugin', 'config', 'reset', 'team/demo', '--platform', 'generic', '--context', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(3);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.config.reset', status: 'blocked',
      data: { confirmation: { required: true, provided: false,
        effects: [expect.objectContaining({ code: 'deletePluginConfig' })] } },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
    });
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(mocks.resetPluginConfigWithHelper).not.toHaveBeenCalled();
  });

  it('does not expose a sensitive value in a resolver failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const secret = 'resolver-secret-value';
    const captured = createCapturedCliIo();
    const exitCode = await runCli([
      'plugin', 'config', 'set', 'team/demo', 'token', '--value-json', JSON.stringify(secret),
      '--context', 'user', '--platform', 'cursor', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      io: captured.io,
    });
    expect(exitCode).toBe(3);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      command: 'plugin.config.set', status: 'blocked', data: { configWrite: 'notStarted' },
    });
    expect(captured.readStdout()).not.toContain(secret);
    expect(captured.readStderr()).not.toContain(secret);
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
  });
});
