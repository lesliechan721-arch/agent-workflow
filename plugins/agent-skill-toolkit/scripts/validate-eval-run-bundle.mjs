#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateEvalRunBundleRuntime } from './eval-run-bundle-validator.mjs';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return 'Usage: validate-eval-run-bundle.mjs <bundle.json> [--format text|json]';
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let format = 'text';
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  return { bundlePath: positional[0], format };
}

async function firstReadable(candidates) {
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next canonical or distributed copy.
    }
  }
  throw new Error('Cannot locate EvalRunBundle schema.');
}

async function schemaErrors(bundlePath) {
  const schemaPath = await firstReadable([
    path.join(scriptRoot, '..', 'assets', 'eval-run-bundle.schema.json'),
  ]);
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(scriptRoot, 'validate-json-contract.mjs'),
        schemaPath,
        bundlePath,
        '--format',
        'json',
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(stdout).errors;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim())
      return JSON.parse(error.stdout).errors;
    throw error;
  }
}

export async function validateEvalRunBundle(bundlePath, options = {}) {
  return validateEvalRunBundleRuntime(bundlePath, {
    ...options,
    schemaErrors: await schemaErrors(bundlePath),
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await validateEvalRunBundle(options.bundlePath);
  process.stdout.write(
    options.format === 'json'
      ? `${JSON.stringify(result, null, 2)}\n`
      : result.valid
        ? 'EvalRunBundle is valid.\n'
        : `${result.errors.join('\n')}\n`,
  );
  if (!result.valid) process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
  : null;
const modulePath = await realpath(fileURLToPath(import.meta.url)).catch(() =>
  path.resolve(fileURLToPath(import.meta.url)),
);
if (invokedPath === modulePath) {
  main().catch((error) => {
    process.stderr.write(`[ERROR] ${error.message}\n`);
    process.exit(1);
  });
}
