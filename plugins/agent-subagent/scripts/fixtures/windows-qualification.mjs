import fs from 'node:fs/promises';

// Shared by the native qualification and its protocol regression tests.
export function field(text, key) {
  const expression = /^<((?:message|input|result|diagnostic)(?:_[0-9]+)?)([^>\n]*)>\n([\s\S]*?)\n<\/\1>\n/gm;
  const attributes = [...text.matchAll(expression)].map((match) => match[2]);
  const controls = text.replace(expression, '');
  const value = controls.match(new RegExp(`(?:^| )${key}=([^ \\n]+)`, 'm'))?.[1]
    ?? attributes.map((properties) => properties.match(new RegExp(`(?:^| )${key}="([^"]*)"`))?.[1]).find((entry) => entry !== undefined);
  if (value !== undefined) return value;
  if (key === 'delivery' && /^queued aw5-[A-Za-z0-9_-]{11}-[A-Za-z0-9_-]{22}(?=\s|$)/m.test(controls)) return 'queued';
  if (key === 'run') return controls.match(/^(?:started|starting|start_failed|ready|queued|stopped|stopping|deferred|exported) (aw5-[A-Za-z0-9_-]{11}-[A-Za-z0-9_-]{22})(?=\s|$)/m)?.[1];
  if (key === 'state') {
    if (/^starting /m.test(controls)) return 'starting';
    if (/^(?:started|ready) /m.test(controls)) return 'running';
  }
}

function resultDetails(response, report = response.stdout) {
  const state = field(report, 'state');
  const code = field(response.stderr ?? '', 'code') ?? field(report, 'code');
  return {
    exitCode: Number.isSafeInteger(response.exit) ? response.exit : null,
    state: ['starting', 'running', 'closing', 'completed', 'failed', 'cancelled', 'unknown'].includes(state) ? state : 'unavailable',
    runtimeCode: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code ?? '') ? code : 'unavailable',
  };
}

function finalMatches(report, expectedText) {
  const blocks = /^<((?:message|input|result|diagnostic)(?:_[0-9]+)?)([^>\n]*)>\n([\s\S]*?)\n<\/\1>\n/gm;
  return [...report.matchAll(blocks)].some((match) => /^result(?:_[0-9]+)?$/.test(match[1]) && match[3] === expectedText);
}

function resultFailure(code, details) {
  throw Object.assign(new Error(code), { code, details });
}

export function checkQualificationResult(response, expectedText) {
  const details = { ...resultDetails(response), textMatches: finalMatches(response.stdout, expectedText) };
  if (response.exit !== 0) resultFailure('resultReadFailed', details);
  if (details.state !== 'completed') resultFailure('resultStateMismatch', details);
  if (!details.textMatches) resultFailure('resultTextMismatch', details);
  return details;
}

export async function checkQualificationExport(response, outputFile, expectedText) {
  let details = { ...resultDetails(response), consumed: / consumed=true\n$/.test(response.stdout) };
  if (response.exit !== 0) resultFailure('resultExportFailed', details);
  if (!details.consumed) resultFailure('resultExportNotConsumed', details);
  let report;
  try { report = await fs.readFile(outputFile, 'utf8'); }
  catch (error) {
    resultFailure('resultExportReadFailed', { ...details,
      fileCode: ['ENOENT', 'EPERM', 'EACCES', 'EBUSY', 'EISDIR'].includes(error.code) ? error.code : 'unavailable' });
  }
  details = { ...details, ...resultDetails(response, report), textMatches: finalMatches(report, expectedText) };
  if (!details.textMatches) resultFailure('resultExportTextMismatch', details);
  return details;
}

export const qualificationAdapter = String.raw`
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
let backend, closed, finishing = false;
const emit = (value) => process.stdout.write(JSON.stringify({ protocolVersion: 5, ...value }) + '\n');
const hardStop = setTimeout(() => process.exit(4), 305000);
let timer;
async function finish(cancelled) {
  if (finishing) return;
  finishing = true; clearInterval(timer); clearTimeout(hardStop);
  if (backend?.connected) backend.send('finish');
  const backendExitCode = backend ? await closed : null;
  emit({ type: 'closing', reason: cancelled ? 'cancelled' : 'completed' });
  emit({ type: 'result', state: cancelled ? 'cancelled' : 'completed', generationStarted: !!backend, backendExitCode,
    text: cancelled ? '' : '跨卷最终答案。\r\n第二行。\n', ...(cancelled ? { code: 'fixtureStopped', remoteStopConfirmed: true } : {}) });
  process.exit(0);
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === 'start') {
    await fs.writeFile(process.env.FIXTURE_OBSERVED, JSON.stringify({ prompt: frame.prompt, workspace: frame.workspace, cwd: process.cwd() }));
    backend = spawn(process.execPath, ['-e', "setTimeout(()=>process.exit(4),300000);process.on('message',()=>process.exit(0));process.on('disconnect',()=>process.exit(0))"],
      { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: false });
    closed = new Promise((resolve) => backend.once('close', resolve));
    emit({ type: 'ready', initialization: { environment: { status: 'available' }, capabilities: { communication: { status: 'enabled', transport: 'mcp', passiveDelivery: 'in-turn' }, resume: { status: frame.resume ? 'unsupported' : 'disabled' } } } });
    timer = setInterval(async () => { if (await fs.stat(process.env.FIXTURE_FINISH).catch(() => null)) await finish(false); }, 30);
  } else if (frame.type === 'message') {
    await fs.writeFile(process.env.FIXTURE_INPUT, JSON.stringify({ text: frame.text }));
    emit({ type: 'delivery', id: frame.id, status: 'submitted' });
    emit({ type: 'message', text: frame.text });
  } else if (frame.type === 'stop') await finish(true);
}
if (!finishing) await finish(true);
`;

export async function waitForCommunication(response, command, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value = response;
  for (;;) {
    const state = field(value.stdout, 'state');
    const code = field(value.stderr ?? '', 'code') ?? field(value.stdout, 'code');
    if (['completed', 'failed', 'cancelled', 'unknown'].includes(state) ||
      value.exit !== 0 && !(state === 'starting' && code === 'startupNotReady')) {
      throw Object.assign(new Error('The run did not become ready.'), { code: 'readinessFailed', details: {
        state: ['starting', 'running', 'closing', 'completed', 'failed', 'cancelled', 'unknown'].includes(state) ? state : 'unavailable',
        runtimeCode: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code ?? '') ? code : 'unavailable',
      } });
    }
    if (field(value.stdout, 'communication') === 'true') return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('The readiness deadline expired.'), { code: 'commandTimeout' });
    value = await command(['wait', '--run', response.handle, '--timeout-ms', String(Math.min(1000, remaining))]);
  }
}
