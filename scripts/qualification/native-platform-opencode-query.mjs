// Test-only child. The existing executePublicAw observed runner owns this
// process and server descendants, including authorized independent groups.
// This helper creates no process group or daemon.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { waitForRpcGroupExit } from './native-platform-rpc.mjs';

const deadline = performance.now() + 22_000;
const operationDeadline = deadline - 6_000;
const outputLimit = 2 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const markerEnvironmentVariable = process.platform === 'win32' ? 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER' : 'AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER';
const receipt = {
  schemaVersion: 1,
  kind: 'opencode-fixed-local-plugin-query',
  status: 'failed',
  process: {
    inheritedMarkerPresent: Boolean(process.env[markerEnvironmentVariable]),
    markerEnvironmentVariable,
    helperCreatesIndependentProcessGroup: false,
    nativeIndependentGroups: process.platform === 'win32' ? 'not-applicable; existing-outer-Windows-Job'
      : 'allowed-by-explicit-user-authorization; outer-observer-enforces-marker-and-identity',
    groupDrainBoundary: process.platform === 'win32' ? 'outer-Windows-Job; no-POSIX-group-query'
      : 'helper-original-group-only; outer-observer-requires-all-owned-descendants-exited-before-completion',
    readyObserved: false,
    activationRequested: false,
    activationResponseStatus: null,
    activationSettled: false,
    apiRequested: false,
    apiResponseStatus: null,
    stdinEofSent: false,
    serverClosed: false,
    serverExitCode: null,
    serverSignal: null,
    fallbackTermUsed: false,
    fallbackKillUsed: false,
    groupDrainChecked: false,
  },
  requests: [],
  observation: null,
  skillObservation: { status: 'unverified', reason: 'not-requested-before-core-observation', grading: 'optional; explicit-returned-content-or-location-mismatch-is-failure' },
};
let input;
let password;
let child;
let closePromise;
let inputError = false;
let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
let nativeFailureReferences = [];
let asyncFailure;
let signalFailure;
const failure = new Promise(resolve => { signalFailure = resolve; });
const latchFailure = code => {
  if (!asyncFailure) { asyncFailure = code; signalFailure(code); }
};

