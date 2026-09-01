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

const maxBodyBytes = 2 * 1024 * 1024;
const reviewShellVersion = 2;
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
  if (request.headers.origin !== origin) throw new HttpError(403, 'Invalid Prototype Review origin');
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
    || typeof launch.sessionId !== 'string'
    || !/^[a-f0-9]{32}$/.test(launch.sessionId)
    || typeof launch.token !== 'string'
    || typeof launch.prototypePath !== 'string'
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
  const waiters = new Set();
  const activeSubmissions = new Set();
  let stopping = false;

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
      sendJson(waiter.response, 200, { ok: true, status });
    }
    waiters.clear();
  }

  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', origin);
      if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
        assertApiRequest(request, launch.token, origin);
        await currentPrototype();
        const feedback = await readCanonicalFeedback({ allowMissing: true });
        sendJson(response, 200, {
          ok: true,
          status: feedback ? 'submitted' : 'ready',
          prototypeId: prototype.config.id,
          revision: prototype.config.revision,
          ...(feedback ? feedbackReceipt(feedback, feedbackPath) : {}),
          url: `${origin}/review/index.html`,
        });
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/wait') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 200, { ok: true, status: 'cancelled' });
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
      if (request.method === 'POST' && requestUrl.pathname === '/api/feedback') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) throw new HttpError(409, 'Prototype Review session is stopping');
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'Feedback must use application/json');
        }
        const feedback = normalizeAndValidate(await receiveJson(request), feedbackSchema, 'feedback');
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
        sendJson(response, 200, {
          ok: true,
          status: 'submitted',
          accepted: committed.accepted,
          ...feedbackReceipt(committed.feedback, feedbackPath),
        });
        notifyWaiters('submitted');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/stop') {
        assertApiRequest(request, launch.token, origin);
        if (stopping) {
          sendJson(response, 200, { ok: true, status: 'cancelled' });
          return;
        }
        stopping = true;
        const submissions = await Promise.allSettled([...activeSubmissions]);
        let submitted = submissions.some((result) => result.status === 'fulfilled');
        if (!submitted) {
          try {
            submitted = await readCanonicalFeedback({ allowMissing: true }) !== null;
          } catch {
            // Invalid or foreign feedback never changes a cancellation into submission.
          }
        }
        const status = submitted ? 'submitted' : 'cancelled';
        sendJson(response, 200, { ok: true, status });
        notifyWaiters(status);
        setImmediate(() => server.close());
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
  await assertDirectoryIdentity(sessionDir, sessionDirIdentity, 'Prototype Review session directory');
  await writeAtomicJson(sessionPath, descriptor, { compact: true });
  await assertDirectoryIdentity(sessionDir, sessionDirIdentity, 'Prototype Review session directory');
  await rm(launchPath, { force: true });

  const close = () => {
    if (stopping) return;
    stopping = true;
    notifyWaiters('cancelled');
    server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
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
