import { createElement } from 'react';

import {
  type CliExecutionContext,
  type CommandReporter,
  withCommandReporterSession,
} from './runtime.js';
import { createRebuildProgressFeed } from '../output/rebuild-progress.js';
import { SessionConsoleApp } from '../tui/session-console-app.js';
import { SessionHost } from '../tui/session-host.js';
import { createConsoleTuiV4Controller } from '../tui/controller-runtime.js';

export function formatInteractiveConsoleUnavailableMessage(
  context: Pick<CliExecutionContext, 'isCi' | 'isTty'>,
): string {
  const reasons = [
    context.isCi ? 'CI 环境默认禁用交互控制台。' : undefined,
    !context.isTty ? '当前 stdin/stdout 不是可交互终端。' : undefined,
  ].filter(Boolean);
  return [
    '当前运行环境不可交互，不能进入 aw 控制台。',
    ...reasons,
    '',
    '可用命令：',
    '- `aw status`',
    '- `aw install <plugin> --platform codex --scope user`',
    '- `aw status --json`',
  ].join('\n');
}

export async function runConsoleController(context: CliExecutionContext): Promise<number> {
  const host = new SessionHost({
    createSession: () => {
      const progressFeed = createRebuildProgressFeed();
      return {
        progressFeed,
        controller: createConsoleTuiV4Controller(context, progressFeed),
      };
    },
  });
  const sessionReporter: CommandReporter = host.reporter;
  try {
    const result = await withCommandReporterSession(context.reporter, sessionReporter, async () => {
      try {
        return await context.tuiRunner.launch<{ exitCode: number }>({
          input: context.stdin,
          output: context.tuiOutput,
          render: (complete) => createElement(SessionConsoleApp, {
            host,
            onExit: ({ code } = { code: 0, reason: 'user' }) => complete({ exitCode: code }),
          }),
        });
      } finally {
        await host.shutdown();
      }
    });
    return result.exitCode;
  } finally {
    host.dispose();
  }
}
