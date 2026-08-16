import { describe, expect, it, vi } from 'vitest';

import { buildEquivalentConfigCommandTokens, runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';

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

describe('config mutation transition gate', () => {
  it.each([
    ['set', ['demo', 'key', 'value']],
    ['unset', ['demo', 'key']],
    ['reset', ['demo', '--scope', 'user', '--yes']],
  ] as const)('fails config %s closed with a v4 receipt', async (command, args) => {
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli(['config', command, ...args, '--json'], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      receiptSchemaVersion: 4,
      command: `config:${command}`,
      ok: false,
      overallState: 'failed',
      errors: [{ code: 'runtimeTransitionIncomplete' }],
    });
    expect(captured.readStderr()).toContain('runtimeTransitionIncomplete');
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(mocks.resetPluginConfigWithHelper).not.toHaveBeenCalled();
  });

  it('does not expose a sensitive value in the transition failure', async () => {
    const secret = 'transition-secret-value';
    const captured = createCapturedCliIo();
    await runCli(['config', 'set', 'demo', 'token', secret, '--json'], {
      interactive: false,
      io: captured.io,
    });
    expect(captured.readStdout()).not.toContain(secret);
    expect(captured.readStderr()).not.toContain(secret);
  });

  it.each(['list', 'get', 'set', 'unset', 'reset'] as const)(
    'keeps config %s replay tokens free of removed catalog selectors',
    (command) => {
      const tokens = buildEquivalentConfigCommandTokens({
        command,
        plugin: 'demo',
        ...(command === 'get' || command === 'set' || command === 'unset' ? { key: 'key' } : {}),
        ...(command === 'set' ? { value: 'value' } : {}),
        scope: 'user',
        projectLayer: 'shared',
        confirmed: command === 'reset',
      });
      expect(tokens).not.toContain('--catalog-channel');
      expect(tokens).not.toContain('--catalog-version');
    },
  );
});
