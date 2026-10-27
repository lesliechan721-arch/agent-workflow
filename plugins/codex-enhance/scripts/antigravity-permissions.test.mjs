import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { antigravityPermissionRule, antigravityPermissionRules, antigravitySettingsPath, prepareAntigravityPermission, assertAntigravityPermissionAllowed } from '../skills/codex-subagent-guide/scripts/adapters/antigravity-permissions.mjs';

const options = { skip: !['darwin', 'linux'].includes(process.platform) };
async function fixture(t, value) {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-agy-permissions-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const command = await fs.realpath(process.execPath), script = path.join(home, 'message.mjs');
  await fs.writeFile(script, 'export {};\n', { mode: 0o600 });
  const environment = { HOME: home }, target = antigravitySettingsPath(environment);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(path.dirname(target)), 0o700);
  if (value !== undefined) await fs.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  return { command, script, environment, target, directory: path.dirname(target), home };
}

// Test Value Gate: real isolated settings IO protects unrelated user policy,
// no-op reuse, private mode, atomic replacement and post-failure persistence.
test('Antigravity exact user rule is appended atomically and reused without rewriting', options, async (t) => {
  const original = { unknown: { keep: true }, toolPermission: 'request-review', permissions: { allow: ['command(git)'], ask: ['command(rm)'], deny: ['command(sudo)'], future: 42 } };
  const f = await fixture(t, original);
  const oldBytes = await fs.readFile(f.target), rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    assert.equal(to, f.target);
    assert.deepEqual(await fs.readFile(f.target), oldBytes);
    const next = JSON.parse(await fs.readFile(from, 'utf8'));
    assert.deepEqual(next.permissions.ask, original.permissions.ask);
    assert.deepEqual(next.permissions.deny, original.permissions.deny);
    return rename(from, to);
  });
  const first = await prepareAntigravityPermission(f);
  assert.equal(first.status, 'added');
  assert.equal(first.rule, `command(${f.command} ${f.script})`);
  const saved = JSON.parse(await fs.readFile(f.target, 'utf8'));
  assert.equal(first.rules.length, 2);
  assert.deepEqual(saved, { ...original, permissions: { ...original.permissions, allow: [...original.permissions.allow, ...first.rules] } });
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o600);
  const before = await fs.readFile(f.target), stat = await fs.stat(f.target, { bigint: true });
  assert.equal((await prepareAntigravityPermission(f)).status, 'existing');
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.equal((await fs.stat(f.target, { bigint: true })).mtimeNs, stat.mtimeNs);
});

test('Antigravity creates a private minimal settings file and keeps existing old installation rules', options, async (t) => {
  const f = await fixture(t);
  const result = await prepareAntigravityPermission(f);
  assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')), { permissions: { allow: result.rules } });
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o600);
  const newScript = path.join(f.home, 'new-message.mjs');
  await fs.writeFile(newScript, 'export {};\n');
  const next = await prepareAntigravityPermission({ ...f, script: newScript });
  assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')).permissions.allow, [...result.rules, ...next.rules]);
});

test('Antigravity adds only the missing quoted-entry rule to an existing prefix grant', options, async (t) => {
  const f = await fixture(t);
  const prefix = antigravityPermissionRule(f.command, f.script);
  await fs.writeFile(f.target, JSON.stringify({ permissions: { allow: [prefix] }, preserve: true }));
  const result = await prepareAntigravityPermission(f);
  assert.equal(result.status, 'added');
  assert.deepEqual(JSON.parse(await fs.readFile(f.target, 'utf8')), { permissions: { allow: result.rules }, preserve: true });
  assert.equal((await prepareAntigravityPermission(f)).status, 'existing');
});

// Permission boundary: quoted entry forms must not authorize another program,
// Node options before the script, shell expansion, redirects or command chains.
test('Antigravity quoted-entry regex accepts literal arguments only', () => {
  const node = '/opt/node.v24/bin/node', script = '/opt/aw/message.mjs';
  const rule = antigravityPermissionRules(node, script, 'darwin')[1];
  const pattern = rule.slice('command(regex:'.length, -1);
  const matcher = new RegExp(`^(?:${pattern})$`, 'u');
  // Go regexp's $ is end-of-text; JS also allows before a final newline.
  const matches = (command) => matcher.exec(command)?.[0] === command;
  for (const entry of [node, `'${node}'`, `"${node}"`]) for (const module of [script, `'${script}'`, `"${script}"`]) {
    for (const args of ["--bridge /tmp/run-2/binding.json send --text 'hello 世界'", "'send' '--text' 'a;b|c$(x)\nnext'", String.raw`send --text 'it'\''s'`, String.raw`send --text "say \"hello\" \$HOME"`, 'receive --timeout-ms 0', '--help']) {
      assert.equal(matches(`${entry} ${module} ${args}`), true, `${entry} ${module} ${args}`);
    }
  }
  const base = `'${node}' '${script}'`;
  for (const command of [
    `${base}.suffix --help`, `'${node}' '${script}.suffix' --help`,
    `'${node}' --eval '1' '${script}'`, `'${node}' /other.mjs`,
    base.replace('node.v24', 'nodeXv24'), `${base} --help; whoami`, `${base} --help && whoami`,
    `${base} --help | cat`, `${base} --help > /tmp/output`, `${base}\nwhoami`, `${base}\n`,
    `${base} send --text $(whoami)`, `${base} send --text "$(whoami)"`, `${base} send --text \`whoami\``,
    `${base} send --text "$HOME"`, `NODE_OPTIONS=--inspect ${base}`, `env ${base}`, `sh -c "${base}"`,
    `${base} send --text 'unterminated`, `${base} send --text {a,b}`, `${base} send --text /tmp/*`,
  ]) assert.equal(matches(command), false, command);
});

