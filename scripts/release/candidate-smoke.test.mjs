import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { sealCandidateDirectory, verifyCandidateDirectory } from './candidate-archive.mjs';
import { fixture as nativeFixture } from '../../packages/native-runtime/tests/fixtures.mjs';
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
const names = ['aw', 'agent-skill-eval', 'aw-plugin-core'].map((name) => `@lesliechan721/${name}`);

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

test('candidate installation consumes all three tarballs and sends only third-party dependencies to npm', async (t) => {
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
  await verifyCandidateDirectory(bundle);
});

test('an incomplete or modified candidate fails before package installation', async (t) => {
  const { bundle } = await fixture(t);
  await fs.appendFile(path.join(bundle, 'cli', 'prepared', 'artifacts', 'package-1.tgz'), 'changed');
  const report = await runCandidateSmoke({ bundleRoot: bundle, product: 'cli', os: process.platform, arch: process.arch });
  assert.equal(report.status, 'failed');
  assert.ok(report.checks.some((check) => check.id === 'candidate-smoke-failure'));
  assert.ok(!report.checks.some((check) => check.id === 'three-package-closure' && check.passed));
});

test('all three package versions must match the CLI candidate', async (t) => {
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

test('Catalog tools retain their own three-package version independently of the Catalog release', async (t) => {
  const { root, bundle, manifest } = await fixture(t);
  const installRoot = path.join(root, 'installed');
  await fs.mkdir(installRoot);
  const result = await installCandidatePackages(bundle, { ...manifest, product: 'catalog', version: '11.0.0' }, installRoot, process.env, {
    installDependencies: async (directory) => fs.mkdir(path.join(directory, 'node_modules')),
  });
  assert.equal(result.version, '9.2.0-beta.3');
});

async function nativeCatalogFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-native-smoke-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'node_modules', '@lesliechan721', 'aw');
  await fs.mkdir(path.join(cli, 'dist', 'src', 'native'), { recursive: true });
  await fs.writeFile(path.join(cli, 'package.json'), JSON.stringify({ type: 'module' }));
  // Exercise the installed candidate's real preparation API and embedded
  // resolver. Only its small module/dependency closure is needed by this probe.
  for (const relative of ['src/commands/native-artifacts.js', 'src/utils/state-paths.js', 'src/utils/test-path-fence.js', 'native-runtime']) {
    const destination = path.join(cli, 'dist', relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(new URL(`../../packages/cli/dist/${relative}`, import.meta.url), destination, { recursive: true });
  }
  const copied = new Set();
  async function copyDependency(name, require) {
    if (copied.has(name)) return;
    copied.add(name);
    let dependencyRoot = path.dirname(require.resolve(name));
    let metadata;
    while (true) {
      try { metadata = JSON.parse(await fs.readFile(path.join(dependencyRoot, 'package.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (metadata?.name === name) break;
      assert.notEqual(dependencyRoot, path.dirname(dependencyRoot), `Cannot locate ${name}`);
      dependencyRoot = path.dirname(dependencyRoot);
    }
    const manifestPath = path.join(dependencyRoot, 'package.json');
    await fs.cp(path.dirname(manifestPath), path.join(root, 'node_modules', name), { recursive: true });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyDependency(dependency, createRequire(manifestPath));
  }
  await copyDependency('fs-extra', createRequire(new URL('../../packages/cli/package.json', import.meta.url)));
  const input = nativeFixture();
  const descriptorPath = path.join(cli, 'dist', 'src', 'native', 'windows-job.lock.json');
  await fs.writeFile(descriptorPath, JSON.stringify(input.descriptor));
  const requests = [];
  let registry;
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/%40example%2Fjob-win32-x64/1.2.3') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: '@example/job-win32-x64', version: '1.2.3', dist: { tarball: `${registry}archive.tgz` } }));
    } else if (request.url === '/archive.tgz') response.end(input.archive);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  registry = `http://127.0.0.1:${server.address().port}/`;
  const env = { ...process.env, AW_HOME: path.join(root, 'aw-home'), AW_NATIVE_REGISTRY_CONFIG: JSON.stringify({ url: registry }) };
  const cacheRoot = path.join(env.AW_HOME, 'native-artifacts', 'v1');
  const runtime = await import(pathToFileURL(path.join(cli, 'dist', 'native-runtime', 'index.mjs')).href);
  return { root, cli, descriptorPath, env, cacheRoot, requests, runtime, ...input };
}

// Test Value Gate: a Windows Catalog candidate must populate its isolated
// cache from its own installed lock before a cache-only renderer can start.
test('Windows Catalog smoke prepares the installed lock before materializing in the same empty cache', async (t) => {
  const input = await nativeCatalogFixture(t);
  const foreignCache = path.join(input.root, 'source-test-cache');
  const env = candidateSmokeEnvironment(input.root, {
    ...input.env,
    AW_TEST_RUNNER_PROCESS_TREE: '1',
    AW_NATIVE_TEST_CONFIG: JSON.stringify({ mode: 'cache-only', cacheRoot: foreignCache, descriptorPath: path.join(input.root, 'source-test.lock.json') }),
    AW_NATIVE_TOOL_CONTEXT: JSON.stringify({ schemaVersion: 1, tools: { 'windows-job': { state: 'unavailable', code: 'source-test-context' } } }),
    AW_NATIVE_RESOLVER_MODE: 'source-candidate',
  });
  await assert.rejects(fs.access(input.cacheRoot));
  const events = [];
  await probeInstalledCatalogCandidate({ ...input, env, candidate: { product: 'catalog' }, platform: 'win32', arch: 'x64' }, async (_root, _bundle, _candidate, rendererEnv) => {
    events.push('renderer');
    assert.equal(rendererEnv, env);
    const testConfig = input.runtime.readNativeToolTestConfig(rendererEnv);
    const descriptor = JSON.parse(await fs.readFile(testConfig?.descriptorPath ?? input.descriptorPath, 'utf8'));
    const ready = await input.runtime.resolveNativeTool({ descriptor, cacheRoot: testConfig?.cacheRoot ?? path.join(rendererEnv.AW_HOME, 'native-artifacts', 'v1'), platform: 'win32', arch: 'x64', mode: 'cache-only' });
    assert.deepEqual(await fs.readFile(ready.executable), input.binary);
    const output = path.join(input.root, 'rendered', 'SKILL.md');
    await fs.mkdir(path.dirname(output));
    await execFileAsync(process.execPath, ['--input-type=module', '-e', 'import fs from "node:fs/promises"; await fs.writeFile(process.argv[1], "rendered skill");', output], { env });
    assert.equal(await fs.readFile(output, 'utf8'), 'rendered skill');
  }, (id) => events.push(id));
  assert.deepEqual(events, ['catalog-native-prepare', 'renderer']);
  assert.deepEqual(input.requests, ['/%40example%2Fjob-win32-x64/1.2.3', '/archive.tgz']);
  await assert.rejects(fs.access(foreignCache));
});

test('failed Catalog native preparation blocks materialization; other smoke modes do not prepare', async (t) => {
  const input = await nativeCatalogFixture(t);
  input.descriptor.variants[0].transport.archiveIntegrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  await fs.writeFile(input.descriptorPath, JSON.stringify(input.descriptor));
  let renderers = 0;
  const render = async () => { renderers += 1; };
  const options = { ...input, candidate: { product: 'catalog' }, platform: 'win32', arch: 'x64' };
  await assert.rejects(probeInstalledCatalogCandidate(options, render), /nativeArchiveIntegrity/u);
  assert.equal(renderers, 0);
  await assert.rejects(fs.access(input.cacheRoot));
  const requests = input.requests.length;
  await probeInstalledCatalogCandidate({ ...options, platform: 'darwin' }, render);
  await probeInstalledCatalogCandidate({ ...options, platform: 'linux' }, render);
  await probeInstalledCatalogCandidate({ ...options, minimumNode: true }, render);
  await probeInstalledCatalogCandidate({ ...options, candidate: { product: 'cli' } }, render);
  assert.equal(renderers, 2);
  assert.equal(input.requests.length, requests);
  await assert.rejects(fs.access(input.cacheRoot));
});
