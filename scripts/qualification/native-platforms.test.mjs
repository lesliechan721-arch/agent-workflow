import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs, runScope, versionFrom, redact } from './native-platforms.mjs';
import { executePublicAw } from './native-platform-public-process.mjs';
import { isolatedEnvironment, prepareEnvironment, renderPackage, execute, assertCommand } from './native-platform-runtime.mjs';

// Test Value Gate: qualification must not turn missing prerequisites into a
// passing report, inherit user credentials, or leave an isolated client home.
test('requires an explicit client acquisition mode and rejects ambiguous inputs', () => {
  const base = ['--candidate', 'candidate.json', '--client', 'codex', '--report', 'report.json'];
  assert.throws(() => parseArgs(base), /invalid-arguments/);
  assert.throws(() => parseArgs([...base, '--install', '--executable', '/client']), /invalid-arguments/);
  assert.throws(() => parseArgs([...base, '--install', '--client', 'pi']), /invalid-arguments/);
  assert.throws(() => parseArgs(['--write-candidate', 'file', '--source-sha', 'abc', '--install']), /invalid-arguments/);
  assert.equal(parseArgs([...base, '--install']).install, true);
  assert.equal(parseArgs([...base, '--install', '--public-aw'])['public-aw'], true);
  assert.throws(() => parseArgs([...base, '--install', '--public-aw', '--public-aw']), /invalid-arguments/);
  assert.throws(() => parseArgs(['--write-candidate', 'file', '--source-sha', 'abc', '--public-aw']), /invalid-arguments/);
  assert.equal(versionFrom('codex-cli 0.167.0\n'), '0.167.0');
  assert.equal(versionFrom('2.1.317 (Claude Code)'), '2.1.317');
  assert.equal(versionFrom('GitHub Copilot CLI 1.0.95.\nRun copilot update'), '1.0.95');
  assert.equal(versionFrom('opencode v2.2.6\n'), '2.2.6');
  assert.equal(versionFrom('opencode v2.2.6-preview'), null);
  assert.equal(versionFrom('unknown'), null);
});

test('isolates configuration and does not pass arbitrary credentials or startup injection', () => {
  const before = process.env.AW_QUALIFICATION_TEST_SECRET;
  process.env.AW_QUALIFICATION_TEST_SECRET = 'private';
  try {
    const root = path.join(os.tmpdir(), 'qualification-env');
    const env = isolatedEnvironment(root);
    assert.equal(env.AW_QUALIFICATION_TEST_SECRET, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.HOME, path.join(root, 'home'));
    assert.equal(env.COPILOT_HOME, path.join(root, 'copilot'));
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1');
    assert.equal(isolatedEnvironment(root, true).GITHUB_TOKEN, undefined);
  } finally {
    if (before === undefined) delete process.env.AW_QUALIFICATION_TEST_SECRET;
    else process.env.AW_QUALIFICATION_TEST_SECRET = before;
  }
});