function redactText(value) {
  let text = value;
  if (password) {
    for (const secret of [password, `opencode:${password}`, Buffer.from(`opencode:${password}`).toString('base64')]) {
      text = text.replaceAll(secret, '<CONTROL_NONCE>');
    }
  }
  text = text.replace(/Basic\s+[A-Za-z0-9+/=]+/giu, '<BASIC_HEADER>');
  if (input?.root) text = text.replaceAll(input.root, '<TEMP_ROOT>');
  return text.replace(/\/Users\/[^/\s"']+/gu, '<HOST_HOME>');
}

function safe(value, depth = 0) {
  if (depth > 6) return '<DEPTH_LIMIT>';
  if (typeof value === 'string') return redactText(value).slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 24).map(item => safe(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [key,
    /password|authorization|credential|secret|token/iu.test(key) ? '<REDACTED>' : safe(item, depth + 1)]));
  return value;
}

function stderrEvidence() {
  // Select from the complete bounded capture before excerpt truncation. A ref
  // near the end of stderr must not disappear behind a leading-log excerpt.
  const text = redactText(stderr.toString('utf8'));
  const lines = text.split(/\r?\n/u);
  const chunks = value => {
    const result = [];
    for (let offset = 0; offset < value.length; offset += 3000) result.push(value.slice(offset, offset + 3000));
    return result;
  };
  const windows = [];
  const missingReferences = [];
  for (const ref of nativeFailureReferences.slice(0, 4)) {
    const hits = [];
    for (let index = 0; index < lines.length; index++) if (lines[index].includes(ref)) hits.push(index);
    if (!hits.length) { missingReferences.push(ref); continue; }
    const startLine = Math.max(0, hits[0] - 12);
    const endLine = Math.min(lines.length, hits[0] + 37);
    const adjacent = lines.slice(startLine, endLine).join('\n');
    const startCharacter = Math.max(0, adjacent.indexOf(ref) - 1500);
    const excerpt = adjacent.slice(startCharacter, startCharacter + 6000);
    windows.push({ ref, occurrenceCount: hits.length, matchedLine: hits[0] + 1,
      adjacentStartLine: startLine + 1, adjacentEndLine: endLine, startCharacterInWindow: startCharacter,
      excerptTruncated: startCharacter > 0 || startCharacter + excerpt.length < adjacent.length,
      chunks: chunks(excerpt) });
  }
  return {
    source: 'owned-native-server-stderr; OPENCODE_PRINT_LOGS=1; no-file-log-read',
    selection: 'exact-native-failure-ref-with-cause-neighbors; tail-if-no-reference-match',
    capturedBytes: stderr.length,
    captureLimitBytes: outputLimit,
    references: nativeFailureReferences,
    referenceLimit: 4,
    omittedReferenceCount: Math.max(0, nativeFailureReferences.length - 4),
    missingReferences,
    windows,
    fallbackTailChunks: windows.length ? [] : chunks(text.slice(-6000)),
    evidenceBoundary: windows.length ? 'matching-log-excerpt; inspect-cause; native-failure-remains-failed'
      : 'no-matching-ref-in-captured-stderr; cause-unverified; native-failure-remains-failed',
  };
}

function fail(code) { throw new Error(code); }

async function until(promise, end, code, watchFailure = true) {
  const remaining = end - performance.now();
  if (remaining <= 0) fail(code);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), Math.ceil(remaining)); }),
      ...(watchFailure ? [failure.then(reason => { throw new Error(reason); })] : []),
    ]);
  } finally { clearTimeout(timer); }
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// path.relative follows the host filesystem's path rules. Canonical real paths
// below still bind discovered files; no whole-path lowercase key is used.
function samePath(actual, expected) {
  return typeof actual === 'string' && path.isAbsolute(actual) && path.relative(expected, actual) === '';
}

async function readInput() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 32 * 1024) fail('scope-input-limit');
  }
  try { input = JSON.parse(text); } catch { fail('scope-input-invalid'); }
  if (!input || !['root', 'cwd', 'fixtureDirectory', 'executable'].every(key => typeof input[key] === 'string' && path.isAbsolute(input[key]))
    || typeof input.expectedPresent !== 'boolean' || input.nativePluginId !== 'aw-qualification-aw-qualification'
    || input.skillRelativePath !== 'skills/aw-qualification/SKILL.md'
    || typeof input.skillBase64 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.skillSha256 ?? '')
    || !/^[a-f0-9]{64}$/u.test(input.indexSha256 ?? '')) fail('scope-input-invalid');
  if (await fs.realpath(input.root) !== input.root || await fs.realpath(input.cwd) !== input.cwd
    || !within(input.root, input.cwd) || !within(input.root, input.fixtureDirectory)
    || !within(input.root, input.executable)) fail('scope-input-path-invalid');
  const expected = Buffer.from(input.skillBase64, 'base64');
  if (sha256(expected) !== input.skillSha256) fail('scope-input-skill-digest-invalid');
  if (!receipt.process.inheritedMarkerPresent) fail('scope-marker-absent');
  if (Object.hasOwn(process.env, 'OPENCODE_CONFIG_DIR')) fail('scope-config-dir-override-present');
  if (process.env.OPENCODE_PRINT_LOGS !== '1') fail('scope-print-logs-flag-absent');
  if (process.env.OPENCODE_DISABLE_MODELS_FETCH !== '1' || process.env.OPENCODE_DISABLE_AUTOUPDATE !== '1') fail('scope-offline-flags-absent');
}

