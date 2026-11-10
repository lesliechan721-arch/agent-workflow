import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs, runScope, versionFrom } from './native-platforms.mjs';
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

test('a real child version mismatch fails before installation and cleans its temporary home', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-process-test-'));
  const observed = path.join(root, 'observed.json');
  const child = path.join(root, 'client.mjs');
  try {
    await fs.writeFile(child, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], JSON.stringify({home:process.env.HOME,token:process.env.GITHUB_TOKEN,args:process.argv.slice(3)})); console.log('codex-cli 0.1.0');`);
    const report = await runScope('codex', 'project', { executable: process.execPath, prefix: [child, observed] });
    assert.equal(report.status, 'failed');
    assert.equal(report.reason, 'client-version-mismatch');
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
