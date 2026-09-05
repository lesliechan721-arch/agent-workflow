import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
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

describe('config mutation runtime entry', () => {
  it.each([
    ['set', ['demo', 'key', '--value-json', '"value"', '--scope', 'user']],
    ['unset', ['demo', 'key']],
    ['reset', ['demo', '--scope', 'user', '--yes']],
  ] as const)('returns a v4 resolver failure for config %s', async (command, args) => {
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli(['config', command, ...args, '--json'], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      receiptSchemaVersion: 7,
      command: `config:${command}`,
      configWrite: 'notStarted',
      ok: false,
      overallState: 'failed',
    });
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(mocks.resetPluginConfigWithHelper).not.toHaveBeenCalled();
  });

  it('does not expose a sensitive value in the transition failure', async () => {
    const secret = 'transition-secret-value';
    const captured = createCapturedCliIo();
    await runCli([
      'config', 'set', 'demo', 'token', '--value-json', JSON.stringify(secret), '--scope', 'user', '--json',
    ], {
      interactive: false,
      io: captured.io,
    });
    expect(captured.readStdout()).not.toContain(secret);
    expect(captured.readStderr()).not.toContain(secret);
  });
});
