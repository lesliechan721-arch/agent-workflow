import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { repoRoot, sha256 } from './native-platform-runtime.mjs';

const yaml = createRequire(path.join(repoRoot, 'packages/cli/package.json'))('yaml');

export const officialSource = 'qualification-official';
export const gitPluginId = `${officialSource}/git-toolkit`;
export const ordinaryGitSkills = ['git-reconcile'];

export async function addOfficialCatalog(ctx) {
  const catalog = path.join(ctx.root, 'official-candidate');
  await fs.cp(path.join(repoRoot, 'packages/cli/plugins-dist'), catalog, { recursive: true });
  const identity = `sha256:${sha256('aw-native-qualification-official-candidate')}`;
  await fs.writeFile(path.join(catalog, '.aw-generated.json'), JSON.stringify({ schemaVersion: 1, kind: 'catalog',
    workspaceIdentity: identity, sourceIdentity: identity }), { flag: 'wx' });
  await ctx.aw(['source', 'add', officialSource, '--path', catalog, '--no-auto-check', '--yes']);
  await ctx.aw(['source', 'sync', officialSource, '--yes']);
  return catalog;
}

function skillDocument(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(source);
  assert(match, 'A published Skill must have both frontmatter and instructions.');
  return { fields: yaml.parse(match[1]), body: match[2] };
}

async function assertPublishedGitSkills(platform, directory, required) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  assert.deepEqual(entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(), required);
  for (const name of required) {
    const published = path.join(directory, name);
    const source = path.join(repoRoot, 'packages/cli/plugins-dist/plugins/git-toolkit', platform, 'skills', name);
    const actual = skillDocument(await fs.readFile(path.join(published, 'SKILL.md'), 'utf8'));
    const authored = skillDocument(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'));
    assert.equal(actual.fields.name, name);
    assert.equal(actual.body, authored.body);
    assert.deepEqual(await fs.readFile(path.join(published, 'README.md')), await fs.readFile(path.join(source, 'README.md')));
    if (platform === 'generic' && name === 'git-commit') {
      assert.equal(actual.fields.metadata['skill.invocation.manual'], 'true');
      assert.equal(actual.fields.metadata['skill.visibility'], 'visible');
      assert.equal(actual.fields.metadata['skill.invocation.model'], 'false');
      assert.equal(actual.fields['disable-model-invocation'], undefined);
    }
  }
}

export async function qualifyShippedGitInstall(ctx) {
  const scope = ctx.scope ?? 'user';
  const result = await ctx.aw(['plugin', 'install', gitPluginId, '--scope', scope, '--target', ctx.platform, '--yes'], ctx.project,
    { timeoutMs: 180_000 });
  assert.equal(result.command, 'plugin.install');
  const targets = result.data.targetResults;
  assert.equal(targets.length, 1);
  const [target] = targets;
  assert.equal(target.pluginId, gitPluginId);
  assert.equal(target.target, ctx.platform);
  assert.equal(target.scope, scope);
  assert.equal(target.execution, 'applied');
  assert.equal(result.data.changes.outputs, 'changed');
  assert.equal(result.data.allSatisfied, true);
  const required = ['git-commit', ...ordinaryGitSkills];
  const notices = result.diagnostics.filter(item => item.code === 'skillInvocationPolicyNotGuaranteed');
  // The manual-only preferences are supported by every native writer.
  // A standalone generic directory has no bound executor.
  const expectedWarning = ctx.platform === 'generic';
  if (expectedWarning) {
    assert.equal(notices.length, 1);
    const [notice] = notices;
    assert.equal(notice.severity, 'warning');
    assert.deepEqual(notice.subject, { pluginId: gitPluginId, target: ctx.platform, scope, field: 'skill.git-commit' });
    assert.equal(notice.detail.reasonCode, 'noBoundExecutor');
    assert(notice.detail.skillInvocationControls.some(control => control.feature === 'skill.invocation.model' && control.values.includes('false')));
  } else assert.deepEqual(notices, []);
  if (ctx.platform === 'generic') {
    assert.deepEqual(target.componentGaps ?? [], []);
    await assertPublishedGitSkills('generic', path.join(ctx.env.HOME, '.agents', 'skills'), required);
    return { level: 'public-AW-install-and-portable-writer-readback', execution: target.execution, skills: required, notice: notices[0] };
  }
  const expected = target.deploymentPlans.flatMap(plan => plan.expected.components).map(component => component.name).sort();
  assert.deepEqual(expected, required);
  const gaps = target.deploymentPlans.flatMap(plan => plan.expected.unmet);
  assert.deepEqual(gaps, []);
  const published = target.deploymentReceipts.filter(receipt => receipt.after.package === 'present' && receipt.after.ownership === 'aw');
  assert.equal(published.length, 1);
  const observed = published[0].after.components.filter(item => item.presence === 'present').map(item => item.id).sort();
  assert.deepEqual(observed, expected.map(name => `skill:${name}`));
  const location = await fs.realpath(published[0].after.nativeIdentity.sourceLocation);
  const relative = path.relative(await fs.realpath(ctx.root), location);
  assert(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
    'Published native package must be inside this isolated fixture.');
  await assertPublishedGitSkills(ctx.platform, path.join(location, 'skills'), required);
  if (ctx.platform === 'antigravity' && scope === 'project') {
    assert.equal(path.dirname(location), path.join(await fs.realpath(ctx.project), '.agents', 'plugins'));
    assert.equal(published[0].after.registration, 'not-applicable');
  }
  if (ctx.platform === 'antigravity' && scope === 'user') {
    assert.equal(published[0].after.nativePackage, 'present');
    const consumed = path.join(ctx.env.HOME, '.gemini', 'config', 'plugins', 'git-toolkit', 'skills');
    await assertPublishedGitSkills('antigravity', consumed, required);
  }
  return { level: 'public-AW-install-receipt-and-published-package-bytes', execution: target.execution, skills: expected, gaps,
    ...(notices[0] ? { notice: notices[0] } : {}) };
}