// Test Value Gate: RPC cleanup failures must retain response/exit ordering
// without placing response bodies or client environment values in diagnostics.
test('retains bounded RPC events for successful and rejected read-only responses', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-rpc-events-'));
  try {
    for (const rejected of [false, true]) {
      const fixture = path.join(root, `client-${rejected}.cjs`);
      await fs.writeFile(fixture, `
const readline = require('node:readline');
setTimeout(() => process.exit(2), 10000).unref();
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
  if (request.id === 2) process.stdout.write(JSON.stringify(${rejected
    ? "{ id: 2, error: { code: -32000, message: 'private-rpc-body' } }"
    : "{ id: 2, result: { data: [], privateBody: 'private-rpc-body' } }"}) + '\\n');
});
`);
      const result = await execute({ executable: process.execPath,
        prefix: [path.resolve('scripts/qualification/native-platform-rpc.mjs')] }, [], {
        cwd: root, env: await prepareEnvironment(root), timeoutMs: 10_000,
        stdin: JSON.stringify({ platform: 'codex', cwd: root,
          launcher: { executable: process.execPath, prefix: [fixture] } }),
      });
      assert.equal(result.exitCode, rejected ? 1 : 0);
      if (!rejected) assert.deepEqual(JSON.parse(result.stdout), { data: [], privateBody: 'private-rpc-body' });
      const diagnostics = result.stderr.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).find(item => item?.kind === 'aw-native-rpc-diagnostics');
      assert(diagnostics, 'RPC response and termination events must survive the subprocess boundary.');
      assert(diagnostics.events.length > 0 && diagnostics.events.length <= 32);
      const response = diagnostics.events.findIndex(event => event.event === 'response' && event.id === 2);
      const signal = diagnostics.events.findIndex(event => event.event === 'signal' && event.signal === 'SIGTERM');
      const closed = diagnostics.events.findIndex(event => event.event === 'child-close');
      assert(response >= 0 && signal > response && closed > signal);
      assert(diagnostics.events.every(event => Number.isFinite(event.atMs)));
      assert.equal(JSON.stringify(diagnostics).includes('private-rpc-body'), false);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('uses actual AW projection bytes for both candidate revisions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-projection-test-'));
  try {
    for (const platform of ['codex', 'pi', 'claude', 'gemini', 'copilot', 'grok']) {
      const current = path.join(root, platform); await fs.mkdir(current);
      const ctx = { root: current, platform, scope: 'user', project: current, env: await prepareEnvironment(current),
        pluginName: 'aw-qualification', skillName: 'aw-qualification', marketplaceName: 'aw-qualification-market',
        marketplace: path.join(current, 'source'), bundle: path.join(current, 'source/plugins/aw-qualification') };
      const first = await renderPackage(ctx, 1);
      const second = await renderPackage(ctx, 2);
      assert.notEqual(first.contentDigest, second.contentDigest);
      assert.match(await fs.readFile(path.join(ctx.bundle, 'skills/aw-qualification/SKILL.md'), 'utf8'), /revision 2/);
      const descriptor = { codex: '.codex-plugin/plugin.json', claude: '.claude-plugin/plugin.json',
        pi: 'package.json', gemini: 'gemini-extension.json', copilot: 'plugin.json', grok: '.grok-plugin/plugin.json' }[platform];
      const manifest = JSON.parse(await fs.readFile(path.join(ctx.bundle, descriptor), 'utf8'));
      assert.equal(manifest.name, ctx.pluginName);
      assert.equal(manifest.version, '1.0.2');
      if (platform === 'claude') {
        const market = JSON.parse(await fs.readFile(path.join(ctx.marketplace, '.claude-plugin/marketplace.json'), 'utf8'));
        assert.equal(market.plugins[0].version, '1.0.2');
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a real child version mismatch fails before public AW installation and cleans its temporary home', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-process-test-'));
  const observed = path.join(root, 'observed.json');
  const child = path.join(root, 'client.mjs');
  try {
    await fs.writeFile(child, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify({home:process.env.HOME,token:process.env.GITHUB_TOKEN,args:process.argv.slice(3)})); console.log('codex-cli 0.1.0');`);
    const report = await runScope('codex', 'project', { executable: process.execPath, prefix: [child, observed] }, { publicAw: true });
    assert.equal(report.status, 'failed');
    assert.equal(report.reason, 'client-version-mismatch');
    assert.equal(report.input, 'public-aw-cli');
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].status, 'failed');
    assert.equal(report.cleanup, 'completed');
    const data = JSON.parse(await fs.readFile(observed, 'utf8'));
    assert.deepEqual(data.args, ['--version']);
    assert.equal(data.token, undefined);
    await assert.rejects(fs.stat(data.home), { code: 'ENOENT' });
    assert.equal(JSON.stringify(report).includes(data.home), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a stalled client is bounded and cannot count as a successful command', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-timeout-test-'));
  try {
    const result = await execute({ executable: process.execPath, prefix: [] }, ['-e', 'setTimeout(()=>process.exit(0),10000);setInterval(()=>{},1000)'],
      { cwd: root, env: await prepareEnvironment(root), timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.throws(() => assertCommand(result), /command-timeout/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('redacts Windows paths nested inside public JSON identity strings', () => {
  const root = 'C:\\qualification';
  const client = 'C:\\download\\tool';
  const stdout = JSON.stringify({ id: JSON.stringify(['pi', `${client}\\pi.cmd`, `${root}\\pi`]) });
  const result = JSON.parse(redact({ stdout }, root, client).stdout);
  assert.deepEqual(JSON.parse(result.id), ['pi', '<CLIENT_BIN>\\pi.cmd', '<TEMP_ROOT>\\pi']);
});

async function publicProcessFixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-process-test-'));
  try { await action({ cwd: root, env: await prepareEnvironment(root), timeoutMs: 8_000 }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const posixOnly = { skip: process.platform === 'win32', timeout: 30_000 };
const nodeLauncher = { executable: process.execPath, prefix: [] };

// Test Value Gate: public AW owns detached native-command groups; observation
// must accept clean completion while retaining marker and cleanup failures.
test('public AW accepts independently grouped children only after their exit', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    const result = await executePublicAw(nodeLauncher, ['-e', `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setTimeout(()=>{},1400)'],{detached:true,stdio:'ignore'});
      child.on('exit',()=>{console.log('completed');});
    `], options);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'completed');
    assert.equal(result.containmentMode, 'observed');
    assert.equal(result.gradingEvidenceAccepted, false);
    assert.equal(result.descendantCleanupGuaranteed, false);
  });
});

test('public AW rejects a zero-exit root that leaves an independently grouped child', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    await assert.rejects(executePublicAw(nodeLauncher, ['-e', `
      const {spawn}=require('node:child_process');
      spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{detached:true,stdio:'ignore'}).unref();
      setTimeout(()=>process.exit(0),1400);
    `], options), /all provider descendants must exit before completion/);
  });
});

test('public AW rejects timeout, output limit and cancellation despite a zero exit', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    await assert.rejects(executePublicAw(nodeLauncher, ['-e', 'setTimeout(()=>{},10000)'],
      { ...options, timeoutMs: 500 }), /public-aw-process-timeout/);
    await assert.rejects(executePublicAw(nodeLauncher, ['-e', 'process.stdout.write("x".repeat(3*1024*1024));setTimeout(()=>{},10000)'],
      options), /public-aw-process-max-buffer/);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('test-cancelled')), 1500);
    try {
      await assert.rejects(executePublicAw(nodeLauncher, ['-e',
        'process.on("SIGTERM",()=>process.exit(0));setTimeout(()=>{},10000)'],
      { ...options, signal: controller.signal }), /public-aw-process-abort/);
    } finally { clearTimeout(timer); }
  });
});

test('public AW inspection preflight failure prevents command launch', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    const marker = path.join(options.cwd, 'launched');
    await assert.rejects(executePublicAw(nodeLauncher, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`],
      options, { execFile(_command, _args, _options, callback) { callback(new Error('inspection unavailable'), ''); } }),
    /process identity lookup failed|process marker lookup failed/);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  });
});

