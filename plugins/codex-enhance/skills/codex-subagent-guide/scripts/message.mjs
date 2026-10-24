#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { LIMITS, RuntimeError, fail } from './runtime/contracts.mjs';
import { readStdin } from './runtime/files.mjs';
import { formatChildResponse, invokeChildTool } from './runtime/adapter-channel.mjs';

const HELP = `Child communication tools
Usage: <generated command> send --text TEXT
       <generated command> send --text -
       <generated command> receive [--timeout-ms N]

Send submits one message to the parent channel. It does not wait for a reply.
Receive waits for one input, a timeout, or closure. The default is 600000 ms.
N must be an integer from 0 to 1800000. Text must contain 1 to 4096 UTF-8 bytes.
Inputs already submitted to model context are not replayed by receive.
`;

export async function runMessage(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  if ((argv.length === 1 && ['--help', '-h'].includes(argv[0])) || (argv.length === 3 && argv[0] === '--bridge' && ['--help', '-h'].includes(argv[2]))) { stdout.write(HELP); return 0; }
  let operation = 'receive';
  try {
    if (argv[0] !== '--bridge' || !argv[1]) fail('invalidArguments', 'Use the child command supplied by the adapter.');
    const bindingFile = argv[1]; operation = argv[2];
    const rest = argv.slice(3); let text; let timeoutMs;
    if (operation === 'send') {
      if (rest.length !== 2 || rest[0] !== '--text') fail('invalidArguments', 'Use send --text TEXT or send --text -.');
      text = rest[1] === '-' ? await readStdin(stdin, LIMITS.messageBytes, 'messageTooLarge') : rest[1];
    } else if (operation === 'receive') {
      if (rest.length) {
        if (rest.length !== 2 || rest[0] !== '--timeout-ms' || !/^(0|[1-9][0-9]*)$/.test(rest[1])) fail('invalidArguments', 'Use receive with an optional --timeout-ms integer.');
        timeoutMs = Number(rest[1]);
      }
    } else fail('invalidArguments', 'Use send or receive.');
    const response = await invokeChildTool({ bindingFile, operation, text, timeoutMs });
    stdout.write(formatChildResponse(operation, response));
    return response.outcome === 'error' ? 1 : 0;
  } catch (error) {
    const code = error instanceof RuntimeError ? error.code : 'childToolFailed';
    const message = error instanceof RuntimeError ? error.message : 'The child tool operation failed.';
    stderr.write(`diagnostic: error\ncode: ${code}\nmessage: ${JSON.stringify(message)}\n`);
    return ['invalidArguments', 'messageInvalid', 'messageTooLarge', 'stdinInteractive', 'binaryUnsupported'].includes(code) ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runMessage(process.argv.slice(2));
}
