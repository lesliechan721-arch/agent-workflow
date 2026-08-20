#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.slice(2).includes('--check');
const mappings = {
  'schemas/eval-audit-result.schema.json':
    'skills/run-agent-skill-evals/assets/eval-audit-result.schema.json',
  'schemas/eval-execution-plan.schema.json':
    'skills/run-agent-skill-evals/assets/eval-execution-plan.schema.json',
  'schemas/eval-run-bundle.schema.json':
    'skills/run-agent-skill-evals/assets/eval-run-bundle.schema.json',
  'schemas/eval-runtime-capabilities.schema.json':
    'skills/run-agent-skill-evals/assets/eval-runtime-capabilities.schema.json',
};

const stale = [];
for (const [sourceRelative, targetRelative] of Object.entries(mappings)) {
  const content = await readFile(path.join(root, sourceRelative), 'utf8');
  const target = path.join(root, targetRelative);
  if (check) {
    if ((await readFile(target, 'utf8').catch(() => null)) !== content)
      stale.push(targetRelative);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

if (stale.length > 0) {
  process.stderr.write(`Generated contract assets are stale:\n${stale.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ valid: true, check }, null, 2)}\n`);
