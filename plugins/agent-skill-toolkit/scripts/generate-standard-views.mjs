#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function parseArgs(argv) {
  let check = false;
  let sourceRoot = root;
  let outputRoot = root;
  let contentRulesPath = process.env.AW_PLUGIN_IMPORT_CONTENT_RULES
    ? path.resolve(process.env.AW_PLUGIN_IMPORT_CONTENT_RULES)
    : null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') check = true;
    else if (arg === '--source-root') sourceRoot = path.resolve(argv[++index] ?? '');
    else if (arg === '--output-root') outputRoot = path.resolve(argv[++index] ?? '');
    else if (arg === '--content-rules') contentRulesPath = path.resolve(argv[++index] ?? '');
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!contentRulesPath) {
    throw new Error(
      'Missing agent-content-toolkit rules import. AW_PLUGIN_IMPORT_CONTENT_RULES is required.',
    );
  }
  return { check, sourceRoot, outputRoot, contentRulesPath };
}
const { check, sourceRoot, outputRoot, contentRulesPath } = parseArgs(process.argv.slice(2));
const [contentRaw, skillRaw, dimensionsRaw, reviewDimensionsPolicy, sourceMap, scoringPolicy] =
  await Promise.all([
    readFile(contentRulesPath, 'utf8'),
    readFile(path.join(sourceRoot, 'standards', 'skill-rules.json'), 'utf8'),
    readFile(path.join(sourceRoot, 'standards', 'review-dimensions.json'), 'utf8'),
    readFile(path.join(sourceRoot, 'standards', 'review-dimensions.md'), 'utf8'),
    readFile(path.join(sourceRoot, 'standards', 'source-map.md'), 'utf8'),
    readFile(path.join(sourceRoot, 'standards', 'scoring-policy.md'), 'utf8'),
  ]);
const contentSource = JSON.parse(contentRaw),
  skillSource = JSON.parse(skillRaw),
  dimensionSource = JSON.parse(dimensionsRaw),
  digest = 'sha256:' + createHash('sha256').update(contentRaw).digest('hex');
if (digest !== skillSource.contentRuleSource.digest)
  throw new Error(
    `agent-content-toolkit rule digest changed: expected ${skillSource.contentRuleSource.digest}, got ${digest}`,
  );
const extensionById = new Map();
for (const extension of skillSource.contentRuleExtensions) {
  if (extensionById.has(extension.id))
    throw new Error(`duplicate content rule extension: ${extension.id}`);
  const invalid = Object.keys(extension).filter(
    (key) =>
      key !== 'id' && !['skill_author', 'skill_review', 'eval_design', 'eval_audit'].includes(key),
  );
  if (invalid.length > 0)
    throw new Error(`${extension.id} redefines canonical fields: ${invalid.join(', ')}`);
  extensionById.set(extension.id, extension);
}
const contentIds = new Set(contentSource.rules.map((rule) => rule.id));
for (const id of extensionById.keys())
  if (!contentIds.has(id)) throw new Error(`unknown content rule extension: ${id}`);
for (const rule of skillSource.rules)
  if (contentIds.has(rule.id))
    throw new Error(`Skill rule duplicates canonical content rule: ${rule.id}`);
const contentRules = contentSource.rules.map((rule) => ({
    ...rule,
    ...(extensionById.get(rule.id) ?? {}),
    id: rule.id,
  })),
  allRules = [...contentRules, ...skillSource.rules];
