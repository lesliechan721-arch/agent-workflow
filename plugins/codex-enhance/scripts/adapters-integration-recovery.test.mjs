import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { protectPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { fixture, scripts, supported, testTimeoutMs } from './fixtures/adapter-v5.mjs';

const moduleTimeoutMs = 30000;
const require = createRequire(import.meta.url);
const moduleEntry = require.resolve('./fixtures/adapter-recovery.mjs');
let moduleResources;
let moduleResourceRoot;
after(async () => { if (moduleResourceRoot) await fs.rm(moduleResourceRoot, { recursive: true, force: true }); });

// Source runs prepare one read-only module view. Every case keeps its own
// writable runtime and environment. Installed tests already have bundled helpers.
function moduleResourcesForFile() {
  moduleResources ??= (async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-recovery-modules-'));
    moduleResourceRoot = root;
    let entry = moduleEntry;
    if (process.env.AW_PLUGIN_EVENT !== 'test') {
      const installed = path.join(root, 'skills/codex-subagent-guide/scripts');
      await fs.cp(scripts, installed, { recursive: true });
      await fs.cp(path.join(scripts, '../assets'), path.join(installed, '../assets'), { recursive: true });
      entry = path.join(root, 'scripts/fixtures/adapter-recovery.mjs');
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.copyFile(moduleEntry, entry);
      for (const relative of ['file-selection/selection.mjs', 'adapters/codex-profile.mjs']) {
        const target = path.join(installed, relative);
        const bundled = await build({ entryPoints: [target], nodePaths: [fileURLToPath(new URL('./node_modules', import.meta.url))], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, legalComments: 'inline', logLevel: 'silent', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
        await fs.writeFile(target, bundled.outputFiles[0].contents);
      }
    }
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    const executable = path.join(bin, `node${process.platform === 'win32' ? '.exe' : ''}`);
    try { await fs.link(process.execPath, executable); }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      await fs.copyFile(process.execPath, executable);
    }
    for (const backend of ['codex', 'claude', 'oracle']) await fs.link(executable, path.join(bin, `${backend}${process.platform === 'win32' ? '.exe' : ''}`));
    return { entry, bin, template: path.join(scripts, '../assets/communication-instructions.md') };
  })();
  return moduleResources;
}

// Test Value Gate: protocol rejection and capability combinations use the real
// common entry and adapters, with JSONL streams and the real in-memory channel.
// The native tests below own install closure, ACLs, file bridges and real exits.
async function moduleFixture(t, backend, scenario = 'success', environment = {}) {
  const { entry, bin, template } = await moduleResourcesForFile();
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-adapter-recovery-'));
  // Negotiation resolves a real executable without package shims or native ACL
  // queries. The controlled backend below replaces only the model process.
  const frames = [], values = [], waiters = new Set();
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env, PATH: bin, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, '.codex'),
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: '', AW_SUBAGENT_PROCESS_TOKEN: randomBytes(24).toString('hex'),
      FIXTURE_BACKEND: backend, FIXTURE_CASE: scenario, FIXTURE_COMMUNICATION_TEMPLATE: template, ...environment,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let closed = false, diagnostic = '';
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { diagnostic += chunk; });
  child.on('message', (value) => values.push(value));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => { frames.push(JSON.parse(line)); for (const check of waiters) check(); });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { closed = true; for (const check of waiters) check(); resolve({ code, diagnostic }); });
  });
  t.after(async () => {
    if (!closed) child.kill('SIGKILL');
    await exit;
    await fs.rm(root, { recursive: true, force: true });
  });
  const waitFor = (type) => new Promise((resolve, reject) => {
    let timer;
    const finish = (error, frame) => { clearTimeout(timer); waiters.delete(check); if (error) reject(error); else resolve(frame); };
    const missing = () => new Error(`Missing ${type}: ${JSON.stringify(frames)} ${diagnostic}`);
    const check = () => {
      const frame = frames.find((value) => value.type === type);
      if (frame) finish(null, frame);
      else if (closed) finish(missing());
    };
    waiters.add(check); timer = setTimeout(() => finish(missing()), moduleTimeoutMs); check();
  });
  const request = {
    protocolVersion: 5, type: 'start', communication: true, resume: true,
    ...(backend !== 'oracle' ? { permissionMode: 'default' } : {}),
    ...(backend === 'codex' ? { codex: { cliSource: 'cli', bypassHookTrust: false } } : {}),
    run: { id: randomBytes(8).toString('base64url'), name: 'recovery-fixture', deadlineAt: null },
    execution: { executor: 'fixture' }, mode: backend === 'oracle' ? 'bundle' : 'workspace',
    workspace: root, prompt: 'Original task.', args: [],
    runtime: { directory: root, toolkit: { command: process.execPath, module: moduleEntry, messageScript: moduleEntry, mcpScript: moduleEntry } },
    ...(backend === 'oracle' ? { fileSelectors: [], fileResolver: { command: process.execPath, args: [moduleEntry] } } : {}),
  };
  return { request, frames, values, waitFor, exit, send: (value) => child.stdin.write(`${JSON.stringify(value)}\n`) };
}

