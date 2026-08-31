import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
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
    ...overrides,
  };
}

function parseReceipt(stdout) {
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected one stdout JSON receipt, received: ${stdout}`);
  return JSON.parse(lines[0]);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function feedbackDigest(feedback) {
  return `sha256:${createHash('sha256').update(stableJson(feedback)).digest('hex')}`;
}

function submissionGateKey(prototypeRoot, prototypeId) {
  return createHash('sha256').update(stableJson({ prototypeRoot, prototypeId })).digest('hex');
}

async function waitForExit(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out waiting for child process; stdout=${stdout}; stderr=${stderr}`));
    }, 10_000);
    child.once('error', reject);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
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
const activeSessions = new Map();

async function runRuntime(args, env = runtimeEnv) {
  return execFileAsync(process.execPath, [runtimeScript, ...args], {
    env,
    timeout: 10_000,
  });
}

async function runRuntimeFailure(args, expectedCode, env = runtimeEnv) {
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
            ? '<!doctype html><h1 data-prototype-id="heading">Fixture</h1>\n'
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
  activeSessions.set(started.session, { env, url: started.url });
  return started;
}

async function sessionDetails(started) {
  return readJson(started.session);
}

async function postFeedback(started, value, headers = {}) {
  const descriptor = await sessionDetails(started);
  return fetch(new URL('/api/feedback', started.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(started.url).origin,
      'x-prototype-review-token': descriptor.token,
      ...headers,
    },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
}

async function pipelineRequests(url, requests) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for pipelined HTTP responses'));
    }, 5_000);
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const raw = buffer.toString('utf8');
      const statuses = [...raw.matchAll(/HTTP\/1\.1 (\d+)/g)].map((match) => Number(match[1]));
      const completedBodies = [...raw.matchAll(/\r\n0\r\n\r\n/g)].length;
      if (statuses.length === requests.length && completedBodies === requests.length) {
        clearTimeout(timer);
        socket.destroy();
        resolve({ statuses, raw });
      }
    });
    socket.on('connect', () => socket.write(requests.join('')));
  });
}

async function waitForPath(filePath) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function stopIfActive(session) {
  try {
    await runRuntime(['stop', '--session', session], activeSessions.get(session)?.env);
  } catch {
    // The owning test can deliberately make a descriptor unreachable.
  }
  activeSessions.delete(session);
}

test.after(async () => {
  for (const session of activeSessions.keys()) await stopIfActive(session);
  await rm(testRoot, { recursive: true, force: true });
});

test('bundled Prototype Review v2 scripts expose all command help and usage exits', async () => {
  await Promise.all([access(runtimeScript), access(serverScript)]);
  const general = await runRuntime(['--help']);
  assert.match(general.stdout, /start --prototype/);
  for (const command of ['start', 'wait', 'status', 'stop']) {
    const result = await runRuntime([command, '--help']);
    assert.match(result.stdout, new RegExp(`prototype-review\\.mjs ${command}`));
    assert.equal(result.stderr, '');
  }
  assert.match((await execFileAsync(process.execPath, [serverScript, '--help'])).stdout, /review-server/);

  const usage = await runRuntimeFailure(['start'], 2);
  assert.deepEqual(parseReceipt(usage.stdout), {
    ok: false,
    status: 'usage',
    error: 'start requires --prototype',
  });
  assert.match(usage.stderr, /Usage:/);
});

test('Prototype and feedback schemas enforce only v2 selection and verdict contracts', async () => {
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
  assert.equal(single.allowOther, true);

  assert.throws(
    () => contract.normalizeAndValidate({ ...single, schemaVersion: 1 }, prototypeSchema, 'prototype'),
    /must equal 2/,
  );
  assert.throws(
    () => contract.normalizeAndValidate({ ...single, decisionFrame: {}, decisionContext: undefined }, prototypeSchema, 'prototype'),
    /decisionContext is required|decisionFrame is not allowed/,
  );
  assert.throws(
    () => contract.normalizeAndValidate({
      ...single,
      selectionMode: 'none',
      options: [...single.options, { ...single.options[0], id: 'b' }],
    }, prototypeSchema, 'prototype'),
    /requires exactly one option/,
  );
  assert.throws(
    () => contract.normalizeAndValidate({
      ...single,
      guidedQuestions: [{ id: 'risk', label: 'Risk visible?' }],
    }, prototypeSchema, 'prototype'),
    /requires choices/,
  );
  const freeform = contract.normalizeAndValidate({
    ...single,
    guidedQuestions: [{ id: 'comment', label: 'What should change?', selectionMode: 'freeform' }],
  }, prototypeSchema, 'prototype');
  assert.equal(freeform.guidedQuestions[0].choices, undefined);

  const accepted = feedbackFor(single);
  assert.deepEqual(
    contract.validateFeedbackAgainstPrototype(accepted, single),
    accepted,
  );
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({ ...accepted, selectedOptions: [] }, single),
    /exactly one option/,
  );

  const multiple = { ...single, selectionMode: 'multiple' };
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({ ...feedbackFor(multiple), selectedOptions: [] }, multiple),
    /at least one option/,
  );
  const none = { ...single, selectionMode: 'none' };
  assert.doesNotThrow(() => contract.validateFeedbackAgainstPrototype(feedbackFor(none), none));
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({ ...feedbackFor(none), selectedOptions: ['a'] }, none),
    /must be empty/,
  );

  const revise = { ...accepted, verdict: 'revise', selectedOptions: [] };
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype(revise, single),
    /revise verdict requires/,
  );
  assert.doesNotThrow(() => contract.validateFeedbackAgainstPrototype({ ...revise, globalNotes: 'Move the summary.' }, single));
  const guided = {
    ...single,
    guidedQuestions: [{ id: 'risk', label: 'Risk visible?', selectionMode: 'single', choices: ['yes', 'no'] }],
  };
  assert.doesNotThrow(() => contract.validateFeedbackAgainstPrototype({
    ...feedbackFor(guided),
    verdict: 'revise',
    selectedOptions: [],
    answers: [{ questionId: 'risk', selected: ['no'], comment: '' }],
  }, guided));
  const cssPrototype = { ...single, editableCssVariables: { '--space': ['8px', '16px'] } };
  assert.doesNotThrow(() => contract.validateFeedbackAgainstPrototype({
    ...feedbackFor(cssPrototype),
    verdict: 'revise',
    selectedOptions: [],
    cssVariableValues: { '--space': '16px' },
  }, cssPrototype));

  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({ ...accepted, verdict: 'rejected', selectedOptions: [] }, single),
    /reason is required/,
  );
  assert.doesNotThrow(() => contract.validateFeedbackAgainstPrototype({
    ...accepted,
    verdict: 'rejected',
    selectedOptions: [],
    reason: 'Neither option preserves history.',
  }, single));
  const rejectedWithSelection = {
    ...accepted,
    verdict: 'rejected',
    selectedOptions: ['a'],
    reason: 'Neither option preserves history.',
  };
  assert.throws(
    () => policy.validateFeedbackForPrototype(rejectedWithSelection, single),
    /selectedOptions must be empty for a rejected verdict/,
  );
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype(rejectedWithSelection, single),
    /selectedOptions must be empty for a rejected verdict/,
  );
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({
      ...accepted,
      verdict: 'rejected',
      selectedOptions: [],
      reason: 'No.',
    }, { ...single, allowOther: false }),
    /not allowed/,
  );
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({
      ...accepted,
      verdict: 'new-material-question',
      selectedOptions: [],
    }, single),
    /materialQuestion is required/,
  );
  assert.throws(
    () => contract.validateFeedbackAgainstPrototype({ ...accepted, prototypeRevision: 2 }, single),
    /must match the Prototype revision/,
  );

  assert.throws(
    () => contract.normalizeAndValidate({ ...accepted, selectedOptions: ['a', 'a'] }, feedbackSchema, 'feedback'),
    /must contain unique items/,
  );
  assert.throws(
    () => contract.normalizeAndValidate({
      ...accepted,
      annotations: [{
        id: 'a1',
        target: { kind: 'dom', value: { optionId: 'a', elementId: 'heading' } },
        category: 'visual',
        comment: 'Too large.',
      }],
    }, feedbackSchema, 'feedback'),
    /category must be object/,
  );
  assert.throws(
    () => policy.validateFeedbackForPrototype(revise, single),
    /revise verdict requires/,
  );
});

