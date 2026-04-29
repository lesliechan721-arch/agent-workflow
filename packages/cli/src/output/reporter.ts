import type { CliIo, CommandDiagnostics } from '../commands/runtime.js';
import type { CommandEvent, CommandNotice, CommandReporter, OutputLevel } from './model.js';
import { redactValue, stringifyRedacted } from './redact.js';

const PLATFORM_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

function noticeIdentity(notice: CommandNotice): string {
  return notice.identity ?? [
    notice.level,
    notice.source?.platform ?? '',
    notice.source?.plugin ?? '',
    notice.source?.scope ?? '',
    notice.message,
  ].join(':');
}

function formatSource(notice: CommandNotice): string {
  const parts = [
    notice.source?.platform ? PLATFORM_LABELS[notice.source.platform] ?? notice.source.platform : undefined,
    notice.source?.plugin,
    notice.source?.scope ? `${notice.source.scope} scope` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' / ')}：` : '';
}

function formatEvent(event: CommandEvent): string {
  const data = event.data ? ` ${stringifyRedacted(event.data)}` : '';
  const message = event.message ? `：${event.message}` : '';
  return `调试：${event.type}${message}${data}`;
}

function warningPrefix(level: OutputLevel): string {
  return level === 'warning' ? '注意：' : '';
}

export function formatNotice(notice: CommandNotice): string {
  const source = formatSource(notice);
  const message = notice.level === 'warning'
    ? formatWarningText(notice.message)
    : notice.message;
  return `${warningPrefix(notice.level)}${source}${message}`;
}

function translateDegradedReplay(message: string): string | null {
  const replayMatch = message.match(
    /^installed\.json 处于 degraded 状态（(.+?)），跳过 skill trigger 偏好 replay，保留 embedded pristine 默认策略。$/,
  );
  if (replayMatch) {
    return `本机安装账本处于异常恢复状态（${replayMatch[1]}），本次跳过 skill 触发偏好回放，保留插件内置默认策略。`;
  }

  if (message === 'installed.json 处于 degraded 状态，跳过卸载后的 skill trigger 重选。') {
    return '本机安装账本处于异常恢复状态，本次没有自动重选 skill 触发偏好。继续安装或升级时请显式传 --skill-trigger default|manual|auto。';
  }

  return null;
}

function translateTrustWarning(message: string): string | null {
  if (message === '当前 repo trust 状态未知，project scope 会话可见性无法确定。') {
    return 'Codex 已写入 project scope 文件，但当前仓库尚未确认 trusted；在 Codex 信任该仓库前，这些 project 配置可能不会进入会话。';
  }

  if (message === '当前 repo 处于 untrusted 状态，project scope 产物不会进入会话。') {
    return 'Codex 已写入 project scope 文件，但当前仓库未被信任；在 Codex 信任该仓库前，这些 project 配置不会进入会话。';
  }

  return null;
}

export function formatWarningText(warning: string): string {
  const sourceMatch = warning.match(/^\[(codex|claude)\/([^\]]+)\]\s*(.+)$/);
  if (sourceMatch) {
    const [, platform, pluginName, rawMessage] = sourceMatch;
    const translated =
      translateDegradedReplay(rawMessage) ??
      translateTrustWarning(rawMessage) ??
      rawMessage
        .replaceAll('skill trigger', 'skill 触发')
        .replaceAll('installed.json', '本机安装账本');
    return `${PLATFORM_LABELS[platform] ?? platform} / ${pluginName}：${translated}`;
  }

  return (
    translateDegradedReplay(warning) ??
    translateTrustWarning(warning) ??
    warning
      .replaceAll('skill trigger', 'skill 触发')
      .replaceAll('plugin / marketplace', '插件 / marketplace')
  );
}

export function formatWarnings(warnings: string[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const warning of warnings) {
    const formatted = `注意：${formatWarningText(warning)}`;
    if (seen.has(formatted)) {
      continue;
    }
    seen.add(formatted);
    lines.push(formatted);
  }
  return lines;
}

export function createIoReporter(io: CliIo, diagnostics: CommandDiagnostics): CommandReporter {
  const seenNotices = new Set<string>();
  return {
    event: (event) => {
      if (diagnostics.verbose) {
        io.stderr(`${formatEvent(event)}\n`);
      }
    },
    notice: (notice) => {
      if (notice.level === 'debug' && !diagnostics.verbose) {
        return;
      }

      const identity = noticeIdentity(notice);
      if (seenNotices.has(identity)) {
        return;
      }
      seenNotices.add(identity);

      const target = notice.target ?? (notice.level === 'warning' ? 'stderr' : 'stdout');
      const line = formatNotice({
        ...notice,
        message: typeof notice.message === 'string'
          ? notice.message
          : String(redactValue(notice.message)),
      });
      if (target === 'stderr') {
        io.stderr(`${line}\n`);
      } else {
        io.stdout(`${line}\n`);
      }
    },
  };
}

export function createNoopReporter(): CommandReporter {
  return {
    event: () => {},
    notice: () => {},
  };
}