// Test Value Gate: run the installed adapter across two real local processes.
// Replace only the model backend, and inspect the actual session target, new
// input, private tool binding and capability events at its public JSONL edge.
for (const backend of ['codex', 'claude']) test(`${backend}: resume preserves the session and uses only the new message and bridge`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend);
  const first = f.start(); first.send(f.request);
  const session = await first.waitFor('session');
  assert.equal((await first.waitFor('ready')).initialization.capabilities.resume.status, 'enabled');
  assert.equal((await first.waitFor('result')).state, 'completed');
  assert.equal((await first.exit).code, 0);
  const before = await f.captured();
  const directory = path.join(path.dirname(f.request.runtime.directory), 'resumed-adapter');
  await fs.mkdir(directory, { mode: 0o700 });
  await protectPrivatePath(directory, 'directory');
  const request = { ...f.request, sessionId: session.sessionId, prompt: 'Only the follow-up message.', runtime: { ...f.request.runtime, directory } };
  const second = f.start(); second.send(request);
  assert.equal((await second.waitFor('session')).sessionId, session.sessionId);
  const result = await second.waitFor('result');
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(result.sessionId, session.sessionId);
  assert.equal((await second.exit).code, 0);
  const values = (await f.captured()).slice(before.length);
  if (backend === 'codex') {
    assert.equal(values.some((value) => value.input?.method === 'thread/start'), false);
    const resumed = values.find((value) => value.input?.method === 'thread/resume').input.params;
    assert.equal(resumed.threadId, session.sessionId);
    const oldConfig = before.find((value) => value.input?.method === 'thread/start').input.params.config;
    const key = `aw_parent_${request.run.id}`;
    assert.notDeepEqual(resumed.config.mcp_servers[key].args, oldConfig.mcp_servers[key].args);
    assert.equal(resumed.config.mcp_servers[key].tools.receive_parent.output_token_limit, 32768);
    assert.ok(resumed.config.mcp_servers[key].args.some((argument) => argument.startsWith(directory)));
    const inputs = values.filter((value) => value.input?.method === 'turn/start');
    assert.equal(inputs.length, 1);
    assert.ok(inputs[0].input.params.input[0].text.startsWith(request.prompt));
    assert.equal(inputs[0].input.params.input[0].text.includes(f.request.prompt), false);
  } else {
    const args = values[0].args;
    assert.equal(args[args.indexOf('--resume') + 1], session.sessionId);
    assert.equal(args.includes('--fork-session'), false);
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
    assert.ok(mcp.mcpServers[`aw_parent_${request.run.id}`].args.some((argument) => argument.startsWith(directory)));
    const inputs = values.filter((value) => value.input?.type === 'user');
    assert.equal(inputs.length, 1);
    assert.ok(inputs[0].input.message.content[0].text.startsWith(request.prompt));
    assert.equal(inputs[0].input.message.content[0].text.includes(f.request.prompt), false);
  }
});

for (const scenario of ['resume rejection', 'resume mismatch', 'resume active']) test(`Codex: ${scenario} never falls back to a new thread or submits input`, { timeout: moduleTimeoutMs }, async (t) => {
  const run = await moduleFixture(t, 'codex', scenario);
  run.send({ ...run.request, sessionId: 'thread-fixture' });
  const result = await run.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  assert.equal(result.code, scenario === 'resume rejection' ? 'backendRequestRejected' : scenario === 'resume mismatch' ? 'backendSessionMismatch' : 'backendInputUnavailable');
  assert.equal((await run.exit).code, 0);
  const values = run.values;
  assert.equal(values.filter((value) => value.input?.method === 'thread/resume').length, 1);
  assert.equal(values.some((value) => ['thread/start', 'thread/fork', 'turn/start'].includes(value.input?.method)), false);
  assert.equal(run.frames.some((frame) => ['ready', 'session'].includes(frame.type)), false);
});

for (const [backend, args] of [['codex', ['--ephemeral']], ['claude', ['--no-session-persistence']], ['oracle', []]]) test(`${backend}: nonpersistent or one-shot execution reports unsupported without a session event`, { timeout: moduleTimeoutMs }, async (t) => {
  const run = await moduleFixture(t, backend);
  run.send({ ...run.request, args });
  assert.deepEqual((await run.waitFor('ready')).initialization.capabilities.resume, { status: 'unsupported' });
  assert.equal((await run.waitFor('result')).state, 'completed'); assert.equal((await run.exit).code, 0);
  assert.equal(run.frames.some((frame) => frame.type === 'session'), false);
});

for (const backend of ['codex', 'claude']) test(`${backend}: disabled resume keeps communication available and publishes no binding`, { timeout: moduleTimeoutMs }, async (t) => {
  const run = await moduleFixture(t, backend);
  run.send({ ...run.request, resume: false });
  const ready = await run.waitFor('ready');
  assert.equal(ready.initialization.capabilities.communication.status, 'enabled');
  assert.equal(ready.initialization.capabilities.resume.status, 'disabled');
  assert.equal((await run.waitFor('result')).state, 'completed'); assert.equal((await run.exit).code, 0);
  assert.equal(run.frames.some((frame) => frame.type === 'session'), false);
});

test('Claude: disabled persistence through the backend environment prevents resume before input', { timeout: moduleTimeoutMs }, async (t) => {
  const run = await moduleFixture(t, 'claude', 'success', { CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' });
  run.send({ ...run.request, sessionId: 'session-fixture' });
  const result = await run.waitFor('result');
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'resumeUnsupported'); assert.equal(result.generationStarted, false); assert.equal((await run.exit).code, 0);
  assert.equal(run.frames.some((frame) => ['ready', 'session'].includes(frame.type)), false);
  assert.deepEqual(run.values, []);
});
