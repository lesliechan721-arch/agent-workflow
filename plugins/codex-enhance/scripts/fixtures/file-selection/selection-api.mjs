import fs from 'node:fs/promises';
import { resolveFiles, assertNativeSelectionReadable } from '../../../skills/codex-subagent-guide/scripts/file-selection/selection.mjs';

// This file moves with the same registered relative layout as the Guide.
// It imports the final bundled module through a literal specifier, without
// reaching into the source repository or a host node_modules directory.
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const request = JSON.parse(input);
  const options = { ...request.options };
  if (options.cancelled) options.isCancelled = () => true;
  if (options.simulateMissing) {
    const missing = options.simulateMissing;
    options.filesystem = { ...fs, stat: async (target, ...args) => {
      if (String(target) === missing) throw Object.assign(new Error('Synthetic file disappeared.'), { code: 'ENOENT' });
      return fs.stat(target, ...args);
    } };
  }
  let result;
  if (request.action === 'resolve') result = await resolveFiles(request.input, options);
  else if (request.action === 'guard') {
    await assertNativeSelectionReadable(request.input.workspace, request.input.selectors, options);
    result = { checked: true };
  } else throw new Error('Unknown fixture action.');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code ?? 'fileSelectionFailed', message: error.message })}\n`);
  process.exitCode = error.exitCode ?? 1;
}
