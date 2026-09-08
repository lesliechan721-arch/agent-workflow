#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
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
import { MAX_REVIEW_TTL_MS } from './review-config.mjs';

const maxBodyBytes = 2 * 1024 * 1024;
const reviewShellVersion = 2;
const shutdownGraceMs = 3_000;
const extensionMs = 30 * 60 * 1000;
const openingLeaseMs = 15_000;
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

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function readRegularJson(filePath, label) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function assertDirectoryIdentity(filePath, identity, label) {
  const info = await lstat(filePath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }
  if (info.dev !== identity.dev || info.ino !== identity.ino || await realpath(filePath) !== identity.path) {
    throw new Error(`${label} physical identity changed after the Review session started`);
  }
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
    // File permissions are best effort on platforms without POSIX modes.
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
  let sameOriginBrowserGet = false;
  if (
    request.method === 'GET'
    && request.headers.origin === undefined
    && request.headers['sec-fetch-site'] === 'same-origin'
    && typeof request.headers.referer === 'string'
  ) {
    try {
      sameOriginBrowserGet = new URL(request.headers.referer).origin === origin
        && request.headers.host === new URL(origin).host;
    } catch {
      sameOriginBrowserGet = false;
    }
  }
  if (request.headers.origin !== origin && !sameOriginBrowserGet) {
    throw new HttpError(403, 'Invalid Prototype Review origin');
  }
  if (request.headers['x-prototype-review-token'] !== token) {
    throw new HttpError(403, 'Invalid Prototype Review session');
  }
}

function feedbackReceipt(feedback, feedbackPath) {
  return {
    prototypeId: feedback.prototypeId,
    revision: feedback.prototypeRevision,
    verdict: feedback.verdict,
    selectedOptionCount: feedback.selectedOptions.length,
    annotationCount: feedback.annotations.length,
    feedback: feedbackPath,
  };
}

