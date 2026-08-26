import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
const sourceRoot = pluginContext?.sourceRoot ?? pluginRoot;

test('AW author maps every supported component and core lifecycle branch to a direct reference', async () => {
  // Static contract exception: installed agents must discover each maintained AW author reference from the final Skill entrypoint; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  const root = path.join(runtimeRoot, 'skills', 'author-aw-plugin');
  const skill = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  const refs = [
    'aw-authoring-profile.md',
    'plugin-manifest-spec.md',
    'aw-validation-and-version.md',
    'aw-skill-integration.md',
    'skill-frontmatter-capabilities.md',
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
  for (const ref of [
    'plugin-manifest-capabilities.generated.md',
    'build-config-capabilities.generated.md',
    'extensions-capabilities.generated.md',
    'slash-command-capabilities.generated.md',
    'mcp-app-capabilities.generated.md',
    'config-lifecycle-artifact-capabilities.generated.md',
  ]) {
    const content = await readFile(path.join(root, 'references', ref), 'utf8');
    assert.ok(content.length > 150, ref + ' must contain a focused generated view');
  }
});

test('generated authoring views are fresh projections of the CLI canonical registry', async () => {
  // Static contract exception: installed agents consume these generated tables as a public field contract; behavior test is not suitable because freshness is byte provenance between the canonical registry and final runtime reference.
  const registryPath = path.resolve(
    sourceRoot,
    '..',
    '..',
    'packages/cli/src/utils/plugin-authoring-capabilities.json',
  );
  const bytes = await readFile(registryPath);
  const registry = JSON.parse(bytes.toString('utf8'));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const expected = {
    'plugin-manifest': 'plugin-manifest-capabilities.generated.md',
    'build-config': 'build-config-capabilities.generated.md',
    extensions: 'extensions-capabilities.generated.md',
    'slash-command': 'slash-command-capabilities.generated.md',
    'mcp-app': 'mcp-app-capabilities.generated.md',
    'config-lifecycle-artifact': 'config-lifecycle-artifact-capabilities.generated.md',
  };
  for (const [surface, fileName] of Object.entries(expected)) {
    const content = await readFile(
      path.join(runtimeRoot, 'skills/author-aw-plugin/references', fileName),
      'utf8',
    );
    assert.match(content, new RegExp(digest, 'u'));
    for (const entry of registry.surfaces[surface].entries) {
      const field = entry.field.replaceAll('|', '\\|');
      assert.ok(content.includes(`| \`${field}\` |`), `${fileName} must include ${entry.field}`);
      assert.ok(
        content.includes((entry.verifiedSource ?? registry.verifiedSource).replaceAll('|', '\\|')),
        `${fileName} must trace ${entry.field} to its verified source`,
      );
    }
  }
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
    'aw-validation-and-version.md',
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
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references', 'aw-validation-and-version.md'),
    'utf8',
  );
  assert.doesNotMatch(skill, /validity=pass|blockedCases|result-triage|run-aw-skill-evals/u);
  assert.match(skill, /完成条件不包括独立 Review 或模型 Eval/u);
  assert.match(validation, /Author 的完成条件不依赖模型 Eval/u);
});

test('AW author references keep public commands aligned to workspace-root authoring', async () => {
  // Static contract exception: the final reference table is the installed agent-facing command contract; behavior test is not suitable because the CLI is external to this plugin and the risk is an agent being instructed to use an obsolete command.
  const reference = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references', 'aw-validation-and-version.md'),
    'utf8',
  );
  for (const command of [
    'aw catalog init',
    'aw catalog version',
    'aw catalog build',
    'aw catalog validate',
    'aw catalog publish',
    'aw catalog source add',
    'aw plugin init',
    'aw plugin add-skill',
    'aw plugin validate',
    'aw plugin test',
    'aw plugin build',
    'aw plugin status',
    'aw install',
  ]) assert.match(reference, new RegExp(command.replaceAll(' ', '\\s+'), 'u'));
  assert.match(reference, /--workspace-root <workspace-root>/u);
  assert.doesNotMatch(reference, /--repo-root|pnpm plugin:test|pnpm build/u);
});

test('AW author manifest reference exposes the Core installation policy', async () => {
  // Static contract exception: an installed author agent can otherwise generate a manifest value that Core rejects; behavior test is not suitable because this plugin publishes guidance and Core owns runtime validation.
  const root = path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references');
  const [reference, capabilities] = await Promise.all([
    readFile(path.join(root, 'plugin-manifest-spec.md'), 'utf8'),
    readFile(path.join(root, 'plugin-manifest-capabilities.generated.md'), 'utf8'),
  ]);
  assert.match(reference, /CLI 生成的能力视图/u);
  assert.match(
    capabilities,
    /`marketplace\.policy\.installation`[^\n]+AVAILABLE, NOT_AVAILABLE, INSTALLED_BY_DEFAULT/u,
  );
});

test('AW author final references use public Eval and Catalog version contracts', async () => {
  // Static contract exception: these strings are the final installed agent instructions on both platform bundles.
  const root = path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references');
  const manifestReference = await readFile(path.join(root, 'plugin-manifest-spec.md'), 'utf8');
  const validationReference = await readFile(path.join(root, 'aw-validation-and-version.md'), 'utf8');
  assert.doesNotMatch(manifestReference, /pnpm plugin:eval/u);
  assert.match(validationReference, /只允许稳定 `x\.y\.z` 或精确 `x\.y\.z-beta\.N`/u);
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