test('start, HTTP feedback, wait, cleanup, and service containment form one real session', async () => {
  const root = path.join(testRoot, 'submitted');
  const config = prototypeConfig('submitted', {
    allowAnnotations: true,
    guidedQuestions: [{ id: 'risk', label: 'Risk visible?', selectionMode: 'single', choices: ['yes', 'no'] }],
    editableCssVariables: { '--space': ['8px', '16px'] },
  });
  const started = await startPrototype(root, config);
  const descriptor = await sessionDetails(started);
  const descriptorText = await readFile(started.session, 'utf8');
  assert.equal(descriptor.reviewShellVersion, 2);
  assert.equal(descriptor.prototypeId, config.id);
  assert.equal(descriptor.revision, config.revision);
  assert.equal(typeof descriptor.token, 'string');
  assert.equal(descriptorText, JSON.stringify(descriptor));
  assert.equal(new URLSearchParams(new URL(started.url).hash.slice(1)).get('token'), descriptor.token);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(started.session)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.dirname(started.session))).mode & 0o777, 0o700);
  }

  assert.match(await (await fetch(started.url)).text(), /Prototype Review/);
  const reviewApp = await readFile(path.join(skillRoot, 'assets', 'review-shell', 'app.js'), 'utf8');
  assert.match(reviewApp, /consumeSessionToken\(window\.location, window\.history\)/);
  assert.doesNotMatch(reviewApp, /\/api\/session/);
  const publicSession = await fetch(new URL('/api/session', started.url));
  assert.equal(publicSession.status, 404);
  assert.equal((await publicSession.text()).includes(descriptor.token), false);
  assert.match(await (await fetch(new URL('/artifact/a.html', started.url))).text(), /Fixture/);
  assert.equal((await fetch(new URL('/prototype.json', started.url))).status, 404);
  assert.equal((await fetch(new URL('/brief.md', started.url))).status, 404);
  assert.equal((await fetch(new URL('/feedback.json', started.url))).status, 404);
  assert.equal((await fetch(new URL('/artifact/%2e%2e%2fprototype.json', started.url))).status, 404);
  assert.equal((await fetch(new URL('/api/status', started.url))).status, 403);
  assert.equal((await fetch(new URL('/api/status', started.url), {
    headers: { 'x-prototype-review-token': descriptor.token },
  })).status, 403);
  assert.equal((await fetch(new URL('/api/stop', started.url), {
    method: 'POST',
    headers: {
      origin: new URL(started.url).origin,
      'x-prototype-review-token': 'wrong-token',
    },
  })).status, 403);
  await assert.rejects(access(path.join(root, 'review')), /ENOENT/);

  const valid = feedbackFor(config, {
    answers: [{ questionId: 'risk', selected: ['yes'], comment: '' }],
    cssVariableValues: { '--space': '8px' },
  });
  assert.equal((await fetch(new URL('/api/feedback', started.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(started.url).origin },
    body: JSON.stringify(valid),
  })).status, 403);
  assert.equal((await postFeedback(started, valid, { origin: 'http://example.test' })).status, 403);
  assert.equal((await postFeedback(started, valid, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await postFeedback(started, { ...valid, prototypeRevision: 2 })).status, 409);
  assert.equal((await postFeedback(started, { ...valid, selectedOptions: [] })).status, 400);
  assert.equal((await postFeedback(started, {
    ...valid,
    verdict: 'rejected',
    reason: 'The candidate does not meet the decision goal.',
  })).status, 400);
  assert.equal((await postFeedback(started, JSON.stringify({
    ...valid,
    globalNotes: 'x'.repeat(2 * 1024 * 1024),
  }))).status, 413);

  const competing = {
    ...valid,
    answers: [{ questionId: 'risk', selected: ['no'], comment: 'The risk is hidden.' }],
    cssVariableValues: { '--space': '16px' },
    globalNotes: 'Use the roomier variant.',
  };
  const candidates = [valid, competing];
  const submissions = await Promise.all(candidates.map((candidate) => postFeedback(started, candidate)));
  assert.deepEqual(submissions.map((response) => response.status).sort(), [200, 409]);
  const successfulFeedback = candidates[submissions.findIndex((response) => response.status === 200)];
  const status = parseReceipt((await runRuntime(['status', '--session', started.session])).stdout);
  assert.equal(status.status, 'submitted');

  const waited = parseReceipt((await runRuntime([
    'wait', '--session', started.session, '--timeout', '2s',
  ])).stdout);
  activeSessions.delete(started.session);
  assert.deepEqual(waited, {
    ok: true,
    status: 'submitted',
    prototypeId: config.id,
    revision: 1,
    verdict: 'accepted',
    selectedOptionCount: 1,
    annotationCount: 0,
    feedback: path.join(descriptor.prototypeRoot, 'feedback.json'),
    feedbackDigest: feedbackDigest(successfulFeedback),
  });
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), successfulFeedback);
  await assert.rejects(access(started.session), /ENOENT/);
  await assert.rejects(access(path.join(root, 'review')), /ENOENT/);
  await assert.rejects(fetch(started.url));
});

