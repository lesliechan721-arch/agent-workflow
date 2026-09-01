import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
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
  assert.equal(context.plugin.name, 'ask-me');
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
const testRoot = await mkdtemp(path.join(os.tmpdir(), 'ask-me-prototype-review-v2-'));
const runtimeTmp = path.join(testRoot, 'tmp');
await mkdir(runtimeTmp);
const runtimeEnv = { ...process.env, TMPDIR: runtimeTmp };
const activeSessions = new Set();

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
  const result = await runRuntime(['start', '--prototype', prototypePath], env);
  const started = parseReceipt(result.stdout);
  assert.equal(started.ok, true);
  assert.equal(started.status, 'ready');
  activeSessions.add(started.session);
  return started;
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
  await rm(testRoot, { recursive: true, force: true });
});

test('Prototype Review scripts expose the bounded command contract', async () => {
  await Promise.all([access(runtimeScript), access(serverScript)]);
  const general = await runRuntime(['--help']);
  assert.match(general.stdout, /start --prototype/);
  for (const command of ['start', 'wait', 'status', 'stop']) {
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

  const runtimeSource = await readFile(runtimeScript, 'utf8');
  const serverSource = await readFile(serverScript, 'utf8');
  for (const obsolete of ['feedbackDigest', 'submission-gates', 'recovering', 'superseded']) {
    assert.doesNotMatch(`${runtimeSource}\n${serverSource}`, new RegExp(obsolete));
  }
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

  const feedback = feedbackFor(config, { cssVariableValues: { '--space': '8px' } });
  const first = await postFeedback(started, feedback);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).accepted, true);
  const repeated = await postFeedback(started, { ...feedback, globalNotes: 'Too late.' });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).accepted, false);
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), feedback);

  const status = parseReceipt((await runRuntime(['status', '--session', started.session])).stdout);
  assert.equal(status.status, 'submitted');
  assert.equal(status.verdict, 'accepted');
  assert.equal('feedbackDigest' in status, false);
  const waited = parseReceipt((await runRuntime(['wait', '--session', started.session, '--timeout', '2s'])).stdout);
  activeSessions.delete(started.session);
  assert.equal(waited.status, 'submitted');
  assert.equal(waited.feedback, await realpath(path.join(root, 'feedback.json')));
  assert.equal('feedbackDigest' in waited, false);
  assert.deepEqual(parseReceipt((await runRuntime(['status', '--session', started.session])).stdout), {
    ok: true,
    status: 'not-found',
    session: started.session,
  });
});

test('the first valid submission wins across sessions for one revision', async () => {
  const root = path.join(testRoot, 'first-wins');
  const config = prototypeConfig('first-wins');
  const first = await startPrototype(root, config);
  const second = await startPrototype(root, config);
  const candidates = [
    feedbackFor(config, { selectedOptions: ['a'], globalNotes: 'First candidate.' }),
    feedbackFor(config, { selectedOptions: ['b'], globalNotes: 'Second candidate.' }),
  ];
  const responses = await Promise.all([
    postFeedback(first, candidates[0]),
    postFeedback(second, candidates[1]),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.deepEqual(bodies.map((body) => body.accepted).sort(), [false, true]);
  const winner = bodies.findIndex((body) => body.accepted);
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), candidates[winner]);

  for (const started of [first, second]) {
    const waited = parseReceipt((await runRuntime([
      'wait', '--session', started.session, '--timeout', '2s',
    ])).stdout);
    activeSessions.delete(started.session);
    assert.equal(waited.status, 'submitted');
    assert.equal(waited.verdict, 'accepted');
  }
});

test('start reuses canonical feedback for the same revision without opening a session', async () => {
  const root = path.join(testRoot, 'reuse');
  const config = prototypeConfig('reuse');
  const started = await startPrototype(root, config);
  const feedback = feedbackFor(config);
  assert.equal((await postFeedback(started, feedback)).status, 200);

  const reused = parseReceipt((await runRuntime([
    'start', '--prototype', path.join(root, 'prototype.json'),
  ])).stdout);
  assert.equal(reused.status, 'submitted');
  assert.equal(reused.verdict, 'accepted');
  assert.equal('session' in reused, false);
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), feedback);

  await runRuntime(['wait', '--session', started.session, '--timeout', '2s']);
  activeSessions.delete(started.session);
});

test('a new revision removes older feedback and invalidates older sessions', async () => {
  const root = path.join(testRoot, 'revision');
  const revisionOne = prototypeConfig('revision');
  const oldWriter = await startPrototype(root, revisionOne);
  const oldObserver = await startPrototype(root, revisionOne);
  assert.equal((await postFeedback(oldWriter, feedbackFor(revisionOne))).status, 200);

  const revisionTwo = { ...revisionOne, revision: 2, question: 'Which revised option should we use?' };
  await writePrototype(root, revisionTwo);
  const current = await startPrototype(root, revisionTwo);
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);

  const staleResponse = await postFeedback(oldObserver, feedbackFor(revisionOne));
  assert.equal(staleResponse.status, 409);
  assert.match((await staleResponse.json()).error, /revision changed/);
  const staleWait = await runRuntimeFailure([
    'wait', '--session', oldObserver.session, '--timeout', '200ms',
  ]);
  assert.equal(parseReceipt(staleWait.stdout).status, 'failed');

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

  await stopIfActive(oldWriter.session);
  await stopIfActive(oldObserver.session);
});

test('status, stop, timeout, cancellation, and unreachable use bounded receipts', async () => {
  const ready = await startPrototype(path.join(testRoot, 'ready'), prototypeConfig('ready'));
  assert.equal(parseReceipt((await runRuntime(['status', '--session', ready.session])).stdout).status, 'ready');
  assert.equal(parseReceipt((await runRuntime([
    'wait', '--session', ready.session, '--timeout', '0ms',
  ])).stdout).status, 'timeout');
  activeSessions.delete(ready.session);

  const stopped = await startPrototype(path.join(testRoot, 'stopped'), prototypeConfig('stopped'));
  assert.equal(parseReceipt((await runRuntime(['stop', '--session', stopped.session])).stdout).status, 'stopped');
  activeSessions.delete(stopped.session);
  assert.equal(parseReceipt((await runRuntime(['stop', '--session', stopped.session])).stdout).status, 'not-found');

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

  const unreachable = await startPrototype(path.join(testRoot, 'unreachable'), prototypeConfig('unreachable'));
  const descriptor = await sessionDetails(unreachable);
  process.kill(descriptor.pid, 'SIGTERM');
  let status;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    status = parseReceipt((await runRuntime(['status', '--session', unreachable.session])).stdout);
    if (status.status === 'unreachable') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(status.status, 'unreachable');
  assert.equal(parseReceipt((await runRuntime(['stop', '--session', unreachable.session])).stdout).status, 'stopped');
  activeSessions.delete(unreachable.session);
});

test('stop cannot be followed by a late submission from a request body still in transit', async () => {
  const root = path.join(testRoot, 'stop-submit-race');
  const config = prototypeConfig('stop-submit-race');
  const started = await startPrototype(root, config);
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

  const stopped = await apiRequest(started, '/api/stop', { method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).status, 'cancelled');
  pending.request.end(serialized.slice(split));
  const lateSubmission = await pending.response;
  assert.equal(lateSubmission.status, 409);
  assert.match(lateSubmission.body.error, /session is stopping/);
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);

  assert.equal(parseReceipt((await runRuntime(['stop', '--session', started.session])).stdout).status, 'stopped');
  activeSessions.delete(started.session);
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
