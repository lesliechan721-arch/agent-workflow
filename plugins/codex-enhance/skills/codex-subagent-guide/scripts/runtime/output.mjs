import { fail, LIMITS } from './contracts.mjs';
import { readRecord } from './store.mjs';

export const OUTPUT_LIMIT = 32768;
export const STDERR_LIMIT = 1024;
const attribute = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const routineDiagnostics = new Set(['codexExecutableSelected', 'communicationPermissionExisting',
  'communicationPermissionAdded', 'profileFieldIrrelevant', 'hookTrustBypassed']);
const sameDiagnostic = (left, right) => left.code === right.code && left.field === right.field && left.message === right.message;

export function textBlock(kind, text, attributes = {}) {
  const base = kind.toLowerCase();
  let name = base;
  for (let suffix = 2; text.includes(`</${name}>`); suffix++) name = `${base}_${suffix}`;
  const properties = Object.entries(attributes).filter(([, value]) => value !== undefined).map(([key, value]) => ` ${key}="${attribute(value)}"`).join('');
  return `<${name}${properties}>\n${text}\n</${name}>\n`;
}
export const communication = (snapshot) => snapshot.initialization?.capabilities.communication === undefined ? 'pending' : String(snapshot.initialization.capabilities.communication.status === 'enabled');
export const resume = (snapshot) => {
  const status = snapshot.initialization?.capabilities.resume?.status ?? snapshot.resume;
  return status === undefined ? 'pending' : String(status === 'enabled');
};
export const needsInitialization = (run) => run.snapshot.initializationSequence > run.observed.initializationSequence ||
  Boolean(run.result && run.snapshot.initialization === null && !run.observed.terminalConsumed);

export function diagnostic(code, message = 'The operation failed. Check this code before continuing.', run, field) {
  const attributes = { ...(run === undefined ? {} : { run }), code, ...(field === undefined ? {} : { field }) };
  if (Buffer.byteLength(message) <= 640) return textBlock('diagnostic', message, attributes);
  return textBlock('diagnostic', 'The diagnostic text was omitted. Correct this error before continuing.', attributes) +
    textBlock('diagnostic', 'The original diagnostic exceeds the display budget.', { ...(run === undefined ? {} : { run }), code: 'diagnosticOmitted' });
}

function diagnosticPrefix(value, maximumBytes) {
  let result = '', bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > maximumBytes) break;
    result += character;
  }
  return result;
}

export function initializationDiagnostics(diagnostics, run, initialization, { control = false, maximumBytes = control ? OUTPUT_LIMIT - STDERR_LIMIT : Infinity, showDiagnostics = false } = {}) {
  const entries = (diagnostics ?? []).filter((entry, index, all) =>
    (showDiagnostics || !routineDiagnostics.has(entry.code)) && all.findIndex((other) => sameDiagnostic(entry, other)) === index);
  const environment = initialization?.environment;
  const environmentFailure = 'The executor environment is unavailable. Repair the executor and start a new run.';
  if (environment?.status === 'unavailable' && !entries.some((entry) => entry.code === environment.code)) {
    entries.push({ code: environment.code, message: environmentFailure });
  }
  const complete = entries.map((entry) => diagnostic(entry.code, entry.message, run, entry.field)).join('');
  if (Buffer.byteLength(complete) <= maximumBytes) return complete;
  const omitted = diagnostic('diagnosticOmitted', 'Initialization diagnostic text or field paths were omitted to fit this report. After termination, use result --diagnostics --output-file PATH for the complete report.', run);
  const render = (textBytes, fields) => entries.map((entry) => textBlock('diagnostic', environment?.status === 'unavailable' && entry.code === environment.code ? environmentFailure : diagnosticPrefix(entry.message, textBytes), { code: entry.code, ...(fields && entry.field !== undefined ? { field: entry.field } : {}) })).join('') + omitted;
  // Keep original codes and field paths when they fit. Bound the complete group,
  // including framing, instead of applying only a per-message truncation limit.
  const fields = Buffer.byteLength(render(0, true)) <= maximumBytes;
  if (Buffer.byteLength(render(0, fields)) <= maximumBytes) {
    let minimum = 0, maximum = 640;
    while (minimum < maximum) {
      const middle = Math.ceil((minimum + maximum) / 2);
      if (Buffer.byteLength(render(middle, fields)) <= maximumBytes) minimum = middle;
      else maximum = middle - 1;
    }
    return render(minimum, fields);
  }
  // Long legal codes can themselves exceed a small final's remaining space.
  // Keep every code in one bounded notice; the caller can defer the final body.
  const codes = [...new Set(entries.map((entry) => entry.code))];
  return textBlock('diagnostic', `Initialization reported these codes: ${codes.join(', ')}. ${environment?.status === 'unavailable' ? environmentFailure + ' ' : ''}Diagnostic text and field paths were omitted. After termination, use result --diagnostics --output-file PATH for the complete report.`, { run, code: 'diagnosticOmitted' });
}

