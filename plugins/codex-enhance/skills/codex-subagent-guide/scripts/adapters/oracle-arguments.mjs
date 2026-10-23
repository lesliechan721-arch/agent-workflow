import { fail } from '../runtime/contracts.mjs';
import { checkArguments, rejectOption } from './common.mjs';

export function assertOracleFileSelectionSupported(fileSelectors, platform = process.platform) {
  // Native Windows ignore paths do not match normalized candidate paths.
  // Until this path satisfies v1, do not submit a task with selected material.
  if (platform === 'win32' && fileSelectors.length > 0) {
    fail('fileSelectionUnsupported', 'Oracle file selection does not support AW file selection v1 on Windows. Use an executor with v1 support.');
  }
}

// Oracle normalizeThinkingTimeLevel, commit 35d8022f370dc89e962637e4e88d3d8d35618f3d.
// Pro is a deliberate tier, not an alias for heavy, max, or ultra.
const thinkingTimes = new Map([
  ['light', 'light'], ['instant', 'light'], ['low', 'light'],
  ['standard', 'standard'], ['medium', 'standard'],
  ['extended', 'extended'], ['high', 'extended'],
  ['extra-high', 'extra-high'], ['extrahigh', 'extra-high'], ['xhigh', 'extra-high'],
  ['pro', 'pro'], ['heavy', 'heavy'],
]);

export function checkOracleArguments(request, owned = []) {
  let engine;
  let model = request.execution.model;
  checkArguments(request.args, {
    owned: ['--prompt', '-p', '--message', '--file', '-f', '--include', '--files', '--path', '--paths', '--wait', '--no-wait', '--write-output', '--models', '--followup', '--followup-model', '--browser-follow-up', '--browser-tab', '--session', '--status', '--exec-session', '--dry-run', '--preview', '--route', '--preflight', '--render', '--render-markdown', '--copy', '--copy-markdown', '--debug-help', '--help', '-h', '--version', '-V', ...owned],
    commands: ['serve', 'project-sources', 'bridge', 'tui', 'doctor', 'docs', 'session', 'status', 'restart'],
    short: { '-m': 'value', '-e': 'value', '-s': 'value', '-v': 'boolean' },
    // Required values in Oracle's bin/oracle-cli.ts at the commit above. Like
    // Commander, consume the next token even when it looks like a control.
    values: [
      '--engine', '--mode', '--model', '--reasoning-effort', '--reasoning-mode', '--slug', '--max-file-size-bytes',
      '--timeout', '--http-timeout', '--zombie-timeout', '--perf-trace-path', '--partial', '--search', '--max-input', '--max-output',
      '--base-url', '--provider', '--azure-endpoint', '--azure-deployment', '--azure-api-version',
      '--browser-chrome-profile', '--browser-chrome-path', '--browser-cookie-path', '--chatgpt-url', '--browser-url',
      '--browser-timeout', '--browser-input-timeout', '--browser-approval-wait', '--browser-attachment-timeout',
      '--browser-recheck-delay', '--browser-recheck-timeout', '--browser-reuse-wait', '--browser-profile-lock-timeout',
      '--browser-max-concurrent-tabs', '--browser-auto-reattach-delay', '--browser-auto-reattach-interval', '--browser-auto-reattach-timeout',
      '--browser-cookie-wait', '--browser-port', '--browser-debug-port', '--browser-cookie-names', '--browser-inline-cookies',
      '--browser-inline-cookies-file', '--browser-manual-login-profile-dir', '--copy-profile', '--browser-model-strategy',
      '--browser-thinking-time', '--browser-research', '--browser-archive', '--browser-attachments', '--remote-chrome',
      '--remote-host', '--remote-token', '--browser-bundle-format', '--youtube', '--generate-image', '--edit-image', '--output',
      '--aspect', '--retain-hours', '--heartbeat',
    ],
    booleans: ['--files-report', '--verbose', '--notify', '--no-notify', '--notify-sound', '--no-notify-sound', '--background', '--no-background', '--zombie-last-activity', '--perf-trace', '--render-plain', '--write-artifacts', '--allow-partial', '--verbose-render', '--no-azure', '--browser', '--browser-attach-running', '--browser-cookie-sync', '--browser-manual-login', '--browser-capture-provider-native', '--no-browser-capture-provider-native', '--browser-inline-files', '--browser-bundle-files', '--gemini-show-thoughts', '--no-gemini-fallback', '--force'],
    onOption(option, value) {
      if (['--model', '-m'].includes(option)) {
        if (request.execution.model !== undefined) rejectOption(option);
        model = value;
      }
      if (request.execution.reasoningEffort !== undefined && ['--reasoning-effort', '--browser-thinking-time'].includes(option)) rejectOption(option);
      if (['--engine', '--mode', '-e', '--browser'].includes(option)) {
        const selected = option === '--browser' ? 'browser' : value;
        if (!['api', 'browser'].includes(selected)) fail('parameterUnavailable', 'Oracle engine must be api or browser. Set oracleEngine or an explicit --engine value.');
        if (engine !== undefined && selected !== engine) fail('adapterArgumentConflict', 'Oracle engine options conflict. Keep one engine selection.');
        engine = selected;
      }
    },
  });
  return { engine, model };
}

export function oracleArguments(request, outputFile) {
  const { engine, model } = checkOracleArguments(request);
  const args = ['--prompt', '-', '--wait', '--write-output', outputFile, ...request.args];
  if (request.execution.model !== undefined) args.push('--model', request.execution.model);
  if (request.execution.reasoningEffort !== undefined) {
    if (engine === undefined) fail('parameterUnavailable', 'Oracle reasoningEffort needs an explicit engine. Set oracleEngine to browser or api, or set --engine in args.');
    if (engine === 'browser') {
      if (model?.trim().toLowerCase().startsWith('gemini')) fail('parameterUnavailable', 'Oracle Gemini browser models do not support thinking time. Omit reasoningEffort or select a supported ChatGPT model.');
      const effort = thinkingTimes.get(request.execution.reasoningEffort.trim().toLowerCase().replace(/[_\s]+/g, '-'));
      if (effort === undefined) fail('parameterUnavailable', 'Oracle browser effort is unavailable. Use low, medium, high, xhigh, light, standard, extended, extra-high, pro, or heavy.');
      args.push('--browser-thinking-time', effort);
    } else args.push('--reasoning-effort', request.execution.reasoningEffort);
  }
  for (const selector of request.fileSelectors) args.push('--file', selector);
  return args;
}
