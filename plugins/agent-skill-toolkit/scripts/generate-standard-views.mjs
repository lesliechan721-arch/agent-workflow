#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.slice(2).includes('--check');
const skillRulesPath = path.join(root, 'standards', 'skill-rules.json');
const mergedRulesPath = path.join(root, 'standards', 'rules.json');
const defaultContentRulesPath = path.resolve(root, '..', 'agent-content-toolkit', 'standards', 'rules.json');
const contentRulesPath = process.env.AGENT_CONTENT_RULES_PATH
  ? path.resolve(process.env.AGENT_CONTENT_RULES_PATH)
  : defaultContentRulesPath;
const audienceKeys = ['writing', 'content_review', 'skill_author', 'skill_review', 'eval_design', 'eval_audit'];

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}
function digest(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}
function normalizedEvidence(value) {
  if (['specification', 'client-contract', 'project-policy', 'normative'].includes(value)) return 'normative';
  if (['third-party-heuristic', 'heuristic'].includes(value)) return 'heuristic';
  return value;
}
function mergeSources(contentSource, skillSource, contentRaw, skillRaw) {
  const extensionById = new Map();
  for (const extension of skillSource.contentRuleExtensions ?? []) {
    if (extensionById.has(extension.id)) throw new Error('Duplicate content rule extension: ' + extension.id);
    const extraKeys = Object.keys(extension).filter((key) => key !== 'id' && !['skill_author', 'skill_review', 'eval_design', 'eval_audit'].includes(key));
    if (extraKeys.length > 0) throw new Error(`Content rule extension ${extension.id} redefines canonical fields: ${extraKeys.join(', ')}`);
    extensionById.set(extension.id, extension);
  }
  const canonicalIds = new Set(contentSource.rules.map((rule) => rule.id));
  for (const id of extensionById.keys()) if (!canonicalIds.has(id)) throw new Error('Extension targets unknown content rule: ' + id);
  for (const rule of skillSource.rules) if (canonicalIds.has(rule.id)) throw new Error('Skill rules duplicate canonical content rule: ' + rule.id);

  const mergedContentRules = contentSource.rules.map((rule) => {
    const extension = extensionById.get(rule.id) ?? {};
    const merged = { ...rule, ...extension, id: rule.id };
    merged.appliesTo = audienceKeys.filter((audience) => merged[audience] !== undefined);
    return merged;
  });
  const merged = {
    schemaVersion: 3,
    sources: {
      contentRules: { path: 'agent-content-toolkit/standards/rules.json', digest: digest(contentRaw) },
      skillRules: { path: 'agent-skill-toolkit/standards/skill-rules.json', digest: digest(skillRaw) },
    },
    compositionModel: skillSource.compositionModel,
    findingAdmission: skillSource.findingAdmission,
    rules: [...mergedContentRules, ...skillSource.rules],
    dimensions: skillSource.dimensions,
    scoringModel: skillSource.scoringModel,
  };
  return merged;
}

const skillRaw = await readFile(skillRulesPath, 'utf8');
const skillSource = JSON.parse(skillRaw);
let source;
let hasCanonicalContentSource = false;
if (await exists(contentRulesPath)) {
  const contentRaw = await readFile(contentRulesPath, 'utf8');
  source = mergeSources(JSON.parse(contentRaw), skillSource, contentRaw, skillRaw);
  hasCanonicalContentSource = true;
} else {
  source = JSON.parse(await readFile(mergedRulesPath, 'utf8'));
  const expected = source.sources?.skillRules?.digest;
  if (expected && expected !== digest(skillRaw)) throw new Error('Generated rules.json does not match local skill-rules.json.');
}

