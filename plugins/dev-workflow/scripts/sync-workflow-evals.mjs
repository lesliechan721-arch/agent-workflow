import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Manifest v1 providers must be Eval-local. Keep one authored adapter closure;
// the workflow Skill receives ordinary copies, not escaping imports or symlinks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = ['context-role-workflow.mjs', 'role-evidence.mjs', 'workflow-results.mjs', 'workflow-evaluation.mjs', 'stage-and-fidelity.mjs', 'browser/browser-oracle.mjs', 'browser/package.json'];

export async function syncWorkflowEvals({ write = false, pluginRoot = root } = {}) {
  const destination = path.join(pluginRoot, 'skills/dev-workflow/evals/runtime');
  if (write) await mkdir(destination, { recursive: true });
  const drift = [];
  for (const name of modules) {
    const source = await readFile(path.join(pluginRoot, 'skills/dev-build/evals', name));
    const file = path.join(destination, name);
    const current = await readFile(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    // Static contract exception: different Eval-local copies would execute different audited oracles; behavior tests cannot exhaustively establish identity of every provider path.
    if (!current?.equals(source)) {
      if (write) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, source); }
      else drift.push(path.relative(pluginRoot, file));
    }
  }
  return { ok: drift.length === 0, checked: modules.length, drift };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node sync-workflow-evals.mjs [--check|--write]\nDefault: read-only closure identity check. --write updates only generated Eval-local modules.\n');
  } else {
    try {
      if (process.argv.slice(2).some((arg) => !['--check', '--write'].includes(arg))) throw new Error('Unsupported argument.');
      const result = await syncWorkflowEvals({ write: process.argv.includes('--write') });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
