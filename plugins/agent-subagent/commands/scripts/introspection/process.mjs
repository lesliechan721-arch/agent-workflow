import { spawn } from 'node:child_process';
import path from 'node:path';
import { RuntimeError } from '../runtime/contracts.mjs';
import { INTROSPECTION_MAX_BYTES } from './protocol.mjs';

export { resolveProbeExecutable } from './executable.mjs';

export const INTROSPECTION_TIMEOUT_MS = 10_000;
const probeError = (code, message) => new RuntimeError(code, message);
const timeoutError = () => probeError('introspectionTimeout', 'The read-only probe did not finish before its deadline.');
const containmentError = () => probeError('introspectionContainmentFailed', 'The probe process tree could not be contained.');

// A streaming consumer may send more requests and return a value to stop.
// One-shot consumers close stdin on launch and receive the bounded stdout.
export async function runProbeProcess(invocation, {
  cwd, env, signal = AbortSignal.timeout(INTROSPECTION_TIMEOUT_MS),
  input, onLine, maximumBytes = INTROSPECTION_MAX_BYTES, containment,
} = {}) {
  if (signal.aborted) throw timeoutError();
  const windowsJob = Boolean(containment) && process.platform === 'win32';
  const ownedGroup = Boolean(containment) && !windowsJob;
  let { command, args } = invocation;
  if (windowsJob) {
    let helper;
    try { helper = await containment.windowsJobExecutable(); }
    catch { throw containmentError(); }
    if (typeof helper !== 'string' || !path.isAbsolute(helper)) throw containmentError();
    const config = { schemaVersion: 1, executable: command, args, parentPid: process.pid };
    command = helper;
    args = ['--config', Buffer.from(JSON.stringify(config)).toString('base64url')];
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(timeoutError()); return; }
    const launchError = () => probeError('introspectionSpawnFailed', 'The probe executable could not be started.');
    let child;
    try {
      child = spawn(command, args, {
        cwd, env: invocation.env ?? env, shell: false, windowsHide: true, detached: ownedGroup,
        stdio: [input === undefined && !onLine ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      });
    } catch { reject(launchError()); return; }
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const chunks = [];
    let size = 0, pending = '', failure, result, stopping = false, groupSignaled = false;
    const stopGroup = () => {
      if (!ownedGroup || !child.pid || groupSignaled) return;
      groupSignaled = true;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') failure = containmentError(); }
    };
    const stop = (error) => {
      if (stopping) return;
      stopping = true;
      failure ??= error;
      child.stdin?.end();
      stopGroup();
      if (child.pid && (!ownedGroup || failure?.code === 'introspectionContainmentFailed') &&
          child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      // Descendants can inherit stdout. Release the local pipe and let AW's
      // outer process group or Job clean up the rest of the tree.
      child.stdout?.destroy();
    };
    const abort = () => stop(timeoutError());
    const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
    const readLine = (line) => {
      result = onLine(line.replace(/\r$/, ''), send);
      if (result !== undefined) stop();
    };
    const outputError = () => probeError('introspectionOutputInvalid', 'The probe did not return valid UTF-8 output in its expected format.');
    child.once('error', () => {
      if (child.pid) { stop(launchError()); return; }
      // A spawn error without a PID can arrive without a close notification.
      stopping = true;
      failure ??= launchError();
      signal.removeEventListener('abort', abort);
      child.stdin?.destroy();
      child.stdout?.destroy();
      reject(failure);
    });
    if (ownedGroup) child.once('exit', stopGroup);
    child.stdin?.on('error', (error) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') stop(probeError('introspectionInputFailed', 'The probe input could not be delivered.'));
    });
    child.stdout?.on('error', () => stop(outputError()));
    child.stdout?.on('data', (chunk) => {
      if (stopping) return;
      size += chunk.length;
      if (size > maximumBytes) {
        stop(probeError('introspectionOutputTooLarge', 'The probe output exceeds its byte limit.'));
        return;
      }
      if (!onLine) { chunks.push(chunk); return; }
      try {
        const lines = (pending + decoder.decode(chunk, { stream: true })).split('\n');
        pending = lines.pop();
        for (const line of lines) {
          readLine(line);
          if (stopping) break;
        }
      } catch (error) { stop(error instanceof RuntimeError ? error : outputError()); }
    });
    child.once('close', (code, exitSignal) => {
      signal.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      // The verified Windows helper reserves exit codes 250 and 251.
      if (windowsJob && (code === 250 || code === 251)) { reject(containmentError()); return; }
      try {
        if (onLine && !stopping) {
          const tail = pending + decoder.decode();
          if (tail) readLine(tail);
        }
        resolve({ stdout: onLine ? '' : decoder.decode(Buffer.concat(chunks, size)), code, signal: exitSignal, result });
      } catch (error) { reject(error instanceof RuntimeError ? error : outputError()); }
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    if (onLine && input !== undefined) child.stdin?.write(input);
    else if (!onLine && input !== undefined) child.stdin?.end(input);
  });
}