const views = [
  ['skill_author', 'skills/author-agent-skill/references/author-standard.generated.md', 'Agent Skill 作者标准'],
  ['skill_review', 'skills/review-agent-skill/references/review-rubric.generated.md', 'Agent Skill 评审标准'],
  ['eval_design', 'skills/design-agent-skill-evals/references/eval-design-standard.generated.md', 'Skill Eval 设计标准'],
  ['eval_audit', 'skills/audit-agent-skill-evals/references/eval-audit-standard.generated.md', 'Skill Eval 审核标准'],
];
function renderView(audience, title) {
  const lines = [`# ${title}`, '', '> GENERATED from canonical content rules plus `standards/skill-rules.json`; do not edit manually.', ''];
  for (const rule of source.rules) {
    const view = rule[audience]; if (!view) continue;
    lines.push(`## \`${rule.id}\``, '', rule.principle, '');
    for (const [key, value] of Object.entries(view)) lines.push(`- **${key}：** ${value}`);
    lines.push('', `Evidence: ${normalizedEvidence(rule.evidenceType)}; sources: ${rule.sourceRefs.join(', ')}`, '');
  }
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}
function renderDimensions() {
  const lines = ['# Review Dimensions', '', '> GENERATED from `standards/rules.json`; do not edit manually.', ''];
  source.dimensions.forEach((dimension, index) => lines.push(`## ${index + 1}. ${dimension.title}（${dimension.weight}）`, '', dimension.details, ''));
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}
function renderScoring() {
  const lines = [
    '# Scoring Model', '',
    '> GENERATED maintainer reference. Runtime reviewers use the mode-specific rubric/dimensions and the validator; do not load this file into a normal review context.', '',
    source.scoringModel.introduction, '',
    '## Canonical dimensions', '',
    '| ID | 维度 | 权重 |', '| --- | --- | ---: |',
    ...source.dimensions.map((dimension) => `| \`${dimension.id}\` | ${dimension.title} | ${dimension.weight} |`), '',
    '## Deterministic ownership', '',
    '- `scripts/validate-review-result.mjs` validates canonical weights and computes coverage, weighted score, confidence, design and release readiness.',
    '- `quick` / `delta` do not produce a weighted score. `full` / `release-quality` must cover every canonical dimension exactly once.',
    '- Findings and unknowns are established before scores. A score below 5 must link a finding or unknown.',
    '- Quality bands are diagnostic only; they do not override release gates.', '',
    source.scoringModel.policy, '',
  ];
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}
function renderComposition(title, reviewer) {
  const model = source.compositionModel;
  const lines = [`# ${title}`, '', '> GENERATED from `standards/rules.json`; do not edit manually.', '', '## 六项清单', '', '| 轴 | 问题 |', '| --- | --- |', ...model.axes.map(([axis, question]) => `| ${axis} | ${question} |`), '', '## Verdict', '', ...model.verdicts.map(([verdict, meaning]) => `- \`${verdict}\`：${meaning}`), '', '## 强拆分信号', '', ...model.splitSignals.map((signal) => `- ${signal}`), '', reviewer ? 'Reviewer 必须给出最小分解候选并比较 active-path load。文件长或分支多只触发审计，不单独形成 finding。' : 'Author 在写正文前完成判定。需要 orchestrator 时，入口只拥有顺序、授权和稳定 handoff。', ''];
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}
function renderEvidenceAdmission() {
  const admission = source.findingAdmission;
  const lines = ['# Evidence and severity', '', '> GENERATED from `standards/rules.json`; do not edit manually.', '', '## ReviewResult evidence admission', '', ...admission.evidenceTypes.map(([type, meaning]) => `- \`${type}\`：${meaning}`), '- `official-guidance`：官方设计建议；影响质量评分，但不能单独支持 P0/P1。', '', '规则来源标签与 ReviewResult admission 类型不同；生成器负责映射，Reviewer 不把 `project-policy` 等来源标签直接写入 ReviewResult。', '', '## P0/P1 admission', '', ...admission.highSeverityRequirements.map((requirement) => `- ${requirement}`), '', 'Owner 未证明为 Skill 时，不得要求修改生产 SKILL.md。Official-guidance、heuristic 和 inferred 默认最多 P2 或 unknown。', ''];
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
}

const outputs = new Map(views.map(([audience, relative, title]) => [relative, renderView(audience, title)]));
outputs.set('skills/review-agent-skill/references/review-dimensions.generated.md', renderDimensions());
outputs.set('standards/scoring-model.generated.md', renderScoring());
outputs.set('skills/author-agent-skill/references/composition-audit.md', renderComposition('Composition Fitness Audit', false));
outputs.set('skills/review-agent-skill/references/composition-fitness.md', renderComposition('Composition Fitness Review', true));
outputs.set('skills/review-agent-skill/references/evidence-and-severity.md', renderEvidenceAdmission());
outputs.set('skills/review-agent-skill/references/source-map.generated.md', await readFile(path.join(root, 'standards', 'source-map.md'), 'utf8'));
outputs.set('standards/review-result-rules.generated.json', `${JSON.stringify({ schemaVersion: source.schemaVersion, dimensions: source.dimensions.map(({ id, title, weight }) => ({ id, title, weight })) }, null, 2)}\n`);
if (hasCanonicalContentSource) outputs.set('standards/rules.json', `${JSON.stringify(source, null, 2)}\n`);

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
  process.stderr.write(`Generated Skill standard views are stale:\n${stale.map((value) => `- ${value}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ valid: true, check, composed: hasCanonicalContentSource, targets: [...outputs.keys()] }, null, 2)}\n`);