function startServer() {
  password = randomBytes(32).toString('base64url');
  child = spawn(input.executable, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: input.cwd,
    env: { ...process.env, OPENCODE_PASSWORD: password },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  closePromise = new Promise(resolve => child.once('close', (code, signal) => {
    receipt.process.serverClosed = true;
    receipt.process.serverExitCode = code;
    receipt.process.serverSignal = signal;
    resolve({ code, signal });
  }));
  child.on('error', () => latchFailure('scope-server-spawn-failed'));
  child.stdin.on('error', () => { inputError = true; latchFailure('scope-server-stdin-failed'); });
  let readinessBuffer = '';
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const capture = (stream, bytes) => {
    if (stdout.length + stderr.length + bytes.length > outputLimit) { latchFailure('scope-server-output-limit'); return; }
    if (stream === 'stderr') { stderr = Buffer.concat([stderr, bytes]); return; }
    stdout = Buffer.concat([stdout, bytes]);
    if (receipt.process.readyObserved) return;
    readinessBuffer += bytes.toString('utf8');
    let newline;
    while ((newline = readinessBuffer.indexOf('\n')) >= 0) {
      const line = readinessBuffer.slice(0, newline);
      readinessBuffer = readinessBuffer.slice(newline + 1);
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row.url !== 'string') continue;
      let url;
      try { url = new URL(row.url); } catch { latchFailure('scope-ready-url-invalid'); return; }
      const port = Number(url.port);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) { latchFailure('scope-ready-url-invalid'); return; }
      receipt.process.readyObserved = true;
      resolveReady(url);
    }
  };
  child.stdout.on('data', bytes => capture('stdout', bytes));
  child.stderr.on('data', bytes => capture('stderr', bytes));
  return Promise.race([ready, closePromise.then(() => { throw new Error('scope-server-ended-before-ready'); })]);
}

async function requestPlugins(url, awaitActivation) {
  const endpoint = awaitActivation ? '/api/plugin/await-activation' : '/api/plugin';
  const method = awaitActivation ? 'POST' : 'GET';
  const expectedStatus = awaitActivation ? 204 : 200;
  const query = new URL(endpoint, url);
  query.searchParams.set('location[directory]', input.cwd);
  if (awaitActivation) receipt.process.activationRequested = true;
  else receipt.process.apiRequested = true;
  const operation = { method, endpoint, directory: safe(input.cwd), requestBody: 'none', expectedStatus,
    responseStatus: null, responseBytes: null, completed: false };
  receipt.requests.push(operation);
  let request;
  try {
    return await until(new Promise((resolve, reject) => {
      // node:http ignores proxy environment variables. Only the verified
      // loopback URL is used; redirects and non-plugin APIs are never followed.
      // Fixed v2.0.0 declares no POST payload and returns 204 No Content.
      request = http.request(query, {
        method,
        agent: false,
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, Accept: 'application/json',
          ...(awaitActivation ? { 'Content-Length': '0' } : {}) },
      }, response => {
        operation.responseStatus = response.statusCode ?? null;
        if (awaitActivation) receipt.process.activationResponseStatus = operation.responseStatus;
        else receipt.process.apiResponseStatus = operation.responseStatus;
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > outputLimit) { response.destroy(); reject(new Error('scope-api-output-limit')); return; }
          chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('scope-api-response-failed')));
        response.on('end', () => {
          operation.responseBytes = bytes;
          if (response.statusCode !== expectedStatus) { reject(new Error(awaitActivation ? 'scope-activation-status-failed' : 'scope-api-status-failed')); return; }
          if (awaitActivation) {
            if (bytes !== 0) { reject(new Error('scope-activation-body-unexpected')); return; }
            receipt.process.activationSettled = true;
            operation.completed = true;
            resolve();
            return;
          }
          try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); operation.completed = true; resolve(value); }
          catch { reject(new Error('scope-api-json-invalid')); }
        });
      });
      request.on('error', () => reject(new Error('scope-api-request-failed')));
      request.end();
    }), operationDeadline, awaitActivation ? 'scope-activation-timeout' : 'scope-api-timeout');
  } finally { request?.destroy(); }
}

