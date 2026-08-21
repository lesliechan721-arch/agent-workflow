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
    else throw new Error('Unknown option: ' + arg);
  }
  if (!contentRulesPath) {
    throw new Error('Missing agent-content-toolkit rules import. AW_PLUGIN_IMPORT_CONTENT_RULES is required.');
  }
  return { check, sourceRoot, outputRoot, contentRulesPath };
}

const options = parseArgs(process.argv.slice(2));
const [contentRaw, skillRaw, dimensionsRaw] = await Promise.all([
  readFile(options.contentRulesPath, 'utf8'),
  readFile(path.join(options.sourceRoot, 'standards', 'skill-rules.json'), 'utf8'),
  readFile(path.join(options.sourceRoot, 'standards', 'review-dimensions.json'), 'utf8'),
]);
const contentSource = JSON.parse(contentRaw);
const skillSource = JSON.parse(skillRaw);
const dimensionSource = JSON.parse(dimensionsRaw);
const contentDigest = 'sha256:' + createHash('sha256').update(contentRaw).digest('hex');
if (contentDigest !== skillSource.contentRuleSource.digest) {
  throw new Error(
    `agent-content-toolkit rule digest changed: expected ${skillSource.contentRuleSource.digest}, got ${contentDigest}`,
  );
}

const extensionById = new Map();
for (const extension of skillSource.contentRuleExtensions) {
  if (extensionById.has(extension.id)) throw new Error('duplicate content rule extension: ' + extension.id);
  const invalid = Object.keys(extension).filter(
    (key) => key !== 'id' && !['skill_author', 'skill_review', 'eval_design', 'eval_audit'].includes(key),
  );
  if (invalid.length > 0) throw new Error(`${extension.id} redefines canonical fields: ${invalid.join(', ')}`);
  extensionById.set(extension.id, extension);
}
const contentIds = new Set(contentSource.rules.map((rule) => rule.id));
for (const id of extensionById.keys()) {
  if (!contentIds.has(id)) throw new Error('unknown content rule extension: ' + id);
}
for (const rule of skillSource.rules) {
  if (contentIds.has(rule.id)) throw new Error('Skill rule duplicates canonical content rule: ' + rule.id);
}
const contentRules = contentSource.rules.map((rule) => ({
  ...rule,
  ...(extensionById.get(rule.id) ?? {}),
  id: rule.id,
}));
const allRules = [...contentRules, ...skillSource.rules];

function evidenceLabel(rule) {
  return ['toolkit-policy', 'client-contract', 'specification'].includes(rule.evidenceType)
    ? 'normative'
    : rule.evidenceType;
}
function evidenceLine(rule) {
  const heuristic = Array.isArray(rule.heuristicRefs) && rule.heuristicRefs.length > 0
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
  const lines = [
    `# ${title}`,
    '',
    '> GENERATED from `standards/skill-rules.json`; do not edit manually.',
    '',
  ];
  if (Array.isArray(model.targetLevels)) {
    lines.push(
      '## 评审层级',
      '',
      '| 层级 | 评审对象 |',
      '| --- | --- |',
      ...model.targetLevels.map(([level, meaning]) => `| \`${level}\` | ${meaning} |`),
      '',
      '当前用户结果涉及多个 Skill、插件、runner、runtime 或持久合同时，不得只做彼此独立的 Skill review。',
      '',
    );
  }
  lines.push(
    '## 组合轴',
    '',
    '| 轴 | 问题 |',
    '| --- | --- |',
    ...model.axes.map(([axis, question]) => `| ${axis} | ${question} |`),
    '',
  );
  if (Array.isArray(model.systemAuditTriggers)) {
    lines.push('## 系统级审计触发信号', '', ...model.systemAuditTriggers.map((signal) => `- ${signal}`), '');
  }
  if (Array.isArray(model.endToEndChallenge)) {
    lines.push('## End-to-End Minimum Architecture Challenge', '', ...model.endToEndChallenge.map((step, index) => `${index + 1}. ${step}`), '');
  }
  lines.push(
    '## Verdict',
    '',
    ...model.verdicts.map(([verdict, meaning]) => `- \`${verdict}\`：${meaning}`),
    '',
    '## 强拆分或过度工程化信号',
    '',
    ...model.splitSignals.map((signal) => `- ${signal}`),
    '',
  );
  if (model.stopRule) lines.push('## 停止规则', '', model.stopRule, '');
  lines.push(
    reviewer
      ? 'Reviewer 先比较当前 common path 与同样安全的最小候选，再决定是否继续局部评分。文件长或分支多只触发审计，不单独形成 finding。'
      : 'Author 在写正文前完成判定。需要 orchestrator 时，入口只拥有顺序、授权和最小 handoff；可重算事实不形成持久模型合同。',
    '',
  );
  return lines.join('\n').replace(/\n+$/u, '') + '\n';
}
function renderEvidence() {
  const admission = skillSource.findingAdmission;
  return [
    '# Evidence and severity',
    '',
    '> GENERATED from `standards/skill-rules.json`; do not edit manually.',
    '',
    '## Evidence',
    '',
    ...admission.evidenceTypes.map(([type, meaning]) => `- \`${type}\`：${meaning}`),
    '',
    '## High-severity admission',
    '',
    ...admission.highSeverityRequirements.map((requirement) => `- ${requirement}`),
    '',
    'Owner 未证明为 Skill 时，不得要求修改生产 SKILL.md。Official-guidance、heuristic 和 inferred 默认最多是 minor/advisory 或 unknown。',
    '',
  ].join('\n').replace(/\n+$/u, '') + '\n';
}

const legacyResultRules = JSON.stringify({
  schemaVersion: 2,
  dimensions: dimensionSource.dimensions,
  reviewResultPolicy: skillSource.reviewResultPolicy,
}, null, 2) + '\n';

const outputs = new Map([
  ['skills/author-agent-skill/references/author-standard.generated.md', renderView('skill_author', 'Agent Skill 作者标准')],
  ['skills/review-agent-skill/references/review-rubric.generated.md', renderView('skill_review', 'Agent Skill 评审标准')],
  ['skills/design-agent-skill-evals/references/eval-design-standard.generated.md', renderView('eval_design', 'Skill Eval 设计标准')],
  ['skills/audit-agent-skill-evals/references/eval-audit-standard.generated.md', renderView('eval_audit', 'Skill Eval 审核标准')],
  ['skills/author-agent-skill/references/composition-audit.md', renderComposition('Composition Fitness Audit', false)],
  ['skills/review-agent-skill/references/composition-fitness.md', renderComposition('Composition Fitness Review', true)],
  ['skills/review-agent-skill/references/evidence-and-severity.md', renderEvidence()],
  ['standards/review-result-rules.generated.json', legacyResultRules],
]);
const stale = [];
for (const [relative, content] of outputs) {
  const target = path.join(options.outputRoot, relative);
  if (options.check) {
    const actual = await readFile(target, 'utf8').catch(() => null);
    if (actual !== content) stale.push(relative);
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}
if (stale.length > 0) {
  process.stderr.write(`Generated Skill standard views are stale:\n${stale.map((value) => `- ${value}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify({ valid: true, check: options.check, targets: [...outputs.keys()] }, null, 2) + '\n');
