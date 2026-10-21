import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTools } from './build.mjs';

// This suite needs OS sandbox creation permission. Run it explicitly on macOS;
// ordinary plugin tests still cover the tool contracts on other hosts.
test('delivered tools run with only Node and package files under an OS filesystem and network sandbox', {
  skip: process.platform !== 'darwin' ? 'The isolation harness requires macOS sandbox-exec.' : false,
}, async () => {
  const fixture = await mkdtemp(path.join(await realpath(os.tmpdir()), 'skill-tools-isolation-'));
  try {
    const runtime = path.join(fixture, 'runtime');
    await mkdir(runtime);
    await mkdir(path.join(runtime, 'home'));
    await mkdir(path.join(runtime, 'bin'));
    const node = path.join(runtime, 'bin', 'node');
    await copyFile(process.execPath, node);
    await chmod(node, 0o755);
    const copiedNode = spawnSync(node, ['--version'], { encoding: 'utf8' });
    assert.equal(copiedNode.status, 0, copiedNode.stderr || `copied Node exited with ${copiedNode.signal}`);
    const outside = path.join(fixture, 'outside.txt');
    await writeFile(outside, 'This file must not be readable in the sandbox.');
    const repository = path.resolve(import.meta.dirname, '../../..');
    await buildTools(path.join(runtime, 'bundle'));
    const program = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import net from 'node:net';
      import { spawnSync } from 'node:child_process';
      const outside = process.argv[2];
      assert.throws(() => fs.readFileSync(outside), e => ['EPERM', 'EACCES'].includes(e.code));
      assert.throws(() => fs.readFileSync(process.argv[3]), e => ['EPERM', 'EACCES'].includes(e.code));
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: 9 });
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Network denial was not observed.')); });
        socket.on('connect', () => { socket.destroy(); reject(new Error('Network is accessible.')); });
        socket.on('error', e => { socket.destroy(); ['EPERM', 'EACCES'].includes(e.code) ? resolve() : reject(e); });
      });
      const author = 'bundle/skills/author-agent-skill/scripts/';
      function run(entry, args) {
        const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
        return result.stdout;
      }
      for (const entry of [author + 'init-skill.mjs', author + 'check-skill.mjs']) run(entry, ['--help']);
      const init = JSON.parse(run(author + 'init-skill.mjs', ['created-skill', '--description', 'Summarize supplied records.', '--format', 'json']));
      assert.equal(init.ok, true); assert.equal(init.state, 'scaffold');
      const check = JSON.parse(run(author + 'check-skill.mjs', ['created-skill', '--format', 'json']));
      assert.equal(check.ok, true); assert.equal(check.complete, true);
      console.log(JSON.stringify({ filesystemDenied: true, networkDenied: true, commands: ['init-skill', 'check-skill'] }));
    `;
    await writeFile(path.join(runtime, 'verify.mjs'), program);
    const policy = `(version 1)
(allow default)
(deny network*)
(deny file-read*
  (literal ${JSON.stringify(outside)})
  (subpath ${JSON.stringify(repository)})
  (subpath "/Users")
  (subpath "/opt/homebrew")
  (subpath "/usr/local")
  (subpath "/usr/lib/node_modules")
  (subpath "/node_modules")
  (subpath "/private/node_modules")
  (subpath "/private/tmp/node_modules")
  (subpath ${JSON.stringify(path.join(fixture, 'node_modules'))}))`;
    const profile = path.join(fixture, 'runtime.sb');
    await writeFile(profile, policy);
    const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, node, 'verify.mjs', outside, path.join(repository, 'package.json')], {
      cwd: runtime,
      env: { HOME: path.join(runtime, 'home'), PATH: path.join(runtime, 'bin'), NODE_PATH: '', TMPDIR: runtime },
      encoding: 'utf8', timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message || `sandbox exited with ${result.signal}`);
    assert.deepEqual(JSON.parse(result.stdout), {
      filesystemDenied: true, networkDenied: true,
      commands: ['init-skill', 'check-skill'],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
