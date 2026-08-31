#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import {
  chmod,
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
    || typeof launch.token !== 'string'
    || typeof launch.prototypePath !== 'string'
  ) {
    throw new Error('Invalid launch descriptor');
  }
  const sessionDir = await realpath(path.dirname(launchPath));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const shellRoot = await realpath(path.resolve(scriptDir, '..', 'assets', 'review-shell'));
  const [prototypeSchema, feedbackSchema] = await Promise.all([
    readJsonSchema(path.resolve(scriptDir, '..', 'assets', 'prototype.schema.json')),
    readJsonSchema(path.resolve(scriptDir, '..', 'assets', 'feedback.schema.json')),
  ]);
  const prototype = await loadAndValidatePrototype(launch.prototypePath, prototypeSchema);
  const feedbackPath = path.join(prototype.prototypeRoot, 'feedback.json');
  const waiters = new Set();
  let submittedFeedback = null;
  let submissionInProgress = false;
  let stopping = false;

  function notifyWaiters(status, extra = {}) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      sendJson(waiter.response, 200, { ok: true, status, ...extra });
    }
    waiters.clear();
  }

  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', origin);
      if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
        assertApiRequest(request, launch.token, origin);
        sendJson(response, 200, {
          ok: true,
          prototypeId: prototype.config.id,
          revision: prototype.config.revision,
          status: submittedFeedback ? 'submitted' : 'ready',
          url: `${origin}/review/index.html`,
        });
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/wait') {
        assertApiRequest(request, launch.token, origin);
        if (submittedFeedback) {
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
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'Feedback must use application/json');
        }
        if (submittedFeedback || submissionInProgress) {
          throw new HttpError(409, 'Feedback was already submitted');
        }
        submissionInProgress = true;
        let feedback;
        try {
          feedback = normalizeAndValidate(await receiveJson(request), feedbackSchema, 'feedback');
          if (
            feedback.prototypeId !== prototype.config.id
            || feedback.prototypeRevision !== prototype.config.revision
          ) {
            throw new HttpError(409, 'Prototype feedback id or revision mismatch');
          }
          validateFeedbackAgainstPrototype(feedback, prototype.config, 'feedback');
          await writeAtomicJson(feedbackPath, feedback);
          submittedFeedback = feedback;
        } catch (error) {
          submissionInProgress = false;
          throw error;
        }
        submissionInProgress = false;
        sendJson(response, 200, { ok: true, status: 'submitted' });
        notifyWaiters('submitted');
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/stop') {
        assertApiRequest(request, launch.token, origin);
        sendJson(response, 200, { ok: true, status: stopping ? 'stopped' : 'cancelled' });
        if (!stopping) {
          stopping = true;
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
  await writeAtomicJson(path.join(sessionDir, 'session.json'), descriptor, { compact: true });
  await rm(launchPath, { force: true });

  const close = () => {
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
    // The parent command will also detect an early process exit.
  }
  console.error(error.stack || error.message);
  process.exit(1);
}