async function observeNativeSkill(url) {
  const query = new URL('/api/skill', url);
  query.searchParams.set('location[directory]', input.cwd);
  const operation = { method: 'GET', endpoint: '/api/skill', directory: safe(input.cwd), requestBody: 'none',
    optionalObservation: true, expectedStatus: 200, responseStatus: null, responseBytes: null, completed: false };
  receipt.requests.push(operation);
  const observation = {
    status: 'unverified', reason: 'query-not-completed', httpStatus: null, matchCount: null, nativeMatches: [],
    evidence: 'fixed-v2.0.0-GET-skill-registry; no-model-adoption-claim',
    grading: 'missing-or-unavailable-is-nonblocking; explicit-AW-location-or-content-mismatch-fails',
  };
  receipt.skillObservation = observation;
  let request;
  let result;
  try {
    result = await until(new Promise((resolve, reject) => {
      request = http.request(query, {
        method: 'GET', agent: false,
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, Accept: 'application/json' },
      }, response => {
        operation.responseStatus = response.statusCode ?? null;
        observation.httpStatus = operation.responseStatus;
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > outputLimit) { response.destroy(); reject(new Error('scope-skill-api-output-limit')); return; }
          chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('scope-skill-api-response-unavailable')));
        response.on('end', () => {
          operation.responseBytes = bytes;
          operation.completed = true;
          if (response.statusCode !== 200) { resolve({ unavailable: 'http-status' }); return; }
          try { resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { resolve({ unavailable: 'response-json-invalid' }); }
        });
      });
      request.on('error', () => reject(new Error('scope-skill-api-request-unavailable')));
      request.end();
    }), operationDeadline, 'scope-skill-api-timeout');
  } catch (error) {
    // Availability is optional. The shared deadline and the outer process
    // observer remain mandatory, including failures during this extra read.
    if (asyncFailure) throw new Error(asyncFailure);
    if (error?.message === 'scope-skill-api-timeout' || performance.now() >= operationDeadline) fail('scope-skill-api-timeout');
    observation.reason = ['scope-skill-api-output-limit', 'scope-skill-api-response-unavailable', 'scope-skill-api-request-unavailable'].includes(error?.message)
      ? error.message : 'skill-query-unavailable';
    return;
  } finally { request?.destroy(); }
  if (result.unavailable) { observation.reason = result.unavailable; return; }
  const response = result.value;
  if (!response || !Array.isArray(response.data)) { observation.reason = 'response-shape-invalid'; return; }
  const matches = response.data.filter(item => item?.id === 'aw-qualification' || item?.name === 'aw-qualification');
  observation.matchCount = matches.length;
  observation.locationMatchesRequestedCwd = samePath(response.location?.directory, input.cwd);
  observation.nativeMatches = matches.map(item => ({
    id: typeof item.id === 'string' ? safe(item.id) : null,
    name: typeof item.name === 'string' ? safe(item.name) : null,
    description: typeof item.description === 'string' ? safe(item.description) : null,
    location: typeof item.location === 'string' ? safe(item.location) : null,
    locationSha256: typeof item.location === 'string' ? sha256(item.location) : null,
    contentSha256: typeof item.content === 'string' ? sha256(item.content) : null,
    contentByteLength: typeof item.content === 'string' ? Buffer.byteLength(item.content) : null,
  }));
  if (!matches.length) { observation.reason = 'AW-fixture-not-listed; background-discovery-or-loading-unverified'; return; }
  const expectedText = Buffer.from(input.skillBase64, 'base64').toString('utf8');
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(expectedText);
  if (!frontmatter) fail('scope-input-skill-frontmatter-invalid');
  const expectedContent = expectedText.slice(frontmatter[0].length);
  const expectedLocation = path.join(input.fixtureDirectory, input.skillRelativePath);
  const item = matches[0];
  observation.expectedLocation = safe(expectedLocation);
  observation.expectedLocationSha256 = sha256(expectedLocation);
  observation.expectedContentSha256 = sha256(expectedContent);
  observation.locationExactMatch = samePath(item.location, expectedLocation)
    && await fs.realpath(item.location) === await fs.realpath(expectedLocation);
  observation.contentExactMatch = item.content === expectedContent;
  if (matches.length !== 1 || !observation.locationMatchesRequestedCwd || item.id !== 'aw-qualification' || item.name !== 'aw-qualification'
    || !observation.locationExactMatch || !observation.contentExactMatch) {
    observation.status = 'failed';
    observation.reason = 'explicit-AW-registry-entry-does-not-match-current-projection';
    fail('scope-native-skill-registry-mismatch');
  }
  observation.status = 'observed';
  observation.reason = 'current-AW-location-and-body-exactly-observed; model-adoption-unverified';
}

