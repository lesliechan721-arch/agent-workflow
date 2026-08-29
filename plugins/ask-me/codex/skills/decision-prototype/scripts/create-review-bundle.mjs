#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { normalizeAndValidate, readJsonSchema } from './review-contract.mjs';

const ownerMarkerName = '.prototype-review-owner.json';
const ownerMarker = {
  schemaVersion: 1,
  kind: 'decision-prototype-review-bundle',
};
const shellFiles = ['index.html', 'app.js', 'review-policy.mjs', 'styles.css'];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--prototype') result.prototype = argv[++index];
    else if (value === '--help' || value === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function pathInfo(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function invalidOwnership(output) {
  return new Error(`Refusing to replace review output without a valid ownership marker. Move or delete ${output}, then rerun the command.`);
}

async function assertOwnedOutput(output, prototypeRoot) {
  const outputInfo = await pathInfo(output);
  if (!outputInfo?.isDirectory() || outputInfo.isSymbolicLink()) {
    throw new Error(`Refusing to replace review output that is not an owned directory: ${output}`);
  }
  const physicalOutput = await realpath(output);
  if (!isInside(prototypeRoot, physicalOutput)) {
    throw new Error(`Refusing to replace review output outside the Prototype root: ${output}`);
  }

  const markerPath = path.join(output, ownerMarkerName);
  const markerInfo = await pathInfo(markerPath);
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) {
    throw invalidOwnership(output);
  }
  let actualMarker;
  try {
    actualMarker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    throw invalidOwnership(output);
  }
  if (
    !actualMarker
    || typeof actualMarker !== 'object'
    || Array.isArray(actualMarker)
    || actualMarker.schemaVersion !== ownerMarker.schemaVersion
    || actualMarker.kind !== ownerMarker.kind
    || Object.keys(actualMarker).length !== Object.keys(ownerMarker).length
  ) {
    throw invalidOwnership(output);
  }
}

async function adoptOutput(temporary, output, prototypeRoot, replaceExisting) {
  if (!replaceExisting) {
    if (await pathInfo(output)) throw new Error(`Review output changed while the bundle was prepared: ${output}`);
    await rename(temporary, output);
    return;
  }

  await assertOwnedOutput(output, prototypeRoot);
  const backup = path.join(prototypeRoot, `.review.previous-${randomBytes(12).toString('hex')}`);
  await rename(output, backup);
  try {
    await rename(temporary, output);
  } catch (error) {
    try {
      await rename(backup, output);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Failed to adopt the new review bundle and restore the previous bundle: ${output}`);
    }
    throw error;
  }
  await rm(backup, { recursive: true });
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.prototype) {
  console.log('Usage: create-review-bundle.mjs --prototype <prototype.json>');
  process.exit(args.help ? 0 : 2);
}

const requestedPrototypePath = path.resolve(args.prototype);
const prototypeRoot = await realpath(path.dirname(requestedPrototypePath));
const prototypePath = path.join(prototypeRoot, path.basename(requestedPrototypePath));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(prototypeRoot, 'review');
const schema = await readJsonSchema(path.resolve(scriptDir, '..', 'assets', 'prototype.schema.json'));
const config = normalizeAndValidate(JSON.parse(await readFile(prototypePath, 'utf8')), schema, 'prototype');
const shellRoot = path.resolve(scriptDir, '..', 'assets', 'review-shell');
const existingOutput = await pathInfo(output);
if (existingOutput) await assertOwnedOutput(output, prototypeRoot);

const temporary = await mkdtemp(path.join(prototypeRoot, '.review.tmp-'));
let adopted = false;
try {
  for (const file of shellFiles) {
    await copyFile(path.join(shellRoot, file), path.join(temporary, file));
  }
  await writeFile(path.join(temporary, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(temporary, ownerMarkerName), `${JSON.stringify(ownerMarker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await adoptOutput(temporary, output, prototypeRoot, existingOutput !== null);
  adopted = true;
} finally {
  if (!adopted) await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, prototypeRoot, output, reviewUrlPath: '/review/index.html' }));
