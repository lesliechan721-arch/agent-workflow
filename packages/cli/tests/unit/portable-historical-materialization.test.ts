import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, computeSkillDigest } from '@lesliechan721/agent-skill-eval';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializePortableSkills } from '../../src/portable/materializer.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { writeAwSourceBinding } from '../../src/review/source-binding.js';
import { portableJsonDigest, portableSkillTreeDigest, readHistoricalPortableMaterialization } from '../../src/portable/historical-materialization.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });
async function fixture(scope: 'project' | 'user' = 'project', completeTree = false) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-history-'));
  roots.push(projectRoot);
  const digest = portableJsonDigest('source');
  const sourceRoot = path.join(projectRoot, 'source');
  const base = { schemaVersion: 4, version: '1.0.0', description: 'Historical export fixture.', platforms: ['generic'],
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } } };
  for (const name of ['root', 'dependency']) {
    const pluginRoot = path.join(sourceRoot, name);
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      ...base, name, ...(name === 'root' ? { dependencies: ['dependency'] } : { skills: './skills' }),
    });
  }
  const sourceSkill = path.join(sourceRoot, 'dependency', 'skills', 'alpha');
  await fs.outputFile(path.join(sourceSkill, 'SKILL.md'), '---\nname: alpha\ndescription: test\n---\nFrozen content\n');
  await fs.outputFile(path.join(sourceSkill, 'README.md'), '# Alpha\n');
  await fs.outputFile(path.join(sourceSkill, '.hidden'), 'must be preserved');
  const plugins = await Promise.all(['root', 'dependency'].map(async (name) => Object.assign(
    await readPluginManifest(path.join(sourceRoot, name)),
    { sourceId: 'team', sourceIdentity: digest, pluginId: `team/${name}` },
  )));
  const exported = await materializePortableSkills({ plugins, pluginId: 'team/root', platform: 'generic', scope, cwd: projectRoot,
    env: { ...process.env, AW_HOME: path.join(projectRoot, 'aw-home') } });
  const generationRoot = scope === 'project'
    ? path.join(projectRoot, '.agent-workflows', '.local', 'portable')
    : path.join(projectRoot, 'portable', 'user');
  const rootDir = path.join(generationRoot, 'root', 'frozen-generation');
  const skill = path.join(rootDir, 'skills', 'alpha');
  try {
    await fs.copy(path.join(exported.rootDir, 'skills'), path.join(rootDir, 'skills'));
    if (completeTree) {
      for (const file of ['evals/cases.json', 'reports/report.json', '.git/config', 'nested/node_modules/example.txt', 'nested/.DS_Store', 'nested/reports/keep.md']) {
        await fs.outputFile(path.join(skill, file), file);
      }
    }
    await writeAwSourceBinding({ rootDir, source: { kind: 'catalog-snapshot', sourceId: 'team', catalogSourceIdentity: digest,
      logicalIdentity: 'test-catalog', snapshotDigest: digest, workspaceIdentity: 'test-workspace', workspaceSourceIdentity: digest },
      subject: { plugin: 'root' }, profile: { kind: 'portable', id: `generic-${scope}`, platform: 'generic', scope, inputDigest: exported.configDigest },
      preparation: exported.preparation,
      artifacts: [{ kind: 'portable-skill', plugin: 'dependency', skill: 'alpha', path: 'skills/alpha' }] });
    const selectedSkills = [{ name: 'alpha', providerPluginId: 'team/dependency', filesDigest: await portableSkillTreeDigest(skill) }];
    const outputDigest = portableJsonDigest(selectedSkills.map((entry) => [entry.name, entry.filesDigest]));
    await fs.writeJson(path.join(rootDir, '.aw-materialization.json'), { schemaVersion: 1, receiptSchemaVersion: 5,
      command: 'skill:materialize', platform: 'generic', plugin: { id: 'team/root', sourceId: 'team', sourceIdentity: digest }, scope,
      selectedSkills, config: { pluginConfigDigest: exported.configDigest }, outputDigest,
      materializationDigest: portableJsonDigest({ platform: 'generic', scope, skills: selectedSkills.map((entry) => [entry.name, entry.filesDigest]) }) });
  } finally { await exported.cleanup(); }
  await fs.remove(sourceRoot);
  return { generationRoot, scope, rootDir, pluginId: 'team/root', logicalIdentity: 'test-catalog', platform: 'generic' as const, skill };
}
describe('historical portable generation integrity', () => {
  it('verifies a complete frozen generation without current or historical snapshot', async () => {
    const options = await fixture();
    expect((await readHistoricalPortableMaterialization(options)).marker.selectedSkills[0]?.providerPluginId).toBe('team/dependency');
    expect(await fs.readFile(path.join(options.skill, '.hidden'), 'utf8')).toBe('must be preserved');
  });
  // Protect the hot recovery path against a second physical read for the
  // same evidence while retaining both independent persisted digest contracts.
  it('reads regular historical files once while preserving both digests', async () => {
    const options = await fixture('project', true);
    const readPaths = async (directory: string, prefix = ''): Promise<Array<[string, Buffer]>> => {
      const files: Array<[string, Buffer]> = [];
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await readPaths(absolutePath, relativePath));
        else files.push([relativePath, await fs.readFile(absolutePath)]);
      }
      return files;
    };
    const files = await readPaths(options.skill);
    const hash = createHash('sha256');
    for (const [file, bytes] of files.sort(([left], [right]) => left.localeCompare(right))) {
      hash.update(file).update('\0').update(bytes).update('\0');
    }
    const expectedFilesDigest = `sha256:${hash.digest('hex')}`;
    const expectedProductionDigest = await computeSkillDigest(options.skill);
    const canonicalSkill = await fs.realpath(options.skill);
    const reads = vi.spyOn(fs, 'readFile');
    const promiseReads = vi.spyOn(fsPromises, 'readFile');
    syncBuiltinESMExports();
    try {
      const historical = await readHistoricalPortableMaterialization(options);
      expect(historical.marker.selectedSkills[0]?.filesDigest).toBe(expectedFilesDigest);
      expect(historical.binding.artifacts[0]?.digest).toBe(expectedProductionDigest);
      const tree = historical.validateSkillDirectory('alpha');
      expect(tree.files['SKILL.md']).toEqual(files.find(([name]) => name === 'SKILL.md')?.[1]);
      expect(tree.files['nested/reports/keep.md']).toEqual(Buffer.from('nested/reports/keep.md'));
      expect(tree.files['evals/cases.json']).toBeUndefined();
      expect(tree.files['reports/report.json']).toBeUndefined();
      for (const [relativePath] of files) {
        const filename = path.join(canonicalSkill, relativePath);
        expect([...reads.mock.calls, ...promiseReads.mock.calls].filter(([file]) => String(file) === filename)).toHaveLength(1);
      }
    } finally { reads.mockRestore(); promiseReads.mockRestore(); syncBuiltinESMExports(); }
  });
  it('keeps reserved marker directories forbidden after successful historical digest validation', async () => {
    const options = await fixture();
    await fs.ensureDir(path.join(options.skill, '.agent-workflows-owner.json'));
    // Empty directories are not part of either persisted hash; the separate
    // portable validator must still reject this reserved node.
    const historical = await readHistoricalPortableMaterialization(options);
    expect(() => historical.validateSkillDirectory('alpha')).toThrow(/保留文件 .agent-workflows-owner.json/u);
  });
  it.skipIf(process.platform === 'win32')('rejects mode-only drift despite unchanged Portable files digest', async () => {
    const options = await fixture();
    const before = await portableSkillTreeDigest(options.skill);
    const production = await computeSkillDigest(options.skill);
    const filename = path.join(options.skill, 'README.md');
    await fs.chmod(filename, (await fs.stat(filename)).mode ^ 0o111);
    expect(await portableSkillTreeDigest(options.skill)).toBe(before);
    expect(await computeSkillDigest(options.skill)).not.toBe(production);
    await expect(readHistoricalPortableMaterialization(options)).rejects.toThrow('portableOutputConflict');
  });
  it('rejects modified author-only and ignored files even when production digest is unchanged', async () => {
    const options = await fixture('project', true);
    const production = await computeSkillDigest(options.skill);
    for (const relativePath of ['evals/cases.json', 'reports/report.json', '.git/config', 'nested/node_modules/example.txt', 'nested/.DS_Store']) {
      const file = path.join(options.skill, relativePath);
      await fs.writeFile(file, 'modified');
      expect(await computeSkillDigest(options.skill)).toBe(production);
      await expect(readHistoricalPortableMaterialization(options)).rejects.toThrow('portableOutputConflict');
      await fs.writeFile(file, relativePath);
    }
    expect(await readHistoricalPortableMaterialization(options)).toMatchObject({ marker: { scope: 'project' } });
  });
  it('binds historical content to its own platform, source, scope and generation root', async () => {
    const user = await fixture('user');
    await expect(readHistoricalPortableMaterialization({ ...user, platform: 'cursor' })).rejects.toThrow();
    await expect(readHistoricalPortableMaterialization({ ...user, logicalIdentity: 'replacement-catalog' })).rejects.toThrow();
    await expect(readHistoricalPortableMaterialization({ ...user, pluginId: 'foreign/root' })).rejects.toThrow();
    expect((await readHistoricalPortableMaterialization(user)).marker.scope).toBe('user');
    await expect(readHistoricalPortableMaterialization({ ...user, scope: 'project' })).rejects.toThrow();
    const project = await fixture('project');
    await expect(readHistoricalPortableMaterialization({ ...project, generationRoot: user.generationRoot })).rejects.toThrow();
  });
  it('rejects an old concrete-platform binding without preparation evidence and keeps it unchanged', async () => {
    const options = await fixture();
    const bindingPath = path.join(options.rootDir, 'aw-source-binding.json');
    const { preparation: _preparation, finalDigest: _digest, ...legacy } = await fs.readJson(bindingPath);
    legacy.profile = { ...legacy.profile, id: 'cursor-project', platform: 'cursor' };
    await fs.writeJson(bindingPath, { ...legacy, finalDigest: `sha256:${createHash('sha256').update(canonicalJson(legacy)).digest('hex')}` });
    const markerPath = path.join(options.rootDir, '.aw-materialization.json');
    const marker = await fs.readJson(markerPath);
    marker.platform = 'cursor';
    marker.materializationDigest = portableJsonDigest({ platform: 'cursor', scope: options.scope,
      skills: marker.selectedSkills.map((entry: { name: string; filesDigest: string }) => [entry.name, entry.filesDigest]) });
    await fs.writeJson(markerPath, marker);
    const before = await fs.readFile(bindingPath);
    await expect(readHistoricalPortableMaterialization({ ...options, platform: 'cursor' })).rejects.toThrow(/prepare again in a new directory/u);
    expect(await fs.readFile(bindingPath)).toEqual(before);
    expect(await fs.readJson(markerPath)).toEqual(marker);
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
