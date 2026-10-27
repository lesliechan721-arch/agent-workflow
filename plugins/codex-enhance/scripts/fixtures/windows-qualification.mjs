// Shared by the native qualification and its protocol regression tests.
export function field(text, key) { return text.replace(/^BEGIN_(MESSAGE|INPUT|FINAL|DIAGNOSTIC):([a-f0-9]{8})\n[\s\S]*?\nEND_\1:\2\n/gm, '').match(new RegExp(`^${key}: (.*)$`, 'm'))?.[1]; }

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
    emit({ type: 'ready', initialization: { environment: { status: 'available' }, capabilities: { communication: { status: 'enabled', transport: 'mcp', passiveDelivery: 'in-turn', activeReceive: true } } } });
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
    const code = field(value.stdout, 'code');
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