export function gapText(gap, run) {
  if (!['notSubmitted', 'unknown'].includes(gap.status) || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(gap.code ?? '') ||
    typeof gap.text !== 'string' || !gap.text.isWellFormed() || !gap.text.trim() || gap.text.includes('\0') || Buffer.byteLength(gap.text) > LIMITS.messageBodyBytes) fail('runStateUnavailable', 'An input delivery record is invalid.');
  return (gap.message ? diagnostic(gap.code, gap.message, run) : '') + textBlock('input', gap.text, { run, delivery: gap.status, code: gap.code });
}

export async function eventText(run, name) {
  const event = await readRecord(run, 'events', name);
  if (event.type === 'delivery') return gapText(await readRecord(run, 'gaps', event.gap), run.handle);
  if (event.type !== 'message' || typeof event.text !== 'string' || !event.text.isWellFormed() || !event.text.trim() || event.text.includes('\0') || Buffer.byteLength(event.text) > LIMITS.messageBodyBytes) fail('runStateUnavailable', 'A process message is invalid.');
  return textBlock('message', event.text, { run: run.handle });
}

export async function* finalChunks(run, gaps, includeInitialization = needsInitialization(run), options = {}) {
  const result = run.result;
  const reported = !options.showDiagnostics && run.snapshot.ready && !includeInitialization ? run.snapshot.diagnostics ?? [] : [];
  const diagnostics = [
    ...(run.snapshot.ready ? run.snapshot.diagnostics ?? [] : []),
    ...(result.diagnostics ?? (includeInitialization ? run.snapshot.diagnostics : []) ?? []),
  ].filter((entry) => !reported.some((previous) => sameDiagnostic(entry, previous)));
  if (options.diagnostics !== false) yield initializationDiagnostics(diagnostics, run.handle, includeInitialization ? run.snapshot.initialization : undefined,
    { maximumBytes: options.diagnosticBytes ?? Infinity, showDiagnostics: options.showDiagnostics });
  for (const name of gaps) yield gapText(await readRecord(run, 'gaps', name), run.handle);
  if (result.message) yield diagnostic(result.code ?? 'resultDiagnostic', result.message, run.handle);
  yield textBlock('result', result.text, {
    run: run.handle, state: result.state,
    ...(includeInitialization ? { communication: communication(run.snapshot), resume: resume(run.snapshot) } : {}),
    ...(result.state !== 'completed' ? { text_status: result.text ? 'partial' : 'missing', generation_started: result.generationStarted, backend_exit_code: result.backendExitCode } : {}),
    ...(result.code ? { code: result.code } : {}),
    ...(run.meta.stopRequested || Object.hasOwn(result, 'remoteStopConfirmed') ? { remote_stop_confirmed: result.remoteStopConfirmed ?? 'unknown' } : {}),
  });
}

export async function uncoveredGaps(run, events, gaps) {
  const covered = new Set();
  for (const name of events) {
    const event = await readRecord(run, 'events', name);
    if (event.type === 'delivery') covered.add(event.gap);
  }
  return gaps.filter((name) => !covered.has(name));
}

export function resultReport(run, events, gaps, options = {}) {
  return async function* () {
    for (const name of events) yield await eventText(run, name);
    yield* finalChunks(run, await uncoveredGaps(run, events, gaps), needsInitialization(run), options);
  };
}

// The frozen record lists are measured before any consumption or file creation.
export async function measureReport(factory) {
  let bytes = 0;
  for await (const chunk of factory()) bytes += Buffer.byteLength(chunk);
  return { bytes };
}

export async function collectReport(factory, _token, maximum = OUTPUT_LIMIT) {
  const chunks = []; let bytes = 0;
  for await (const chunk of factory()) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maximum) fail('resultTooLarge', 'The complete report exceeds the output limit.');
    chunks.push(chunk);
  }
  return chunks.join('');
}

export async function writeChunk(stream, text) {
  if (stream.destroyed || stream.writableEnded) fail('resultOutputFailed', 'The output stream is closed.');
  await new Promise((resolve, reject) => {
    const onError = (error) => { stream.off('error', onError); reject(error); };
    stream.once('error', onError);
    stream.write(text, 'utf8', (error) => {
      stream.off('error', onError);
      if (error) reject(error); else resolve();
    });
  });
}

export const exportHint = (handle) => `Use result --run ${handle} --output-file PATH to read the complete report.`;
