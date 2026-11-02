import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 0x3c);
  bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(machine, 132);
  return bytes;
}

export function tarball(entries) {
  const chunks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000700\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.link) header.write(entry.link, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const sum = header.reduce((value, byte) => value + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

export function fixture({ binary = pe(), scripts, extra = [], entries } = {}) {
  const manifest = { name: '@example/job-win32-x64', version: '1.2.3', ...(scripts === undefined ? {} : { scripts }) };
  const archive = tarball(entries ?? [
    { name: 'package/package.json', content: JSON.stringify(manifest) },
    { name: 'package/dist/job.exe', content: binary },
    ...extra,
  ]);
  const descriptor = {
    schemaVersion: 1,
    tool: { id: '@example/job', version: '1.2.3', protocol: 'aw.windows-job.v1' },
    variants: [{
      platform: 'win32', arch: 'x64',
      transport: { kind: 'npm', package: manifest.name, version: manifest.version, archiveIntegrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`, entry: 'package/dist/job.exe' },
      file: { sha256: `sha256:${createHash('sha256').update(binary).digest('hex')}`, size: binary.length, format: 'pe', machine: '0x8664' },
      limits: { archiveBytes: 64 * 1024, expandedBytes: 64 * 1024, entries: 16 },
    }],
  };
  return { archive, descriptor, binary };
}

export async function tempFixture(test, options) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'aw-native-runtime-'));
  const { rm } = await import('node:fs/promises');
  test.after(() => rm(directory, { recursive: true, force: true }));
  const data = fixture(options);
  const archivePath = path.join(directory, 'archive.tgz');
  await writeFile(archivePath, data.archive);
  return { ...data, directory, archivePath, cacheRoot: path.join(directory, 'cache'), platform: 'win32', arch: 'x64' };
}
