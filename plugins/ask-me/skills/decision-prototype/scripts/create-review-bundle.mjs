#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { normalizeAndValidate, readJsonSchema } from './review-contract.mjs';

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

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.prototype) {
  console.log('Usage: create-review-bundle.mjs --prototype <prototype.json>');
  process.exit(args.help ? 0 : 2);
}

const prototypePath = path.resolve(args.prototype);
const prototypeRoot = path.dirname(prototypePath);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(prototypeRoot, 'review');
const schema = await readJsonSchema(path.resolve(scriptDir, '..', 'assets', 'prototype.schema.json'));
const config = normalizeAndValidate(JSON.parse(await readFile(prototypePath, 'utf8')), schema, 'prototype');
const shellRoot = path.resolve(scriptDir, '..', 'assets', 'review-shell');
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'app.js', 'review-policy.mjs', 'styles.css']) {
  await cp(path.join(shellRoot, file), path.join(output, file));
}
await writeFile(path.join(output, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, prototypeRoot, output, reviewUrlPath: '/review/index.html' }));
