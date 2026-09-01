#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  loadAndValidatePrototype,
  normalizeAndValidate,
  readJsonSchema,
  validateFeedbackAgainstPrototype,
} from './review-contract.mjs';

const reviewShellVersion = 2;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const prototypeSchemaPath = path.resolve(scriptDir, '..', 'assets', 'prototype.schema.json');
const feedbackSchemaPath = path.resolve(scriptDir, '..', 'assets', 'feedback.schema.json');
const serverScript = path.join(scriptDir, 'review-server.mjs');
const sessionBindings = new WeakMap();

class UsageError extends Error {}

function globalHelp() {
  return `Usage:
  prototype-review.mjs start --prototype <prototype.json>
  prototype-review.mjs wait --session <session.json> [--timeout 30m]
  prototype-review.mjs status --session <session.json>
  prototype-review.mjs stop --session <session.json>

Commands:
  start   Validate and start a localhost Prototype Review session.
  wait    Wait for submitted feedback, cancellation, or timeout.
  status  Read the current session status without changing it.
  stop    Stop the session when reachable and clean up its local descriptor.`;
}

function commandHelp(command) {
  const lines = {
    start: 'Usage: prototype-review.mjs start --prototype <prototype.json>',
    wait: 'Usage: prototype-review.mjs wait --session <session.json> [--timeout 30m]',
    status: 'Usage: prototype-review.mjs status --session <session.json>',
    stop: 'Usage: prototype-review.mjs stop --session <session.json>',
  };
  return lines[command] || globalHelp();
}

function parseCommand(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { help: true, command: null };
  }
  const command = argv[0];
  if (!['start', 'wait', 'status', 'stop'].includes(command)) {
    throw new UsageError(`Unknown command: ${command}`);
  }
  const values = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') values.help = true;
    else if (value === '--prototype' && command === 'start') values.prototype = argv[++index];
    else if (value === '--session' && command !== 'start') values.session = argv[++index];
    else if (value === '--timeout' && command === 'wait') values.timeout = argv[++index];
    else throw new UsageError(`Unknown argument for ${command}: ${value}`);
  }
  if (values.help) return values;
  if (command === 'start' && !values.prototype) throw new UsageError('start requires --prototype');
  if (command !== 'start' && !values.session) throw new UsageError(`${command} requires --session`);
  return values;
}

function parseTimeout(value = '30m') {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new UsageError(`Invalid timeout: ${value}`);
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const result = Number(match[1]) * multipliers[match[2] || 'ms'];
  if (!Number.isSafeInteger(result) || result < 0) throw new UsageError(`Invalid timeout: ${value}`);
  return result;
}

