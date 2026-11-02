import { createHash, timingSafeEqual } from 'node:crypto';

export class NativeToolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NativeToolError';
    this.code = code;
  }
}

export const NATIVE_TOOL_LIMITS = Object.freeze({
  archiveBytes: 16 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  entries: 64,
  timeoutMs: 30_000,
});

function fail(code = 'nativeDescriptorInvalid') {
  throw new NativeToolError(code);
}

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  if (Object.keys(value).some((key) => !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(value, key))) fail();
  return value;
}

function matches(value, expression, maxLength = 256) {
  if (typeof value !== 'string' || value.length > maxLength || !expression.test(value)) fail();
  return value;
}

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** Windows-safe canonical archive names, independent of the host OS. */
export function isSafeNativeArchivePath(value, directory = false) {
  if (typeof value !== 'string' || value.length > 512 || !value || /[\x00-\x1f\x7f\\:]/.test(value)) return false;
  const path = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = path.split('/');
  return segments[0] === 'package' && segments.every((part) => part && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/[<>"|?*]/.test(part)
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

export function parseNativeToolDescriptor(value) {
  object(value, ['schemaVersion', 'tool', 'variants']);
  if (value.schemaVersion !== 1) fail();
  object(value.tool, ['id', 'version', 'protocol']);
  const tool = {
    id: matches(value.tool.id, packageName, 214),
    version: matches(value.tool.version, exactVersion, 128),
    protocol: matches(value.tool.protocol, /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/, 128),
  };
  if (!Array.isArray(value.variants) || value.variants.length < 1 || value.variants.length > 2) fail();
  const seen = new Set();
  const variants = value.variants.map((candidate) => {
    object(candidate, ['platform', 'arch', 'transport', 'file', 'limits']);
    if (candidate.platform !== 'win32' || !['x64', 'arm64'].includes(candidate.arch) || seen.has(candidate.arch)) fail();
    seen.add(candidate.arch);
    const transport = object(candidate.transport, ['kind', 'package', 'version', 'archiveIntegrity', 'entry']);
    if (transport.kind !== 'npm' || !isSafeNativeArchivePath(transport.entry) || !transport.entry.endsWith('.exe')) fail();
    matches(transport.package, packageName, 214);
    matches(transport.version, exactVersion, 128);
    matches(transport.archiveIntegrity, /^sha512-[A-Za-z0-9+/]{86}==$/, 95);
    const integrity = transport.archiveIntegrity.slice(7);
    if (Buffer.from(integrity, 'base64').toString('base64') !== integrity) fail();
    const file = object(candidate.file, ['sha256', 'size', 'format', 'machine']);
    matches(file.sha256, /^sha256:[a-f0-9]{64}$/, 71);
    if (!Number.isSafeInteger(file.size) || file.size < 64 || file.size > NATIVE_TOOL_LIMITS.expandedBytes
      || file.format !== 'pe' || file.machine !== (candidate.arch === 'x64' ? '0x8664' : '0xaa64')) fail();
    const limits = object(candidate.limits, ['archiveBytes', 'expandedBytes', 'entries']);
    for (const key of ['archiveBytes', 'expandedBytes', 'entries']) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > NATIVE_TOOL_LIMITS[key]) fail();
    }
    if (limits.expandedBytes < file.size || limits.entries < 2) fail();
    return { platform: candidate.platform, arch: candidate.arch, transport: { ...transport }, file: { ...file }, limits: { ...limits } };
  });
  variants.sort((a, b) => a.arch.localeCompare(b.arch, 'en'));
  return { schemaVersion: 1, tool, variants };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function nativeToolDescriptorDigest(descriptor) {
  return `sha256:${createHash('sha256').update(canonical(parseNativeToolDescriptor(descriptor))).digest('hex')}`;
}

export function selectNativeToolVariant(descriptor, platform = process.platform, arch = process.arch) {
  const parsed = parseNativeToolDescriptor(descriptor);
  const selected = parsed.variants.find((variant) => variant.platform === platform && variant.arch === arch);
  if (!selected) fail('nativeVariantUnavailable');
  return selected;
}

export function validateNativeBinary(bytes, variant) {
  if (!(bytes instanceof Uint8Array)) fail('nativeBinaryFormatInvalid');
  if (!variant?.file || !/^sha256:[a-f0-9]{64}$/.test(variant.file.sha256)
    || !Number.isSafeInteger(variant.file.size) || !['0x8664', '0xaa64'].includes(variant.file.machine)) fail();
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length !== variant.file.size) fail('nativeBinarySizeMismatch');
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (!timingSafeEqual(Buffer.from(digest), Buffer.from(variant.file.sha256.slice(7)))) fail('nativeBinaryDigestMismatch');
  if (buffer.length < 64 || buffer.readUInt16LE(0) !== 0x5a4d) fail('nativeBinaryFormatInvalid');
  const offset = buffer.readUInt32LE(0x3c);
  if (offset < 64 || offset > buffer.length - 24 || buffer.readUInt32LE(offset) !== 0x00004550) fail('nativeBinaryFormatInvalid');
  if (buffer.readUInt16LE(offset + 4) !== Number.parseInt(variant.file.machine, 16)) fail('nativeBinaryMachineMismatch');
}
