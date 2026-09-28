import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAwSourceBinding } from '../../src/review/source-binding.js';
import { portableJsonDigest, portableSkillTreeDigest, readHistoricalPortableMaterialization } from '../../src/portable/historical-materialization.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });
async function fixture(scope: 'project' | 'user' = 'project') {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-history-'));
  roots.push(projectRoot);
  const generationRoot = scope === 'project'
    ? path.join(projectRoot, '.agent-workflows', '.local', 'portable')
    : path.join(projectRoot, 'portable', 'user');
  const rootDir = path.join(generationRoot, 'root', 'old-generation');
  const skill = path.join(rootDir, 'skills', 'alpha');
  await fs.outputFile(path.join(skill, 'SKILL.md'), '---\nname: alpha\ndescription: test\n---\nOld content\n');
  await fs.outputFile(path.join(skill, '.hidden'), 'must be preserved');
  const digest = portableJsonDigest('old');
  await writeAwSourceBinding({ rootDir, source: { kind: 'catalog-snapshot', sourceId: 'team', catalogSourceIdentity: digest,
    logicalIdentity: 'test-catalog', snapshotDigest: digest, workspaceIdentity: 'test-workspace', workspaceSourceIdentity: digest },
    subject: { plugin: 'root' }, profile: { kind: 'portable', id: `agent-skills-${scope}`, scope, inputDigest: digest },
    artifacts: [{ kind: 'portable-skill', plugin: 'dependency', skill: 'alpha', path: 'skills/alpha' }] });
  const selectedSkills = [{ name: 'alpha', providerPluginId: 'team/dependency', filesDigest: await portableSkillTreeDigest(skill) }];
  const outputDigest = portableJsonDigest(selectedSkills.map((entry) => [entry.name, entry.filesDigest]));
  await fs.writeJson(path.join(rootDir, '.aw-materialization.json'), { schemaVersion: 1, receiptSchemaVersion: 5,
    command: 'skill:materialize', plugin: { id: 'team/root', sourceId: 'team', sourceIdentity: digest }, scope,
    selectedSkills, config: { pluginConfigDigest: digest }, outputDigest, materializationDigest: outputDigest });
  return { generationRoot, scope, rootDir, pluginId: 'team/root', logicalIdentity: 'test-catalog', skill };
}
describe('historical portable generation integrity', () => {
  it('verifies complete old generation without current or historical snapshot', async () => {
    expect((await readHistoricalPortableMaterialization(await fixture())).marker.selectedSkills[0]?.providerPluginId).toBe('team/dependency');
  });
  it('binds complete historical content to its own scope and generation root', async () => {
    const user = await fixture('user');
    expect((await readHistoricalPortableMaterialization(user)).marker.scope).toBe('user');
    await expect(readHistoricalPortableMaterialization({ ...user, scope: 'project' })).rejects.toThrow();
    const project = await fixture('project');
    await expect(readHistoricalPortableMaterialization({ ...project, generationRoot: user.generationRoot })).rejects.toThrow();
  });
  it.each(['hidden', 'extra', 'owner', 'symlink'])('rejects %s evidence drift without changing bytes', async (change) => {
    const options = await fixture();
    if (change === 'hidden') await fs.writeFile(path.join(options.skill, '.hidden'), 'modified');
    if (change === 'extra') await fs.ensureDir(path.join(options.rootDir, 'skills', 'extra'));
    if (change === 'owner') {
      const filename = path.join(options.rootDir, '.aw-materialization.json');
      const marker = await fs.readJson(filename);
      marker.selectedSkills[0].providerPluginId = 'team/replacement';
      await fs.writeJson(filename, marker);
    }
    if (change === 'symlink') await fs.symlink(options.skill, path.join(options.skill, 'alias'));
    const before = await fs.readFile(path.join(options.rootDir, 'aw-source-binding.json'));
    await expect(readHistoricalPortableMaterialization(options)).rejects.toThrow();
    expect(await fs.readFile(path.join(options.rootDir, 'aw-source-binding.json'))).toEqual(before);
  });
});
