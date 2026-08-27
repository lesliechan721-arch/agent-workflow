import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const runtimeRoot = pluginContext?.platform
  ? path.join(pluginRoot, pluginContext.platform)
  : pluginRoot;

test('AW author maps every supported component and core lifecycle branch to a direct reference', async () => {
  // Static contract exception: installed agents must discover each maintained AW author reference from the final Skill entrypoint; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  const root = path.join(runtimeRoot, 'skills', 'author-aw-plugin');
  const skill = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  const refs = [
    'aw-authoring-profile.md',
    'plugin-manifest-spec.md',
    'aw-validation.md',
    'aw-skill-integration.md',
    'extensions-spec.md',
    'slash-commands.md',
    'mcp-and-apps.md',
    'claude-only-capabilities.md',
    'build-config-spec.md',
    'aw-script-testing.md',
    'aw-config-and-helper.md',
    'aw-artifact-renderer.md',
    'aw-lifecycle.md',
    'aw-readme-authoring.md',
  ];
  for (const ref of refs) {
    const content = await readFile(path.join(root, 'references', ref), 'utf8');
    assert.ok(content.length > 150, ref + ' must contain focused guidance');
    assert.match(skill, new RegExp('references/' + ref.replaceAll('.', '\\.'), 'u'));
  }
});

test('authoring references use runtime capability lookup without bundled field truth', async () => {
  // Static contract exception: installed authors must query the live CLI instead of a bundled field table; behavior test is not suitable because the final installed guidance is the consumer interface.
  const root = path.join(runtimeRoot, 'skills', 'author-aw-plugin');
  const contents = await Promise.all([
    readFile(path.join(root, 'SKILL.md'), 'utf8'),
    ...[
      'plugin-manifest-spec.md', 'build-config-spec.md', 'extensions-spec.md',
      'slash-commands.md', 'mcp-and-apps.md', 'aw-config-and-helper.md',
      'aw-lifecycle.md', 'aw-artifact-renderer.md',
    ].map((name) => readFile(path.join(root, 'references', name), 'utf8')),
  ]);
  const combined = contents.join('\n');
  assert.match(combined, /aw plugin capabilities --surface manifest --json/u);
  for (const surface of ['build-config', 'extensions', 'slash-commands', 'mcp-apps', 'config', 'lifecycle', 'artifacts']) {
    assert.match(combined, new RegExp(`aw plugin capabilities --surface ${surface} --json`, 'u'));
  }
  assert.doesNotMatch(combined, /capabilities\.generated\.md|skill-frontmatter-capabilities\.md/u);
});

test('artifact renderer reference exposes the portable distribution input contract', async () => {
  // Static contract exception: installed authors consume this reference to select only bundle-local portable runtime imports; behavior test is not suitable because this plugin publishes guidance instead of running consumer renderers.
  const reference = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references', 'aw-artifact-renderer.md'),
    'utf8',
  );
  for (const fragment of [
    'AW_PLUGIN_DISTRIBUTION=agent-skills',
    'AW_PLUGIN_PLATFORM',
    '`distribution` 是 `"agent-skills"`',
    '`runtimeImports` 的每项是 `{ artifactId, name, providerPluginId, exportName, path, digest }`',
    'typed build-time reuse edge，不声明、也不推断 manifest `dependencies`',
    'target 的 `id` 和其 runtime import 的 `name`',
    'bundle-local `path`',
    'target 为 disabled 时也返回 disabled artifact',
  ]) {
    assert.ok(reference.includes(fragment), `missing portable renderer contract: ${fragment}`);
  }
});

test('author references exclude repository release internals and known drift', async () => {
  // Static contract exception: these strings would direct installed agents to unavailable or workspace-private commands; behavior test is not suitable because absence in the shipped guidance is the safety boundary.
  const referencesRoot = path.join(runtimeRoot, 'skills/author-aw-plugin/references');
  const files = [
    'aw-authoring-profile.md',
    'aw-config-and-helper.md',
    'aw-lifecycle.md',
    'aw-script-testing.md',
    'aw-validation.md',
    'build-config-spec.md',
    'mcp-and-apps.md',
    'plugin-manifest-spec.md',
  ];
  const content = (await Promise.all(files.map((file) => readFile(path.join(referencesRoot, file), 'utf8')))).join('\n');
  for (const forbidden of [
    'release:recover',
    'npx -y',
    'pnpm plugin:test',
    'plugin-release-ledger',
    'dist-tag',
    'receipt schema 4',
  ]) {
    assert.doesNotMatch(content, new RegExp(forbidden, 'u'));
  }
});

test('AW author does not make Audit, Review, or model Eval part of change completion', async () => {
  // Static contract exception: installed author instructions must not authorize unrequested review or model cost; behavior test is not suitable because the safety boundary is the final Skill instruction itself.
  const skill = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'SKILL.md'),
    'utf8',
  );
  const validation = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references', 'aw-validation.md'),
    'utf8',
  );
  assert.doesNotMatch(skill, /validity=pass|blockedCases|result-triage|run-aw-skill-evals/u);
  assert.match(skill, /完成条件不包括独立 Review 或模型 Eval/u);
  assert.match(validation, /Author 的完成条件不依赖(?:独立 Review 或)?模型 Eval/u);
});

