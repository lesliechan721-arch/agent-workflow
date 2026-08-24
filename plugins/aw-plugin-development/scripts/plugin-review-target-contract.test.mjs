import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const runtimeRoot = context?.platform ? path.join(localRoot, context.platform) : localRoot;
const discover = path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/discover-aw-review-targets.mjs');
const sourceRoot = context?.sourceRoot ?? localRoot;
const skillValidatorBin = path.resolve(sourceRoot, '..', '..', 'packages', 'cli', 'dist', 'index.js');
const temps = [];
after(async () => Promise.all(temps.map((entry) => rm(entry, { recursive: true, force: true }))));

test('target discovery emits one bounded single-plugin review inventory', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-plugin-review-target-'));
  temps.push(temp);
  const plugin = path.join(temp, 'review-chain');
  const inspect = path.join(plugin, 'skills', 'inspect');
  const review = path.join(plugin, 'skills', 'review');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(inspect, { recursive: true });
  await mkdir(review, { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'review-chain', version: '0.1.0', skills: './skills' }));
  await writeFile(path.join(inspect, 'SKILL.md'),
    '---\nname: inspect\ndescription: Inspect one plugin.\n---\n');
  await writeFile(path.join(review, 'SKILL.md'),
    '---\nname: review\ndescription: Review one plugin.\n---\n');

  const { stdout } = await execFileAsync(process.execPath, [discover, plugin, '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, AW_SKILL_VALIDATOR_BIN: skillValidatorBin },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.plugin, 'review-chain');
  assert.equal(result.targets.length, 2);
  assert.equal(result.pluginReview.id, 'aw-plugin:review-chain');
  assert.deepEqual(result.pluginReview.targetIds, result.targets.map((target) => target.id));
  assert.equal('providedStages' in result, false);
  assert.equal('releaseReadiness' in result, false);
});