test('Antigravity rejects invalid settings and definite policy conflicts without replacing bytes', options, async (t) => {
  for (const [value, code] of [
    ['{bad JSON', 'communicationPermissionConfigInvalid'], ['null', 'communicationPermissionConfigInvalid'],
    [{ permissions: null }, 'communicationPermissionConfigInvalid'], [{ permissions: { allow: 'command(node)' } }, 'communicationPermissionConfigInvalid'],
    [{ permissions: { ask: [false] } }, 'communicationPermissionConfigInvalid'], [{ permissions: { deny: {} } }, 'communicationPermissionConfigInvalid'],
    [{ toolPermission: false }, 'communicationPermissionConfigInvalid'], [{ toolPermission: 'strict', unknown: true }, 'communicationPermissionDenied'],
    [{ permissions: { ask: ['command(*)'] } }, 'communicationPermissionDenied'],
  ]) {
    const f = await fixture(t, value), before = await fs.readFile(f.target);
    await assert.rejects(prepareAntigravityPermission(f), { code });
    assert.deepEqual(await fs.readFile(f.target), before);
    assert.deepEqual(await fs.readdir(f.directory), ['settings.json']);
  }
  const f = await fixture(t);
  for (const kind of ['ask', 'deny']) for (const suffix of ['', ' --bridge', ' --bridge /binding send --text secret']) {
    assert.throws(() => assertAntigravityPermissionAllowed({ permissions: { [kind]: [`command(${f.command} ${f.script}${suffix})`] } }, f.command, f.script), { code: 'communicationPermissionDenied' });
  }
  assert.throws(() => assertAntigravityPermissionAllowed({ permissions: { deny: ['command(regex:.*)'] } }, f.command, f.script), { code: 'communicationPermissionUnsupported' });
});

test('Antigravity detects a concurrent edit before publication and removes only its temporary file', options, async (t) => {
  const f = await fixture(t, { preserve: true }), open = fs.open.bind(fs);
  const concurrent = '{"preserve":true,"editor":"new value"}\n';
  t.mock.method(fs, 'open', async (target, ...args) => {
    const handle = await open(target, ...args);
    if (path.basename(target).startsWith('.settings-')) await fs.writeFile(f.target, concurrent);
    return handle;
  });
  await assert.rejects(prepareAntigravityPermission(f), { code: 'communicationPermissionConflict' });
  assert.equal(await fs.readFile(f.target, 'utf8'), concurrent);
  assert.deepEqual(await fs.readdir(f.directory), ['settings.json']);
});

test('Antigravity preserves original settings when atomic rename fails', options, async (t) => {
  const f = await fixture(t, { keep: 'original' }), before = await fs.readFile(f.target);
  t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('busy'), { code: 'EACCES' }); });
  await assert.rejects(prepareAntigravityPermission(f), { code: 'communicationPermissionWriteFailed' });
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.deepEqual(await fs.readdir(f.directory), ['settings.json']);
});

test('Antigravity refuses linked files and directories and unqualified token quoting', options, async (t) => {
  const f = await fixture(t), foreign = path.join(f.home, 'foreign.json');
  await fs.writeFile(foreign, '{"foreign":true}');
  await fs.symlink(foreign, f.target);
  await assert.rejects(prepareAntigravityPermission(f), { code: 'communicationPermissionConfigInvalid' });
  assert.equal(await fs.readFile(foreign, 'utf8'), '{"foreign":true}');
  await fs.unlink(f.target);
  await fs.rename(f.directory, `${f.directory}-foreign`);
  await fs.symlink(`${f.directory}-foreign`, f.directory);
  await assert.rejects(prepareAntigravityPermission(f), { code: 'communicationPermissionConfigInvalid' });
  for (const suffix of [' with space', "'quote", '中文', '*', '\n']) assert.throws(() => antigravityPermissionRule(f.command, `${f.script}${suffix}`), { code: 'communicationPermissionUnsupported' });
  assert.throws(() => antigravityPermissionRule(f.command, f.script, 'win32'), { code: 'communicationPermissionUnsupported' });
});
