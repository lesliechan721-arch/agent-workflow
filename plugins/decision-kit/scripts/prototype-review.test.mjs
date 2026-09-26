import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as sourceReviewPolicy from '../skills/decision-prototype/assets/review-shell/review-policy.mjs';
import * as sourceReviewContract from '../skills/decision-prototype/scripts/review-contract.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localPluginRoot = path.resolve(scriptDir, '..');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function resolveContext() {
  if (!process.env.AW_PLUGIN_CONTEXT) {
    return { sourceRoot: localPluginRoot, bundleRoot: localPluginRoot, platform: null };
  }
  const context = await readJson(process.env.AW_PLUGIN_CONTEXT);
  assert.equal(context.event, 'test');
  assert.equal(context.plugin.name, 'decision-kit');
  assert.ok(['codex', 'claude'].includes(context.platform));
  return {
    sourceRoot: context.sourceRoot,
    bundleRoot: context.plugin.rootDir,
    platform: context.platform,
  };
}

function prototypeConfig(id, overrides = {}) {
  return {
    schemaVersion: 2,
    id,
    revision: 1,
    question: 'Which option should we use?',
    decisionContext: {
      goal: 'Choose the clearest approval layout.',
      priorities: ['Clarity'],
      constraints: ['Keep approval history visible'],
    },
    stopCondition: 'The reviewer accepts one direction.',
    options: [
      { id: 'a', label: 'Option A', kind: 'html', artifact: 'artifact/a.html' },
      { id: 'b', label: 'Option B', kind: 'html', artifact: 'artifact/b.html' },
    ],
    ...overrides,
  };
}

function feedbackFor(config, overrides = {}) {
  return {
    schemaVersion: 2,
    reviewShellVersion: 2,
    prototypeId: config.id,
    prototypeRevision: config.revision,
    verdict: 'accepted',
    selectedOptions: config.selectionMode === 'none' ? [] : [config.options[0].id],
    answers: [],
    annotations: [],
    cssVariableValues: Object.fromEntries(
      Object.entries(config.editableCssVariables || {}).map(([name, values]) => [name, values[0]]),
    ),
    globalNotes: '',
    ...overrides,
  };
}

function parseReceipt(stdout) {
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected one stdout JSON receipt, received: ${stdout}`);
  return JSON.parse(lines[0]);
}

const context = await resolveContext();
const skillsRoot = context.platform
  ? path.join(context.bundleRoot, context.platform, 'skills')
  : path.join(context.sourceRoot, 'skills');
const skillRoot = path.join(skillsRoot, 'decision-prototype');
const runtimeScript = path.join(skillRoot, 'scripts', 'prototype-review.mjs');
const serverScript = path.join(skillRoot, 'scripts', 'review-server.mjs');
const testRoot = await mkdtemp(path.join(os.tmpdir(), 'decision-kit-prototype-review-v2-'));
const runtimeTmp = path.join(testRoot, 'tmp');
await mkdir(runtimeTmp);
const runtimeEnv = { ...process.env, TMPDIR: runtimeTmp };
const activeSessions = new Set();
const ownedServers = new Set();

async function runRuntime(args, env = runtimeEnv) {
  return execFileAsync(process.execPath, [runtimeScript, ...args], {
    env,
    timeout: 10_000,
  });
}

async function runRuntimeFailure(args, expectedCode = 1, env = runtimeEnv) {
  try {
    await runRuntime(args, env);
  } catch (error) {
    assert.equal(error.code, expectedCode);
    return error;
  }
  assert.fail(`Expected prototype-review ${args.join(' ')} to fail`);
}

async function writePrototype(root, config, files = {}) {
  await mkdir(path.join(root, 'artifact'), { recursive: true });
  for (const option of config.options || []) {
    const target = path.resolve(root, option.artifact);
    if (!target.startsWith(`${path.join(root, 'artifact')}${path.sep}`)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await access(target);
    } catch {
      await writeFile(
        target,
        files[option.artifact]
          || (option.kind === 'html'
            ? `<!doctype html><h1 data-prototype-id="heading">${option.label}</h1>\n`
            : 'fixture\n'),
      );
    }
  }
  await writeFile(path.join(root, 'brief.md'), '# Prototype brief\n');
  await writeFile(path.join(root, 'prototype.json'), `${JSON.stringify(config, null, 2)}\n`);
  return path.join(root, 'prototype.json');
}

async function startPrototype(root, config, files, env = runtimeEnv) {
  const prototypePath = await writePrototype(root, config, files);
  const result = await runRuntime(['start', '--prototype', prototypePath, '--ttl', '5s'], env);
  const started = parseReceipt(result.stdout);
  assert.equal(started.ok, true);
  assert.equal(started.status, 'ready');
  activeSessions.add(started.session);
  return started;
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`Timed out while waiting for ${filePath}`);
}

async function waitForChildExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned Review server did not exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startOwnedServer(root, config, ttlMs) {
  const prototypePath = await writePrototype(root, config);
  return startOwnedServerFromPrototype(prototypePath, ttlMs);
}

async function startOwnedServerFromPrototype(prototypePath, ttlMs, startupTimeoutMs = 2_000) {
  const sessionId = randomBytes(16).toString('hex');
  const sessionDir = path.join(runtimeTmp, 'agent-workflow', 'prototype-review', sessionId);
  const launchPath = path.join(sessionDir, 'launch.json');
  const sessionPath = path.join(sessionDir, 'session.json');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(launchPath, JSON.stringify({
    schemaVersion: 2,
    reviewShellVersion: 2,
    sessionId,
    token: randomBytes(32).toString('base64url'),
    prototypePath,
    ttlMs,
  }));
  const child = spawn(process.execPath, [serverScript, '--launch', launchPath], {
    env: runtimeEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  ownedServers.add(child);
  child.once('exit', () => ownedServers.delete(child));
  await Promise.race([
    waitForFile(sessionPath, startupTimeoutMs),
    new Promise((_, reject) => child.once('exit', (code) => reject(new Error(
      `Owned Review server exited during startup with ${code}: ${stderr}`,
    )))),
  ]);
  const descriptor = await readJson(sessionPath);
  return {
    child,
    session: sessionPath,
    url: descriptor.url,
    prototypeId: descriptor.prototypeId,
    revision: descriptor.revision,
  };
}

async function unusedLocalPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function writeUnreachableSession(root, config, { schemaVersion = 2 } = {}) {
  const prototypePath = await realpath(await writePrototype(root, config));
  const prototypeRoot = await realpath(root);
  const sessionId = randomBytes(16).toString('hex');
  const sessionDir = path.join(runtimeTmp, 'agent-workflow', 'prototype-review', sessionId);
  const session = path.join(sessionDir, 'session.json');
  const token = randomBytes(32).toString('base64url');
  const port = await unusedLocalPort();
  const now = Date.now();
  await mkdir(sessionDir, { recursive: true });
  await writeFile(session, JSON.stringify({
    schemaVersion,
    reviewShellVersion: 2,
    sessionId,
    token,
    pid: 999_999,
    url: `http://127.0.0.1:${port}/review/index.html#token=${token}`,
    prototypePath,
    prototypeRoot,
    prototypeId: config.id,
    revision: config.revision,
    createdAt: new Date(now).toISOString(),
    ...(schemaVersion === 2 ? { expiresAt: new Date(now + 5_000).toISOString() } : {}),
  }));
  return session;
}

