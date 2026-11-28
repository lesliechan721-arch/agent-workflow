import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clientCacheIdentity, clientCacheComplete } from './native-platforms.mjs';
import { clients, sha256, installClientPackage, prepareEnvironment } from './native-platform-runtime.mjs';

// Test Value Gate: acquisition reports must retain elapsed time and fixed npm
// phases on success and failure without exporting private npm log data.
test('records bounded install timing and preserves the download command contract', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-acquisition-test-'));
  try {
    await prepareEnvironment(root);
    const download = await installClientPackage({ package: 'fixture-client', version: '1.0.0' }, root,
      { executable: process.execPath, prefix: ['fixture-npm.mjs'] }, async (command, args, options) => {
        assert.equal(command, process.execPath);
        assert(args.includes('--ignore-scripts')); assert(args.includes('--timing'));
        assert.equal(args.at(-1), 'fixture-client@1.0.0');
        assert.equal(options.timeout, 180_000); assert.equal(options.killSignal, 'SIGKILL');
        assert.equal(options.env.HOME, path.join(root, 'home'));
        const logs = path.join(root, 'npm-logs');
        assert.equal(options.env.npm_config_logs_dir, logs);
        await fs.mkdir(logs, { recursive: true });
        await fs.writeFile(path.join(logs, 'fixture-timing.json'), JSON.stringify({
          timers: { npm: 25, idealTree: 10, reify: 15, 'fetch:private-url': 8 },
          unfinishedTimers: { 'reify:unpack': ['private-log-data'], 'private-path': [1, 2] },
          metadata: { secret: 'private-log-data' },
        }));
      });
    assert.equal(download.status, 'completed'); assert.equal(download.timeoutMs, 180_000);
    assert(download.elapsedMs >= 0); assert(download.completedAt >= download.startedAt);
    assert.deepEqual(download.npmTiming, { state: 'captured', timers: { npm: 25, idealTree: 10, reify: 15 }, unfinished: ['reify:unpack'] });
    assert(!JSON.stringify(download).includes('private-'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('retains a failed install and distinguishes unavailable timing from an exceeded log limit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-acquisition-test-'));
  try {
    await prepareEnvironment(root);
    for (const oversized of [false, true]) {
      const cause = Object.assign(new Error('controlled install failure'), { code: null, signal: 'SIGKILL', killed: true, stderr: 'controlled warning' });
      await assert.rejects(installClientPackage({ package: 'fixture-client', version: '1.0.0' }, root,
        { executable: process.execPath, prefix: [] }, async () => {
          if (oversized) {
            const logs = path.join(root, 'npm-logs');
            await fs.mkdir(logs, { recursive: true });
            await fs.writeFile(path.join(logs, 'fixture-timing.json'), Buffer.alloc(256 * 1024 + 1));
          }
          throw cause;
        }), error => {
        assert.equal(error.message, 'client-install-failed'); assert.equal(error.cause, cause);
        assert.equal(error.evidence.signal, 'SIGKILL'); assert.equal(error.evidence.killed, true);
        assert.equal(error.evidence.download.status, 'failed');
        assert.equal(error.evidence.download.deadlineReached, false);
        assert(error.evidence.download.elapsedMs >= 0);
        assert.equal(error.evidence.download.npmTiming.state, oversized ? 'over-limit' : 'missing');
        return true;
      });
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// Test Value Gate: a shared content cache must never make one download report
// another client's timing, including when downloads overlap and one fails.
test('shares npm downloads but keeps prefixes and success/failure timing separate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-acquisition-cache-test-'));
  const cache = path.join(root, 'shared-cache');
  const previousCache = process.env.AW_QUALIFICATION_NPM_CACHE;
  process.env.AW_QUALIFICATION_NPM_CACHE = cache;
  try {
    await fs.mkdir(path.join(cache, '_logs'), { recursive: true });
    await fs.writeFile(path.join(cache, '_logs', 'unrelated-timing.json'), JSON.stringify({ timers: { npm: 999 } }));
    const roots = [path.join(root, 'first'), path.join(root, 'second')];
    await Promise.all(roots.map(installRoot => prepareEnvironment(installRoot)));
    const results = await Promise.allSettled(roots.map((installRoot, index) =>
      installClientPackage({ package: 'fixture-client', version: '1.0.0' }, installRoot,
        { executable: process.execPath, prefix: [] }, async (_command, args, options) => {
          const prefix = args[args.indexOf('--prefix') + 1];
          assert.equal(prefix, path.join(installRoot, 'tool'));
          assert.equal(await fs.stat(prefix).then(() => true, () => false), false);
          assert.equal(options.env.npm_config_cache, cache);
          const logs = options.env.npm_config_logs_dir;
          assert.equal(logs, path.join(installRoot, 'npm-logs'));
          await fs.mkdir(logs, { recursive: true });
          await fs.writeFile(path.join(logs, 'fixture-timing.json'), JSON.stringify({ timers: { npm: index + 1 } }));
          if (index === 1) throw Object.assign(new Error('install failed'), { code: 1 });
        })));
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.deepEqual(results[0].value.npmTiming, { state: 'captured', timers: { npm: 1 }, unfinished: [] });
    assert.deepEqual(results[1].reason.evidence.download.npmTiming, { state: 'captured', timers: { npm: 2 }, unfinished: [] });
  } finally {
    if (previousCache === undefined) delete process.env.AW_QUALIFICATION_NPM_CACHE;
    else process.env.AW_QUALIFICATION_NPM_CACHE = previousCache;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Only the selected fixed packages invalidate a cache key, regardless of selection order.
test('binds the content cache identity to the selected fixed package manifest', () => {
  const expected = sha256(JSON.stringify([
    ['claude', '@anthropic-ai/claude-code', clients.claude.version],
    ['pi', '@earendil-works/pi-coding-agent', clients.pi.version],
  ]));
  assert.equal(clientCacheIdentity('pi,claude'), expected);
  assert.equal(clientCacheIdentity('claude,pi'), expected);
  assert.equal(clientCacheIdentity('all'), clientCacheIdentity(Object.keys(clients).join(',')));
  assert.notEqual(clientCacheIdentity('pi'), expected);
  assert.throws(() => clientCacheIdentity('pi,unknown'), /invalid-arguments/);
});

// npm prefix/entry validation completes before acquisition is attached. An immutable
// cache may survive later business failures, but a partial group must remain refillable.
test('saves downloads only after all applicable selected acquisitions succeeded', () => {
  function acquired(platform) {
    const { package: name, version, source } = clients[platform];
    return { platform, status: 'failed', acquisition: { package: name, version, source, download: { status: 'completed' } } };
  }
  const copilot = acquired('copilot');
  const grok = acquired('grok');
  const excluded = { platform: 'grok', status: 'excluded', reason: 'official-client-distribution-unavailable' };
  const host = { platform: 'win32', arch: 'x64' };
  const complete = (rows, arch = 'x64') => clientCacheComplete('copilot,grok', { clients: rows }, { ...host, arch });
  assert(complete([grok, copilot]));
  assert(complete([copilot, excluded], 'arm64'));
  for (const rows of [[copilot], [copilot, copilot], [copilot, excluded], [copilot, acquired('claude')],
    [copilot, { platform: 'grok', evidence: { download: { status: 'completed' } } }],
    ...[{ source: 'foreign' }, { version: 'unknown' }, { download: { status: 'failed' } }, { download: {} }]
      .map(override => [copilot, { ...grok, acquisition: { ...grok.acquisition, ...override } }])]) {
    assert.equal(complete(rows), false);
  }
  assert.equal(clientCacheComplete('grok', { clients: [excluded] }, { platform: 'darwin', arch: 'x64' }), false);
});

test('prepares independent canonical Grok executables in fresh isolated homes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-grok-homes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'verified.exe');
  await fs.writeFile(binary, 'acquired bytes');
  const prepare = async name => {
    const env = await prepareEnvironment(path.join(root, name), binary);
    return path.join(env.GROK_HOME, 'bin', 'grok.exe');
  };
  const [a, b] = await Promise.all([prepare('user'), prepare('project')]);
  assert.equal(await fs.readFile(a, 'utf8'), 'acquired bytes');
  await fs.writeFile(a, 'changed private copy');
  assert.equal(await fs.readFile(b, 'utf8'), 'acquired bytes');
  assert.equal(await fs.readFile(binary, 'utf8'), 'acquired bytes');
  await assert.rejects(prepare('user'), { code: 'EEXIST' });
});
