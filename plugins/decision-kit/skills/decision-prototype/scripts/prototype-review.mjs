#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  utimes,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
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
import { resolveReviewTtl } from './review-config.mjs';
import { requestBrowserOpen } from './review-opener.mjs';

const reviewShellVersion = 2;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const prototypeSchemaPath = path.resolve(scriptDir, '..', 'assets', 'prototype.schema.json');
const feedbackSchemaPath = path.resolve(scriptDir, '..', 'assets', 'feedback.schema.json');
const serverScript = path.join(scriptDir, 'review-server.mjs');
const terminalRetentionMs = 24 * 60 * 60 * 1000;
const lockStaleMs = 30_000;

class UsageError extends Error {}

class CommandError extends Error {
  constructor(message, commandReceipt) {
    super(message);
    this.commandReceipt = commandReceipt;
  }
}

function globalHelp() {
  return `Usage:
  prototype-review.mjs start --prototype <prototype.json> [--ttl 30m] [--new-session]
  prototype-review.mjs open --session <session.json> [--timeout 10s] [--retry]
  prototype-review.mjs wait --session <session.json> [--timeout 30m]
  prototype-review.mjs status --session <session.json>
  prototype-review.mjs stop --session <session.json>

Commands:
  start   Validate and start a localhost Prototype Review session.
  open    Request the system browser and wait briefly for a page connection.
  wait    Wait for a result. A timeout ends only this wait.
  status  Read the current session status without changing it.
  stop    Stop the session and report success only after shutdown is confirmed.

Options:
  start without --ttl uses 30 minutes.
  --new-session preserves an unknown old session; it does not stop it or renew a healthy session.
  open --timeout limits only the page-connection wait; it does not wait for feedback.
  open --retry requests the browser again after the previous request has finished.
  wait defaults to 30 minutes. Allow at least 30 minutes for user feedback; avoid short polling.
  Explicit shorter wait timeouts remain available for diagnostics and tests.
  submitted receipts include validated feedbackData and the feedback file path.`;
}

function commandHelp(command) {
  const lines = {
    start: `Usage: prototype-review.mjs start --prototype <prototype.json> [--ttl 30m] [--new-session]

Without --ttl, start uses 30 minutes.
--new-session preserves an unknown old session. It does not stop it or renew a healthy session.`,
    open: `Usage: prototype-review.mjs open --session <session.json> [--timeout 10s] [--retry]

--timeout limits only the page-connection wait; it does not wait for feedback.
--retry requests the browser again after the previous request has finished.`,
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
  if (!['start', 'open', 'wait', 'status', 'stop'].includes(command)) {
    throw new UsageError(`Unknown command: ${command}`);
  }
  const values = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') values.help = true;
    else if (value === '--prototype' && command === 'start') values.prototype = argv[++index];
    else if (value === '--ttl' && command === 'start') values.ttl = argv[++index];
    else if (value === '--new-session' && command === 'start') values.newSession = true;
    else if (value === '--session' && command !== 'start') values.session = argv[++index];
    else if (value === '--timeout' && ['open', 'wait'].includes(command)) values.timeout = argv[++index];
    else if (value === '--retry' && command === 'open') values.retry = true;
    else throw new UsageError(`Unknown argument for ${command}: ${value}`);
  }
  if (values.help) return values;
  for (const [name, flag] of [
    ['prototype', '--prototype'],
    ['session', '--session'],
    ['ttl', '--ttl'],
    ['timeout', '--timeout'],
  ]) {
    if (name in values && (typeof values[name] !== 'string' || values[name].startsWith('--'))) {
      throw new UsageError(`${command} requires a value for ${flag}`);
    }
  }
  if (command === 'start' && !values.prototype) throw new UsageError('start requires --prototype');
  if (command === 'start' && values.ttl === undefined && argv.includes('--ttl')) {
    throw new UsageError('start requires a value for --ttl');
  }
  if (['open', 'wait'].includes(command) && values.timeout === undefined && argv.includes('--timeout')) {
    throw new UsageError(`${command} requires a value for --timeout`);
  }
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
    feedbackData: feedback,
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
    || ![1, 2].includes(value.schemaVersion)
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
  if (value.schemaVersion === 2) {
    if (
      typeof value.createdAt !== 'string'
      || typeof value.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(value.createdAt))
      || !Number.isFinite(Date.parse(value.expiresAt))
      || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
    ) {
      throw new Error('Invalid Prototype Review v2 session deadline');
    }
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
  return assertLocalDescriptor(JSON.parse(await readFile(location.resolved, 'utf8')), location);
}

