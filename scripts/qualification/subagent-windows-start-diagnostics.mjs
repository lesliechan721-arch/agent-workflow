#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit fake-only qualification. Instrument a temporary copy, never the
// production source. Output contains fixed phase names, timings and statuses.
const prefix = 'AW_SUBAGENT_WINDOWS_START_DIAGNOSTICS';
const emit = (value) => process.stdout.write(`${prefix} ${JSON.stringify(value)}\n`);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const phaseNames = new Set(['start', 'createRun', 'workerIdentity', 'launchSaved', 'observeWindow', 'observe', 'saveObservation', 'user.sid', 'path.reparse', 'acl.set', 'acl.verify', 'process.query', 'native.operation']);
const phases = [];
let emitted = 0;

function replaceOnce(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before)) throw new Error('The diagnostic source boundary changed.');
  return source.replace(before, after);
}

const adapterSource = String.raw`
import { spawn } from 'node:child_process';
import readline from 'node:readline';
let backend, closed, finishing = false;
const emit = (value) => process.stdout.write(JSON.stringify({ protocolVersion: 5, ...value }) + '\n');
const hardStop = setTimeout(() => void finish(false), 90000);
async function finish(cancelled) {
  if (finishing) return;
  finishing = true;
  clearTimeout(hardStop);
  if (backend?.connected) backend.send('finish');
  const backendExitCode = backend ? await closed : null;
  emit({ type: 'closing', reason: cancelled ? 'cancelled' : 'completed' });
  emit({ type: 'result', state: cancelled ? 'cancelled' : 'completed', generationStarted: !!backend,
    backendExitCode, text: '', ...(cancelled ? { code: 'fixtureStopped', remoteStopConfirmed: true } : {}) });
  process.exit(0);
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === 'start') {
    backend = spawn(process.execPath, ['-e', "setTimeout(()=>process.exit(4),85000);process.on('message',()=>process.exit(0));process.on('disconnect',()=>process.exit(0))"],
      { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: false });
    closed = new Promise((resolve) => backend.once('close', resolve));
    emit({ type: 'ready', communicationSupported: true });
  } else if (frame.type === 'stop') await finish(true);
}
if (!finishing) await finish(true);
`;

