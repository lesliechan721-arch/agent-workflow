import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { antigravityPermissionRule, antigravityPermissionRules, antigravitySettingsPath, prepareAntigravityPermission, assertAntigravityPermissionAllowed } from '../skills/spawn-subagent/scripts/adapters/antigravity-permissions.mjs';

const options = { skip: !['darwin', 'linux'].includes(process.platform) };
async function fixture(t, value) {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-agy-permissions-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const command = await fs.realpath(process.execPath), script = path.join(home, 'message.mjs');
  await fs.writeFile(script, 'export {};\n', { mode: 0o600 });
  const args = [script, 'command', 'run', 'cmdp_0123456789abcdef', '--'];
  const environment = { HOME: home }, target = antigravitySettingsPath(environment);
  const directory = path.join(home, 'runtime');
  await fs.mkdir(directory, { mode: 0o700 });
  if (value !== undefined) {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(path.dirname(target)), 0o700);
    await fs.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  }
  return { command, script, args, environment, target, directory, userDirectory: path.dirname(target), home };
}

// Test Value Gate: real isolated IO protects session-only authorization,
// existing policy, private permissions and absence of user config writes.
test('Antigravity injects only a merged allow list and leaves read-only user settings unchanged', options, async (t) => {
  const original = { unknown: { keep: true }, toolPermission: 'request-review', permissions: { allow: ['command(git)', 'command(git)'], ask: ['command(rm)'], deny: ['command(sudo)'], future: 42 } };
  const f = await fixture(t, original);
  await fs.chmod(f.target, 0o400);
  const before = await fs.readFile(f.target), stat = await fs.stat(f.target, { bigint: true });
  const first = await prepareAntigravityPermission(f);
  const settings = JSON.parse(await fs.readFile(first.settingsFile, 'utf8'));
  assert.deepEqual(settings, { permissions: { allow: ['command(git)', ...first.rules] } });
  assert.equal((await fs.stat(first.settingsFile)).mode & 0o777, 0o600);
  assert.equal(path.dirname(first.settingsFile), f.directory);
  assert.deepEqual(await fs.readFile(f.target), before);
  const after = await fs.stat(f.target, { bigint: true });
  for (const field of ['ino', 'mode', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], stat[field]);
  const second = await prepareAntigravityPermission(f);
  assert.deepEqual(JSON.parse(await fs.readFile(second.settingsFile, 'utf8')), settings);
  assert.deepEqual(await fs.readdir(f.userDirectory), ['settings.json']);
});

test('Antigravity missing user settings stay absent while each execution gets its current rules', options, async (t) => {
  const f = await fixture(t);
  const first = await prepareAntigravityPermission(f);
  assert.deepEqual(JSON.parse(await fs.readFile(first.settingsFile, 'utf8')), { permissions: { allow: first.rules } });
  await assert.rejects(fs.access(path.join(f.home, '.gemini')), { code: 'ENOENT' });
  const nextScript = path.join(f.home, 'next-cli.mjs');
  await fs.writeFile(nextScript, 'export {};');
  const nextDirectory = path.join(f.home, 'resumed');
  await fs.mkdir(nextDirectory, { mode: 0o700 });
  const next = await prepareAntigravityPermission({ ...f, args: [nextScript, ...f.args.slice(1)], directory: nextDirectory });
  assert.deepEqual(JSON.parse(await fs.readFile(next.settingsFile, 'utf8')), { permissions: { allow: next.rules } });
  assert.notDeepEqual(next.rules, first.rules);
  assert.deepEqual(JSON.parse(await fs.readFile(first.settingsFile, 'utf8')), { permissions: { allow: first.rules } });
  await assert.rejects(fs.access(path.join(f.home, '.gemini')), { code: 'ENOENT' });
});

test('Antigravity existing exact grants are not duplicated in the session override', options, async (t) => {
  const f = await fixture(t);
  const rules = antigravityPermissionRules(f.command, f.args);
  await fs.mkdir(f.userDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(f.userDirectory), 0o700);
  const original = JSON.stringify({ permissions: { allow: rules }, preserve: true });
  await fs.writeFile(f.target, original, { mode: 0o600 });
  const result = await prepareAntigravityPermission(f);
  assert.deepEqual(JSON.parse(await fs.readFile(result.settingsFile, 'utf8')), { permissions: { allow: rules } });
  assert.equal(await fs.readFile(f.target, 'utf8'), original);
});

