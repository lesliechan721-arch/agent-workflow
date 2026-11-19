import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const activeDigest = 'sha256:7131bfce3591200c78e8f70631b7387a8dce1ef337bf31550b2426091b46e4fd';
const fixtureFiles = 3073;
const self = fileURLToPath(import.meta.url);
const { values: options } = parseArgs({ options: {
  serial: { type: 'string' }, four: { type: 'string' }, eight: { type: 'string' },
  catalog: { type: 'string' }, mode: { type: 'string', default: 'all' },
  worker: { type: 'string' }, root: { type: 'string' }, output: { type: 'string' },
} });
const workspace = 'packages/plugin-core/dist/workspace.js';
const requireFrom = (root) => createRequire(path.resolve(root, workspace));
const core = (root) => import(pathToFileURL(path.resolve(root, workspace)));
const hash = (input) => createHash('sha256').update(input).digest('hex');
const variantDigest = async (root) => hash(await fs.readFile(path.resolve(root, workspace)));
const host = { platform: process.platform, arch: process.arch, release: os.release(), node: process.version,
  cpu: os.cpus()[0]?.model, logicalCpus: os.availableParallelism(),
  uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? null };
const report = (result) => options.output
  ? fs.writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`)
  : process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function validate(buildRoot, catalog, expectedDigest = activeDigest) {
  const { validateCatalogSnapshotTransport } = await core(buildRoot);
  const start = performance.now();
  const result = await validateCatalogSnapshotTransport(catalog);
  const elapsedMs = performance.now() - start;
  if (expectedDigest) assert.equal(result.snapshotDigest, expectedDigest);
  assert.equal(result.manifest.entries.length, 12);
  return { elapsedMs, snapshotDigest: result.snapshotDigest, manifestSHA256: hash(JSON.stringify(result.manifest)) };
}

function filePages(mode, catalog) {
  const script = fileURLToPath(new URL('./file-pages.py', import.meta.url));
  const pages = JSON.parse(execFileSync('python3', [script, mode, catalog], { encoding: 'utf8' }));
  assert.equal(pages.regularFiles, fixtureFiles);
  return pages;
}

async function memoryWorker(buildRoot, largeFixture) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-digest-core-'));
  const src = path.dirname(path.resolve(buildRoot, workspace));
  try {
    await fs.cp(src, path.join(directory, 'dist'), { recursive: true });
    await fs.cp(path.join(src, '..', 'schemas'), path.join(directory, 'schemas'), { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    // Load exactly the compiled scanner in a separate worker. Export the private
    // function only in this disposable copy to isolate its RSS from validation.
    const installedModules = path.resolve(src, '..', 'node_modules');
    await fs.symlink(installedModules, path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const instrumented = path.join(directory, 'dist/workspace.js');
    await fs.appendFile(instrumented, '\nexport { digestDirectory };\n');
    const { digestDirectory } = await import(pathToFileURL(instrumented));
    const before = process.memoryUsage.rss();
    let peak = before;
    let externalPeak = process.memoryUsage().external;
    const capture = () => {
      const memory = process.memoryUsage();
      peak = Math.max(peak, memory.rss);
      externalPeak = Math.max(externalPeak, memory.external);
    };
    const timer = setInterval(capture, 2);
    const start = performance.now();
    let digest;
    try {
      digest = await digestDirectory(largeFixture, new Map());
    } finally {
      capture();
      clearInterval(timer);
    }
    await report({ digest, elapsedMs: performance.now() - start, rssBeforeBytes: before, peakRssBytes: peak,
      peakRssDeltaBytes: peak - before, peakExternalBytes: externalPeak });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function memory(variants, root) {
  const large = path.join(root, 'large');
  await fs.mkdir(large);
  const entries = [];
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const fileCount = 12;
  const chunksPerFile = 24;
  for (let i = 0; i < fileCount; i++) {
    const name = `file-${String(i).padStart(2, '0')}.bin`;
    const file = await fs.open(path.join(large, name), 'wx');
    const expected = createHash('sha256');
    try {
      for (let j = 0; j < chunksPerFile; j++) {
        chunk.fill((i * chunksPerFile + j) % 251);
        expected.update(chunk);
        const { bytesWritten } = await file.write(chunk);
        assert.equal(bytesWritten, chunk.length);
      }
    } finally {
      await file.close();
    }
    entries.push(`${name}\0${expected.digest('hex')}`);
  }
  const expected = 'sha256:' + hash(entries.join('\n'));
  const rounds = [];
  for (const order of [Object.keys(variants), Object.keys(variants).reverse()]) {
    const row = {};
    for (const name of order) {
      const result = JSON.parse(execFileSync(process.execPath, [self, '--worker', 'memory', '--root', variants[name],
        '--catalog', large], { encoding: 'utf8' }));
      assert.equal(result.digest, expected);
      row[name] = result;
    }
    rounds.push(row);
  }
  return { fileCount, bytesPerFile: chunksPerFile * chunk.length, digest: expected, rounds };
}

async function check(variants, catalog, root) {
  const snapshot = path.join(root, 'snapshot');
  await fs.cp(catalog, snapshot, { recursive: true, preserveTimestamps: true });
  const payload = path.join(snapshot, 'plugins', 'human-content');
  // Add malformed entries only while exercising the walk's error precedence.
  const earlyDir = path.join(payload, '!first');
  const failedPath = path.join(earlyDir, '00-first');
  const laterPath = path.join(earlyDir, '01-later');
  const nested = path.join(earlyDir, '02-child');
  const links = [path.join(nested, '00-link'), path.join(earlyDir, '03-link')];
  const target = path.join(payload, 'generic', 'skills', 'explain-for-review', 'SKILL.md');
  const original = await fs.readFile(target);
  const stats = await fs.stat(target);
  const corruption = Buffer.from(original);
  const byte = corruption.indexOf(Buffer.from('description:'));
  assert.ok(byte > 0, 'Pick a byte that keeps the file length unchanged.');
  corruption[byte] = 'x'.charCodeAt(0);
  const out = {};
  for (const [name, buildRoot] of Object.entries(variants)) {
    const { validateCatalogSnapshotTransport } = await core(buildRoot);
    const baseline = await validateCatalogSnapshotTransport(snapshot);
    assert.equal(baseline.snapshotDigest, activeDigest);
    await fs.writeFile(target, corruption);
    await fs.utimes(target, stats.atime, stats.mtime);
    await assert.rejects(() => validateCatalogSnapshotTransport(snapshot), /artifactDigest/u);
    await fs.writeFile(target, original);

    await fs.mkdir(nested, { recursive: true });
    for (const file of [failedPath, laterPath]) await fs.writeFile(file, 'read');
    const fsExtra = requireFrom(buildRoot)('fs-extra');
    const read = fsExtra.readFile;
    const lstat = fsExtra.lstat;
    let inFlight = 0;
    let peak = 0;
    const finished = [];
    fsExtra.readFile = async (file, ...args) => {
      if (file !== failedPath && file !== laterPath) return read(file, ...args);
      inFlight++;
      peak = Math.max(inFlight, peak);
      try {
        await delay(file === failedPath ? 25 : 2);
        throw Object.assign(new Error('injected read failure'), { code: 'ENOENT', path: file });
      } finally {
        inFlight--;
        finished.push(path.basename(file));
      }
    };
    try {
      await assert.rejects(() => validateCatalogSnapshotTransport(snapshot), { code: 'ENOENT', path: failedPath });
    } finally {
      fsExtra.readFile = read;
    }
    assert.equal(inFlight, 0);
    assert.deepEqual(finished, name === 'serial' ? ['00-first'] : ['01-later', '00-first']);

    let symlinkCheck = 'passed';
    try {
      await fs.symlink(target, links[0], 'file');
      await fs.symlink(target, links[1], 'file');
      fsExtra.lstat = async (file, ...args) => {
        if (file === links[0]) await delay(8);
        return lstat(file, ...args);
      };
      await assert.rejects(() => validateCatalogSnapshotTransport(snapshot), {
        message: 'Generated output contains a symbolic link: plugins/human-content/!first/02-child/00-link',
      });
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      symlinkCheck = `not exercised: ${error.code}`;
    } finally {
      fsExtra.lstat = lstat;
      await fs.rm(earlyDir, { recursive: true, force: true });
    }
    let rootSymlinkCheck = 'passed';
    const aliased = path.join(root, 'aliased');
    try {
      await fs.symlink(snapshot, aliased, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(() => validateCatalogSnapshotTransport(aliased), /regular non-symbolic-link directory/u);
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      rootSymlinkCheck = `not exercised: ${error.code}`;
    } finally {
      await fs.rm(aliased, { recursive: true, force: true });
    }
    assert.deepEqual(await validateCatalogSnapshotTransport(snapshot), baseline);
    out[name] = { sameSizeCorruptionDetected: true, peakFailedReadConcurrency: peak,
      errorCompletionOrder: finished, readsInFlightAtError: inFlight, symlinkCheck, rootSymlinkCheck };
  }
  return out;
}

if (options.worker === 'memory') {
  await memoryWorker(options.root, options.catalog);
} else if (options.mode === 'fixture') {
  const result = await validate(options.root, options.catalog, null);
  const entries = await fs.readdir(options.catalog, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const metadata = { regularFiles: files.length, plugins: 12, snapshotDigest: result.snapshotDigest,
    manifestSHA256: result.manifestSHA256 };
  if (metadata.snapshotDigest !== activeDigest || files.length !== fixtureFiles) {
    metadata.fileSHA256 = {};
    for (const entry of files) {
      const file = path.join(entry.parentPath, entry.name);
      metadata.fileSHA256[path.relative(options.catalog, file)] = hash(await fs.readFile(file));
    }
  }
  await report(metadata);
  assert.equal(metadata.snapshotDigest, activeDigest);
  assert.equal(files.length, fixtureFiles);
  const runtime = await fs.readFile(path.join(options.catalog,
    'plugins/agent-subagent/skills/spawn-subagent/scripts/runtime/windows-native.mjs'), 'utf8');
  assert.doesNotMatch(runtime, /aw-plugin-staging-/u, 'The public fixture must not embed a transient staging path.');
} else if (options.mode === 'archive') {
  const expected = (await fs.readFile(path.join(options.catalog, 'catalog.sha256'), 'utf8')).split(/\s/u)[0];
  const archiveSHA256 = hash(await fs.readFile(path.join(options.catalog, 'catalog.tgz')));
  assert.match(expected, /^[0-9a-f]{64}$/u);
  assert.equal(archiveSHA256, expected);
  const fixture = JSON.parse(await fs.readFile(path.join(options.catalog, 'catalog-fixture.json'), 'utf8'));
  assert.equal(fixture.snapshotDigest, activeDigest);
  assert.equal(fixture.regularFiles, fixtureFiles);
  await report({ archiveSHA256, ...fixture });
} else if (options.mode === 'read-once' || options.mode === 'remounted-read') {
  const catalog = await fs.realpath(options.catalog);
  const workspaceSHA256 = await variantDigest(options.root);
  await core(options.root);
  const remounted = options.mode === 'remounted-read';
  let before = null;
  let cacheState = 'first application read after extraction, OS page cache unverified';
  if (process.platform === 'linux') {
    before = filePages('evict', catalog);
    cacheState = before.residentPages === 0
      ? 'regular file pages evicted and checked before validation'
      : 'some regular file pages still resident';
  } else if (process.platform === 'darwin' && remounted) {
    before = filePages('inspect', catalog);
    cacheState = before.residentPages === 0
      ? 'read-only APFS after remount, no regular file pages reported resident'
      : 'read-only APFS after remount, some regular file pages still resident';
  } else if (remounted) {
    cacheState = 'read-only NTFS after VHD remount, system file cache unverified';
  }
  const result = await validate(options.root, catalog);
  const after = before ? filePages('inspect', catalog) : null;
  await report({ host, workspaceSHA256, cacheState, pagesBefore: before, pagesAfter: after, result });
} else {
  const variants = { serial: options.serial, four: options.four, eight: options.eight };
  assert.ok(Object.values(variants).every(Boolean) && options.catalog, 'Provide --serial, --four, --eight and --catalog.');
  const names = Object.keys(variants);
  const catalog = await fs.realpath(options.catalog);
  const buildDigests = await Promise.all(names.map(async (name) => [name, await variantDigest(variants[name])]));
  assert.equal(new Set(buildDigests.map(([, digest]) => digest)).size, names.length);
  const result = { host, workspaceSHA256: Object.fromEntries(buildDigests) };
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-digest-compare-')));
  try {
    if (options.mode === 'all' || options.mode === 'warm') {
      for (const name of names) await validate(variants[name], catalog);
      const orders = [names, [...names].reverse(), ['four', 'eight', 'serial'],
        ['serial', 'eight', 'four'], ['eight', 'serial', 'four'], ['four', 'serial', 'eight']];
      result.warm = [];
      result.warmCacheState = 'all variants validated this snapshot once before measured rounds';
      for (const order of orders) {
        const row = {};
        for (const name of order) row[name] = await validate(variants[name], catalog);
        result.warm.push(row);
      }
      assert.equal(new Set(result.warm.flatMap((round) => Object.values(round).map((item) => item.manifestSHA256))).size, 1);
    }
    if (options.mode === 'all' || options.mode === 'checks') result.checks = await check(variants, catalog, root);
    if (options.mode === 'all' || options.mode === 'memory') result.largeFiles = await memory(variants, root);
    assert.ok(result.warm || result.checks || result.largeFiles, 'Use all, warm, checks, memory or read-once.');
    await report(result);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
