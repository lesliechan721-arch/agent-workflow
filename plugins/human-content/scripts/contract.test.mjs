import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let manifestRoot = root;
let skillsRoot = path.join(root, 'skills');
if (process.env.AW_PLUGIN_CONTEXT) {
  const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
  assert.equal(context.event, 'test');
  assert.equal(context.plugin.name, 'human-content');
  assert.ok(['codex', 'claude'].includes(context.platform));
  manifestRoot = context.plugin.rootDir;
  skillsRoot = path.join(context.plugin.rootDir, context.platform, 'skills');
}

test('public package and self-contained reading resources are present', async () => {
  const m = JSON.parse(await readFile(path.join(manifestRoot, '.agents-plugin/plugin.json'), 'utf8'));
  assert.equal(m.schemaVersion, 3);
  assert.equal(m.name, 'human-content');
  assert.equal(m.skills, './skills');
  // Portable dependency consumers require this declaration in the built bundle.
  assert.equal(typeof m.distributions?.agentSkills?.skills, 'string');
  const portableRoot = path.resolve(manifestRoot, m.distributions.agentSkills.skills);
  assert.ok(portableRoot.startsWith(`${manifestRoot}${path.sep}`));
  for (const relative of ['SKILL.md', 'README.md', 'references/faithful-presentation.md']) {
    await access(path.join(portableRoot, 'explain-for-review', relative));
  }
  assert.deepEqual(m.interface.capabilities, ['Skills']);
  const names = await readdir(skillsRoot);
  assert.ok(names.includes('explain-for-review'));
  for (const name of names) {
    const root = path.join(skillsRoot, name);
    const text = await readFile(path.join(root, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(text, /^description: .+/m);
    for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(target)) continue;
      const resolved = path.resolve(root, target.split('#')[0]);
      assert.ok(resolved.startsWith(`${root}${path.sep}`));
      await access(resolved);
    }
    const metadata = await readFile(path.join(root, 'agents/openai.yaml'), 'utf8');
    assert.match(metadata, /allow_implicit_invocation: true/);
  }
});
