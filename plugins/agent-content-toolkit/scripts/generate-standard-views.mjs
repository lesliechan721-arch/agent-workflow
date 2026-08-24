#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function parseArgs(argv) {
  let check = false;
  let sourceRoot = root;
  let outputRoot = root;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') check = true;
    else if (arg === '--source-root') sourceRoot = path.resolve(argv[++index] ?? '');
    else if (arg === '--output-root') outputRoot = path.resolve(argv[++index] ?? '');
    else throw new Error(`Unknown option: ${arg}`);
  }
  return { check, sourceRoot, outputRoot };
}
const { check, sourceRoot, outputRoot } = parseArgs(process.argv.slice(2));
const source = JSON.parse(await readFile(path.join(sourceRoot, 'standards', 'rules.json'), 'utf8'));
const views = [
  [
    'writing',
    'skills/write-agent-content/references/writing-standard.md',
    'Agent-facing 写作标准',
  ],
  [
    'content_review',
    'skills/review-agent-content/references/review-standard.md',
    'Agent-facing 内容评审标准',
  ],
];
function evidenceLabel(rule) {
  return ['toolkit-policy', 'client-contract', 'specification'].includes(rule.evidenceType)
    ? 'normative'
    : rule.evidenceType;
}

function renderView(audience, title) {
  const lines = [
    `# ${title}`,
    '',
  ];
  for (const rule of source.rules) {
    const view = rule[audience];
    if (!view) continue;
    lines.push('## `' + rule.id + '`', '', rule.principle, '');
    for (const [key, value] of Object.entries(view)) lines.push(`- **${key}：** ${value}`);
    const heuristic =
      Array.isArray(rule.heuristicRefs) && rule.heuristicRefs.length > 0
        ? `; heuristic lenses: ${rule.heuristicRefs.join(', ')}`
        : '';
    lines.push(
      '',
      `Evidence: ${evidenceLabel(rule)}; sources: ${rule.sourceRefs.join(', ')}${heuristic}`,
      '',
    );
  }
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}
const outputs = new Map(
  views.map(([audience, relative, title]) => [relative, renderView(audience, title)]),
);
const stale = [];
for (const [relative, content] of outputs) {
  const target = path.join(outputRoot, relative);
  if (check) {
    const actual = await readFile(target, 'utf8').catch(() => null);
    if (actual !== content) stale.push(relative);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}
if (stale.length > 0) {
  process.stderr.write(
    `Generated content standard views are stale:\n${stale.map((value) => `- ${value}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `${JSON.stringify({ valid: true, check, targets: [...outputs.keys()] }, null, 2)}\n`,
);
