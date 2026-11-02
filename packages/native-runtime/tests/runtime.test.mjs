import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, link, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { importNativeTool, resolveNativeTool, resolveNativeRegistryConfig, readNativeToolTestConfig } from '../src/index.mjs';
import { nativeToolDescriptorDigest, parseNativeToolDescriptor, validateNativeBinary } from '../src/descriptor.mjs';
import { fixture, pe, tempFixture } from './fixtures.mjs';

const code = (expected) => (error) => error.code === expected && error.message === expected;

test('offline descriptor pins exact npm bytes and canonical digest', () => {
  const { descriptor, binary } = fixture();
  const parsed = parseNativeToolDescriptor(descriptor);
  validateNativeBinary(binary, parsed.variants[0]);
  const reordered = { variants: descriptor.variants, tool: { protocol: descriptor.tool.protocol, version: '1.2.3', id: descriptor.tool.id }, schemaVersion: 1 };
  assert.equal(nativeToolDescriptorDigest(reordered), nativeToolDescriptorDigest(descriptor));
  for (const patch of [
    (value) => { value.variants[0].transport.version = '^1.2.3'; },
    (value) => { value.variants[0].transport.version = 'latest'; },
    (value) => { value.variants[0].transport.package = 'https://example.com/archive.tgz'; },
    (value) => { value.variants[0].transport.url = 'https://example.com/archive.tgz'; },
    (value) => { value.variants[0].transport.entry = 'package/../job.exe'; },
    (value) => { value.variants[0].limits.archiveBytes = Number.MAX_SAFE_INTEGER; },
    (value) => { value.variants.push(structuredClone(value.variants[0])); },
  ]) {
    const invalid = structuredClone(descriptor);
    patch(invalid);
    assert.throws(() => parseNativeToolDescriptor(invalid), code('nativeDescriptorInvalid'));
  }
});

test('non-Windows and cache-only misses never create a cache', async (t) => {
  const input = await tempFixture(t);
  await assert.rejects(resolveNativeTool({ ...input, platform: 'darwin', mode: 'network', registry: 'http://127.0.0.1:1/' }), code('nativeVariantUnavailable'));
  await assert.rejects(resolveNativeTool({ ...input, mode: 'cache-only' }), code('nativeCacheMiss'));
  await assert.rejects(access(input.cacheRoot));
});

test('offline import starts with no helper and a cache hit needs no registry', async (t) => {
  const input = await tempFixture(t);
  const result = await importNativeTool(input);
  assert.equal(result.state, 'ready');
  assert.deepEqual(await readFile(result.executable), input.binary);
  const ready = await resolveNativeTool({ ...input, mode: 'network', registry: 'http://127.0.0.1:1/' });
  assert.deepEqual(ready, result);
  assert.deepEqual(await resolveNativeTool({ ...input, mode: 'network', registryEnvironment: { AW_NATIVE_REGISTRY_CONFIG: '{invalid' } }), result);
  await assert.rejects(resolveNativeTool({ ...input, archivePath: undefined, mode: 'source-candidate' }), code('nativeSourceCandidateRequired'));
});

test('test-only transport configuration requires the runner guard and absolute explicit paths', async (t) => {
  const input = await tempFixture(t);
  const config = { mode: 'source-candidate', archivePath: input.archivePath, cacheRoot: input.cacheRoot, descriptorPath: path.join(input.directory, 'candidate.lock.json') };
  const environment = { AW_TEST_RUNNER_PROCESS_TREE: '1', AW_NATIVE_TEST_CONFIG: JSON.stringify(config) };
  assert.deepEqual(readNativeToolTestConfig(environment), config);
  assert.equal(readNativeToolTestConfig({}), undefined);
  assert.equal(readNativeToolTestConfig({ AW_TEST_RUNNER_PROCESS_TREE: '1' }), undefined);
  assert.throws(() => readNativeToolTestConfig({ AW_NATIVE_TEST_CONFIG: JSON.stringify(config) }), code('nativeTestConfigInvalid'));
  for (const invalid of [
    { ...config, archivePath: undefined },
    { ...config, mode: 'fixture', archivePath: undefined },
    { ...config, cacheRoot: './cache' },
    { ...config, descriptorPath: './candidate.lock.json' },
    { ...config, mode: 'fallback' },
    { ...config, extra: true },
  ]) {
    assert.throws(() => readNativeToolTestConfig({ ...environment, AW_NATIVE_TEST_CONFIG: JSON.stringify(invalid) }), code('nativeTestConfigInvalid'));
  }
  await assert.rejects(resolveNativeTool({ ...input, archivePath: undefined, mode: 'network', registryEnvironment: { AW_NATIVE_REGISTRY_CONFIG: '{invalid' } }), code('nativeRegistryConfigInvalid'));
  await assert.rejects(access(input.cacheRoot));
});

