#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const current = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === current;
if (isMain) {
  const target = path.resolve(path.dirname(current), '../../../scripts/legacy-review/inspect-aw-target.mjs');
  const child = spawn(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.once('error', (error) => {
    process.stderr.write('[ERROR] ' + error.message + '\n');
    process.exit(1);
  });
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