async function writeTerminalOnly(prototypePath, config, status = 'submitted') {
  const physicalPrototypePath = await realpath(prototypePath);
  const prototypeRoot = await realpath(path.dirname(physicalPrototypePath));
  const sessionId = randomBytes(16).toString('hex');
  const sessionDir = path.join(runtimeTmp, 'agent-workflow', 'prototype-review', sessionId);
  const session = path.join(sessionDir, 'session.json');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'terminal.json'), JSON.stringify({
    schemaVersion: 1,
    sessionId,
    prototypePath: physicalPrototypePath,
    prototypeRoot,
    prototypeId: config.id,
    revision: config.revision,
    status,
    resourcesClosed: true,
    endedAt: new Date().toISOString(),
  }));
  return session;
}

async function sessionDetails(started) {
  return readJson(started.session);
}

async function apiRequest(started, pathname, options = {}) {
  const descriptor = await sessionDetails(started);
  return fetch(new URL(pathname, started.url), {
    ...options,
    headers: {
      origin: new URL(started.url).origin,
      'x-prototype-review-token': descriptor.token,
      ...options.headers,
    },
  });
}

async function fakeSystemOpener(name, delayMs = 0, exitCode = 0) {
  if (!['darwin', 'linux'].includes(process.platform)) return null;
  if (process.platform === 'linux') {
    for (const marker of ['/.dockerenv', '/run/.containerenv']) {
      try {
        await access(marker);
        return null;
      } catch {
        // A missing container marker keeps the natural desktop qualification available.
      }
    }
  }
  const bin = path.join(testRoot, `fake-opener-${name}`);
  const countPath = path.join(bin, 'requests.txt');
  const executable = path.join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open');
  await mkdir(bin, { recursive: true });
  await writeFile(executable, `#!${process.execPath}\n`
    + "const { appendFileSync } = require('node:fs');\n"
    + "const delay = Number(process.env.FAKE_OPEN_DELAY_MS || '0');\n"
    + "const exitCode = Number(process.env.FAKE_OPEN_EXIT_CODE || '0');\n"
    + "setTimeout(() => { appendFileSync(process.env.FAKE_OPEN_COUNT, 'request\\n'); process.exit(exitCode); }, delay);\n");
  await chmod(executable, 0o700);
  return {
    countPath,
    env: {
      ...runtimeEnv,
      PATH: bin,
      CI: '',
      SSH_CLIENT: '',
      SSH_CONNECTION: '',
      SSH_TTY: '',
      WSL_DISTRO_NAME: '',
      WSL_INTEROP: '',
      container: '',
      DISPLAY: process.platform === 'linux' ? ':99' : runtimeEnv.DISPLAY,
      FAKE_OPEN_COUNT: countPath,
      FAKE_OPEN_DELAY_MS: String(delayMs),
      FAKE_OPEN_EXIT_CODE: String(exitCode),
    },
  };
}