function assertTerminal(value, location, descriptor = null) {
  if (
    !isObject(value)
    || value.schemaVersion !== 1
    || value.sessionId !== location.sessionId
    || !['submitted', 'cancelled', 'expired'].includes(value.status)
    || value.resourcesClosed !== true
    || typeof value.prototypePath !== 'string'
    || typeof value.prototypeRoot !== 'string'
    || typeof value.prototypeId !== 'string'
    || !Number.isInteger(value.revision)
    || typeof value.endedAt !== 'string'
    || !Number.isFinite(Date.parse(value.endedAt))
  ) {
    throw new Error('Invalid Prototype Review terminal receipt');
  }
  if (descriptor && (
    value.sessionId !== descriptor.sessionId
    || value.prototypePath !== descriptor.prototypePath
    || value.prototypeRoot !== descriptor.prototypeRoot
    || value.prototypeId !== descriptor.prototypeId
    || value.revision !== descriptor.revision
  )) {
    throw new Error('Prototype Review terminal receipt does not match its session');
  }
  return value;
}

async function readTerminal(sessionPath, descriptor = null, { allowMissing = true } = {}) {
  const location = localSessionLocation(sessionPath);
  let physical;
  try {
    physical = await physicalSessionLocation(location);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  const terminalPath = path.join(location.sessionDir, 'terminal.json');
  let info;
  try {
    info = await lstat(terminalPath);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Prototype Review terminal receipt must be a regular non-symlink file');
  }
  if (await realpath(terminalPath) !== path.join(physical.physicalSessionDir, 'terminal.json')) {
    throw new Error('Prototype Review terminal receipt is outside its session directory');
  }
  return assertTerminal(JSON.parse(await readFile(terminalPath, 'utf8')), location, descriptor);
}

async function readPartialSessionIdentity(sessionPath) {
  const location = localSessionLocation(sessionPath);
  let physical;
  try {
    physical = await physicalSessionLocation(location);
  } catch {
    return null;
  }
  for (const name of ['session.json', 'launch.json']) {
    const filePath = path.join(location.sessionDir, name);
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (await realpath(filePath) !== path.join(physical.physicalSessionDir, name)) continue;
      const value = JSON.parse(await readFile(filePath, 'utf8'));
      if (isObject(value) && typeof value.prototypePath === 'string') return value;
    } catch {
      // An unreadable or invalid file has no identity that this command can safely use.
    }
  }
  return null;
}

async function removeKnownSessionDirectory(sessionPath, allowedNames) {
  const location = localSessionLocation(sessionPath);
  const physical = await physicalSessionLocation(location);
  const names = await readdir(location.sessionDir);
  if (names.some((name) => !allowedNames.has(name))) return false;
  const identities = new Map();
  for (const name of names) {
    const filePath = path.join(location.sessionDir, name);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    if (await realpath(filePath) !== path.join(physical.physicalSessionDir, name)) return false;
    identities.set(name, { filePath, dev: info.dev, ino: info.ino });
  }
  for (const identity of identities.values()) {
    const current = await lstat(identity.filePath);
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.dev !== identity.dev
      || current.ino !== identity.ino
    ) return false;
  }
  for (const identity of identities.values()) await rm(identity.filePath);
  const current = await physicalSessionLocation(location);
  if (!sameSessionDirectory(current, physical)) return false;
  await rmdir(location.sessionDir);
  return true;
}

