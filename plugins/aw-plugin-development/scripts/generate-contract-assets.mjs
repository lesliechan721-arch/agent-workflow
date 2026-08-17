#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginsRoot = path.dirname(root);
const check = process.argv.slice(2).includes('--check');
const mappings = [
  ['agent-content-toolkit/scripts/validate-json-contract.mjs', 'skills/author-aw-plugin/scripts/validate-json-contract.mjs'],
  ['agent-content-toolkit/scripts/validate-json-contract.mjs', 'skills/review-aw-plugin/scripts/validate-json-contract.mjs'],
  ['agent-content-toolkit/scripts/validate-review-result.mjs', 'skills/review-aw-plugin/scripts/validate-review-result.mjs'],
  ['agent-content-toolkit/scripts/validate-eval-audit-result.mjs', 'skills/author-aw-plugin/scripts/validate-eval-audit-result.mjs'],
  ['agent-content-toolkit/scripts/validate-eval-audit-result.mjs', 'skills/review-aw-plugin/scripts/validate-eval-audit-result.mjs'],
  ['agent-content-toolkit/standards/review-result-rules.generated.json', 'skills/review-aw-plugin/assets/review-result-rules.generated.json'],
  ['agent-content-toolkit/schemas/skill-design-brief.schema.json', 'skills/author-aw-plugin/assets/skill-design-brief.schema.json'],
  ['agent-content-toolkit/schemas/eval-audit-result.schema.json', 'skills/author-aw-plugin/assets/eval-audit-result.schema.json'],
  ['agent-content-toolkit/schemas/review-input-bundle.schema.json', 'skills/review-aw-plugin/assets/review-input-bundle.schema.json'],
  ['agent-content-toolkit/schemas/review-result.schema.json', 'skills/review-aw-plugin/assets/review-result.schema.json'],
  ['agent-content-toolkit/schemas/eval-audit-result.schema.json', 'skills/review-aw-plugin/assets/eval-audit-result.schema.json'],
  ['agent-content-toolkit/schemas/reference-audit-result.schema.json', 'skills/review-aw-plugin/assets/reference-audit-result.schema.json'],
  ['aw-plugin-development/schemas/aw-authoring-context.schema.json', 'skills/author-aw-plugin/assets/aw-authoring-context.schema.json'],
  ['aw-plugin-development/schemas/aw-review-summary.schema.json', 'skills/review-aw-plugin/assets/aw-review-summary.schema.json'],
  ['aw-plugin-development/scripts/validate-aw-review-summary.mjs', 'skills/review-aw-plugin/scripts/validate-aw-review-summary.mjs'],
];
const stale = [];
for (const [sourceRelative, targetRelative] of mappings) {
  const content = await readFile(path.join(pluginsRoot, sourceRelative), 'utf8');
  const target = path.join(root, targetRelative);
  if (check) {
    if (await readFile(target, 'utf8').catch(() => null) !== content) stale.push(targetRelative);
    continue;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
if (stale.length > 0) {
  process.stderr.write(`Generated AW contract assets are stale:\n${stale.map(value => `- ${value}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ valid: true, check, targets: mappings.map(([, target]) => target) }, null, 2)}\n`);
