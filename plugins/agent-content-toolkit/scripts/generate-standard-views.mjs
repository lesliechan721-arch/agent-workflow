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
  ['skill_author', 'skills/author-agent-skill/references/author-standard.generated.md', 'Agent Skill 作者标准'],
  ['skill_review', 'skills/review-agent-skill/references/review-rubric.generated.md', 'Agent Skill 评审标准'],
  ['eval_design', 'skills/design-agent-skill-evals/references/eval-design-standard.generated.md', 'Skill Eval 设计标准'],
  ['eval_audit', 'skills/audit-agent-skill-evals/references/eval-audit-standard.generated.md', 'Skill Eval 审核标准'],
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

function renderDimensions() {
  const lines = ['# Review Dimensions', '', '> GENERATED from `standards/rules.json`; do not edit manually.', ''];
  source.dimensions.forEach((dimension, index) => {
    lines.push(`## ${index + 1}. ${dimension.title}（${dimension.weight}）`, '', dimension.details, '');
  });
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

function renderScoring() {
  const lines = [
    '# Scoring Model',
    '',
    '> GENERATED from `standards/rules.json`; do not edit manually.',
    '',
    source.scoringModel.introduction,
    '',
    '## 维度与权重',
    '',
    '| ID | 维度 | 权重 |',
    '| --- | --- | ---: |',
    ...source.dimensions.map(dimension => `| \`${dimension.id}\` | ${dimension.title} | ${dimension.weight} |`),
    '',
    source.scoringModel.policy,
    '',
  ];
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

function renderComposition(title, reviewer) {
  const model = source.compositionModel;
  const lines = [
    `# ${title}`,
    '',
    '> GENERATED from `standards/rules.json`; do not edit manually.',
    '',
    '## 六项清单',
    '',
    '| 轴 | 问题 |',
    '| --- | --- |',
    ...model.axes.map(([axis, question]) => `| ${axis} | ${question} |`),
    '',
    '## Verdict',
    '',
    ...model.verdicts.map(([verdict, meaning]) => `- \`${verdict}\`：${meaning}`),
    '',
    '## 强拆分信号',
    '',
    ...model.splitSignals.map(signal => `- ${signal}`),
    '',
    reviewer
      ? 'Reviewer 必须给出最小分解候选并比较 active-path load。文件长或分支多只触发审计，不单独形成 finding。'
      : 'Author 在写正文前完成判定。需要 orchestrator 时，入口只拥有顺序、授权和稳定 handoff。',
    '',
  ];
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

function renderEvidenceAdmission() {
  const admission = source.findingAdmission;
  const lines = [
    '# Evidence and severity',
    '',
    '> GENERATED from `standards/rules.json`; do not edit manually.',
    '',
    '## Evidence',
    '',
    ...admission.evidenceTypes.map(([type, meaning]) => `- \`${type}\`：${meaning}`),
    '',
    '## P0/P1 admission',
    '',
    ...admission.highSeverityRequirements.map(requirement => `- ${requirement}`),
    '',
    'Owner 未证明为 Skill 时，不得要求修改生产 SKILL.md。Heuristic/inferred 默认最多 P2 或 unknown。',
    '',
  ];
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

const outputs = new Map(views.map(([audience, relative, title]) => [relative, renderView(audience, title)]));
outputs.set('skills/review-agent-skill/references/review-dimensions.generated.md', renderDimensions());
outputs.set('skills/review-agent-skill/references/scoring-model.generated.md', renderScoring());
outputs.set('skills/author-agent-skill/references/composition-audit.md', renderComposition('Composition Fitness Audit', false));
outputs.set('skills/review-agent-skill/references/composition-fitness.md', renderComposition('Composition Fitness Review', true));
outputs.set('skills/review-agent-skill/references/evidence-and-severity.md', renderEvidenceAdmission());
outputs.set(
  'standards/review-result-rules.generated.json',
  `${JSON.stringify({
    schemaVersion: source.schemaVersion,
    dimensions: source.dimensions.map(({ id, title, weight }) => ({ id, title, weight })),
  }, null, 2)}\n`,
);

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
  process.stderr.write(`Generated standard views are stale:\n${stale.map(value => `- ${value}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ valid: true, check, targets: [...outputs.keys()] }, null, 2)}\n`);
