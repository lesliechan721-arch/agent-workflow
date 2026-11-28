import path from 'node:path';
import fs from 'fs-extra';
import { expect, vi } from 'vitest';
import { createDependencyCatalogSnapshotFixture } from './catalog-source-fixture.js';
import { getNativeTestLayout } from './native-execution-fixture.js';
import type { RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { writeIntent, observeIntent } from '../../src/intent/intent-store.js';
import { type RecoveryReceipt } from '../../src/recovery/receipt.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { useEmptyGitRepositoryFixture } from './git-repository-fixture.js';

const createEmptyGitRepository = useEmptyGitRepositoryFixture();

export async function fixture(collide = false, platforms: Array<'generic' | 'opencode' | 'cursor' | 'claude'> = ['generic'],
  hooks: boolean | string[] = false, graph: Record<string, string[]> = { a: ['d'], b: ['d'], d: [] },
  projectHookMutation?: { consumer: string; provider: string; scope?: 'user' | 'project'; replaceRetired?: boolean }, nativeHookMutation?: string) {
  const names = Object.keys(graph).sort();
  const skill = (name: string) => collide && name === 'b' ? 'a' : name;
  const hasHook = (name: string) => hooks === true || Array.isArray(hooks) && hooks.includes(name);
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'joint-project');
  const source = path.join(isolation.layout.fixtureCwd, 'joint-source');
  const hookTrace = path.join(cwd, 'hook-trace.jsonl');
  const hookFailure = path.join(cwd, 'fail-pre-apply');
  await fs.ensureDir(cwd); await createEmptyGitRepository(cwd);
  for (const name of names) await fs.outputFile(path.join(source, 'plugins', name, 'skills', skill(name), 'SKILL.md'),
    `---\nname: ${skill(name)}\ndescription: Test ${name}\n---\nUse ${name}.\n`);
  for (const name of names) await fs.outputFile(path.join(source, 'plugins', name, 'skills', skill(name), 'README.md'), `Use ${name}.\n`);
  for (const name of names.filter(hasHook)) await fs.outputFile(path.join(source, 'plugins', name, 'pre-apply.mjs'), [
    "import fs from 'node:fs'; const c = JSON.parse(fs.readFileSync(0, 'utf8'));",
    `fs.appendFileSync(${JSON.stringify(hookTrace)}, JSON.stringify({ plugin: c.plugin.name, platform: c.target.platform, scope: c.target.scope }) + '\\n');`,
    `const failure = ${JSON.stringify(hookFailure)};`,
    "if (fs.existsSync(failure) && fs.readFileSync(failure, 'utf8') === [c.plugin.name, c.target.platform, c.target.scope].join('/')) process.exit(23);",
    ...(name !== nativeHookMutation ? [] : [
      "if (c.target.scope === 'project') fs.appendFileSync(fs.readFileSync(failure, 'utf8'), '\\nExternal D-only bytes.\\n');",
    ]),
    ...(name !== projectHookMutation?.consumer ? [] : projectHookMutation.replaceRetired ? [
      `const retired = ${JSON.stringify(path.join(isolation.env.HOME!, '.agents', 'skills', 'retiring-skill'))};`,
      "if (c.target.scope === 'project') { fs.mkdirSync(retired, { recursive: true }); fs.writeFileSync(retired + '/README.md', 'External bytes.'); }",
    ] : [
      `const file = ${JSON.stringify(path.join(isolation.env.HOME!, '.agents', 'skills', projectHookMutation.provider, 'README.md'))};`,
      `if (c.target.scope === ${JSON.stringify(projectHookMutation.scope ?? 'project')} && fs.existsSync(file)) fs.writeFileSync(file, 'External bytes.');`,
    ]),
  ].join('\n'));
  await createDependencyCatalogSnapshotFixture(source, names.map((name) => ({ name,
    ...(graph[name]!.length ? { dependencies: graph[name] } : {}), configureManifest: (manifest) => {
      manifest.platforms = platforms; manifest.skills = './skills'; delete manifest.extensions;
      if (hasHook(name)) manifest.scripts = { preApply: { path: './pre-apply.mjs' } };
    } })));
  const config = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', cwd, env: isolation.env });
  const generated = await fs.readJson(path.join(source, '.aw-generated.json')) as { workspaceIdentity: string };
  const options = { cwd, env: isolation.env, cliVersion: '1.0.0', yes: true };
  const intent = (name: string) => ({ schemaVersion: 3 as const, kind: 'aw-plugin-intents' as const,
    sources: { team: { logicalIdentity: generated.workspaceIdentity } }, roots: [{ pluginId: `team/${name}` }] });
  await writeIntent({ ...options, scope: 'user' }, intent('a'));
  await writeIntent({ ...options, scope: 'project' }, intent('b'));
  await setTargets({ ...options, scope: 'user' }, ['generic']);
  const nativePaths: Record<string, string> = {};
  for (const scope of ['user', 'project'] as const) for (const platform of platforms.filter((platform) => platform !== 'generic')) for (const name of names) {
    const layout = await getNativeTestLayout({ platform, pluginId: `team/${name}`, scope, cwd, env: isolation.env });
    nativePaths[`${platform}/${scope}/${name}`] = path.join(layout.packageRoot, 'skills', skill(name));
  }
  const nativeSkill = (platform: 'opencode' | 'cursor', scope: 'user' | 'project', name: string) => nativePaths[`${platform}/${scope}/${name}`]!;
  return { options, cwd, source, hookTrace, hookFailure, nativeSkill, userRoot: path.join(isolation.env.HOME!, '.agents', 'skills'), projectRoot: path.join(cwd, '.agents', 'skills') };
}

export function failNextPackagePublication(packageRoot: string) {
  let failed = false;
  const move = fs.move.bind(fs);
  const spy = vi.spyOn(fs, 'move').mockImplementation(async (source: string, destination: string, options?: fs.MoveOptions) => {
    if (destination === packageRoot && !failed) {
      failed = true;
      throw new Error('EACCES');
    }
    return move(source, destination, options);
  });
  return { failed: () => failed, restore: () => spy.mockRestore() };
}

export async function expectSavedIntent(receipt: RecoveryReceipt, location: Parameters<typeof observeIntent>[0]) {
  const saved = await observeIntent(location);
  expect(saved.state).toBe('valid');
  if (saved.state !== 'valid') throw new Error('Expected the saved Intent to be readable.');
  expect(receipt.intent).toEqual({ state: 'valid', digest: saved.digest,
    roots: saved.value.roots.map((root) => root.pluginId) });
}

export function failManifestAfterActiveCheck(file: string, stages: string[], transportAlreadyChecked: string[] = []) {
  const readJson = fs.readJson.bind(fs);
  let reads: number | undefined;
  const spy = vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
    if (String(args[0]) === file && reads !== undefined && ++reads === 2) {
      throw Object.assign(new Error('read failed'), { code: 'EIO' });
    }
    return readJson(...args);
  });
  const runtime: RebuildCommandRuntime = { debugLogger: { log: (event) => {
    if (event.data?.phase === 'start' && stages.includes(String(event.data.name))) {
      // Public remove's source preflight and plan now share a read window. Fail
      // the later semantic manifest read, not the successful Transport read.
      reads = transportAlreadyChecked.includes(String(event.data.name)) ? 1 : 0;
    }
  } } };
  return { runtime, restore: () => spy.mockRestore() };
}
