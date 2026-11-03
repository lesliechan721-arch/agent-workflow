// TEMPORARY: copy to .github/scripts/native-eval-standalone.mjs for dispatch acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyCandidateDirectory, bytesDigest } from '../../scripts/release/candidate-archive.mjs';
import { candidateSmokeEnvironment, installCandidatePackages } from '../../scripts/release/candidate-smoke.mjs';

assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
assert.equal(process.platform, 'win32', 'Run this probe on a real Windows runner.');
assert.ok(['x64', 'arm64'].includes(process.arch));
assert.equal(process.versions.node.split('.')[0], '24');
const [flag, selectedRoot, extra] = process.argv.slice(2);
assert.ok(flag === '--bundle-root' && selectedRoot && extra === undefined);
const bundleRoot = path.resolve(selectedRoot);
const manifest = await verifyCandidateDirectory(bundleRoot, {
  product: 'cli', sourceHead: process.env.GITHUB_SHA, candidateHead: process.env.GITHUB_SHA,
});
const candidateDigest = bytesDigest(await fs.readFile(path.join(bundleRoot, 'candidate.json')));
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-standalone-')));

// This worker lives inside the isolated installed tree. Its ESM lookup cannot
// reach the checkout. The guards are local Node API guards, not an OS firewall.
const worker = String.raw`
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
const blocked = () => { throw new Error('Standalone Eval probe forbids network access.'); };
for (const module of [http, https]) { module.request = blocked; module.get = blocked; }
net.connect = blocked; net.createConnection = blocked; net.Socket.prototype.connect = blocked;
tls.connect = blocked;
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  dns[name] = blocked;
  dns.promises[name] = async () => blocked();
}
globalThis.fetch = async () => blocked();
globalThis.WebSocket = class { constructor() { blocked(); } };
syncBuiltinESMExports();
assert.throws(() => http.get('http://127.0.0.1:1/'), /forbids network/u);
await assert.rejects(fetch('http://127.0.0.1:1/'), /forbids network/u);
const root = path.dirname(fileURLToPath(import.meta.url));
for (const name of ['@lesliechan721/aw', '@lesliechan721/aw-plugin-core']) {
  await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
const installed = (await fs.readdir(path.join(root, 'node_modules/@lesliechan721'))).sort();
assert.deepEqual(installed, ['agent-skill-eval', 'aw-windows-job-win32-' + process.arch].sort());
const evaluator = await import('@lesliechan721/agent-skill-eval');
const helper = await evaluator.prepareWindowsJobHelper();
const expected = fileURLToPath(import.meta.resolve('@lesliechan721/aw-windows-job-win32-' + process.arch + '/aw-windows-job.exe'));
assert.equal(helper, expected);
const response = await new Promise((resolve, reject) => {
  const child = spawn(helper, ['--operation'], { cwd: root, env: process.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(30_000) });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => {
    if (code !== 0) return reject(new Error('Helper exited ' + code + ': ' + stderr));
    try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
  });
  child.stdin.end(JSON.stringify({ schemaVersion: 1, operation: 'processTable', input: { requiredPids: [process.pid] } }));
});
assert.equal(response.schemaVersion, 1);
assert.ok(response.result, 'Standalone Eval helper must inspect the current process.');
console.log(JSON.stringify({ schemaVersion: 1, kind: 'standalone-eval-acceptance', status: 'passed', platform: process.platform, arch: process.arch, node: process.versions.node, installed, helper, checks: ['five-package-install-then-cli-core-removal', 'public-eval-import', 'node-network-apis-blocked', 'installed-helper-processTable'] }));
`;

try {
  const env = candidateSmokeEnvironment(root);
  for (const directory of [env.HOME, env.AW_HOME, env.AW_CODEX_HOME, env.AW_CLAUDE_HOME]) await fs.mkdir(directory, { recursive: true });
  // Use all five local candidate archives. Only third-party dependencies use npm.
  await installCandidatePackages(bundleRoot, manifest, root, env);
  for (const name of ['aw', 'aw-plugin-core']) await fs.rm(path.join(root, 'node_modules/@lesliechan721', name), { recursive: true });
  await fs.rm(path.join(root, 'node_modules/.bin'), { recursive: true, force: true });
  for (const name of await fs.readdir(root)) {
    if (name.startsWith('unpack-') || name.startsWith('dependencies-')) await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
  const workerPath = path.join(root, 'standalone.mjs');
  await fs.writeFile(workerPath, worker);
  const runtimeEnv = { ...env, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', npm_config_registry: 'http://127.0.0.1:1/', npm_config_offline: 'true' };
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { cwd: root, env: runtimeEnv, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'inherit'], signal: AbortSignal.timeout(90_000) });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`Standalone Eval probe exited ${code}.`));
      resolve(stdout);
    });
  });
  const report = JSON.parse(stdout);
  assert.equal(report.status, 'passed');
  console.log(JSON.stringify({ ...report, sourceHead: manifest.sourceHead, candidateHead: manifest.candidateHead, candidateDigest }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