async function instrument(scripts, trace, began) {
  const helper = [
    "import { appendFileSync as diagnosticAppend } from 'node:fs';",
    `const diagnosticTrace = ${JSON.stringify(trace)};`,
    `const diagnosticBegan = ${began};`,
    "function diagnosticPhase(phase, event, operationMs) { try { diagnosticAppend(diagnosticTrace, JSON.stringify({ phase, event, elapsedMs: Date.now() - diagnosticBegan, ...(operationMs === undefined ? {} : { operationMs: Date.now() - operationMs }), role: process.argv[1]?.endsWith('worker.mjs') ? 'worker' : ['start', 'stop'].includes(process.argv[2]) ? process.argv[2] : 'process' }) + '\\n'); } catch {} }",
  ].join('\n') + '\n';
  const platformFile = path.join(scripts, 'runtime/platform.mjs');
  let platform = await fs.readFile(platformFile, 'utf8');
  platform = replaceOnce(platform, 'export async function windowsOperation(source, input = {}) {', [
    'export async function windowsOperation(source, input = {}) {',
    "  const operationPhase = source.includes('Set-Acl') ? 'acl.set' : source.includes('Get-Acl') ? 'acl.verify' : source.includes('ReparsePoint') ? 'path.reparse' : source.includes('Win32_Process') ? 'process.query' : source.includes('WindowsIdentity') ? 'user.sid' : 'native.operation';",
    "  const operationBegan = Date.now(); diagnosticPhase(operationPhase, 'begin');",
  ].join('\n'));
  platform = replaceOnce(platform, '    return stdout.trim() ? JSON.parse(stdout) : null;', "    diagnosticPhase(operationPhase, 'end', operationBegan);\n    return stdout.trim() ? JSON.parse(stdout) : null;");
  platform = replaceOnce(platform, "    fail('platformOperationFailed', 'A native Windows identity, access-control, or process operation failed.');", "    diagnosticPhase(operationPhase, 'error', operationBegan);\n    fail('platformOperationFailed', 'A native Windows identity, access-control, or process operation failed.');");
  await fs.writeFile(platformFile, helper + platform);
  const commandsFile = path.join(scripts, 'runtime/commands.mjs');
  let commands = await fs.readFile(commandsFile, 'utf8');
  for (const [before, after] of [
    ['export async function startRun(context, prepared, request) {', "export async function startRun(context, prepared, request) {\n  diagnosticPhase('start', 'begin');"],
    ['  const run = await createRun(context, request.name, prepared.request.workspace);', "  diagnosticPhase('createRun', 'begin');\n  const run = await createRun(context, request.name, prepared.request.workspace);\n  diagnosticPhase('createRun', 'end');"],
    ['    const identity = await child.identityReady;', "    diagnosticPhase('workerIdentity', 'begin');\n    const identity = await child.identityReady;\n    diagnosticPhase('workerIdentity', 'end');"],
    ['    child.unref();', "    diagnosticPhase('launchSaved', 'end');\n    child.unref();"],
    ['  const until = Date.now() + 10000;', "  diagnosticPhase('observeWindow', 'begin');\n  const until = Date.now() + 10000;"],
    ['    try { current = await observeRun(context, await openRun(context, run.handle)); }', "    diagnosticPhase('observe', 'begin');\n    try { current = await observeRun(context, await openRun(context, run.handle)); diagnosticPhase('observe', 'end'); }"],
    ['  await saveObservation(current, { terminalConsumed: false });', "  diagnosticPhase('observeWindow', 'end');\n  diagnosticPhase('saveObservation', 'begin');\n  await saveObservation(current, { terminalConsumed: false });\n  diagnosticPhase('saveObservation', 'end');\n  diagnosticPhase('start', 'end');"],
  ]) commands = replaceOnce(commands, before, after);
  await fs.writeFile(commandsFile, helper + commands);
}