async function openRequestCount(countPath) {
  try {
    return (await readFile(countPath, 'utf8')).trim().split('\n').filter(Boolean).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function waitForOpenRequest(countPath, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await openRequestCount(countPath) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out while waiting for ${expected} fake browser open requests`);
}

async function postFeedback(started, value) {
  return apiRequest(started, '/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

function openChunkedFeedback(started, descriptor) {
  const target = new URL('/api/feedback', started.url);
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({
      hostname: target.hostname,
      port: Number(target.port),
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: target.origin,
        'x-prototype-review-token': descriptor.token,
      },
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
  });
  return { request, response };
}

async function stopIfActive(session) {
  if (!activeSessions.has(session)) return;
  try {
    await runRuntime(['stop', '--session', session]);
  } catch {
    // Some tests intentionally invalidate or stop the server first.
  }
  activeSessions.delete(session);
}

test.after(async () => {
  for (const session of activeSessions) await stopIfActive(session);
  for (const child of ownedServers) child.kill('SIGTERM');
  await Promise.all([...ownedServers].map((child) => waitForChildExit(child).catch(() => {})));
  await rm(testRoot, { recursive: true, force: true });
});

test('Prototype Review scripts expose the bounded command contract', async () => {
  await Promise.all([access(runtimeScript), access(serverScript)]);
  const general = await runRuntime(['--help']);
  assert.match(general.stdout, /start --prototype/);
  assert.match(general.stdout, /--ttl 30m/);
  assert.match(general.stdout, /--new-session/);
  assert.match(general.stdout, /--timeout 5m/);
  for (const command of ['start', 'open', 'wait', 'status', 'stop']) {
    const result = await runRuntime([command, '--help']);
    assert.match(result.stdout, new RegExp(`prototype-review\\.mjs ${command}`));
    assert.equal(result.stderr, '');
  }
  const usage = await runRuntimeFailure(['start'], 2);
  assert.deepEqual(parseReceipt(usage.stdout), {
    ok: false,
    status: 'usage',
    error: 'start requires --prototype',
  });
});

test('Prototype and feedback validation enforce progressive verdict rules', async () => {
  const contract = sourceReviewContract;
  const policy = sourceReviewPolicy;
  const replacedUrls = [];
  assert.equal(policy.consumeSessionToken(
    { hash: '#token=session-token', pathname: '/review/index.html', search: '?mode=review' },
    { replaceState: (...values) => replacedUrls.push(values) },
  ), 'session-token');
  assert.deepEqual(replacedUrls, [[null, '', '/review/index.html?mode=review']]);
  assert.throws(
    () => policy.consumeSessionToken(
      { hash: '', pathname: '/review/index.html', search: '' },
      { replaceState: () => assert.fail('missing tokens must not change history') },
    ),
    /session token is missing/,
  );

  const prototypeSchema = await contract.readJsonSchema(path.join(skillRoot, 'assets', 'prototype.schema.json'));
  const feedbackSchema = await contract.readJsonSchema(path.join(skillRoot, 'assets', 'feedback.schema.json'));
  const single = contract.normalizeAndValidate(prototypeConfig('single'), prototypeSchema, 'prototype');
  assert.equal(single.selectionMode, 'single');
  assert.equal(single.htmlExecution, 'static');
  const accepted = contract.normalizeAndValidate(feedbackFor(single), feedbackSchema, 'feedback');
  assert.doesNotThrow(() => contract.validateFeedbackAgainstPrototype(accepted, single));
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({ ...accepted, selectedOptions: [] }, single),
    /exactly one option/,
  );

  const revise = { ...accepted, verdict: 'revise', globalNotes: 'Move the summary.' };
  assert.doesNotThrow(() => contract.validateFeedbackAgainstPrototype(revise, single));
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({ ...revise, selectedOptions: [] }, single),
    /exactly one option/,
  );
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({ ...revise, globalNotes: '' }, single),
    /revise verdict requires/,
  );

  const rejected = { ...accepted, verdict: 'rejected', selectedOptions: [], reason: 'Neither works.' };
  assert.doesNotThrow(() => contract.validateFeedbackAgainstPrototype(rejected, single));
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({ ...rejected, selectedOptions: ['a'] }, single),
    /must be empty/,
  );
  const newQuestion = {
    ...accepted,
    verdict: 'new-material-question',
    selectedOptions: [],
    materialQuestion: 'Who approves the request?',
  };
  assert.doesNotThrow(() => contract.validateFeedbackAgainstPrototype(newQuestion, single));
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({ ...newQuestion, selectedOptions: ['a'] }, single),
    /must be empty/,
  );

  assert.equal(policy.iframeSandbox({ htmlExecution: 'static' }), 'allow-same-origin');
  assert.equal(policy.iframeSandbox({ htmlExecution: 'sandboxed' }), 'allow-scripts');
  assert.deepEqual(policy.markedAnnotationTarget('a', 'heading', 'text'), {
    kind: 'text',
    value: { optionId: 'a', elementId: 'heading' },
  });
});

test('start, authenticated HTTP, submission, status, and wait form one real session', async () => {
  const root = path.join(testRoot, 'lifecycle');
  const config = prototypeConfig('lifecycle', {
    allowAnnotations: true,
    editableCssVariables: { '--space': ['8px', '16px'] },
  });
  const started = await startPrototype(root, config);
  const descriptor = await sessionDetails(started);
  assert.equal(new URL(started.url).hostname, '127.0.0.1');
  assert.equal(new URLSearchParams(new URL(started.url).hash.slice(1)).get('token'), descriptor.token);

  const configResponse = await fetch(new URL('/review/config.json', started.url));
  assert.equal(configResponse.status, 200);
  assert.equal((await configResponse.json()).id, config.id);
  assert.equal((await fetch(new URL('/artifact/a.html', started.url))).status, 200);
  assert.equal((await fetch(new URL('/artifact/%2e%2e/prototype.json', started.url))).status, 404);
  assert.equal((await fetch(new URL('/api/status', started.url), {
    headers: { origin: new URL(started.url).origin },
  })).status, 403);

  const feedback = feedbackFor(config, {
    cssVariableValues: { '--space': '8px' },
    globalNotes: 'Keep the summary visible.',
    annotations: [{
      id: 'summary-note',
      target: { kind: 'text', value: { optionId: 'a', elementId: 'heading' } },
      category: { kind: 'content' },
      comment: 'This heading is clear.',
    }],
  });
  const first = await postFeedback(started, feedback);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).accepted, true);
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), feedback);
  await waitForFile(path.join(path.dirname(started.session), 'terminal.json'));

  const status = parseReceipt((await runRuntime(['status', '--session', started.session])).stdout);
  assert.equal(status.status, 'submitted');
  assert.equal(status.verdict, 'accepted');
  assert.equal('feedbackDigest' in status, false);
  const waited = parseReceipt((await runRuntime(['wait', '--session', started.session, '--timeout', '2s'])).stdout);
  activeSessions.delete(started.session);
  assert.equal(waited.status, 'submitted');
  assert.equal(waited.feedback, await realpath(path.join(root, 'feedback.json')));
  assert.deepEqual(waited.feedbackData, feedback);
  assert.deepEqual(status.feedbackData, feedback);
  assert.equal('feedbackDigest' in waited, false);
  assert.equal(parseReceipt((await runRuntime(['status', '--session', started.session])).stdout).status, 'submitted');
});

test('authenticated page connection and explicit extension expose current bounded time state', async () => {
  const root = path.join(testRoot, 'page-lifecycle');
  const started = await startOwnedServer(root, prototypeConfig('page-lifecycle'), 5_000);
  const descriptor = await sessionDetails(started);
  const descriptorInfo = await lstat(started.session);
  const initialResponse = await apiRequest(started, '/api/status');
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  assert.equal(initial.status, 'ready');
  assert.equal(initial.presentation.pageConnected, false);
  assert.equal(initial.presentation.openRequested, false);
  assert.equal(initial.presentation.openInProgress, false);
  assert.equal(initial.presentation.openStatus, null);
  assert.equal(initial.createdAt, descriptor.createdAt);
  assert.equal(initial.expiresAt, descriptor.expiresAt);
  assert.equal(Date.parse(initial.maxExpiresAt) - Date.parse(initial.createdAt), 4 * 60 * 60 * 1000);

  await apiRequest(started, '/api/wait?timeoutMs=1');
  const connectedResponse = await apiRequest(started, '/api/page-connected', { method: 'POST' });
  assert.equal(connectedResponse.status, 200);
  const connected = await connectedResponse.json();
  assert.equal(connected.status, 'ready');
  assert.equal(connected.presentation.pageConnected, true);
  assert.equal(connected.expiresAt, initial.expiresAt);

  let extended = connected;
  for (let index = 0; index < 8; index += 1) {
    const response = await apiRequest(started, '/api/extend', { method: 'POST' });
    assert.equal(response.status, 200);
    extended = await response.json();
    if (index === 0) {
      assert.equal(Date.parse(extended.expiresAt) - Date.parse(initial.expiresAt), 30 * 60 * 1000);
    }
  }
  assert.equal(extended.status, 'ready');
  assert.equal(extended.expiresAt, extended.maxExpiresAt);
  assert.equal(extended.presentation.pageConnected, true);
  const currentDescriptor = await sessionDetails(started);
  const currentDescriptorInfo = await lstat(started.session);
  assert.equal(currentDescriptor.expiresAt, descriptor.expiresAt);
  assert.equal(currentDescriptorInfo.dev, descriptorInfo.dev);
  assert.equal(currentDescriptorInfo.ino, descriptorInfo.ino);

  const cliStatus = parseReceipt((await runRuntime(['status', '--session', started.session])).stdout);
  assert.equal(cliStatus.createdAt, initial.createdAt);
  assert.equal(cliStatus.expiresAt, extended.expiresAt);
  assert.equal(cliStatus.maxExpiresAt, extended.maxExpiresAt);
  assert.equal(cliStatus.presentation.pageConnected, true);
  await apiRequest(started, '/api/stop', { method: 'POST' });
  await waitForChildExit(started.child);
});

test('new control APIs require the bound origin and token', async () => {
  const started = await startOwnedServer(
    path.join(testRoot, 'control-auth'),
    prototypeConfig('control-auth'),
    5_000,
  );
  const descriptor = await sessionDetails(started);
  const browserStatus = await fetch(new URL('/api/status', started.url), {
    headers: {
      referer: new URL('/review/index.html', started.url).href,
      'sec-fetch-site': 'same-origin',
      'x-prototype-review-token': descriptor.token,
    },
  });
  assert.equal(browserStatus.status, 200);
  const incompleteBrowserStatus = await fetch(new URL('/api/status', started.url), {
    headers: {
      'sec-fetch-site': 'same-origin',
      'x-prototype-review-token': descriptor.token,
    },
  });
  assert.equal(incompleteBrowserStatus.status, 403);
  for (const pathname of [
    '/api/page-connected',
    '/api/extend',
    '/api/cancel',
    '/api/open-reserve',
    '/api/open-complete',
  ]) {
    const response = await fetch(new URL(pathname, started.url), {
      method: 'POST',
      headers: {
        origin: new URL(started.url).origin,
        'x-prototype-review-token': `${descriptor.token}-wrong`,
        'content-type': 'application/json',
      },
      body: pathname.includes('open-') ? '{}' : undefined,
    });
    assert.equal(response.status, 403, pathname);
  }
  const wrongOrigin = await fetch(new URL('/api/page-connected', started.url), {
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:1',
      'x-prototype-review-token': descriptor.token,
    },
  });
  assert.equal(wrongOrigin.status, 403);
  await apiRequest(started, '/api/stop', { method: 'POST' });
  await waitForChildExit(started.child);
});

test('the server coordinates one browser request and permits retry only after completion', async () => {
  const started = await startOwnedServer(
    path.join(testRoot, 'open-coordination'),
    prototypeConfig('open-coordination'),
    5_000,
  );
  const reserve = (retry) => apiRequest(started, '/api/open-reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ retry }),
  });
  const complete = (reservation, status) => apiRequest(started, '/api/open-complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reservation, status, method: 'system-browser' }),
  });

  const first = await (await reserve(false)).json();
  assert.equal(first.status, 'reserved');
  assert.equal(first.presentation.openInProgress, true);
  assert.equal((await (await reserve(false)).json()).status, 'opening');
  assert.equal((await (await complete(first.reservation, 'requested')).json()).status, 'open-requested');
  assert.equal((await (await reserve(false)).json()).status, 'open-requested');

  const retry = await (await reserve(true)).json();
  assert.equal(retry.status, 'reserved');
  assert.notEqual(retry.reservation, first.reservation);
  assert.equal((await (await reserve(true)).json()).status, 'opening');
  assert.equal((await (await complete(retry.reservation, 'unavailable')).json()).status, 'unavailable');
  assert.equal((await (await reserve(false)).json()).status, 'unavailable');
  for (const status of ['failed', 'unavailable']) {
    const opening = await (await reserve(true)).json();
    assert.equal(opening.status, 'reserved');
    await apiRequest(started, '/api/page-connected', { method: 'POST' });
    const connected = await (await complete(opening.reservation, status)).json();
    assert.equal(connected.status, 'connected');
    assert.equal(connected.presentation.pageConnected, true);
    assert.equal(connected.presentation.openStatus, status);
    assert.equal(parseReceipt((await runRuntime([
      'open', '--session', started.session, '--timeout', '0ms',
    ])).stdout).status, 'connected');
  }
  await apiRequest(started, '/api/stop', { method: 'POST' });
  await waitForChildExit(started.child);
});

test('cancel closes the session without feedback and preserves canonical submission precedence', async () => {
  const cancelledRoot = path.join(testRoot, 'page-cancelled');
  const cancelled = await startOwnedServer(
    cancelledRoot,
    prototypeConfig('page-cancelled'),
    5_000,
  );
  const cancelResponse = await apiRequest(cancelled, '/api/cancel', { method: 'POST' });
  assert.equal(cancelResponse.status, 200);
  const cancelledState = await cancelResponse.json();
  assert.equal(cancelledState.status, 'cancelled');
  assert.equal(typeof cancelledState.createdAt, 'string');
  assert.equal(typeof cancelledState.maxExpiresAt, 'string');
  await waitForChildExit(cancelled.child);
  await assert.rejects(access(path.join(cancelledRoot, 'feedback.json')), /ENOENT/);
  assert.equal((await readJson(path.join(path.dirname(cancelled.session), 'terminal.json'))).status, 'cancelled');

  const submittedRoot = path.join(testRoot, 'page-cancel-submitted');
  const config = prototypeConfig('page-cancel-submitted');
  const prototypePath = await writePrototype(submittedRoot, config);
  const [writer, canceller] = await Promise.all([
    startOwnedServerFromPrototype(prototypePath, 5_000),
    startOwnedServerFromPrototype(prototypePath, 5_000),
  ]);
  assert.equal((await postFeedback(writer, feedbackFor(config))).status, 200);
  const submittedResponse = await apiRequest(canceller, '/api/cancel', { method: 'POST' });
  assert.equal(submittedResponse.status, 200);
  assert.equal((await submittedResponse.json()).status, 'submitted');
  await Promise.all([waitForChildExit(writer.child), waitForChildExit(canceller.child)]);
  assert.equal((await readJson(path.join(path.dirname(canceller.session), 'terminal.json'))).status, 'submitted');
});

test('open reports a request without claiming connection, does not repeat, and retries explicitly', async (t) => {
  const fake = await fakeSystemOpener('open-retry');
  if (!fake) {
    t.skip('The host cannot qualify a fake executable as a natural desktop opener');
    return;
  }
  const root = path.join(testRoot, 'open-retry');
  const config = prototypeConfig('open-retry');
  const started = await startPrototype(root, config);
  const before = await (await apiRequest(started, '/api/status')).json();

  const opened = parseReceipt((await runRuntime([
    'open', '--session', started.session, '--timeout', '50ms',
  ], fake.env)).stdout);
  assert.equal(opened.status, 'open-requested');
  assert.deepEqual(opened.presentation, { pageConnected: false, method: 'system-browser' });
  assert.equal(await openRequestCount(fake.countPath), 1);

  const repeated = parseReceipt((await runRuntime([
    'open', '--session', started.session, '--timeout', '0ms',
  ], fake.env)).stdout);
  assert.equal(repeated.status, 'open-requested');
  assert.equal(await openRequestCount(fake.countPath), 1);

  const retried = parseReceipt((await runRuntime([
    'open', '--session', started.session, '--timeout', '0ms', '--retry',
  ], fake.env)).stdout);
  assert.equal(retried.status, 'open-requested');
  assert.equal(await openRequestCount(fake.countPath), 2);
  const after = await (await apiRequest(started, '/api/status')).json();
  assert.equal(after.expiresAt, before.expiresAt);
  assert.equal(after.presentation.openRequested, true);
  assert.equal(after.presentation.pageConnected, false);

  assert.equal((await postFeedback(started, feedbackFor(config))).status, 200);
  const submitted = parseReceipt((await runRuntime([
    'open', '--session', started.session, '--timeout', '0ms', '--retry',
  ], fake.env)).stdout);
  assert.equal(submitted.status, 'submitted');
  assert.equal(await openRequestCount(fake.countPath), 2);
  activeSessions.delete(started.session);
});

test('a repeated open waits for a later page connection without another browser request', async (t) => {
  const fake = await fakeSystemOpener('open-repeated-wait');
  if (!fake) {
    t.skip('The host cannot qualify a fake executable as a natural desktop opener');
    return;
  }
  const started = await startPrototype(
    path.join(testRoot, 'open-repeated-wait'),
    prototypeConfig('open-repeated-wait'),
  );
  const first = parseReceipt((await runRuntime([
    'open', '--session', started.session, '--timeout', '0ms',
  ], fake.env)).stdout);
  assert.equal(first.status, 'open-requested');
  assert.equal(await openRequestCount(fake.countPath), 1);

  const repeated = runRuntime([
    'open', '--session', started.session, '--timeout', '1s',
  ], fake.env);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await apiRequest(started, '/api/page-connected', { method: 'POST' })).status, 200);
  const connected = parseReceipt((await repeated).stdout);
  assert.equal(connected.status, 'connected');
  assert.equal(connected.presentation.pageConnected, true);
  assert.equal(await openRequestCount(fake.countPath), 1);
  await stopIfActive(started.session);
});

test('concurrent open commands share one request, observe connection, and allow a later retry', async (t) => {
  const fake = await fakeSystemOpener('open-concurrent', 100);
  if (!fake) {
    t.skip('The host cannot qualify a fake executable as a natural desktop opener');
    return;
  }
  const started = await startPrototype(
    path.join(testRoot, 'open-concurrent'),
    prototypeConfig('open-concurrent'),
  );
  const commands = [
    runRuntime(['open', '--session', started.session, '--timeout', '1s'], fake.env),
    runRuntime(['open', '--session', started.session, '--timeout', '1s'], fake.env),
  ];
  await waitForOpenRequest(fake.countPath, 1);
  const connectedResponse = await apiRequest(started, '/api/page-connected', { method: 'POST' });
  assert.equal(connectedResponse.status, 200);
  const receipts = (await Promise.all(commands)).map((result) => parseReceipt(result.stdout));
  assert.deepEqual(receipts.map((value) => value.status), ['connected', 'connected']);
  assert.equal(await openRequestCount(fake.countPath), 1);

  const repeated = parseReceipt((await runRuntime([
    'open', '--session', started.session, '--timeout', '0ms',
  ], fake.env)).stdout);
  assert.equal(repeated.status, 'connected');
  assert.equal(await openRequestCount(fake.countPath), 1);

  const retried = parseReceipt((await runRuntime([
    'open', '--session', started.session, '--timeout', '0ms', '--retry',
  ], fake.env)).stdout);
  assert.equal(retried.status, 'connected');
  assert.equal(await openRequestCount(fake.countPath), 2);
  await stopIfActive(started.session);
});

test('a concurrent open stays pending until the shared opener result is known', async (t) => {
  const fake = await fakeSystemOpener('open-pending-failure', 250, 1);
  if (!fake) {
    t.skip('The host cannot qualify a fake executable as a natural desktop opener');
    return;
  }
  const started = await startPrototype(
    path.join(testRoot, 'open-pending-failure'),
    prototypeConfig('open-pending-failure'),
  );
  const owner = runRuntimeFailure([
    'open', '--session', started.session, '--timeout', '1s',
  ], 1, fake.env);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const shared = parseReceipt((await runRuntime([
    'open', '--session', started.session, '--timeout', '50ms',
  ], fake.env)).stdout);
  assert.equal(shared.status, 'opening');
  assert.equal(shared.presentation.pageConnected, false);

  const ownerFailure = await owner;
  assert.equal(parseReceipt(ownerFailure.stdout).status, 'failed');
  assert.equal(await openRequestCount(fake.countPath), 1);
  const repeatedFailure = await runRuntimeFailure([
    'open', '--session', started.session, '--timeout', '0ms',
  ], 1, fake.env);
  assert.equal(parseReceipt(repeatedFailure.stdout).status, 'failed');
  assert.equal(await openRequestCount(fake.countPath), 1);
  await stopIfActive(started.session);
});

test('open recovers cancellation after listener close while an owned connection delays terminal', async (t) => {
  const fake = await fakeSystemOpener('open-cancel-recovery');
  if (!fake) {
    t.skip('The host cannot qualify a fake executable as a natural desktop opener');
    return;
  }
  const root = path.join(testRoot, 'open-cancel-recovery');
  const config = prototypeConfig('open-cancel-recovery');
  const started = await startOwnedServer(root, config, 10_000);
  const descriptor = await sessionDetails(started);
  const opening = runRuntime([
    'open', '--session', started.session, '--timeout', '5s',
  ], fake.env).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  await waitForOpenRequest(fake.countPath, 1);

  const pending = openChunkedFeedback(started, descriptor);
  const connectionClosed = pending.response.then(
    () => null,
    (error) => error,
  );
  await new Promise((resolve, reject) => {
    pending.request.write('{', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelResponse = await apiRequest(started, '/api/cancel', { method: 'POST' });
  assert.equal(cancelResponse.status, 200);
  assert.equal((await cancelResponse.json()).status, 'cancelled');

  const outcome = await opening;
  assert.equal('error' in outcome, false, outcome.error?.stderr);
  assert.equal(parseReceipt(outcome.result.stdout).status, 'cancelled');
  assert.ok(await connectionClosed instanceof Error);
  await waitForChildExit(started.child);
  const terminal = await readJson(path.join(path.dirname(started.session), 'terminal.json'));
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.resourcesClosed, true);
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);
});

test('the server exits by its own TTL and after feedback without a waiter', async () => {
  const expiredRoot = path.join(testRoot, 'owned-expiry');
  const expired = await startOwnedServer(expiredRoot, prototypeConfig('owned-expiry'), 250);
  await waitForChildExit(expired.child, 2_000);
  const expiredTerminal = await readJson(path.join(path.dirname(expired.session), 'terminal.json'));
  assert.equal(expiredTerminal.status, 'expired');
  assert.equal(expiredTerminal.resourcesClosed, true);
  await access(path.join(expiredRoot, 'prototype.json'));
  await assert.rejects(access(path.join(expiredRoot, 'feedback.json')), /ENOENT/);

  const submittedRoot = path.join(testRoot, 'owned-submission');
  const config = prototypeConfig('owned-submission');
  const submitted = await startOwnedServer(submittedRoot, config, 5_000);
  const response = await postFeedback(submitted, feedbackFor(config));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  await waitForChildExit(submitted.child, 2_000);
  assert.equal((await readJson(path.join(path.dirname(submitted.session), 'terminal.json'))).status, 'submitted');
  assert.equal(parseReceipt((await runRuntime(['status', '--session', submitted.session])).stdout).status, 'submitted');
});

test('feedback that crosses the real deadline cannot create canonical feedback', async () => {
  const root = path.join(testRoot, 'deadline-submit');
  const sharedArtifact = 'artifact/shared.html';
  const config = prototypeConfig('deadline-submit', {
    options: Array.from({ length: 5_000 }, (_, index) => ({
      id: `option-${index}`,
      label: `Option ${index}`,
      kind: 'html',
      artifact: sharedArtifact,
    })),
  });
  await mkdir(path.join(root, 'artifact'), { recursive: true });
  await writeFile(path.join(root, sharedArtifact), '<!doctype html><h1>Shared</h1>\n');
  await writeFile(path.join(root, 'brief.md'), '# Prototype brief\n');
  const prototypePath = path.join(root, 'prototype.json');
  await writeFile(prototypePath, `${JSON.stringify(config)}\n`);
  const started = await startOwnedServerFromPrototype(prototypePath, 250, 5_000);
  const descriptor = await sessionDetails(started);
  const requestedAt = Date.now();
  assert.ok(requestedAt < Date.parse(descriptor.expiresAt));

  const response = await postFeedback(started, feedbackFor(config));
  assert.equal(response.status, 410);
  assert.match((await response.json()).error, /expired before feedback was saved/);
  await waitForChildExit(started.child, 2_000);
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);
  assert.equal((await readJson(path.join(path.dirname(started.session), 'terminal.json'))).status, 'expired');
});

test('ending a wait client does not own the server lifetime', async () => {
  const root = path.join(testRoot, 'interrupted-wait');
  const started = await startOwnedServer(root, prototypeConfig('interrupted-wait'), 500);
  const waiter = spawn(process.execPath, [
    runtimeScript,
    'wait',
    '--session', started.session,
    '--timeout', '5s',
  ], { env: runtimeEnv, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  waiter.kill('SIGTERM');
  await waitForChildExit(waiter);
  await waitForChildExit(started.child, 2_000);
  assert.equal((await readJson(path.join(path.dirname(started.session), 'terminal.json'))).status, 'expired');
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);
});

test('concurrent starts reuse one server and the first valid submission wins', async () => {
  const root = path.join(testRoot, 'first-wins');
  const config = prototypeConfig('first-wins');
  const prototypePath = await writePrototype(root, config);
  const starts = await Promise.all([
    runRuntime(['start', '--prototype', prototypePath, '--ttl', '5s']),
    runRuntime(['start', '--prototype', prototypePath, '--ttl', '5s']),
  ]);
  const [first, second] = starts.map((result) => parseReceipt(result.stdout));
  activeSessions.add(first.session);
  assert.equal(first.session, second.session);
  assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
  assert.equal(first.expiresAt, second.expiresAt);
  const candidates = [
    feedbackFor(config, { selectedOptions: ['a'], globalNotes: 'First candidate.' }),
    feedbackFor(config, { selectedOptions: ['b'], globalNotes: 'Second candidate.' }),
  ];
  const responses = await Promise.all([
    postFeedback(first, candidates[0]),
    postFeedback(second, candidates[1]),
  ]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.ok(responses.every((response) => [200, 409].includes(response.status)));
  assert.equal(bodies.filter((body) => body.accepted === true).length, 1);
  const winner = bodies.findIndex((body) => body.accepted);
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), candidates[winner]);

  const waited = parseReceipt((await runRuntime([
    'wait', '--session', first.session, '--timeout', '2s',
  ])).stdout);
  activeSessions.delete(first.session);
  assert.equal(waited.status, 'submitted');
  assert.equal(waited.verdict, 'accepted');
});

test('the first valid submission wins across two independently owned servers', async () => {
  const root = path.join(testRoot, 'cross-server-first-wins');
  const config = prototypeConfig('cross-server-first-wins');
  const prototypePath = await writePrototype(root, config);
  const [first, second] = await Promise.all([
    startOwnedServerFromPrototype(prototypePath, 5_000),
    startOwnedServerFromPrototype(prototypePath, 5_000),
  ]);
  assert.notEqual(first.session, second.session);
  const candidates = [
    feedbackFor(config, { selectedOptions: ['a'], globalNotes: 'First server.' }),
    feedbackFor(config, { selectedOptions: ['b'], globalNotes: 'Second server.' }),
  ];
  const responses = await Promise.all([
    postFeedback(first, candidates[0]),
    postFeedback(second, candidates[1]),
  ]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.deepEqual(bodies.map((body) => body.accepted).sort(), [false, true]);
  const winner = bodies.findIndex((body) => body.accepted);
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), candidates[winner]);
  await Promise.all([waitForChildExit(first.child), waitForChildExit(second.child)]);
});

test('--new-session preserves an unknown matching session and later starts reuse the healthy server', async () => {
  const root = path.join(testRoot, 'new-session');
  const config = prototypeConfig('new-session');
  const unknown = await writeUnreachableSession(root, config);
  const blocked = await runRuntimeFailure([
    'start', '--prototype', path.join(root, 'prototype.json'), '--ttl', '5s',
  ]);
  assert.match(blocked.stderr, /matching Prototype Review session is unreachable/);

  const started = parseReceipt((await runRuntime([
    'start', '--prototype', path.join(root, 'prototype.json'), '--ttl', '5s', '--new-session',
  ])).stdout);
  activeSessions.add(started.session);
  assert.notEqual(started.session, unknown);
  await access(unknown);

  const reused = parseReceipt((await runRuntime([
    'start', '--prototype', path.join(root, 'prototype.json'),
  ], { ...runtimeEnv, PATH: '' })).stdout);
  assert.equal(reused.session, started.session);
  assert.equal(reused.reused, true);
  assert.equal(reused.expiresAt, started.expiresAt);
  await stopIfActive(started.session);
});

test('start reuses canonical feedback for the same revision without opening a session', async () => {
  const root = path.join(testRoot, 'reuse');
  const config = prototypeConfig('reuse');
  const started = await startPrototype(root, config);
  const feedback = feedbackFor(config);
  assert.equal((await postFeedback(started, feedback)).status, 200);

  const reused = parseReceipt((await runRuntime([
    'start', '--prototype', path.join(root, 'prototype.json'), '--ttl', '5s',
  ])).stdout);
  assert.equal(reused.status, 'submitted');
  assert.equal(reused.verdict, 'accepted');
  assert.deepEqual(reused.feedbackData, feedback);
  assert.equal('session' in reused, false);
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), feedback);

  await runRuntime(['wait', '--session', started.session, '--timeout', '2s']);
  activeSessions.delete(started.session);
});

test('a new revision invalidates an older live session', async () => {
  const root = path.join(testRoot, 'revision');
  const revisionOne = prototypeConfig('revision');
  const oldSession = await startPrototype(root, revisionOne);

  const revisionTwo = { ...revisionOne, revision: 2, question: 'Which revised option should we use?' };
  await writePrototype(root, revisionTwo);
  const current = await startPrototype(root, revisionTwo);
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);

  const staleResponse = await postFeedback(oldSession, feedbackFor(revisionOne));
  assert.equal(staleResponse.status, 409);
  assert.match((await staleResponse.json()).error, /revision changed/);
  const staleWait = parseReceipt((await runRuntime([
    'wait', '--session', oldSession.session, '--timeout', '2s',
  ])).stdout);
  assert.equal(staleWait.status, 'cancelled');
  activeSessions.delete(oldSession.session);

  const currentFeedback = feedbackFor(revisionTwo, {
    verdict: 'revise',
    selectedOptions: ['b'],
    globalNotes: 'Keep the history closer to the action.',
  });
  assert.equal((await postFeedback(current, currentFeedback)).status, 200);
  const waited = parseReceipt((await runRuntime([
    'wait', '--session', current.session, '--timeout', '2s',
  ])).stdout);
  activeSessions.delete(current.session);
  assert.equal(waited.revision, 2);
  assert.equal(waited.verdict, 'revise');
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), currentFeedback);

});

test('a new revision removes older canonical feedback and accepts a new result', async () => {
  const root = path.join(testRoot, 'revision-feedback');
  const revisionOne = prototypeConfig('revision-feedback');
  const first = await startPrototype(root, revisionOne);
  assert.equal((await postFeedback(first, feedbackFor(revisionOne))).status, 200);
  await waitForFile(path.join(path.dirname(first.session), 'terminal.json'));
  activeSessions.delete(first.session);
  assert.equal((await readJson(path.join(root, 'feedback.json'))).prototypeRevision, 1);

  const revisionTwo = { ...revisionOne, revision: 2, question: 'Choose the revised result.' };
  await writePrototype(root, revisionTwo);
  const second = await startPrototype(root, revisionTwo);
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);
  const currentFeedback = feedbackFor(revisionTwo, {
    verdict: 'revise',
    globalNotes: 'Use the second revision.',
  });
  const response = await postFeedback(second, currentFeedback);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), currentFeedback);
  activeSessions.delete(second.session);
});

test('status, stop, timeout, cancellation, and unreachable use bounded receipts', async () => {
  const ready = await startPrototype(path.join(testRoot, 'ready'), prototypeConfig('ready'));
  assert.equal(parseReceipt((await runRuntime(['status', '--session', ready.session])).stdout).status, 'ready');
  assert.equal(parseReceipt((await runRuntime([
    'wait', '--session', ready.session, '--timeout', '0ms',
  ])).stdout).status, 'timeout');
  const readyFeedback = feedbackFor(prototypeConfig('ready'));
  assert.equal((await postFeedback(ready, readyFeedback)).status, 200);
  assert.equal(parseReceipt((await runRuntime([
    'wait', '--session', ready.session, '--timeout', '2s',
  ])).stdout).status, 'submitted');
  activeSessions.delete(ready.session);

  const stopped = await startPrototype(path.join(testRoot, 'stopped'), prototypeConfig('stopped'));
  const stoppedReceipt = parseReceipt((await runRuntime(['stop', '--session', stopped.session])).stdout);
  assert.equal(stoppedReceipt.status, 'stopped');
  assert.equal(stoppedReceipt.terminalStatus, 'cancelled');
  activeSessions.delete(stopped.session);
  assert.equal(parseReceipt((await runRuntime(['stop', '--session', stopped.session])).stdout).status, 'stopped');
  assert.equal(parseReceipt((await runRuntime(['status', '--session', stopped.session])).stdout).status, 'cancelled');

  const cancelled = await startPrototype(path.join(testRoot, 'cancelled'), prototypeConfig('cancelled'));
  const cancelledDescriptor = await sessionDetails(cancelled);
  const pendingWait = fetch(new URL('/api/wait?timeoutMs=2000', cancelled.url), {
    headers: {
      origin: new URL(cancelled.url).origin,
      'x-prototype-review-token': cancelledDescriptor.token,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await apiRequest(cancelled, '/api/stop', { method: 'POST' })).status, 200);
  assert.equal((await (await pendingWait).json()).status, 'cancelled');
  assert.equal(parseReceipt((await runRuntime(['stop', '--session', cancelled.session])).stdout).status, 'stopped');
  activeSessions.delete(cancelled.session);

  const unreachable = await writeUnreachableSession(
    path.join(testRoot, 'unreachable'),
    prototypeConfig('unreachable'),
  );
  const status = parseReceipt((await runRuntime(['status', '--session', unreachable])).stdout);
  assert.equal(status.status, 'unreachable');
  const failure = await runRuntimeFailure(['stop', '--session', unreachable]);
  assert.equal(parseReceipt(failure.stdout).status, 'stop-unconfirmed');
  await access(unreachable);
});

test('v1 sessions keep feedback recovery and authenticated stop without claiming a TTL', async () => {
  const root = path.join(testRoot, 'legacy-v1');
  const config = prototypeConfig('legacy-v1');
  const prototypePath = await realpath(await writePrototype(root, config));
  const prototypeRoot = await realpath(root);
  const sessionId = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('base64url');
  let origin;
  const legacyServer = http.createServer((request, response) => {
    assert.equal(request.headers.origin, origin);
    assert.equal(request.headers['x-prototype-review-token'], token);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.method === 'POST' && request.url === '/api/stop') {
      response.end(JSON.stringify({ ok: true, status: 'submitted' }));
      setImmediate(() => legacyServer.close());
      return;
    }
    response.end(JSON.stringify({ ok: true, status: 'ready' }));
  });
  await new Promise((resolve, reject) => {
    legacyServer.once('error', reject);
    legacyServer.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${legacyServer.address().port}`;
  const safetyTimer = setTimeout(() => legacyServer.close(), 3_000);
  const closed = new Promise((resolve) => legacyServer.once('close', resolve));
  const sessionDir = path.join(runtimeTmp, 'agent-workflow', 'prototype-review', sessionId);
  const session = path.join(sessionDir, 'session.json');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(session, JSON.stringify({
    schemaVersion: 1,
    reviewShellVersion: 2,
    sessionId,
    token,
    pid: process.pid,
    url: `${origin}/review/index.html#token=${token}`,
    prototypePath,
    prototypeRoot,
    prototypeId: config.id,
    revision: config.revision,
    createdAt: new Date().toISOString(),
  }));

  const ready = parseReceipt((await runRuntime(['status', '--session', session])).stdout);
  assert.equal(ready.status, 'ready');
  assert.equal('expiresAt' in ready, false);
  await writeFile(path.join(root, 'feedback.json'), `${JSON.stringify(feedbackFor(config), null, 2)}\n`);
  assert.equal(parseReceipt((await runRuntime(['status', '--session', session])).stdout).status, 'submitted');
  const stopped = parseReceipt((await runRuntime(['stop', '--session', session])).stdout);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.status, 'stopping');
  await closed;
  clearTimeout(safetyTimer);
  await access(session);
  await assert.rejects(access(path.join(sessionDir, 'terminal.json')), /ENOENT/);
});

