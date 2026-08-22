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
const sourceRoot = context?.sourceRoot ?? localRoot;
const runtimeRoot = context?.platform ? path.join(localRoot, context.platform) : localRoot;
const discover = path.join(
  runtimeRoot,
  'skills/review-aw-plugin/scripts/discover-aw-review-targets.mjs',
);
const temps = [];

after(async () => Promise.all(
  temps.map((entry) => rm(entry, { recursive: true, force: true })),
));

async function runDiscover(pluginRoot, args = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [discover, pluginRoot, ...args, '--format', 'json'],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

test('target discovery emits one plugin-level composition review target', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-plugin-review-target-'));
  temps.push(temp);
  const plugin = path.join(temp, 'review-chain');
  const inspect = path.join(plugin, 'skills', 'inspect');
  const review = path.join(plugin, 'skills', 'review');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(path.join(inspect, 'assets'), { recursive: true });
  await mkdir(path.join(review, 'assets'), { recursive: true });
  await writeFile(
    path.join(plugin, '.agents-plugin', 'plugin.json'),
    JSON.stringify({ name: 'review-chain', version: '0.1.0', skills: './skills' }),
  );
  await writeFile(
    path.join(inspect, 'SKILL.md'),
    '---\nname: inspect\ndescription: Inspect one plugin.\n---\n\nWrite assets/context.json.\n',
  );
  await writeFile(path.join(inspect, 'assets', 'context.json'), '{}\n');
  await writeFile(
    path.join(review, 'SKILL.md'),
    '---\nname: review\ndescription: Review one inspected plugin.\n---\n\nWrite assets/summary.json.\n',
  );
  await writeFile(path.join(review, 'assets', 'summary.json'), '{}\n');

  const result = await runDiscover(plugin);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.plugin, 'review-chain');
  assert.equal(result.targets.length, 2);
  assert.equal(result.pluginReview.id, 'aw-plugin:review-chain');
  assert.equal(result.pluginReview.targetLevel, 'plugin');
  assert.equal(result.pluginReview.reviewRoot, plugin);
  assert.deepEqual(
    result.pluginReview.targetIds,
    result.targets.map((target) => target.id),
  );
  assert.deepEqual(
    result.pluginReview.uniqueDigests,
    [...new Set(result.targets.map((target) => target.digest))].sort(),
  );
  assert.deepEqual(result.pluginReview.materializedProfiles, []);
  assert.equal(result.pluginReview.machineCheck.ok, true);
  assert.deepEqual(result.pluginReview.machineCheck.blockedTargetIds, []);
  assert.equal('providedStages' in result, false);
  assert.equal('profileCoverage' in result, false);
  assert.equal('releaseReadiness' in result, false);
});
