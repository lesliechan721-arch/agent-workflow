import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { NativeToolError, isSafeNativeArchivePath, validateNativeBinary } from './descriptor.mjs';

function reject(code = 'nativeArchiveInvalid') { throw new NativeToolError(code); }

function field(buffer) {
  const zero = buffer.indexOf(0);
  if (zero >= 0 && buffer.subarray(zero).some((byte) => byte !== 0)) reject();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(zero < 0 ? buffer : buffer.subarray(0, zero)); } catch { reject(); }
}

function octal(buffer) {
  const value = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value)) reject();
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) reject();
  return number;
}

export function extractNativeArchive(archive, variant) {
  if (archive.length > variant.limits.archiveBytes) reject('nativeArchiveLimitExceeded');
  const actual = createHash('sha512').update(archive).digest();
  if (!timingSafeEqual(actual, Buffer.from(variant.transport.archiveIntegrity.slice(7), 'base64'))) reject('nativeArchiveIntegrityMismatch');
  let tar;
  // Headers and padding also consume the expanded budget, bounding decompression bombs.
  try { tar = gunzipSync(archive, { maxOutputLength: variant.limits.expandedBytes }); } catch { reject('nativeArchiveExpansionInvalid'); }
  if (tar.length % 512 !== 0) reject();
  const seen = new Set();
  const files = new Set();
  let executable;
  let manifest;
  let offset = 0;
  let terminated = false;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || tar.subarray(offset).some((byte) => byte !== 0)) reject();
      offset = tar.length;
      terminated = true;
      break;
    }
    if (seen.size >= variant.limits.entries) reject('nativeArchiveLimitExceeded');
    if (header.subarray(257, 263).toString('ascii') !== 'ustar\0'
      || header.subarray(263, 265).toString('ascii') !== '00') reject('nativeArchiveFormatUnsupported');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== octal(header.subarray(148, 156))) reject();
    const prefix = field(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ''}${field(header.subarray(0, 100))}`;
    const type = header[156];
    if (![0, 48, 53].includes(type) || field(header.subarray(157, 257))) reject('nativeArchiveEntryUnsafe');
    const directory = type === 53;
    if (!isSafeNativeArchivePath(name, directory)) reject('nativeArchiveEntryUnsafe');
    const identity = (directory && name.endsWith('/') ? name.slice(0, -1) : name).toLowerCase();
    if (seen.has(identity)) reject('nativeArchiveEntryUnsafe');
    for (const previous of seen) {
      if (previous.startsWith(`${identity}/`) && !directory) reject('nativeArchiveEntryUnsafe');
    }
    const parentParts = identity.split('/');
    for (let i = 1; i < parentParts.length; i += 1) {
      if (files.has(parentParts.slice(0, i).join('/'))) reject('nativeArchiveEntryUnsafe');
    }
    seen.add(identity);
    const size = octal(header.subarray(124, 136));
    if (directory && size !== 0) reject();
    const end = offset + 512 + size;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) reject();
    if (!directory) {
      files.add(identity);
      // Separate bookkeeping avoids accepting a regular file as a later parent.
      if (name === variant.transport.entry) executable = tar.subarray(offset + 512, end);
      if (name === 'package/package.json') {
        if (size > 64 * 1024) reject('nativeArchiveLimitExceeded');
        try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(tar.subarray(offset + 512, end))); } catch { reject(); }
      }
    }
    offset = next;
  }
  if (!terminated || !executable || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.name !== variant.transport.package || manifest.version !== variant.transport.version) reject('nativePackageMismatch');
  if (Object.hasOwn(manifest, 'scripts') && (!manifest.scripts || typeof manifest.scripts !== 'object'
    || Array.isArray(manifest.scripts) || Object.keys(manifest.scripts).length !== 0)) reject('nativePackageScriptForbidden');
  validateNativeBinary(executable, variant);
  return executable;
}