test('one submitted revision blocks later sessions without replacing its feedback', async () => {
  const root = path.join(testRoot, 'shared-session');
  const config = prototypeConfig('shared-session');
  const first = await startPrototype(root, config);
  const second = await startPrototype(root, config);
  const firstDescriptor = await sessionDetails(first);
  const accepted = feedbackFor(config);
  const rejected = feedbackFor(config, {
    verdict: 'rejected',
    selectedOptions: [],
    reason: 'The current option does not preserve enough context.',
  });

  const firstSubmission = await postFeedback(first, accepted);
  assert.equal(firstSubmission.status, 200);
  assert.equal((await firstSubmission.json()).feedbackDigest, feedbackDigest(accepted));
  const gateRoot = path.join(path.dirname(path.dirname(first.session)), 'submission-gates');
  assert.deepEqual((await readdir(gateRoot)).filter((name) => name.endsWith('.json')), []);
  const submitted = parseReceipt((await runRuntime([
    'wait', '--session', first.session, '--timeout', '2s',
  ])).stdout);
  activeSessions.delete(first.session);
  assert.deepEqual(submitted, {
    ok: true,
    status: 'submitted',
    prototypeId: config.id,
    revision: config.revision,
    verdict: 'accepted',
    selectedOptionCount: 1,
    annotationCount: 0,
    feedback: path.join(firstDescriptor.prototypeRoot, 'feedback.json'),
    feedbackDigest: feedbackDigest(accepted),
  });

  const secondSubmission = await postFeedback(second, rejected);
  assert.equal(secondSubmission.status, 409);
  assert.deepEqual(await secondSubmission.json(), {
    ok: false,
    status: 'superseded',
    error: 'Feedback was already submitted by another Prototype Review session for this revision',
  });
  activeSessions.delete(second.session);
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), accepted);
  await assert.rejects(access(first.session), /ENOENT/);
  await assert.rejects(access(second.session), /ENOENT/);
  await assert.rejects(fetch(first.url));
  await assert.rejects(fetch(second.url));
  assert.deepEqual(
    (await readdir(path.dirname(path.dirname(first.session)))).filter((name) => /^[a-f0-9]{32}$/.test(name)),
    [],
  );
});

test('simultaneous sessions for one revision allow only one canonical submission', async () => {
  const root = path.join(testRoot, 'simultaneous-sessions');
  const config = prototypeConfig('simultaneous-sessions');
  const sessions = await Promise.all([
    startPrototype(root, config),
    startPrototype(root, config),
  ]);
  const candidates = [
    feedbackFor(config),
    feedbackFor(config, {
      verdict: 'rejected',
      selectedOptions: [],
      reason: 'The option is not clear enough.',
    }),
  ];
  const responses = await Promise.all(sessions.map((session, index) => postFeedback(session, candidates[index])));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  const winnerIndex = responses.findIndex((response) => response.status === 200);
  const loserIndex = 1 - winnerIndex;
  assert.equal(bodies[winnerIndex].feedbackDigest, feedbackDigest(candidates[winnerIndex]));
  if (bodies[loserIndex].status === 'busy') {
    const retried = await postFeedback(sessions[loserIndex], candidates[loserIndex]);
    assert.equal(retried.status, 409);
    assert.equal((await retried.json()).status, 'superseded');
  } else {
    assert.equal(bodies[loserIndex].status, 'superseded');
  }
  activeSessions.delete(sessions[loserIndex].session);

  const winnerDescriptor = await sessionDetails(sessions[winnerIndex]);
  const waited = parseReceipt((await runRuntime([
    'wait', '--session', sessions[winnerIndex].session, '--timeout', '2s',
  ])).stdout);
  activeSessions.delete(sessions[winnerIndex].session);
  assert.equal(waited.status, 'submitted');
  assert.equal(waited.verdict, candidates[winnerIndex].verdict);
  assert.equal(waited.feedback, path.join(winnerDescriptor.prototypeRoot, 'feedback.json'));
  assert.equal(waited.feedbackDigest, feedbackDigest(candidates[winnerIndex]));
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), candidates[winnerIndex]);
  await assert.rejects(access(sessions[loserIndex].session), /ENOENT/);
  await assert.rejects(fetch(sessions[loserIndex].url));
});