test('wait preserves an observed terminal response before resource confirmation and prefers saved feedback', async () => {
  for (const [status, saveFeedback] of [['cancelled', false], ['expired', false], ['expired', true]]) {
    const id = `wait-observed-${status}-${saveFeedback}`;
    const root = path.join(testRoot, id);
    const config = prototypeConfig(id);
    const session = await writeUnreachableSession(root, config);
    const descriptor = await readJson(session);
    const origin = new URL(descriptor.url).origin;
    let requests = 0;
    // This peer models the authenticated response followed by listener closure;
    // real server shutdown and resource confirmation have separate lifecycle tests.
    const server = http.createServer(async (request, response) => {
      requests += 1;
      assert.equal(request.headers.origin, origin);
      assert.equal(request.headers['x-prototype-review-token'], descriptor.token);
      assert.ok(request.url.startsWith('/api/wait?'));
      if (saveFeedback) {
        await writeFile(path.join(root, 'feedback.json'), JSON.stringify(feedbackFor(config)));
      }
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ ok: true, status }));
      server.close();
    });
    const closed = new Promise((resolve) => server.once('close', resolve));
    await new Promise((resolve) => server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
    try {
      const result = await runRuntime(['wait', '--session', session, '--timeout', '500ms']);
      const receipt = parseReceipt(result.stdout);
      assert.equal(receipt.status, saveFeedback ? 'submitted' : status);
      assert.equal(requests, 1);
      assert.equal(result.stderr, '');
      assert.equal('resourcesClosed' in receipt, false);
      await assert.rejects(access(path.join(path.dirname(session), 'terminal.json')), /ENOENT/);
    } finally {
      server.closeAllConnections();
      server.close();
      await closed;
    }
  }
});

