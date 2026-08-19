#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.slice(2).includes('--check');
const mappings = {
  'scripts/validate-json-contract.mjs': ['skills/author-agent-skill/scripts/validate-json-contract.mjs','skills/review-agent-skill/scripts/validate-json-contract.mjs','skills/audit-agent-skill-evals/scripts/validate-json-contract.mjs'],
  'scripts/validate-review-result.mjs': ['skills/review-agent-skill/scripts/validate-review-result.mjs'],
  'scripts/validate-review-stage-result.mjs': ['skills/review-agent-skill/scripts/validate-review-stage-result.mjs'],
  'scripts/validate-eval-audit-result.mjs': ['skills/audit-agent-skill-evals/scripts/validate-eval-audit-result.mjs','skills/author-agent-skill/scripts/validate-eval-audit-result.mjs','skills/review-agent-skill/scripts/validate-eval-audit-result.mjs'],
  'standards/review-result-rules.generated.json': ['skills/review-agent-skill/assets/review-result-rules.generated.json'],
  'schemas/skill-design-brief.schema.json': ['skills/author-agent-skill/assets/skill-design-brief.schema.json'],
  'schemas/review-input-bundle.schema.json': ['skills/review-agent-skill/assets/review-input-bundle.schema.json'],
  'schemas/review-result.schema.json': ['skills/review-agent-skill/assets/review-result.schema.json'],
  'schemas/eval-audit-result.schema.json': ['skills/audit-agent-skill-evals/assets/eval-audit-result.schema.json','skills/author-agent-skill/assets/eval-audit-result.schema.json','skills/review-agent-skill/assets/eval-audit-result.schema.json'],
  'schemas/reference-audit-result.schema.json': ['skills/review-agent-skill/assets/reference-audit-result.schema.json']
};
const stale = [];
for (const [sourceRelative, targets] of Object.entries(mappings)) {
  const content = await readFile(path.join(root, sourceRelative), 'utf8');
  for (const targetRelative of targets) {
    const target = path.join(root, targetRelative);
    if (check) { if (await readFile(target, 'utf8').catch(() => null) !== content) stale.push(targetRelative); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}
if (stale.length > 0) { process.stderr.write(`Generated Skill contract assets are stale:\n${stale.map((value) => `- ${value}`).join('\n')}\n`); process.exit(1); }
process.stdout.write(`${JSON.stringify({ valid: true, check, targets: Object.values(mappings).flat() }, null, 2)}\n`);
