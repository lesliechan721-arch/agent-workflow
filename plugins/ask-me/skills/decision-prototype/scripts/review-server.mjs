#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  loadAndValidatePrototype,
  normalizeAndValidate,
  readJsonSchema,
  validateFeedbackAgainstPrototype,
} from './review-contract.mjs';

const maxBodyBytes = 2 * 1024 * 1024;
const reviewShellVersion = 2;
const revisionSubmittedError = 'Feedback was already submitted by another Prototype Review session for this revision';
const staleRevisionError = 'Prototype revision changed after this Review session started';
const submissionBusyError = 'Another feedback submission is in progress for this Prototype';
const shellFiles = new Set(['app.js', 'index.html', 'review-policy.mjs', 'styles.css']);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--launch') result.launch = argv[++index];
    else if (value === '--help' || value === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
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

function feedbackDigest(feedback) {
  return `sha256:${createHash('sha256').update(stableJson(feedback)).digest('hex')}`;
}

function processIsReachable(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function physicalIdentity(info, physicalPath) {
  return { dev: info.dev, ino: info.ino, physicalPath };
}

async function assertPhysicalNode(filePath, expected, kind, label) {
  const info = await lstat(filePath);
  if (!info[kind]() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink ${kind === 'isFile' ? 'file' : 'directory'}`);
  }
  if (
    info.dev !== expected.dev
    || info.ino !== expected.ino
    || await realpath(filePath) !== expected.physicalPath
  ) {
    throw new Error(`${label} physical identity changed after the Review session started`);
  }
  return info;
}

async function readRegularJson(filePath, label) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeAtomicJson(filePath, value, { compact = false } = {}) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, compact ? JSON.stringify(value) : `${JSON.stringify(value, null, 2)}\n`, {
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

async function resolveArtifact(urlPath, artifactRoot, physicalArtifactRoot) {
  let relative;
  try {
    relative = decodeURIComponent(urlPath.slice('/artifact/'.length));
  } catch {
    throw new HttpError(400, 'Invalid artifact path encoding');
  }
  const target = path.resolve(artifactRoot, relative);
  if (!isInside(artifactRoot, target)) throw new HttpError(404, 'Artifact not found');
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, 'Artifact not found');
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(404, 'Artifact not found');
  const physicalTarget = await realpath(target);
  if (!isInside(physicalArtifactRoot, physicalTarget)) throw new HttpError(404, 'Artifact not found');
  return physicalTarget;
}

async function resolveShellFile(shellRoot, name) {
  if (!shellFiles.has(name)) throw new HttpError(404, 'Review Shell asset not found');
  const target = path.join(shellRoot, name);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(404, 'Review Shell asset not found');
  const physicalTarget = await realpath(target);
  if (!isInside(shellRoot, physicalTarget)) throw new HttpError(404, 'Review Shell asset not found');
  return physicalTarget;
}

async function receiveJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new HttpError(413, 'Feedback exceeds 2 MiB');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Feedback must be valid JSON');
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function serveFile(request, response, filePath) {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

function assertApiRequest(request, token, origin) {
  if (request.headers.origin !== origin) {
    throw new HttpError(403, 'Invalid Prototype Review origin');
  }
  if (request.headers['x-prototype-review-token'] !== token) {
    throw new HttpError(403, 'Invalid Prototype Review session');
  }
}

async function startServer(launchPath) {
  const launch = await readRegularJson(launchPath, 'Launch descriptor');
  if (
    !isObject(launch)
    || typeof launch.sessionId !== 'string'
    || !/^[a-f0-9]{32}$/.test(launch.sessionId)
    || typeof launch.token !== 'string'
    || typeof launch.prototypePath !== 'string'
  ) {
    throw new Error('Invalid launch descriptor');
  }
  const sessionDir = await realpath(path.dirname(launchPath));
  const sessionBase = path.dirname(sessionDir);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const shellRoot = await realpath(path.resolve(scriptDir, '..', 'assets', 'review-shell'));
  const [prototypeSchema, feedbackSchema] = await Promise.all([
    readJsonSchema(path.resolve(scriptDir, '..', 'assets', 'prototype.schema.json')),
    readJsonSchema(path.resolve(scriptDir, '..', 'assets', 'feedback.schema.json')),
  ]);
  const prototype = await loadAndValidatePrototype(launch.prototypePath, prototypeSchema);
  const feedbackPath = path.join(prototype.prototypeRoot, 'feedback.json');
  const sessionPath = path.join(sessionDir, 'session.json');
  const gateRoot = path.join(sessionBase, 'submission-gates');
  const [prototypeRootInfo, prototypePathInfo, artifactRootInfo, sessionBaseInfo, sessionDirInfo] = await Promise.all([
    lstat(prototype.prototypeRoot),
    lstat(prototype.prototypePath),
    lstat(prototype.artifactRoot),
    lstat(sessionBase),
    lstat(sessionDir),
  ]);
  const [
    prototypeRootIdentity,
    prototypePathIdentity,
    artifactRootIdentity,
    sessionBaseIdentity,
    sessionDirIdentity,
  ] = await Promise.all([
    realpath(prototype.prototypeRoot).then((physical) => physicalIdentity(prototypeRootInfo, physical)),
    realpath(prototype.prototypePath).then((physical) => physicalIdentity(prototypePathInfo, physical)),
    realpath(prototype.artifactRoot).then((physical) => physicalIdentity(artifactRootInfo, physical)),
    realpath(sessionBase).then((physical) => physicalIdentity(sessionBaseInfo, physical)),
    realpath(sessionDir).then((physical) => physicalIdentity(sessionDirInfo, physical)),
  ]);
  const gateKey = createHash('sha256').update(stableJson({
    prototypeRoot: prototype.prototypeRoot,
    prototypeId: prototype.config.id,
  })).digest('hex');
  const gatePath = path.join(gateRoot, `${gateKey}.json`);
  const recoveryPath = path.join(gateRoot, `${gateKey}.recovering`);
  const recoveryOwnerName = 'owner.json';
  const gateOwner = {
    schemaVersion: 1,
    sessionId: launch.sessionId,
    pid: process.pid,
    prototypeRoot: prototype.prototypeRoot,
    prototypeId: prototype.config.id,
    prototypePath: prototype.prototypePath,
    revision: prototype.config.revision,
    tokenDigest: `sha256:${createHash('sha256').update(launch.token).digest('hex')}`,
  };
  const waiters = new Set();
  let submittedFeedback = null;
  let submittedFeedbackDigest = null;
  let submissionInProgress = false;
  let ownsSubmissionGate = false;
  let stopping = false;
  let sessionDescriptor = null;
  let sessionPathIdentity = null;

  async function assertPrototypeIdentity() {
    await assertPhysicalNode(prototype.prototypeRoot, prototypeRootIdentity, 'isDirectory', 'Prototype root');
    await assertPhysicalNode(prototype.prototypePath, prototypePathIdentity, 'isFile', 'Prototype config');
    await assertPhysicalNode(prototype.artifactRoot, artifactRootIdentity, 'isDirectory', 'Prototype artifact root');
    if (
      path.dirname(prototype.prototypePath) !== prototype.prototypeRoot
      || path.dirname(prototype.artifactRoot) !== prototype.prototypeRoot
    ) {
      throw new Error('Prototype runtime paths are outside the bound Prototype root');
    }
  }

  async function assertSessionBaseIdentity() {
    await assertPhysicalNode(sessionBase, sessionBaseIdentity, 'isDirectory', 'Prototype Review temporary root');
  }

  async function assertSessionDirectoryIdentity() {
    await assertSessionBaseIdentity();
    await assertPhysicalNode(sessionDir, sessionDirIdentity, 'isDirectory', 'Prototype Review session directory');
    if (
      path.dirname(sessionDir) !== sessionBase
      || path.basename(sessionDir) !== launch.sessionId
      || path.dirname(sessionDirIdentity.physicalPath) !== sessionBaseIdentity.physicalPath
      || path.basename(sessionDirIdentity.physicalPath) !== launch.sessionId
    ) {
      throw new Error('Prototype Review session directory is outside its bound temporary root');
    }
  }

  async function validatedFeedbackFile({ allowMissing = false } = {}) {
    await assertPrototypeIdentity();
    if (path.dirname(feedbackPath) !== prototype.prototypeRoot || path.basename(feedbackPath) !== 'feedback.json') {
      throw new Error('Submitted feedback is outside the bound Prototype root');
    }
    let info;
    try {
      info = await lstat(feedbackPath);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Submitted feedback must be a regular non-symlink file');
    }
    if (await realpath(feedbackPath) !== path.join(prototypeRootIdentity.physicalPath, 'feedback.json')) {
      throw new Error('Submitted feedback is outside the physical Prototype root');
    }
    return feedbackPath;
  }

  async function writeFeedback(feedback) {
    await validatedFeedbackFile({ allowMissing: true });
    await writeAtomicJson(feedbackPath, feedback);
    await validatedFeedbackFile();
  }

  async function validatedOwnedSessionFile({ allowMissing = false } = {}) {
    await assertSessionDirectoryIdentity();
    if (path.dirname(sessionPath) !== sessionDir || path.basename(sessionPath) !== 'session.json') {
      throw new Error('Prototype Review session descriptor is outside its bound session directory');
    }
    let info;
    try {
      info = await lstat(sessionPath);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!sessionPathIdentity || !sessionDescriptor) {
      throw new Error('Prototype Review session descriptor ownership is not bound');
    }
    await assertPhysicalNode(sessionPath, sessionPathIdentity, 'isFile', 'Prototype Review session descriptor');
    if (await realpath(sessionPath) !== path.join(sessionDirIdentity.physicalPath, 'session.json')) {
      throw new Error('Prototype Review session descriptor is outside its bound session directory');
    }
    const current = await readRegularJson(sessionPath, 'Prototype Review session descriptor');
    if (stableJson(current) !== stableJson(sessionDescriptor)) {
      throw new Error('Prototype Review session descriptor owner identity changed');
    }
    return sessionPath;
  }

  function notifyWaiters(status, extra = {}) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      sendJson(waiter.response, 200, { ok: true, status, ...extra });
    }
    waiters.clear();
  }

  async function submittedFeedbackMatchesDisk() {
    if (!submittedFeedback || !submittedFeedbackDigest) return false;
    try {
      const feedback = normalizeAndValidate(
        await readRegularJson(await validatedFeedbackFile(), 'Submitted feedback'),
        feedbackSchema,
        'feedback',
      );
      validateFeedbackAgainstPrototype(feedback, prototype.config, 'feedback');
      return feedbackDigest(feedback) === submittedFeedbackDigest
        && stableJson(feedback) === stableJson(submittedFeedback);
    } catch {
      return false;
    }
  }

  async function readCanonicalFeedback() {
    let value;
    try {
      const validatedFeedbackPath = await validatedFeedbackFile({ allowMissing: true });
      if (!validatedFeedbackPath) return null;
      value = await readRegularJson(validatedFeedbackPath, 'Submitted feedback');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const feedback = normalizeAndValidate(value, feedbackSchema, 'feedback');
    if (feedback.prototypeId !== prototype.config.id) {
      throw new Error('Existing feedback belongs to a different Prototype');
    }
    return feedback;
  }

  async function currentPrototypeMatchesSession() {
    try {
      await assertPrototypeIdentity();
      const current = await loadAndValidatePrototype(prototype.prototypePath, prototypeSchema);
      await assertPrototypeIdentity();
      return current.prototypeRoot === prototype.prototypeRoot
        && current.prototypePath === prototype.prototypePath
        && current.physicalArtifactRoot === prototype.physicalArtifactRoot
        && current.config.id === prototype.config.id
        && current.config.revision === prototype.config.revision;
    } catch {
      return false;
    }
  }

  async function waitForSubmissionTestSeam() {
    const delayMs = Number(process.env.AW_PROTOTYPE_REVIEW_TEST_AFTER_WRITE_DELAY_MS || '0');
    if (Number.isInteger(delayMs) && delayMs > 0 && delayMs <= 5_000) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async function validatedGateRoot({ create = false } = {}) {
    await assertSessionBaseIdentity();
    if (path.dirname(gateRoot) !== sessionBase || path.basename(gateRoot) !== 'submission-gates') {
      throw new Error('Prototype submission gate root is outside the session temporary root');
    }
    if (create) {
      try {
        await mkdir(gateRoot, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const info = await lstat(gateRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Prototype submission gate root must be a regular non-symlink directory');
    }
    const [physicalSessionBase, physicalGateRoot] = await Promise.all([
      realpath(sessionBase),
      realpath(gateRoot),
    ]);
    if (
      physicalSessionBase !== sessionBaseIdentity.physicalPath
      || path.dirname(physicalGateRoot) !== physicalSessionBase
      || path.basename(physicalGateRoot) !== 'submission-gates'
    ) {
      throw new Error('Prototype submission gate root is outside the physical session temporary root');
    }
    return physicalGateRoot;
  }

  function validatedGatePaths(root) {
    if (!/^[a-f0-9]{64}$/.test(gateKey)) throw new Error('Invalid Prototype submission gate key');
    const validatedGatePath = path.join(root, `${gateKey}.json`);
    const validatedRecoveryPath = path.join(root, `${gateKey}.recovering`);
    if (
      path.dirname(validatedGatePath) !== root
      || path.dirname(validatedRecoveryPath) !== root
      || validatedGatePath !== gatePath
      || validatedRecoveryPath !== recoveryPath
    ) {
      throw new Error('Prototype submission gate path is outside its validated root');
    }
    return { validatedGatePath, validatedRecoveryPath };
  }

  async function validatedGateFile(root, { allowMissing = false } = {}) {
    const { validatedGatePath } = validatedGatePaths(root);
    let info;
    try {
      info = await lstat(validatedGatePath);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Prototype submission gate must be a regular non-symlink file');
    }
    const physicalGatePath = await realpath(validatedGatePath);
    if (
      path.dirname(physicalGatePath) !== root
      || path.basename(physicalGatePath) !== `${gateKey}.json`
    ) {
      throw new Error('Prototype submission gate is outside its validated root');
    }
    return validatedGatePath;
  }

  async function validatedRecoveryDirectory(root, { allowMissing = false } = {}) {
    const { validatedRecoveryPath } = validatedGatePaths(root);
    let info;
    try {
      info = await lstat(validatedRecoveryPath);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Prototype submission recovery claim must be a regular non-symlink directory');
    }
    const physicalRecoveryPath = await realpath(validatedRecoveryPath);
    if (
      path.dirname(physicalRecoveryPath) !== root
      || path.basename(physicalRecoveryPath) !== `${gateKey}.recovering`
    ) {
      throw new Error('Prototype submission recovery claim is outside its validated root');
    }
    return validatedRecoveryPath;
  }

  async function validatedRecoveryOwnerFile(root, { allowMissing = false } = {}) {
    const validatedRecoveryPath = await validatedRecoveryDirectory(root);
    const ownerPath = path.join(validatedRecoveryPath, recoveryOwnerName);
    let info;
    try {
      info = await lstat(ownerPath);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Prototype submission recovery owner must be a regular non-symlink file');
    }
    if (await realpath(ownerPath) !== path.join(await realpath(validatedRecoveryPath), recoveryOwnerName)) {
      throw new Error('Prototype submission recovery owner is outside its validated claim');
    }
    return ownerPath;
  }

  async function createSubmissionGate() {
    const root = await validatedGateRoot({ create: true });
    const { validatedGatePath } = validatedGatePaths(root);
    const temporary = path.join(root, `.${gateKey}.${launch.sessionId}.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify(gateOwner), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await link(temporary, validatedGatePath);
      ownsSubmissionGate = true;
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  function gateOwnerMatchesPrototype(owner) {
    return isObject(owner)
      && owner.schemaVersion === 1
      && /^[a-f0-9]{32}$/.test(owner.sessionId)
      && Number.isInteger(owner.pid)
      && owner.pid > 0
      && owner.prototypeRoot === prototype.prototypeRoot
      && owner.prototypeId === prototype.config.id
      && owner.prototypePath === prototype.prototypePath
      && Number.isInteger(owner.revision)
      && /^sha256:[a-f0-9]{64}$/.test(owner.tokenDigest);
  }

  async function gateOwnerIsReachable(owner) {
    try {
      if (!gateOwnerMatchesPrototype(owner) || !processIsReachable(owner.pid)) return false;

      await assertSessionBaseIdentity();
      const ownerSessionDir = path.join(sessionBase, owner.sessionId);
      const ownerSessionPath = path.join(ownerSessionDir, 'session.json');
      const sessionDirInfo = await lstat(ownerSessionDir);
      if (!sessionDirInfo.isDirectory() || sessionDirInfo.isSymbolicLink()) return false;
      const [physicalSessionBase, physicalOwnerSessionDir] = await Promise.all([
        realpath(sessionBase),
        realpath(ownerSessionDir),
      ]);
      if (
        path.dirname(physicalOwnerSessionDir) !== physicalSessionBase
        || path.basename(physicalOwnerSessionDir) !== owner.sessionId
      ) return false;
      const ownerSessionInfo = await lstat(ownerSessionPath);
      if (!ownerSessionInfo.isFile() || ownerSessionInfo.isSymbolicLink()) return false;
      if (await realpath(ownerSessionPath) !== path.join(physicalOwnerSessionDir, 'session.json')) return false;
      const descriptor = await readRegularJson(ownerSessionPath, 'Prototype Review session descriptor');
      const descriptorUrl = new URL(descriptor.url);
      const descriptorMatches = descriptor.schemaVersion === 1
        && descriptor.reviewShellVersion === reviewShellVersion
        && descriptor.sessionId === owner.sessionId
        && descriptor.pid === owner.pid
        && descriptor.prototypeRoot === owner.prototypeRoot
        && descriptor.prototypeId === owner.prototypeId
        && descriptor.prototypePath === owner.prototypePath
        && descriptor.revision === owner.revision
        && typeof descriptor.token === 'string'
        && descriptorUrl.protocol === 'http:'
        && descriptorUrl.hostname === '127.0.0.1'
        && Boolean(descriptorUrl.port)
        && new URLSearchParams(descriptorUrl.hash.slice(1)).get('token') === descriptor.token
        && `sha256:${createHash('sha256').update(descriptor.token).digest('hex')}` === owner.tokenDigest;
      if (!descriptorMatches) return false;

      const response = await fetch(new URL('/api/owner', descriptorUrl.origin), {
        signal: AbortSignal.timeout(5_000),
        headers: {
          origin: descriptorUrl.origin,
          'x-prototype-review-token': descriptor.token,
        },
      });
      if (!response.ok) return false;
      const identity = await response.json();
      return identity.ok === true
        && identity.sessionId === owner.sessionId
        && identity.pid === owner.pid
        && identity.prototypeRoot === owner.prototypeRoot
        && identity.prototypeId === owner.prototypeId
        && identity.prototypePath === owner.prototypePath
        && identity.revision === owner.revision;
    } catch {
      return false;
    }
  }

  async function currentGateOwnerIsReachable() {
    const root = await validatedGateRoot();
    const validatedGatePath = await validatedGateFile(root, { allowMissing: true });
    if (!validatedGatePath) return false;
    return gateOwnerIsReachable(await readRegularJson(validatedGatePath, 'Prototype submission gate'));
  }

  async function removeRecoveryClaim(root, expectedOwner = null) {
    const validatedRecoveryPath = await validatedRecoveryDirectory(root);
    const entries = await readdir(validatedRecoveryPath);
    if (entries.length === 0) {
      await rmdir(validatedRecoveryPath);
      return;
    }
    if (entries.length !== 1 || entries[0] !== recoveryOwnerName || !expectedOwner) {
      throw new Error('Prototype submission recovery claim contains foreign content');
    }
    const ownerPath = await validatedRecoveryOwnerFile(root);
    const currentOwner = await readRegularJson(ownerPath, 'Prototype submission recovery owner');
    if (!gateOwnerMatchesPrototype(currentOwner) || stableJson(currentOwner) !== stableJson(expectedOwner)) {
      throw new Error('Prototype submission recovery claim owner changed');
    }
    await rm(ownerPath);
    await rmdir(validatedRecoveryPath);
  }

  async function createRecoveryClaim(root) {
    const { validatedRecoveryPath } = validatedGatePaths(root);
    try {
      await lstat(validatedRecoveryPath);
      await validatedRecoveryDirectory(root);
      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(root, `.${gateKey}.${launch.sessionId}.${process.pid}.recovering`);
    if (path.dirname(temporary) !== root) {
      throw new Error('Prototype submission recovery temporary path is outside its validated root');
    }
    await mkdir(temporary, { mode: 0o700 });
    const temporaryOwner = path.join(temporary, recoveryOwnerName);
    try {
      await writeFile(temporaryOwner, JSON.stringify(gateOwner), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      try {
        await rename(temporary, validatedRecoveryPath);
        return true;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        return false;
      }
    } finally {
      try {
        const info = await lstat(temporary);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error('Prototype submission recovery temporary path must be a regular non-symlink directory');
        }
        if (path.dirname(await realpath(temporary)) !== root) {
          throw new Error('Prototype submission recovery temporary path is outside its validated root');
        }
        const ownerInfo = await lstat(temporaryOwner);
        if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink()) {
          throw new Error('Prototype submission recovery temporary owner must be a regular non-symlink file');
        }
        if (await realpath(temporaryOwner) !== path.join(await realpath(temporary), recoveryOwnerName)) {
          throw new Error('Prototype submission recovery temporary owner is outside its validated claim');
        }
        await rm(temporaryOwner);
        await rmdir(temporary);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  async function acquireRecoveryClaim(root) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await createRecoveryClaim(root)) return true;
      const validatedRecoveryPath = await validatedRecoveryDirectory(root);
      const entries = await readdir(validatedRecoveryPath);
      if (entries.length === 0) {
        await removeRecoveryClaim(root);
        continue;
      }
      if (entries.length !== 1 || entries[0] !== recoveryOwnerName) {
        throw new Error('Prototype submission recovery claim contains foreign content');
      }
      const ownerPath = await validatedRecoveryOwnerFile(root);
      const owner = await readRegularJson(ownerPath, 'Prototype submission recovery owner');
      if (!gateOwnerMatchesPrototype(owner)) {
        throw new Error('Prototype submission recovery claim has an invalid owner');
      }
      if (await gateOwnerIsReachable(owner)) return false;
      await removeRecoveryClaim(root, owner);
    }
    return false;
  }

  async function acquireSubmissionGate() {
    if (await createSubmissionGate()) return true;
    if (await currentGateOwnerIsReachable()) return false;

    const root = await validatedGateRoot();
    const { validatedGatePath } = validatedGatePaths(root);
    if (!await acquireRecoveryClaim(root)) return false;
    try {
      if (await currentGateOwnerIsReachable()) return false;
      await validatedGateRoot();
      await validatedGateFile(root);
      await rm(validatedGatePath, { force: true });
      return createSubmissionGate();
    } finally {
      try {
        await validatedGateRoot();
        await removeRecoveryClaim(root, gateOwner);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  async function releaseSubmissionGate() {
    if (!ownsSubmissionGate) return;
    try {
      const root = await validatedGateRoot();
      const validatedGatePath = await validatedGateFile(root);
      const owner = await readRegularJson(validatedGatePath, 'Prototype submission gate');
      if (owner.sessionId === launch.sessionId && owner.pid === process.pid) {
        await validatedGateRoot();
        await validatedGateFile(root);
        await rm(validatedGatePath, { force: true });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      ownsSubmissionGate = false;
    }
  }

  async function supersedeSession(error = 'Feedback was superseded by another Prototype Review session') {
    const state = {
      ok: true,
      status: 'superseded',
      error,
    };
    if (stopping) return state;
    const ownedSessionPath = await validatedOwnedSessionFile({ allowMissing: true });
    stopping = true;
    if (ownedSessionPath) {
      await validatedOwnedSessionFile();
      await rm(ownedSessionPath);
    }
    await assertSessionDirectoryIdentity();
    try {
      await rmdir(sessionDir);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    notifyWaiters(state.status, { error: state.error });
    setImmediate(() => server.close());
    return state;
  }

  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', origin);
      if (request.method === 'GET' && requestUrl.pathname === '/api/owner') {
        assertApiRequest(request, launch.token, origin);
        sendJson(response, 200, {
          ok: true,
          sessionId: launch.sessionId,
          pid: process.pid,
          prototypeRoot: prototype.prototypeRoot,
          prototypeId: prototype.config.id,
          prototypePath: prototype.prototypePath,
          revision: prototype.config.revision,
        });
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
        assertApiRequest(request, launch.token, origin);
        if (submittedFeedback && !await submittedFeedbackMatchesDisk()) {
          sendJson(response, 200, await supersedeSession());
          return;
        }
        sendJson(response, 200, {
          ok: true,
          prototypeId: prototype.config.id,
          revision: prototype.config.revision,
          status: submittedFeedback ? 'submitted' : 'ready',
          ...(submittedFeedbackDigest ? { feedbackDigest: submittedFeedbackDigest } : {}),
          url: `${origin}/review/index.html`,
        });
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/wait') {
        assertApiRequest(request, launch.token, origin);
        if (submittedFeedback) {
          if (!await submittedFeedbackMatchesDisk()) {
            sendJson(response, 200, await supersedeSession());
            return;
          }
          sendJson(response, 200, {
            ok: true,
            status: 'submitted',
            feedbackDigest: submittedFeedbackDigest,
          });
          return;
        }
        const requestedTimeout = Number(requestUrl.searchParams.get('timeoutMs') || '25000');
        const timeoutMs = Number.isInteger(requestedTimeout)
          ? Math.max(1, Math.min(requestedTimeout, 30000))
          : 25000;
        const waiter = { response, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          sendJson(response, 200, { ok: true, status: 'ready' });
        }, timeoutMs);
        waiters.add(waiter);
        response.once('close', () => {
          if (!waiters.delete(waiter)) return;
          clearTimeout(waiter.timer);
        });
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/feedback') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 409, {
            ok: false,
            status: 'stopping',
            error: 'Prototype Review session is stopping; feedback was not submitted',
          });
          return;
        }
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'Feedback must use application/json');
        }
        if (submittedFeedback || submissionInProgress) {
          throw new HttpError(409, 'Feedback was already submitted');
        }
        submissionInProgress = true;
        let outcome;
        try {
          const feedback = normalizeAndValidate(await receiveJson(request), feedbackSchema, 'feedback');
          if (
            feedback.prototypeId !== prototype.config.id
            || feedback.prototypeRevision !== prototype.config.revision
          ) {
            throw new HttpError(409, 'Prototype feedback id or revision mismatch');
          }
          validateFeedbackAgainstPrototype(feedback, prototype.config, 'feedback');
          if (!await currentPrototypeMatchesSession()) {
            outcome = { status: 'superseded', error: staleRevisionError };
          } else if (!await acquireSubmissionGate()) {
            outcome = { status: 'busy', error: submissionBusyError };
          } else if (!await currentPrototypeMatchesSession()) {
            outcome = { status: 'superseded', error: staleRevisionError };
          } else {
            const existingFeedback = await readCanonicalFeedback();
            if (existingFeedback && existingFeedback.prototypeRevision >= prototype.config.revision) {
              outcome = { status: 'superseded', error: revisionSubmittedError };
            } else {
              const ownDigest = feedbackDigest(feedback);
              await writeFeedback(feedback);
              await waitForSubmissionTestSeam();
              if (!await currentPrototypeMatchesSession()) {
                let diskStillOwn = false;
                try {
                  const currentFeedback = await readCanonicalFeedback();
                  diskStillOwn = currentFeedback !== null && feedbackDigest(currentFeedback) === ownDigest;
                } catch {
                  // Foreign or invalid feedback is never removed by stale-submission cleanup.
                }
                if (diskStillOwn) {
                  const ownedFeedbackPath = await validatedFeedbackFile();
                  const currentFeedback = await readCanonicalFeedback();
                  if (currentFeedback !== null && feedbackDigest(currentFeedback) === ownDigest) {
                    await validatedFeedbackFile();
                    await rm(ownedFeedbackPath);
                  }
                }
                outcome = { status: 'superseded', error: staleRevisionError };
              } else {
                submittedFeedback = feedback;
                submittedFeedbackDigest = ownDigest;
                if (!await submittedFeedbackMatchesDisk()) {
                  outcome = {
                    status: 'superseded',
                    error: 'Feedback was superseded by another Prototype Review session',
                  };
                } else {
                  outcome = { status: 'submitted' };
                }
              }
            }
          }
        } catch (error) {
          throw error;
    } finally {
      try {
        await releaseSubmissionGate();
      } finally {
        submissionInProgress = false;
      }
    }

        if (outcome.status === 'busy') {
          sendJson(response, 409, { ok: false, ...outcome });
          return;
        }
        if (outcome.status === 'superseded') {
          const state = await supersedeSession(outcome.error);
          sendJson(response, 409, { ...state, ok: false });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          status: 'submitted',
          feedbackDigest: submittedFeedbackDigest,
        });
        notifyWaiters('submitted', { feedbackDigest: submittedFeedbackDigest });
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/stop') {
        assertApiRequest(request, launch.token, origin);
        if (submissionInProgress) {
          sendJson(response, 409, {
            ok: false,
            status: 'busy',
            error: 'Feedback submission is in progress',
          });
          return;
        }
        sendJson(response, 200, { ok: true, status: stopping ? 'stopped' : 'cancelled' });
        if (!stopping) {
          stopping = true;
          await releaseSubmissionGate();
          notifyWaiters('cancelled');
          setImmediate(() => server.close());
        }
        return;
      }
      if (requestUrl.pathname.startsWith('/api/')) throw new HttpError(404, 'API route not found');
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed');
      if (requestUrl.pathname === '/review/config.json') {
        sendJson(response, 200, prototype.config);
        return;
      }
      if (requestUrl.pathname === '/' || requestUrl.pathname === '/review' || requestUrl.pathname === '/review/') {
        serveFile(request, response, await resolveShellFile(shellRoot, 'index.html'));
        return;
      }
      if (requestUrl.pathname.startsWith('/review/')) {
        const name = requestUrl.pathname.slice('/review/'.length);
        serveFile(request, response, await resolveShellFile(shellRoot, name));
        return;
      }
      if (requestUrl.pathname.startsWith('/artifact/')) {
        await assertPrototypeIdentity();
        serveFile(
          request,
          response,
          await resolveArtifact(requestUrl.pathname, prototype.artifactRoot, prototype.physicalArtifactRoot),
        );
        return;
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 400);
      sendJson(response, status, { ok: false, error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Prototype Review server did not allocate a port');
  origin = `http://127.0.0.1:${address.port}`;
  const descriptor = {
    schemaVersion: 1,
    reviewShellVersion,
    sessionId: launch.sessionId,
    token: launch.token,
    pid: process.pid,
    url: `${origin}/review/index.html#token=${encodeURIComponent(launch.token)}`,
    prototypePath: prototype.prototypePath,
    prototypeRoot: prototype.prototypeRoot,
    prototypeId: prototype.config.id,
    revision: prototype.config.revision,
    createdAt: new Date().toISOString(),
  };
  await assertSessionDirectoryIdentity();
  await writeAtomicJson(sessionPath, descriptor, { compact: true });
  const sessionPathInfo = await lstat(sessionPath);
  sessionPathIdentity = physicalIdentity(sessionPathInfo, await realpath(sessionPath));
  sessionDescriptor = descriptor;
  await validatedOwnedSessionFile();
  await rm(launchPath, { force: true });

  const close = async () => {
    await releaseSubmissionGate();
    notifyWaiters('cancelled');
    server.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.launch) {
  console.log('Usage: review-server.mjs --launch <launch.json>');
  process.exit(args.help ? 0 : 2);
}

try {
  await startServer(path.resolve(args.launch));
} catch (error) {
  try {
    const sessionDir = path.dirname(path.resolve(args.launch));
    await writeAtomicJson(path.join(sessionDir, 'startup-error.json'), {
      ok: false,
      status: 'failed',
      error: error.message,
    });
  } catch {
    // The parent command will also detect an early process exit.
  }
  console.error(error.stack || error.message);
  process.exit(1);
}
