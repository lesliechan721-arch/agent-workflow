#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.slice(2).includes('--check');
const mappings = {
  'scripts/validate-json-contract.mjs': [
    'skills/review-agent-content/scripts/validate-json-contract.mjs'
  ],
  'schemas/reference-audit-result.schema.json': [
    'skills/review-agent-content/assets/reference-audit-result.schema.json'
  ]
};
const stale = [];
for (const [sourceRelative, targets] of Object.entries(mappings)) {
  const content = await readFile(path.join(root, sourceRelative), 'utf8');
  for (const targetRelative of targets) {
    const target = path.join(root, targetRelative);
    if (check) {
      if (await readFile(target, 'utf8').catch(() => null) !== content) stale.push(targetRelative);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}
if (stale.length > 0) {
  process.stderr.write(`Generated content contract assets are stale:\n${stale.map(value => `- ${value}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ valid: true, check, targets: Object.values(mappings).flat() }, null, 2)}\n`);
