import { spawn } from 'node:child_process';
import path from 'node:path';
import { fail } from './contracts.mjs';

const spawnNative = spawn;
// Keep one prepared tool for this process, including background operations.
let windowsJobTool;
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

export async function windowsJobExecutable() {
  windowsJobTool ??= import('./native-tool-reader.mjs')
    .then(({ readNativeTool }) => {
      const tool = readNativeTool('windows-job', 'aw.windows-job.v1');
      if (tool.state !== 'ready') throw new Error();
      return tool;
    }).catch(() => {
      fail('platformUnavailable', 'The Windows native tool context is missing or invalid. Run this command through AW.');
    });
  return (await windowsJobTool).executable;
}

export async function windowsNativeOperation(operation, input = {}) {
  if (!validInput(operation, input)) fail('platformOperationFailed', 'A native Windows operation input is invalid.');
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, operation, input }));
  if (payload.length > inputLimit) fail('platformOperationFailed', 'A native Windows operation input is too large.');
  const executable = await windowsJobExecutable();
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
