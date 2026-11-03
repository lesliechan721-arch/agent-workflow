import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import test from 'node:test';

import { sealCandidateDirectory, verifyCandidateDirectory } from './candidate-archive.mjs';
import {
  assertCandidateHost,
  assertRequiredChecks,
  candidateSmokeEnvironment,
  installCandidatePackages,
  parseCandidateSmokeArgs,
  probeInstalledCatalogCandidate,
  runCandidateSmoke,
} from './candidate-smoke.mjs';

const execFileAsync = promisify(execFile);
const names = ['aw', 'agent-skill-eval', 'aw-plugin-core', 'aw-windows-job-win32-x64', 'aw-windows-job-win32-arm64'].map((name) => `@lesliechan721/${name}`);

// These tests protect artifact provenance, native CPU/Node evidence, and the
// registry boundary. They do not replace the real six-platform artifact smoke.
test('host evidence requires the actual native CPU and the exact minimum Node version', () => {
  const options = parseCandidateSmokeArgs(['--bundle-root', '.', '--product', 'cli', '--os', 'win32', '--arch', 'arm64']);
  assert.throws(() => assertCandidateHost(options, { os: 'win32', arch: 'x64', node: '24.1.0' }), /native OS and CPU/u);
  assert.doesNotThrow(() => assertCandidateHost(options, { os: 'win32', arch: 'arm64', node: '24.1.0' }));
  assert.throws(() => assertCandidateHost(options, { os: 'win32', arch: 'arm64', node: '22.0.0' }), /Node 24/u);
  assert.throws(() => assertCandidateHost({ ...options, minimumNode: true }, { os: 'win32', arch: 'arm64', node: '22.22.0' }), /exactly Node 22.0.0/u);
  assert.doesNotThrow(() => assertCandidateHost({ ...options, minimumNode: true }, { os: 'win32', arch: 'arm64', node: '22.0.0' }));
  assert.throws(() => parseCandidateSmokeArgs(['--bundle-root', '.', '--product', 'cli', '--os', 'linux', '--arch', 'x64', '--arch', 'arm64']));
});

test('required checks reject missing, skipped, failed, and duplicate results', () => {
  for (const checks of [[], [{ id: 'bin', passed: true, skipped: true }], [{ id: 'bin', passed: false }], [{ id: 'bin', passed: true }, { id: 'bin', passed: true }]]) {
    assert.throws(() => assertRequiredChecks(checks, ['bin']), /did not pass/u);
  }
  assert.throws(() => assertRequiredChecks([{ id: 'bin', passed: true }, { id: 'qualification-failure', passed: false }], ['bin']), /did not pass/u);
  assert.doesNotThrow(() => assertRequiredChecks([{ id: 'bin', passed: true }], ['bin']));
});