async function observe(response) {
  if (!response || !samePath(response.location?.directory, input.cwd) || !Array.isArray(response.data)) fail('scope-api-shape-or-location-invalid');
  const matches = response.data.filter(item => item?.id === input.nativePluginId || item?.source?.type === 'local'
    && [input.fixtureDirectory, path.join(input.fixtureDirectory, 'index.mjs')].some(expected => samePath(item.source.path, expected)));
  const summarize = item => ({
    ...(item.id === undefined ? {} : { id: safe(item.id) }),
    source: { type: item.source?.type ?? null, path: typeof item.source?.path === 'string' && within(input.root, item.source.path) ? safe(item.source.path) : '<UNEXPECTED_PATH>' },
    state: safe(item.state),
  });
  const failedRows = response.data.filter(item => item?.state?.status === 'failed');
  nativeFailureReferences = [...new Set([...matches, ...failedRows]
    .filter(item => item?.state?.status === 'failed' && /^err_[a-f0-9]{8}$/u.test(item.state.ref ?? ''))
    .map(item => item.state.ref))];
  receipt.observation = {
    location: { directory: safe(response.location.directory), matchesRequestedCwd: true },
    expectedPresent: input.expectedPresent,
    nativeMatches: matches.map(summarize),
    nativeFailedRows: failedRows.map(summarize),
    nativeFailedRowCount: failedRows.length,
    nativeFailedRowsOmittedByOutputBound: Math.max(0, failedRows.length - 24),
    nativeFailureReferences,
    pluginCount: response.data.length,
    skillBytes: null,
  };
  if (!input.expectedPresent) {
    if (matches.length !== 0) fail('scope-fixture-unexpectedly-present');
    return;
  }
  if (matches.length !== 1) fail('scope-fixture-match-count-invalid');
  const item = matches[0];
  if (item.source?.type !== 'local' || ![input.fixtureDirectory, path.join(input.fixtureDirectory, 'index.mjs')].some(expected => samePath(item.source.path, expected))) fail('scope-fixture-source-mismatch');
  if (item.id !== undefined && item.id !== input.nativePluginId) fail('scope-fixture-id-mismatch');
  if (item.state?.status === 'failed') fail('scope-fixture-plugin-failed');
  if (item.state?.status !== 'active') fail('scope-fixture-state-invalid');
  const source = await fs.realpath(item.source.path);
  const sourceDirectory = source === input.fixtureDirectory ? source : path.dirname(source);
  if (sourceDirectory !== input.fixtureDirectory || await fs.realpath(input.fixtureDirectory) !== input.fixtureDirectory) fail('scope-fixture-source-realpath-mismatch');
  const skillPath = path.join(sourceDirectory, input.skillRelativePath);
  if (await fs.realpath(skillPath) !== skillPath || !(await fs.lstat(skillPath)).isFile()) fail('scope-native-skill-path-invalid');
  const actual = await fs.readFile(skillPath);
  const expected = Buffer.from(input.skillBase64, 'base64');
  const entryBytes = await fs.readFile(path.join(sourceDirectory, 'index.mjs'));
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(actual.toString('utf8'));
  if (!frontmatter) fail('scope-native-skill-frontmatter-invalid');
  receipt.observation.skillBytes = {
    sourcePathForm: source === input.fixtureDirectory ? 'directory' : 'index.mjs',
    path: safe(skillPath),
    sha256: sha256(actual),
    projectedSha256: input.skillSha256,
    bodySha256: sha256(Buffer.from(actual.toString('utf8').slice(frontmatter[0].length))),
    entrySha256: sha256(entryBytes),
    projectedEntrySha256: input.indexSha256,
    exactMatch: actual.equals(expected),
    byteLength: actual.length,
    evidence: 'current-SKILL.md-at-native-inventory-source',
  };
  if (!actual.equals(expected)) fail('scope-native-skill-bytes-mismatch');
  if (sha256(entryBytes) !== input.indexSha256) fail('scope-native-entry-bytes-mismatch');
}

