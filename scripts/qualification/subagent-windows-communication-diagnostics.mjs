#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit fake-only native diagnosis. Original assertions and receive,
// response, process, and late-ready windows remain unchanged.
const prefix = 'AW_SUBAGENT_WINDOWS_COMMUNICATION_DIAGNOSTICS';
const emit = (value) => process.stdout.write(`${prefix} ${JSON.stringify(value)}\n`);
const source = fileURLToPath(new URL('../../plugins/codex-enhance/', import.meta.url));
const phases = new Set([
  'bridge.requestVerified', 'bridge.receiveCheck', 'bridge.receiveClaimed', 'bridge.receiveTimeout',
  'bridge.receiveReleased', 'bridge.sendBegin', 'bridge.sendEnd', 'bridge.responseBegin',
  'bridge.responseSaved', 'tool.begin', 'tool.bindingVerified', 'tool.requestSaved', 'tool.responseRead',
  'mcp.handle', 'mcp.writeQueued', 'mcp.writeCompleted', 'store.contextBegin', 'store.contextReady',
  'store.mkdirBegin', 'store.mkdirCreated', 'store.directoryProtected', 'store.directoryError',
  'store.rootVerifyBegin', 'store.rootVerifyEnd', 'store.rootVerifyError', 'cli.error',
]);

function replaceOnce(text, before, after) {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error('The diagnostic source boundary changed.');
  return text.replace(before, after);
}

const helper = String.raw`
import { appendFileSync as diagnosticAppend } from 'node:fs';
function diagnosticPhase(phase, details = {}) {
  const target = process.env.AW_SUBAGENT_COMMUNICATION_TRACE_FILE;
  if (!target) return;
  const entry = process.argv[1] ?? '';
  const role = entry.endsWith('worker.mjs') ? 'worker' : entry.endsWith('message-mcp.mjs') ? 'mcp'
    : ['start', 'wait', 'result', 'stop'].includes(process.argv[2]) ? process.argv[2] : 'test';
  try { diagnosticAppend(target, JSON.stringify({ phase, time: Date.now(), pid: process.pid, role, ...details }) + '\n'); } catch {}
}
`;

const withHelper = (text) => text.startsWith('#!') ? text.slice(0, text.indexOf('\n') + 1) + helper + text.slice(text.indexOf('\n') + 1) : helper + text;

