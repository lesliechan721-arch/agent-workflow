import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';

describe('console and removed diagnose entry', () => {
  it('rejects the bare console in a non-interactive runtime with copyable live commands', async () => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([], {
      interactive: false,
      io: captured.io,
    });

    expect(exitCode).toBe(1);
    expect(captured.readStderr()).toContain('当前运行环境不可交互');
    expect(captured.readStderr()).toContain('aw status --json');
  });

  it('treats diagnose as an ordinary unknown command without a compatibility route', async () => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli(['diagnose'], { io: captured.io });

    expect(exitCode).toBe(1);
    expect(captured.readStderr()).toContain('unknown command');
    expect(captured.readStderr()).not.toContain('status --verbose');
  });
});