async function stopAfterFailure() {
  if (!child || receipt.process.serverClosed) return;
  receipt.process.fallbackTermUsed = true;
  child.kill('SIGTERM');
  try { await until(closePromise, Math.min(deadline - 700, performance.now() + 600), 'scope-server-term-timeout', false); }
  catch {
    if (!receipt.process.serverClosed) {
      receipt.process.fallbackKillUsed = true;
      child.kill('SIGKILL');
      await until(closePromise, deadline - 300, 'scope-server-kill-timeout', false);
    }
  }
}

try {
  await until(readInput(), operationDeadline, 'scope-input-timeout');
  const url = await until(startServer(), operationDeadline, 'scope-ready-timeout');
  // Both requests share the original operation and absolute helper deadlines.
  // Await completion does not imply that any particular plugin succeeded.
  await requestPlugins(url, true);
  const response = await requestPlugins(url, false);
  let observationError;
  try {
    await until(observe(response), operationDeadline, 'scope-native-observation-timeout');
    if (input.expectedPresent) await observeNativeSkill(url);
    else receipt.skillObservation.reason = 'not-requested; core-fixture-expected-absent-in-this-cwd';
  } catch (error) { observationError = error; }
  finally {
    receipt.process.stdinEofSent = true;
    child.stdin.end();
  }
  const closed = await until(closePromise, deadline - 2_000, 'scope-server-eof-timeout');
  if (closed.code !== 0 || closed.signal !== null || inputError) fail('scope-server-eof-exit-invalid');
  if (process.platform !== 'win32') {
    await waitForRpcGroupExit(deadline);
    receipt.process.groupDrainChecked = true;
  }
  if (asyncFailure) fail(asyncFailure);
  if (observationError) throw observationError;
  receipt.status = 'passed';
} catch (error) {
  receipt.reason = /^scope-[a-z-]+$/u.test(error?.message) ? error.message
    : /^rpc-[a-z-]+$/u.test(error?.message) ? error.message : 'scope-query-failed';
  try {
    if (child && !receipt.process.stdinEofSent) {
      receipt.process.stdinEofSent = true;
      child.stdin.end();
    }
    await stopAfterFailure();
    if (child && process.platform !== 'win32') {
      await waitForRpcGroupExit(deadline);
      receipt.process.groupDrainChecked = true;
    }
  } catch (cleanupError) {
    receipt.cleanupReason = /^scope-[a-z-]+$|^rpc-[a-z-]+$/u.test(cleanupError?.message) ? cleanupError.message : 'scope-cleanup-failed';
  }
  process.exitCode = 1;
} finally {
  if (receipt.status !== 'passed' || nativeFailureReferences.length) {
    receipt.serverOutput = { stdout: safe(stdout.toString('utf8')).slice(0, 2000), stderr: stderrEvidence() };
  }
  receipt.outputBytes = { stdout: stdout.length, stderr: stderr.length };
  process.stdout.write(JSON.stringify(safe(receipt)) + '\n');
}