test('a new Prototype revision can replace canonical feedback', async () => {
  const root = path.join(testRoot, 'new-revision');
  const firstConfig = prototypeConfig('new-revision');
  const first = await startPrototype(root, firstConfig);
  const accepted = feedbackFor(firstConfig);
  assert.equal((await postFeedback(first, accepted)).status, 200);
  assert.equal(parseReceipt((await runRuntime([
    'wait', '--session', first.session, '--timeout', '2s',
  ])).stdout).verdict, 'accepted');
  activeSessions.delete(first.session);

  const secondConfig = { ...firstConfig, revision: 2 };
  const second = await startPrototype(root, secondConfig);
  const rejected = feedbackFor(secondConfig, {
    verdict: 'rejected',
    selectedOptions: [],
    reason: 'Revision 2 still does not meet the goal.',
  });
  assert.equal((await postFeedback(second, rejected)).status, 200);
  const waited = parseReceipt((await runRuntime([
    'wait', '--session', second.session, '--timeout', '2s',
  ])).stdout);
  activeSessions.delete(second.session);
  assert.equal(waited.status, 'submitted');
  assert.equal(waited.revision, 2);
  assert.equal(waited.verdict, 'rejected');
  assert.equal(waited.feedbackDigest, feedbackDigest(rejected));
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), rejected);
});

test('a session for an old revision cannot overwrite feedback from the current revision', async () => {
  const root = path.join(testRoot, 'stale-revision');
  const firstConfig = prototypeConfig('stale-revision');
  const stale = await startPrototype(root, firstConfig);
  const secondConfig = { ...firstConfig, revision: 2 };
  const current = await startPrototype(root, secondConfig);
  const currentFeedback = feedbackFor(secondConfig, {
    verdict: 'rejected',
    selectedOptions: [],
    reason: 'Revision 2 does not meet the goal.',
  });
  assert.equal((await postFeedback(current, currentFeedback)).status, 200);
  const currentWait = parseReceipt((await runRuntime([
    'wait', '--session', current.session, '--timeout', '2s',
  ])).stdout);
  activeSessions.delete(current.session);
  assert.equal(currentWait.status, 'submitted');
  assert.equal(currentWait.feedbackDigest, feedbackDigest(currentFeedback));

  const staleResponse = await postFeedback(stale, feedbackFor(firstConfig));
  assert.equal(staleResponse.status, 409);
  assert.deepEqual(await staleResponse.json(), {
    ok: false,
    status: 'superseded',
    error: 'Prototype revision changed after this Review session started',
  });
  activeSessions.delete(stale.session);
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), currentFeedback);
  assert.equal(feedbackDigest(await readJson(path.join(root, 'feedback.json'))), currentWait.feedbackDigest);
  await assert.rejects(access(stale.session), /ENOENT/);
  await assert.rejects(fetch(stale.url));
});

test('a revision change after feedback write removes only that stale submission', async () => {
  const root = path.join(testRoot, 'revision-change-after-write');
  const firstConfig = prototypeConfig('revision-change-after-write');
  const isolatedTmp = path.join(testRoot, 'revision-change-after-write-tmp');
  await mkdir(isolatedTmp);
  const isolatedEnv = {
    ...runtimeEnv,
    TMPDIR: isolatedTmp,
    AW_PROTOTYPE_REVIEW_TEST_AFTER_WRITE_DELAY_MS: '250',
  };
  const started = await startPrototype(root, firstConfig, undefined, isolatedEnv);
  const submission = postFeedback(started, feedbackFor(firstConfig));
  await waitForPath(path.join(root, 'feedback.json'));
  await writePrototype(root, { ...firstConfig, revision: 2 });

  const response = await submission;
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    status: 'superseded',
    error: 'Prototype revision changed after this Review session started',
  });
  activeSessions.delete(started.session);
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);
  await assert.rejects(access(started.session), /ENOENT/);
  await assert.rejects(fetch(started.url));
  const gateRoot = path.join(path.dirname(path.dirname(started.session)), 'submission-gates');
  assert.deepEqual((await readdir(gateRoot)).filter((name) => name.endsWith('.json')), []);
});

test('stale-submission cleanup never deletes feedback that no longer matches its own digest', async () => {
  const root = path.join(testRoot, 'foreign-feedback-after-write');
  const firstConfig = prototypeConfig('foreign-feedback-after-write');
  const isolatedTmp = path.join(testRoot, 'foreign-feedback-after-write-tmp');
  await mkdir(isolatedTmp);
  const isolatedEnv = {
    ...runtimeEnv,
    TMPDIR: isolatedTmp,
    AW_PROTOTYPE_REVIEW_TEST_AFTER_WRITE_DELAY_MS: '250',
  };
  const started = await startPrototype(root, firstConfig, undefined, isolatedEnv);
  const submission = postFeedback(started, feedbackFor(firstConfig));
  const feedbackPath = path.join(root, 'feedback.json');
  await waitForPath(feedbackPath);
  const secondConfig = { ...firstConfig, revision: 2 };
  await writePrototype(root, secondConfig);
  const foreignFeedback = feedbackFor(secondConfig, {
    verdict: 'rejected',
    selectedOptions: [],
    reason: 'This feedback belongs to the current revision.',
  });
  await writeFile(feedbackPath, `${JSON.stringify(foreignFeedback, null, 2)}\n`);

  const response = await submission;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).status, 'superseded');
  activeSessions.delete(started.session);
  assert.deepEqual(await readJson(feedbackPath), foreignFeedback);
  await assert.rejects(access(started.session), /ENOENT/);
});

test('an orphaned recovery claim does not permanently block feedback submission', async () => {
  const root = path.join(testRoot, 'orphaned-recovery-claim');
  const config = prototypeConfig('orphaned-recovery-claim');
  const started = await startPrototype(root, config);
  const descriptor = await sessionDetails(started);
  const gateRoot = path.join(path.dirname(path.dirname(started.session)), 'submission-gates');
  const gateKey = submissionGateKey(descriptor.prototypeRoot, config.id);
  await mkdir(path.join(gateRoot, `${gateKey}.recovering`), { recursive: true });
  await writeFile(path.join(gateRoot, `${gateKey}.json`), JSON.stringify({
    schemaVersion: 1,
    sessionId: 'd'.repeat(32),
    pid: process.pid,
    prototypeRoot: descriptor.prototypeRoot,
    prototypeId: config.id,
    prototypePath: descriptor.prototypePath,
    revision: config.revision,
    tokenDigest: `sha256:${'0'.repeat(64)}`,
  }));

  assert.equal((await postFeedback(started, feedbackFor(config))).status, 200);
  const waited = parseReceipt((await runRuntime([
    'wait', '--session', started.session, '--timeout', '2s',
  ])).stdout);
  activeSessions.delete(started.session);
  assert.equal(waited.status, 'submitted');
  await assert.rejects(access(path.join(gateRoot, `${gateKey}.recovering`)), /ENOENT/);
});

