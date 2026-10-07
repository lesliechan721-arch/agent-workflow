#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { LIMITS, cleanString, fail, redact, safeError } from '../runtime/contracts.mjs';
import { safePath, readLimited, textFromBytes, atomicJson, executablePaths, materialSource } from '../runtime/files.mjs';

const execFileAsync = promisify(execFile);
export const CODEX_VERSION = '0.160.1';

export function codexArguments(envelope, outputFile, environment = {}) {
  const args = [
    'exec', '--ephemeral', '--json', '--color', 'never', '--skip-git-repo-check',
    '-s', 'read-only', '-c', 'approval_policy="never"', '--output-last-message', outputFile,
    '-c', `developer_instructions=${JSON.stringify(envelope.instructions)}`,
    '-c', 'features.multi_agent=false', '-c', 'features.collab=false',
    '-c', 'features.apps=false', '-c', 'features.connectors=false',
    '-c', 'features.plugins=false', '-c', 'features.codex_hooks=false', '-c', 'features.hooks=false',
    '-c', 'features.skip_host_skill_discovery=true', '-c', 'web_search="disabled"',
    '-c', 'features.browser_use=false', '-c', 'features.browser_use_external=false',
    '-c', 'features.computer_use=false', '-c', 'features.image_generation=false', '-c', 'features.view_image=false',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'shell_environment_policy.inherit="none"',
  ];
  const inheritedMarkers = ['AW_AGENT_SKILL_EVAL_PROCESS_MARKER', 'AW_SUBAGENT_PROCESS_TOKEN', 'PATH', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS'].filter((key) => typeof environment[key] === 'string');
  if (inheritedMarkers.length) args.push('-c', `shell_environment_policy.set={${inheritedMarkers.map((key) => `${key}=${JSON.stringify(environment[key])}`).join(',')}}`);
  if (envelope.mode === 'bundle') args.push('-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.js_repl=false', '-c', 'features.code_mode=false', '-c', 'features.apply_patch_freeform=false');
  if (envelope.execution.model !== undefined) args.push('-m', envelope.execution.model);
  if (envelope.execution.reasoningEffort !== undefined) args.push('-c', `model_reasoning_effort=${JSON.stringify(envelope.execution.reasoningEffort)}`);
  args.push('-');
  return args;
}

export function codexTerminal(events) {
  const terminals = events.filter((event) => event?.type === 'turn.completed' || event?.type === 'turn.failed');
  if (terminals.length !== 1) return undefined;
  return terminals[0];
}

export function codexUserPayload(envelope) {
  if (!Array.isArray(envelope.materials) || envelope.materials.length > LIMITS.files) fail('materialCountExceeded', 'The adapter material count is invalid.');
  let total = 0;
  const sources = new Set();
  const materials = envelope.materials.map((material) => {
    materialSource(material.source);
    if (sources.has(material.source)) fail('materialDuplicate', 'A material was supplied more than once.');
    sources.add(material.source);
    if (typeof material.content !== 'string' || material.content.includes('\0')) fail('materialInvalid', 'Materials require UTF-8 text content.');
    const bytes = Buffer.byteLength(material.content);
    total += bytes;
    if (bytes > LIMITS.fileBytes || total > LIMITS.materialBytes) fail('materialTooLarge', 'The adapter material bytes exceed the limit.');
    if (!Number.isSafeInteger(material.startLine) || material.startLine < 1 || !Number.isSafeInteger(material.endLine) || material.endLine < material.startLine || typeof material.originalPath !== 'string') fail('materialInvalid', 'A material requires an original reference and valid line range.');
    return { source: material.source, originalPath: material.originalPath, startLine: material.startLine, endLine: material.endLine, content: material.content };
  });
  return JSON.stringify({ task: envelope.task, materials });
}

async function verifyLocalToolConfiguration(workspace, environment) {
  const home = environment.CODEX_HOME ?? path.join(environment.HOME ?? os.homedir(), '.codex');
  const systemRoot = process.platform === 'darwin' ? '/private/etc/codex' : '/etc/codex';
  const candidates = new Set([path.join(home, 'config.toml'), path.join(systemRoot, 'config.toml'), path.join(systemRoot, 'managed_config.toml')]);
  for (let cursor = workspace; ; cursor = path.dirname(cursor)) {
    candidates.add(path.join(cursor, '.codex', 'config.toml'));
    if (path.dirname(cursor) === cursor) break;
  }
  for (const candidate of candidates) {
    try {
      const text = textFromBytes(await readLimited(candidate, LIMITS.fileBytes));
      // This small boundary reader supports ordinary TOML sections and scalar settings.
      // Unsupported composite syntax is rejected rather than interpreted as actual tool evidence.
      if (text.includes('"""') || text.includes("'''")) fail('toolConfigurationSyntaxUnsupported', 'This adapter cannot verify a configuration that uses multiline TOML strings. Use a separately qualified restricted configuration.');
      const lines = text.split('\n').map((line) => {
        let quote;
        let escaped = false;
        let end = line.length;
        for (let index = 0; index < line.length; index++) {
          const char = line[index];
          if (quote) {
            if (quote === '"' && char === '\\' && !escaped) { escaped = true; continue; }
            if (char === quote && !escaped) quote = undefined;
            escaped = false;
          } else if (char === '"' || char === "'") quote = char;
          else if (char === '#') { end = index; break; }
          else if (char === '{') fail('toolConfigurationSyntaxUnsupported', 'This adapter cannot verify inline TOML tables. Use a separately qualified restricted configuration.');
        }
        return line.slice(0, end).trim();
      });
      const externalToolKeys = new Set(['mcp_servers', 'hooks', 'environments', 'exec_server', 'remote_execution']);
      for (const line of lines) {
        let key;
        if (line.startsWith('[')) {
          const table = line.match(/^\[\[?\s*(.*?)\s*\]\]?$/);
          if (!table) fail('toolConfigurationSyntaxUnsupported', 'This adapter cannot verify the TOML table key syntax.');
          key = table[1];
        } else {
          const equals = line.indexOf('=');
          if (equals < 0) continue;
          key = line.slice(0, equals).trim();
        }
        // Quoted key escapes can change a key's meaning after Codex decodes TOML.
        // Only plain bare keys and unescaped quoted keys are supported here.
        if (key.includes('\\')) fail('toolConfigurationSyntaxUnsupported', 'This adapter cannot verify escaped TOML keys. Use a separately qualified restricted configuration.');
        const tokens = key.match(/"[^"\\]*"|'[^'\\]*'|[A-Za-z0-9_-]+/g) ?? [];
        const remainder = key.replace(/"[^"\\]*"|'[^'\\]*'|[A-Za-z0-9_-]+/g, '');
        if (!tokens.length || !/^[.\s]*$/.test(remainder)) fail('toolConfigurationSyntaxUnsupported', 'This adapter cannot verify the TOML key syntax.');
        if (tokens.some((token) => externalToolKeys.has(token.startsWith('"') || token.startsWith("'") ? token.slice(1, -1) : token))) fail('toolConfigurationUnsupported', 'This Codex adapter cannot verify read-only behavior with configured external tools, hooks, or remote execution. Use a separately qualified restricted configuration.');
      }
    } catch (error) {
      if (error?.code === 'pathMissing') continue;
      throw error;
    }
  }
}

async function privateOutputPath(runDirectory, output) {
  if (!path.isAbsolute(output) || path.relative(runDirectory, output).startsWith('..') || output === runDirectory) fail('adapterOutputPathInvalid', 'Adapter outputs must stay inside the private run directory.');
  await safePath(path.dirname(output), 'directory');
  try { await fs.lstat(output); fail('adapterOutputExists', 'An adapter output already exists. This adapter does not resubmit existing runs.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return output;
}

export async function executeCodex(envelope, environment = process.env) {
  const backendEnvironment = {
    ...Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME', 'OPENAI_API_KEY', 'AW_SUBAGENT_PROCESS_TOKEN', 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER'].filter((key) => typeof environment[key] === 'string').map((key) => [key, environment[key]])),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  };
  if (envelope?.protocolVersion !== 3 || !envelope.execution || typeof envelope.instructions !== 'string' || typeof envelope.task !== 'string') fail('protocolInvalid', 'The adapter requires a separated v3 request. Old v2 requests must be migrated.');
  if (!['workspace', 'bundle'].includes(envelope.mode) || envelope.access !== 'read-only') fail('adapterAccessUnsupported', 'This Codex adapter accepts read-only workspace and bundle calls only.');
  if (!envelope.instructions.trim() || Buffer.byteLength(envelope.instructions) > LIMITS.instructionBytes) fail('instructionsInvalid', 'The adapter requires complete, nonempty instructions within the size limit.');
  if (Buffer.byteLength(envelope.task) > LIMITS.taskBytes || !envelope.task.trim()) fail('taskInvalid', 'The adapter task is empty or too large.');
  for (const key of ['model', 'reasoningEffort']) if (!cleanString(envelope.execution[key])) fail('parameterInvalid', 'Model and effort must be clean nonempty strings.');
  if (!['darwin', 'linux'].includes(process.platform)) fail('platformUnsupported', 'This adapter has no Windows process or sandbox qualification.');
  const directory = environment.AW_SUBAGENT_TEMP_DIR;
  if (!directory) fail('adapterDirectoryMissing', 'The adapter needs AW_SUBAGENT_TEMP_DIR.');
  await safePath(directory, 'directory');
  if (((await fs.stat(directory)).mode & 0o077) !== 0) fail('directoryNotPrivate', 'The adapter temporary directory must have mode 0700.');
  const resultFile = await privateOutputPath(directory, environment.AW_SUBAGENT_RESULT_FILE ?? path.join(directory, 'result.json'));
  const traceFile = await privateOutputPath(directory, path.join(directory, 'codex-events.jsonl'));
  const outputFile = await privateOutputPath(directory, path.join(directory, 'codex-last-message.md'));
  if (envelope.mode === 'bundle' ? envelope.workspace !== null : !path.isAbsolute(envelope.workspace ?? '')) fail('workspaceInvalid', 'Workspace mode needs an absolute path; bundle mode must use null.');
  const workspace = envelope.mode === 'bundle' ? directory : envelope.workspace;
  await safePath(workspace, 'directory');
  const userPayload = codexUserPayload(envelope);
  const result = {
    protocolVersion: 3, state: 'failed', instructionChannel: 'developer', generationStarted: false,
    service: { state: 'failed' }, text: '',
    access: { mode: 'read-only', restrictions: [
      'Codex read-only sandbox and approval_policy=never are used. This does not establish strong scope isolation.',
      ...(envelope.mode === 'bundle' ? ['Shell and workspace tools are disabled; only the supplied material copies enter task data.'] : ['Tools can read the live workspace.']),
      'User configuration and execution policy remain enabled; user instructions may load. Automatic project AGENTS.md loading is disabled.',
      'Remote cancellation is not confirmed by this adapter.',
    ] },
    adapter: { id: 'codex-exec-v3', cliVersion: CODEX_VERSION, platform: process.platform },
  };
  let submitted = false;
  let interrupted = false;
  let child;
  const onSignal = () => { interrupted = true; if (child) child.kill('SIGTERM'); };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    if (!environment.AW_SUBAGENT_CODEX_BINARY || !path.isAbsolute(environment.AW_SUBAGENT_CODEX_BINARY)) fail('codexExecutableMissing', 'Set AW_SUBAGENT_CODEX_BINARY to a trusted absolute Codex executable.');
    const executable = await executablePaths(environment.AW_SUBAGENT_CODEX_BINARY);
    await verifyLocalToolConfiguration(workspace, environment);
    const { stdout: version } = await execFileAsync(executable.command, ['--version'], { env: backendEnvironment, cwd: workspace, timeout: 5000, maxBuffer: 16384 });
    if (version.trim() !== `codex-cli ${CODEX_VERSION}`) fail('codexVersionUnsupported', `This adapter requires Codex CLI ${CODEX_VERSION}.`);
    if (interrupted) fail('adapterStoppedBeforeSubmission', 'The adapter was stopped before generation.');
    const events = [];
    const eventDecoder = new StringDecoder('utf8');
    let pending = '';
    let eventBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let invalidEvents = false;
    child = spawn(executable.command, codexArguments(envelope, outputFile, backendEnvironment), { shell: false, detached: false, cwd: workspace, env: backendEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => { child.once('error', () => resolve({ code: null })); child.once('close', (code) => resolve({ code })); });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    submitted = true; result.generationStarted = true;
    child.stdout.on('data', (chunk) => {
      eventBytes += chunk.length;
      if (eventBytes + stderrBytes > LIMITS.logBytes) { overflow = true; child.kill('SIGTERM'); return; }
      pending += eventDecoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { invalidEvents = true; }
      }
    });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (eventBytes + stderrBytes > LIMITS.logBytes) { overflow = true; child.kill('SIGTERM'); } });
    child.stdin.on('error', () => {});
    child.stdin.end(userPayload);
    const { code } = await exited;
    pending += eventDecoder.end();
    if (pending.trim()) { try { events.push(JSON.parse(pending)); } catch { invalidEvents = true; } }
    await fs.writeFile(traceFile, events.map((event) => JSON.stringify(event, (_key, value) => typeof value === 'string' ? redact(value, environment) : value)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    const terminal = codexTerminal(events);
    const sessions = events.filter((event) => event.type === 'thread.started' && typeof event.thread_id === 'string');
    if (sessions.length === 1) result.service.sessionId = sessions[0].thread_id;
    if (terminal && !invalidEvents && !overflow) result.service.event = terminal.type;
    if (terminal?.usage && Object.values(terminal.usage).every((value) => Number.isSafeInteger(value) && value >= 0)) result.usage = terminal.usage;
    let finalText = '';
    let outputInvalid = false;
    try { finalText = textFromBytes(await readLimited(outputFile, LIMITS.outputBytes, 'outputTooLarge')); await fs.chmod(outputFile, 0o600); }
    catch (error) { outputInvalid = error?.code !== 'pathMissing'; }
    const scopeViolation = events.some((event) => ['mcp_tool_call', 'collab_tool_call', 'web_search', 'file_change'].includes(event?.item?.type) || (envelope.mode === 'bundle' && event?.item?.type === 'command_execution'));
    result.state = !interrupted && !overflow && !invalidEvents && !scopeViolation && !outputInvalid && sessions.length === 1 && code === 0 && terminal?.type === 'turn.completed' && finalText.trim() ? 'completed'
      : !interrupted && !overflow && !invalidEvents && !scopeViolation && sessions.length === 1 && terminal?.type === 'turn.failed' ? 'failed' : 'unknown';
    result.service.state = !invalidEvents && !overflow && terminal ? (terminal.type === 'turn.completed' ? 'completed' : 'failed') : 'unknown';
    result.text = redact(finalText, environment);
    if (scopeViolation) result.code = 'accessViolationObserved';
    else if (overflow || outputInvalid) result.code = 'adapterOutputInvalid';
    else if (result.state === 'unknown') result.code = 'serviceTerminalUnconfirmed';
    if (result.state === 'failed' && /(?:model|reasoning.?effort).*(?:not supported|unsupported|not found|does not exist|unavailable|not available|invalid|not permitted)/i.test(terminal?.error?.message ?? '')) result.code = 'parameterUnavailable';
    result.localExitCode = code;
    if (interrupted) result.remoteStopConfirmed = false;
    await atomicJson(resultFile, result);
    return result;
  } catch (error) {
    result.state = submitted ? 'unknown' : 'failed'; result.service.state = result.state;
    result.generationStarted = submitted; result.code = safeError(error).code;
    if (interrupted) result.remoteStopConfirmed = false;
    await atomicJson(resultFile, result);
    return result;
  } finally { process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); }
}

async function main() {
  process.umask(0o077);
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Codex v3 foreground adapter\nUsage: node codex-v3.mjs < request.json\nRequires private AW_SUBAGENT_TEMP_DIR, AW_SUBAGENT_RESULT_FILE, and absolute AW_SUBAGENT_CODEX_BINARY (Codex 0.160.1).\nSupports read-only workspace and explicit text bundles. No resume or confirmed remote cancellation.\nModel and OS qualification need separate evidence.\n');
    return;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    // JSON escaping can use six bytes for one input byte; reject rather than truncate.
    if (bytes > 6 * (LIMITS.materialBytes + LIMITS.taskBytes + LIMITS.instructionBytes) + 1048576) fail('protocolTooLarge', 'The v3 input is too large.');
    chunks.push(chunk);
  }
  let envelope;
  try { envelope = JSON.parse(textFromBytes(Buffer.concat(chunks))); } catch (error) { if (error.code) throw error; fail('protocolInvalid', 'The v3 input is not valid JSON.'); }
  const result = await executeCodex(envelope);
  if (result.state !== 'completed') process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => {
  process.stderr.write(`${JSON.stringify(safeError(error))}\n`); process.exitCode = 1;
});
