#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { fields, RuntimeError, fail } from './runtime/contracts.mjs';
import { formatChildResponse, invokeChildTool } from './runtime/adapter-channel.mjs';

const tools = [
  {
    name: 'send_parent',
    description: 'Submit one message to the parent channel without waiting for a reply. Success does not prove the parent model has read it.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, description: 'Nonempty Unicode text, at most 4096 UTF-8 bytes.' } } },
  },
  {
    name: 'receive_parent',
    description: 'Wait for one parent input, timeout, or closure. Inputs already submitted to model context are not replayed. Keep the current task open when waiting for an answer.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { timeoutMs: { type: 'integer', minimum: 0, maximum: 1800000, default: 600000 } } },
  },
];

export async function runMessageMcp(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    stdout.write('Child communication MCP server\nUsage: <generated command>\nTools: send_parent(text), receive_parent(timeoutMs=600000).\n'); return;
  }
  if (argv.length !== 2 || argv[0] !== '--bridge' || !argv[1]) fail('invalidArguments', 'Use the child MCP command supplied by the adapter.');
  const bindingFile = argv[1]; const controller = new AbortController(); const active = new Set();
  let output = Promise.resolve(); let failedOutput = false;
  const write = (value) => {
    const operation = output.then(() => new Promise((resolve, reject) => {
      stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve());
    }));
    output = operation.catch(() => { failedOutput = true; controller.abort(); });
    return operation;
  };
  const error = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  const handle = async (request) => {
    if (!fields(request, ['jsonrpc', 'id', 'method', 'params']) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
        || (Object.hasOwn(request, 'id') && !(typeof request.id === 'string' || Number.isSafeInteger(request.id)))) {
      await error(null, -32600, 'Invalid JSON-RPC request.'); return;
    }
    if (!Object.hasOwn(request, 'id')) return;
    let result;
    if (request.method === 'initialize') {
      const requested = request.params?.protocolVersion;
      result = { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'aw-child-communication', version: '5.0.0' } };
    } else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'tools/call') {
      let operation = request.params?.name === 'send_parent' ? 'send' : 'receive';
      try {
        if (!fields(request.params, ['name', 'arguments', '_meta']) || !tools.some((tool) => tool.name === request.params.name)) fail('invalidArguments', 'Use an available communication tool.');
        const args = request.params.arguments ?? {};
        if (!fields(args, operation === 'send' ? ['text'] : ['timeoutMs'])) fail('invalidArguments', 'The tool arguments contain an undefined field.');
        const response = await invokeChildTool({ bindingFile, operation, text: args.text, timeoutMs: args.timeoutMs, signal: controller.signal });
        result = { content: [{ type: 'text', text: formatChildResponse(operation, response) }], ...(response.outcome === 'error' ? { isError: true } : {}) };
      } catch (failure) {
        result = { isError: true, content: [{ type: 'text', text: formatChildResponse(operation, { outcome: 'error', code: failure instanceof RuntimeError ? failure.code : 'childToolFailed', message: failure instanceof RuntimeError ? failure.message : 'The child tool operation failed.' }) }] };
      }
    } else { await error(request.id, -32601, 'Method not found.'); return; }
    await write({ jsonrpc: '2.0', id: request.id, result });
  };
  let buffer = Buffer.alloc(0);
  try {
    for await (const chunk of stdin) {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffer.length > 1048576) fail('protocolTooLarge', 'The MCP input exceeds its frame limit.');
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
        let request;
        try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line)); }
        catch { await error(null, -32700, 'Parse error.'); continue; }
        // Long receive calls must not block other JSON-RPC requests.
        const operation = handle(request).catch(() => { controller.abort(); });
        active.add(operation); operation.finally(() => active.delete(operation));
      }
    }
    if (buffer.length) await error(null, -32700, 'The final MCP frame is incomplete.');
  } catch {
    stderr.write('diagnostic: error\ncode: childMcpFailed\nmessage: "The child MCP channel failed."\n');
  } finally {
    controller.abort(); await Promise.allSettled([...active]); await output;
    if (failedOutput) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runMessageMcp(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`diagnostic: error\ncode: ${error instanceof RuntimeError ? error.code : 'childMcpFailed'}\nmessage: "The child MCP server could not start."\n`);
    process.exitCode = error?.code === 'invalidArguments' ? 2 : 1;
  }
}
