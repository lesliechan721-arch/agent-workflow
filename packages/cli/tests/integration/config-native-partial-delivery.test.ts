import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { replaceCatalogSourcesConfig } from '../helpers/write-command-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function installFixture(initialMode: 'initial' | 'role-only') {
  installNativeTestQualification({ platforms: ['codex'], discovery: true });
  const isolation = getCurrentSourceTestIsolation();
  const { env, layout: { fixtureCwd: cwd } } = isolation;
  const source = path.join(cwd, 'native-config-source');
  const codex = await createCodexNativeTestRuntime(isolation);
  await fs.outputFile(path.join(source, 'plugins/demo/render.mjs'), `import fs from 'node:fs';
const { allowedOutputKinds, config: { values: { mode } } } = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
const components = [];
const unmet = [];
if (allowedOutputKinds.includes('agent')) {
  components.push({ id: 'role', kind: 'agent', name: 'demo-agent',
    content: { description: 'Review role.', prompt: mode === 'update-role' ? 'Check with new settings.' : 'Check with original settings.' } });
}
if (allowedOutputKinds.includes('skill')) {
  if (mode === 'initial' || mode === 'add-skill') {
    const name = mode === 'initial' ? 'check' : 'added';
    components.push({ id: name, kind: 'skill', name, content: { files: {
      'SKILL.md': { text: '---\\nname: ' + name + '\\ndescription: Fixture skill.\\n---\\nCheck content.\\n' },
      'README.md': { text: 'Fixture skill.\\n' }
    } } });
  }
  if (mode !== 'initial' && mode !== 'role-only') {
    unmet.push({ id: 'check', kind: 'skill', name: 'check', reasonCode: 'dependency-unmet', requiredFeatures: [] });
  }
}
console.log(JSON.stringify({ version: 3, components, omitted: [], unmet }));
`);
  await createCatalogSnapshotFixture(source, 'demo', [], 'Fixture plugin.\n', (manifest) => {
    manifest.platforms = ['codex'];
    delete manifest.extensions;
    if (initialMode === 'role-only') {
      manifest.extensions = { agents: [{ name: 'baseline', description: 'Known role.', prompt: 'Verify.' }] };
    }
    manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: initialMode } } };
    manifest.artifacts = { configKeys: ['mode'] };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
  });
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'team', type: 'path', primary: true, path: source }] },
  expectedDigest: (await readCatalogSourcesConfigSnapshot(env)).digest, env });

  const run = (args: string[]) => runCliEntry([...args, '--json'], {
    cwd, env, interactive: false, nativeCliRunner: codex.nativeCliRunner,
  });
  expect(await run(['target', 'set', 'codex'])).toMatchObject({ exitCode: 0 });
  expect(await run(['plugin', 'install', 'team/demo', '--scope', 'user', '--context', 'user', '--target', 'codex', '--yes']))
    .toMatchObject({ exitCode: 0 });
  const roleFile = path.join(env.CODEX_HOME!, 'agents', 'aw-team-demo-demo-agent.toml');
  const initialRole = await fs.readFile(roleFile, 'utf8');
  expect(initialRole).toContain('Check with original settings.');

  const apply = async (mode: string) => {
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'mode', '--context', 'user',
      '--value-json', JSON.stringify(mode), '--platform', 'codex'])).toMatchObject({ exitCode: 0 });
    const result = await run(['plugin', 'config', 'apply', 'team/demo', '--context', 'user', '--target', 'codex', '--yes']);
    expect(result.exitCode, result.stdout).toBe(4);
    expect(result.stderr).toContain('platformComponentsUnmet');
    const receipt = result.parseJsonStdout<{
      data: { apply: { targetResults: Array<{ partialDelivery?: true }> } };
      diagnostics: Array<{ code: string }>;
      nextActions: unknown[];
    }>();
    expect(receipt).toMatchObject({ schemaVersion: 2, command: 'plugin.config.apply', status: 'partial',
      data: { configWrite: 'notStarted', apply: { state: 'partial', targetResults: [{
        target: { pluginId: 'team/demo', platform: 'codex', scope: 'user' },
        state: 'failed', errorCode: 'platformComponentsUnmet',
      }] } } });
    expect(receipt.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'skillInvocationPolicyNotGuaranteed' }));
    return receipt;
  };

  return { apply, codex, env, roleFile, initialRole };
}

it('reports verified native role delivery during a partial config apply', async () => {
  const { apply, codex, roleFile, initialRole } = await installFixture('initial');
  const [packageRoot] = codex.packageRoots.values();
  const skillFile = path.join(packageRoot!, 'skills/check/SKILL.md');
  const initialSkill = await fs.readFile(skillFile);
  const retained = await apply('retain-only');
  expect(await fs.readFile(skillFile)).toEqual(initialSkill);
  expect(await fs.readFile(roleFile, 'utf8')).toBe(initialRole);
  expect(retained.data.apply.targetResults[0]).not.toHaveProperty('partialDelivery');
  expect(retained.nextActions).toMatchObject([{ kind: 'command', argv: ['aw', 'plugin', 'sync', 'team/demo',
    '--context', 'user', '--target', 'codex'] }]);

  const changed = await apply('update-role');
  expect(await fs.readFile(skillFile)).toEqual(initialSkill);
  expect(await fs.readFile(roleFile, 'utf8')).toContain('Check with new settings.');
  expect(changed.data.apply.targetResults[0]).toMatchObject({ partialDelivery: true });
  expect(changed.nextActions).toEqual([{ kind: 'manual', message: expect.stringContaining('team/demo (codex/user)') }]);
}, 30_000);

it('reports newly published native Skill delivery during a partial config apply', async () => {
  const { apply, codex, env, roleFile, initialRole } = await installFixture('role-only');
  expect(codex.packageRoots.size).toBe(0);
  const skillPath = path.join('skills', 'added', 'SKILL.md');
  expect((await fs.readdir(env.AW_HOME!, { recursive: true })).some((file) => file.endsWith(skillPath))).toBe(false);

  const changed = await apply('add-skill');
  const [packageRoot] = codex.packageRoots.values();
  expect(await fs.readFile(path.join(packageRoot!, skillPath), 'utf8')).toContain('Check content.');
  expect(await fs.readFile(roleFile, 'utf8')).toBe(initialRole);
  expect(changed.data.apply.targetResults[0]).toMatchObject({ partialDelivery: true });
  expect(changed.nextActions).toEqual([{ kind: 'manual', message: expect.stringContaining('team/demo (codex/user)') }]);
}, 30_000);
