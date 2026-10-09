import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { SKILL_CONFIG_KEYS, renderArtifactPlan } from './render-artifacts.mjs';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const ids = ['codex-explore-skill', 'codex-explore-role', 'codex-subagent-guide-skill',
  'codex-subagent-role', 'codex-advisor-skill', 'codex-advisor-role'];
const skillIds = ids.filter((id) => id.endsWith('-skill'));
function sourceRoot(id) {
  const staged = path.join(root, '.agents-plugin/artifact-sources/codex', id, '0');
  return existsSync(staged) ? staged : path.join(root, 'skills', id.replace(/-skill$/, ''));
}

function context(values = {}) {
  return {
    platform: 'codex', scope: 'user', requestedArtifactIds: ids,
    artifactSources: skillIds.map((id) => ({ id, target: 'codex.skill', sourceDirs: [sourceRoot(id)] })),
    config: { values },
  };
}

function artifact(plan, id) {
  const found = plan.artifacts.find((item) => item.id === id);
  assert.ok(found, `Missing artifact ${id}`);
  return found;
}

// Test Value Gate: the real process entry verifies structured artifact delivery and
// complete default instruction transport to the native developer channel.
test('real renderer keeps shared instructions and adds local rules only to native specialist roles', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-enhance-render-'));
  try {
    const input = path.join(temporary, 'context.json');
    await writeFile(input, JSON.stringify(context()));
    const { stdout, stderr } = await execFileAsync(process.execPath,
      [path.join(root, 'scripts/render-artifacts.mjs')], {
        env: { ...process.env, AW_PLUGIN_CONTEXT: input }, cwd: temporary,
      });
    assert.equal(stderr, '');
    const plan = JSON.parse(stdout);
    assert.equal(plan.version, 2);
    assert.deepEqual(plan.artifacts.map((item) => item.id), ids);
    for (const [skillId, roleId, roleKey, file] of [
      ['codex-subagent-guide-skill', 'codex-subagent-role', 'codex-subagent', 'assets/task-instructions.md'],
      ['codex-advisor-skill', 'codex-advisor-role', 'codex-advisor', 'assets/advisor-instructions.md'],
      ['codex-explore-skill', 'codex-explore-role', 'codex-explore', 'assets/explore-instructions.md'],
    ]) {
      const canonical = await readFile(path.join(sourceRoot(skillId), file), 'utf8');
      const role = artifact(plan, roleId);
      assert.equal(role.roleKey, roleKey);
      assert.equal(role.content.roleFile.name, roleKey);
      const delivered = role.content.roleFile.developer_instructions;
      if (roleKey === 'codex-subagent') {
        assert.equal(delivered, canonical);
      } else {
        const prefix = `${canonical.trimEnd()}\n\n`;
        assert.equal(delivered.startsWith(prefix), true);
        const local = delivered.slice(prefix.length);
        // The Codex developer channel consumes this local prohibition. These
        // checks protect its scope; they do not prove model compliance.
        assert.equal(local.split(roleKey).length - 1, 1);
        assert.match(local, new RegExp(`不要通过 ${roleKey} 将同一`));
        for (const other of ['codex-advisor', 'codex-explore'].filter((key) => key !== roleKey)) {
          assert.equal(local.includes(other), false);
        }
      }
      assert.equal(role.content.registration.description, role.content.roleFile.description);
      assert.doesNotMatch(role.content.roleFile.description, /再次委派|不再委派/);
      assert.equal(artifact(plan, skillId).content.files[file], canonical);
      assert.equal(Object.hasOwn(role.content.roleFile, 'model'), false);
      assert.equal(Object.hasOwn(role.content.roleFile, 'model_reasoning_effort'), false);
      assert.deepEqual(role.refreshKeys, []);
    }
    for (const id of skillIds) {
      const skill = artifact(plan, id);
      assert.deepEqual(skill.refreshKeys, SKILL_CONFIG_KEYS[skill.skillKey]);
      assert.equal(Object.hasOwn(skill.content.files, 'runtime/worker-bindings.json'), false);
      assert.equal(Object.hasOwn(skill.content.files, '.aw-runtime-config.json'), false);
      assert.equal(Object.hasOwn(skill.content.files, 'scripts/aw-runtime-config.mjs'), false);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// Test Value Gate: a narrow request cannot read another consumer's configuration;
// role-only requests work without any config and without execution-revision input.
test('requested subsets are exact and each consumer reads only its declared configuration', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
  for (const id of ids) {
    const input = { ...context(), requestedArtifactIds: [id] };
    Object.defineProperty(input, 'runtimeConfig', { get() { throw new Error('read execution revision'); } });
    if (id.endsWith('-role')) {
      Object.defineProperty(input, 'config', { get() { throw new Error('role-only read config'); } });
    } else {
      const key = id.replace(/-skill$/, '');
      for (const otherKey of ['simpleTaskProfile', 'advisorProfile', 'quickProfile']) {
        if (!SKILL_CONFIG_KEYS[key].includes(otherKey)) {
          Object.defineProperty(input.config.values, otherKey, { get() { throw new Error(`read ${otherKey}`); } });
        }
      }
    }
    const plan = await renderArtifactPlan(input);
    assert.deepEqual(plan.artifacts.map((item) => item.id), [id]);
    if (id.endsWith('-role')) {
      const sourceInput = { ...context(), requestedArtifactIds: [id], artifactSources: undefined };
      Object.defineProperty(sourceInput, 'config', { get() { throw new Error('source role-only read config'); } });
      const skillKey = id === 'codex-subagent-role' ? 'codex-subagent-guide' : id.replace(/-role$/, '');
      const declaredSources = manifest.artifacts.targets.find((target) => target.skillKey === skillKey).sourceDirs;
      if (declaredSources.some((source) => existsSync(path.resolve(root, source, 'SKILL.md')))) {
        assert.deepEqual(await renderArtifactPlan(sourceInput), plan);
      } else {
        await assert.rejects(renderArtifactPlan(sourceInput), { code: 'ENOENT' });
      }
    }
  }
  const reversed = [...ids].reverse();
  assert.deepEqual((await renderArtifactPlan({ ...context(), requestedArtifactIds: reversed }))
    .artifacts.map((item) => item.id), reversed);
});