test('public AW observation failure aborts and remains failed after cleanup', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    const marker = path.join(options.cwd, 'launched');
    let injected = false;
    await assert.rejects(executePublicAw(nodeLauncher, ['-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes');setTimeout(()=>{},10000)`], options, {
      execFile(command, args, settings, callback) {
        fs.stat(marker).then(() => {
          if (!injected) { injected = true; callback(new Error('inspection lost'), ''); }
          else execFile(command, args, settings, callback);
        }, () => execFile(command, args, settings, callback));
      },
    }), (error) => {
      assert.equal(injected, true);
      assert.equal(error.result?.cancelled, true);
      assert(error.publicAwProcessDiagnostics.length > 0);
      assert.equal(typeof error.publicAwProcessDiagnostics[0].rootPid, 'number');
      return true;
    });
  });
});

test('public AW lease release failure cannot become success', posixOnly, async () => {
  await publicProcessFixture(async (options) => {
    await assert.rejects(executePublicAw(nodeLauncher, ['-e', 'console.log("ok")'], options, {
      async createSentinel(name, marker) {
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'],
          { env: { PATH: process.env.PATH, [name]: marker }, stdio: 'ignore' });
        const closed = once(child, 'close');
        return { pid: child.pid, async stop() { child.kill('SIGTERM'); await closed; throw new Error('release failed'); } };
      },
    }), /public-aw-inspection-lease-release-failed/);
  });
});