async function garbageCollectSessions() {
  const base = sessionBase();
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const cutoff = Date.now() - terminalRetentionMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const sessionPath = path.join(base, entry.name, 'session.json');
    let descriptor = null;
    try {
      descriptor = await readSession(sessionPath, { allowMissing: true });
      const terminal = await readTerminal(sessionPath, descriptor);
      if (terminal && Date.parse(terminal.endedAt) < cutoff) {
        if (descriptor && await probeListener(descriptor) !== 'closed') continue;
        await removeKnownSessionDirectory(sessionPath, new Set(['session.json', 'terminal.json']));
        continue;
      }
      if (!descriptor || !Number.isFinite(Date.parse(descriptor.createdAt))) continue;
      if (Date.parse(descriptor.createdAt) >= cutoff) continue;
      if (await probeListener(descriptor) !== 'closed') continue;
      await removeKnownSessionDirectory(sessionPath, new Set(['session.json']));
    } catch {
      // Unknown or replaced temporary state is preserved for manual recovery.
    }
  }
}

function startLockName(prototype) {
  const key = `${prototype.prototypePath}\0${prototype.config.id}\0${prototype.config.revision}`;
  return `.start-${createHash('sha256').update(key).digest('hex')}.lock`;
}

async function acquireStartLock(prototype) {
  const base = sessionBase();
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseInfo = await lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) {
    throw new Error('Prototype Review temporary root must be a regular non-symlink directory');
  }
  const physicalBase = await realpath(base);
  const lockPath = path.join(base, startLockName(prototype));
  const ownerPath = path.join(lockPath, 'owner.json');
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(ownerPath, JSON.stringify({
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const [directoryInfo, ownerInfo] = await Promise.all([lstat(lockPath), lstat(ownerPath)]);
      if (
        !directoryInfo.isDirectory()
        || directoryInfo.isSymbolicLink()
        || path.dirname(await realpath(lockPath)) !== physicalBase
        || !ownerInfo.isFile()
        || ownerInfo.isSymbolicLink()
        || await realpath(ownerPath) !== path.join(await realpath(lockPath), 'owner.json')
      ) {
        throw new Error('Prototype Review start lock physical identity is invalid');
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(ownerPath, now, now).catch(() => {});
      }, 1_000);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        try {
          const [currentDirectory, currentOwner] = await Promise.all([lstat(lockPath), lstat(ownerPath)]);
          if (
            !currentDirectory.isDirectory()
            || currentDirectory.isSymbolicLink()
            || currentDirectory.dev !== directoryInfo.dev
            || currentDirectory.ino !== directoryInfo.ino
            || !currentOwner.isFile()
            || currentOwner.isSymbolicLink()
            || currentOwner.dev !== ownerInfo.dev
            || currentOwner.ino !== ownerInfo.ino
          ) return;
          const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
          if (owner.token !== token) return;
          await rm(ownerPath);
          await rmdir(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lockInfo;
      let ownerInfo;
      try {
        lockInfo = await lstat(lockPath);
        if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) {
          throw new Error('Prototype Review start lock is not a regular directory');
        }
        ownerInfo = await lstat(ownerPath);
        if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink()) {
          throw new Error('Prototype Review start lock owner is invalid');
        }
      } catch (inspectionError) {
        if (inspectionError.code !== 'ENOENT') throw inspectionError;
      }
      if (ownerInfo && Date.now() - ownerInfo.mtimeMs > lockStaleMs) {
        try {
          const current = await lstat(ownerPath);
          if (current.dev === ownerInfo.dev && current.ino === ownerInfo.ino) {
            await rm(ownerPath);
            await rmdir(lockPath);
            continue;
          }
        } catch (recoveryError) {
          if (!['ENOENT', 'ENOTEMPTY'].includes(recoveryError.code)) throw recoveryError;
        }
      }
      if (!ownerInfo && lockInfo && Date.now() - lockInfo.mtimeMs > lockStaleMs) {
        try {
          const current = await lstat(lockPath);
          if (current.dev === lockInfo.dev && current.ino === lockInfo.ino) {
            await rmdir(lockPath);
            continue;
          }
        } catch (recoveryError) {
          if (!['ENOENT', 'ENOTEMPTY'].includes(recoveryError.code)) throw recoveryError;
        }
      }
      if (Date.now() >= deadline) throw new Error('Timed out while waiting for another Prototype Review start');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function findReusableSession(prototype, { allowUnknown }) {
  let entries;
  try {
    entries = await readdir(sessionBase(), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let conflict = null;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const sessionPath = path.join(sessionBase(), entry.name, 'session.json');
    let descriptor;
    try {
      descriptor = await readSession(sessionPath, { allowMissing: true });
    } catch {
      descriptor = null;
    }
    const identity = descriptor || await readPartialSessionIdentity(sessionPath);
    const matches = identity
      && identity.prototypePath === prototype.prototypePath
      && (identity.prototypeId === undefined || identity.prototypeId === prototype.config.id)
      && (identity.revision === undefined || identity.revision === prototype.config.revision);
    if (!matches) continue;
    if (!descriptor) {
      conflict ||= 'A matching Prototype Review session cannot be verified; use --new-session to preserve it and start another session';
      continue;
    }
    const terminal = await readTerminal(sessionPath, descriptor);
    if (terminal) continue;
    let state;
    try {
      state = await authenticatedRequest(descriptor, '/api/status', { timeoutMs: 750 });
    } catch {
      conflict ||= 'A matching Prototype Review session is unreachable; use --new-session to preserve it and start another session';
      continue;
    }
    if (state.status === 'submitted') {
      const submitted = await readSubmittedFeedback(descriptor, { allowMissing: true });
      if (submitted) return submittedReceipt(submitted.feedback, submitted.feedbackPath);
    }
    if (descriptor.schemaVersion === 2 && state.status === 'ready') {
      return {
        ok: true,
        status: 'ready',
        session: sessionPath,
        url: descriptor.url,
        prototypeId: descriptor.prototypeId,
        revision: descriptor.revision,
        reviewShellVersion,
        reused: true,
        expiresAt: state.expiresAt || descriptor.expiresAt,
      };
    }
    conflict ||= 'A matching legacy or stopping Prototype Review session must be stopped or bypassed with --new-session';
  }
  if (conflict && !allowUnknown) throw new Error(conflict);
  return null;
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
  const explicitTtlMs = options.ttl === undefined ? undefined : parseTimeout(options.ttl);
  await garbageCollectSessions();
  const releaseLock = await acquireStartLock(prototype);
  try {
    const existingReceipt = await prepareFeedbackForStart(prototype, feedbackSchema);
    if (existingReceipt) return existingReceipt;
    const reusable = await findReusableSession(prototype, { allowUnknown: options.newSession === true });
    if (reusable) return reusable;
    const ttlMs = await resolveReviewTtl({ ttlMs: explicitTtlMs });
    const { sessionDir, sessionId, location } = await createSessionDirectory();
    const sessionPath = path.join(sessionDir, 'session.json');
    const launchPath = path.join(sessionDir, 'launch.json');
    const startupErrorPath = path.join(sessionDir, 'startup-error.json');
    const token = randomBytes(32).toString('base64url');
    const ownedFiles = new Map();
    let child;
    try {
      await writeAtomicJson(launchPath, {
        schemaVersion: 2,
        reviewShellVersion,
        sessionId,
        token,
        prototypePath: prototype.prototypePath,
        ttlMs,
      });
      ownedFiles.set(launchPath, await bindOwnedSessionFile(location, launchPath));
      if (!sameSessionDirectory(await physicalSessionLocation(location), location)) {
        throw new Error('Prototype Review session directory physical identity changed during start');
      }
      const managedByTestRunner = process.env.AW_TEST_RUNNER_PROCESS_TREE === '1';
      child = spawn(process.execPath, [serverScript, '--launch', launchPath], {
        detached: !managedByTestRunner,
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
        reused: false,
        expiresAt: descriptor.expiresAt,
      };
    } catch (error) {
      if (child && child.exitCode === null) child.kill('SIGTERM');
      await cleanupFailedStart(location, ownedFiles);
      throw error;
    }
  } finally {
    await releaseLock();
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

async function readSubmittedFeedback(descriptor, { allowMissing = false } = {}) {
  const feedbackPath = path.join(descriptor.prototypeRoot, 'feedback.json');
  let info;
  try {
    info = await lstat(feedbackPath);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Submitted feedback must be a regular non-symlink file');
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
  if (await realpath(feedbackPath) !== path.join(descriptor.prototypeRoot, 'feedback.json')) {
    throw new Error('Submitted feedback is outside the physical Prototype root');
  }
  const feedback = normalizeAndValidate(
    JSON.parse(await readFile(feedbackPath, 'utf8')),
    feedbackSchema,
    'feedback',
  );
  if (
    feedback.prototypeId !== descriptor.prototypeId
    || feedback.prototypeRevision !== descriptor.revision
  ) {
    throw new Error('Submitted feedback does not match this Prototype Review session');
  }
  validateFeedbackAgainstPrototype(feedback, prototype.config, 'feedback');
  return { feedback, feedbackPath };
}

async function terminalResult(terminal, sessionPath) {
  const submitted = await readSubmittedFeedback(terminal, { allowMissing: true });
  if (submitted) return { ...submittedReceipt(submitted.feedback, submitted.feedbackPath), session: sessionPath };
  if (terminal.status === 'submitted') {
    throw new Error('Prototype Review ended as submitted, but its matching feedback is unavailable');
  }
  return {
    ok: true,
    status: terminal.status,
    session: sessionPath,
    prototypeId: terminal.prototypeId,
    revision: terminal.revision,
    endedAt: terminal.endedAt,
  };
}

function openReceipt(state, descriptor, sessionPath, status = state.status) {
  const pageConnected = state.presentation?.pageConnected === true;
  const browserAttempted = state.presentation?.openInProgress === true
    || state.presentation?.openStatus !== null && state.presentation?.openStatus !== undefined
    || ['open-requested', 'unavailable', 'failed'].includes(status);
  return {
    ok: status !== 'failed',
    status,
    session: sessionPath,
    prototypeId: descriptor.prototypeId,
    revision: descriptor.revision,
    presentation: {
      pageConnected,
      ...(browserAttempted ? { method: 'system-browser' } : {}),
    },
    ...(state.presentation?.openReason ? { reason: state.presentation.openReason } : {}),
  };
}

async function submittedOpenResult(descriptor, sessionPath) {
  const submitted = await readSubmittedFeedback(descriptor, { allowMissing: true });
  if (!submitted) throw new Error('Prototype Review reported submission without matching feedback');
  return { ...submittedReceipt(submitted.feedback, submitted.feedbackPath), session: sessionPath };
}

async function recoverOpenRequest(error, descriptor, sessionPath) {
  const submitted = await readSubmittedFeedback(descriptor, { allowMissing: true });
  if (submitted) return { ...submittedReceipt(submitted.feedback, submitted.feedbackPath), session: sessionPath };
  const terminal = await waitForTerminal(sessionPath, descriptor, 3_500);
  const recovered = await readSubmittedFeedback(descriptor, { allowMissing: true });
  if (recovered) return { ...submittedReceipt(recovered.feedback, recovered.feedbackPath), session: sessionPath };
  if (terminal) return terminalResult(terminal, sessionPath);
  throw new CommandError(error.message, {
    ok: false,
    status: 'failed',
    session: sessionPath,
    prototypeId: descriptor.prototypeId,
    revision: descriptor.revision,
  });
}

async function waitForOpenConnection(descriptor, sessionPath, timeoutMs, initialState) {
  const deadline = Date.now() + timeoutMs;
  let state = initialState;
  for (;;) {
    if (state.status === 'submitted') return submittedOpenResult(descriptor, sessionPath);
    if (['cancelled', 'expired', 'stopping'].includes(state.status)) {
      return openReceipt(state, descriptor, sessionPath);
    }
    if (state.presentation?.pageConnected === true || state.status === 'connected') {
      return openReceipt(state, descriptor, sessionPath, 'connected');
    }
    const openStatus = state.presentation?.openStatus || state.status;
    if (openStatus === 'unavailable') {
      return openReceipt(state, descriptor, sessionPath, 'unavailable');
    }
    if (openStatus === 'failed') {
      const failed = openReceipt(state, descriptor, sessionPath, 'failed');
      throw new CommandError(failed.reason || 'The system browser request failed', failed);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return openReceipt(
        state,
        descriptor,
        sessionPath,
        state.presentation?.openInProgress === true ? 'opening' : 'open-requested',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    try {
      state = await authenticatedRequest(descriptor, '/api/status', {
        timeoutMs: Math.max(100, Math.min(1_000, remaining)),
      });
    } catch (error) {
      return recoverOpenRequest(error, descriptor, sessionPath);
    }
  }
}

async function openCommand(options) {
  await garbageCollectSessions();
  const timeoutMs = parseTimeout(options.timeout || '10s');
  const sessionPath = path.resolve(options.session);
  const descriptor = await readSession(sessionPath, { allowMissing: true });
  if (!descriptor) {
    const terminal = await readTerminal(sessionPath);
    return terminal ? terminalResult(terminal, sessionPath) : { ok: true, status: 'not-found', session: sessionPath };
  }
  const submitted = await readSubmittedFeedback(descriptor, { allowMissing: true });
  if (submitted) return { ...submittedReceipt(submitted.feedback, submitted.feedbackPath), session: sessionPath };
  const terminal = await readTerminal(sessionPath, descriptor);
  if (terminal) return terminalResult(terminal, sessionPath);
  if (descriptor.schemaVersion !== 2) {
    throw new Error('open requires a Prototype Review v2 session');
  }

  let reserved;
  try {
    reserved = await authenticatedRequest(descriptor, '/api/open-reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retry: options.retry === true }),
    });
  } catch (error) {
    return recoverOpenRequest(error, descriptor, sessionPath);
  }
  if (reserved.status === 'submitted') return submittedOpenResult(descriptor, sessionPath);
  if (reserved.status === 'connected') return openReceipt(reserved, descriptor, sessionPath);
  if (reserved.status === 'unavailable') {
    return openReceipt(reserved, descriptor, sessionPath);
  }
  if (reserved.status === 'failed') {
    const failed = openReceipt(reserved, descriptor, sessionPath);
    throw new CommandError(failed.reason || 'The system browser request failed', failed);
  }
  if (['cancelled', 'expired', 'stopping'].includes(reserved.status)) {
    return openReceipt(reserved, descriptor, sessionPath);
  }
  if (['opening', 'open-requested'].includes(reserved.status)) {
    return waitForOpenConnection(descriptor, sessionPath, timeoutMs, reserved);
  }
  if (reserved.status !== 'reserved' || typeof reserved.reservation !== 'string') {
    throw new Error(`Unknown Prototype Review open status: ${reserved.status}`);
  }

  let openerResult;
  try {
    openerResult = await requestBrowserOpen(descriptor.url);
  } catch {
    openerResult = {
      status: 'failed',
      method: 'system-browser',
      reason: 'The system browser request failed unexpectedly',
    };
  }
  let completed;
  try {
    completed = await authenticatedRequest(descriptor, '/api/open-complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reservation: reserved.reservation, ...openerResult }),
    });
  } catch (error) {
    return recoverOpenRequest(error, descriptor, sessionPath);
  }
  if (completed.status === 'submitted') return submittedOpenResult(descriptor, sessionPath);
  if (['cancelled', 'expired', 'stopping'].includes(completed.status)) {
    return openReceipt(completed, descriptor, sessionPath);
  }
  if (completed.status === 'unavailable') return openReceipt(completed, descriptor, sessionPath);
  if (completed.status === 'failed') {
    const failed = openReceipt(completed, descriptor, sessionPath);
    throw new CommandError(failed.reason || 'The system browser request failed', failed);
  }
  if (completed.status === 'connected') return openReceipt(completed, descriptor, sessionPath);
  if (completed.status !== 'open-requested') {
    throw new Error(`Unknown Prototype Review open completion status: ${completed.status}`);
  }
  return waitForOpenConnection(descriptor, sessionPath, timeoutMs, completed);
}

async function waitCommand(options) {
  const timeoutMs = parseTimeout(options.timeout);
  const sessionPath = path.resolve(options.session);
  const descriptor = await readSession(sessionPath, { allowMissing: true });
  if (!descriptor) {
    const terminal = await readTerminal(sessionPath);
    return terminal ? terminalResult(terminal, sessionPath) : { ok: true, status: 'not-found', session: sessionPath };
  }
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const submitted = await readSubmittedFeedback(descriptor, { allowMissing: true });
    if (submitted) return submittedReceipt(submitted.feedback, submitted.feedbackPath);
    const terminal = await readTerminal(sessionPath, descriptor);
    if (terminal) {
      return terminalResult(terminal, sessionPath);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ok: true,
        status: 'timeout',
        prototypeId: descriptor.prototypeId,
        revision: descriptor.revision,
      };
    }
    const pollMs = Math.min(remaining, 30_000);
    let state;
    try {
      state = await authenticatedRequest(
        descriptor,
        `/api/wait?timeoutMs=${pollMs}`,
        { timeoutMs: pollMs + 2_000 },
      );
    } catch (error) {
      const recovered = await readSubmittedFeedback(descriptor, { allowMissing: true });
      if (recovered) return submittedReceipt(recovered.feedback, recovered.feedbackPath);
      const ended = await readTerminal(sessionPath, descriptor);
      if (ended) return terminalResult(ended, sessionPath);
      console.error(error.message);
      return {
        ok: true,
        status: 'unreachable',
        session: sessionPath,
        prototypeId: descriptor.prototypeId,
        revision: descriptor.revision,
      };
    }
    if (['cancelled', 'expired'].includes(state.status)) {
      const recovered = await readSubmittedFeedback(descriptor, { allowMissing: true });
      if (recovered) return submittedReceipt(recovered.feedback, recovered.feedbackPath);
      return {
        ok: true,
        status: state.status,
        session: sessionPath,
        prototypeId: descriptor.prototypeId,
        revision: descriptor.revision,
      };
    }
    if (['ready', 'stopping'].includes(state.status)) continue;
    if (state.status !== 'submitted') throw new Error(`Unknown Prototype Review wait status: ${state.status}`);
  }
}

async function statusCommand(options) {
  const sessionPath = path.resolve(options.session);
  const descriptor = await readSession(sessionPath, { allowMissing: true });
  if (!descriptor) {
    const terminal = await readTerminal(sessionPath);
    return terminal ? terminalResult(terminal, sessionPath) : { ok: true, status: 'not-found', session: sessionPath };
  }
  const submitted = await readSubmittedFeedback(descriptor, { allowMissing: true });
  if (submitted) {
    return {
      ...submittedReceipt(submitted.feedback, submitted.feedbackPath),
      session: sessionPath,
    };
  }
  const terminal = await readTerminal(sessionPath, descriptor);
  if (terminal) return terminalResult(terminal, sessionPath);
  try {
    const state = await authenticatedRequest(descriptor, '/api/status');
    if (state.status === 'submitted') {
      const recovered = await readSubmittedFeedback(descriptor);
      return { ...submittedReceipt(recovered.feedback, recovered.feedbackPath), session: sessionPath };
    }
    return {
      ok: true,
      status: state.status,
      session: sessionPath,
      url: descriptor.url,
      prototypeId: descriptor.prototypeId,
      revision: descriptor.revision,
      reviewShellVersion,
      ...(descriptor.schemaVersion === 2 ? {
        createdAt: state.createdAt || descriptor.createdAt,
        expiresAt: state.expiresAt || descriptor.expiresAt,
        ...(state.maxExpiresAt ? { maxExpiresAt: state.maxExpiresAt } : {}),
        ...(state.presentation ? { presentation: state.presentation } : {}),
      } : {}),
    };
  } catch (error) {
    const recovered = await readSubmittedFeedback(descriptor, { allowMissing: true });
    if (recovered) {
      return { ...submittedReceipt(recovered.feedback, recovered.feedbackPath), session: sessionPath };
    }
    const ended = await readTerminal(sessionPath, descriptor);
    if (ended) return terminalResult(ended, sessionPath);
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

function probeListener(descriptor, timeoutMs = 250) {
  const url = new URL(descriptor.url);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish('unknown'));
    socket.once('connect', () => finish('open'));
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
  });
}

async function waitForTerminal(sessionPath, descriptor, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const terminal = await readTerminal(sessionPath, descriptor);
    if (terminal) return terminal;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function stopCommand(options) {
  await garbageCollectSessions();
  const sessionPath = path.resolve(options.session);
  const descriptor = await readSession(sessionPath, { allowMissing: true });
  if (!descriptor) {
    const terminal = await readTerminal(sessionPath);
    return terminal
      ? { ok: true, status: 'stopped', terminalStatus: terminal.status, session: sessionPath }
      : { ok: true, status: 'not-found', session: sessionPath };
  }
  const existingTerminal = await readTerminal(sessionPath, descriptor);
  if (existingTerminal) {
    return {
      ok: true,
      status: 'stopped',
      terminalStatus: existingTerminal.status,
      prototypeId: descriptor.prototypeId,
      revision: descriptor.revision,
    };
  }
  let requested;
  try {
    requested = await stopReachableSession(descriptor);
    if (!['submitted', 'cancelled', 'expired', 'stopping'].includes(requested.status)) {
      throw new Error(`Unknown Prototype Review stop status: ${requested.status}`);
    }
  } catch (error) {
    const terminal = await waitForTerminal(sessionPath, descriptor, 3_500);
    if (terminal) {
      return {
        ok: true,
        status: 'stopped',
        terminalStatus: terminal.status,
        prototypeId: descriptor.prototypeId,
        revision: descriptor.revision,
      };
    }
    throw new CommandError(error.message, {
      ok: false,
      status: 'stop-unconfirmed',
      session: sessionPath,
      prototypeId: descriptor.prototypeId,
      revision: descriptor.revision,
    });
  }
  if (descriptor.schemaVersion === 1) {
    return {
      ok: true,
      status: 'stopping',
      session: sessionPath,
      prototypeId: descriptor.prototypeId,
      revision: descriptor.revision,
    };
  }
  const terminal = await waitForTerminal(sessionPath, descriptor, 6_000);
  if (!terminal) {
    throw new CommandError('Prototype Review shutdown could not be confirmed', {
      ok: false,
      status: 'stop-unconfirmed',
      session: sessionPath,
      prototypeId: descriptor.prototypeId,
      revision: descriptor.revision,
    });
  }
  return {
    ok: true,
    status: 'stopped',
    terminalStatus: terminal.status,
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
      open: openCommand,
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
    if (error instanceof CommandError) {
      console.error(error.message);
      receipt(error.commandReceipt);
      return 1;
    }
    console.error(error.stack || error.message);
    receipt({ ok: false, status: 'failed', error: error.message });
    return 1;
  }
}

process.exitCode = await main();
