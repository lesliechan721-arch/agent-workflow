import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { antigravityDistributions, acquireAntigravityDistribution, extractAntigravityArchive, getAntigravityDistribution } from './native-platform-antigravity-distributions.mjs';
import { prepareEnvironment } from './native-platform-runtime.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-agy-distribution-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, env: await prepareEnvironment(root) };
}

// Test Value Gate: every required Hosted cell has an exact official archive;
// the Windows archives contain antigravity.exe, not a guessed command name.
test('selects only the six pinned Antigravity release assets', () => {
  assert.deepEqual(Object.keys(antigravityDistributions).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
  for (const [key, item] of Object.entries(antigravityDistributions)) {
    const [platform, arch] = key.split('-');
    assert.equal(getAntigravityDistribution({ platform, arch }), item);
    assert.equal(item.version, '1.3.4'); assert.match(item.sha256, /^[a-f0-9]{64}$/u);
    assert(item.url.startsWith('https://github.com/google-antigravity/antigravity-cli/releases/download/1.3.4/'));
    assert.equal(item.entry, platform === 'win32' ? 'antigravity.exe' : 'antigravity');
    assert.equal(item.format, platform === 'win32' ? 'zip' : 'tar.gz');
  }
  assert.throws(() => getAntigravityDistribution({ platform: 'freebsd', arch: 'x64' }), /distribution-unavailable/u);
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const files = [], directory = []; let offset = 0;
  for (const { name, body = 'fixture', mode = 0o100600, size } of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(body), digest = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(digest, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(size ?? bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(digest, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(size ?? bytes.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    files.push(local, filename, bytes); directory.push(central, filename); offset += local.length + filename.length + bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}

test('extracts ZIP regular files and directories without invoking the contained entry', async t => {
  const { root, env } = await fixture(t);
  const archive = path.join(root, 'regular.zip');
  await fs.writeFile(archive, zip([{ name: 'nested/', body: '', mode: 0o40700 }, { name: 'nested/antigravity.exe', body: 'not executable' }]));
  const destination = path.join(root, 'regular');
  const observed = await extractAntigravityArchive(archive, destination, { format: 'zip' }, env);
  assert.equal(observed.archiveEntries, 2); assert.equal(observed.expandedBytes, Buffer.byteLength('not executable'));
  assert.equal(await fs.readFile(path.join(destination, 'nested/antigravity.exe'), 'utf8'), 'not executable');
});

// Test Value Gate: Windows ZIPs must reject links, path aliases, traversal,
// duplicate names and expansion limits before any entry can become a launcher.
test('rejects unsafe, duplicate and oversized ZIP entries', async t => {
  const { root, env } = await fixture(t);
  const cases = [
    [{ name: '../escaped' }], [{ name: '/absolute' }], [{ name: 'C:/escaped' }], [{ name: 'linked', mode: 0o120777 }],
    [{ name: 'back\\slash' }], [{ name: 'name:stream' }], [{ name: 'NUL.txt' }], [{ name: 'trailing.' }],
    [{ name: 'same' }, { name: 'SAME' }], [{ name: 'oversized', body: '', size: 768 * 1024 * 1024 + 1 }],
  ];
  for (const [index, entries] of cases.entries()) {
    const archive = path.join(root, `bad-${index}.zip`);
    await fs.writeFile(archive, zip(entries));
    await assert.rejects(extractAntigravityArchive(archive, path.join(root, `bad-${index}`), { format: 'zip' }, env), /archive-extraction-failed/u);
  }
  const many = path.join(root, 'many.zip');
  await fs.writeFile(many, zip(Array.from({ length: 20001 }, (_, index) => ({ name: `entry-${index}`, body: '' }))));
  await assert.rejects(extractAntigravityArchive(many, path.join(root, 'many'), { format: 'zip' }, env), /archive-extraction-failed/u);
  await assert.rejects(fs.stat(path.join(root, 'escaped')), { code: 'ENOENT' });
});

test('routes tar.gz through the existing bounded regular-entry extractor', { skip: process.platform === 'win32' }, async t => {
  const { root, env } = await fixture(t);
  const header = Buffer.alloc(512), body = Buffer.from('tar fixture');
  header.write('antigravity'); header.write('0000755\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
  header.fill(0x20, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  const archive = path.join(root, 'regular.tar.gz');
  await fs.writeFile(archive, gzipSync(Buffer.concat([header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)])));
  const observed = await extractAntigravityArchive(archive, path.join(root, 'tar'), { format: 'tar.gz' }, env);
  assert.equal(observed.archiveEntries, 1); assert.equal(await fs.readFile(path.join(root, 'tar/antigravity'), 'utf8'), 'tar fixture');
});

test('rejects unpinned download bytes before creating an extraction directory', async t => {
  const { root, env } = await fixture(t);
  await assert.rejects(acquireAntigravityDistribution(root, env, { host: { platform: 'win32', arch: 'x64' },
    fetchImpl: async () => new Response(Buffer.from('wrong archive')) }), /archive-sha256-mismatch/u);
  await assert.rejects(fs.stat(path.join(root, 'distribution')), { code: 'ENOENT' });
});