test('a reused live PID with a stale descriptor and server is a recoverable lock owner', async () => {
  const root = path.join(testRoot, 'stale-gate-recovery');
  const config = prototypeConfig('stale-gate-recovery');
  const second = await startPrototype(root, config);
  const descriptor = await sessionDetails(second);
  const sessionBase = path.dirname(path.dirname(second.session));
  const gateRoot = path.join(sessionBase, 'submission-gates');
  const gatePath = path.join(gateRoot, `${submissionGateKey(descriptor.prototypeRoot, config.id)}.json`);
  const staleSessionId = 'e'.repeat(32);
  const staleToken = 'stale-session-token';
  const staleSessionDir = path.join(sessionBase, staleSessionId);
  await mkdir(staleSessionDir);
  await writeFile(path.join(staleSessionDir, 'session.json'), JSON.stringify({
    ...descriptor,
    sessionId: staleSessionId,
    pid: process.pid,
    token: staleToken,
    url: `http://127.0.0.1:1/review/index.html#token=${staleToken}`,
  }));
  await mkdir(gateRoot, { recursive: true });
  await writeFile(gatePath, JSON.stringify({
    schemaVersion: 1,
    sessionId: staleSessionId,
    pid: process.pid,
    prototypeRoot: descriptor.prototypeRoot,
    prototypeId: config.id,
    prototypePath: descriptor.prototypePath,
    revision: config.revision,
    tokenDigest: `sha256:${createHash('sha256').update(staleToken).digest('hex')}`,
  }));
  const replacement = feedbackFor(config, {
    verdict: 'rejected',
    selectedOptions: [],
    reason: 'The recovered submission rejects the option.',
  });
  assert.equal((await postFeedback(second, replacement)).status, 200);
  const waited = parseReceipt((await runRuntime([
    'wait', '--session', second.session, '--timeout', '2s',
  ])).stdout);
  activeSessions.delete(second.session);
  assert.equal(waited.status, 'submitted');
  assert.equal(waited.verdict, 'rejected');
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), replacement);
});

test('a live lock owner with a matching safe descriptor stays busy without session cleanup', async () => {
  const root = path.join(testRoot, 'live-gate-owner');
  const config = prototypeConfig('live-gate-owner');
  const owner = await startPrototype(root, config);
  const contender = await startPrototype(root, config);
  const descriptor = await sessionDetails(owner);
  const gateRoot = path.join(path.dirname(path.dirname(owner.session)), 'submission-gates');
  const gatePath = path.join(gateRoot, `${submissionGateKey(descriptor.prototypeRoot, config.id)}.json`);
  await mkdir(gateRoot, { recursive: true });
  await writeFile(gatePath, JSON.stringify({
    schemaVersion: 1,
    sessionId: descriptor.sessionId,
    pid: descriptor.pid,
    prototypeRoot: descriptor.prototypeRoot,
    prototypeId: descriptor.prototypeId,
    prototypePath: descriptor.prototypePath,
    revision: descriptor.revision,
    tokenDigest: `sha256:${createHash('sha256').update(descriptor.token).digest('hex')}`,
  }));

  const response = await postFeedback(contender, feedbackFor(config));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    status: 'busy',
    error: 'Another feedback submission is in progress for this Prototype',
  });
  await Promise.all([access(owner.session), access(contender.session)]);
  assert.equal(parseReceipt((await runRuntime(['status', '--session', owner.session])).stdout).status, 'ready');
  assert.equal(parseReceipt((await runRuntime(['status', '--session', contender.session])).stdout).status, 'ready');
  await rm(gatePath);
  assert.equal(parseReceipt((await runRuntime(['stop', '--session', owner.session])).stdout).status, 'stopped');
  assert.equal(parseReceipt((await runRuntime(['stop', '--session', contender.session])).stdout).status, 'stopped');
  activeSessions.delete(owner.session);
  activeSessions.delete(contender.session);
});

test('stop and wait timeout stay busy while a feedback transaction finishes as submitted', async () => {
  const root = path.join(testRoot, 'stop-submit-race');
  const config = prototypeConfig('stop-submit-race');
  const isolatedTmp = path.join(testRoot, 'stop-submit-race-tmp');
  await mkdir(isolatedTmp);
  const isolatedEnv = {
    ...runtimeEnv,
    TMPDIR: isolatedTmp,
    AW_PROTOTYPE_REVIEW_TEST_AFTER_WRITE_DELAY_MS: '1000',
  };
  const started = await startPrototype(root, config, undefined, isolatedEnv);
  const feedback = feedbackFor(config);
  const submission = postFeedback(started, feedback);
  await waitForPath(path.join(root, 'feedback.json'));

  const busyStop = await runRuntimeFailure(['stop', '--session', started.session], 1, isolatedEnv);
  assert.deepEqual(parseReceipt(busyStop.stdout), {
    ok: false,
    status: 'busy',
    error: 'Feedback submission is in progress',
  });
  const busyWait = await runRuntimeFailure([
    'wait', '--session', started.session, '--timeout', '20ms',
  ], 1, isolatedEnv);
  assert.deepEqual(parseReceipt(busyWait.stdout), {
    ok: false,
    status: 'busy',
    error: 'Feedback submission is in progress',
  });
  await access(started.session);

  assert.equal((await submission).status, 200);
  const waited = parseReceipt((await runRuntime([
    'wait', '--session', started.session, '--timeout', '2s',
  ], isolatedEnv)).stdout);
  activeSessions.delete(started.session);
  assert.equal(waited.status, 'submitted');
  assert.equal(waited.verdict, 'accepted');
  assert.equal(waited.feedbackDigest, feedbackDigest(feedback));
  assert.equal(parseReceipt((await runRuntime([
    'stop', '--session', started.session,
  ], isolatedEnv)).stdout).status, 'not-found');
});