test('AW author references keep public commands aligned to single-plugin workspace-root authoring', async () => {
  // Static contract exception: the final reference table is the installed agent-facing command contract; behavior test is not suitable because the CLI is external to this plugin and the risk is an agent being instructed to use an obsolete command.
  const reference = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references', 'aw-validation.md'),
    'utf8',
  );
  for (const command of [
    'aw plugin remove',
    'aw plugin validate',
    'aw plugin test',
    'aw plugin build',
    'aw plugin status',
    'aw plugin capabilities',
  ]) assert.match(reference, new RegExp(command.replaceAll(' ', '\\s+'), 'u'));
  assert.match(reference, /--workspace-root <workspace-root>/u);
  assert.match(reference, /aw plugin remove <plugin-name> --workspace-root <workspace-root> --yes --json/u);
  assert.match(reference, /不使用或猜测 `--force`/u);
  assert.match(reference, /删除的插件不再运行 validate、test、build 或 status/u);
  assert.doesNotMatch(reference, /aw catalog (?:init|version|build|validate|status|publish|source)/u);
  assert.doesNotMatch(reference, /--repo-root|pnpm plugin:test|pnpm build/u);
});

test('AW author manifest reference points to the runtime capability contract', async () => {
  // Static contract exception: installed authors must reach the live manifest contract; behavior test is not suitable because the final installed reference is the consumer interface.
  const root = path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references');
  const reference = await readFile(path.join(root, 'plugin-manifest-spec.md'), 'utf8');
  assert.match(reference, /aw plugin capabilities --surface manifest --json/u);
});

test('AW author final references use public Eval and plugin version contracts', async () => {
  // Static contract exception: these strings are the final installed agent instructions on both platform bundles.
  const root = path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references');
  const manifestReference = await readFile(path.join(root, 'plugin-manifest-spec.md'), 'utf8');
  const validationReference = await readFile(path.join(root, 'aw-validation.md'), 'utf8');
  assert.doesNotMatch(manifestReference, /pnpm plugin:eval/u);
  assert.match(validationReference, /plugin `version`/u);
  assert.doesNotMatch(validationReference, /catalog-v<version>|--remote|--branch/u);
});

test('AW config reference keeps private values out of presets', async () => {
  // Static contract exception: installed author instructions must retain the no-secret preset rule; behavior test is not suitable because this plugin supplies author guidance and does not execute config writes itself.
  const reference = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references', 'aw-config-and-helper.md'),
    'utf8',
  );
  assert.match(reference, /preset 不得包含 sensitive、`file` 或 `directory` 字段/u);
});

test('AW reviewer final references contain no monorepo publication flow', async () => {
  const root = path.join(runtimeRoot, 'skills', 'review-aw-plugin');
  const contents = await Promise.all([
    readFile(path.join(root, 'SKILL.md'), 'utf8'),
    readFile(path.join(root, 'references', 'review-publication.md'), 'utf8'),
  ]);
  for (const content of contents) {
    assert.doesNotMatch(content, /pnpm review:publish|--repo-root|packages\/cli\/dist/u);
  }
  assert.match(contents[0], /--workspace-root <workspace-root>/u);
  assert.match(contents.join('\n'), /PATH` 上已安装的 `aw`|上层兼容 Runner/u);
  assert.match(contents[0], /失败时停止，不读取 manifest 派生的 collection/u);
  assert.match(contents[0], /leaf inventory 为空/u);

  const releaseChecker = await readFile(
    path.join(root, 'scripts', 'check-aw-plugin-release.mjs'),
    'utf8',
  );
  for (const override of [
    'AW_PLUGIN_VALIDATOR_BIN',
    'AW_SKILL_CHECK_BIN',
    'AW_REVIEW_LITE_VALIDATOR',
    'AW_EVAL_AUDIT_VALIDATOR',
    'AW_EVAL_BUNDLE_VALIDATOR',
  ]) assert.doesNotMatch(releaseChecker, new RegExp(`process\\.env\\.${override}`, 'u'));
});

test('AW reviewer prepares every strict Release Check input before running the checker', async () => {
  // Static contract exception: this is the installed orchestration contract for inputs enforced by the deterministic checker.
  const skill = await readFile(
    path.join(runtimeRoot, 'skills', 'review-aw-plugin', 'SKILL.md'),
    'utf8',
  );
  assert.match(skill, /每个唯一 production digest[^\n]+`full`[^\n]+`QualityReviewResult v1`/u);
  assert.match(skill, /coverage 必须为 100%[^\n]+confidence 必须为 medium 或 high/u);
  assert.match(skill, /`effectiveDecision` 必须为 `pass`/u);
  assert.match(skill, /preflight audit、run bundle 和 triage audit/u);
  assert.match(skill, /当前 corpus digest、case IDs 和 minimum runs/u);
  assert.match(skill, /缺少任一 required input 时停止/u);
});
