#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(path.join(root, 'standards', 'rules.json'), 'utf8'));
const check = process.argv.slice(2).includes('--check');
const views = [
  ['writing', 'skills/write-agent-content/references/writing-standard.generated.md', 'Agent-facing 写作标准'],
  ['content_review', 'skills/review-agent-content/references/review-standard.generated.md', 'Agent-facing 内容评审标准'],
];

function renderView(audience, title) {
  const lines = [`# ${title}`, '', '> GENERATED from `standards/rules.json`; do not edit manually.', ''];
  for (const rule of source.rules) {
    const view = rule[audience];
    if (!view) continue;
    lines.push(`## \`${rule.id}\``, '', rule.principle, '');
    for (const [key, value] of Object.entries(view)) lines.push(`- **${key}：** ${value}`);
    lines.push('', `Evidence: ${rule.evidenceType}; sources: ${rule.sourceRefs.join(', ')}`, '');
  }
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

const outputs = new Map(views.map(([audience, relative, title]) => [relative, renderView(audience, title)]));
const stale = [];
for (const [relative, content] of outputs) {
  const target = path.join(root, relative);
  if (check) {
    const actual = await readFile(target, 'utf8').catch(() => null);
    if (actual !== content) stale.push(relative);
    continue;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
if (stale.length > 0) {
  process.stderr.write(`Generated content standard views are stale:\n${stale.map(value => `- ${value}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ valid: true, check, targets: [...outputs.keys()] }, null, 2)}\n`);
