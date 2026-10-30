import fs from 'node:fs/promises';
import path from 'node:path';
import { mock } from 'node:test';
import { adapterMain, negotiateExecutable } from '../../skills/codex-subagent-guide/scripts/adapters/common.mjs';

const realTimeout = setTimeout;
const realClearTimeout = clearTimeout;
// The parent controls only the adapter's wall clock and timers. JSONL, file
// validation, IPC and the independent process watchdog remain real.
mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Number(process.env.FIXTURE_NOW) });
const clockTimeout = setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  // Preserve Node's native range warnings, which mock timers omit.
  realClearTimeout(realTimeout(() => {}, milliseconds));
  return clockTimeout(callback, milliseconds, ...args);
};
realTimeout(() => process.exit(9), 120000).unref();

let active;
let stopCalls = 0;
process.on('message', async ({ id, milliseconds = 0 }) => {
  mock.timers.tick(milliseconds);
  await new Promise(setImmediate);
  process.send({ id, now: Date.now(), stopCalls, aborted: active?.signal.aborted ?? false });
});

adapterMain(import.meta.url, {
  mode: 'workspace',
  async negotiate(context) {
    const executable = await negotiateExecutable(context, context.request.args.includes('environmentMissing') ? path.join(context.request.workspace, 'missing-cli') : process.execPath);
    await fs.writeFile(path.join(context.request.runtime.directory, 'environment-checked.json'), '{}');
    if (context.request.communication && context.request.args.includes('negotiationMustFail')) {
      await fs.writeFile(path.join(context.request.runtime.directory, 'queried.json'), '{}');
      throw Object.assign(new Error('Capability query failed.'), { code: 'communicationQueryFailed' });
    }
    if (context.request.args.includes('legacyNegotiation')) return { environment: { status: 'available' }, capabilities: { resume: { supported: false }, communication: { supported: true, transport: 'mcp', passiveDelivery: 'in-turn', activeReceive: true } }, executable };
    return { environment: { status: 'available' }, capabilities: { resume: { supported: false }, communication: context.request.args.includes('preparationMustFail') ? { supported: true, transport: 'mcp', passiveDelivery: 'in-turn' } : { supported: false } }, executable };
  },
  async execute(context) {
    active = context;
    context.onStop = () => {
      stopCalls++;
      context.stopped.resolve();
    };
    await context.prepareCommunication();
    await fs.writeFile(path.join(context.request.runtime.directory, 'initialization.json'), JSON.stringify({ prompt: context.prompt, communication: context.communication, bridgeCreated: !!context.bridge }));
    await context.ready();
    context.generationStarted = true;
    await context.stopped.promise;
    return { state: 'unknown', code: 'fixtureStopped', text: '' };
  },
}, 'Adapter lifecycle fixture\n');
