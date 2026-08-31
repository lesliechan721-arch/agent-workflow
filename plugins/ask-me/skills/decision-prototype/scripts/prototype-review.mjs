#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
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
  stop    Stop a reachable session through authenticated HTTP.`;
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

function sessionBase() {
  return path.join(os.tmpdir(), 'agent-workflow', 'prototype-review');
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
      return { sessionDir, sessionId };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

function assertLocalDescriptor(value, sessionPath) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.reviewShellVersion !== reviewShellVersion
    || typeof value.sessionId !== 'string'
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
  const expectedPath = path.join(sessionBase(), value.sessionId, 'session.json');
  if (path.resolve(sessionPath) !== expectedPath) {
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
  const resolved = path.resolve(sessionPath);
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Session descriptor must be a regular non-symlink file');
  return assertLocalDescriptor(JSON.parse(await readFile(resolved, 'utf8')), resolved);
}

async function cleanupSession(sessionPath) {
  const resolved = path.resolve(sessionPath);
  await rm(resolved, { force: true });
  try {
    await rmdir(path.dirname(resolved));
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
  }
}

async function waitForStartup(child, sessionPath, errorPath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await pathExists(sessionPath)) return readSession(sessionPath);
    if (await pathExists(errorPath)) {
      const startupError = JSON.parse(await readFile(errorPath, 'utf8'));
      throw new Error(startupError.error || 'Prototype Review server failed to start');
    }
    if (child.exitCode !== null) throw new Error(`Prototype Review server exited with code ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out while starting the Prototype Review server');
}

async function startCommand(options) {
  const prototypeSchema = await readJsonSchema(prototypeSchemaPath);
  const prototype = await loadAndValidatePrototype(path.resolve(options.prototype), prototypeSchema);
  const { sessionDir, sessionId } = await createSessionDirectory();
  const sessionPath = path.join(sessionDir, 'session.json');
  const launchPath = path.join(sessionDir, 'launch.json');
  const startupErrorPath = path.join(sessionDir, 'startup-error.json');
  const token = randomBytes(32).toString('base64url');
  let child;
  try {
    await writeAtomicJson(launchPath, {
      schemaVersion: 1,
      sessionId,
      token,
      prototypePath: prototype.prototypePath,
    });
    child = spawn(process.execPath, [serverScript, '--launch', launchPath], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const descriptor = await waitForStartup(child, sessionPath, startupErrorPath);
    if (descriptor.token !== token || descriptor.sessionId !== sessionId) {
      throw new Error('Prototype Review server returned a mismatched session descriptor');
    }
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
    await rm(sessionDir, { recursive: true, force: true });
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
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `Prototype Review server returned HTTP ${response.status}`);
  }
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
  if (prototype.config.id !== descriptor.prototypeId || prototype.config.revision !== descriptor.revision) {
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
      await stopReachableSession(descriptor);
      await cleanupSession(sessionPath);
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
      await cleanupSession(sessionPath);
      return {
        ok: true,
        status: 'cancelled',
        prototypeId: descriptor.prototypeId,
        revision: descriptor.revision,
      };
    }
    if (state.status !== 'submitted') throw new Error(`Unknown Prototype Review wait status: ${state.status}`);

    const { feedback, feedbackPath } = await readSubmittedFeedback(descriptor);
    await stopReachableSession(descriptor);
    await cleanupSession(sessionPath);
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
    return {
      ok: true,
      status: state.status,
      session: sessionPath,
      url: descriptor.url,
      prototypeId: descriptor.prototypeId,
      revision: descriptor.revision,
      reviewShellVersion,
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
  await stopReachableSession(descriptor);
  await cleanupSession(sessionPath);
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
