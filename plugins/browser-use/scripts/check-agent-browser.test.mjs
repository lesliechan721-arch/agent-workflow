import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-agent-browser.mjs', import.meta.url));

test('preApply accepts an executable agent-browser on PATH', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'browser-use-pre-apply-'));
  try {
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const executable = path.join(bin, 'agent-browser');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    const result = spawnSync(process.execPath, [script], { env: { PATH: bin }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preApply blocks installation when agent-browser is absent', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'browser-use-pre-apply-'));
  try {
    const result = spawnSync(process.execPath, [script], { env: { PATH: root }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /agent-browser is unavailable on PATH/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