// Permission boundary: quoted entry forms must not authorize another program,
// Node options before the script, shell expansion, redirects or command chains.
// Explicit POSIX targets must use the same literal paths on every host.
test('Antigravity quoted-entry regex accepts literal arguments only', () => {
  const node = '/opt/node.v24/bin/node', script = '/opt/aw/cli.mjs';
  const args = [script, 'command', 'run', 'cmdp_0123456789abcdef', '--'];
  for (const platform of ['darwin', 'linux']) {
    assert.equal(antigravityPermissionRule(node, args, platform), `command(${[node, ...args].join(' ')})`);
    for (const invalid of ['/opt/aw/../message.mjs', '/opt//message.mjs', 'C:\\aw\\message.mjs']) {
      assert.throws(() => antigravityPermissionRule(node, [invalid, ...args.slice(1)], platform), { code: 'communicationPermissionUnsupported' });
    }
  }
  assert.throws(() => antigravityPermissionRules(node, args, 'win32'), { code: 'communicationPermissionUnsupported' });
  const rule = antigravityPermissionRules(node, args, 'darwin')[1];
  const pattern = rule.slice('command(regex:'.length, -1);
  const matcher = new RegExp(`^(?:${pattern})$`, 'u');
  // Go regexp's $ is end-of-text; JS also allows before a final newline.
  const matches = (command) => matcher.exec(command)?.[0] === command;
  for (const entry of [node, `'${node}'`, `"${node}"`]) for (const module of [script, `'${script}'`, `"${script}"`]) {
    for (const args of ["--bridge /tmp/run-2/binding.json send --text 'hello 世界'", "'send' '--text' 'a;b|c$(x)\nnext'", String.raw`send --text 'it'\''s'`, String.raw`send --text "say \"hello\" \$HOME"`, 'receive --timeout-ms 0', '--help']) {
      assert.equal(matches(`${entry} ${module} command run cmdp_0123456789abcdef -- ${args}`), true, `${entry} ${module} command run cmdp_0123456789abcdef -- ${args}`);
    }
  }
  const base = `'${node}' '${script}' command run cmdp_0123456789abcdef --`;
  for (const command of [
    `${base}.suffix --help`, `${base.replace('cmdp_0123456789abcdef', 'cmdp_ffffffffffffffff')} --help`, `${base.replace('command run', 'command remove')} --help`, `'${node}' '${script}.suffix' --help`,
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
    assert.deepEqual(await fs.readdir(f.directory), []);
    assert.deepEqual(await fs.readdir(f.userDirectory), ['settings.json']);
  }
  const f = await fixture(t);
  for (const kind of ['ask', 'deny']) for (const suffix of ['', ' --bridge', ' --bridge /binding send --text secret']) {
    assert.throws(() => assertAntigravityPermissionAllowed({ permissions: { [kind]: [`command(${[f.command, ...f.args].join(' ')}${suffix})`] } }, f.command, f.args), { code: 'communicationPermissionDenied' });
  }
  assert.throws(() => assertAntigravityPermissionAllowed({ permissions: { deny: ['command(regex:.*)'] } }, f.command, f.args), { code: 'communicationPermissionUnsupported' });
});

test('Antigravity rejects an inconsistent user settings read without publishing session settings', options, async (t) => {
  const f = await fixture(t, { preserve: true }), open = fs.open.bind(fs);
  const concurrent = '{"permissions":{"deny":["command(*)"]}}';
  t.mock.method(fs, 'open', async (target, ...args) => {
    const handle = await open(target, ...args);
    if (target === f.target) {
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...args) => {
        const contents = await read(...args);
        await fs.writeFile(f.target, concurrent);
        return contents;
      };
    }
    return handle;
  });
  await assert.rejects(prepareAntigravityPermission(f), { code: 'communicationPermissionConflict' });
  assert.equal(await fs.readFile(f.target, 'utf8'), concurrent);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('Antigravity session publication failure preserves user settings and removes the private temporary file', options, async (t) => {
  const f = await fixture(t, { keep: 'original' }), before = await fs.readFile(f.target);
  t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('busy'), { code: 'EACCES' }); });
  await assert.rejects(prepareAntigravityPermission(f), { code: 'communicationPermissionWriteFailed' });
  assert.deepEqual(await fs.readFile(f.target), before);
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.deepEqual(await fs.readdir(f.userDirectory), ['settings.json']);
});

test('Antigravity refuses linked settings and directories and unqualified command quoting', options, async (t) => {
  const f = await fixture(t, {}), foreign = path.join(f.home, 'foreign.json');
  await fs.writeFile(foreign, '{"foreign":true}');
  await fs.unlink(f.target);
  await fs.symlink(foreign, f.target);
  await assert.rejects(prepareAntigravityPermission(f), { code: 'communicationPermissionConfigInvalid' });
  assert.equal(await fs.readFile(foreign, 'utf8'), '{"foreign":true}');
  await fs.unlink(f.target);
  await fs.rename(f.userDirectory, `${f.userDirectory}-foreign`);
  await fs.symlink(`${f.userDirectory}-foreign`, f.userDirectory);
  await assert.rejects(prepareAntigravityPermission(f), { code: 'communicationPermissionConfigInvalid' });
  for (const suffix of [' with space', "'quote", '中文', '*', '\n']) assert.throws(() => antigravityPermissionRule(f.command, [`${f.script}${suffix}`, ...f.args.slice(1)]), { code: 'communicationPermissionUnsupported' });
  assert.throws(() => antigravityPermissionRule(f.command, f.args, 'win32'), { code: 'communicationPermissionUnsupported' });
  assert.deepEqual(await fs.readdir(f.directory), []);
});
