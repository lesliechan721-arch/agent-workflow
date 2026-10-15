import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { sealCandidateDirectory } from './candidate-archive.mjs';
import {
  assertCandidateHost,
  assertRequiredChecks,
  installCandidatePackages,
  parseCandidateSmokeArgs,
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
    if (index === 1) metadata.optionalDependencies = { [names[3]]: metadata.version, [names[4]]: metadata.version };
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
  for (const name of names) {
    const installed = path.join(installRoot, 'node_modules', ...name.split('/'));
    assert.equal((await fs.lstat(installed)).isSymbolicLink(), false);
    assert.equal(await fs.readFile(path.join(installed, 'candidate-marker'), 'utf8'), name);
  }
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
