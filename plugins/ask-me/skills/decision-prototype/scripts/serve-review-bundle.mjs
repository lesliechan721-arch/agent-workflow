#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { normalizeAndValidate, readJsonSchema } from './review-contract.mjs';

function parseArgs(argv) {
  const result = { port: 4173 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root') result.root = argv[++index];
    else if (value === '--port') result.port = Number(argv[++index]);
    else if (value === '--help' || value === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.root) {
  console.log('Usage: serve-review-bundle.mjs --root <prototype-dir> [--port 4173]');
  process.exit(args.help ? 0 : 2);
}
if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error('Invalid port');
const root = await realpath(path.resolve(args.root));
if (!(await stat(root)).isDirectory()) throw new Error('Root must be a directory');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const [prototypeSchema, feedbackSchema] = await Promise.all([
  readJsonSchema(path.resolve(scriptDir, '..', 'assets', 'prototype.schema.json')),
  readJsonSchema(path.resolve(scriptDir, '..', 'assets', 'feedback.schema.json')),
]);
const config = normalizeAndValidate(
  JSON.parse(await readFile(path.join(root, 'review', 'config.json'), 'utf8')),
  prototypeSchema,
  'prototype',
);
const sessionToken = randomBytes(32).toString('base64url');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isInside(candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function resolveInside(urlPath) {
  const normalized = path.posix.normalize(decodeURIComponent(urlPath.split('?')[0]));
  const relative = normalized.replace(/^\/+/, '') || 'review/index.html';
  let target = path.resolve(root, relative);
  if (!isInside(target)) throw new Error('Path escapes root');
  if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
  const physicalTarget = await realpath(target);
  if (!isInside(physicalTarget)) throw new Error('Path escapes root through a symbolic link');
  return physicalTarget;
}

async function receiveJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Feedback exceeds 2 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function reviewOrigin() {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server is not listening');
  return `http://127.0.0.1:${address.port}`;
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/api/session') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ token: sessionToken }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/feedback') {
      if (request.headers.origin !== reviewOrigin()) throw new HttpError(403, 'Invalid feedback origin');
      if (request.headers['x-prototype-review-token'] !== sessionToken) throw new HttpError(403, 'Invalid feedback session');
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Feedback must use application/json');
      const feedback = normalizeAndValidate(await receiveJson(request), feedbackSchema, 'feedback');
      if (feedback.prototypeId !== config.id || feedback.prototypeRevision !== config.revision) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'prototype revision mismatch' }));
        return;
      }
      const target = path.join(root, 'feedback.json');
      const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, `${JSON.stringify(feedback, null, 2)}\n`, 'utf8');
      await rename(temporary, target);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, path: target }));
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405); response.end(); return;
    }
    if ((request.url || '').split('?')[0] === '/review/config.json') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      if (request.method === 'HEAD') response.end();
      else response.end(JSON.stringify(config));
      return;
    }
    const target = await resolveInside(request.url || '/');
    response.writeHead(200, { 'content-type': contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if (request.method === 'HEAD') response.end();
    else createReadStream(target).pipe(response);
  } catch (error) {
    response.writeHead(error.status || (error.code === 'ENOENT' ? 404 : 400), { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error.message);
  }
});

server.listen(args.port, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : args.port;
  console.log(JSON.stringify({ ok: true, root, url: `http://127.0.0.1:${port}/review/index.html` }));
});
