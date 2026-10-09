import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.protocolVersion !== 4 || request.mode !== 'bundle') throw new Error('Expected an Adapter v4 bundle request.');
const { command, args } = request.fileResolver;
const helper = spawn(command, args, { cwd: request.workspace, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = ''; let stderr = '';
helper.stdout.on('data', (chunk) => { stdout += chunk; });
helper.stderr.on('data', (chunk) => { stderr += chunk; });
helper.stdin.end(JSON.stringify({ protocolVersion: 1, workspace: request.workspace, selectors: request.fileSelectors }));
const code = await new Promise((resolve, reject) => { helper.once('error', reject); helper.once('close', resolve); });
const result = { protocolVersion: 4, state: 'failed', generationStarted: false, backendExitCode: null, text: '' };
if (code === 0) {
  const selection = JSON.parse(stdout);
  if (selection.protocolVersion !== 1 || !Array.isArray(selection.files) || selection.files.some((file) => typeof file !== 'string')) throw new Error('Invalid helper result.');
  // A deterministic consumer uses each returned path literally. This fixture
  // records the paths at the model boundary and makes no model call.
  Object.assign(result, { state: 'completed', generationStarted: true, backendExitCode: 0, text: JSON.stringify(selection) });
  if (process.env.AW_TEST_SELECTION_BOUNDARY) await fs.appendFile(process.env.AW_TEST_SELECTION_BOUNDARY, `${JSON.stringify(selection.files)}\n`);
} else result.code = JSON.parse(stderr).code;
await fs.writeFile(process.env.AW_SUBAGENT_RESULT_FILE, JSON.stringify(result));
process.exitCode = code === 0 ? 0 : 1;
