import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeploymentBinding, LifecyclePrepareInput, MutationContext, PreparedDeployment, ReadContext } from '../../src/platforms/contracts.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { deploymentPackageComponent, inspectDeployment } from '../../src/platforms/inspection.js';
import { identityDigest } from '../../src/platforms/identity.js';
import { executePlatformLifecycle, hasSharedNativeRetirementEffect, preparePlatformLifecycle, type PlatformDriverState } from '../../src/platforms/lifecycle.js';
import { deploymentConfirmationEffects } from '../../src/commands/deployment-confirmation.js';
import { createNativeLifecycleServices } from '../../src/platforms/lifecycle-native-services.js';
import { cleanupOwnedComponents, createSkillOwnerMarkerContent, SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { readCodexConfigFile, upsertCodexMarketplaceFile, applyCodexConfigTransactionFile } from '../../src/utils/codex-config.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';

const code = 'demo@aw-test';
const sourceIdentity = `sha256:${'a'.repeat(64)}`;
const pluginEntry = { name: 'demo', source: './plugins/demo', extra: { keep: 'until removal' } };
const otherEntry = { name: 'other', source: './plugins/other', extra: { keep: true } };
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => fs.remove(directory))); });

type Platform = 'codex' | 'claude' | 'copilot';
async function fixture(platform: Platform, options: { installed?: boolean; userOnly?: boolean; managed?: boolean; failUninstall?: boolean; orphan?: boolean; persistentNative?: boolean; malformedNative?: boolean; projectAliases?: boolean } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-retirement-'));
  temporary.push(temp);
  const cwd = await fs.realpath(temp);
  const hostRoot = path.join(cwd, 'host');
  const projectA = path.join(cwd, 'project-a');
  const projectB = path.join(cwd, 'project-b');
  await Promise.all([fs.ensureDir(hostRoot), fs.ensureDir(projectA), fs.ensureDir(projectB)]);
  const projectARecordPath = options.projectAliases ? path.join(cwd, 'project-a-alias') : projectA;
  const projectBRecordPath = options.projectAliases ? path.join(cwd, 'project-b-alias') : projectB;
  if (options.projectAliases) {
    await fs.symlink(projectA, projectARecordPath, 'junction');
    await fs.symlink(projectB, projectBRecordPath, 'junction');
  }
  const env = { HOME: cwd, USERPROFILE: cwd, AW_HOME: path.join(cwd, 'aw'), CODEX_HOME: hostRoot, CLAUDE_CONFIG_DIR: hostRoot, COPILOT_HOME: hostRoot };
  const context: ReadContext = { cwd: projectA, env, confirmedCatalogRetirement: true };
  const base = { plugin: { sourceId: 'test', sourceIdentity, pluginId: 'test/demo', version: '1.0.0' }, platform,
    route: `${platform}-marketplace` as DeploymentBinding['route'], consumers: [{ id: 'fake-client', product: 'cli' as const, version: '2.1.292', availability: 'available' as const, reasonCodes: [],
      entry: { kind: 'cli' as const, executable: path.join(cwd, 'fake-client'), configRoot: hostRoot } }], physicalKey: '', activationKey: '', renderUnitIds: [] };
  const bind = async (projectRoot?: string): Promise<DeploymentBinding> => {
    const binding: DeploymentBinding = { ...base, id: `bind-${projectRoot ?? 'user'}`, activationKey: `activation-${projectRoot ?? 'user'}`,
      scope: projectRoot ? { kind: 'project', projectRoot } : { kind: 'user' } };
    const layout = await getDeploymentLayout(context, binding);
    binding.physicalKey = layout.renderUnits[0]!.physicalKey;
    binding.renderUnitIds = layout.renderUnits.map(({ id }) => id);
    return binding;
  };
  const binding = await bind(projectA);
  const layout = await getDeploymentLayout(context, binding);
  const market = layout.marketplaceRoot!;
  const manifestFile = path.join(market, platform === 'codex' ? '.agents/plugins/marketplace.json'
    : platform === 'claude' ? '.claude-plugin/marketplace.json' : '.github/plugin/marketplace.json');
  const manifest = { name: 'aw-test', owner: { name: 'AW' }, plugins: [pluginEntry, otherEntry] };
  await fs.outputJson(path.join(market, 'config.json'), { schemaVersion: 2, sourceId: 'test', sourceIdentity, marketplaceName: 'aw-test' });
  await fs.outputJson(manifestFile, manifest);
  const owner = deploymentPackageComponent(binding, layout);
  if (options.installed !== false) await fs.outputFile(path.join(layout.packageRoot, SKILL_OWNER_MARKER), createSkillOwnerMarkerContent(owner.identity));
  const configPath = (projectRoot?: string): string => platform === 'codex'
    ? path.join(projectRoot ? path.join(projectRoot, '.codex') : hostRoot, 'config.toml')
    : path.join(projectRoot ? path.join(projectRoot, platform === 'claude' ? '.claude' : '.github/copilot') : hostRoot,
      projectRoot ? 'settings.local.json' : 'settings.json');
  const suppliedEnabled = options.orphan ? false : true;
  async function writeActivation(projectRoot?: string, enabled = suppliedEnabled) {
    const file = configPath(projectRoot);
    if (platform === 'codex') await applyCodexConfigTransactionFile(file, { upsertPluginActivations: { [code]: enabled, 'other@aw-test': true } });
    else await fs.outputJson(file, { enabledPlugins: { [code]: enabled, 'other@aw-test': true }, extra: { untouched: true } });
  }
  if (options.installed !== false) await writeActivation();
  if (!options.userOnly) await writeActivation(projectA);
  await writeActivation(projectB);
  if (platform === 'codex') await upsertCodexMarketplaceFile(configPath(), 'aw-test', { source: market, sourceType: 'local' });
  if (platform === 'claude') await fs.outputJson(path.join(hostRoot, 'plugins', 'known_marketplaces.json'), {
    'aw-test': { source: { source: 'directory', path: market }, installLocation: market },
  });
  const installedRows: Record<string, unknown>[] = [];
  if (platform === 'claude' && !options.orphan) {
    if (options.installed !== false) installedRows.push({ id: code, scope: 'user', enabled: true, readFromFolder: layout.packageRoot });
    for (const projectPath of options.userOnly ? [projectBRecordPath] : [projectARecordPath, projectBRecordPath]) {
      installedRows.push({ id: code, scope: 'local', projectPath, enabled: true, readFromFolder: layout.packageRoot });
    }
    if (options.managed) installedRows.push({ id: code, scope: 'managed', enabled: true, readFromFolder: layout.packageRoot });
  }
  const installedFile = path.join(hostRoot, 'plugins', 'installed_plugins.json');
  const writeInstalledRows = () => fs.outputJson(installedFile, { plugins: { [code]: installedRows } });
  if (options.projectAliases) await writeInstalledRows();
  let nativeRegistered = options.installed !== false && !options.orphan;
  let marketplacePath = market;
  let marketplace: 'canonical' | 'foreign' | 'absent' | 'unknown' = 'canonical';
  const mutations: string[][] = [];
  const activation = async (projectRoot?: string) => {
    if (platform === 'codex') return (await readCodexConfigFile(configPath(projectRoot))).snapshot.plugins[code]?.enabled;
    const settings = await fs.readJson(configPath(projectRoot)).catch(() => ({}));
    return settings.enabledPlugins?.[code] as boolean | undefined;
  };
  const runner = vi.fn(async (call: NativeCliInvocation) => {
    const args = call.args;
    const project = call.cwd === projectA || call.cwd === projectB ? call.cwd : undefined;
    const projectRecordPath = project === projectA ? projectARecordPath : project === projectB ? projectBRecordPath : undefined;
    if (args[1] === 'marketplace') {
      if (marketplace === 'unknown') return { exitCode: 1, stdout: '', stderr: 'read failed' };
      const location = marketplace === 'foreign' ? path.join(cwd, 'foreign') : marketplacePath;
      return { exitCode: 0, stderr: '', stdout: JSON.stringify(marketplace === 'absent' ? []
        : [{ name: 'aw-test', source: platform === 'claude' ? 'directory' : `Local: ${location}`, path: location }]) };
    }
    if (args[1] === 'list') {
      if (options.malformedNative) return { exitCode: 0, stderr: '', stdout: '[{}]' };
      let value: unknown;
      if (platform === 'codex') value = { available: [], installed: nativeRegistered
        ? [{ pluginId: code, installed: true, enabled: (await activation(project) ?? await activation()) === true }] : [] };
      else if (platform === 'claude') value = installedRows.filter((row) => row.scope !== 'local' || row.projectPath === projectRecordPath);
      else {
        // Model the actual Copilot live list behavior: the row survives a
        // successful uninstall while manifest, package or activation remains.
        const entries = (await fs.readJson(manifestFile)).plugins as Array<{ name: string }>;
        const live = options.persistentNative || nativeRegistered || entries.some((entry) => entry.name === 'demo') || await fs.pathExists(layout.packageRoot)
          || await activation(project) !== undefined || await activation() !== undefined;
        value = live ? [{ name: 'demo', marketplace: 'aw-test', source: 'live', installedFrom: market, enabled: options.persistentNative || nativeRegistered }] : [];
      }
      return { exitCode: 0, stderr: '', stdout: JSON.stringify(value) };
    }
    mutations.push([...args]);
    if (options.failUninstall) return { exitCode: 1, stdout: '', stderr: 'uninstall failed' };
    if (platform !== 'claude') {
      expect(await fs.pathExists(layout.packageRoot)).toBe(true);
      expect((await fs.readJson(manifestFile)).plugins).toContainEqual(pluginEntry);
      nativeRegistered = false;
    } else {
      const scope = args[4];
      const index = installedRows.findIndex((row) => row.scope === scope && (scope !== 'local' || row.projectPath === projectRecordPath));
      if (index < 0) return { exitCode: 1, stdout: '', stderr: 'not registered in scope' };
      installedRows.splice(index, 1);
      if (options.projectAliases) await writeInstalledRows();
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  context.runner = runner;
  async function input(target = binding, retirement = true): Promise<LifecyclePrepareInput> {
    const ctx = { ...context, confirmedCatalogRetirement: retirement ? true as const : undefined };
    const targetLayout = await getDeploymentLayout(ctx, target);
    const observation = await inspectDeployment(ctx, target);
    const component = deploymentPackageComponent(target, targetLayout);
    return { operation: 'cleanup', binding: target, observation, projections: [], expected: { components: [], omitted: [], unmet: [], sources: {} },
      evidence: { confirmedCatalogRetirement: ctx.confirmedCatalogRetirement, fingerprint: identityDigest(observation), layout: targetLayout,
        renderUnits: targetLayout.renderUnits, ownership: [{ component, state: observation.package === 'present' ? 'present' : 'absent' }],
        sharedReferences: 'present', nativeIdentity: targetLayout.nativeIdentity, userActivationEnabled: true, contentMatches: false } };
  }
  async function plan(target = binding): Promise<PreparedDeployment<PlatformDriverState>> {
    const prepared = preparePlatformLifecycle(await input(target));
    if (prepared.status !== 'ready') throw new Error(JSON.stringify(prepared.diagnostics));
    return prepared.prepared;
  }
  async function execute(prepared: PreparedDeployment<PlatformDriverState>) {
    const ctx = { ...context, cwd: prepared.plan.binding.scope.kind === 'project' ? prepared.plan.binding.scope.projectRoot : context.cwd };
    const services: MutationContext['services'] = { ...createNativeLifecycleServices(ctx, prepared.plan.evidence),
      verifyEvidence: async () => identityDigest(await inspectDeployment(ctx, prepared.plan.binding)) === prepared.plan.evidence.fingerprint,
      publishPackage: async () => { throw new Error('unexpected publication'); },
      writeContribution: async () => { throw new Error('unexpected supplement write'); },
      removeOwned: async (_binding, component) => {
        const result = await cleanupOwnedComponents({ components: [component] });
        if (result.failures.length || result.residual.length) throw new Error('cleanup incomplete');
        return { changed: result.removed.length > 0, mutation: result.removed.length ? 'confirmed' : 'none' };
      } };
    return executePlatformLifecycle({ ...ctx, services }, prepared);
  }
  return { binding, layout, context, hostRoot, projectA, projectB, projectARecordPath, projectBRecordPath, installedFile, configPath, activation, manifest, manifestFile, market,
    input, plan, execute, bind, runner, mutations, installedRows, setMarketplacePath: (value: string) => { marketplacePath = value; }, setMarketplace: (value: typeof marketplace) => { marketplace = value; } };
}

describe('confirmed Catalog retirement of shared native routes', () => {
  // Test Value Gate: a disabled activation and orphan payload are still removable;
  // the same frozen scope without retirement authority must preserve shared output.
  it('clears a Codex orphan and both activation keys, then permits a separate no-package project cleanup', async () => {
    const f = await fixture('codex', { orphan: true });
    const ordinary = preparePlatformLifecycle(await f.input(f.binding, false));
    expect(ordinary.status).toBe('ready');
    if (ordinary.status === 'ready') expect(ordinary.prepared.plan.effects).toEqual([]);
    const projectB = await fs.readFile(f.configPath(f.projectB), 'utf8');
    const frozen = await f.plan();
    expect(hasSharedNativeRetirementEffect(frozen.plan)).toBe(true);
    const receipt = await f.execute(frozen);
    expect(receipt.after).toMatchObject({ package: 'absent', registration: 'absent', ownership: 'absent' });
    expect(receipt.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(f.mutations).toEqual([]);
    expect(await f.activation()).toBeUndefined();
    expect(await f.activation(f.projectA)).toBeUndefined();
    expect(await fs.readJson(f.manifestFile)).toEqual({ ...f.manifest, plugins: [otherEntry] });
    expect(await fs.readFile(f.configPath(f.projectB), 'utf8')).toBe(projectB);
    const next = await f.plan(await f.bind(f.projectB));
    expect(hasSharedNativeRetirementEffect(next.plan)).toBe(false);
    expect((await f.execute(next)).diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(await f.activation(f.projectB)).toBeUndefined();
    expect((await readCodexConfigFile(f.configPath())).snapshot.marketplaces['aw-test']?.source).toBe(f.market);
  });

  // Test Value Gate: removing a local activation requires source proof even when
  // the only remaining artifact looks like an old AW registration.
  it.each(['absent-market', 'foreign-market', 'missing-config', 'changed-source', 'invalid-manifest', 'redirected-entry'] as const)('blocks a no-package Codex cleanup with %s', async (reason) => {
    const f = await fixture('codex', { installed: false });
    if (reason === 'absent-market') await fs.remove(f.configPath());
    if (reason === 'foreign-market') await upsertCodexMarketplaceFile(f.configPath(), 'aw-test', { source: path.join(f.hostRoot, 'foreign'), sourceType: 'local' });
    if (reason === 'missing-config') await fs.remove(path.join(f.market, 'config.json'));
    if (reason === 'changed-source') await fs.outputJson(path.join(f.market, 'config.json'), { schemaVersion: 2, sourceId: 'test', sourceIdentity: `sha256:${'b'.repeat(64)}`, marketplaceName: 'aw-test' });
    if (reason === 'invalid-manifest') await fs.writeFile(f.manifestFile, '{invalid');
    if (reason === 'redirected-entry') await fs.writeJson(f.manifestFile, { ...f.manifest, plugins: [pluginEntry, { name: 'demo', source: './plugins/outside' }] });
    const before = await fs.readFile(f.configPath(f.projectA), 'utf8');
    expect(preparePlatformLifecycle(await f.input())).toMatchObject({ status: 'blocked', diagnostics: [{ code: 'deploymentOwnershipUnconfirmed' }] });
    expect(await fs.readFile(f.configPath(f.projectA), 'utf8')).toBe(before);
    expect(f.mutations).toEqual([]);
  });

  it.each(['absent', 'foreign', 'unknown'] as const)('keeps a no-package Copilot activation when the host marketplace is %s', async (state) => {
    const f = await fixture('copilot', { installed: false });
    f.setMarketplace(state);
    expect(preparePlatformLifecycle(await f.input())).toMatchObject({ status: 'blocked' });
    expect(await f.activation(f.projectA)).toBe(true);
    expect(f.mutations).toEqual([]);
  });

  it.each(['claude', 'copilot', 'codex'] as const)('does not infer absence from a malformed %s native inventory', async (platform) => {
    const f = await fixture(platform, { malformedNative: true, orphan: true });
    expect(preparePlatformLifecycle(await f.input())).toMatchObject({ status: 'blocked' });
    expect(await fs.pathExists(f.layout.packageRoot)).toBe(true);
    expect(f.mutations).toEqual([]);
  });

  it('leaves the User activation unchanged in no-package Codex project cleanup', async () => {
    const f = await fixture('codex', { installed: false });
    await fs.outputJson(f.manifestFile, { ...f.manifest, plugins: [otherEntry] });
    await applyCodexConfigTransactionFile(f.configPath(), { upsertPluginActivations: { [code]: false } });
    const user = await fs.readFile(f.configPath(), 'utf8');
    const frozen = await f.plan();
    expect(hasSharedNativeRetirementEffect(frozen.plan)).toBe(false);
    expect((await f.execute(frozen)).diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(await fs.readFile(f.configPath(), 'utf8')).toBe(user);
    expect(await f.activation(f.projectA)).toBeUndefined();
  });

  // Test Value Gate: each scoped native uninstall is necessary; the still-live
  // other scope must not prevent the second command or reach a different project.
  it.each([false, true])('retires Claude local+user or inherited user (inherited=%s), then unbinds the next project without a package', async (userOnly) => {
    const f = await fixture('claude', { userOnly });
    const frozen = await f.plan();
    expect(hasSharedNativeRetirementEffect(frozen.plan)).toBe(true);
    const receipt = await f.execute(frozen);
    expect(receipt.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(receipt.after).toMatchObject({ package: 'absent', registration: 'absent' });
    expect(f.mutations).toEqual([...(!userOnly ? [['plugin', 'uninstall', code, '--scope', 'local']] : []), ['plugin', 'uninstall', code, '--scope', 'user']]);
    expect(f.installedRows).toEqual([expect.objectContaining({ scope: 'local', projectPath: f.projectB })]);
    expect(await fs.readJson(f.manifestFile)).toEqual({ ...f.manifest, plugins: [otherEntry] });
    const later = await f.plan(await f.bind(f.projectB));
    expect(hasSharedNativeRetirementEffect(later.plan)).toBe(false);
    expect((await f.execute(later)).diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(f.mutations.at(-1)).toEqual(['plugin', 'uninstall', code, '--scope', 'local']);
    expect(f.installedRows).toEqual([]);
  });

  // Test Value Gate: a local Claude uninstall does not withdraw the User
  // registration; the shared package deletion still needs explicit confirmation.
  it('discloses shared package removal without claiming a shared registration withdrawal for Claude local-only retirement', async () => {
    const f = await fixture('claude');
    f.installedRows.splice(f.installedRows.findIndex((row) => row.scope === 'user'), 1);
    const frozen = await f.plan();
    const shared = deploymentConfirmationEffects(frozen.plan).filter((effect) => effect.impact === 'shared');
    expect(shared.length).toBeGreaterThan(0);
    for (const effect of shared) {
      expect(effect.message).toContain('delete the shared native package');
      expect(effect.message).not.toContain('withdraw the shared native registration');
    }
  });

  it('preserves shared Claude output even when offline cleanup finds no other reference', async () => {
    const f = await fixture('claude');
    const input = await f.input(await f.bind(), false);
    input.evidence.sharedReferences = 'none';
    const cleanup = preparePlatformLifecycle(input);
    expect(cleanup.status).toBe('ready');
    if (cleanup.status === 'ready') expect(cleanup.prepared.plan.effects.map(({ kind }) => kind)).toEqual(['deactivate']);
    const remove = preparePlatformLifecycle({ ...input, operation: 'remove' });
    expect(remove.status).toBe('ready');
    if (remove.status === 'ready') expect(remove.prepared.plan.effects.map(({ kind }) => kind)).toContain('unregister');
  });

  // Test Value Gate: physical project aliases in both native inventories must
  // not silently skip the current local uninstall, with or without the package.
  it('retires Claude local registrations recorded under aliases of the current physical project only', async () => {
    const f = await fixture('claude', { projectAliases: true });
    expect(await fs.realpath(f.projectARecordPath)).toBe(f.projectA);
    expect(await fs.realpath(f.projectBRecordPath)).toBe(f.projectB);
    const otherSettings = f.configPath(f.projectB);
    const original = await fs.readFile(otherSettings, 'utf8');
    await fs.writeFile(otherSettings, '{invalid');

    const receipt = await f.execute(await f.plan());
    expect(receipt.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(receipt.after).toMatchObject({ package: 'absent', registration: 'absent' });
    expect(f.mutations).toEqual([['plugin', 'uninstall', code, '--scope', 'local'], ['plugin', 'uninstall', code, '--scope', 'user']]);
    expect(f.installedRows).toEqual([expect.objectContaining({ scope: 'local', projectPath: f.projectBRecordPath })]);
    expect(await fs.readJson(f.installedFile)).toEqual({ plugins: { [code]: f.installedRows } });
    expect(await fs.readFile(otherSettings, 'utf8')).toBe('{invalid');

    await fs.writeFile(otherSettings, original);
    const next = await f.execute(await f.plan(await f.bind(f.projectB)));
    expect(next.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(next.after).toMatchObject({ package: 'absent', registration: 'absent' });
    expect(f.mutations).toHaveLength(3);
    expect(f.mutations.at(-1)).toEqual(['plugin', 'uninstall', code, '--scope', 'local']);
    expect(f.installedRows).toEqual([]);
    expect(await fs.readJson(f.installedFile)).toEqual({ plugins: { [code]: [] } });
  });

  it.each([
    ['codex', false], ['claude', true], ['copilot', false],
  ] as const)('rejects a raw %s marketplace path containing a parent component, installed=%s', async (platform, installed) => {
    const f = await fixture(platform, { installed });
    const foreign = path.join(f.projectB, 'other-market');
    await fs.ensureDir(foreign);
    const link = path.join(path.dirname(f.market), 'alias');
    await fs.symlink(foreign, link, 'junction');
    const source = [link, '..', path.basename(f.market)].join(path.sep);
    if (platform === 'codex') await upsertCodexMarketplaceFile(f.configPath(), 'aw-test', { source, sourceType: 'local' });
    if (platform === 'claude') await fs.outputJson(path.join(f.hostRoot, 'plugins', 'known_marketplaces.json'), {
      'aw-test': { source: { source: 'directory', path: source }, installLocation: f.market },
    });
    if (platform === 'copilot') f.setMarketplacePath(source);
    const local = await fs.readFile(f.configPath(f.projectA), 'utf8');
    expect(preparePlatformLifecycle(await f.input())).toMatchObject({ status: 'blocked' });
    expect(f.mutations).toEqual([]);
    expect(await fs.pathExists(f.layout.packageRoot)).toBe(installed);
    expect(await fs.readFile(f.configPath(f.projectA), 'utf8')).toBe(local);
  });

  it('blocks a managed Claude disk registration hidden by the native list', async () => {
    const f = await fixture('claude');
    const file = path.join(f.hostRoot, 'plugins', 'installed_plugins.json');
    const records = { plugins: { [code]: [{ scope: 'managed' }] } };
    await fs.outputJson(file, records);
    expect(preparePlatformLifecycle(await f.input())).toMatchObject({ status: 'blocked', diagnostics: [{ code: 'nativeManagedRegistration' }] });
    expect(await fs.pathExists(f.layout.packageRoot)).toBe(true);
    expect(await fs.readJson(file)).toEqual(records);
    expect(f.mutations).toEqual([]);
  });

  it('blocks Claude managed registration, and no-package local cleanup without a known marketplace', async () => {
    const managed = await fixture('claude', { managed: true });
    expect(preparePlatformLifecycle(await managed.input())).toMatchObject({ status: 'blocked', diagnostics: [{ code: 'nativeManagedRegistration' }] });
    expect(await fs.pathExists(managed.layout.packageRoot)).toBe(true);
    expect(managed.mutations).toEqual([]);
    const missing = await fixture('claude', { installed: false });
    await fs.remove(path.join(missing.hostRoot, 'plugins', 'known_marketplaces.json'));
    expect(preparePlatformLifecycle(await missing.input())).toMatchObject({ status: 'blocked' });
    expect(missing.mutations).toEqual([]);
  });

  it.each(['disagrees', 'invalid'] as const)('blocks when the Claude disk registration %s', async (state) => {
    const f = await fixture('claude', { orphan: true });
    await fs.outputJson(path.join(f.hostRoot, 'plugins', 'installed_plugins.json'), state === 'invalid'
      ? { plugins: null } : { plugins: { [code]: [{ scope: 'local', projectPath: f.projectA }] } });
    expect(preparePlatformLifecycle(await f.input())).toMatchObject({ status: 'blocked' });
    expect(await fs.pathExists(f.layout.packageRoot)).toBe(true);
    expect(f.mutations).toEqual([]);
  });

  it.each([
    ['missing installed file', undefined], ['empty installed object', {}], ['version only', { version: 2 }],
  ] as const)('does not call Claude disable for a verified orphan package with %s', async (_state, installed) => {
    const f = await fixture('claude', { orphan: true });
    if (installed) await fs.outputJson(f.installedFile, installed);
    const receipt = await f.execute(await f.plan());
    expect(receipt.after).toMatchObject({ registration: 'absent', package: 'absent' });
    expect(receipt.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(f.mutations).toEqual([]);
    expect(await fs.readJson(f.manifestFile)).toEqual({ ...f.manifest, plugins: [otherEntry] });
  });

  // The last native uninstall may retain only the file's version. The
  // postcheck must still recognize the now-empty installed plugin list.
  it('confirms Claude removal when the last uninstall omits the plugins field', async () => {
    const f = await fixture('claude', { userOnly: true });
    f.installedRows.splice(1);
    await fs.outputJson(f.installedFile, { version: 2, plugins: { [code]: f.installedRows } });
    const run = f.runner.getMockImplementation()!;
    f.runner.mockImplementation(async (call) => {
      const result = await run(call);
      if (call.args[1] === 'uninstall' && result.exitCode === 0 && f.installedRows.length === 0) {
        await fs.outputJson(f.installedFile, { version: 2 });
      }
      return result;
    });
    const receipt = await f.execute(await f.plan());
    expect(receipt.after).toMatchObject({ registration: 'absent', package: 'absent' });
    expect(receipt.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect(await fs.readJson(f.installedFile)).toEqual({ version: 2 });
  });

  // Test Value Gate: client uninstall must precede local removal, and its live
  // inventory must be checked only after the payload, listing and keys disappear.
  it.each([false, true])('Copilot withdrawal preserves retry evidence on uninstall failure=%s', async (failUninstall) => {
    const f = await fixture('copilot', { failUninstall });
    const frozen = await f.plan();
    const before = await fs.readJson(f.configPath(f.projectB));
    const receipt = await f.execute(frozen);
    expect(f.mutations).toEqual([['plugin', 'uninstall', code]]);
    expect(await fs.readJson(f.configPath(f.projectB))).toEqual(before);
    if (failUninstall) {
      expect(receipt.effects.some(({ status }) => status === 'failed' || status === 'unknown')).toBe(true);
      expect(await fs.pathExists(f.layout.packageRoot)).toBe(true);
      expect(await fs.readJson(f.manifestFile)).toEqual(f.manifest);
      expect(await f.activation()).toBe(true);
      expect(await f.activation(f.projectA)).toBe(true);
    } else {
      expect(receipt.after).toMatchObject({ package: 'absent', registration: 'absent' });
      expect(receipt.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
      expect(await f.activation()).toBeUndefined();
      expect(await f.activation(f.projectA)).toBeUndefined();
      expect(await fs.readJson(f.manifestFile)).toEqual({ ...f.manifest, plugins: [otherEntry] });
      const next = await f.plan(await f.bind(f.projectB));
      expect((await f.execute(next)).diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
      expect(await f.activation(f.projectB)).toBeUndefined();
      expect(f.mutations).toHaveLength(1);
    }
  });

  it('reports a real Copilot registration residual even if all local effects ran', async () => {
    const f = await fixture('copilot', { persistentNative: true });
    const receipt = await f.execute(await f.plan());
    expect(receipt.after).toMatchObject({ package: 'absent', registration: 'present' });
    expect(receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'nativeRetirementPostcheckFailed', severity: 'error' }));
  });

  it('binds the whole Codex plugin table that retirement would delete', async () => {
    const f = await fixture('codex');
    const frozen = await f.plan();
    const file = f.configPath(f.projectA);
    const config = await fs.readFile(file, 'utf8');
    const edited = config.replace('enabled = true', 'enabled = true\ncustom_setting = "external change"');
    expect(edited).not.toBe(config);
    await fs.writeFile(file, edited);
    const receipt = await f.execute(frozen);
    expect(receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'operationPlanStale' }));
    expect(await fs.readFile(file, 'utf8')).toBe(edited);
    expect(f.mutations).toEqual([]);
  });

  it('preserves unrelated changes made to the shared manifest and host settings after Review', async () => {
    const f = await fixture('copilot');
    const frozen = await f.plan();
    const sibling = { ...otherEntry, description: 'updated by another action' };
    await fs.writeJson(f.manifestFile, { ...f.manifest, plugins: [pluginEntry, sibling] });
    const settings = await fs.readJson(f.configPath());
    await fs.writeJson(f.configPath(), { ...settings, enabledPlugins: { ...settings.enabledPlugins, 'other@aw-test': false } });
    expect((await f.execute(frozen)).diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    expect((await fs.readJson(f.manifestFile)).plugins).toEqual([sibling]);
    expect((await fs.readJson(f.configPath())).enabledPlugins).toEqual({ 'other@aw-test': false });
  });

  it('rechecks the reviewed plugin entry before retirement writes', async () => {
    const f = await fixture('codex');
    const frozen = await f.plan();
    const changed = { ...f.manifest, plugins: [{ ...pluginEntry, description: 'changed after Review' }, otherEntry] };
    await fs.outputJson(f.manifestFile, changed);
    const receipt = await f.execute(frozen);
    expect(receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'operationPlanStale' }));
    expect(await fs.readJson(f.manifestFile)).toEqual(changed);
    expect(await fs.pathExists(f.layout.packageRoot)).toBe(true);
    expect(f.mutations).toEqual([]);
  });
});