test('local registry fetches only the current exact package and concurrent calls converge', async (t) => {
  const input = await tempFixture(t);
  const requests = [];
  let base;
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/%40example%2Fjob-win32-x64/1.2.3') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: '@example/job-win32-x64', version: '1.2.3', dist: { tarball: `${base}artifact.tgz` } }));
    } else if (request.url === '/artifact.tgz') response.end(input.archive);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}/`;
  const results = await Promise.all(Array.from({ length: 5 }, () => resolveNativeTool({ ...input, archivePath: undefined, mode: 'network', registry: base })));
  assert.ok(results.every((value) => value.executable === results[0].executable));
  assert.deepEqual(await readFile(results[0].executable), input.binary);
  assert.equal(requests.length, 10);
  assert.ok(requests.every((value) => value === '/%40example%2Fjob-win32-x64/1.2.3' || value === '/artifact.tgz'));
  assert.deepEqual(await readdir(path.dirname(path.dirname(results[0].executable))), [input.descriptor.variants[0].file.sha256.slice(7)]);
});

test('corrupt owned candidates recover and foreign content remains', async (t) => {
  const input = await tempFixture(t);
  const first = await importNativeTool(input);
  await writeFile(first.executable, Buffer.alloc(300));
  const recovered = await resolveNativeTool({ ...input, mode: 'fixture' });
  assert.deepEqual(await readFile(recovered.executable), input.binary);
  const foreign = path.join(path.dirname(recovered.executable), 'foreign.txt');
  await writeFile(foreign, 'keep');
  await assert.rejects(importNativeTool(input), code('nativeCacheForeign'));
  assert.equal(await readFile(foreign, 'utf8'), 'keep');
  assert.deepEqual(await readFile(recovered.executable), input.binary);
});

test('concurrent owned repair converges without accepting foreign or unsafe content', async (t) => {
  const input = await tempFixture(t);
  const ready = await importNativeTool(input);
  const failures = [];
  let successes = 0;
  // Reproduce the review experiment with the real filesystem and independent resolver calls.
  for (let round = 0; round < 20; round += 1) {
    await writeFile(ready.executable, Buffer.alloc(300));
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => resolveNativeTool({ ...input, mode: 'fixture' })));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        successes += 1;
        assert.equal(result.value.executable, ready.executable);
      } else failures.push({ round, code: result.reason.code });
    }
    assert.deepEqual(await readFile(ready.executable), input.binary);
  }
  t.diagnostic(JSON.stringify({ rounds: 20, callersPerRound: 5, successes, failures }));
  assert.deepEqual(failures, []);
  const foreign = path.join(path.dirname(ready.executable), 'foreign.txt');
  await writeFile(foreign, 'keep');
  await writeFile(ready.executable, Buffer.alloc(300));
  for (const result of await Promise.allSettled(Array.from({ length: 5 }, () => resolveNativeTool({ ...input, mode: 'fixture' })))) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'nativeCacheForeign');
  }
  assert.equal(await readFile(foreign, 'utf8'), 'keep');
  assert.deepEqual(await readFile(ready.executable), Buffer.alloc(300));
  const unsafe = await tempFixture(t);
  const outside = path.join(unsafe.directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'foreign.txt'), 'keep');
  await symlink(outside, unsafe.cacheRoot, process.platform === 'win32' ? 'junction' : 'dir');
  for (const result of await Promise.allSettled(Array.from({ length: 5 }, () => resolveNativeTool({ ...unsafe, mode: 'fixture' })))) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'nativeCacheUnsafe');
  }
  assert.equal(await readFile(path.join(outside, 'foreign.txt'), 'utf8'), 'keep');
});

test('empty foreign and symlink cache directories are never overwritten', async (t) => {
  const input = await tempFixture(t);
  const target = path.join(input.cacheRoot, 'win32', 'x64', input.descriptor.variants[0].file.sha256.slice(7));
  await mkdir(target, { recursive: true });
  await assert.rejects(importNativeTool(input), code('nativeCacheForeign'));
  assert.deepEqual(await readdir(target), []);
  const other = await tempFixture(t);
  const outside = path.join(other.directory, 'outside');
  await mkdir(outside);
  await symlink(outside, other.cacheRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(importNativeTool(other), code('nativeCacheUnsafe'));
  assert.deepEqual(await readdir(outside), []);
});

// Test Value Gate: cache inspection must reject linked leaves before returning
// an executable, and must preserve the external file that shares those bytes.
test('cache hits reject hard-linked marker and executable leaves', async (t) => {
  for (const name of ['.aw-native-artifact.json', 'native.exe']) {
    const input = await tempFixture(t);
    const ready = await importNativeTool(input);
    const leaf = path.join(path.dirname(ready.executable), name);
    const bytes = await readFile(leaf);
    const outside = path.join(input.directory, 'outside');
    await writeFile(outside, bytes);
    await unlink(leaf);
    await link(outside, leaf);
    await assert.rejects(resolveNativeTool({ ...input, mode: 'cache-only' }), code('nativeCacheUnsafe'));
    assert.deepEqual(await readFile(outside), bytes);
    assert.deepEqual(await readFile(leaf), bytes);
  }
});

test('malicious archives and unlocked bytes fail before candidate publication', async (t) => {
  const cases = [
    [{ scripts: { install: 'node evil.js' } }, 'nativePackageScriptForbidden'],
    [{ extra: [{ name: 'package/../escape', content: 'bad' }] }, 'nativeArchiveEntryUnsafe'],
    [{ extra: [{ name: '/absolute', content: 'bad' }] }, 'nativeArchiveEntryUnsafe'],
    [{ extra: [{ name: 'package/link', type: '2', link: 'dist/job.exe' }] }, 'nativeArchiveEntryUnsafe'],
    [{ extra: [{ name: 'package/link', type: '1', link: 'package/dist/job.exe' }] }, 'nativeArchiveEntryUnsafe'],
    [{ extra: [{ name: 'package/dist/JOB.EXE', content: 'bad' }] }, 'nativeArchiveEntryUnsafe'],
    [{ extra: [{ name: 'package/NUL.txt', content: 'bad' }] }, 'nativeArchiveEntryUnsafe'],
    [{ binary: pe(0xaa64) }, 'nativeBinaryMachineMismatch'],
  ];
  for (const [options, expected] of cases) {
    const input = await tempFixture(t, options);
    await assert.rejects(importNativeTool(input), code(expected));
    await assert.rejects(access(input.cacheRoot));
  }
  const digest = await tempFixture(t);
  digest.descriptor.variants[0].file.sha256 = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(importNativeTool(digest), code('nativeBinaryDigestMismatch'));
  const integrity = await tempFixture(t);
  integrity.descriptor.variants[0].transport.archiveIntegrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  await assert.rejects(importNativeTool(integrity), code('nativeArchiveIntegrityMismatch'));
  const oversized = await tempFixture(t, { extra: [{ name: 'package/huge', content: Buffer.alloc(100 * 1024) }] });
  await assert.rejects(importNativeTool(oversized), code('nativeArchiveExpansionInvalid'));
  const entries = await tempFixture(t, { extra: [{ name: 'package/extra', content: 'x' }] });
  entries.descriptor.variants[0].limits.entries = 2;
  await assert.rejects(importNativeTool(entries), code('nativeArchiveLimitExceeded'));
});

test('scope credentials do not inherit default-registry headers or follow remote tarball URLs', async (t) => {
  const input = await tempFixture(t);
  const observed = [];
  let base;
  const server = createServer((request, response) => {
    observed.push(request.headers.authorization);
    response.end(JSON.stringify({ name: '@example/job-win32-x64', version: '1.2.3', dist: { tarball: 'http://127.0.0.1:1/steal' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}/`;
  const registry = resolveNativeRegistryConfig({ AW_NATIVE_REGISTRY_CONFIG: JSON.stringify({ url: 'https://registry.example/', headers: { authorization: 'Bearer SECRET' }, scopes: { '@example': base } }) });
  await assert.rejects(resolveNativeTool({ ...input, archivePath: undefined, mode: 'network', registry }), code('nativeRegistryArchiveOriginInvalid'));
  assert.deepEqual(observed, [undefined]);
  assert.throws(() => resolveNativeRegistryConfig({ AW_NATIVE_REGISTRY_CONFIG: JSON.stringify({ url: 'https://secret@example.com/' }) }), code('nativeRegistryConfigInvalid'));
});

