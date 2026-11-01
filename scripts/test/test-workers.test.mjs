import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { parseTestWorkerCount, resolveTestWorkers } from '../../packages/cli/scripts/test-workers.mjs';
import { EXPECTED_PERF_SUMMARY_NAMES, runPerfGate } from '../perf/run-perf-gate.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roots = [];
after(async () => Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))));

test('worker counts accept decimal positive safe integers and reject invalid values', () => {
  for (const [value, expected] of [['1', 1], ['04', 4], ['9007199254740991', Number.MAX_SAFE_INTEGER]]) {
    assert.equal(parseTestWorkerCount(value), expected);
  }
  for (const value of ['0', '-1', '1.5', '50%', 'x', ' ', ' 2', '+2', '1e2', 'Infinity', '9007199254740992']) {
    assert.throws(() => parseTestWorkerCount(value), /AW_TEST_WORKERS.*received/u);
  }
  assert.deepEqual(resolveTestWorkers({ env: {} }), { maxWorkers: 2, source: 'default' });
  assert.deepEqual(resolveTestWorkers({ env: { AW_TEST_WORKERS: '' } }), { maxWorkers: 2, source: 'default' });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-test-workers-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.symlink(await fs.realpath(path.join(repoRoot, 'packages/cli/node_modules/vitest')), path.join(root, 'node_modules/vitest'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const helperUrl = new URL('../../packages/cli/scripts/test-workers.mjs', import.meta.url).href;
  for (const [name, serial] of [['vitest.config.mjs', false], ['vitest.fast.config.mjs', false], ['vitest.smoke.config.mjs', true], ['vitest.perf.config.mjs', true]]) {
    await fs.writeFile(path.join(root, name), [
      `import { vitestWorkerOptions } from ${JSON.stringify(helperUrl)};`,
      `export default { test: { include: ['*.test.mjs'], pool: 'forks', ...vitestWorkerOptions({ serial: ${serial} }), fileParallelism: ${!serial} } };`,
    ].join('\n'));
  }
  for (let id = 0; id < 4; id += 1) {
    await fs.writeFile(path.join(root, `${id}.test.mjs`), [
      "import { test } from 'vitest';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "test('records actual file concurrency', async () => {",
      `  fs.writeFileSync(path.join(process.env.PROBE_ROOT, 'started-${id}'), '');`,
      `  fs.appendFileSync(path.join(process.env.PROBE_ROOT, 'events'), 'start ${id}\\n');`,
      '  const deadline = Date.now() + 5000;',
      "  while (fs.readdirSync(process.env.PROBE_ROOT).filter((name) => name.startsWith('started-')).length < Number(process.env.EXPECT_PARALLEL)) {",
      "    if (Date.now() > deadline) throw new Error('Workers did not run in parallel');",
      '    await new Promise((resolve) => setTimeout(resolve, 10));',
      '  }',
      '  await new Promise((resolve) => setTimeout(resolve, 50));',
      `  fs.appendFileSync(path.join(process.env.PROBE_ROOT, 'events'), 'end ${id}\\n');`,
      '});',
    ].join('\n'));
  }
  return root;
}

async function launch(root, { workers = '', args = [], expected = 1 } = {}) {
  const probe = await fs.mkdtemp(path.join(root, 'probe-'));
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/test/run-vitest.mjs'), 'run', ...args], {
    cwd: root,
    env: { ...process.env, AW_TEST_WORKERS: workers, AW_TEST_METRICS_DIR: '', PROBE_ROOT: probe, EXPECT_PARALLEL: String(expected) },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.error, undefined);
  const events = await fs.readFile(path.join(probe, 'events'), 'utf8').catch(() => '');
  let active = 0;
  let peak = 0;
  for (const line of events.trim().split('\n').filter(Boolean)) {
    active += line.startsWith('start') ? 1 : -1;
    peak = Math.max(peak, active);
  }
  return { ...result, peak, events };
}

test('real Vitest startup uses defaults, environment values, and explicit precedence', async () => {
  const root = await fixture();
  for (const options of [
    { expected: 2, source: 'default' },
    { workers: '1', expected: 1, source: 'environment' },
    { workers: '4', expected: 4, source: 'environment' },
    { workers: '4', args: ['--maxWorkers', '2', '--minWorkers=1'], expected: 2, source: 'explicit parameter' },
  ]) {
    const result = await launch(root, options);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.peak, options.expected);
    assert.match(result.stderr, new RegExp(`"maxWorkers":${options.expected},"source":"${options.source}"`, 'u'));
  }
});

test('invalid workers and serial overrides fail before any test file starts', async () => {
  const root = await fixture();
  for (const options of [
    { workers: '0', error: /AW_TEST_WORKERS.*"0"/u },
    { workers: 'wat', args: ['--maxWorkers=2'], error: /AW_TEST_WORKERS.*"wat"/u },
    { args: ['--maxWorkers=50%'], error: /--maxWorkers.*50%/u },
    { args: ['--maxWorkers=1', '--minWorkers=2'], error: /minWorkers.*cannot exceed/u },
    { args: ['--config', 'vitest.smoke.config.mjs', '--maxWorkers=2'], error: /requires 1 worker/u },
    { args: ['--project', 'process-lifecycle', '--maxWorkers=2'], error: /requires 1 worker/u },
  ]) {
    const result = await launch(root, options);
    assert.equal(result.status, 1);
    assert.equal(result.events, '');
    assert.match(result.stderr, options.error);
  }
  const serial = await launch(root, { workers: '4', args: ['--config', 'vitest.smoke.config.mjs'] });
  assert.equal(serial.status, 0, serial.stdout + serial.stderr);
  assert.equal(serial.peak, 1);
  assert.match(serial.stderr, /"maxWorkers":1,"source":"serial constraint"/u);
});

test('performance gate keeps real serial and fast-lane baselines despite invalid tuning environment', async () => {
  const root = await fixture();
  const observed = [];
  await runPerfGate({
    env: { ...process.env, AW_TEST_WORKERS: 'invalid' },
    runChild: async (label, args, _timeout, env) => {
      const expected = label === 'fast unit lane' ? 2 : 1;
      const forwarded = args.slice(args.indexOf('run') + 1).map((arg) => arg.replace(/\.config\.ts$/u, '.config.mjs'));
      const result = await launch(root, { workers: env.AW_TEST_WORKERS, args: forwarded, expected });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      observed.push(result.peak);
      return { stdout: EXPECTED_PERF_SUMMARY_NAMES.map((name) => `AW_PERF_SUMMARY ${JSON.stringify({ name })}`).join('\n') };
    },
    log: () => {},
  });
  assert.deepEqual(observed, [1, 2]);
});
