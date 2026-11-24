import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let manifestRoot = root;
let skillsRoot = path.join(root, 'skills');
let sourceRoot = root;
let bundled = false;
if (process.env.AW_PLUGIN_CONTEXT) {
  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
  assert.equal(context.event, 'test');
  assert.equal(context.plugin.name, 'human-content');
  assert.ok(['codex', 'claude'].includes(context.platform));
  manifestRoot = context.plugin.rootDir;
  skillsRoot = path.join(context.plugin.rootDir, context.platform, 'skills');
  sourceRoot = context.sourceRoot ?? root;
  bundled = true;
}

const REQUIRED_SKILL = 'explain-clearly';
const REQUIRED_REFERENCES = [
  'references/diagrams-and-visuals.md',
  'references/interactive-html.md',
  'references/explainer-video.md',
];
const REQUIRED_SKILL_FILES = [
  'SKILL.md',
  'README.md',
  ...REQUIRED_REFERENCES,
];

async function assertReadmeLinksResolve(readmePath, boundaryRoot) {
  const text = await readFile(readmePath, 'utf8');
  assert.ok(text.trim().length > 0, `README must be non-empty: ${readmePath}`);
  const baseDir = path.dirname(readmePath);
  for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const resolved = path.resolve(baseDir, target.split('#')[0]);
    assert.ok(resolved.startsWith(`${boundaryRoot}${path.sep}`), `README link escapes root: ${target}`);
    await access(resolved);
  }
}

test('public package and self-contained explain-clearly resources are present', async () => {
  const m = JSON.parse(await readFile(path.join(manifestRoot, '.agents-plugin/plugin.json'), 'utf8'));
  assert.equal(m.schemaVersion, 4);
  assert.equal(m.name, 'human-content');
  assert.equal(m.skills, './skills');
  assert.deepEqual(m.platforms, ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'copilot', 'grok', 'generic']);
  assert.equal(Object.hasOwn(m, 'distributions'), false);

  await assertReadmeLinksResolve(path.join(sourceRoot, 'README.md'), sourceRoot);

  const runtimeRoots = bundled
    ? m.platforms.map((platform) => path.join(manifestRoot, platform, 'skills'))
    : [path.resolve(manifestRoot, m.skills)];
  for (const runtimeRoot of runtimeRoots) {
    assert.ok(runtimeRoot.startsWith(`${manifestRoot}${path.sep}`));
    for (const relative of REQUIRED_SKILL_FILES) {
      await access(path.join(runtimeRoot, REQUIRED_SKILL, relative));
    }
    if (bundled) {
      await assert.rejects(access(path.join(runtimeRoot, REQUIRED_SKILL, 'evals')));
    }
  }

  assert.deepEqual(m.interface.capabilities, ['Skills']);
  const names = (await readdir(skillsRoot)).filter((name) => !name.startsWith('.'));
  assert.deepEqual(names, [REQUIRED_SKILL]);

  for (const name of names) {
    const skillDir = path.join(skillsRoot, name);
    await assertReadmeLinksResolve(path.join(skillDir, 'README.md'), skillDir);

    const text = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(text, /^description: .+/m);

    const referencedPaths = new Set();
    for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(target)) continue;
      referencedPaths.add(target.split('#')[0]);
    }
    for (const [, target] of text.matchAll(/`((?:references|assets|scripts)\/[^`\s]+)`/g)) {
      referencedPaths.add(target.split('#')[0]);
    }
    for (const requiredRef of REQUIRED_REFERENCES) {
      assert.ok(referencedPaths.has(requiredRef), `SKILL.md must explicitly reference ${requiredRef}`);
    }
    for (const target of referencedPaths) {
      const resolved = path.resolve(skillDir, target);
      assert.ok(resolved.startsWith(`${skillDir}${path.sep}`));
      await access(resolved);
    }

    const metadata = await readFile(path.join(skillDir, 'agents/openai.yaml'), 'utf8');
    assert.match(metadata, new RegExp(`display_name: ${name}`));
    assert.match(metadata, new RegExp(`default_prompt:.*\\$${name}`));
    assert.match(metadata, /allow_implicit_invocation: true/);
  }
});

test('source eval manifest and corpora align with explain-clearly', async () => {
  const evalRoot = path.join(sourceRoot, 'skills', REQUIRED_SKILL, 'evals');
  const manifest = JSON.parse(await readFile(path.join(evalRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.ok(Array.isArray(manifest.suites) && manifest.suites.length >= 2);
  assert.ok(manifest.profiles && typeof manifest.profiles === 'object');

  for (const suite of manifest.suites) {
    assert.ok(Array.isArray(suite.profiles) && suite.profiles.length > 0);
    for (const profileId of suite.profiles) {
      const profile = manifest.profiles[profileId];
      assert.ok(profile, `Missing profile ${profileId} in eval manifest`);
      assert.ok(Object.hasOwn(profile.plugins ?? {}, 'human-content'));
    }

    const corpus = JSON.parse(await readFile(path.join(evalRoot, suite.cases), 'utf8'));
    assert.equal(corpus.version, 1);
    assert.equal(corpus.suite.unitUnderTest, REQUIRED_SKILL);
    assert.equal(corpus.suite.kind, suite.kind);
    assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0);

    const caseIds = new Set();
    for (const entry of corpus.cases) {
      assert.equal(typeof entry.id, 'string');
      assert.ok(entry.id.length > 0);
      assert.equal(caseIds.has(entry.id), false, `Duplicate eval case id: ${entry.id}`);
      caseIds.add(entry.id);
    }
  }
});
