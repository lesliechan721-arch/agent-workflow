import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCodexExecutable } from '../skills/codex-subagent-guide/scripts/adapters/codex-executable.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-codex-executable-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  await fs.mkdir(home);
  await fs.mkdir(bin);
  return { root, home, bin, environment: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), PATH: bin } };
}

async function executable(target, body = 'process.stdout.write("codex-cli 1.2.3\\n");') {
  await fs.writeFile(target, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
}

// Test Value Gate: the public resolver must use the effective PATH, preserve
// its selected absolute entry, and keep explicit App and CLI sources isolated.
test('CLI selection uses the effective PATH and explicit source boundaries', async (t) => {
  const { bin, environment } = await fixture(t);
  const command = path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (process.platform === 'win32') await fs.copyFile(process.execPath, command);
  else await executable(command);
  const selected = await resolveCodexExecutable({ source: 'auto', environment, platform: 'linux' });
  assert.equal(selected.command, command);
  assert.deepEqual(selected.args, []);
  assert.match(selected.diagnostic.message, /path/);
  if (process.platform !== 'win32') assert.match(selected.diagnostic.message, /1\.2\.3/);
  await assert.rejects(resolveCodexExecutable({ source: 'app', environment, platform: 'linux' }), { code: 'codexAppUnsupported' });
  await fs.unlink(command);
  await assert.rejects(resolveCodexExecutable({ source: 'cli', environment }), { code: 'codexExecutableNotFound' });
  await assert.rejects(resolveCodexExecutable({ source: 'auto', environment, platform: 'linux' }), { code: 'codexExecutableNotFound' });
});

async function bundle(home, name, identifier = 'com.openai.codex') {
  const root = path.join(home, 'Applications', name);
  await fs.mkdir(path.join(root, 'Contents', 'Resources'), { recursive: true });
  await fs.writeFile(path.join(root, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>\n`);
  const command = path.join(root, 'Contents', 'Resources', 'codex');
  await executable(command);
  return { root, command };
}

// Test Value Gate: native bundle identity and real directory containment must
// select user Apps in order, without accepting an unrelated or escaping entry.
test('macOS App selection enforces identity, priority, containment, and missing-only fallback', { skip: process.platform !== 'darwin' }, async (t) => {
  const { root, home, bin, environment } = await fixture(t);
  const stat = fs.stat.bind(fs);
  t.mock.method(fs, 'stat', async (target, ...args) => {
    if (String(target).startsWith('/Applications/')) throw Object.assign(new Error('isolated system Apps'), { code: 'ENOENT' });
    return stat(target, ...args);
  });
  const codex = await bundle(home, 'Codex.app');
  const chatgpt = await bundle(home, 'ChatGPT.app');
  const cli = path.join(bin, 'codex');
  await executable(cli, 'process.exit(9);');
  assert.equal((await resolveCodexExecutable({ source: 'auto', environment })).command, cli);
  assert.equal((await resolveCodexExecutable({ source: 'app', environment })).command, codex.command);
  await fs.unlink(cli);
  assert.equal((await resolveCodexExecutable({ source: 'auto', environment })).command, codex.command);
  await fs.writeFile(path.join(codex.root, 'Contents', 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.unrelated</string></dict></plist>');
  assert.equal((await resolveCodexExecutable({ source: 'app', environment })).command, chatgpt.command);
  await fs.writeFile(path.join(codex.root, 'Contents', 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist>');
  await fs.unlink(codex.command);
  const outside = path.join(root, 'outside-codex');
  await executable(outside);
  await fs.symlink(outside, codex.command);
  assert.equal((await resolveCodexExecutable({ source: 'app', environment })).command, chatgpt.command);
  await fs.unlink(chatgpt.command);
  await assert.rejects(resolveCodexExecutable({ source: 'app', environment }), { code: 'codexExecutableNotFound' });
  await assert.rejects(resolveCodexExecutable({ source: 'cli', environment }), { code: 'codexExecutableNotFound' });
  assert.match((await resolveCodexExecutable({ source: 'auto', environment }).catch((error) => error)).diagnostic.message, /\(auto\)/);
});

// Test Value Gate: a controlled system-query boundary protects package-root
// isolation, unique selection, update removal, and query failure diagnostics.
// This fake host does not provide native Windows registration/start evidence.
test('registered Windows packages have a bounded and unambiguous executable search', { skip: process.platform === 'win32' }, async (t) => {
  const { root, environment } = await fixture(t);
  const systemRoot = path.join(root, 'system');
  const host = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const query = path.join(root, 'query.json');
  await fs.mkdir(path.dirname(host), { recursive: true });
  await executable(host, 'const fs = require("node:fs"); const query = JSON.parse(fs.readFileSync(process.env.AW_CODEX_TEST_QUERY, "utf8")); if (query.fail) process.exit(7); process.stdout.write(JSON.stringify(query));');
  const previous = { SystemRoot: process.env.SystemRoot, AW_CODEX_TEST_QUERY: process.env.AW_CODEX_TEST_QUERY };
  process.env.SystemRoot = systemRoot;
  process.env.AW_CODEX_TEST_QUERY = query;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const packageRoot = path.join(root, 'registered-package');
  await fs.mkdir(path.join(packageRoot, 'resources', 'nested'), { recursive: true });
  const command = path.join(packageRoot, 'resources', 'nested', 'codex.exe');
  await executable(command);
  await fs.mkdir(path.join(root, 'unregistered'));
  await executable(path.join(root, 'unregistered', 'codex.exe'));
  await fs.symlink(path.join(root, 'unregistered'), path.join(packageRoot, 'linked'));
  await fs.writeFile(query, JSON.stringify([{ family: 'OpenAI.Codex_dynamicPublisher', root: packageRoot, version: '1.2.3.4' }]));
  assert.equal((await resolveCodexExecutable({ source: 'app', environment, platform: 'win32' })).command, command);
  const second = path.join(packageRoot, 'codex.exe');
  await executable(second);
  await assert.rejects(resolveCodexExecutable({ source: 'app', environment, platform: 'win32' }), { code: 'codexAppAmbiguous' });
  await fs.unlink(second);
  await fs.unlink(command);
  await assert.rejects(resolveCodexExecutable({ source: 'app', environment, platform: 'win32' }), { code: 'codexExecutableNotFound' });
  await fs.writeFile(query, JSON.stringify({ fail: true, secret: 'not-in-diagnostic' }));
  const failure = await resolveCodexExecutable({ source: 'app', environment, platform: 'win32' }).catch((error) => error);
  assert.equal(failure.code, 'codexAppQueryFailed');
  assert.equal(failure.diagnostic.message.includes('not-in-diagnostic'), false);
});