test('terminal-only submitted state requires matching canonical feedback', async () => {
  const matchingRoot = path.join(testRoot, 'terminal-only-matching');
  const matchingConfig = prototypeConfig('terminal-only-matching');
  const matchingPrototype = await writePrototype(matchingRoot, matchingConfig);
  await writeFile(
    path.join(matchingRoot, 'feedback.json'),
    `${JSON.stringify(feedbackFor(matchingConfig), null, 2)}\n`,
  );
  const matchingSession = await writeTerminalOnly(matchingPrototype, matchingConfig);
  for (const command of ['status', 'wait', 'open']) {
    const result = parseReceipt((await runRuntime([command, '--session', matchingSession])).stdout);
    assert.equal(result.status, 'submitted');
    assert.equal(result.verdict, 'accepted');
    assert.equal(result.feedback, await realpath(path.join(matchingRoot, 'feedback.json')));
    assert.deepEqual(result.feedbackData, feedbackFor(matchingConfig));
  }

  const missingRoot = path.join(testRoot, 'terminal-only-missing');
  const missingConfig = prototypeConfig('terminal-only-missing');
  const missingPrototype = await writePrototype(missingRoot, missingConfig);
  const missingSession = await writeTerminalOnly(missingPrototype, missingConfig);
  const missing = await runRuntimeFailure(['status', '--session', missingSession]);
  assert.equal(parseReceipt(missing.stdout).status, 'failed');
  assert.match(missing.stderr, /matching feedback is unavailable/);

  const mismatchRoot = path.join(testRoot, 'terminal-only-mismatch');
  const mismatchConfig = prototypeConfig('terminal-only-mismatch');
  const mismatchPrototype = await writePrototype(mismatchRoot, mismatchConfig);
  await writeFile(
    path.join(mismatchRoot, 'feedback.json'),
    `${JSON.stringify(feedbackFor({ ...mismatchConfig, revision: 2 }), null, 2)}\n`,
  );
  const mismatchSession = await writeTerminalOnly(mismatchPrototype, mismatchConfig);
  const mismatch = await runRuntimeFailure(['wait', '--session', mismatchSession]);
  assert.equal(parseReceipt(mismatch.stdout).status, 'failed');
  assert.match(mismatch.stderr, /does not match this Prototype Review session/);
});

