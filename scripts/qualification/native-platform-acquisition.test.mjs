import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installClientPackage, prepareEnvironment } from './native-platform-runtime.mjs';

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
        const logs = path.join(root, 'npm-cache', '_logs');
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
            const logs = path.join(root, 'npm-cache', '_logs');
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