async function instrument(scripts) {
  const channelFile = path.join(scripts, 'runtime/adapter-channel.mjs');
  let channel = await fs.readFile(channelFile, 'utf8');
  const channelChanges = [
    ["        waiter.resolve({ outcome: 'timeout' });", "        diagnosticPhase('bridge.receiveTimeout');\n        waiter.resolve({ outcome: 'timeout' });"],
    ["      if (closed) response = closedResponse(request.operation);", "      diagnosticPhase('bridge.requestVerified', { operation: request.operation, timeoutMs: request.timeoutMs });\n      if (closed) response = closedResponse(request.operation);"],
    ["        const sending = Promise.resolve().then(() => emitParentMessage(request.text));", "        const sending = Promise.resolve().then(() => { diagnosticPhase('bridge.sendBegin'); return emitParentMessage(request.text); });"],
    ["        try { await sending; response = { outcome: 'submitted' }; }", "        try { await sending; diagnosticPhase('bridge.sendEnd'); response = { outcome: 'submitted' }; }"],
    ["        if (receiveActive) response = errorResponse('receiveAlreadyPending', 'Only one receive call can be active.');", "        diagnosticPhase('bridge.receiveCheck', { active: receiveActive, timeoutMs });\n        if (receiveActive) response = errorResponse('receiveAlreadyPending', 'Only one receive call can be active.');"],
    ['          receiveActive = true; ownsReceive = true;', "          receiveActive = true; ownsReceive = true; diagnosticPhase('bridge.receiveClaimed', { timeoutMs });"],
    ['      await atomicJson(responsePath, response);', "      diagnosticPhase('bridge.responseBegin', { outcome: response.outcome, code: response.code });\n      await atomicJson(responsePath, response);\n      diagnosticPhase('bridge.responseSaved', { outcome: response.outcome, code: response.code });"],
    ['    } finally { if (ownsReceive) receiveActive = false; }', "    } finally { if (ownsReceive) { receiveActive = false; diagnosticPhase('bridge.receiveReleased'); } }"],
    ["  const directory = path.dirname(bindingFile);", "  diagnosticPhase('tool.begin', { operation, timeoutMs });\n  const directory = path.dirname(bindingFile);"],
    ["  const id = token(); const requestPath = path.join(directory, `${id}.request.json`); const responsePath = path.join(directory, `${id}.response.json`);", "  diagnosticPhase('tool.bindingVerified', { operation });\n  const id = token(); const requestPath = path.join(directory, `${id}.request.json`); const responsePath = path.join(directory, `${id}.response.json`);"],
    ["    await atomicJson(requestPath, { binding: descriptor.binding, operation, ...(operation === 'send' ? { text } : { timeoutMs: timeoutMs ?? LIMITS.receiveMs }) });", "    await atomicJson(requestPath, { binding: descriptor.binding, operation, ...(operation === 'send' ? { text } : { timeoutMs: timeoutMs ?? LIMITS.receiveMs }) });\n    diagnosticPhase('tool.requestSaved', { operation });"],
    ["      try { await verifyPrivatePath(responsePath, 'file'); return await readJson(responsePath, LIMITS.messageFrameBytes); }", "      try { await verifyPrivatePath(responsePath, 'file'); const response = await readJson(responsePath, LIMITS.messageFrameBytes); diagnosticPhase('tool.responseRead', { operation, outcome: response.outcome, code: response.code }); return response; }"],
  ];
  for (const [before, after] of channelChanges) channel = replaceOnce(channel, before, after);
  await fs.writeFile(channelFile, withHelper(channel));

  const mcpFile = path.join(scripts, 'message-mcp.mjs');
  let mcp = await fs.readFile(mcpFile, 'utf8');
  mcp = replaceOnce(mcp, '  const write = (value) => {', "  const write = (value) => {\n    diagnosticPhase('mcp.writeQueued', { requestId: Number.isSafeInteger(value?.id) ? value.id : null });");
  mcp = replaceOnce(mcp, '    return operation;', "    return operation.then((value) => { diagnosticPhase('mcp.writeCompleted'); return value; });");
  mcp = replaceOnce(mcp, "    if (!Object.hasOwn(request, 'id')) return;", "    if (!Object.hasOwn(request, 'id')) return;\n    diagnosticPhase('mcp.handle', { requestId: Number.isSafeInteger(request.id) ? request.id : null, method: ['initialize', 'tools/list', 'tools/call'].includes(request.method) ? request.method : 'other' });");
  await fs.writeFile(mcpFile, withHelper(mcp));

  const storeFile = path.join(scripts, 'runtime/store.mjs');
  let store = await fs.readFile(storeFile, 'utf8');
  store = replaceOnce(store, 'export async function storeContext(options = {}) {', "export async function storeContext(options = {}) {\n  diagnosticPhase('store.contextBegin');");
  store = replaceOnce(store, '  return { owner, root: path.join(temporary, `aw-subagent-v5-${userKey}`), table: undefined };', "  diagnosticPhase('store.contextReady');\n  return { owner, root: path.join(temporary, `aw-subagent-v5-${userKey}`), table: undefined };");
  store = replaceOnce(store, `async function privateDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  await protectPrivatePath(directory, 'directory');
}`, `async function privateDirectory(directory) {
  const name = path.basename(directory);
  const resource = /^aw-subagent-v5-/.test(name) ? 'userRoot' : ['events', 'outbox', 'gaps', 'adapter'].includes(name) ? name : 'run';
  diagnosticPhase('store.mkdirBegin', { resource });
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    diagnosticPhase('store.mkdirCreated', { resource });
    await protectPrivatePath(directory, 'directory');
    diagnosticPhase('store.directoryProtected', { resource });
  } catch (error) { diagnosticPhase('store.directoryError', { resource, code: error?.code }); throw error; }
}`);
  store = replaceOnce(store, "  await verifyPrivatePath(context.root, 'directory', context.owner);\n  const id = randomBytes(16).toString('hex');", "  diagnosticPhase('store.rootVerifyBegin');\n  try { await verifyPrivatePath(context.root, 'directory', context.owner); diagnosticPhase('store.rootVerifyEnd'); }\n  catch (error) { diagnosticPhase('store.rootVerifyError', { code: error?.code }); throw error; }\n  const id = randomBytes(16).toString('hex');");
  await fs.writeFile(storeFile, withHelper(store));

  const entryFile = path.join(scripts, 'subagent.mjs');
  let entry = await fs.readFile(entryFile, 'utf8');
  entry = replaceOnce(entry, 'main().catch(async (error) => {', "main().catch(async (error) => {\n  diagnosticPhase('cli.error', { code: error?.code });");
  await fs.writeFile(entryFile, withHelper(entry));
}

function safePhase(value, began) {
  if (!phases.has(value?.phase) || !Number.isSafeInteger(value.time) || !Number.isSafeInteger(value.pid)) return null;
  const result = { phase: value.phase, elapsedMs: value.time - began, pid: value.pid, role: value.role };
  if (!['test', 'worker', 'mcp', 'start', 'wait', 'result', 'stop'].includes(result.role)) return null;
  for (const key of ['operation', 'resource', 'code', 'outcome', 'method']) {
    if (typeof value[key] === 'string' && /^[A-Za-z][A-Za-z0-9/]{0,63}$/.test(value[key])) result[key] = value[key];
  }
  for (const key of ['timeoutMs', 'requestId']) if (Number.isSafeInteger(value[key])) result[key] = value[key];
  if (typeof value.active === 'boolean') result.active = value.active;
  return result;
}