test('stop accepted first rejects pipelined feedback without writing it', async () => {
  const root = path.join(testRoot, 'stop-first-pipeline');
  const config = prototypeConfig('stop-first-pipeline');
  const started = await startPrototype(root, config);
  const descriptor = await sessionDetails(started);
  const feedback = JSON.stringify(feedbackFor(config));
  const origin = new URL(started.url).origin;
  const headers = [
    `Host: 127.0.0.1:${new URL(started.url).port}`,
    `Origin: ${origin}`,
    `x-prototype-review-token: ${descriptor.token}`,
  ];
  const responses = await pipelineRequests(started.url, [
    `POST /api/stop HTTP/1.1\r\n${headers.join('\r\n')}\r\nContent-Length: 0\r\n\r\n`,
    `POST /api/feedback HTTP/1.1\r\n${headers.join('\r\n')}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(feedback)}\r\nConnection: close\r\n\r\n${feedback}`,
  ]);

  assert.deepEqual(responses.statuses, [200, 409]);
  assert.match(responses.raw, /\{"ok":true,"status":"cancelled"\}/);
  assert.match(
    responses.raw,
    /\{"ok":false,"status":"stopping","error":"Prototype Review session is stopping; feedback was not submitted"\}/,
  );
  await assert.rejects(access(path.join(root, 'feedback.json')), /ENOENT/);

  activeSessions.delete(started.session);
  await rm(path.dirname(started.session), { recursive: true, force: true });
});