test('network truncation and declared archive limits publish no candidate', async (t) => {
  for (const failure of ['truncated', 'oversized']) {
    const input = await tempFixture(t);
    let base;
    const server = createServer((request, response) => {
      if (request.url.endsWith('/1.2.3')) {
        response.end(JSON.stringify({ name: '@example/job-win32-x64', version: '1.2.3', dist: { tarball: `${base}archive` } }));
      } else if (failure === 'truncated') {
        response.writeHead(200, { 'content-length': input.archive.length + 10 });
        response.write(input.archive);
        response.end();
        response.socket?.destroy();
      } else {
        response.writeHead(200, { 'content-length': 1024 * 1024 });
        response.end('x');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    base = `http://127.0.0.1:${server.address().port}/`;
    await assert.rejects(resolveNativeTool({ ...input, archivePath: undefined, mode: 'network', registry: base }), code(failure === 'truncated' ? 'nativeDownloadFailed' : 'nativeArchiveLimitExceeded'));
    await assert.rejects(access(input.cacheRoot));
  }
});

test('controlled HTTP proxy handles the exact registry requests without direct registry access', async (t) => {
  const input = await tempFixture(t);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === 'http://registry.invalid/%40example%2Fjob-win32-x64/1.2.3') {
      response.end(JSON.stringify({ name: '@example/job-win32-x64', version: '1.2.3', dist: { tarball: 'http://registry.invalid/artifact.tgz' } }));
    } else if (request.url === 'http://registry.invalid/artifact.tgz') response.end(input.archive);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const registry = { url: 'http://registry.invalid/', proxy: `http://127.0.0.1:${server.address().port}/` };
  const result = await resolveNativeTool({ ...input, archivePath: undefined, mode: 'network', registry });
  assert.deepEqual(await readFile(result.executable), input.binary);
  assert.deepEqual(requests, ['http://registry.invalid/%40example%2Fjob-win32-x64/1.2.3', 'http://registry.invalid/artifact.tgz']);
});
