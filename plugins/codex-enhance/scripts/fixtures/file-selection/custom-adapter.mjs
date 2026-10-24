import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const request = JSON.parse(await new Promise((resolve) => lines.once('line', resolve)));
if (request.protocolVersion !== 5 || request.type !== 'start' || request.mode !== 'bundle') throw new Error('Expected an Adapter v5 bundle request.');
const emit = (event) => process.stdout.write(JSON.stringify({ protocolVersion: 5, ...event }) + '\n');
emit({ type: 'ready', communicationSupported: false });
const { command, args } = request.fileResolver;
const helper = spawn(command, args, { cwd: request.workspace, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = ''; let stderr = '';
helper.stdout.on('data', (chunk) => { stdout += chunk; });
helper.stderr.on('data', (chunk) => { stderr += chunk; });
helper.stdin.end(JSON.stringify({ protocolVersion: 1, workspace: request.workspace, selectors: request.fileSelectors }));
const code = await new Promise((resolve, reject) => { helper.once('error', reject); helper.once('close', resolve); });
const result = { protocolVersion: 5, type: 'result', state: 'failed', generationStarted: false, backendExitCode: null, text: '' };
if (code === 0) {
  const selection = JSON.parse(stdout);
  if (selection.protocolVersion !== 1 || !Array.isArray(selection.files) || selection.files.some((file) => typeof file !== 'string')) throw new Error('Invalid helper result.');
  // A deterministic consumer uses each returned path literally. This fixture
  // records the paths at the model boundary and makes no model call.
  Object.assign(result, { state: 'completed', generationStarted: true, backendExitCode: 0, text: JSON.stringify(selection) });
  if (process.env.AW_TEST_SELECTION_BOUNDARY) await fs.appendFile(process.env.AW_TEST_SELECTION_BOUNDARY, `${JSON.stringify(selection.files)}\n`);
} else result.code = JSON.parse(stderr).code;
emit({ type: 'closing', reason: code === 0 ? 'completed' : 'failed' });
emit(result);
// A valid v5 protocol can carry a failed task while the adapter exits 0.
lines.close();
process.stdin.destroy();
process.exitCode = 0;
