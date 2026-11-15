import manifestSchema from '../schemas/plugin-manifest-v4.json' with { type: 'json' };
import type { HookEvent, PlatformId } from './types.js';
import type { HookFeedback } from './plugin-components.js';

export type HookResponseBody =
  | Record<string, never>
  | { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  | { decision: 'deny' | 'block'; reason: string }
  | { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: { behavior: 'deny'; message: string } } }
  | { injectSteps: Array<{ userMessage: string }> };
export interface HookHandlerResponseTemplate { exitCode: 0 | 2; stdout: HookResponseBody | null; stderr: '$message' | null }
export interface HookHandlerProtocol {
  id: string;
  input: { transport: 'stdin-json'; eventField: 'hook_event_name' | null; fields: string[]; schemaUrl: string | null };
  responses: Partial<Record<HookFeedback, HookHandlerResponseTemplate>>;
  otherExitCodes: 'diagnostic-only' | 'error-ignored';
  blockEffect: 'deny-tool' | 'deny-permission' | 'reject-tool-result' | 'reject-prompt' | 'prevent-completion' | null;
  sources: string[];
}
export interface PlatformHookHandlerContract {
  platform: PlatformId; dialect: 'common' | 'native'; event: string; nativeEvent: string | null;
  matcherAllowed: boolean | null;
  api: 'command' | 'pi.on' | 'ctx.tool.hook' | null;
  /** A known wire protocol does not qualify an installed client or grant a capability. */
  qualification: 'required';
  protocol: HookHandlerProtocol | null;
}
export interface PlatformHookHandlers {
  common: Readonly<Record<HookEvent, PlatformHookHandlerContract>>;
  native: Readonly<Record<string, PlatformHookHandlerContract>>;
}
const COMMON_EVENTS: HookEvent[] = ['before_tool', 'after_tool', 'session_start'];
const COMMON_MAPPING: Partial<Record<PlatformId, Partial<Record<HookEvent, string>>>> = {
  codex: { before_tool: 'PreToolUse', after_tool: 'PostToolUse', session_start: 'SessionStart' },
  claude: { before_tool: 'PreToolUse', after_tool: 'PostToolUse', session_start: 'SessionStart' },
  antigravity: { before_tool: 'PreToolUse', after_tool: 'PostToolUse', session_start: 'SessionStart' },
  cursor: { session_start: 'sessionStart' },
  opencode: { before_tool: 'before', after_tool: 'after' },
  pi: { before_tool: 'tool_call', after_tool: 'tool_result', session_start: 'session_start' },
  gemini: { before_tool: 'BeforeTool', after_tool: 'AfterTool', session_start: 'SessionStart' },
  copilot: { before_tool: 'preToolUse', after_tool: 'postToolUse', session_start: 'sessionStart' },
  grok: { before_tool: 'PreToolUse', after_tool: 'PostToolUse', session_start: 'SessionStart' },
};
const CODEX_SOURCE = 'https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/hooks';
const CLAUDE_SOURCE = 'https://code.claude.com/docs/en/hooks';
const ANTIGRAVITY_SOURCE = 'https://antigravity.google/docs/build-plugins#lifecycle-hooks';
const STEM: Record<string, string> = { PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use', PermissionRequest: 'permission-request', SessionStart: 'session-start', SubagentStart: 'subagent-start', UserPromptSubmit: 'user-prompt-submit', Stop: 'stop', SubagentStop: 'subagent-stop' };
const TOOL_FIELDS = ['tool_name', 'tool_input', 'tool_use_id'];
const EVENT_FIELDS: Record<string, string[]> = { PreToolUse: TOOL_FIELDS, PostToolUse: [...TOOL_FIELDS, 'tool_response'], PermissionRequest: ['tool_name', 'tool_input'], SessionStart: ['source'], SubagentStart: ['agent_id', 'agent_type'], UserPromptSubmit: ['prompt'], Stop: ['stop_hook_active'], SubagentStop: ['agent_id', 'agent_type', 'stop_hook_active'] };
const CONTEXT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'SubagentStart', 'UserPromptSubmit']);
const BLOCK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Stop', 'SubagentStop']);
const NO_MATCHER_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'CwdChanged', 'WorktreeCreate', 'WorktreeRemove']);
function knownProtocol(platform: PlatformId, event: string): HookHandlerProtocol | null {
  if ((platform === 'codex' || platform === 'claude') && STEM[event]) {
    const stem = STEM[event]!;
    const responses: HookHandlerProtocol['responses'] = { notify: { exitCode: 0, stdout: null, stderr: null } };
    if (CONTEXT_EVENTS.has(event)) responses.context = { exitCode: 0, stdout: { hookSpecificOutput: { hookEventName: event, additionalContext: '$message' } }, stderr: null };
    if (BLOCK_EVENTS.has(event) && !(platform === 'claude' && event === 'PostToolUse')) responses.block = { exitCode: 2, stdout: null, stderr: '$message' };
    if (platform === 'claude' && event === 'PermissionRequest') {
      responses.block = { exitCode: 0, stdout: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '$message' } } }, stderr: null };
    }
    return {
      id: `${platform}.command-hook.v1`,
      input: { transport: 'stdin-json', eventField: 'hook_event_name', fields: ['session_id', 'transcript_path', 'cwd', 'permission_mode', 'hook_event_name', ...(EVENT_FIELDS[event] ?? [])],
        schemaUrl: platform === 'codex' ? `${CODEX_SOURCE.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')}/schema/generated/${stem}.command.input.schema.json` : `${CLAUDE_SOURCE}#${stem}-input` },
      responses, otherExitCodes: 'diagnostic-only',
      blockEffect: !responses.block ? null : event === 'PreToolUse' ? 'deny-tool' : event === 'PermissionRequest' ? 'deny-permission' : event === 'PostToolUse' ? 'reject-tool-result' : event === 'UserPromptSubmit' ? 'reject-prompt' : 'prevent-completion',
      sources: platform === 'codex' ? [`${CODEX_SOURCE}/src/events/${event === 'SubagentStart' ? 'session_start' : stem.replace(/-/gu, '_')}.rs`, `${CODEX_SOURCE}/src/engine/output_parser.rs`] : [`${CLAUDE_SOURCE}#exit-code-2-behavior-per-event`, `${CLAUDE_SOURCE}#${stem}-decision-control`],
    };
  }
  if (platform === 'antigravity' && ['PreToolUse', 'PostToolUse', 'SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'].includes(event)) {
    const responses: HookHandlerProtocol['responses'] = { notify: { exitCode: 0, stdout: {}, stderr: null } };
    if (['SessionStart', 'PreInvocation', 'PostInvocation'].includes(event)) responses.context = { exitCode: 0, stdout: { injectSteps: [{ userMessage: '$message' }] }, stderr: null };
    if (event === 'PreToolUse' || event === 'Stop') responses.block = { exitCode: 0, stdout: { decision: event === 'PreToolUse' ? 'deny' : 'block', reason: '$message' }, stderr: null };
    return { id: 'antigravity.command-hook.v1', input: { transport: 'stdin-json', eventField: null, fields: [], schemaUrl: null }, responses, otherExitCodes: 'error-ignored', blockEffect: event === 'PreToolUse' ? 'deny-tool' : event === 'Stop' ? 'prevent-completion' : null, sources: [ANTIGRAVITY_SOURCE] };
  }
  if ((platform === 'pi' && ['tool_call', 'tool_result', 'session_start', 'before_agent_start'].includes(event)) || (platform === 'opencode' && ['before', 'after'].includes(event))) {
    return { id: 'aw.serialized-event-notify.v1', input: { transport: 'stdin-json', eventField: null, fields: [], schemaUrl: null },
      responses: { notify: { exitCode: 0, stdout: null, stderr: null } }, otherExitCodes: 'diagnostic-only', blockEffect: null,
      sources: platform === 'pi' ? ['https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/extensions.md'] : ['https://github.com/anomalyco/opencode/blob/v2.0.0/packages/plugin/src/README.md'] };
  }
  return null;
}
function matcherAllowed(platform: PlatformId, event: string): boolean | null {
  if (platform === 'codex' || platform === 'claude') return !NO_MATCHER_EVENTS.has(event);
  if (platform === 'antigravity') return event === 'PreToolUse' || event === 'PostToolUse';
  if (platform === 'pi' || platform === 'opencode') return false;
  return null;
}
const nativeDefinitions = manifestSchema.$defs.extensions.properties.nativeHooks.properties;
const platforms = manifestSchema.properties.platforms.items.enum as PlatformId[];
const REGISTRY: Readonly<Record<PlatformId, PlatformHookHandlers>> = Object.fromEntries(platforms.map((platform) => {
  const definition = nativeDefinitions[platform as keyof typeof nativeDefinitions];
  const events: readonly string[] = definition?.items.properties.event.enum ?? [];
  const native = Object.fromEntries(events.map((event): [string, PlatformHookHandlerContract] => [event, {
    platform, dialect: 'native', event, nativeEvent: event, api: platform === 'pi' ? 'pi.on' : platform === 'opencode' ? 'ctx.tool.hook' : 'command', matcherAllowed: matcherAllowed(platform, event), qualification: 'required', protocol: knownProtocol(platform, event),
  }]));
  const common = Object.fromEntries(COMMON_EVENTS.map((event): [HookEvent, PlatformHookHandlerContract] => {
    const nativeEvent = COMMON_MAPPING[platform]?.[event] ?? null;
    return [event, { platform, dialect: 'common', event, nativeEvent, api: !nativeEvent ? null : platform === 'pi' ? 'pi.on' : platform === 'opencode' ? 'ctx.tool.hook' : 'command',
      matcherAllowed: nativeEvent ? matcherAllowed(platform, nativeEvent) : null,
      qualification: 'required', protocol: nativeEvent ? knownProtocol(platform, nativeEvent) : null }];
  })) as Record<HookEvent, PlatformHookHandlerContract>;
  return [platform, { common, native }];
})) as Record<PlatformId, PlatformHookHandlers>;
export function getPlatformHookHandlerRegistry(): Readonly<Record<PlatformId, PlatformHookHandlers>> { return structuredClone(REGISTRY); }
export function getHookHandlerContract(platform: PlatformId, dialect: 'common' | 'native', event: string): PlatformHookHandlerContract {
  const handler = dialect === 'common' ? REGISTRY[platform]?.common[event as HookEvent] : REGISTRY[platform]?.native[event];
  if (!handler) throw new Error(`Invalid ${platform} ${dialect} hook event ${JSON.stringify(event)}.`);
  return structuredClone(handler);
}
export function createHookHandlerResponse(options: { platform: PlatformId; dialect: 'common' | 'native'; event: string; feedback: HookFeedback; message?: string }): { exitCode: 0 | 2; stdout: string; stderr: string } {
  const handler = getHookHandlerContract(options.platform, options.dialect, options.event);
  const response = handler.protocol?.responses[options.feedback];
  if (!response) throw new Error('Hook handler feedback protocol is unverified or unsupported.');
  const message = options.message ?? '';
  if (options.feedback !== 'notify' && message.trim() === '') throw new Error('Hook handler context/block feedback requires a non-empty message.');
  const substitute = (value: HookResponseBody): HookResponseBody => {
    if ('hookSpecificOutput' in value) {
      if ('decision' in value.hookSpecificOutput) return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
      return { hookSpecificOutput: { ...value.hookSpecificOutput, additionalContext: message } };
    }
    if ('injectSteps' in value) return { injectSteps: [{ userMessage: message }] };
    if (value.decision === 'deny' || value.decision === 'block') return { decision: value.decision, reason: message };
    return {};
  };
  return { exitCode: response.exitCode, stdout: response.stdout ? JSON.stringify(substitute(response.stdout)) : '', stderr: response.stderr === '$message' ? message : '' };
}
