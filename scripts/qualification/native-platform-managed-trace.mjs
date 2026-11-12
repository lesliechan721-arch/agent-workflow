import { closeSync, openSync, realpathSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

const PUBLIC_MARKER = 'AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER';
const UUID = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/giu;

function canonicalFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return undefined;
  try { const resolved = realpathSync(file); return statSync(resolved).isFile() ? resolved : undefined; }
  catch { return undefined; }
}

function markerValues(...environments) {
  return [...new Set(environments.flatMap((environment) => Object.entries(environment ?? {})
    .filter(([name, value]) => /MARKER/iu.test(name) && typeof value === 'string' && value.length > 0)
    .map(([, value]) => value)))].sort((left, right) => right.length - left.length);
}

function redact(value, markers, limit) {
  let text = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : '';
  let previous;
  do {
    previous = text;
    for (const marker of markers) text = text.replaceAll(marker, '');
    text = text.replace(UUID, '');
  } while (text !== previous);
  return text.slice(0, limit);
}

// Own only a new temporary file; an existing path or symlink is never opened.
export function createManagedTraceWriter(file) {
  let descriptor;
  let closed = false;
  let count = 0;
  let bytes = 0;
  function close() {
    closed = true;
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Diagnostics cannot affect AW. */ }
      descriptor = undefined;
    }
  }
  return { close, emit(record) {
    if (closed || count >= 96) return false;
    try {
      const json = JSON.stringify(record);
      if (typeof json !== 'string') return false;
      const line = Buffer.from(`${json}\n`, 'utf8');
      if (line.length > 256 * 1024 - bytes) return false;
      if (descriptor === undefined) descriptor = openSync(file, 'wx', 0o600);
      for (let offset = 0; offset < line.length;) {
        const written = writeSync(descriptor, line, offset, line.length - offset);
        if (written <= 0) throw new Error('trace-write-incomplete');
        offset += written;
      }
      count += 1; bytes += line.length;
      return true;
    } catch { close(); return false; }
  } };
}

export function createManagedTraceRunner(base, { entries, client, env = process.env, emit }) {
  const targets = new Set(entries.map(canonicalFile).filter(Boolean));
  const preloadMarker = env[PUBLIC_MARKER];
  const preloadMarkers = markerValues(process.env, env);
  let operationId = 0;
  return function managedTraceRunner(invocation) {
    let details;
    let registryList;
    let markers;
    try {
      const direct = targets.has(canonicalFile(invocation.command));
      const prefixed = !direct && Array.isArray(invocation.args) && targets.has(canonicalFile(invocation.args[0]));
      if ((direct || prefixed) && Array.isArray(invocation.args) && invocation.args.every((argument) => typeof argument === 'string')) {
        markers = [...new Set([...preloadMarkers, ...markerValues(process.env, env, invocation.env)])];
        const args = prefixed ? invocation.args.slice(1) : invocation.args;
        registryList = client === 'codex' && args.length === 4
          && args.every((argument, index) => argument === ['plugin', 'marketplace', 'list', '--json'][index]);
        details = { operationId: ++operationId, startTime: new Date().toISOString(), parentPid: process.pid,
          command: invocation.command, args: invocation.args.slice(0, 16),
          publicMarkerProvided: typeof preloadMarker === 'string' && preloadMarker.length > 0
            && invocation.env?.[PUBLIC_MARKER] === preloadMarker };
      }
    } catch { /* Invalid diagnostic input leaves the real runner unchanged. */ }
    if (!details) return base(invocation);
    function record(phase, value, threw = false) {
      try {
        const allMarkers = [...new Set([...markers, ...markerValues(process.env, env, invocation.env)])];
        const text = (input, limit = 1024) => typeof input === 'string' || Buffer.isBuffer(input) ? redact(input, allMarkers, limit) : null;
        const code = (input) => typeof input === 'number' ? input : text(input);
        const failed = threw || typeof value?.exitCode === 'number' && value.exitCode !== 0;
        emit({ ...details, phase: text(phase), startTime: text(details.startTime), command: text(details.command),
          args: details.args.map((argument) => text(argument)), finishTime: phase === 'finish' ? text(new Date().toISOString()) : null,
          ...(phase === 'finish' ? { threw, exitCode: typeof value?.exitCode === 'number' ? value.exitCode : null,
            reason: text(value?.reason), cause: { code: code(value?.cause?.code) },
            operationDiagnostic: { code: text(value?.operationDiagnostic?.code), safeMessage: text(value?.operationDiagnostic?.safeMessage) },
            cleanupError: Boolean(value?.cleanupError),
            ...(!failed && registryList ? { stdout: text(value?.stdout, 4000) } : {}),
            ...(failed ? { stderr: text(value?.stderr, 4000) } : {}) } : {}) });
      } catch { /* Never read error.message or replace a real result/error. */ }
    }
    record('start');
    return (async () => {
      try { const result = await base(invocation); record('finish', result); return result; }
      catch (error) { record('finish', error, true); throw error; }
    })();
  };
}

export function managedTraceConfiguration(env = process.env, platform = process.platform) {
  try {
    if (env.GITHUB_ACTIONS !== 'true' || env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE !== '1'
      || !['linux', 'win32'].includes(platform)
      || !['codex', 'pi'].includes(env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT)) return undefined;
    const entries = JSON.parse(env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES);
    const file = env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE;
    if (!Array.isArray(entries) || !entries.length || !entries.every((entry) => canonicalFile(entry))
      || typeof file !== 'string' || !path.isAbsolute(file)) return undefined;
    return { entries, file, client: env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT };
  } catch { return undefined; }
}

async function installFromEnvironment() {
  const configuration = managedTraceConfiguration();
  if (!configuration) return false;
  const writer = createManagedTraceWriter(configuration.file);
  try {
    const native = await import('../../packages/cli/dist/src/utils/native-cli.js');
    const base = native.getDefaultNativeCliRunner();
    const wrapper = createManagedTraceRunner(base, { ...configuration, env: process.env, emit: writer.emit });
    native.setNativeCliRunnerOverrideForTests(native.retainNativeCliRunnerBackend(wrapper, base));
    process.once('exit', writer.close);
    return true;
  } catch { writer.close(); return false; }
}

// --import applies only to outer AW. The real default backend and its deadlines
// remain in use. Synchronous trace IO has time/IO cost; this private diagnostic
// does not provide performance evidence without instrumentation. parentPid is AW
// only; the logical runner exposes no child identity or final native environment.
export const managedTraceInstalled = await installFromEnvironment();
