import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { setTargets } from '../../src/intent/deployment-preferences.js';
import type { CommandResult } from '../../src/output/public-result.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { artifactValueDigest } from '../../src/utils/artifact-plan.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: native delivery, status and no-op sync agree with the actual
// recipient files, including dynamically prepared agents and scope exclusions.
it.each([
  { target: 'copilot', scope: 'user', includesMain: false, hasRole: true, dynamicRules: false },
  { target: 'copilot', scope: 'user', includesMain: true, hasRole: false, dynamicRules: false },
  { target: 'grok', scope: 'project', includesMain: true, hasRole: true, dynamicRules: false },
  { target: 'grok', scope: 'project', includesMain: true, hasRole: false, dynamicRules: false },
  { target: 'grok', scope: 'user', includesMain: true, hasRole: false, dynamicRules: true },
  { target: 'grok', scope: 'project', includesMain: true, hasRole: false, dynamicRules: true },
  { target: 'grok', scope: 'project', includesMain: true, hasRole: true, dynamicRules: true },
] as const)('projects $target $scope instructions with main=$includesMain, role=$hasRole, and dynamic rules=$dynamicRules', async ({ target, scope, includesMain, hasRole, dynamicRules }) => {
  installNativeTestQualification({ platforms: [target], discovery: true, executable: process.execPath });
  const { env, layout } = getCurrentSourceTestIsolation();
  const cwd = layout.fixtureCwd;
  const source = path.join(cwd, 'catalog');
  const host = resolvePlatformConfigRoot(target, { cwd, env });
  const trace = path.join(cwd, 'renderer-calls');
  const instruction = 'Keep the input unchanged.';
  const prompt = 'Review the input for correctness.';
  const runsRenderer = hasRole || dynamicRules;
  const mixed = dynamicRules && hasRole;
  const ruleNames = dynamicRules ? scope === 'project' ? ['preserve', 'read-only'] : ['preserve'] : [];
  const components = [
    ...ruleNames.map((name) => ({ id: `renderer-${name}`, name, kind: 'instruction',
      content: { title: 'Preserve input', content: instruction, coverage: ['main'] } })),
    ...(hasRole && !dynamicRules ? [{ id: 'renderer-reviewer', name: 'reviewer', kind: 'agent', content: { description: 'Review input.', prompt } }] : []),
  ];
  const unrelated = target === 'copilot'
    ? path.join(cwd, '.github', 'agents', 'reviewer.agent.md') : path.join(host, 'agents', 'reviewer.md');
  await fs.ensureDir(path.join(cwd, '.git'));
  await fs.outputFile(unrelated, 'A role from another scope.\n');
  await fs.outputFile(path.join(source, 'plugins/demo/render.mjs'), `
    import fs from 'node:fs';
    const { allowedOutputKinds } = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
    const components = ${JSON.stringify(components)};
    fs.appendFileSync(${JSON.stringify(trace)}, 'render\\n');
    console.log(JSON.stringify({ version: 3, components: components.filter(({ kind }) => allowedOutputKinds.includes(kind)), omitted: [], unmet: [] }));
  `);
  await createCatalogSnapshotFixture(source, 'demo', [], 'Instruction audience fixture.', (manifest) => {
    manifest.platforms = [target];
    if (mixed) manifest.extensions = { agents: [{ name: 'reviewer', description: 'Review input.', prompt }] };
    if (!dynamicRules) manifest.extensions = { instructions: [{ name: 'preserve', title: 'Preserve input', content: instruction,
      coverage: includesMain ? ['main', 'plugin-agents'] : ['plugin-agents'] }] };
    manifest.artifacts = { configKeys: [], scopes: [runsRenderer ? scope : scope === 'user' ? 'project' : 'user'] };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
  });
  const config = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
  await setTargets({ cwd, env, scope: 'user' }, [target]);

  let marketplaceRoot: string | undefined;
  let marketplaceName: string | undefined;
  let registered = false;
  let nativeWrites = 0;
  let grokInventory: 'empty' | 'unreadable' | 'foreign' = 'empty';
  const grokPackage = path.join(cwd, '.grok/plugins/aw-local-demo');
  const foreignSource = path.join(cwd, 'foreign-plugin-source');
  const foreignRoot = path.join(host, 'installed-plugins/foreign-root');
  const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
    let stdout = '';
    if (target === 'grok') {
      if (args.join(' ') === 'plugin list --json') {
        stdout = grokInventory === 'unreadable' ? '{broken' : JSON.stringify(grokInventory === 'foreign' ? [{
          name: 'demo', status: 'installed', repo_key: 'foreign-root', version: '1.0.0', path: foreignRoot, source: foreignSource,
        }] : []);
      } else if (args[0] === 'inspect') {
        const reportedPath = process.platform === 'win32' ? grokPackage.replace('\\plugins\\', '/plugins\\') : grokPackage;
        const activeRoot = grokInventory === 'foreign' ? foreignRoot : await fs.pathExists(grokPackage) ? reportedPath : undefined;
        stdout = JSON.stringify({ grokVersion: '1.0.77', projectTrusted: true, skills: [], agents: [], mcpServers: [],
          plugins: activeRoot ? [{ name: 'demo', scope, path: activeRoot, enabled: true }] : [] });
      } else throw new Error(`Unexpected Grok request ${args.join(' ')}`);
    } else if (args.join(' ') === 'plugin marketplace list --json') {
      stdout = JSON.stringify(marketplaceRoot ? [{ name: marketplaceName, source: marketplaceRoot }] : []);
    } else if (args.join(' ') === 'plugin list --json') {
      const settings = await fs.readJson(path.join(host, 'settings.json')).catch(() => ({}));
      stdout = JSON.stringify(registered ? [{ name: 'demo', marketplace: marketplaceName, source: marketplaceRoot,
        enabled: settings.enabledPlugins?.[`demo@${marketplaceName}`] === true }] : []);
    } else if (args.slice(0, 3).join(' ') === 'plugin marketplace add') {
      marketplaceRoot = args[3]!;
      marketplaceName = (await fs.readJson(path.join(marketplaceRoot, '.github', 'plugin', 'marketplace.json'))).name;
      nativeWrites++;
    } else if (args.slice(0, 2).join(' ') === 'plugin install') {
      expect(args[2]).toBe(`demo@${marketplaceName}`);
      registered = true;
      nativeWrites++;
    } else throw new Error(`Unexpected Copilot request ${args.join(' ')}`);
    return { exitCode: 0, stdout, stderr: '' };
  };
  const invoke = (...args: string[]) => runCliEntry(['plugin', ...args, '--context', scope, '--json'],
    { cwd, env, nativeCliRunner, interactive: false });
  const aw = async (...args: string[]) => {
    const result = await invoke(...args);
    const value = result.parseJsonStdout<CommandResult>();
    expect(result.exitCode, JSON.stringify(value)).toBe(0);
    return value;
  };
  const componentIds = [...components.map(({ id }) => id), ...(mixed ? ['agent:reviewer'] : !dynamicRules ? ['instruction:preserve'] : [])];
  const expected = {
    target, scope, content: 'satisfied', satisfaction: 'installed', installedComponentCount: componentIds.length,
    installedComponentIds: expect.arrayContaining(componentIds),
    ...(runsRenderer ? {} : { componentGaps: [expect.objectContaining({ componentId: 'instruction:preserve', kind: 'instruction',
      requiredFeatures: [{ feature: 'instruction.coverage', values: ['plugin-agents'] }] })] }),
  };
  const install = await aw('install', 'local/demo', '--scope', scope, '--yes');
  expect(install.status).toBe('success');
  expect(install.data, JSON.stringify(install)).toMatchObject({ remainingTargets: [], targetResults: [expected] });
  const packageRoot = target === 'copilot' ? path.join(marketplaceRoot!, 'plugins', 'demo') : grokPackage;
  const roleFile = target === 'copilot' ? path.join(packageRoot, 'com.github.copilot', 'agents', 'reviewer.agent.md')
    : path.join(packageRoot, 'agents', 'reviewer.md');
  const grokRules = scope === 'user' ? path.join(host, 'rules') : path.join(cwd, '.grok/rules');
  const mainFile = target === 'copilot' ? path.join(packageRoot, 'com.github.copilot/rules/preserve.md')
    : path.join(grokRules, 'aw-local-demo-preserve.md');
  if (hasRole) {
    const body = await fs.readFile(roleFile, 'utf8');
    expect(body).toContain(dynamicRules ? `${prompt}\n` : `${prompt}\n\n${instruction}\n`);
  } else expect(await fs.pathExists(roleFile)).toBe(false);
  if (includesMain) expect(await fs.readFile(mainFile, 'utf8')).toContain(instruction);
  else expect(await fs.pathExists(mainFile)).toBe(false);
  if (dynamicRules && !hasRole) expect(await fs.pathExists(packageRoot)).toBe(false);

  const rendered = runsRenderer ? await fs.readFile(trace, 'utf8') : null;
  const writes = nativeWrites;
  const projectedFiles = [...(hasRole ? [roleFile] : []), ...(includesMain ? [mainFile] : []),
    ...ruleNames.slice(1).map((name) => path.join(grokRules, `aw-local-demo-${name}.md`))];
  const readFiles = () => Promise.all(projectedFiles.map(async (file) => ({ contents: await fs.readFile(file, 'utf8'), mtime: (await fs.stat(file)).mtimeMs })));
  const projected = await readFiles();
  const status = await aw('status');
  expect(status.data, JSON.stringify(status)).toMatchObject({ counts: { pending: 0, unconfirmed: 0 }, inSync: true, allSatisfied: true,
    inventory: [{ targetResults: [expected] }] });
  if (runsRenderer) {
    expect(status.data).not.toMatchObject({ inventory: [{ targetResults: [{ componentGaps: expect.any(Array) }] }] });
    expect(await fs.readFile(trace, 'utf8')).toBe(rendered);
  } else expect(await fs.pathExists(trace)).toBe(false);

  const sync = await aw('sync', 'local/demo', '--yes');
  expect(sync.status).toBe('success');
  expect(sync.data, JSON.stringify(sync)).toMatchObject({ remainingTargets: [], changes: { outputs: 'none' }, targetResults: [expected] });
  expect(nativeWrites).toBe(writes);
  expect(await readFiles()).toEqual(projected);
  expect(await fs.readFile(unrelated, 'utf8')).toBe('A role from another scope.\n');

  let supplementRecord: string | undefined;
  if (dynamicRules && !hasRole) {
    const records = path.join(env.AW_HOME!, 'platforms', target, 'empty-state');
    const [recordName] = await fs.readdir(records);
    const record = path.join(records, recordName!);
    const evidence = await fs.readFile(record);
    await fs.remove(record);
    const unconfirmed = await invoke('status');
    expect(unconfirmed.exitCode).toBe(3);
    expect(unconfirmed.parseJsonStdout<CommandResult>().data).toMatchObject({ counts: { unconfirmed: 1 }, inSync: null, allSatisfied: null,
      inventory: [{ targetResults: [{ content: 'unknown' }] }] });
    await fs.writeFile(record, evidence);
    if (scope === 'user') {
      grokInventory = 'unreadable';
      const unreadable = (await invoke('status')).parseJsonStdout<CommandResult>();
      expect(unreadable.data).toMatchObject({ inSync: null, allSatisfied: null, inventory: [{ targetResults: [{ content: 'unknown',
        blockerCodes: ['nativeObservationFailed'], deploymentObservations: [{ after: { registration: 'unknown' } }] }] }] });
      grokInventory = 'foreign';
      const foreignFile = path.join(foreignRoot, 'foreign.txt');
      await fs.outputFile(foreignFile, 'Foreign installation.\n');
      const foreign = (await invoke('status')).parseJsonStdout<CommandResult>();
      expect(foreign.data).toMatchObject({ inSync: false, allSatisfied: false, inventory: [{ targetResults: [{ content: 'conflict',
        blockerCodes: ['deploymentOwnershipConflict'], deploymentObservations: [{ after: { registration: 'present', ownership: 'foreign' } }] }] }] });
      expect(await fs.readFile(foreignFile, 'utf8')).toBe('Foreign installation.\n');
      expect(await readFiles()).toEqual(projected);
      grokInventory = 'empty';
    } else {
      supplementRecord = path.join(env.AW_HOME!, 'platforms', target, 'supplements', recordName!);
      const complete = await fs.readJson(supplementRecord);
      const { bindingId, inputDigest, outputs: legacyOutputs } = complete;
      await fs.writeJson(supplementRecord, { schemaVersion: 1, bindingId, inputDigest, outputs: legacyOutputs });
      expect((await aw('status')).data).toMatchObject({ inSync: true, allSatisfied: true, inventory: [{ targetResults: [expected] }] });
      for (const outputs of [[], complete.outputs.filter(({ id }: { id: string }) => id === 'renderer-read-only')]) {
        await fs.writeJson(supplementRecord, { ...complete, outputs });
        const damaged = await invoke('status');
        expect(damaged.exitCode).toBe(3);
        expect(damaged.parseJsonStdout<CommandResult>().data).toMatchObject({ inSync: null, allSatisfied: null,
          inventory: [{ targetResults: [{ content: 'unknown' }] }] });
      }
      const repaired = await aw('sync', 'local/demo', '--yes');
      expect(repaired.data).toMatchObject({ changes: { outputs: 'none' }, remainingTargets: [], targetResults: [expected] });
      expect((await aw('status')).data).toMatchObject({ inSync: true, allSatisfied: true, inventory: [{ targetResults: [expected] }] });
      const oldProof = JSON.parse(evidence.toString('utf8'));
      delete oldProof.deliveryDigest;
      delete oldProof.installedComponentIds;
      await fs.writeJson(record, { ...oldProof, deliveryDigest: artifactValueDigest(oldProof) });
      const oldStatus = (await invoke('status')).parseJsonStdout<CommandResult>();
      expect(oldStatus.data).toMatchObject({ inSync: null, allSatisfied: null, inventory: [{ targetResults: [{ content: 'unknown' }] }] });
      expect((await aw('sync', 'local/demo', '--yes')).data).toMatchObject({ changes: { outputs: 'none' }, remainingTargets: [], targetResults: [expected] });
      expect((await aw('status')).data).toMatchObject({ inSync: true, allSatisfied: true });
      expect(await readFiles()).toEqual(projected);
    }
  }
  if (mixed) {
    const records = path.join(env.AW_HOME!, 'platforms', target, 'supplements');
    const [recordName] = await fs.readdir(records);
    supplementRecord = path.join(records, recordName!);
    const complete = await fs.readJson(supplementRecord);
    await fs.writeJson(supplementRecord, { ...complete, outputs: complete.outputs.filter(({ id }: { id: string }) => id !== 'renderer-preserve') });
    await fs.remove(mainFile);
    const beforeStatus = await fs.readFile(trace, 'utf8');
    const damaged = await invoke('status');
    expect(damaged.exitCode).toBe(3);
    expect(damaged.parseJsonStdout<CommandResult>().data).toMatchObject({ counts: { unconfirmed: 1 }, inSync: null, allSatisfied: null,
      inventory: [{ targetResults: [{ content: 'unknown', installedComponentIds: ['agent:reviewer'],
        deploymentObservations: [{ after: { package: 'present' } }] }] }] });
    expect(await fs.readFile(trace, 'utf8')).toBe(beforeStatus);
    const repaired = await aw('sync', 'local/demo', '--yes');
    expect(repaired.data).toMatchObject({ changes: { outputs: 'changed' }, remainingTargets: [], targetResults: [expected] });
    expect(await fs.readFile(mainFile, 'utf8')).toContain(instruction);
    expect((await aw('status')).data).toMatchObject({ inSync: true, allSatisfied: true, inventory: [{ targetResults: [expected] }] });
  }
  if (runsRenderer) {
    const lostFile = dynamicRules ? mainFile : roleFile;
    await fs.remove(lostFile);
    const afterLoss = await aw('status');
    expect(afterLoss.data, JSON.stringify(afterLoss)).toMatchObject({ counts: { pending: 1 }, inSync: false, allSatisfied: false,
      inventory: [{ targetResults: [{ content: 'absent' }] }] });
    expect(afterLoss.data).not.toMatchObject({ inventory: [{ targetResults: [{ componentGaps: expect.any(Array) }] }] });
    if (dynamicRules) {
      await fs.outputFile(lostFile, 'Foreign rule.\n');
      const foreign = await invoke('status');
      expect(foreign.parseJsonStdout<CommandResult>().data).toMatchObject({ counts: { blocked: 1 }, inSync: false, allSatisfied: false,
        inventory: [{ targetResults: [{ content: 'conflict' }] }] });
      if (supplementRecord) {
        const complete = await fs.readJson(supplementRecord);
        await fs.writeJson(supplementRecord, { ...complete, outputs: [] });
        const unconfirmedForeign = await invoke('status');
        expect(unconfirmedForeign.parseJsonStdout<CommandResult>().data).toMatchObject({ inSync: null, allSatisfied: null });
        const failedRepair = (await invoke('sync', 'local/demo', '--yes')).parseJsonStdout<CommandResult>();
        expect(failedRepair.status).not.toBe('success');
        expect(failedRepair.data).toMatchObject({ remainingTargets: [{ pluginId: 'local/demo', target, scope }] });
        expect(await fs.readFile(lostFile, 'utf8')).toBe('Foreign rule.\n');
      }
    }
  }
});
