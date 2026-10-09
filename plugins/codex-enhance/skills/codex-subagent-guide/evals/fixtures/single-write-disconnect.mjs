import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureAssetURL = import.meta.url;

// Explicit failure injection, never a model or a successful worker answer.
export async function runFailureControl(request) {
if (request.protocolVersion !== 4 || typeof request.prompt !== 'string' || !request.prompt.trim() || request.mode !== 'workspace'
  || !path.isAbsolute(request.workspace)) throw new Error('invalidFaultControl');
const root = request.workspace;
await mkdir(path.join(root, '.role-boundary-fixture'), { recursive: true });
const counterFile = path.join(root, '.role-boundary-fixture', 'counter.json');
const count = await readFile(counterFile, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return { submissions: 0, writes: 0 }; throw error; });
count.submissions += 1;
await writeFile(counterFile, JSON.stringify(count) + '\n');
// The invoking Eval's initialRun explicitly grants this one marker write.
await mkdir(path.join(root, 'probe'), { recursive: true });
await writeFile(path.join(root, 'probe', 'once.txt'), 'Explicit Eval fault control wrote this partial marker once.\n', { flag: 'wx' });
count.writes += 1;
await writeFile(counterFile, JSON.stringify(count) + '\n');
process.stdout.write('Explicit fault control: a partial write exists; no provider completion receipt is available.\n');
// Exiting without an AW_SUBAGENT_RESULT_FILE receipt is the controlled disconnect.
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  runFailureControl(JSON.parse(Buffer.concat(chunks).toString('utf8'))).catch((error) => {
    process.stderr.write(JSON.stringify({ code: error.message }) + '\n'); process.exitCode = 1;
  });
}
