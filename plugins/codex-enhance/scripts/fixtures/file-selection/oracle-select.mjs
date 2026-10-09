import { readFiles } from './oracle-reference/files.js';
import { publicError, validateSelectors } from '../../../skills/codex-subagent-guide/scripts/file-selection/contracts.mjs';
import { spawn } from 'node:child_process';

// Run the original published Oracle selection module without any CLI session,
// model, content read, service configuration or network request.
console.log = () => {};
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const request = JSON.parse(input);
  validateSelectors(request.selectors);
  if (process.argv[2]) {
    const guard = spawn(process.execPath, [process.argv[2]], { shell: false, detached: false, stdio: ['pipe', 'ignore', 'pipe'] });
    let diagnostics = '';
    guard.stderr.on('data', (chunk) => { diagnostics += chunk; });
    guard.stdin.on('error', () => {});
    guard.stdin.end(JSON.stringify({ action: 'guard', input: { workspace: request.workspace, selectors: request.selectors } }));
    const exitCode = await new Promise((resolve, reject) => { guard.once('error', reject); guard.once('close', resolve); });
    if (exitCode !== 0) throw Object.assign(new Error('Native selection metadata guard failed.'), { code: JSON.parse(diagnostics).code, exitCode });
  }
  const selectors = request.selectors.flatMap((value) => value.split(',').map((part) => part.trim()).filter(Boolean));
  const result = await readFiles(selectors, { cwd: request.workspace, readContents: false, maxFileSizeBytes: 0 });
  process.stdout.write(`${JSON.stringify({ protocolVersion: 1, files: [...new Set(result.map((file) => file.path))].sort() })}\n`);
} catch (error) {
  let failure;
  if (error?.code) failure = publicError(error);
  else if (error?.message?.startsWith('Missing file or directory:')) failure = { code: 'fileSelectionPathMissing', exitCode: 2 };
  else if (error?.message === 'No files matched the provided --file patterns.') failure = { code: 'fileSelectionEmpty', exitCode: 2 };
  else failure = { code: 'fileSelectionFailed', exitCode: 1 };
  process.stderr.write(`${JSON.stringify({ code: failure.code })}\n`);
  process.exitCode = failure.exitCode;
}