async function startServer(launchPath) {
  const launchInfo = await lstat(launchPath);
  if (!launchInfo.isFile() || launchInfo.isSymbolicLink()) {
    throw new Error('Launch descriptor must be a regular non-symlink file');
  }
  const launch = await readRegularJson(launchPath, 'Launch descriptor');
  if (
    !isObject(launch)
    || launch.schemaVersion !== 2
    || launch.reviewShellVersion !== reviewShellVersion
    || typeof launch.sessionId !== 'string'
    || !/^[a-f0-9]{32}$/.test(launch.sessionId)
    || typeof launch.token !== 'string'
    || typeof launch.prototypePath !== 'string'
    || !Number.isInteger(launch.ttlMs)
    || launch.ttlMs <= 0
    || launch.ttlMs > MAX_REVIEW_TTL_MS
  ) {
    throw new Error('Invalid launch descriptor');
  }

  const sessionDir = await realpath(path.dirname(launchPath));
  if (path.basename(sessionDir) !== launch.sessionId || await realpath(launchPath) !== path.join(sessionDir, 'launch.json')) {
    throw new Error('Launch descriptor is outside its bound session directory');
  }
  const sessionDirInfo = await lstat(sessionDir);
  if (!sessionDirInfo.isDirectory() || sessionDirInfo.isSymbolicLink()) {
    throw new Error('Session directory must be a regular non-symlink directory');
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const shellRoot = await realpath(path.resolve(scriptDir, '..', 'assets', 'review-shell'));
  const [prototypeSchema, feedbackSchema] = await Promise.all([
    readJsonSchema(path.resolve(scriptDir, '..', 'assets', 'prototype.schema.json')),
    readJsonSchema(path.resolve(scriptDir, '..', 'assets', 'feedback.schema.json')),
  ]);
  const prototype = await loadAndValidatePrototype(launch.prototypePath, prototypeSchema);
  const [prototypeRootInfo, artifactRootInfo] = await Promise.all([
    lstat(prototype.prototypeRoot),
    lstat(prototype.artifactRoot),
  ]);
  const prototypeRootIdentity = {
    dev: prototypeRootInfo.dev,
    ino: prototypeRootInfo.ino,
    path: prototype.prototypeRoot,
  };
  const artifactRootIdentity = {
    dev: artifactRootInfo.dev,
    ino: artifactRootInfo.ino,
    path: prototype.physicalArtifactRoot,
  };
  const sessionDirIdentity = {
    dev: sessionDirInfo.dev,
    ino: sessionDirInfo.ino,
    path: sessionDir,
  };
  const feedbackPath = path.join(prototype.prototypeRoot, 'feedback.json');
  const sessionPath = path.join(sessionDir, 'session.json');
  const terminalPath = path.join(sessionDir, 'terminal.json');
  const waiters = new Set();
  const activeSubmissions = new Set();
  const sockets = new Set();
  const createdAtMs = Date.now();
  const createdAtMonotonic = performance.now();
  const maxExpiresAtMs = createdAtMs + MAX_REVIEW_TTL_MS;
  const maxExpiresAtMonotonic = createdAtMonotonic + MAX_REVIEW_TTL_MS;
  let expiresAtMs = createdAtMs + launch.ttlMs;
  let expiresAtMonotonic = createdAtMonotonic + launch.ttlMs;
  let stopping = false;
  let finalStatus = null;
  let finalization = null;
  let expiryTimer = null;
  let pageConnected = false;
  let opening = null;
  let lastOpen = null;
  let origin;
  let server;
  let finishLifetime;
  const lifetime = new Promise((resolve) => {
    finishLifetime = resolve;
  });

  function deadlinePassed() {
    return Date.now() >= expiresAtMs || performance.now() >= expiresAtMonotonic;
  }

  function assertSubmissionDeadline() {
    if (deadlinePassed()) {
      throw new HttpError(410, 'Prototype Review session expired before feedback was saved');
    }
  }

  function refreshOpening() {
    if (
      opening
      && (Date.now() >= opening.expiresAtMs || performance.now() >= opening.expiresAtMonotonic)
    ) {
      opening = null;
      lastOpen = {
        status: 'failed',
        method: 'system-browser',
        reason: 'The previous browser open request did not finish',
      };
    }
  }

  function presentation() {
    refreshOpening();
    return {
      pageConnected,
      openRequested: lastOpen?.status === 'requested',
      openInProgress: opening !== null,
      openStatus: lastOpen?.status || null,
      ...(lastOpen?.reason ? { openReason: lastOpen.reason } : {}),
    };
  }

  function stateReceipt(status, extra = {}) {
    return {
      ok: true,
      status,
      prototypeId: prototype.config.id,
      revision: prototype.config.revision,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      maxExpiresAt: new Date(maxExpiresAtMs).toISOString(),
      presentation: presentation(),
      ...extra,
    };
  }

  async function currentPrototype() {
    await assertDirectoryIdentity(prototype.prototypeRoot, prototypeRootIdentity, 'Prototype root');
    await assertDirectoryIdentity(prototype.artifactRoot, artifactRootIdentity, 'Prototype artifact root');
    const current = await loadAndValidatePrototype(prototype.prototypePath, prototypeSchema);
    await assertDirectoryIdentity(prototype.prototypeRoot, prototypeRootIdentity, 'Prototype root');
    await assertDirectoryIdentity(prototype.artifactRoot, artifactRootIdentity, 'Prototype artifact root');
    if (
      current.prototypeRoot !== prototype.prototypeRoot
      || current.prototypePath !== prototype.prototypePath
      || current.config.id !== prototype.config.id
      || current.config.revision !== prototype.config.revision
    ) {
      throw new HttpError(409, 'Prototype revision changed; feedback was not submitted');
    }
    return current;
  }

  async function readCanonicalFeedback({ allowMissing = false } = {}) {
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
    if (await realpath(feedbackPath) !== path.join(prototype.prototypeRoot, 'feedback.json')) {
      throw new Error('Submitted feedback is outside the physical Prototype root');
    }
    const feedback = normalizeAndValidate(
      JSON.parse(await readFile(feedbackPath, 'utf8')),
      feedbackSchema,
      'feedback',
    );
    if (
      feedback.prototypeId !== prototype.config.id
      || feedback.prototypeRevision !== prototype.config.revision
    ) {
      throw new Error('Existing feedback does not match this Prototype revision');
    }
    validateFeedbackAgainstPrototype(feedback, prototype.config, 'feedback');
    return feedback;
  }

  async function removeOwnedFeedback(temporaryInfo) {
    let feedbackInfo;
    try {
      feedbackInfo = await lstat(feedbackPath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (
      feedbackInfo.isFile()
      && !feedbackInfo.isSymbolicLink()
      && feedbackInfo.dev === temporaryInfo.dev
      && feedbackInfo.ino === temporaryInfo.ino
    ) {
      await rm(feedbackPath);
    }
  }

  async function commitFeedback(feedback) {
    await currentPrototype();
    const temporary = path.join(
      prototype.prototypeRoot,
      `.feedback-${launch.sessionId}-${randomBytes(8).toString('hex')}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(feedback, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    const temporaryInfo = await lstat(temporary);
    try {
      if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink()) {
        throw new Error('Feedback temporary must be a regular non-symlink file');
      }
      if (await realpath(temporary) !== temporary) {
        throw new Error('Feedback temporary is outside the Prototype root');
      }
      await currentPrototype();
      assertSubmissionDeadline();
      try {
        await link(temporary, feedbackPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        return { feedback: await readCanonicalFeedback(), accepted: false };
      }
      if (await currentPrototype().then(() => true, () => false)) {
        return { feedback, accepted: true };
      }
      await removeOwnedFeedback(temporaryInfo);
      throw new HttpError(409, 'Prototype revision changed; feedback was not submitted');
    } finally {
      await rm(temporary, { force: true });
    }
  }

  function notifyWaiters(status) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      try {
        sendJson(waiter.response, 200, { ok: true, status });
      } catch {
        waiter.response.destroy();
      }
    }
    waiters.clear();
  }

  async function canonicalFeedbackExists() {
    try {
      return await readCanonicalFeedback({ allowMissing: true }) !== null;
    } catch {
      return false;
    }
  }

  function closeServerBounded() {
    return new Promise((resolve) => {
      let settled = false;
      let forceTimer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };
      forceTimer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        setTimeout(finish, 50);
      }, shutdownGraceMs);
      server.close(finish);
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    });
  }

  function finalize(requestedStatus) {
    stopping = true;
    if (expiryTimer) clearTimeout(expiryTimer);
    if (finalization) return finalization;
    finalization = (async () => {
      const submissions = await Promise.allSettled([...activeSubmissions]);
      const submitted = requestedStatus === 'submitted'
        || submissions.some((result) => result.status === 'fulfilled')
        || await canonicalFeedbackExists();
      finalStatus = submitted ? 'submitted' : requestedStatus;
      notifyWaiters(finalStatus);
      await closeServerBounded();
      try {
        await assertDirectoryIdentity(sessionDir, sessionDirIdentity, 'Prototype Review session directory');
        await writeAtomicJson(terminalPath, {
          schemaVersion: 1,
          sessionId: launch.sessionId,
          prototypePath: prototype.prototypePath,
          prototypeRoot: prototype.prototypeRoot,
          prototypeId: prototype.config.id,
          revision: prototype.config.revision,
          status: finalStatus,
          resourcesClosed: true,
          endedAt: new Date().toISOString(),
        }, { compact: true });
      } catch (error) {
        console.error(`Cannot persist Prototype Review terminal receipt: ${error.message}`);
      }
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
      finishLifetime();
      return finalStatus;
    })();
    return finalization;
  }

  function handleSignal() {
    void finalize('cancelled');
  }

  function scheduleExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer);
    const remaining = Math.min(expiresAtMs - Date.now(), expiresAtMonotonic - performance.now());
    if (remaining <= 0) {
      void finalize('expired');
      return;
    }
    expiryTimer = setTimeout(() => scheduleExpiry(), Math.max(1, remaining));
  }

  server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', origin);
      if (deadlinePassed()) {
        if (requestUrl.pathname.startsWith('/api/')) {
          assertApiRequest(request, launch.token, origin);
        }
        const readableTerminalRequest = (
          request.method === 'GET'
          && ['/api/status', '/api/wait'].includes(requestUrl.pathname)
        ) || (request.method === 'POST' && requestUrl.pathname === '/api/stop');
        sendJson(response, readableTerminalRequest ? 200 : 410, stateReceipt('expired'));
        void finalize('expired');
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 200, stateReceipt(finalStatus || 'stopping'));
          return;
        }
        await currentPrototype();
        const feedback = await readCanonicalFeedback({ allowMissing: true });
        sendJson(response, 200, stateReceipt(feedback ? 'submitted' : 'ready', {
          ...(feedback ? feedbackReceipt(feedback, feedbackPath) : {}),
          url: `${origin}/review/index.html`,
        }));
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/wait') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 200, { ok: true, status: finalStatus || 'stopping' });
          return;
        }
        await currentPrototype();
        const feedback = await readCanonicalFeedback({ allowMissing: true });
        if (feedback) {
          sendJson(response, 200, { ok: true, status: 'submitted' });
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
      if (request.method === 'POST' && requestUrl.pathname === '/api/page-connected') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 200, stateReceipt(finalStatus || 'stopping'));
          return;
        }
        await currentPrototype();
        const feedback = await readCanonicalFeedback({ allowMissing: true });
        if (feedback) {
          sendJson(response, 200, stateReceipt('submitted', feedbackReceipt(feedback, feedbackPath)));
          return;
        }
        assertSubmissionDeadline();
        if (stopping) throw new HttpError(409, 'Prototype Review session is stopping');
        pageConnected = true;
        sendJson(response, 200, stateReceipt('ready'));
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/extend') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 200, stateReceipt(finalStatus || 'stopping'));
          return;
        }
        await currentPrototype();
        const feedback = await readCanonicalFeedback({ allowMissing: true });
        if (feedback) {
          sendJson(response, 200, stateReceipt('submitted', feedbackReceipt(feedback, feedbackPath)));
          return;
        }
        assertSubmissionDeadline();
        if (stopping) throw new HttpError(409, 'Prototype Review session is stopping');
        const nextExpiresAtMs = Math.min(expiresAtMs + extensionMs, maxExpiresAtMs);
        const deltaMs = nextExpiresAtMs - expiresAtMs;
        expiresAtMs = nextExpiresAtMs;
        expiresAtMonotonic = Math.min(expiresAtMonotonic + deltaMs, maxExpiresAtMonotonic);
        scheduleExpiry();
        sendJson(response, 200, stateReceipt('ready'));
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/open-reserve') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 200, stateReceipt(finalStatus || 'stopping'));
          return;
        }
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'Browser open reservation must use application/json');
        }
        await currentPrototype();
        const feedback = await readCanonicalFeedback({ allowMissing: true });
        if (feedback) {
          sendJson(response, 200, stateReceipt('submitted', feedbackReceipt(feedback, feedbackPath)));
          return;
        }
        const body = await receiveJson(request);
        if (!isObject(body) || (body.retry !== undefined && typeof body.retry !== 'boolean')) {
          throw new HttpError(400, 'Invalid browser open reservation');
        }
        assertSubmissionDeadline();
        if (stopping) throw new HttpError(409, 'Prototype Review session is stopping');
        refreshOpening();
        const retry = body.retry === true;
        if (opening) {
          sendJson(response, 200, stateReceipt('opening'));
          return;
        }
        if (pageConnected && !retry) {
          sendJson(response, 200, stateReceipt('connected'));
          return;
        }
        if (lastOpen && !retry) {
          sendJson(response, 200, stateReceipt(
            lastOpen.status === 'requested' ? 'open-requested' : lastOpen.status,
          ));
          return;
        }
        const reservation = randomBytes(16).toString('hex');
        lastOpen = null;
        opening = {
          reservation,
          expiresAtMs: Date.now() + openingLeaseMs,
          expiresAtMonotonic: performance.now() + openingLeaseMs,
        };
        sendJson(response, 200, stateReceipt('reserved', { reservation }));
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/open-complete') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 200, stateReceipt(finalStatus || 'stopping'));
          return;
        }
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'Browser open completion must use application/json');
        }
        await currentPrototype();
        const body = await receiveJson(request);
        if (
          !isObject(body)
          || typeof body.reservation !== 'string'
          || !['requested', 'unavailable', 'failed'].includes(body.status)
          || body.method !== 'system-browser'
          || (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500))
        ) {
          throw new HttpError(400, 'Invalid browser open completion');
        }
        assertSubmissionDeadline();
        refreshOpening();
        if (!opening || opening.reservation !== body.reservation) {
          throw new HttpError(409, 'Browser open reservation is no longer current');
        }
        const feedback = await readCanonicalFeedback({ allowMissing: true });
        if (feedback) {
          opening = null;
          sendJson(response, 200, stateReceipt('submitted', feedbackReceipt(feedback, feedbackPath)));
          return;
        }
        assertSubmissionDeadline();
        if (stopping) throw new HttpError(409, 'Prototype Review session is stopping');
        opening = null;
        lastOpen = {
          status: body.status,
          method: body.method,
          ...(body.reason ? { reason: body.reason } : {}),
        };
        sendJson(response, 200, stateReceipt(
          body.status === 'requested' ? (pageConnected ? 'connected' : 'open-requested') : body.status,
        ));
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/feedback') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) throw new HttpError(409, 'Prototype Review session is stopping');
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'Feedback must use application/json');
        }
        const feedback = normalizeAndValidate(await receiveJson(request), feedbackSchema, 'feedback');
        assertSubmissionDeadline();
        if (stopping) throw new HttpError(409, 'Prototype Review session is stopping');
        if (
          feedback.prototypeId !== prototype.config.id
          || feedback.prototypeRevision !== prototype.config.revision
        ) {
          throw new HttpError(409, 'Prototype feedback id or revision mismatch');
        }
        validateFeedbackAgainstPrototype(feedback, prototype.config, 'feedback');
        const submission = commitFeedback(feedback);
        activeSubmissions.add(submission);
        let committed;
        try {
          committed = await submission;
        } finally {
          activeSubmissions.delete(submission);
        }
        stopping = true;
        sendJson(response, 200, {
          ok: true,
          status: 'submitted',
          accepted: committed.accepted,
          ...feedbackReceipt(committed.feedback, feedbackPath),
        });
        void finalize('submitted');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/stop') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 200, { ok: true, status: finalStatus || 'stopping' });
          return;
        }
        stopping = true;
        const submissions = await Promise.allSettled([...activeSubmissions]);
        const submitted = submissions.some((result) => result.status === 'fulfilled')
          || await canonicalFeedbackExists();
        const status = submitted ? 'submitted' : 'cancelled';
        sendJson(response, 200, { ok: true, status });
        void finalize(status);
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/cancel') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 200, stateReceipt(finalStatus || 'stopping'));
          return;
        }
        await currentPrototype();
        assertSubmissionDeadline();
        if (stopping) {
          sendJson(response, 200, stateReceipt(finalStatus || 'stopping'));
          return;
        }
        stopping = true;
        const submissions = await Promise.allSettled([...activeSubmissions]);
        const feedback = await readCanonicalFeedback({ allowMissing: true });
        const submitted = submissions.some((result) => result.status === 'fulfilled') || feedback !== null;
        const status = submitted ? 'submitted' : 'cancelled';
        sendJson(response, 200, stateReceipt(
          status,
          feedback ? feedbackReceipt(feedback, feedbackPath) : {},
        ));
        void finalize(status);
        return;
      }
      if (requestUrl.pathname.startsWith('/api/')) throw new HttpError(404, 'API route not found');
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed');
      if (requestUrl.pathname === '/review/config.json') {
        await currentPrototype();
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
        const current = await currentPrototype();
        serveFile(
          request,
          response,
          await resolveArtifact(requestUrl.pathname, current.artifactRoot, current.physicalArtifactRoot),
        );
        return;
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 400);
      sendJson(response, status, { ok: false, status: 'failed', error: error.message });
      if (status === 409 && error.message.includes('Prototype revision changed')) {
        void finalize('cancelled');
      }
      if (status === 410 && error.message.includes('Prototype Review session expired')) {
        void finalize('expired');
      }
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Prototype Review server did not allocate a port');
  origin = `http://127.0.0.1:${address.port}`;
  const descriptor = {
    schemaVersion: 2,
    reviewShellVersion,
    sessionId: launch.sessionId,
    token: launch.token,
    pid: process.pid,
    url: `${origin}/review/index.html#token=${encodeURIComponent(launch.token)}`,
    prototypePath: prototype.prototypePath,
    prototypeRoot: prototype.prototypeRoot,
    prototypeId: prototype.config.id,
    revision: prototype.config.revision,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  await assertDirectoryIdentity(sessionDir, sessionDirIdentity, 'Prototype Review session directory');
  await writeAtomicJson(sessionPath, descriptor, { compact: true });
  await assertDirectoryIdentity(sessionDir, sessionDirIdentity, 'Prototype Review session directory');
  await rm(launchPath, { force: true });
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  scheduleExpiry();
  await lifetime;
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
    // The parent command also detects an early process exit.
  }
  console.error(error.stack || error.message);
  process.exit(1);
}
