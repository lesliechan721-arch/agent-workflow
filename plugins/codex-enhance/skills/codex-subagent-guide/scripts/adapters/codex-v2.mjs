#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { LIMITS, digest, fail, redact, safeError } from '../runtime/contracts.mjs';
import { safePath, readLimited, textFromBytes, atomicJson, executableIdentity } from '../runtime/files.mjs';

const execFileAsync = promisify(execFile);
export const CODEX_VERSION = '0.160.1';

export function codexArguments(envelope, outputFile, environment = {}) {
  const args = [
    'exec', '--ephemeral', '--json', '--color', 'never', '--skip-git-repo-check',
    '-s', 'read-only', '-c', 'approval_policy="never"', '--output-last-message', outputFile,
    '-c', `developer_instructions=${JSON.stringify(envelope.instructions.text)}`,
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
  if (envelope.run.mode === 'bundle') args.push('-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.js_repl=false', '-c', 'features.code_mode=false', '-c', 'features.apply_patch_freeform=false');
  if (envelope.run.model !== undefined) args.push('-m', envelope.run.model);
  if (envelope.run.reasoningEffort !== undefined) args.push('-c', `model_reasoning_effort=${JSON.stringify(envelope.run.reasoningEffort)}`);
  args.push('-');
  return args;
}

export function codexTerminal(events) {
  const terminals = events.filter((event) => event?.type === 'turn.completed' || event?.type === 'turn.failed');
  if (terminals.length !== 1) return undefined;
  return terminals[0];
}

export async function codexUserPayload(envelope) {
  const materials = [];
  let total = 0;
  if (!Array.isArray(envelope.materials) || envelope.materials.length > LIMITS.files) fail('materialCountExceeded', 'The adapter material count is invalid.');
  for (const material of envelope.materials) {
    const bytes = await readLimited(material.path, LIMITS.fileBytes, 'materialFileTooLarge');
    total += bytes.length;
    if (total > LIMITS.materialBytes) fail('materialTotalTooLarge', 'The adapter material bytes exceed the total limit.');
    if (digest(bytes) !== material.sha256) fail('materialDigestMismatch', 'A captured material changed before adapter submission.');
    materials.push({ source: material.source, sha256: material.sha256, startLine: material.startLine, endLine: material.endLine, content: textFromBytes(bytes) });
  }
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
  if (envelope?.protocolVersion !== 2 || !envelope.run || !envelope.instructions || typeof envelope.task !== 'string') fail('protocolInvalid', 'The adapter requires a separated instruction-v2 request.');
  if (!['workspace', 'bundle'].includes(envelope.run.mode) || envelope.run.access !== 'read-only') fail('adapterAccessUnsupported', 'This Codex adapter accepts read-only workspace and bundle runs only.');
  if (envelope.run.requiredIsolation) fail('isolationUnsupported', 'Strong scope isolation has not been qualified for this adapter.');
  if (typeof envelope.instructions.text !== 'string' || !envelope.instructions.text.trim() || Buffer.byteLength(envelope.instructions.text) > LIMITS.instructionBytes || digest(envelope.instructions.text) !== envelope.instructions.revision) fail('instructionRevisionMismatch', 'The adapter received invalid or incomplete bound instructions.');
  if (Buffer.byteLength(envelope.task) > LIMITS.taskBytes || !envelope.task.trim()) fail('taskInvalid', 'The adapter task is empty or too large.');
  for (const key of ['model', 'reasoningEffort']) if (envelope.run[key] !== undefined && (typeof envelope.run[key] !== 'string' || !envelope.run[key] || /[\u0000-\u001f\u007f]/u.test(envelope.run[key]))) fail('parameterInvalid', 'Model and effort must be clean nonempty strings.');
  if (!['darwin', 'linux'].includes(process.platform)) fail('platformUnsupported', 'This adapter has no Windows process or sandbox qualification.');
  const runDirectory = environment.AW_SUBAGENT_RUN_DIR;
  if (!runDirectory) fail('adapterRunDirectoryMissing', 'The adapter needs a private run directory.');
  await safePath(runDirectory, 'directory');
  if (((await fs.stat(runDirectory)).mode & 0o077) !== 0) fail('runDirectoryNotPrivate', 'The adapter run directory must have mode 0700.');
  const resultFile = await privateOutputPath(runDirectory, environment.AW_SUBAGENT_RESULT_FILE ?? path.join(runDirectory, 'receipt.json'));
  const traceFile = await privateOutputPath(runDirectory, environment.AW_SUBAGENT_TRACE_FILE ?? path.join(runDirectory, 'codex-events.jsonl'));
  const outputFile = await privateOutputPath(runDirectory, path.join(runDirectory, 'codex-last-message.md'));
  const workspace = envelope.run.workspace ?? process.cwd();
  await safePath(workspace, 'directory');
  const userPayload = await codexUserPayload(envelope);
  const receipt = {
    protocolVersion: 2, outcome: 'failed', instructionChannel: 'developer',
    instructionsRevision: envelope.instructions.revision, generationStarted: false,
    adapter: { id: 'codex-exec-v2', version: 1, cliVersion: CODEX_VERSION, platform: process.platform, qualification: 'not-established-by-this-receipt' },
  };
  let submitted = false;
  let interrupted = false;
  let child;
  const onSignal = () => { interrupted = true; if (child) child.kill('SIGTERM'); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    if (!environment.AW_SUBAGENT_CODEX_BINARY || !path.isAbsolute(environment.AW_SUBAGENT_CODEX_BINARY)) fail('codexExecutableMissing', 'Set AW_SUBAGENT_CODEX_BINARY to a trusted absolute Codex executable.');
    const identity = await executableIdentity(environment.AW_SUBAGENT_CODEX_BINARY);
    if (environment.AW_SUBAGENT_CODEX_EXPECTED_SHA256 && identity.sha256 !== environment.AW_SUBAGENT_CODEX_EXPECTED_SHA256) fail('codexExecutableChanged', 'The captured Codex executable changed before submission.');
    await verifyLocalToolConfiguration(workspace, environment);
    const { stdout: version } = await execFileAsync(identity.path, ['--version'], { env: backendEnvironment, cwd: workspace, timeout: 5000, maxBuffer: 16384 });
    if (version.trim() !== `codex-cli ${CODEX_VERSION}`) fail('codexVersionUnsupported', `This adapter requires the exact Codex CLI version ${CODEX_VERSION}.`);
    const events = [];
    const eventDecoder = new StringDecoder('utf8');
    let pending = '';
    let eventBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let invalidEvents = false;
    const diagnostics = [];
    child = spawn(identity.path, codexArguments(envelope, outputFile, backendEnvironment), { shell: false, cwd: workspace, env: backendEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => {
      child.once('error', () => resolve({ code: null }));
      child.once('close', (code) => resolve({ code }));
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    submitted = true;
    receipt.generationStarted = true;
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
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (eventBytes + stderrBytes > LIMITS.logBytes) { overflow = true; child.kill('SIGTERM'); return; }
      diagnostics.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(userPayload);
    const { code } = await exited;
    pending += eventDecoder.end();
    if (pending.trim()) { try { events.push(JSON.parse(pending)); } catch { invalidEvents = true; } }
    await fs.writeFile(traceFile, redact(events.map((event) => JSON.stringify(event)).join('\n') + '\n', environment), { mode: 0o600, flag: 'wx' });
    receipt.traceFile = path.relative(runDirectory, traceFile);
    const terminal = codexTerminal(events);
    const session = events.find((event) => event.type === 'thread.started' && typeof event.thread_id === 'string');
    if (session) receipt.providerSessionId = session.thread_id;
    if (terminal && !invalidEvents && !overflow) receipt.providerTerminal = terminal.type;
    const usage = terminal?.usage;
    if (usage && Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0) && Object.values(usage).some((value) => value > 0)) receipt.usage = usage;
    let finalText = '';
    try { finalText = textFromBytes(await readLimited(outputFile, LIMITS.outputBytes, 'outputTooLarge')); await fs.chmod(outputFile, 0o600); } catch { /* Missing final output cannot prove success. */ }
    if (finalText) await fs.writeFile(outputFile, redact(finalText, environment), { mode: 0o600 });
    const scopeViolation = events.some((event) => ['mcp_tool_call', 'collab_tool_call', 'web_search', 'file_change'].includes(event?.item?.type) || (envelope.run.mode === 'bundle' && event?.item?.type === 'command_execution'));
    if (scopeViolation) receipt.scopeViolation = true;
    receipt.outcome = code === 0 && terminal?.type === 'turn.completed' && finalText.trim() && !interrupted && !overflow && !invalidEvents && !scopeViolation ? 'completed'
      : terminal?.type === 'turn.failed' && !invalidEvents && !overflow ? 'failed' : 'unknown';
    if (receipt.outcome === 'failed' && /(?:model|reasoning.?effort).*(?:not supported|unsupported|not found|does not exist|unavailable|not available|invalid|not permitted)/i.test(terminal?.error?.message ?? '')) receipt.code = 'parameterUnavailable';
    receipt.localExitCode = code;
    if (interrupted) receipt.remoteStopConfirmed = false;
    // Raw CLI errors may contain config values. Keep only a stable program diagnosis.
    if (diagnostics.length && receipt.outcome !== 'completed') process.stderr.write('Codex did not produce a confirmed complete result. Inspect the redacted private event trace.\n');
    await atomicJson(resultFile, receipt);
    return { text: redact(finalText, environment), receipt };
  } catch (error) {
    receipt.outcome = submitted ? 'unknown' : 'failed';
    receipt.generationStarted = submitted;
    receipt.code = safeError(error).code;
    await atomicJson(resultFile, receipt);
    throw error;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
}

async function main() {
  process.umask(0o077);
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Codex instruction-v2 adapter\nUsage: node codex-v2.mjs < request.json\nRequires AW_SUBAGENT_RUN_DIR, AW_SUBAGENT_RESULT_FILE, and an absolute AW_SUBAGENT_CODEX_BINARY (Codex 0.160.1).\nSupports read-only workspace and text bundle execution; no resume or confirmed remote cancellation.\nModel and OS qualification must be recorded separately. User/project execpolicy rules remain enabled. Automatic project AGENTS.md loading is disabled; the task must carry required project constraints. Codex home user instructions may still load.\n');
    return;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > LIMITS.materialBytes + LIMITS.taskBytes + LIMITS.instructionBytes + 1048576) fail('protocolTooLarge', 'The instruction-v2 input is too large.');
    chunks.push(chunk);
  }
  let envelope;
  try { envelope = JSON.parse(textFromBytes(Buffer.concat(chunks))); } catch (error) { if (error.code) throw error; fail('protocolInvalid', 'The instruction-v2 input is not valid JSON.'); }
  const result = await executeCodex(envelope);
  if (result.text) process.stdout.write(result.text);
  if (result.receipt.outcome !== 'completed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => {
  process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
  process.exitCode = 1;
});