function receipt(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sessionBase() {
  return path.join(os.tmpdir(), 'agent-workflow', 'prototype-review');
}

function submittedReceipt(feedback, feedbackPath) {
  return {
    ok: true,
    status: 'submitted',
    prototypeId: feedback.prototypeId,
    revision: feedback.prototypeRevision,
    verdict: feedback.verdict,
    selectedOptionCount: feedback.selectedOptions.length,
    annotationCount: feedback.annotations.length,
    feedback: feedbackPath,
  };
}

async function prepareFeedbackForStart(prototype, feedbackSchema) {
  const feedbackPath = path.join(prototype.prototypeRoot, 'feedback.json');
  const rootInfo = await lstat(prototype.prototypeRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Prototype root must be a regular non-symlink directory');
  }
  let info;
  try {
    info = await lstat(feedbackPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Existing feedback must be a regular non-symlink file');
  }
  if (await realpath(feedbackPath) !== path.join(prototype.prototypeRoot, 'feedback.json')) {
    throw new Error('Existing feedback is outside the physical Prototype root');
  }
  const feedback = normalizeAndValidate(
    JSON.parse(await readFile(feedbackPath, 'utf8')),
    feedbackSchema,
    'feedback',
  );
  if (feedback.prototypeId !== prototype.config.id) {
    throw new Error('Existing feedback belongs to a different Prototype');
  }
  if (feedback.prototypeRevision === prototype.config.revision) {
    validateFeedbackAgainstPrototype(feedback, prototype.config, 'feedback');
    return submittedReceipt(feedback, feedbackPath);
  }
  if (feedback.prototypeRevision > prototype.config.revision) {
    throw new Error('Existing feedback belongs to a newer Prototype revision');
  }
  const currentInfo = await lstat(feedbackPath);
  const currentRootInfo = await lstat(prototype.prototypeRoot);
  if (
    !currentRootInfo.isDirectory()
    || currentRootInfo.isSymbolicLink()
    || currentRootInfo.dev !== rootInfo.dev
    || currentRootInfo.ino !== rootInfo.ino
    || !currentInfo.isFile()
    || currentInfo.isSymbolicLink()
    || currentInfo.dev !== info.dev
    || currentInfo.ino !== info.ino
    || await realpath(feedbackPath) !== path.join(prototype.prototypeRoot, 'feedback.json')
  ) {
    throw new Error('Existing feedback changed before the new Prototype revision started');
  }
  await rm(feedbackPath);
  return null;
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeAtomicJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporary, filePath);
  try {
    await chmod(filePath, 0o600);
  } catch {
    // File permissions are best effort on platforms that do not expose POSIX modes.
  }
}

async function createSessionDirectory() {
  const base = sessionBase();
  await mkdir(base, { recursive: true, mode: 0o700 });
  for (;;) {
    const sessionId = randomBytes(16).toString('hex');
    const sessionDir = path.join(base, sessionId);
    try {
      await mkdir(sessionDir, { mode: 0o700 });
      try {
        await chmod(sessionDir, 0o700);
      } catch {
        // Directory permissions are best effort on platforms that do not expose POSIX modes.
      }
      const location = localSessionLocation(path.join(sessionDir, 'session.json'));
      return { sessionDir, sessionId, location: await physicalSessionLocation(location) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

function sameSessionDirectory(left, right) {
  return left.physicalSessionDir === right.physicalSessionDir
    && left.sessionDirIdentity.dev === right.sessionDirIdentity.dev
    && left.sessionDirIdentity.ino === right.sessionDirIdentity.ino;
}

async function bindOwnedSessionFile(location, filePath) {
  const current = await physicalSessionLocation(location);
  if (!sameSessionDirectory(current, location)) {
    throw new Error('Prototype Review session directory physical identity changed during start');
  }
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Prototype Review start file must be a regular non-symlink file');
  }
  if (await realpath(filePath) !== path.join(location.physicalSessionDir, path.basename(filePath))) {
    throw new Error('Prototype Review start file is outside its bound session directory');
  }
  return { filePath, dev: info.dev, ino: info.ino };
}

async function cleanupFailedStart(location, ownedFiles) {
  let current;
  try {
    current = await physicalSessionLocation(location);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!sameSessionDirectory(current, location)) return;
  for (const owned of ownedFiles.values()) {
    let info;
    try {
      info = await lstat(owned.filePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || info.dev !== owned.dev
      || info.ino !== owned.ino
      || await realpath(owned.filePath) !== path.join(location.physicalSessionDir, path.basename(owned.filePath))
    ) continue;
    await rm(owned.filePath);
  }
  current = await physicalSessionLocation(location);
  if (!sameSessionDirectory(current, location)) return;
  try {
    await rmdir(location.sessionDir);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
  }
}

function localSessionLocation(sessionPath) {
  const resolved = path.resolve(sessionPath);
  const base = path.resolve(sessionBase());
  const sessionDir = path.dirname(resolved);
  const sessionId = path.basename(sessionDir);
  if (
    path.basename(resolved) !== 'session.json'
    || path.dirname(sessionDir) !== base
    || !/^[a-f0-9]{32}$/.test(sessionId)
  ) {
    throw new Error('Session descriptor is outside the Prototype Review temporary root');
  }
  return { base, resolved, sessionDir, sessionId };
}

async function physicalSessionLocation(location) {
  const [baseInfo, sessionDirInfo] = await Promise.all([
    lstat(location.base),
    lstat(location.sessionDir),
  ]);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) {
    throw new Error('Prototype Review temporary root must be a regular non-symlink directory');
  }
  if (!sessionDirInfo.isDirectory() || sessionDirInfo.isSymbolicLink()) {
    throw new Error('Session directory must be a regular non-symlink directory');
  }
  const [physicalBase, physicalSessionDir] = await Promise.all([
    realpath(location.base),
    realpath(location.sessionDir),
  ]);
  if (
    path.dirname(physicalSessionDir) !== physicalBase
    || path.basename(physicalSessionDir) !== location.sessionId
  ) {
    throw new Error('Session directory is outside the physical Prototype Review temporary root');
  }
  return {
    ...location,
    physicalBase,
    physicalSessionDir,
    sessionDirIdentity: { dev: sessionDirInfo.dev, ino: sessionDirInfo.ino },
  };
}

function assertLocalDescriptor(value, location) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.reviewShellVersion !== reviewShellVersion
    || typeof value.sessionId !== 'string'
    || !/^[a-f0-9]{32}$/.test(value.sessionId)
    || typeof value.token !== 'string'
    || typeof value.pid !== 'number'
    || typeof value.url !== 'string'
    || typeof value.prototypePath !== 'string'
    || typeof value.prototypeRoot !== 'string'
    || typeof value.prototypeId !== 'string'
    || !Number.isInteger(value.revision)
  ) {
    throw new Error('Invalid Prototype Review session descriptor');
  }
  if (value.sessionId !== location.sessionId) {
    throw new Error('Session descriptor is outside the Prototype Review temporary root');
  }
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error('Session descriptor URL must use localhost HTTP');
  }
  if (new URLSearchParams(url.hash.slice(1)).get('token') !== value.token) {
    throw new Error('Session descriptor URL must contain the session token fragment');
  }
  return value;
}

async function readSession(sessionPath, { allowMissing = false } = {}) {
  const location = localSessionLocation(sessionPath);
  let info;
  try {
    info = await lstat(location.resolved);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Session descriptor must be a regular non-symlink file');
  const physical = await physicalSessionLocation(location);
  if (await realpath(location.resolved) !== path.join(physical.physicalSessionDir, 'session.json')) {
    throw new Error('Session descriptor is outside the physical Prototype Review session directory');
  }
  const descriptor = assertLocalDescriptor(JSON.parse(await readFile(location.resolved, 'utf8')), location);
  sessionBindings.set(descriptor, {
    physicalSessionDir: physical.physicalSessionDir,
    sessionDirIdentity: physical.sessionDirIdentity,
    sessionPathIdentity: { dev: info.dev, ino: info.ino },
  });
  return descriptor;
}

async function cleanupSession(sessionPath, expectedDescriptor) {
  const location = localSessionLocation(sessionPath);
  const binding = sessionBindings.get(expectedDescriptor);
  if (!binding) throw new Error('Prototype Review session cleanup has no bound owner identity');
  let physical;
  try {
    physical = await physicalSessionLocation(location);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (
    physical.physicalSessionDir !== binding.physicalSessionDir
    || physical.sessionDirIdentity.dev !== binding.sessionDirIdentity.dev
    || physical.sessionDirIdentity.ino !== binding.sessionDirIdentity.ino
  ) {
    throw new Error('Prototype Review session directory physical identity changed before cleanup');
  }
  let info;
  try {
    info = await lstat(location.resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw new Error('Session descriptor must be a regular non-symlink file');
  }
  if (info) {
    try {
      if (info.dev !== binding.sessionPathIdentity.dev || info.ino !== binding.sessionPathIdentity.ino) {
        throw new Error('Prototype Review session descriptor physical identity changed before cleanup');
      }
      if (await realpath(location.resolved) !== path.join(await realpath(location.sessionDir), 'session.json')) {
        throw new Error('Session descriptor is outside the physical Prototype Review session directory');
      }
      const current = assertLocalDescriptor(JSON.parse(await readFile(location.resolved, 'utf8')), location);
      if (stableJson(current) !== stableJson(expectedDescriptor)) {
        throw new Error('Prototype Review session descriptor owner identity changed before cleanup');
      }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
  await rm(location.resolved, { force: true });
  try {
    await rmdir(location.sessionDir);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
  }
}

async function waitForStartup(child, sessionPath, errorPath, location, ownedFiles) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await pathExists(sessionPath)) {
      return readSession(sessionPath);
    }
    if (await pathExists(errorPath)) {
      ownedFiles.set(errorPath, await bindOwnedSessionFile(location, errorPath));
      const startupError = JSON.parse(await readFile(errorPath, 'utf8'));
      throw new Error(startupError.error || 'Prototype Review server failed to start');
    }
    if (child.exitCode !== null) throw new Error(`Prototype Review server exited with code ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out while starting the Prototype Review server');
}

async function startCommand(options) {
  const [prototypeSchema, feedbackSchema] = await Promise.all([
    readJsonSchema(prototypeSchemaPath),
    readJsonSchema(feedbackSchemaPath),
  ]);
  const prototype = await loadAndValidatePrototype(path.resolve(options.prototype), prototypeSchema);
  const existingReceipt = await prepareFeedbackForStart(prototype, feedbackSchema);
  if (existingReceipt) return existingReceipt;
  const { sessionDir, sessionId, location } = await createSessionDirectory();
  const sessionPath = path.join(sessionDir, 'session.json');
  const launchPath = path.join(sessionDir, 'launch.json');
  const startupErrorPath = path.join(sessionDir, 'startup-error.json');
  const token = randomBytes(32).toString('base64url');
  const ownedFiles = new Map();
  let child;
  try {
    await writeAtomicJson(launchPath, {
      schemaVersion: 1,
      sessionId,
      token,
      prototypePath: prototype.prototypePath,
    });
    ownedFiles.set(launchPath, await bindOwnedSessionFile(location, launchPath));
    if (!sameSessionDirectory(await physicalSessionLocation(location), location)) {
      throw new Error('Prototype Review session directory physical identity changed during start');
    }
    child = spawn(process.execPath, [serverScript, '--launch', launchPath], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const descriptor = await waitForStartup(child, sessionPath, startupErrorPath, location, ownedFiles);
    if (descriptor.token !== token || descriptor.sessionId !== sessionId) {
      throw new Error('Prototype Review server returned a mismatched session descriptor');
    }
    ownedFiles.set(sessionPath, await bindOwnedSessionFile(location, sessionPath));
    child.unref();
    return {
      ok: true,
      status: 'ready',
      session: sessionPath,
      url: descriptor.url,
      prototypeId: descriptor.prototypeId,
      revision: descriptor.revision,
      reviewShellVersion,
    };
  } catch (error) {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await cleanupFailedStart(location, ownedFiles);
    throw error;
  }
}

function apiUrl(descriptor, pathname) {
  return new URL(pathname, descriptor.url);
}

async function authenticatedRequest(descriptor, pathname, options = {}) {
  const { timeoutMs = 5_000, ...requestOptions } = options;
  const response = await fetch(apiUrl(descriptor, pathname), {
    ...requestOptions,
    signal: requestOptions.signal || AbortSignal.timeout(timeoutMs),
    headers: {
      ...requestOptions.headers,
      origin: new URL(descriptor.url).origin,
      'x-prototype-review-token': descriptor.token,
    },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Prototype Review server returned HTTP ${response.status} without a JSON receipt`);
  }
  if (!response.ok || body.ok === false) throw new Error(body.error || `Prototype Review server returned HTTP ${response.status}`);
  return body;
}

async function stopReachableSession(descriptor) {
  return authenticatedRequest(descriptor, '/api/stop', { method: 'POST' });
}

async function readSubmittedFeedback(descriptor) {
  const [prototypeSchema, feedbackSchema] = await Promise.all([
    readJsonSchema(prototypeSchemaPath),
    readJsonSchema(feedbackSchemaPath),
  ]);
  const prototype = await loadAndValidatePrototype(descriptor.prototypePath, prototypeSchema);
  if (
    prototype.prototypeRoot !== descriptor.prototypeRoot
    || prototype.prototypePath !== descriptor.prototypePath
    || prototype.config.id !== descriptor.prototypeId
    || prototype.config.revision !== descriptor.revision
  ) {
    throw new Error('Session Prototype identity no longer matches prototype.json');
  }
  const feedbackPath = path.join(descriptor.prototypeRoot, 'feedback.json');
  const info = await lstat(feedbackPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Submitted feedback must be a regular non-symlink file');
  const feedback = normalizeAndValidate(
    JSON.parse(await readFile(feedbackPath, 'utf8')),
    feedbackSchema,
    'feedback',
  );
  validateFeedbackAgainstPrototype(feedback, prototype.config, 'feedback');
  return { feedback, feedbackPath };
}

async function waitCommand(options) {
  const timeoutMs = parseTimeout(options.timeout);
  const sessionPath = path.resolve(options.session);
  const descriptor = await readSession(sessionPath);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      let stopped;
      try {
        stopped = await stopReachableSession(descriptor);
      } catch {
        // Timeout still owns cleanup of its local session descriptor.
      }
      if (stopped?.status === 'submitted') {
        const submitted = await readSubmittedFeedback(descriptor);
        await cleanupSession(sessionPath, descriptor);
        return submittedReceipt(submitted.feedback, submitted.feedbackPath);
      }
      await cleanupSession(sessionPath, descriptor);
      return {
        ok: true,
        status: 'timeout',
        prototypeId: descriptor.prototypeId,
        revision: descriptor.revision,
      };
    }
    const pollMs = Math.min(remaining, 30_000);
    const state = await authenticatedRequest(
      descriptor,
      `/api/wait?timeoutMs=${pollMs}`,
      { timeoutMs: pollMs + 2_000 },
    );
    if (state.status === 'ready') continue;
    if (state.status === 'cancelled') {
      await cleanupSession(sessionPath, descriptor);
      return {
        ok: true,
        status: 'cancelled',
        prototypeId: descriptor.prototypeId,
        revision: descriptor.revision,
      };
    }
    if (state.status !== 'submitted') throw new Error(`Unknown Prototype Review wait status: ${state.status}`);

    const submitted = await readSubmittedFeedback(descriptor);
    const { feedback, feedbackPath } = submitted;
    try {
      await stopReachableSession(descriptor);
    } catch {
      // Submitted feedback on disk is canonical even if the server already exited.
    }
    await cleanupSession(sessionPath, descriptor);
    return {
      ok: true,
      status: 'submitted',
      prototypeId: descriptor.prototypeId,
      revision: descriptor.revision,
      verdict: feedback.verdict,
      selectedOptionCount: feedback.selectedOptions.length,
      annotationCount: feedback.annotations.length,
      feedback: feedbackPath,
    };
  }
}

async function statusCommand(options) {
  const sessionPath = path.resolve(options.session);
  const descriptor = await readSession(sessionPath, { allowMissing: true });
  if (!descriptor) return { ok: true, status: 'not-found', session: sessionPath };
  try {
    const state = await authenticatedRequest(descriptor, '/api/status');
    let submitted;
    if (state.status === 'submitted') {
      submitted = await readSubmittedFeedback(descriptor);
    }
    return {
      ok: true,
      status: state.status,
      session: sessionPath,
      url: descriptor.url,
      prototypeId: descriptor.prototypeId,
      revision: descriptor.revision,
      reviewShellVersion,
      ...(submitted ? submittedReceipt(submitted.feedback, submitted.feedbackPath) : {}),
    };
  } catch (error) {
    console.error(error.message);
    return {
      ok: true,
      status: 'unreachable',
      session: sessionPath,
      url: descriptor.url,
      prototypeId: descriptor.prototypeId,
      revision: descriptor.revision,
      reviewShellVersion,
    };
  }
}

async function stopCommand(options) {
  const sessionPath = path.resolve(options.session);
  const descriptor = await readSession(sessionPath, { allowMissing: true });
  if (!descriptor) return { ok: true, status: 'not-found', session: sessionPath };
  try {
    await stopReachableSession(descriptor);
  } catch {
    // A local stop also cleans up a server that is already unreachable.
  }
  await cleanupSession(sessionPath, descriptor);
  return {
    ok: true,
    status: 'stopped',
    prototypeId: descriptor.prototypeId,
    revision: descriptor.revision,
  };
}

async function main() {
  let options;
  try {
    options = parseCommand(process.argv.slice(2));
    if (options.help) {
      console.log(options.command ? commandHelp(options.command) : globalHelp());
      return 0;
    }
    const handlers = {
      start: startCommand,
      wait: waitCommand,
      status: statusCommand,
      stop: stopCommand,
    };
    receipt(await handlers[options.command](options));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(options?.command ? commandHelp(options.command) : globalHelp());
      receipt({ ok: false, status: 'usage', error: error.message });
      return 2;
    }
    console.error(error.stack || error.message);
    receipt({ ok: false, status: 'failed', error: error.message });
    return 1;
  }
}

process.exitCode = await main();
