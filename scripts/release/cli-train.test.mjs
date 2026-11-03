import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureCommand, CLI_RELEASE_PACKAGES } from './common.mjs';
import { prepareLocalRelease, publishPreparedRelease } from './prepared-release.mjs';

// Test Value Gate: a fresh five-package train must prepare before any registry
// native version exists, then publish once and verify actual registry archives.
test('prepares and publishes a fresh five-package train through an isolated registry', { timeout: 120_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-train-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const published = new Map();
  const events = [];
  let registryUrl;
  const server = http.createServer(async (request, response) => {
    try {
      const route = decodeURIComponent(request.url.split('?')[0]);
      const packageName = route.slice(1);
      if (request.method === 'PUT') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const document = JSON.parse(body);
        const version = Object.keys(document.versions)[0];
        const attachment = Object.values(document._attachments)[0];
        const metadata = document.versions[version];
        metadata.dist.tarball = `${registryUrl}archives/${encodeURIComponent(metadata.name)}.tgz`;
        published.set(metadata.name, { metadata, bytes: Buffer.from(attachment.data, 'base64') });
        events.push(metadata.name);
        response.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (route.startsWith('/archives/')) {
        const name = route.slice('/archives/'.length, -4);
        const entry = published.get(name);
        if (entry) { response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(entry.bytes); return; }
      }
      const name = [...published.keys()].find((entry) => packageName === entry || packageName.startsWith(`${entry}/`));
      if (name) {
        const metadata = published.get(name).metadata;
        const value = packageName === name
          ? { name, 'dist-tags': { latest: metadata.version }, versions: { [metadata.version]: metadata } }
          : metadata;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
    } catch (error) { response.writeHead(500).end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  registryUrl = `http://127.0.0.1:${server.address().port}/`;
  const userConfig = path.join(root, '.npmrc');
  await fs.writeFile(userConfig, `//127.0.0.1:${server.address().port}/:_authToken=fixture\n`);
  const env = { ...process.env, NPM_CONFIG_USERCONFIG: userConfig, npm_config_cache: path.join(root, 'npm-cache'), npm_config_loglevel: 'error' };
  const version = '1.2.3';
  const snapshot = { generationId: 'fixture', inputDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64), cliPackageDigest: 'c'.repeat(64) };
  const metadata = CLI_RELEASE_PACKAGES.map((entry, index) => ({
    name: entry.name, version,
    ...(index < 2 ? { os: ['win32'], cpu: [['x64', 'arm64'][index]] } : {}),
    ...(index === 2 ? { optionalDependencies: Object.fromEntries(CLI_RELEASE_PACKAGES.slice(0, 2).map((item) => [item.name, version])) } : {}),
    ...(index === 4 ? { dependencies: Object.fromEntries(CLI_RELEASE_PACKAGES.slice(2, 4).map((item) => [item.name, version])) } : {}),
  }));
  const packageRoots = await Promise.all(metadata.map(async (manifest, index) => {
    const packageRoot = path.join(root, `source-${index}`);
    await fs.mkdir(path.join(packageRoot, 'package'), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(packageRoot, 'package', 'payload.txt'), `fixture-${index}`);
    return packageRoot;
  }));
  Object.assign(snapshot, { evalPackageRoot: packageRoots[2], corePackageRoot: packageRoots[3], cliPackageRoot: packageRoots[4] });
  const pack = (index) => async ({ destination }) => {
    await fs.copyFile(path.join(packageRoots[index], 'package.json'), path.join(packageRoots[index], 'package', 'package.json'));
    const tarball = path.join(destination, `${index}.tgz`);
    await captureCommand('tar', ['-czf', tarball, '-C', packageRoots[index], 'package']);
    return tarball;
  };
  const nativeRoot = path.join(root, 'native-evidence');
  await fs.mkdir(nativeRoot);
  for (const name of ['candidate.json', 'reproducibility.json', 'qualification-x64.json', 'qualification-arm64.json']) await fs.writeFile(path.join(nativeRoot, name), '{}');
  const options = {
    repoRoot: root, releaseRoot: path.join(root, '.release'), env, registryUrl, npmCommand: 'npm', runNpmCommand: captureCommand,
    axes: { cli: true, catalog: false }, assertClean: async () => {}, assertTargetsMatchHead: async () => {},
    readTargets: async () => ({ schemaVersion: 2, cli: version }), assertPackageVersions: async () => ({ targetVersion: version }),
    resolveHead: async () => 'd'.repeat(40), withSnapshot: async (callback) => callback(snapshot),
    prepareWindowsJobTarballs: async ({ destination }) => ({ root: nativeRoot, tarballPaths: await Promise.all([pack(0)({ destination }), pack(1)({ destination })]) }),
    // Fixture evidence proves the recovery wiring. Real Windows qualification is separate.
    assertWindowsJobCandidateEvidence: async () => {},
    packEval: pack(2), packCore: pack(3), packCli: pack(4), assertCliTagAvailable: async () => {},
    publishCliTag: async () => { events.push('tag'); }, visibilityTimeoutMs: 60_000,
  };
  const descriptor = await prepareLocalRelease('stable', options);
  assert.equal(published.size, 0);
  assert.equal(descriptor.npm.packages.length, 5);
  await publishPreparedRelease(options);
  assert.deepEqual(events, [...CLI_RELEASE_PACKAGES.map((entry) => entry.name), 'tag']);
});