test('readonly status keeps old runtime state and the next mutating command collects it after 24 hours', async () => {
  const root = path.join(testRoot, 'terminal-gc');
  const config = prototypeConfig('terminal-gc');
  const session = await writeUnreachableSession(root, config);
  const descriptor = await readJson(session);
  await writeFile(path.join(path.dirname(session), 'terminal.json'), JSON.stringify({
    schemaVersion: 1,
    sessionId: descriptor.sessionId,
    prototypePath: descriptor.prototypePath,
    prototypeRoot: descriptor.prototypeRoot,
    prototypeId: descriptor.prototypeId,
    revision: descriptor.revision,
    status: 'expired',
    resourcesClosed: true,
    endedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  }));
  const interrupted = await writeUnreachableSession(
    path.join(testRoot, 'interrupted-gc'),
    prototypeConfig('interrupted-gc'),
  );
  const interruptedDescriptor = await readJson(interrupted);
  const oldCreatedAt = Date.now() - 25 * 60 * 60 * 1000;
  await writeFile(interrupted, JSON.stringify({
    ...interruptedDescriptor,
    createdAt: new Date(oldCreatedAt).toISOString(),
    expiresAt: new Date(oldCreatedAt + 5_000).toISOString(),
  }));

  assert.equal(parseReceipt((await runRuntime(['status', '--session', session])).stdout).status, 'expired');
  assert.equal(parseReceipt((await runRuntime(['status', '--session', interrupted])).stdout).status, 'unreachable');
  await access(session);
  await access(interrupted);
  const trigger = await startPrototype(path.join(testRoot, 'terminal-gc-trigger'), prototypeConfig('terminal-gc-trigger'));
  await assert.rejects(access(session), /ENOENT/);
  await assert.rejects(access(interrupted), /ENOENT/);
  await stopIfActive(trigger.session);
});

