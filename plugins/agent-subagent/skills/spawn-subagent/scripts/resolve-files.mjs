#!/usr/bin/env node
import { writeSync } from 'node:fs';
import { LIMITS, fail, publicError } from './file-selection/contracts.mjs';

const help = `AW file selection protocol v1
Usage: node scripts/resolve-files.mjs < request.json
       node scripts/resolve-files.mjs --help
stdin: one UTF-8 JSON object {protocolVersion:1, workspace:"/real/absolute/directory", selectors:["src/**/*.ts", "!**/*.test.ts"]}
stdout: one JSON object {protocolVersion:1, files:["/literal/absolute/file"]}, then newline.
No material contents are read. Empty selectors do not scan. Commas split selectors; all exclusions apply last.
Limits: input ${LIMITS.inputBytes} bytes; output ${LIMITS.outputBytes} bytes; ${LIMITS.selectors} selectors; ${LIMITS.patterns} comma-separated patterns;
pattern ${LIMITS.patternBytes} bytes; brace range ${LIMITS.braceRange} values; total expanded patterns ${LIMITS.expandedPatterns};
${LIMITS.entries} scanned entries; ${LIMITS.operations} filesystem operations; ${LIMITS.files} selected files;
ignore file ${LIMITS.ignoreFileBytes} bytes; all ignore reads ${LIMITS.ignoreTotalBytes} bytes; total time ${LIMITS.durationMs} ms (including stdin).
Exit: 0 success/help; 2 invalid input, missing explicit path or empty selection; 1 read, resource limit or internal failure.
Errors: stderr contains one bounded JSON object {code,message}; stdout is empty. Reduce an over-limit selection; sync/reinstall missing resources.
`;

function report(error) {
  const { code, message, exitCode } = publicError(error);
  writeSync(2, `${JSON.stringify({ code, message })}\n`);
  return exitCode;
}

if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(help);
else {
  const timer = setTimeout(() => process.exit(report(Object.assign(new Error('File selection exceeded its time limit. Reduce the selection.'),
    { code: 'fileSelectionLimitExceeded', exitCode: 1 }))), LIMITS.durationMs);
  try {
    if (process.argv.length !== 2) fail('fileSelectionInputInvalid', 'Use stdin JSON without extra arguments, or use --help.', 2);
    if (process.stdin.isTTY) fail('fileSelectionInputInvalid', 'Send one JSON request on stdin and close stdin.', 2);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > LIMITS.inputBytes) fail('fileSelectionLimitExceeded', 'The input exceeds its byte limit. Reduce the selection.');
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { fail('fileSelectionInputInvalid', 'stdin must contain one valid UTF-8 JSON object.', 2); }
    const { resolveFiles } = await import('./file-selection/selection.mjs');
    const result = await resolveFiles(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.exitCode = report(error); process.stdin.destroy(); }
  finally { clearTimeout(timer); }
}
