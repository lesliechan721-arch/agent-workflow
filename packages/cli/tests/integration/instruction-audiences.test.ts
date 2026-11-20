import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { setTargets } from '../../src/intent/deployment-preferences.js';
import type { CommandResult } from '../../src/output/public-result.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
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
  { target: 'copilot', scope: 'user', includesMain: false, hasRole: true },
  { target: 'copilot', scope: 'user', includesMain: true, hasRole: false },
  { target: 'grok', scope: 'project', includesMain: true, hasRole: true },
  { target: 'grok', scope: 'project', includesMain: true, hasRole: false },
] as const)('projects $target instructions with main=$includesMain and a same-scope role=$hasRole', async ({ target, scope, includesMain, hasRole }) => {
  installNativeTestQualification({ platforms: [target], discovery: true, executable: process.execPath });
  const { env, layout } = getCurrentSourceTestIsolation();
  const cwd = layout.fixtureCwd;
  const source = path.join(cwd, 'catalog');
  const host = resolvePlatformConfigRoot(target, { cwd, env });
  const trace = path.join(cwd, 'renderer-calls');
  const instruction = 'Keep the input unchanged.';
  const prompt = 'Review the input for correctness.';
  const unrelated = target === 'copilot'
    ? path.join(cwd, '.github', 'agents', 'reviewer.agent.md') : path.join(host, 'agents', 'reviewer.md');
  await fs.ensureDir(path.join(cwd, '.git'));
  await fs.outputFile(unrelated, 'A role from another scope.\n');
  await fs.outputFile(path.join(source, 'plugins/demo/render.mjs'), `
    import fs from 'node:fs';
    const { allowedOutputKinds } = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
    const role = ${JSON.stringify({ id: 'renderer-reviewer', name: 'reviewer', kind: 'agent', content: { description: 'Review input.', prompt } })};
    fs.appendFileSync(${JSON.stringify(trace)}, 'render\\n');
    console.log(JSON.stringify({ version: 3, components: allowedOutputKinds.includes('agent') ? [role] : [], omitted: [], unmet: [] }));
  `);
  await createCatalogSnapshotFixture(source, 'demo', [], 'Instruction audience fixture.', (manifest) => {
    manifest.platforms = [target];
    manifest.extensions = { instructions: [{ name: 'preserve', title: 'Preserve input', content: instruction,
      coverage: includesMain ? ['main', 'plugin-agents'] : ['plugin-agents'] }] };
    manifest.artifacts = { configKeys: [], scopes: [hasRole ? scope : scope === 'user' ? 'project' : 'user'] };
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
  const grokPackage = path.join(cwd, '.grok', 'plugins', 'aw-local-demo');
  const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
    let stdout = '';
    if (target === 'grok') {
      if (args.join(' ') === 'plugin list --json') stdout = '[]';
      else if (args[0] === 'inspect') {
        const reportedPath = process.platform === 'win32' ? grokPackage.replace('\\plugins\\', '/plugins\\') : grokPackage;
        stdout = JSON.stringify({ grokVersion: '1.0.77', projectTrusted: true, skills: [], agents: [], mcpServers: [],
          plugins: await fs.pathExists(grokPackage) ? [{ name: 'demo', scope, path: reportedPath, enabled: true }] : [] });
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
  const aw = async (...args: string[]) => {
    const result = await runCliEntry(['plugin', ...args, '--context', scope, '--json'], { cwd, env, nativeCliRunner, interactive: false });
    const value = result.parseJsonStdout<CommandResult>();
    expect(result.exitCode, JSON.stringify(value)).toBe(0);
    return value;
  };
  const expected = {
    target, scope, content: 'satisfied', satisfaction: 'installed', installedComponentCount: hasRole ? 2 : 1,
    installedComponentIds: hasRole ? expect.arrayContaining(['renderer-reviewer', 'instruction:preserve']) : ['instruction:preserve'],
    ...(hasRole ? {} : { componentGaps: [expect.objectContaining({ componentId: 'instruction:preserve', kind: 'instruction',
      requiredFeatures: [{ feature: 'instruction.coverage', values: ['plugin-agents'] }] })] }),
  };
  const install = await aw('install', 'local/demo', '--scope', scope, '--yes');
  expect(install.status).toBe('success');
  expect(install.data, JSON.stringify(install)).toMatchObject({ remainingTargets: [], targetResults: [expected] });
  const packageRoot = target === 'copilot' ? path.join(marketplaceRoot!, 'plugins', 'demo') : grokPackage;
  const roleFile = target === 'copilot' ? path.join(packageRoot, 'com.github.copilot', 'agents', 'reviewer.agent.md')
    : path.join(packageRoot, 'agents', 'reviewer.md');
  const mainFile = target === 'copilot' ? path.join(packageRoot, 'com.github.copilot', 'rules', 'preserve.md')
    : path.join(cwd, '.grok', 'rules', 'aw-local-demo-preserve.md');
  if (hasRole) {
    const body = await fs.readFile(roleFile, 'utf8');
    expect(body).toContain(`${prompt}\n\n${instruction}\n`);
  } else expect(await fs.pathExists(roleFile)).toBe(false);
  if (includesMain) expect(await fs.readFile(mainFile, 'utf8')).toContain(instruction);
  else expect(await fs.pathExists(mainFile)).toBe(false);

  const rendered = hasRole ? await fs.readFile(trace, 'utf8') : null;
  const writes = nativeWrites;
  const projectedFiles = [...(hasRole ? [roleFile] : []), ...(includesMain ? [mainFile] : [])];
  const readFiles = () => Promise.all(projectedFiles.map(async (file) => ({ contents: await fs.readFile(file, 'utf8'), mtime: (await fs.stat(file)).mtimeMs })));
  const projected = await readFiles();
  const status = await aw('status');
  expect(status.data, JSON.stringify(status)).toMatchObject({ counts: { pending: 0, unconfirmed: 0 }, inSync: true, allSatisfied: true,
    inventory: [{ targetResults: [expected] }] });
  if (hasRole) {
    expect(status.data).not.toMatchObject({ inventory: [{ targetResults: [{ componentGaps: expect.any(Array) }] }] });
    expect(await fs.readFile(trace, 'utf8')).toBe(rendered);
  } else expect(await fs.pathExists(trace)).toBe(false);

  const sync = await aw('sync', 'local/demo', '--yes');
  expect(sync.status).toBe('success');
  expect(sync.data, JSON.stringify(sync)).toMatchObject({ remainingTargets: [], changes: { outputs: 'none' }, targetResults: [expected] });
  expect(nativeWrites).toBe(writes);
  expect(await readFiles()).toEqual(projected);
  expect(await fs.readFile(unrelated, 'utf8')).toBe('A role from another scope.\n');

  if (hasRole) {
    await fs.remove(roleFile);
    const afterLoss = await aw('status');
    expect(afterLoss.data, JSON.stringify(afterLoss)).toMatchObject({ counts: { pending: 1 }, inSync: false, allSatisfied: false,
      inventory: [{ targetResults: [{ content: 'absent' }] }] });
    expect(afterLoss.data).not.toMatchObject({ inventory: [{ targetResults: [{ componentGaps: expect.any(Array) }] }] });
  }
});