function evidenceLabel(rule) {
  return ['toolkit-policy', 'client-contract', 'specification'].includes(rule.evidenceType)
    ? 'normative'
    : rule.evidenceType;
}
function evidenceLine(rule) {
  const heuristic =
    Array.isArray(rule.heuristicRefs) && rule.heuristicRefs.length > 0
      ? `; heuristic lenses: ${rule.heuristicRefs.join(', ')}`
      : '';
  return `Evidence: ${evidenceLabel(rule)}; sources: ${rule.sourceRefs.join(', ')}${heuristic}`;
}
function renderView(audience, title) {
  const lines = [
    `# ${title}`,
    '',
    '> GENERATED from canonical content rules plus `standards/skill-rules.json`; do not edit manually.',
    '',
  ];
  for (const rule of allRules) {
    const view = rule[audience];
    if (!view) continue;
    lines.push(`## \`${rule.id}\``, '', rule.principle, '');
    for (const [key, value] of Object.entries(view)) lines.push(`- **${key}：** ${value}`);
    lines.push('', evidenceLine(rule), '');
  }
  return lines.join('\n').replace(/\n+$/u, '') + '\n';
}
function renderComposition(title, reviewer) {
  const model = skillSource.compositionModel;
  return (
    [
      `# ${title}`,
      '',
      '> GENERATED from `standards/skill-rules.json`; do not edit manually.',
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
      ...model.splitSignals.map((signal) => `- ${signal}`),
      '',
      reviewer
        ? 'Reviewer 必须给出最小分解候选并比较 active-path load。文件长或分支多只触发审计，不单独形成 finding。'
        : 'Author 在写正文前完成判定。需要 orchestrator 时，入口只拥有顺序、授权和稳定 handoff。',
      '',
    ]
      .join('\n')
      .replace(/\n+$/u, '') + '\n'
  );
}
function renderEvidence() {
  const admission = skillSource.findingAdmission;
  return (
    [
      '# Evidence and severity',
      '',
      '> GENERATED from `standards/skill-rules.json`; do not edit manually.',
      '',
      '## Evidence',
      '',
      ...admission.evidenceTypes.map(([type, meaning]) => `- \`${type}\`：${meaning}`),
      '',
      '## P0/P1 admission',
      '',
      ...admission.highSeverityRequirements.map((requirement) => `- ${requirement}`),
      '',
      'Owner 未证明为 Skill 时，不得要求修改生产 SKILL.md。Official-guidance、heuristic 和 inferred 默认最多 P2 或 unknown。',
      '',
    ]
      .join('\n')
      .replace(/\n+$/u, '') + '\n'
  );
}
const resultRules = {
    schemaVersion: 2,
    dimensions: dimensionSource.dimensions,
    reviewResultPolicy: skillSource.reviewResultPolicy,
  },
  outputs = new Map([
    [
      'skills/author-agent-skill/references/author-standard.generated.md',
      renderView('skill_author', 'Agent Skill 作者标准'),
    ],
    [
      'skills/review-agent-skill/references/review-rubric.generated.md',
      renderView('skill_review', 'Agent Skill 评审标准'),
    ],
    [
      'skills/design-agent-skill-evals/references/eval-design-standard.generated.md',
      renderView('eval_design', 'Skill Eval 设计标准'),
    ],
    [
      'skills/audit-agent-skill-evals/references/eval-audit-standard.generated.md',
      renderView('eval_audit', 'Skill Eval 审核标准'),
    ],
    [
      'skills/author-agent-skill/references/composition-audit.md',
      renderComposition('Composition Fitness Audit', false),
    ],
    [
      'skills/review-agent-skill/references/composition-fitness.md',
      renderComposition('Composition Fitness Review', true),
    ],
    ['skills/review-agent-skill/references/evidence-and-severity.md', renderEvidence()],
    ['skills/review-agent-skill/references/review-dimensions.generated.md', reviewDimensionsPolicy],
    ['skills/review-agent-skill/references/scoring-model.generated.md', scoringPolicy],
    ['skills/review-agent-skill/references/source-map.generated.md', sourceMap],
    [
      'skills/review-agent-skill/assets/review-result-rules.generated.json',
      JSON.stringify(resultRules, null, 2) + '\n',
    ],
  ]);
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
    `Generated Skill standard views are stale:\n${stale.map((value) => `- ${value}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  JSON.stringify({ valid: true, check, targets: [...outputs.keys()] }, null, 2) + '\n',
);