test('v2 stop waits for terminal while an owned HTTP connection is still active', async () => {
  const root = path.join(testRoot, 'stop-submit-race');
  const config = prototypeConfig('stop-submit-race');
  const started = await startOwnedServer(root, config, 5_000);
  const descriptor = await sessionDetails(started);
  const serialized = JSON.stringify(feedbackFor(config));
  const split = Math.floor(serialized.length / 2);
  const pending = openChunkedFeedback(started, descriptor);
  await new Promise((resolve, reject) => {
    pending.request.write(serialized.slice(0, split), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  let stopSettled = false;
  const stopResult = runRuntime(['stop', '--session', started.session]).then((result) => {
    stopSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(stopSettled, false);
  assert.equal(started.child.exitCode, null);
  await assert.rejects(access(path.join(path.dirname(started.session), 'terminal.json')), /ENOENT/);

  pending.request.end(serialized.slice(split));
  const lateSubmission = await pending.response;
  assert.equal(lateSubmission.status, 409);
  assert.match(lateSubmission.body.error, /session is stopping/);
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);

  const stopped = parseReceipt((await stopResult).stdout);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.terminalStatus, 'cancelled');
  await access(path.join(path.dirname(started.session), 'terminal.json'));
  await waitForChildExit(started.child);
});

test('v2 shutdown force-closes an owned HTTP connection before terminal confirmation', async () => {
  const root = path.join(testRoot, 'stop-force-close');
  const config = prototypeConfig('stop-force-close');
  const started = await startOwnedServer(root, config, 10_000);
  const descriptor = await sessionDetails(started);
  const serialized = JSON.stringify(feedbackFor(config));
  const pending = openChunkedFeedback(started, descriptor);
  const connectionClosed = pending.response.then(
    () => null,
    (error) => error,
  );
  await new Promise((resolve, reject) => {
    pending.request.write(serialized.slice(0, 1), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const requestedAt = Date.now();
  const stopped = parseReceipt((await runRuntime(['stop', '--session', started.session])).stdout);
  const elapsedMs = Date.now() - requestedAt;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.terminalStatus, 'cancelled');
  assert.ok(elapsedMs >= 2_500, `shutdown completed too early after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 6_000, `shutdown exceeded the CLI confirmation bound after ${elapsedMs}ms`);
  const connectionError = await connectionClosed;
  assert.ok(connectionError instanceof Error);
  assert.equal((await readJson(path.join(path.dirname(started.session), 'terminal.json'))).resourcesClosed, true);
  await waitForChildExit(started.child);
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);
});

test('artifact and feedback paths fail closed on escape or symlink replacement', async () => {
  const escapedRoot = path.join(testRoot, 'artifact-escape');
  const escaped = prototypeConfig('artifact-escape', {
    options: [{ id: 'a', label: 'A', kind: 'html', artifact: '../outside.html' }],
  });
  await mkdir(escapedRoot, { recursive: true });
  await writeFile(path.join(testRoot, 'outside.html'), 'outside\n');
  await writePrototype(escapedRoot, escaped);
  assert.match((await runRuntimeFailure([
    'start', '--prototype', path.join(escapedRoot, 'prototype.json'),
  ])).stderr, /inside artifact/);

  const symlinkRoot = path.join(testRoot, 'artifact-symlink');
  const symlinkConfig = prototypeConfig('artifact-symlink');
  await writePrototype(symlinkRoot, symlinkConfig);
  await rm(path.join(symlinkRoot, 'artifact', 'a.html'));
  await symlink(path.join(testRoot, 'outside.html'), path.join(symlinkRoot, 'artifact', 'a.html'));
  assert.match((await runRuntimeFailure([
    'start', '--prototype', path.join(symlinkRoot, 'prototype.json'),
  ])).stderr, /regular non-symlink file/);

  const feedbackRoot = path.join(testRoot, 'feedback-symlink');
  const feedbackConfig = prototypeConfig('feedback-symlink');
  const started = await startPrototype(feedbackRoot, feedbackConfig);
  const externalFeedback = path.join(testRoot, 'external-feedback.json');
  await writeFile(externalFeedback, 'preserve\n');
  await symlink(externalFeedback, path.join(feedbackRoot, 'feedback.json'));
  const response = await postFeedback(started, feedbackFor(feedbackConfig));
  assert.equal(response.status, 400);
  assert.equal(await readFile(externalFeedback, 'utf8'), 'preserve\n');
  await stopIfActive(started.session);
});

test('a replaced Prototype root cannot receive feedback from an existing session', async () => {
  const root = path.join(testRoot, 'replaced-root');
  const displacedRoot = path.join(testRoot, 'replaced-root-original');
  const config = prototypeConfig('replaced-root');
  const started = await startPrototype(root, config);
  await rename(root, displacedRoot);
  await writePrototype(root, config);

  const response = await postFeedback(started, feedbackFor(config));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /physical identity changed/);
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);
  await stopIfActive(started.session);
});

test('session descriptors outside the runtime root cannot be used', async () => {
  const foreign = path.join(testRoot, 'foreign-session.json');
  await writeFile(foreign, '{}\n');
  const failure = await runRuntimeFailure(['status', '--session', foreign]);
  assert.match(failure.stderr, /outside the Prototype Review temporary root/);
  assert.equal(parseReceipt(failure.stdout).status, 'failed');
});
