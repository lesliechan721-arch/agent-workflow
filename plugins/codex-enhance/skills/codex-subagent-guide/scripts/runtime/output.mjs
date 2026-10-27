import { randomBytes } from 'node:crypto';
import { fail } from './contracts.mjs';
import { readRecord } from './store.mjs';

export const OUTPUT_LIMIT = 8192;
export const STDERR_LIMIT = 1024;
export const chooseBoundary = (data = []) => {
  let token;
  do { token = randomBytes(4).toString('hex'); } while (data.some((value) => String(value).includes(token)));
  return token;
};
export const textBlock = (kind, text, token) => {
  if (text.includes(token)) fail('boundaryCollision', 'The output boundary must be selected again.');
  return `BEGIN_${kind}:${token}\n${text}\nEND_${kind}:${token}\n`;
};
export const communication = (snapshot) => snapshot.communication === null ? 'pending' : String(snapshot.communication.status === 'enabled');
export const needsCommunication = (run) => run.snapshot.communicationSequence > run.observed.communicationSequence ||
  run.result && run.snapshot.communication === null && !run.observed.terminalConsumed;

export function communicationDetails(snapshot) {
  const value = snapshot.communication;
  if (!value) return '';
  return `communication_status: ${value.status}\n${value.status === 'enabled' ? `communication_transport: ${value.transport}\ncommunication_passive_delivery: ${value.passiveDelivery}\ncommunication_active_receive: ${value.activeReceive}\n` : ''}`;
}

export function initializationDiagnostics(diagnostics, token) {
  if (!diagnostics?.length) return '';
  return textBlock('DIAGNOSTIC', diagnostics.map((entry) => `${entry.code}${entry.field ? ` (${entry.field})` : ''}: ${entry.message}`).join('\n'), token);
}

export function groupHeader(run, capability = false) {
  return `agent: ${run.meta.name}\nrun: ${run.handle}\nstate: ${run.snapshot.state}\n${capability ? `communication: ${communication(run.snapshot)}\n${communicationDetails(run.snapshot)}` : ''}`;
}

export function diagnostic(code, message) {
  return `diagnostic: error\ncode: ${code}\n${message === undefined ? '' : `message: ${message}\n`}`;
}

function optionalDiagnostic(message, token) {
  if (!message) return '';
  return Buffer.byteLength(message) > 768 ? 'diagnostic_omitted: true\n' : textBlock('DIAGNOSTIC', message, token);
}

export function gapText(gap, token) {
  if (!['notSubmitted', 'unknown'].includes(gap.status) || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(gap.code ?? '') ||
    typeof gap.text !== 'string' || !gap.text.isWellFormed() || !gap.text.trim() || gap.text.includes('\0') || Buffer.byteLength(gap.text) > 4096) fail('runStateUnavailable', 'An input delivery record is invalid.');
  return `delivery: ${gap.status}\ncode: ${gap.code}\n${optionalDiagnostic(gap.message, token)}${textBlock('INPUT', gap.text, token)}`;
}

export async function eventText(run, name, token) {
  const event = await readRecord(run, 'events', name);
  if (event.type === 'delivery') return gapText(await readRecord(run, 'gaps', event.gap), token);
  if (event.type !== 'message' || typeof event.text !== 'string' || !event.text.isWellFormed() || !event.text.trim() || event.text.includes('\0') || Buffer.byteLength(event.text) > 4096) fail('runStateUnavailable', 'A process message is invalid.');
  return textBlock('MESSAGE', event.text, token);
}

export async function* finalChunks(run, gaps, token) {
  const result = run.result;
  yield initializationDiagnostics(result.diagnostics ?? run.snapshot.diagnostics, token);
  if (result.state !== 'completed') {
    yield `text_status: ${result.text ? 'partial' : 'missing'}\ngeneration_started: ${result.generationStarted}\nbackend_exit_code: ${result.backendExitCode}\n`;
  }
  if (result.code) yield `code: ${result.code}\n`;
  if (run.meta.stopRequested || Object.hasOwn(result, 'remoteStopConfirmed')) yield `remote_stop_confirmed: ${result.remoteStopConfirmed ?? 'unknown'}\n`;
  if (result.message) yield optionalDiagnostic(result.message, token);
  if (gaps.length) yield `delivery_gaps: ${gaps.length}\n`;
  for (const name of gaps) yield gapText(await readRecord(run, 'gaps', name), token);
  yield textBlock('FINAL', result.text, token);
}

export function resultReport(run, events, gaps) {
  return async function* (token) {
    yield `result: read\n${groupHeader(run, needsCommunication(run))}`;
    for (const name of events) yield await eventText(run, name, token);
    yield* finalChunks(run, gaps, token);
  };
}

// Two passes keep the full report out of memory. The single parent serializes consumers.
export async function measureReport(factory) {
  for (;;) {
    const token = chooseBoundary();
    let bytes = 0, collision = false;
    try { for await (const chunk of factory(token)) {
      // Generated boundary lines are excluded, but every data/control value is checked.
      const data = chunk.replace(new RegExp(`^(?:BEGIN|END)_(?:MESSAGE|INPUT|FINAL|DIAGNOSTIC):${token}\\n`, 'gm'), '');
      if (data.includes(token)) { collision = true; break; }
      bytes += Buffer.byteLength(chunk);
    } } catch (error) { if (error.code === 'boundaryCollision') collision = true; else throw error; }
    if (!collision) return { token, bytes };
  }
}

export async function collectReport(factory, token, maximum = OUTPUT_LIMIT) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of factory(token)) {
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

export const exportHint = (handle) => `Use result --run ${handle} --export with a destination that accepts the full output.`;
