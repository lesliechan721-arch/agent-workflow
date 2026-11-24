import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const require = createRequire(import.meta.url);
const cases = require.resolve('./fixtures/codex-profile-cases.mjs');
const scripts = guideRuntimeScripts(new URL('./', import.meta.url));

if (process.env.AW_PLUGIN_EVENT !== 'test') {
  await import('./fixtures/codex-profile-cases.mjs');
} else {
  test('relocated command package preserves profile and platform behavior', checkRelocatedPackage);
}

// Test Value Gate: exercise the staged command package after moving it away
// from the plugin's build dependencies.
async function checkRelocatedPackage(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-codex-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const movedScripts = path.join(root, 'commands/scripts');
  await fs.cp(scripts, movedScripts, { recursive: true });
  // The Windows runtime embeds the generated reader from staging.
  await fs.rm(path.join(movedScripts, 'runtime/native-tool-reader.mjs'), { force: true });
  const movedCases = path.join(root, 'scripts/fixtures/codex-profile-cases.mjs');
  await fs.mkdir(path.dirname(movedCases), { recursive: true });
  await fs.copyFile(cases, movedCases);
  const env = { ...process.env, NODE_PATH: '' };
  // Start a new test runner with its own exit status.
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--test', movedCases], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output);
}