async function runCase(plugin, directory, testCase) {
  const temporary = path.join(directory, `temporary-${testCase.name}`);
  const trace = path.join(directory, `trace-${testCase.name}.jsonl`);
  await fs.mkdir(temporary);
  const began = Date.now(); let cursor = 0, pendingDrain;
  const drain = () => pendingDrain ??= (async () => {
    const contents = await fs.readFile(trace, 'utf8').catch(() => '');
    if (Buffer.byteLength(contents) > 4194304) throw new Error('The diagnostic trace exceeded its bound.');
    const lines = contents.split('\n');
    while (cursor < lines.length - 1) {
      const value = safePhase(JSON.parse(lines[cursor++]), began);
      if (value) emit({ type: 'phase', case: testCase.name, ...value });
    }
  })().finally(() => { pendingDrain = undefined; });
  const timer = setInterval(() => void drain().catch(() => {}), 500);
  emit({ type: 'caseBegin', case: testCase.name });
  try {
    return await new Promise((resolve) => {
      const environment = { ...process.env, AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS: '1', AW_SUBAGENT_COMMUNICATION_TRACE_FILE: trace,
        TMPDIR: temporary, TMP: temporary, TEMP: temporary };
      const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', `--test-name-pattern=^${testCase.pattern}$`, path.join(plugin, 'scripts', testCase.file)],
        { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      let timedOut = false, outputBytes = 0;
      const watchdog = setTimeout(() => { timedOut = true; child.kill(); }, testCase.file.includes('runtime') ? 420000 : 90000);
      const output = (stream, bytes) => {
        outputBytes += bytes.length;
        if (outputBytes <= 262144) stream.write(bytes);
      };
      child.stdout.on('data', (bytes) => output(process.stdout, bytes)); child.stderr.on('data', (bytes) => output(process.stderr, bytes));
      child.once('error', () => {});
      child.once('close', (exitCode, signal) => {
        clearTimeout(watchdog);
        const result = { type: 'caseEnd', case: testCase.name, exitCode, signal, timedOut, elapsedMs: Date.now() - began,
          outputTruncated: outputBytes > 262144 };
        emit(result); resolve(result);
      });
    });
  } finally {
    clearInterval(timer); await drain(); await drain();
  }
}

async function main() {
  const checkOnly = process.argv.length === 3 && process.argv[2] === '--check-instrumentation';
  if (process.argv.length !== 2 && !checkOnly) throw new Error('Use no arguments, or --check-instrumentation.');
  if (process.platform !== 'win32' && !checkOnly) {
    emit({ type: 'skipped', reason: 'Native Windows is required.', platform: process.platform }); return;
  }
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-windows-communication-diagnostics-'));
  const plugin = path.join(directory, 'plugin'); let retain = false;
  try {
    await fs.mkdir(path.join(plugin, 'scripts/fixtures'), { recursive: true });
    await fs.mkdir(path.join(plugin, 'skills/codex-subagent-guide'), { recursive: true });
    await fs.cp(path.join(source, 'skills/codex-subagent-guide/scripts'), path.join(plugin, 'skills/codex-subagent-guide/scripts'), { recursive: true });
    for (const file of ['subagent-bridge-v5.test.mjs', 'subagent-runtime.test.mjs', 'fixtures/guide-runtime-resources.mjs']) {
      await fs.copyFile(path.join(source, 'scripts', file), path.join(plugin, 'scripts', file));
    }
    await instrument(path.join(plugin, 'skills/codex-subagent-guide/scripts'));
    if (checkOnly) {
      for (const file of ['runtime/adapter-channel.mjs', 'runtime/store.mjs', 'message-mcp.mjs', 'subagent.mjs']) {
        const result = await new Promise((resolve) => {
          const child = spawn(process.execPath, ['--check', path.join(plugin, 'skills/codex-subagent-guide/scripts', file)], { stdio: 'inherit' });
          child.once('error', () => resolve(1)); child.once('close', resolve);
        });
        if (result !== 0) throw new Error('An instrumented module did not parse.');
      }
      emit({ type: 'instrumentationChecked', modules: 4, nativeTestsRun: false }); return;
    }
    const cases = [
      { name: 'receive-allocation', file: 'subagent-bridge-v5.test.mjs', pattern: 'explicit receive and automatic input share allocation without replay' },
      { name: 'mcp-concurrency', file: 'subagent-bridge-v5.test.mjs', pattern: 'generated MCP process supports concurrent receive/send and rejects extra tool identity' },
      ...[1, 2, 3].map((attempt) => ({ name: `late-ready-${attempt}`, file: 'subagent-runtime.test.mjs', pattern: 'late ready capability survives terminal snapshot merging' })),
    ];
    const results = [];
    for (const testCase of cases) { const result = await runCase(plugin, directory, testCase); results.push(result); retain ||= result.timedOut; }
    const failed = results.filter((result) => result.exitCode !== 0 || result.timedOut || result.outputTruncated);
    emit({ type: 'summary', cases: results.length, failed: failed.length, cleanupUncertain: retain });
    if (failed.length) process.exitCode = 1;
  } finally {
    if (!retain) await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  emit({ type: 'failure', reason: error instanceof Error && ['The diagnostic source boundary changed.', 'An instrumented module did not parse.', 'The diagnostic trace exceeded its bound.', 'Use no arguments, or --check-instrumentation.'].includes(error.message)
    ? error.message : 'The fake-only communication diagnostic did not complete.' });
  process.exitCode = 1;
});