async function main() {
  if (process.platform !== 'win32') { emit({ type: 'skipped', reason: 'Native Windows is required.', platform: process.platform }); return; }
  const began = Date.now();
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-windows-start-diagnostics-'));
  const temporary = path.join(directory, 'temporary');
  const installed = path.join(directory, 'installed');
  const scripts = path.join(installed, 'scripts');
  const workspace = path.join(directory, 'workspace');
  const trace = path.join(directory, 'phases.jsonl');
  const handles = new Set();
  let cleaned = false;
  let traceTimer;
  const drain = async () => {
    const contents = await fs.readFile(trace, 'utf8').catch(() => '');
    const lines = contents.split('\n');
    while (emitted < lines.length - 1) {
      try {
        const row = JSON.parse(lines[emitted++]);
        if (!phaseNames.has(row.phase) || !['begin', 'end', 'error'].includes(row.event) || !Number.isSafeInteger(row.elapsedMs) || !['start', 'stop', 'worker', 'process'].includes(row.role)) continue;
        const safe = { phase: row.phase, event: row.event, elapsedMs: row.elapsedMs, role: row.role };
        if (Number.isSafeInteger(row.operationMs)) safe.operationMs = row.operationMs;
        phases.push(safe); emit(safe);
      } catch {}
    }
  };
  try {
    await Promise.all([fs.mkdir(temporary), fs.mkdir(workspace), fs.mkdir(installed)]);
    const source = fileURLToPath(new URL('../../plugins/codex-enhance/skills/codex-subagent-guide/scripts/', import.meta.url));
    await fs.cp(source, scripts, { recursive: true });
    await instrument(scripts, trace, began);
    const adapter = path.join(directory, 'fake-adapter.mjs');
    await fs.writeFile(adapter, adapterSource);
    const configuration = { installedIdentity: { source: 'fixture', plugin: 'fixture', platform: 'codex', scope: 'user' }, resourceRoot: installed,
      effectiveValues: { advisorProfile: { executor: 'fixture' }, subagentCommands: [{ key: 'fixture', title: 'Fixture', adapter: 'custom', mode: 'workspace', command: await fs.realpath(process.execPath), entrypoint: adapter }] } };
    await fs.writeFile(path.join(installed, 'effective.json'), JSON.stringify(configuration));
    await fs.writeFile(path.join(scripts, 'aw-runtime-config.mjs'), "import fs from 'node:fs/promises';export async function readRuntimeConfig(){return JSON.parse(await fs.readFile(new URL('../effective.json',import.meta.url),'utf8'));}\n");
    const environment = { ...Object.fromEntries(Object.entries(process.env).map(([name, value]) => [name.toUpperCase(), value])), HOME: directory, USERPROFILE: directory,
      CODEX_HOME: directory, AW_HOME: directory, AW_CODEX_HOME: directory, AW_CLAUDE_HOME: directory, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    const entry = path.join(scripts, 'subagent.mjs');
    const command = (args) => new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [entry, ...args], { cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'ignore'] });
      const output = []; let bytes = 0, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
      child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes <= 16384) output.push(chunk); });
      child.once('error', () => {});
      child.once('close', (exit, signal) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(output).toString('utf8');
        for (const match of stdout.matchAll(/^run: (aw5-[a-f0-9]{32}-[a-f0-9]{32})$/gm)) handles.add(match[1]);
        const fields = Object.fromEntries(['start', 'stop', 'state', 'communication', 'code'].flatMap((field) => {
          const match = stdout.match(new RegExp(`^${field}: ([a-zA-Z][a-zA-Z0-9]*)$`, 'm')); return match ? [[field, match[1]]] : [];
        }));
        emit({ type: 'command', command: args[0], elapsedMs: Date.now() - started, exit, signal, timedOut, ...fields });
        resolve();
      });
    });
    traceTimer = setInterval(() => { void drain(); }, 300);
    await command(['start', '--profile', 'advisorProfile', '--workspace', workspace, '--prompt', 'Fixed fake-only startup diagnostic.']);
    // Recover only this fresh fixture's capabilities if start timed out before
    // writing its handle. A PID or process name is never used as a kill target.
    const runDirectories = [];
    for (const root of await fs.readdir(temporary)) {
      if (!/^aw-subagent-v5-[a-f0-9]{16}$/.test(root)) continue;
      for (const id of await fs.readdir(path.join(temporary, root))) {
        if (!/^[a-f0-9]{32}$/.test(id)) continue;
        const runDirectory = path.join(temporary, root, id);
        const meta = JSON.parse(await fs.readFile(path.join(runDirectory, 'owner.json'), 'utf8'));
        if (meta.id !== id || !/^[a-f0-9]{32}$/.test(meta.key ?? '')) throw new Error('The fixture owner record is invalid.');
        handles.add(`aw5-${id}-${meta.key}`); runDirectories.push(runDirectory);
      }
    }
    for (const handle of handles) await command(['stop', '--run', handle]);
    const deadline = Date.now() + 120000;
    do {
      const records = await Promise.all(runDirectories.map(async (runDirectory) => JSON.parse(await fs.readFile(path.join(runDirectory, 'owner.json'), 'utf8'))));
      if (records.every((meta) => meta.localTreeStopped === true)) { cleaned = true; break; }
      await pause(1000);
    } while (Date.now() < deadline);
    await drain();
    const operations = [...phaseNames].flatMap((phase) => {
      const completed = phases.filter((row) => row.phase === phase && Number.isSafeInteger(row.operationMs));
      return completed.length ? [{ phase, count: completed.length, totalMs: completed.reduce((total, row) => total + row.operationMs, 0), maximumMs: Math.max(...completed.map((row) => row.operationMs)) }] : [];
    });
    emit({ type: 'summary', elapsedMs: Date.now() - began, phases: phases.length, operations, cleanupConfirmed: cleaned });
    if (!cleaned) throw new Error('The fake runtime stop was not confirmed.');
  } finally {
    clearInterval(traceTimer);
    await drain();
    // Retain resources rather than remove a live or uncertain runtime tree.
    if (cleaned) await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(() => { emit({ type: 'failure', reason: 'The fixed fake-only startup diagnostic did not complete.' }); process.exitCode = 1; });
