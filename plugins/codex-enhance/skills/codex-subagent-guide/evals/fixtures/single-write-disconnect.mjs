import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureAssetURL = import.meta.url;

// Explicit failure injection, never a model or a successful worker answer.
export async function runFailureControl(request) {
if (request.protocolVersion !== 5 || request.type !== 'start' || typeof request.prompt !== 'string' || !request.prompt.trim() || request.mode !== 'workspace'
  || !path.isAbsolute(request.workspace)) throw new Error('invalidFaultControl');
process.stdout.write(JSON.stringify({ protocolVersion: 5, type: 'ready', communication: { status: 'unsupported' } }) + '\n');
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
process.stderr.write('Explicit fault control: a partial write exists; no provider completion receipt is available.\n');
// Exiting without a v5 result event is the controlled disconnect.
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createInterface } = await import('node:readline');
  const lines = createInterface({ input: process.stdin });
  lines.once('line', (line) => {
    lines.close();
    runFailureControl(JSON.parse(line)).then(() => process.exit(0)).catch((error) => {
      process.stderr.write(JSON.stringify({ code: error.message }) + '\n'); process.exitCode = 1;
    });
  });
}
