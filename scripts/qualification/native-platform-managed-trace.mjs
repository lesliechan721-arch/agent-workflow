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

export function createManagedTraceRunner(base, { entries, client, env = process.env, emit, platform = process.platform }) {
  const targets = new Set(entries.map(canonicalFile).filter(Boolean));
  function sameFile(file, target) {
    if (file === target && typeof file === 'string') return true;
    if (platform !== 'win32' || typeof file !== 'string' || typeof target !== 'string'
      || target.toLowerCase() !== file.toLowerCase()) return false;
    // Windows realpath can retain requested case. Require a case alias and
    // the same file identity before recording the selected client.
    try {
      const actual = statSync(file, { bigint: true });
      const expected = statSync(target, { bigint: true });
      return actual.isFile() && expected.isFile() && actual.ino !== 0n
        && expected.dev === actual.dev && expected.ino === actual.ino;
    } catch { return false; }
  }
  const matchesTarget = (file) => [...targets].some((target) => sameFile(file, target));
  const systemRoot = Object.entries(env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1];
  const queryEntry = client === 'codex' && platform === 'win32' && typeof systemRoot === 'string' && path.isAbsolute(systemRoot)
    ? canonicalFile(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')) : undefined;
  const preloadMarker = env[PUBLIC_MARKER];
  const preloadMarkers = markerValues(process.env, env);
  let operationId = 0;
  let unmatchedCount = 0;
  return function managedTraceRunner(invocation) {
    let details;
    let registryList;
    let markers;
    let querySample;
    try {
      const commandFile = canonicalFile(invocation.command);
      const firstArgument = Array.isArray(invocation.args) ? invocation.args[0] : undefined;
      const argumentFile = canonicalFile(firstArgument);
      const direct = matchesTarget(commandFile);
      const prefixed = !direct && matchesTarget(argumentFile);
      if ((direct || prefixed) && Array.isArray(invocation.args) && invocation.args.every((argument) => typeof argument === 'string')) {
        markers = [...new Set([...preloadMarkers, ...markerValues(process.env, env, invocation.env)])];
        const args = prefixed ? invocation.args.slice(1) : invocation.args;
        registryList = client === 'codex' && args.length === 4
          && args.every((argument, index) => argument === ['plugin', 'marketplace', 'list', '--json'][index]);
        details = { operationId: ++operationId, startTime: new Date().toISOString(), parentPid: process.pid,
          command: invocation.command, args: invocation.args.slice(0, 16),
          publicMarkerProvided: typeof preloadMarker === 'string' && preloadMarker.length > 0
            && invocation.env?.[PUBLIC_MARKER] === preloadMarker };
      } else if (unmatchedCount < 8) {
        unmatchedCount += 1;
        // Fixed facts only: unmatched calls must not expose paths, argv or env.
        const absolute = (value) => typeof value === 'string' && path.isAbsolute(value);
        const insensitiveMatch = (file) => process.platform === 'win32' && typeof file === 'string'
          && [...targets].some((target) => target.toLowerCase() === file.toLowerCase());
        const unmatched = { phase: 'unmatched', commandAbsolute: absolute(invocation.command), commandResolved: Boolean(commandFile),
          firstArgumentAbsolute: absolute(firstArgument), firstArgumentResolved: Boolean(argumentFile),
          commandCaseInsensitiveMatch: insensitiveMatch(commandFile), argumentCaseInsensitiveMatch: insensitiveMatch(argumentFile),
          argumentsAreStrings: Array.isArray(invocation.args) && invocation.args.every((argument) => typeof argument === 'string') };
        if (queryEntry && sameFile(commandFile, queryEntry)) querySample = {
          unmatched, startTime: new Date().toISOString(), startedAt: performance.now(),
        };
        else emit(unmatched);
      }
    } catch { /* Invalid diagnostic input leaves the real runner unchanged. */ }
    if (!details) {
      if (!querySample) return base(invocation);
      // One completed sample replaces its unmatched row. No argv, environment
      // or output is recorded; an unfinished query supplies no completion fact.
      const finish = (value, threw) => {
        try { emit({ ...querySample.unmatched, commandRole: 'windows-system-powershell', startTime: querySample.startTime,
          finishTime: new Date().toISOString(), elapsedMs: performance.now() - querySample.startedAt,
          threw, exitCode: typeof value?.exitCode === 'number' ? value.exitCode : null }); }
        catch { /* Diagnostics cannot replace the original result or error. */ }
      };
      let pending;
      try { pending = base(invocation); }
      catch (error) { finish(error, true); throw error; }
      try { Promise.prototype.then.call(pending, (result) => finish(result, false), (error) => finish(error, true)); }
      catch { /* Keep the original Promise even if completion cannot be observed. */ }
      return pending;
    }
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

function traceRequested(env, platform) {
  return env.GITHUB_ACTIONS === 'true' && env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE === '1'
    && ['linux', 'darwin', 'win32'].includes(platform)
    && ['codex', 'pi', 'claude', 'gemini', 'copilot'].includes(env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT)
    && typeof env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE === 'string'
    && path.isAbsolute(env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE);
}

export function managedTraceConfiguration(env = process.env, platform = process.platform) {
  try {
    if (!traceRequested(env, platform)) return undefined;
    const entries = JSON.parse(env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES);
    const file = env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE;
    if (!Array.isArray(entries) || !entries.length || !entries.every((entry) => canonicalFile(entry))
      || typeof file !== 'string' || !path.isAbsolute(file)) return undefined;
    return { entries, file, client: env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT };
  } catch { return undefined; }
}

async function installFromEnvironment() {
  if (!traceRequested(process.env, process.platform)) return false;
  const writer = createManagedTraceWriter(process.env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE);
  const configuration = managedTraceConfiguration();
  if (!configuration) {
    writer.emit({ phase: 'installation', state: 'configuration-rejected' }); writer.close(); return false;
  }
  writer.emit({ phase: 'installation', state: 'loading-runner' });
  try {
    const native = await import('../../packages/cli/dist/src/utils/native-cli.js');
    const base = native.getDefaultNativeCliRunner();
    const wrapper = createManagedTraceRunner(base, { ...configuration, env: process.env, emit: writer.emit });
    native.setNativeCliRunnerOverrideForTests(native.retainNativeCliRunnerBackend(wrapper, base));
    writer.emit({ phase: 'installation', state: 'installed' });
    process.once('exit', writer.close);
    return true;
  } catch { writer.emit({ phase: 'installation', state: 'runner-install-failed' }); writer.close(); return false; }
}

// --import applies only to outer AW. The real default backend and its deadlines
// remain in use. Synchronous trace IO has time/IO cost; this private diagnostic
// does not provide performance evidence without instrumentation. parentPid is AW
// only; the logical runner exposes no child identity or final native environment.
export const managedTraceInstalled = await installFromEnvironment();
