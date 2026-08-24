import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? localRoot;
const runtimeRoot = context ? path.join(context.plugin.rootDir, context.platform) : localRoot;

test('author Skill directly routes every maintained author reference', async () => {
  // Static contract exception: installed agents must discover each maintained reference from the final Skill entrypoint; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  const root = path.join(runtimeRoot, 'skills', 'author-agent-skill');
  const skill = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  for (const reference of [
    'problem-and-scope.md',
    'invocation-and-description.md',
    'package-and-disclosure.md',
    'script-authoring.md',
    'completion-and-validation.md',
    'author-standard.md',
    'composition-audit.md',
  ]) {
    assert.match(skill, new RegExp(`references/${reference.replaceAll('.', '\\.')}`, 'u'));
    if (!['author-standard.md', 'composition-audit.md'].includes(reference)) {
      const source = path.join(sourceRoot, 'skills', 'author-agent-skill', 'references', reference);
      assert.ok((await readFile(source, 'utf8')).length > 150, reference);
    }
  }
});

test('single-Skill Reviewer directly exposes delta and conditional specialist references', async () => {
  // Static contract exception: installed reviewers must retain direct routes to each conditional review contract; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  const root = path.join(runtimeRoot, 'skills', 'review-agent-skill');
  const skill = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  for (const reference of [
    'delta-review.md',
    'review-rubric.md',
    'composition-fitness.md',
    'architecture-boundaries.md',
    'scripts-and-resources.md',
    'evidence-and-severity.md',
  ]) {
    assert.match(skill, new RegExp(`references/${reference.replaceAll('.', '\\.')}`, 'u'));
  }
});

test('authoring and Eval design do not force Review, Audit, or model execution', async () => {
  // Static contract exception: installed author instructions must not authorize unrequested review or model cost; behavior test is not suitable because the safety boundary is the final Skill instruction itself.
  const author = await readFile(path.join(runtimeRoot, 'skills', 'author-agent-skill', 'SKILL.md'), 'utf8');
  const designer = await readFile(path.join(runtimeRoot, 'skills', 'design-agent-skill-evals', 'SKILL.md'), 'utf8');
  for (const text of [author, designer]) {
    assert.doesNotMatch(text, /必须启动独立上下文子代理/u);
    assert.doesNotMatch(text, /validity=pass|blockedCases|case corpus digest/u);
    assert.doesNotMatch(text, /run-aw-skill-evals/u);
  }
  assert.match(author, /不自动审核 Oracle、不自动运行 Eval、不自动触发独立 Review/u);
  assert.match(designer, /Audit status: not assessed/u);
});
