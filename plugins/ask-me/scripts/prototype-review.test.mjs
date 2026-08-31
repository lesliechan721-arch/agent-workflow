import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
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

async function runRuntime(args) {
  return execFileAsync(process.execPath, [runtimeScript, ...args], {
    env: runtimeEnv,
    timeout: 10_000,
  });
}

async function runRuntimeFailure(args, expectedCode) {
  try {
    await runRuntime(args);
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

async function startPrototype(root, config, files) {
  const prototypePath = await writePrototype(root, config, files);
  const result = await runRuntime(['start', '--prototype', prototypePath]);
  const started = parseReceipt(result.stdout);
  assert.equal(started.ok, true);
  assert.equal(started.status, 'ready');
  activeSessions.set(started.session, started.url);
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

async function stopIfActive(session) {
  try {
    await runRuntime(['stop', '--session', session]);
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
  });
  assert.deepEqual(await readJson(path.join(root, 'feedback.json')), successfulFeedback);
  await assert.rejects(access(started.session), /ENOENT/);
  await assert.rejects(access(path.join(root, 'review')), /ENOENT/);
  await assert.rejects(fetch(started.url));
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
