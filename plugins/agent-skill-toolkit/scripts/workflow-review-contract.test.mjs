import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const runtimeRoot = context ? path.join(context.plugin.rootDir, context.platform) : localRoot;

const readSkill = (name) => readFile(path.join(runtimeRoot, 'skills', name, 'SKILL.md'), 'utf8');

test('single-Skill Reviewer rejects workflow, plugin, and unbounded system scope', async () => {
  // Static contract exception: installed routing instructions must not claim a broader review unit; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  const skill = await readSkill('review-agent-skill');
  assert.match(skill, /只评审一个 Skill package/u);
  assert.doesNotMatch(skill, /skill \| workflow \| plugin \| system/u);
  assert.doesNotMatch(skill, /target_level=plugin|End-to-End Minimum Architecture Challenge/u);
  assert.match(skill, /目标包含多个 Skill、整个插件或跨插件工作流时，不给完整结论/u);
});

test('workflow Reviewer requires an admitted user-result boundary', async () => {
  // Static contract exception: installed workflow review instructions must contain the admission fields that limit verdict scope; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  const skill = await readSkill('review-agent-workflow');
  assert.match(skill, /## Scope Admission/u);
  for (const field of ['用户结果', '入口', '参与组件', '代表性路径', '明确排除', '用户要做的决策']) {
    assert.match(skill, new RegExp(field, 'u'));
  }
  assert.match(skill, /partial.*rejected/su);
  assert.match(skill, /不能给整个仓库或系统 `pass`/u);
});

test('workflow Reviewer discloses top-level publication with the public digest command', async () => {
  // Static contract exception: installed publication instructions must preserve the publication owner and canonical digest producer; behavior test is not suitable because the consumer contract is the final Skill instruction and its disclosed reference.
  const skill = await readSkill('review-agent-workflow');
  const publication = await readFile(
    path.join(runtimeRoot, 'skills', 'review-agent-workflow', 'references', 'review-publication.md'),
    'utf8',
  );
  assert.match(skill, /本次请求的顶层 Reviewer/u);
  assert.match(skill, /\[Review Publication\]\(references\/review-publication\.md\)/u);
  assert.match(publication, /作为其它 Reviewer 的子级运行时.*不自行发布记录/u);
  assert.match(publication, /aw review digest <component-path> --json/u);
  assert.match(publication, /返回的 `path` 和 `digest` 原样写入/u);
  assert.match(publication, /不自行计算或猜测/u);
});

test('workflow Reviewer owns Leaf Fix Admission and parent synthesis', async () => {
  // Static contract exception: installed workflow review instructions must preserve the leaf-fix ownership boundary; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  const skill = await readSkill('review-agent-workflow');
  const reference = await readFile(
    path.join(runtimeRoot, 'skills', 'review-agent-workflow', 'references', 'workflow-review.md'),
    'utf8',
  );
  assert.match(skill, /Leaf Fix Admission/u);
  assert.match(skill, /当前 Reviewer 负责 common path、owner、blast radius 和最终 verdict/u);
  assert.match(reference, /该 leaf 的直接调用者和已知其它消费者/u);
  assert.match(reference, /workflow、adapter、caller 或 runtime/u);
});

test('workflow Reviewer does not replace leaf Skill Review', async () => {
  // Static contract exception: installed workflow review instructions must retain the read-only handoff to the leaf reviewer; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  const skill = await readSkill('review-agent-workflow');
  assert.match(skill, /`review-agent-skill`：按需评审具体 leaf Skill/u);
  assert.match(skill, /只读审核/u);
  assert.doesNotMatch(skill, /写入生产 Skill|直接修改生产 Skill/u);
});
