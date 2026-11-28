import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { partitionByDuration } from '../../packages/cli/scripts/integration-sequencer.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Test Value Gate: slow files must not collect on one runner, and timing data
// must never become an allowlist that silently drops new or renamed tests.
test('duration placement balances heavy files and preserves every discovered specification', () => {
  const root = path.resolve('integration-fixture');
  const names = ['heavy.test.ts', 'medium.test.ts', 'small.test.ts', 'new.test.tsx'];
  const files = names.map((name) => ({ moduleId: path.join(root, name) }));
  const seconds = { 'heavy.test.ts': 100, 'medium.test.ts': 60, 'small.test.ts': 40, 'deleted.test.ts': 1 };
  const shards = partitionByDuration(files, 2, root, seconds);
  assert.equal(shards.flat().length, files.length);
  assert.deepEqual(new Set(shards.flat()), new Set(files));
  assert.notEqual(shards.findIndex((s) => s.includes(files[0])), shards.findIndex((s) => s.includes(files[1])));
  assert.deepEqual(partitionByDuration([...files].reverse(), 2, root, seconds), shards);
  const measured = partitionByDuration(files.slice(0, 3), 2, root, seconds);
  assert.deepEqual(measured.map((s) => s.reduce((total, spec) => total + seconds[path.basename(spec.moduleId)], 0)), [100, 100]);
  assert.equal(partitionByDuration(files, 7, root, {}).flat().length, files.length);
});

// Exercise the real CLI hook, including .tsx and a file absent from the profile.
// The public list output proves shard coverage without running product tests.
test('Vitest list applies all platform profiles with complete, disjoint shards', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-integration-shards-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.symlink(await fs.realpath(path.join(repoRoot, 'packages/cli/node_modules/vitest')),
    path.join(root, 'node_modules/vitest'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(root, 'vitest.config.mjs'), `import Sequencer from ${JSON.stringify(new URL('../../packages/cli/scripts/integration-sequencer.mjs', import.meta.url).href)};
  export default {
    test: { sequence: { sequencer: Sequencer }, projects: [{ test: { name: 'integration', include: ['tests/integration/**/*.test.{ts,tsx}'] } }] }
  };`);
  const names = [
    'catalog-git-publisher-journal.test.ts', 'write-commands-config-values.test.ts',
    'write-commands-dependency-scope-placement.test.ts', 'new.test.tsx',
    'joint-recovery-install.test.ts', 'portable-scope.test.ts',
    'recovery-native-dispatch-cursor-pi.test.ts', 'recovery-native-dispatch-grok-trust.test.ts',
  ];
  await fs.mkdir(path.join(root, 'tests/integration'), { recursive: true });
  for (const name of names) {
    await fs.writeFile(path.join(root, 'tests/integration', name), "import { test } from 'vitest'; test('is discovered', () => {});\n");
  }
  for (const [platform, count] of [['win32', 8], ['darwin', 2], ['linux', 2]]) {
    const all = [];
    for (let index = 1; index <= count; index++) {
      const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/test/run-vitest.mjs'),
        'list', '--project', 'integration', '--shard', `${index}/${count}`, '--json'], {
        cwd: root,
        env: { ...process.env, AW_TEST_WORKERS: '1', AW_TEST_SHARD_PLATFORM: platform },
        encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.trim(), `No list output for ${platform} ${index}/${count}: ${result.stderr}`);
      const listed = JSON.parse(result.stdout);
      all.push(...new Set(listed.map((entry) => path.basename(entry.file))));
    }
    assert.equal(all.length, names.length, platform);
    assert.deepEqual([...all].sort(), [...names].sort(), platform);
  }
});