test('status, stop, timeout, cancellation, and unreachable recovery use authenticated lifecycle calls', async () => {
  const stopped = await startPrototype(path.join(testRoot, 'stopped'), prototypeConfig('stopped'));
  assert.equal(parseReceipt((await runRuntime(['status', '--session', stopped.session])).stdout).status, 'ready');
  assert.equal(parseReceipt((await runRuntime(['stop', '--session', stopped.session])).stdout).status, 'stopped');
  activeSessions.delete(stopped.session);
  assert.equal(parseReceipt((await runRuntime(['stop', '--session', stopped.session])).stdout).status, 'not-found');

  const timed = await startPrototype(path.join(testRoot, 'timed'), prototypeConfig('timed'));
  const timeout = parseReceipt((await runRuntime([
    'wait', '--session', timed.session, '--timeout', '20ms',
  ])).stdout);
  activeSessions.delete(timed.session);
  assert.equal(timeout.status, 'timeout');
  assert.equal(parseReceipt((await runRuntime(['status', '--session', timed.session])).stdout).status, 'not-found');

  const cancelled = await startPrototype(path.join(testRoot, 'cancelled'), prototypeConfig('cancelled'));
  const waiting = spawn(process.execPath, [
    runtimeScript,
    'wait', '--session', cancelled.session, '--timeout', '5s',
  ], { env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const waitingResult = waitForExit(waiting);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const stopReceipt = parseReceipt((await runRuntime(['stop', '--session', cancelled.session])).stdout);
  assert.equal(stopReceipt.status, 'stopped');
  const cancelledResult = await waitingResult;
  activeSessions.delete(cancelled.session);
  assert.equal(cancelledResult.code, 0);
  assert.equal(parseReceipt(cancelledResult.stdout).status, 'cancelled');

  const unreachable = await startPrototype(path.join(testRoot, 'unreachable'), prototypeConfig('unreachable'));
  const unreachableDescriptor = await sessionDetails(unreachable);
  const directStop = await fetch(new URL('/api/stop', unreachable.url), {
    method: 'POST',
    headers: {
      origin: new URL(unreachable.url).origin,
      'x-prototype-review-token': unreachableDescriptor.token,
    },
  });
  assert.equal(directStop.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const unreachableStatus = parseReceipt((await runRuntime(['status', '--session', unreachable.session])).stdout);
  assert.equal(unreachableStatus.status, 'unreachable');
  const failedStop = await runRuntimeFailure(['stop', '--session', unreachable.session], 1);
  assert.equal(parseReceipt(failedStop.stdout).status, 'failed');
  await access(unreachable.session);
  activeSessions.delete(unreachable.session);
  await rm(path.dirname(unreachable.session), { recursive: true, force: true });
});

test('start rejects artifact escape, final symlinks, and physical containment escape', async () => {
  const outside = path.join(testRoot, 'outside.txt');
  await writeFile(outside, 'outside\n');

  const escapedRoot = path.join(testRoot, 'escaped-artifact');
  const escapedConfig = prototypeConfig('escaped-artifact', {
    options: [{ id: 'a', label: 'A', kind: 'text', artifact: 'brief.md' }],
  });
  const escapedPath = await writePrototype(escapedRoot, escapedConfig);
  const escaped = await runRuntimeFailure(['start', '--prototype', escapedPath], 1);
  assert.match(parseReceipt(escaped.stdout).error, /inside artifact/);

  const linkedRoot = path.join(testRoot, 'linked-artifact');
  const linkedConfig = prototypeConfig('linked-artifact', {
    options: [{ id: 'a', label: 'A', kind: 'text', artifact: 'artifact/link.txt' }],
  });
  await mkdir(path.join(linkedRoot, 'artifact'), { recursive: true });
  await symlink(outside, path.join(linkedRoot, 'artifact', 'link.txt'));
  await writeFile(path.join(linkedRoot, 'prototype.json'), `${JSON.stringify(linkedConfig)}\n`);
  const linked = await runRuntimeFailure([
    'start', '--prototype', path.join(linkedRoot, 'prototype.json'),
  ], 1);
  assert.match(parseReceipt(linked.stdout).error, /regular non-symlink file/);

  const physicalRoot = path.join(testRoot, 'physical-escape');
  const outsideDir = path.join(testRoot, 'outside-dir');
  await mkdir(path.join(physicalRoot, 'artifact'), { recursive: true });
  await mkdir(outsideDir);
  await writeFile(path.join(outsideDir, 'option.txt'), 'outside\n');
  await symlink(outsideDir, path.join(physicalRoot, 'artifact', 'linked-dir'));
  const physicalConfig = prototypeConfig('physical-escape', {
    options: [{ id: 'a', label: 'A', kind: 'text', artifact: 'artifact/linked-dir/option.txt' }],
  });
  await writeFile(path.join(physicalRoot, 'prototype.json'), `${JSON.stringify(physicalConfig)}\n`);
  const physical = await runRuntimeFailure([
    'start', '--prototype', path.join(physicalRoot, 'prototype.json'),
  ], 1);
  assert.match(parseReceipt(physical.stdout).error, /escapes artifact/);
});

test('start failure preserves a foreign replacement of its session directory', async () => {
  const root = path.join(testRoot, 'start-replaced-session');
  const config = prototypeConfig('start-replaced-session');
  const prototypePath = await writePrototype(root, config);
  const isolatedTmp = path.join(testRoot, 'start-replaced-session-tmp');
  await mkdir(isolatedTmp);
  const isolatedEnv = {
    ...runtimeEnv,
    TMPDIR: isolatedTmp,
    AW_PROTOTYPE_REVIEW_TEST_AFTER_LAUNCH_DELAY_MS: '500',
  };
  const child = spawn(process.execPath, [runtimeScript, 'start', '--prototype', prototypePath], {
    env: isolatedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = waitForExit(child);
  const base = path.join(isolatedTmp, 'agent-workflow', 'prototype-review');
  let sessionDir;
  const deadline = Date.now() + 2_000;
  while (!sessionDir && Date.now() < deadline) {
    try {
      for (const entry of await readdir(base)) {
        const candidate = path.join(base, entry);
        if (/^[a-f0-9]{32}$/.test(entry) && await access(path.join(candidate, 'start-ready')).then(() => true, () => false)) {
          sessionDir = candidate;
          break;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!sessionDir) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(sessionDir, 'expected the bound session directory and ready marker');
  const movedSessionDir = `${sessionDir}-owned`;
  await rename(sessionDir, movedSessionDir);
  await mkdir(sessionDir);
  const sentinelPath = path.join(sessionDir, 'keep.txt');
  await writeFile(sentinelPath, 'foreign sentinel\n');

  const failed = await result;
  assert.equal(failed.code, 1);
  assert.match(parseReceipt(failed.stdout).error, /physical identity changed during start/);
  assert.equal(await readFile(sentinelPath, 'utf8'), 'foreign sentinel\n');
  assert.deepEqual(await readdir(sessionDir), ['keep.txt']);

  await rm(sessionDir, { recursive: true, force: true });
  await rm(movedSessionDir, { recursive: true, force: true });
});

test('a replaced Prototype root fails closed without writing external feedback', async () => {
  const root = path.join(testRoot, 'swapped-prototype-root');
  const originalRoot = path.join(testRoot, 'swapped-prototype-original');
  const externalRoot = path.join(testRoot, 'swapped-prototype-external');
  const config = prototypeConfig('swapped-prototype-root');
  const started = await startPrototype(root, config);
  await rename(root, originalRoot);
  await writePrototype(externalRoot, config);
  const sentinelPath = path.join(externalRoot, 'keep.txt');
  await writeFile(sentinelPath, 'keep\n');
  await symlink(externalRoot, root);

  const response = await postFeedback(started, feedbackFor(config));
  assert.notEqual(response.status, 200);
  assert.match((await response.json()).error, /revision changed after this Review session started/);
  await assert.rejects(access(path.join(externalRoot, 'feedback.json')), /ENOENT/);
  assert.equal(await readFile(sentinelPath, 'utf8'), 'keep\n');
  assert.deepEqual((await readdir(externalRoot)).sort(), ['artifact', 'brief.md', 'keep.txt', 'prototype.json']);

  activeSessions.delete(started.session);
  await rm(root);
  await rm(path.dirname(started.session), { recursive: true, force: true });
});

test('a replaced session directory fails closed without deleting a foreign descriptor', async () => {
  const root = path.join(testRoot, 'swapped-session-directory');
  const config = prototypeConfig('swapped-session-directory');
  const started = await startPrototype(root, config);
  const descriptor = await sessionDetails(started);
  const originalSessionDir = `${path.dirname(started.session)}-original`;
  const externalSessionDir = path.join(testRoot, 'swapped-session-external');
  const externalSessionPath = path.join(externalSessionDir, 'session.json');
  const sentinelPath = path.join(externalSessionDir, 'keep.txt');
  await rename(path.dirname(started.session), originalSessionDir);
  await mkdir(externalSessionDir);
  const foreignDescriptor = `${JSON.stringify({ foreign: true })}\n`;
  await writeFile(externalSessionPath, foreignDescriptor);
  await writeFile(sentinelPath, 'keep\n');
  await symlink(externalSessionDir, path.dirname(started.session));
  await writePrototype(root, { ...config, revision: 2 });

  const response = await fetch(new URL('/api/feedback', started.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(started.url).origin,
      'x-prototype-review-token': descriptor.token,
    },
    body: JSON.stringify(feedbackFor(config)),
  });
  assert.notEqual(response.status, 200);
  assert.match((await response.json()).error, /session directory|physical identity/);
  assert.equal(await readFile(externalSessionPath, 'utf8'), foreignDescriptor);
  assert.equal(await readFile(sentinelPath, 'utf8'), 'keep\n');
  assert.deepEqual((await readdir(externalSessionDir)).sort(), ['keep.txt', 'session.json']);

  activeSessions.delete(started.session);
  await rm(path.dirname(started.session));
  await rm(originalSessionDir, { recursive: true, force: true });
});

test('session descriptor traversal and symlink parents cannot escape cleanup containment', async () => {
  const started = await startPrototype(
    path.join(testRoot, 'descriptor-containment'),
    prototypeConfig('descriptor-containment'),
  );
  const descriptor = await sessionDetails(started);
  const sessionBase = path.dirname(path.dirname(started.session));

  const traversalRoot = path.join(path.dirname(sessionBase), 'outside-session');
  const traversalSession = path.join(traversalRoot, 'session.json');
  const traversalSentinel = path.join(traversalRoot, 'keep.txt');
  await mkdir(traversalRoot);
  await writeFile(traversalSentinel, 'keep\n');
  await writeFile(traversalSession, JSON.stringify({
    ...descriptor,
    sessionId: '../outside-session',
  }));
  const traversal = await runRuntimeFailure(['stop', '--session', traversalSession], 1);
  assert.match(parseReceipt(traversal.stdout).error, /outside the Prototype Review temporary root/);
  await Promise.all([access(traversalSession), access(traversalSentinel)]);

  const linkedSessionId = 'f'.repeat(32);
  const linkedTarget = path.join(testRoot, 'linked-session-target');
  const linkedSession = path.join(linkedTarget, 'session.json');
  const linkedSentinel = path.join(linkedTarget, 'keep.txt');
  await mkdir(linkedTarget);
  await writeFile(linkedSentinel, 'keep\n');
  await writeFile(linkedSession, JSON.stringify({
    ...descriptor,
    sessionId: linkedSessionId,
  }));
  const linkedParent = path.join(sessionBase, linkedSessionId);
  await symlink(linkedTarget, linkedParent);
  const linked = await runRuntimeFailure(['stop', '--session', path.join(linkedParent, 'session.json')], 1);
  assert.match(parseReceipt(linked.stdout).error, /regular non-symlink directory/);
  await Promise.all([access(linkedSession), access(linkedSentinel)]);

  assert.equal(parseReceipt((await runRuntime(['status', '--session', started.session])).stdout).status, 'ready');
  assert.equal(parseReceipt((await runRuntime(['stop', '--session', started.session])).stdout).status, 'stopped');
  activeSessions.delete(started.session);
  await rm(linkedParent, { force: true });
});

test('a symlinked submission gate root fails closed without changing external files', async () => {
  const root = path.join(testRoot, 'symlinked-gate-root');
  const config = prototypeConfig('symlinked-gate-root');
  const isolatedTmp = path.join(testRoot, 'symlinked-gate-tmp');
  await mkdir(isolatedTmp);
  const isolatedEnv = { ...runtimeEnv, TMPDIR: isolatedTmp };
  const started = await startPrototype(root, config, undefined, isolatedEnv);
  const descriptor = await sessionDetails(started);
  const sessionBase = path.dirname(path.dirname(started.session));
  const gateRoot = path.join(sessionBase, 'submission-gates');
  const externalRoot = path.join(testRoot, 'external-submission-gates');
  const gateKey = submissionGateKey(descriptor.prototypeRoot, config.id);
  const sentinelPath = path.join(externalRoot, `${gateKey}.json`);
  const sentinel = 'external sentinel must not change\n';
  await mkdir(externalRoot);
  await writeFile(sentinelPath, sentinel);
  await symlink(externalRoot, gateRoot);

  const response = await postFeedback(started, feedbackFor(config));
  assert.notEqual(response.status, 200);
  assert.match((await response.json()).error, /gate root must be a regular non-symlink directory/);
  assert.equal(await readFile(sentinelPath, 'utf8'), sentinel);
  assert.deepEqual(await readdir(externalRoot), [`${gateKey}.json`]);
  assert.equal(parseReceipt((await runRuntime([
    'status', '--session', started.session,
  ], isolatedEnv)).stdout).status, 'ready');
  assert.equal(parseReceipt((await runRuntime([
    'stop', '--session', started.session,
  ], isolatedEnv)).stdout).status, 'stopped');
  activeSessions.delete(started.session);
  await rm(gateRoot, { force: true });
});

test('a symlinked recovery claim fails closed without changing its external target', async () => {
  const root = path.join(testRoot, 'symlinked-recovery-claim');
  const config = prototypeConfig('symlinked-recovery-claim');
  const isolatedTmp = path.join(testRoot, 'symlinked-recovery-tmp');
  await mkdir(isolatedTmp);
  const isolatedEnv = { ...runtimeEnv, TMPDIR: isolatedTmp };
  const started = await startPrototype(root, config, undefined, isolatedEnv);
  const descriptor = await sessionDetails(started);
  const gateRoot = path.join(path.dirname(path.dirname(started.session)), 'submission-gates');
  const gateKey = submissionGateKey(descriptor.prototypeRoot, config.id);
  const gatePath = path.join(gateRoot, `${gateKey}.json`);
  const recoveryPath = path.join(gateRoot, `${gateKey}.recovering`);
  const externalRoot = path.join(testRoot, 'external-recovery-target');
  const sentinelPath = path.join(externalRoot, 'keep.txt');
  await Promise.all([
    mkdir(gateRoot),
    mkdir(externalRoot),
  ]);
  await writeFile(sentinelPath, 'keep\n');
  await writeFile(gatePath, JSON.stringify({
    schemaVersion: 1,
    sessionId: 'c'.repeat(32),
    pid: process.pid,
    prototypeRoot: descriptor.prototypeRoot,
    prototypeId: config.id,
    prototypePath: descriptor.prototypePath,
    revision: config.revision,
    tokenDigest: `sha256:${'0'.repeat(64)}`,
  }));
  await symlink(externalRoot, recoveryPath);

  const response = await postFeedback(started, feedbackFor(config));
  assert.notEqual(response.status, 200);
  assert.match((await response.json()).error, /recovery claim must be a regular non-symlink directory/);
  assert.equal(await readFile(sentinelPath, 'utf8'), 'keep\n');
  assert.deepEqual(await readdir(externalRoot), ['keep.txt']);
  assert.equal((await lstat(recoveryPath)).isSymbolicLink(), true);

  await rm(recoveryPath);
  await rm(gatePath);
  assert.equal(parseReceipt((await runRuntime([
    'stop', '--session', started.session,
  ], isolatedEnv)).stdout).status, 'stopped');
  activeSessions.delete(started.session);
});
