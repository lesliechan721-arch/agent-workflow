import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './contracts.mjs';

const spawnNative = spawn;
const nativeRoot = fileURLToPath(new URL('./native/windows/', import.meta.url));
const inputLimit = 256 * 1024;
const outputLimit = 8 * 1024 * 1024;
const timeoutMs = 30000;
const sidPattern = /^S-1-\d+(?:-\d+)+$/;
const ticks = (value) => typeof value === 'string' && /^\d{1,20}$/.test(value);
const pid = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
const resourcePath = (value) => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && path.normalize(value) === value;
const kind = (value) => value === 'file' || value === 'directory';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, required, optional = []) => object(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const chain = (value) => value === undefined || Array.isArray(value) && value.every(resourcePath);
const scope = (value) => fields(value, ['kind', 'name', 'sid']) && value.kind === 'windows-job' && /^Local\\aw-subagent-[a-f0-9]{32}$/.test(value.name) && sidPattern.test(value.sid);

function validInput(operation, input) {
  const resource = (value, protection) => fields(value, ['target', 'kind', 'sid'], protection ? ['chain'] : []) && resourcePath(value.target) && kind(value.kind) && sidPattern.test(value.sid) && (!protection || chain(value.chain));
  switch (operation) {
    case 'pathCheck': case 'pathTree': return fields(input, ['target', 'kind'], ['chain']) && resourcePath(input.target) && (operation === 'pathTree' ? input.kind === 'directory' : kind(input.kind)) && chain(input.chain);
    case 'aclVerify': return fields(input, ['resources'], ['chain']) && chain(input.chain) && Array.isArray(input.resources) && input.resources.every((value) => resource(value, false));
    case 'aclProtect': return fields(input, ['resources']) && Array.isArray(input.resources) && input.resources.every((value) => resource(value, true));
    case 'rootPublish': return fields(input, ['source', 'destination']) && resourcePath(input.source) && resourcePath(input.destination);
    case 'processTable': return fields(input, [], ['requiredPids']) && (input.requiredPids === undefined || Array.isArray(input.requiredPids) && input.requiredPids.every(pid));
    case 'processIdentity': case 'processStart': return fields(input, ['pid']) && pid(input.pid);
    case 'processStop': return fields(input, ['pid', 'started', 'sid']) && pid(input.pid) && ticks(input.started) && sidPattern.test(input.sid);
    case 'jobObserve': case 'jobStop': return scope(input);
    default: return false;
  }
}

function processRow(value) {
  return fields(value, ['pid', 'ppid', 'pgid', 'started']) && pid(value.pid) && Number.isSafeInteger(value.ppid) && value.ppid >= 0 && value.ppid <= 0xffffffff && value.pgid === null && ticks(value.started);
}

function validResult(operation, result, input) {
  switch (operation) {
    case 'pathCheck': case 'pathTree': case 'aclVerify': case 'aclProtect': case 'rootPublish': return result === true;
    case 'processStop': return typeof result === 'boolean';
    case 'processStart': return result === null || ticks(result);
    case 'processIdentity': return result === null || processRow(result) && result.pid === input.pid;
    case 'processTable': return Array.isArray(result) && result.every(processRow) && new Set(result.map((row) => row.pid)).size === result.length && result.some((row) => row.pid === process.pid);
    case 'jobObserve': case 'jobStop': return Array.isArray(result) && result.every(pid) && new Set(result).size === result.length;
    default: return false;
  }
}

export async function resolveWindowsNativeHelper({ arch = process.arch, root = nativeRoot } = {}) {
  const unavailable = () => fail('platformUnavailable', 'The Windows native helper is missing or invalid. Sync or reinstall the plugin.');
  if (!['x64', 'arm64'].includes(arch)) unavailable();
  const executable = path.join(root, arch, 'aw-windows-job.exe');
  const manifestPath = path.join(root, 'manifest.json');
  try {
    for (const [target, limit] of [[manifestPath, 64 * 1024], [executable, 64 * 1024 * 1024]]) {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) unavailable();
    }
    for (const target of [root, path.join(root, arch)]) {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
    }
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(manifestPath)));
    const binary = manifest?.binaries?.[arch];
    const machine = arch === 'x64' ? 0x8664 : 0xaa64;
    if (manifest?.schemaVersion !== 1 || !binary || binary.goarch !== (arch === 'x64' ? 'amd64' : 'arm64') || binary.path !== `${arch}/aw-windows-job.exe` || binary.peMachine !== `0x${machine.toString(16)}` || !/^sha256:[a-f0-9]{64}$/.test(binary.sha256 ?? '')) unavailable();
    const bytes = await fs.readFile(executable);
    if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') unavailable();
    const offset = bytes.readUInt32LE(0x3c);
    if (offset < 0x40 || offset > bytes.length - 6 || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== machine || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== binary.sha256) unavailable();
    return executable;
  } catch { unavailable(); }
}

export async function windowsNativeOperation(operation, input = {}) {
  if (!validInput(operation, input)) fail('platformOperationFailed', 'A native Windows operation input is invalid.');
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, operation, input }));
  if (payload.length > inputLimit) fail('platformOperationFailed', 'A native Windows operation input is too large.');
  const executable = await resolveWindowsNativeHelper();
  const started = performance.now();
  const failure = (reason, code = null, signal = null) => {
    fail('platformOperationFailed', `A native Windows identity, access-control, or process operation failed. ${JSON.stringify({ operation, reason, elapsedMs: Math.round(performance.now() - started), timeoutMs, exitCode: Number.isSafeInteger(code) ? code : null, signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGBREAK'].includes(signal) ? signal : null })}`);
  };
  let bytes;
  try {
    bytes = await new Promise((resolve, reject) => {
      const child = spawnNative(executable, ['--operation'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
      const chunks = [];
      let length = 0;
      let reason;
      const timer = setTimeout(() => { reason = 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        length += chunk.length;
        if (length <= outputLimit) chunks.push(chunk);
        else { reason = 'outputLimit'; child.kill('SIGKILL'); }
      });
      child.once('error', () => { clearTimeout(timer); reject({ reason: 'launchFailed' }); });
      child.stdin.once('error', () => { reason ??= 'inputFailed'; child.kill('SIGKILL'); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (reason || code !== 0) reject({ reason: reason ?? 'processExit', code, signal });
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(payload);
    });
  } catch (error) { failure(error.reason ?? 'launchFailed', error.code, error.signal); }
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { failure('invalidJson'); }
  if (!fields(envelope, ['schemaVersion', 'result']) || envelope.schemaVersion !== 1 || !validResult(operation, envelope.result, input)) failure('invalidResult');
  return envelope.result;
}
