import fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createChildChannel } from '../../skills/codex-subagent-guide/scripts/runtime/adapter-channel.mjs';
import { adapterMain, deferred, renderCommunicationInstructions } from '../../skills/codex-subagent-guide/scripts/adapters/common.mjs';
import { executeCodex, negotiateCodex } from '../../skills/codex-subagent-guide/scripts/adapters/codex-v5.mjs';
import { executeClaude, negotiateClaude } from '../../skills/codex-subagent-guide/scripts/adapters/claude-code-v5.mjs';
import { executeOracle, negotiateOracle } from '../../skills/codex-subagent-guide/scripts/adapters/oracle-v5.mjs';

// The adapter, negotiation, JSONL frames and session binding are real. Only the
// external backend and the file transport are controlled. Native recovery tests
// retain the installed adapter, private file bridge and process-exit evidence.
setTimeout(() => process.exit(9), 30000).unref();
const name = process.env.FIXTURE_BACKEND;
const scenario = process.env.FIXTURE_CASE;
const adapter = {
  codex: { mode: 'workspace', permissionMode: true, codex: true, negotiate: negotiateCodex, execute: executeCodex },
  claude: { mode: 'workspace', permissionMode: true, negotiate: negotiateClaude, execute: executeClaude },
  oracle: { mode: 'bundle', negotiate: negotiateOracle, execute: executeOracle },
}[name];
const observe = (value) => process.send(value);

function backend(context, args) {
  const stdout = new PassThrough();
  const done = deferred();
  let exited = false;
  let closing;
  const emit = (value) => stdout.write(`${JSON.stringify(value)}\n`);
  const instance = {
    child: { stdout }, done: done.promise,
    get exited() { return exited; },
    get exitCode() { return exited ? 0 : null; },
    async write(input) {
      observe({ input });
      if (name === 'oracle') return;
      if (name === 'claude') {
        emit({ type: 'system', subtype: 'init', session_id: 'session-fixture' });
        emit({ type: 'user', uuid: input.uuid });
        emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'session-fixture', result: 'Module answer.' });
        return;
      }
      const respond = (result) => emit({ id: input.id, result });
      if (input.method === 'initialize' || input.method === 'thread/unsubscribe') respond({});
      else if (input.method === 'thread/resume' || input.method === 'thread/start') {
        if (scenario === 'resume rejection') emit({ id: input.id, error: { code: -32602, message: 'Session unavailable.' } });
        else respond({ thread: { id: scenario === 'resume mismatch' ? 'other-thread' : 'thread-fixture', ...(scenario === 'resume active' ? { status: { type: 'active' } } : {}) } });
      } else if (input.method === 'turn/start') {
        respond({ turn: { id: 'turn-fixture' } });
        emit({ method: 'turn/started', params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture' } } });
        emit({ method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'completed', items: [{ type: 'agentMessage', text: 'Module answer.' }] } } });
      }
    },
    async end() {
      closing ??= (async () => {
        if (name === 'oracle') {
          await fs.writeFile(args[args.indexOf('--write-output') + 1], 'Module answer.');
        }
        exited = true;
        stdout.end();
        done.resolve();
      })();
      await closing;
    },
    async cleanup() { await this.end(); return true; },
  };
  context.backend = instance;
  observe({ args });
  return instance;
}

adapterMain(import.meta.url, {
  ...adapter,
  async execute(context) {
    const prepare = context.prepareCommunication;
    context.prepareCommunication = async function (options = {}) {
      if (!context.request.communication || !context.communicationCandidate.supported) return prepare(options);
      const { supported: _supported, ...details } = context.communicationCandidate;
      // Use the real channel in place of its filesystem transport. Capability
      // validation, resume gating, bindSession and ready/result stay in common.
      context.bridge = createChildChannel({
        emitParentMessage: async (text) => context.emit({ type: 'message', text }),
        submitInput: options.submitInput, canSubmitInput: options.canSubmitInput,
      });
      context.bridge.mcpServer = { command: process.execPath, args: ['memory-parent-tool'] };
      const communication = { status: 'enabled', ...details };
      const instructions = await renderCommunicationInstructions(communication, context.bridge, options.instructionBindings,
        pathToFileURL(process.env.FIXTURE_COMMUNICATION_TEMPLATE));
      context.prompt = `${context.request.prompt}\n\n${instructions}`;
      context.communication = communication;
      return context.bridge;
    };
    context.spawn = async (_command, args) => backend(context, args);
    return adapter.execute(context);
  },
}, 'Adapter recovery module fixture\n');
