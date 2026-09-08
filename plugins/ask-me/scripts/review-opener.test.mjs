import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { promisify } from 'node:util';

import { requestBrowserOpen } from '../skills/decision-prototype/scripts/review-opener.mjs';

const privateToken = 'private_token_12345678901234567890123456789';
const reviewUrl = `http://127.0.0.1:43127/review/index.html#token=${privateToken}`;
const execFileAsync = promisify(execFile);

function fakeSpawn({ code = 0, error, hang = false } = {}) {
  const calls = [];
  let killed = false;
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = () => {
      killed = true;
      return true;
    };
    if (!hang) {
      queueMicrotask(() => {
        if (error) child.emit('error', error);
        else child.emit('close', code);
      });
    }
    return child;
  };
  return { calls, spawnProcess, wasKilled: () => killed };
}

function options(platform, fake, env = {}) {
  return {
    platform,
    env,
    osRelease: 'test release',
    pathExists: async () => false,
    spawnProcess: fake.spawnProcess,
  };
}

test('uses each supported platform opener with an argument array and no shell', async () => {
  const cases = [
    ['darwin', {}, 'open', [reviewUrl]],
    ['win32', {}, 'rundll32.exe', ['url.dll,FileProtocolHandler', reviewUrl]],
    ['linux', { DISPLAY: ':1' }, 'xdg-open', [reviewUrl]],
  ];

  for (const [platform, env, command, args] of cases) {
    const fake = fakeSpawn();
    assert.deepEqual(
      await requestBrowserOpen(reviewUrl, options(platform, fake, env)),
      { status: 'requested', method: 'system-browser' },
    );
    assert.deepEqual(fake.calls, [{
      command,
      args,
      options: { shell: false, stdio: 'ignore', windowsHide: true },
    }]);
  }
});

test('rejects non-loopback and non-HTTP URLs before starting a process', async () => {
  const invalidUrls = [
    `https://127.0.0.1:43127/review/index.html#token=${privateToken}`,
    `http://example.com:43127/review/index.html#token=${privateToken}`,
    `http://user:password@localhost:43127/review/index.html#token=${privateToken}`,
    `http://localhost/review/index.html#token=${privateToken}`,
    `http://localhost:0/review/index.html#token=${privateToken}`,
    `http://localhost:43127/other#token=${privateToken}`,
    `http://localhost:43127/review/index.html?token=${privateToken}`,
    'http://localhost:43127/review/index.html#token=short',
    `http://localhost:43127/review/index.html#token=${privateToken}&next=other`,
    'file:///tmp/review.html',
    'not a URL',
  ];
  const fake = fakeSpawn();

  for (const url of invalidUrls) {
    const opened = await requestBrowserOpen(url, options('darwin', fake));
    assert.equal(opened.status, 'failed');
    assert.equal(opened.method, 'system-browser');
    assert.doesNotMatch(opened.reason, /password|private_token/);
  }
  assert.deepEqual(fake.calls, []);
});

test('reports remote, container, WSL, and headless environments as unavailable', async () => {
  const cases = [
    options('darwin', fakeSpawn(), { SSH_CONNECTION: 'private remote value' }),
    {
      ...options('linux', fakeSpawn(), { DISPLAY: ':1' }),
      pathExists: async (filePath) => filePath === '/.dockerenv',
    },
    { ...options('linux', fakeSpawn(), { DISPLAY: ':1' }), osRelease: '5.15.0-microsoft-standard-WSL2' },
    options('linux', fakeSpawn(), {}),
    options('win32', fakeSpawn(), { SESSIONNAME: 'Services' }),
    options('darwin', fakeSpawn(), { CI: '1' }),
  ];

  for (const environment of cases) {
    const opened = await requestBrowserOpen(reviewUrl, environment);
    assert.equal(opened.status, 'unavailable');
    assert.equal(opened.method, 'system-browser');
    assert.doesNotMatch(opened.reason, /private remote value|private_token/);
  }
});

test('reports missing, rejected, and failed opener processes without process details', async () => {
  const missing = fakeSpawn({ error: Object.assign(new Error(privateToken), { code: 'ENOENT' }) });
  assert.deepEqual(await requestBrowserOpen(reviewUrl, options('darwin', missing)), {
    status: 'unavailable',
    method: 'system-browser',
    reason: 'The system browser opener is not available.',
  });

  const denied = fakeSpawn({ error: Object.assign(new Error(privateToken), { code: 'EACCES' }) });
  const deniedResult = await requestBrowserOpen(reviewUrl, options('darwin', denied));
  assert.equal(deniedResult.status, 'failed');
  assert.doesNotMatch(deniedResult.reason, /private_token/);

  const rejected = fakeSpawn({ code: 2 });
  const rejectedResult = await requestBrowserOpen(reviewUrl, options('darwin', rejected));
  assert.equal(rejectedResult.status, 'failed');
  assert.doesNotMatch(rejectedResult.reason, /private_token/);

  const thrownResult = await requestBrowserOpen(reviewUrl, {
    ...options('darwin', fakeSpawn()),
    spawnProcess: () => { throw new Error(privateToken); },
  });
  assert.equal(thrownResult.status, 'failed');
  assert.doesNotMatch(thrownResult.reason, /private_token/);
});

test('bounds the opener process without waiting for a browser process', async () => {
  const hanging = fakeSpawn({ hang: true });
  const startedAt = Date.now();
  const opened = await requestBrowserOpen(reviewUrl, {
    ...options('darwin', hanging),
    timeoutMs: 20,
  });

  assert.equal(opened.status, 'failed');
  assert.equal(hanging.wasKilled(), true);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.doesNotMatch(opened.reason, /private_token/);
});

test('a launcher that ignores SIGTERM does not keep the calling process alive', async () => {
  const openerUrl = new URL(
    '../skills/decision-prototype/scripts/review-opener.mjs',
    import.meta.url,
  ).href;
  const launcherLifetimeMs = 800;
  const program = `
    import { spawn } from 'node:child_process';
    import { requestBrowserOpen } from ${JSON.stringify(openerUrl)};
    const launcher = spawn(process.execPath, [
      '-e',
      ${JSON.stringify(`process.on('SIGTERM', () => {}); process.send('ready'); setTimeout(() => process.exit(0), ${launcherLifetimeMs})`)},
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise((resolve, reject) => {
      launcher.once('message', resolve);
      launcher.once('error', reject);
      launcher.once('exit', (code) => reject(new Error('launcher exited before ready: ' + code)));
    });
    await new Promise((resolve) => {
      launcher.once('disconnect', resolve);
      launcher.disconnect();
    });
    const spawnProcess = () => launcher;
    await requestBrowserOpen(${JSON.stringify(reviewUrl)}, {
      platform: 'darwin',
      env: {},
      spawnProcess,
      timeoutMs: 20,
    });
  `;
  const startedAt = Date.now();

  await execFileAsync(process.execPath, ['--input-type=module', '-e', program], { timeout: 500 });
  const callerDurationMs = Date.now() - startedAt;
  assert.ok(callerDurationMs < 500, 'the timed-out launcher must not keep the caller alive');

  await new Promise((resolve) => setTimeout(resolve, launcherLifetimeMs - callerDurationMs + 100));
});

test('unsupported platforms are unavailable without starting a process', async () => {
  const fake = fakeSpawn();
  assert.deepEqual(await requestBrowserOpen(reviewUrl, options('aix', fake)), {
    status: 'unavailable',
    method: 'system-browser',
    reason: 'System browser opening is unavailable on this platform.',
  });
  assert.deepEqual(fake.calls, []);
});