async function fixture(t, bins = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-candidate-smoke-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  const artifacts = path.join(bundle, 'cli', 'prepared', 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  for (const [index, name] of names.entries()) {
    const packageRoot = path.join(root, `source-${index}`, 'package');
    await fs.mkdir(packageRoot, { recursive: true });
    const metadata = { name, version: '9.2.0-beta.3', type: 'module' };
    if (index === 0) metadata.dependencies = { [names[1]]: metadata.version, [names[2]]: metadata.version, ...(bins ? {} : { 'third-party-demo': '^1.0.0' }) };
    if (index === 1) metadata.optionalDependencies = Object.fromEntries(names.slice(3).map((name) => [name, metadata.version]));
    if (index >= 3) { metadata.os = ['win32']; metadata.cpu = [index === 3 ? 'x64' : 'arm64']; }
    if (bins && index < 2) {
      const bin = index === 0 ? 'aw' : 'aw-skill-eval';
      metadata.bin = { [bin]: './bin.js' };
      await fs.writeFile(path.join(packageRoot, 'bin.js'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(bin)});\n`);
    }
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(metadata));
    await fs.writeFile(path.join(packageRoot, 'candidate-marker'), name);
    await execFileAsync('tar', ['-czf', path.join(artifacts, `package-${index}.tgz`), '-C', path.dirname(packageRoot), 'package']);
  }
  await fs.writeFile(path.join(bundle, 'cli', 'prepared', 'descriptor.json'), '{}');
  await fs.writeFile(path.join(bundle, 'cli', 'attempted.json'), '{}');
  const manifest = await sealCandidateDirectory(bundle, { product: 'cli', version: '9.2.0-beta.3', channel: 'beta', sourceHead: 'a'.repeat(40), candidateHead: 'b'.repeat(40), tag: 'cli-src-v9.2.0-beta.3' });
  return { root, bundle, manifest };
}

test('candidate installation consumes all five tarballs and sends only third-party dependencies to npm', async (t) => {
  const { root, bundle, manifest } = await fixture(t);
  const installRoot = path.join(root, 'installed');
  await fs.mkdir(installRoot);
  const requested = [];
  await installCandidatePackages(bundle, manifest, installRoot, process.env, {
    installDependencies: async (directory, dependencies) => {
      requested.push(dependencies);
      await fs.mkdir(path.join(directory, 'node_modules'));
    },
  });
  assert.deepEqual(requested, [{ 'third-party-demo': '^1.0.0' }]);
  for (const name of names.slice(0, 3)) {
    const installed = path.join(installRoot, 'node_modules', ...name.split('/'));
    assert.equal((await fs.lstat(installed)).isSymbolicLink(), false);
    assert.equal(await fs.readFile(path.join(installed, 'candidate-marker'), 'utf8'), name);
  }
  await verifyCandidateDirectory(bundle);
});

test('an incomplete or modified candidate fails before package installation', async (t) => {
  const { bundle } = await fixture(t);
  await fs.appendFile(path.join(bundle, 'cli', 'prepared', 'artifacts', 'package-1.tgz'), 'changed');
  const report = await runCandidateSmoke({ bundleRoot: bundle, product: 'cli', os: process.platform, arch: process.arch });
  assert.equal(report.status, 'failed');
  assert.ok(report.checks.some((check) => check.id === 'candidate-smoke-failure'));
  assert.ok(!report.checks.some((check) => check.id === 'five-package-closure' && check.passed));
});

test('all five package versions must match the CLI candidate', async (t) => {
  const { root, bundle, manifest } = await fixture(t);
  const installRoot = path.join(root, 'installed');
  await fs.mkdir(installRoot);
  await assert.rejects(installCandidatePackages(bundle, { ...manifest, version: '9.2.0-beta.4' }, installRoot, process.env), /differs from its tarballs/u);
});


test('installation links candidate bins and applies executable permissions without running package scripts', async (t) => {
  const { root, bundle, manifest } = await fixture(t, true);
  const installRoot = path.join(root, 'installed');
  await fs.mkdir(installRoot);
  const env = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'npmrc') };
  await installCandidatePackages(bundle, manifest, installRoot, env);
  for (const bin of ['aw', 'aw-skill-eval']) {
    const shim = path.join(installRoot, 'node_modules', '.bin', `${bin}${process.platform === 'win32' ? '.cmd' : ''}`);
    await fs.access(shim);
    if (process.platform !== 'win32') {
      assert.ok((await fs.stat(shim)).mode & 0o111);
      assert.equal((await execFileAsync(shim, [], { env })).stdout.trim(), bin);
    }
  }
});

test('Catalog tools retain their own five-package version independently of the Catalog release', async (t) => {
  const { root, bundle, manifest } = await fixture(t);
  const installRoot = path.join(root, 'installed');
  await fs.mkdir(installRoot);
  const result = await installCandidatePackages(bundle, { ...manifest, product: 'catalog', version: '11.0.0' }, installRoot, process.env, {
    installDependencies: async (directory) => fs.mkdir(path.join(directory, 'node_modules')),
  });
  assert.equal(result.version, '9.2.0-beta.3');
});

// Test Value Gate: the real installer must complete while the registry rejects
// every self-owned package. Third-party dependency requests stay available.
test('candidate installation succeeds when the registry rejects all five own packages', async (t) => {
  const { root, bundle, manifest } = await fixture(t);
  const thirdRoot = path.join(root, 'third', 'package');
  await fs.mkdir(thirdRoot, { recursive: true });
  await fs.writeFile(path.join(thirdRoot, 'package.json'), JSON.stringify({ name: 'third-party-demo', version: '1.0.0' }));
  await execFileAsync('tar', ['-czf', path.join(root, 'third.tgz'), '-C', path.dirname(thirdRoot), 'package']);
  const tarball = await fs.readFile(path.join(root, 'third.tgz'));
  const requests = [];
  let registry;
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url);
    requests.push(url);
    if (url.includes('@lesliechan721') || url.includes('aw-windows-job')) {
      response.writeHead(403); response.end('Self-owned package requests are forbidden.');
    } else if (url === '/third.tgz') response.end(tarball);
    else if (url === '/third-party-demo') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: 'third-party-demo', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'third-party-demo', version: '1.0.0', dist: { tarball: `${registry}third.tgz` } } } }));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  registry = `http://127.0.0.1:${server.address().port}/`;
  const installed = path.join(root, 'installed');
  await fs.mkdir(installed);
  await installCandidatePackages(bundle, manifest, installed, { ...process.env, npm_config_registry: registry, npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'npmrc') });
  assert.ok(requests.includes('/third-party-demo'));
  assert.ok(requests.includes('/third.tgz'));
  assert.ok(!requests.some((url) => url.includes('@lesliechan721')));
  const dependency = path.join(installed, 'node_modules/@lesliechan721/aw/node_modules/third-party-demo/package.json');
  assert.equal(JSON.parse(await fs.readFile(dependency, 'utf8')).version, '1.0.0');
  for (const name of names.slice(3)) {
    const target = path.join(installed, 'node_modules', ...name.split('/'));
    if (process.platform === 'win32' && name.endsWith(`-${process.arch}`)) await fs.access(target);
    else await assert.rejects(fs.access(target));
  }
});

test('Catalog materialization uses the installed toolchain without a native prefetch stage', async () => {
  const calls = [];
  const input = { root: '/installed', bundleRoot: '/bundle', candidate: { product: 'catalog' }, env: {} };
  await probeInstalledCatalogCandidate(input, async (...args) => calls.push(args));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], input.root);
  await probeInstalledCatalogCandidate({ ...input, minimumNode: true }, async () => calls.push(null));
  await probeInstalledCatalogCandidate({ ...input, candidate: { product: 'cli' } }, async () => calls.push(null));
  assert.equal(calls.length, 1);
});
