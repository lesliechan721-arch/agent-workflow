import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const require = createRequire(import.meta.url);
const cases = require.resolve('./fixtures/codex-profile-cases.mjs');
const packageRoot = fileURLToPath(new URL('./', import.meta.url));
const scripts = guideRuntimeScripts(new URL('./', import.meta.url));

// Test Value Gate: run the field and trust cases against a moved installation,
// whose literal imports cannot reach source files or host dependency folders.
test('installed Codex profile conversion and hook provenance contracts', async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-codex-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const movedScripts = path.join(root, 'skills/codex-subagent-guide/scripts');
  await fs.cp(scripts, movedScripts, { recursive: true });
  const entry = path.join(movedScripts, 'adapters/codex-profile.mjs');
  if (process.env.AW_PLUGIN_EVENT !== 'test') {
    const bundled = await build({ entryPoints: [entry], nodePaths: [path.join(packageRoot, 'node_modules')], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, logLevel: 'silent' });
    await fs.writeFile(entry, bundled.outputFiles[0].contents);
  }
  const movedCases = path.join(root, 'scripts/fixtures/codex-profile-cases.mjs');
  await fs.mkdir(path.dirname(movedCases), { recursive: true });
  await fs.copyFile(cases, movedCases);
  const child = spawn(process.execPath, ['--test', movedCases], { cwd: root, env: { ...process.env, NODE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output);
});
