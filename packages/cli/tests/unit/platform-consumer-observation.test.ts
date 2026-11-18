import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';
import { getPlatformCapabilities, getQualifiedPlatformProfile } from '../../src/platforms/capabilities.js';
import { deploymentPackageComponent, inspectDeployment } from '../../src/platforms/inspection.js';
import { SKILL_OWNER_MARKER, writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { readPlatformPackageContentDigest } from '../../src/utils/platform-empty-state.js';
import type { ReadContext, ScopeRef } from '../../src/platforms/contracts.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createRebuildIntegration, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { createNoopReporter } from '../../src/output/reporter.js';
import { createNoopDebugLogger } from '../../src/output/debug-log.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';

async function fixture(platform: 'pi' | 'grok', project = false) {
  const isolated = getCurrentSourceTestIsolation();
  const cwd = isolated.layout.fixtureCwd;
  const env: NodeJS.ProcessEnv = { ...isolated.env, GROK_HOME: path.join(cwd, 'grok-home') };
  const ctx: ReadContext = { cwd, env };
  let piList = 'No packages installed.\n';
  if (platform === 'pi') ctx.runner = async () => ({ exitCode: 0, stderr: '', stdout: piList });
  const host = platform === 'pi' ? path.join(env.HOME!, '.pi', 'agent') : env.GROK_HOME!;
  const scope: ScopeRef = project ? { kind: 'project', projectRoot: cwd } : { kind: 'user' };
  const resolved = await resolveDeployments(ctx, { plugin: { sourceId: 'team', sourceIdentity: `sha256:${'a'.repeat(64)}`,
    pluginId: 'team/example', version: '1.0.0' }, operation: 'ensure', scope, recoveryCandidates: [], discovery: {
    platform, availability: 'available', diagnostics: [], installations: [{ id: 'client', product: 'cli', availability: 'available',
      version: platform === 'pi' ? '1.5.0' : '1.0.77', reasonCodes: [], entry: { kind: 'cli', executable: path.join(cwd, platform), configRoot: host } }],
  } });
  const binding = resolved.bindings[0]!;
  const layout = await getDeploymentLayout(ctx, binding);
  const caps = async () => getPlatformCapabilities({ binding, renderUnit: resolved.renderUnits[0]!,
    observation: await inspectDeployment(ctx, binding), profile: getQualifiedPlatformProfile(platform) });
  return { ctx, host, binding, layout, caps, setPiList: (value: string) => { piList = value; } };
}

async function consumer(root: string, version = '0.22.0') {
  await fs.outputJson(path.join(root, 'package.json'), { name: '@tintinweb/pi-subagents', version, pi: { extensions: ['./index.ts'] } });
  await fs.outputFile(path.join(root, 'index.ts'), 'export default function () {}');
}

async function grokPackage(item: Awaited<ReturnType<typeof fixture>>, body: string): Promise<string> {
  const root = item.layout.packageRoot;
  await fs.outputJson(path.join(root, '.grok-plugin/plugin.json'), { name: item.layout.nativeIdentity.packageId, version: '1.0.0', skills: './skills/' });
  await fs.outputFile(path.join(root, 'skills/demo/SKILL.md'), `---\nname: demo\ndescription: Grok fixture\n---\n${body}\n`);
  const digest = (await readPlatformPackageContentDigest(root))!;
  await writeSkillOwnerMarker({ skillRoot: root, allowedRoot: path.dirname(root), identity: deploymentPackageComponent(item.binding, item.layout).identity,
    nativeProjection: { physicalIdentity: item.layout.physicalIdentity, preparation: 'complete', inputDigest: `sha256:${'c'.repeat(64)}`, contentDigest: digest,
      components: [{ id: 'skill', nativeName: 'demo', relativeOutputs: ['skills/demo/SKILL.md'] }] } });
  return digest;
}

async function grokRebuildFixture(trusted: boolean | undefined, multipleCli = false) {
  installNativeTestQualification({ platforms: ['grok'] });
  const item = await fixture('grok');
  const bin = path.join(item.ctx.cwd, 'bin');
  await fs.outputFile(path.join(bin, 'grok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const secondBin = path.join(item.ctx.cwd, 'other-bin');
  if (multipleCli) await fs.outputFile(path.join(secondBin, 'grok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...item.ctx.env, PATH: [bin, ...(multipleCli ? [secondBin] : [])].join(path.delimiter) };
  const root = path.join(item.ctx.cwd, 'grok-plugin');
  await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), { schemaVersion: 4, name: 'example', version: '1.0.0',
    description: 'Grok trust and stale fixture.', platforms: ['grok'], skills: './skills',
    marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } } });
  await fs.outputFile(path.join(root, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Grok lifecycle fixture.\n---\nGrok fixture.\n');
  const plugin = await readPluginManifest(root, { mode: 'bundle' });
  Object.assign(plugin, { sourceId: 'team', pluginId: 'team/example', sourceIdentity: item.binding.plugin.sourceIdentity });
  const installed = path.join(item.host, 'installed-plugins/local-123');
  const state = { trusted, enabled: true, source: '', registered: false };
  const queryCwds = new Set<string>();
  const nativeWrites: string[][] = [];
  const runner: NonNullable<RebuildExecutionContext['nativeCliRunner']> = async ({ args, cwd }) => {
    let stdout = '';
    if (args.includes('--version')) stdout = 'grok 1.0.77';
    else if (args.includes('--help')) stdout = 'Grok Build plugin install uninstall update enable disable --json';
    else if (args[0] === 'plugin' && args[1] === 'list') stdout = JSON.stringify(state.registered ? [{ status: 'installed',
      name: 'example', repo_key: 'local-123', version: '1.0.0', path: installed, source: state.source }] : []);
    else if (args[0] === 'inspect') {
      queryCwds.add(cwd);
      stdout = JSON.stringify({ grokVersion: '1.0.77', cwd, projectRoot: null, projectTrusted: state.trusted,
        configSources: { layers: [{ role: 'user', path: path.join(item.host, 'config.toml') }] },
        plugins: state.registered ? [{ name: 'example', scope: 'user', path: installed, enabled: state.enabled }] : [],
        skills: [], agents: [], mcpServers: [] });
    } else {
      nativeWrites.push([...args]);
      if (args[0] === 'plugin' && args[1] === 'install') {
        state.source = args[2]!; state.registered = true; state.enabled = true;
        await fs.copy(state.source, installed, { overwrite: true });
      } else if (args[0] === 'plugin' && args[1] === 'uninstall') {
        state.registered = false; await fs.remove(installed);
      } else if (args[0] === 'plugin' && args[1] === 'enable') state.enabled = true;
      else if (args[0] === 'plugin' && args[1] === 'disable') state.enabled = false;
      else throw new Error('Unexpected Grok fixture mutation.');
    }
    return { exitCode: 0, stdout, stderr: '' };
  };
  const context: RebuildExecutionContext = { env, nativeCliRunner: runner,
    reporter: createNoopReporter(), debugLogger: createNoopDebugLogger(), preparedArtifactRenderResults: new Map() };
  let integration = createRebuildIntegration({ context });
  const prepare = (command: 'sync' | 'reinstall' = 'sync') => integration.buildTarget({ plugin, platform: 'grok', scope: 'user', cwd: item.ctx.cwd, command,
    catalog: { rootDir: root, source: 'local', catalogVersion: '1.0.0' } });
  const observe = () => inspectDeployment({ ...item.ctx, env, runner }, item.binding);
  const grant = async () => {
    await runner({ command: path.join(bin, 'grok'), cwd: item.ctx.cwd, env,
      args: ['plugin', 'install', item.layout.packageRoot, '--trust'] });
    // Explicit native consent happens between AW commands, with a new Review.
    await context.platformRebuildSession?.dispose();
    delete context.platformRebuildSession;
    context.preparedArtifactRenderResults = new Map();
    integration = createRebuildIntegration({ context });
  };
  return { item, state, queryCwds, nativeWrites, context, get integration() { return integration; }, prepare, observe, grant };
}

describe('public native consumer observation', () => {
  // Test Value Gate: runtime trust does not grant new-source consent, and fresh
  // neutral query directories must not invalidate an unchanged prepared action.
  it.each([true, false, undefined])('uses Grok native User trust=%s through preparation and execution', async (trusted) => {
    const test = await grokRebuildFixture(trusted);
    try {
      const before = await test.observe();
      const repeat = await test.observe();
      expect(test.queryCwds.size).toBe(2);
      expect(repeat.prerequisites.nativeSources?.configurationEvidence).toBe(before.prerequisites.nativeSources?.configurationEvidence);
      expect(before.grokScopeAuthorization).toBe(trusted === true ? 'granted' : trusted === false ? 'denied' : 'unknown');
      const target = await test.prepare();
      const result = await executeRebuildOperation({ command: 'sync', target, driver: test.integration.driver });
      expect(result.status).toBe('failed');
      const diagnostics = result.deploymentReceipts?.flatMap((receipt) => [
        ...receipt.diagnostics, ...receipt.effects.flatMap((effect) => effect.diagnostics),
      ]);
      expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'nativeTrustRequired' }));
      expect(test.nativeWrites).toEqual([]);
      if (trusted) {
        await test.grant();
        const synced = await executeRebuildOperation({ command: 'sync', target: await test.prepare(), driver: test.integration.driver });
        expect(synced.status, JSON.stringify(synced)).toBe('succeeded');
        expect((await test.observe()).registration).toBe('present');
        const refresh = await test.prepare('reinstall');
        const refreshed = await executeRebuildOperation({ command: 'reinstall', target: refresh, driver: test.integration.driver });
        expect(refreshed.status, JSON.stringify(refreshed)).toBe('succeeded');
        expect(test.nativeWrites.filter((args) => args[0] === 'plugin' && args[1] === 'install')).toHaveLength(2);
      }
    } finally { await test.context.platformRebuildSession?.dispose(); }
  });

  // Test Value Gate: the grouped rebuild postcheck must use the same complete
  // CLI path as native mutation without rewriting the other CLI's unknown facts.
  it('refreshes through one Grok CLI while retaining another CLI as unobserved', async () => {
    const test = await grokRebuildFixture(true, true);
    try {
      await executeRebuildOperation({ command: 'sync', target: await test.prepare(), driver: test.integration.driver });
      await test.grant();
      const target = await test.prepare('reinstall');
      expect(target.platformDeployment?.plans[0]?.binding.consumers).toHaveLength(2);
      const refreshed = await executeRebuildOperation({ command: 'reinstall', target, driver: test.integration.driver });
      expect(refreshed.status, JSON.stringify(refreshed)).toBe('succeeded');
      expect(refreshed.deploymentReceipts?.[0]?.after.consumers).toMatchObject([
        { activation: 'enabled' }, { activation: 'unknown', load: 'unknown' },
      ]);
      expect(refreshed.deploymentReceipts?.flatMap((receipt) => receipt.unmet)).toEqual([]);
    } finally { await test.context.platformRebuildSession?.dispose(); }
  });

  // Test Value Gate: ignoring ephemeral query metadata must still reject a
  // prepared write after actual native identity, policy or configuration changes.
  it.each(['enabled', 'trust', 'source', 'configuration'] as const)('rejects a prepared Grok write after %s changes', async (change) => {
    const test = await grokRebuildFixture(true);
    try {
      const installed = await executeRebuildOperation({ command: 'sync', target: await test.prepare(), driver: test.integration.driver });
      expect(installed.status).toBe('failed');
      await test.grant();
      const target = await test.prepare();
      const before = await test.observe();
      const mutations = test.nativeWrites.length;
      if (change === 'enabled') test.state.enabled = false;
      else if (change === 'trust') test.state.trusted = false;
      else if (change === 'source') test.state.source = path.join(test.item.ctx.cwd, 'foreign-source');
      else await fs.outputFile(path.join(test.item.host, 'config.toml'), '[plugins]\ndisabled=["example"]\n');
      const after = await test.observe();
      expect(after.prerequisites.nativeSources?.configurationEvidence).not.toBe(before.prerequisites.nativeSources?.configurationEvidence);
      const result = await executeRebuildOperation({ command: 'sync', target, driver: test.integration.driver });
      expect(result).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('operationPlanStale') } });
      expect(test.nativeWrites).toHaveLength(mutations);
    } finally { await test.context.platformRebuildSession?.dispose(); }
  });

  // Test Value Gate: native package registration must survive conflicting or
  // damaged supplemental files without claiming activation, trust or loading.
  it.each([false, true])('keeps Pi native scope registration separate from local configuration with project=%s', async (project) => {
    const item = await fixture('pi', project);
    const scope = project ? 'Project' : 'User';
    item.setPiList(`${scope} packages:\n  ${item.layout.packageRoot}\n    ${item.layout.packageRoot}\n`);
    await fs.outputFile(item.layout.activationPath, '{');
    const native = await inspectDeployment(item.ctx, item.binding);
    expect(native.registration).toBe('present');
    expect(native.consumers[0]).toMatchObject({ activation: 'unknown', load: 'not-observed' });
    expect(native.configuration).toMatchObject({ scope: project ? 'project' : 'user', activation: 'unknown' });
    item.setPiList('User packages:\n  npm:another-package\n');
    expect((await inspectDeployment(item.ctx, item.binding)).registration).toBe(project ? 'unknown' : 'absent');
  });

  it.each(['No packages installed.\n', 'User packages:\n  npm:other-package\n', '', 'Project packages:\n'])(
    'keeps Pi Project absence unknown and distinguishes hidden scope from invalid native output: %j', async (output) => {
      const item = await fixture('pi', true);
      item.setPiList(output);
      const observed = await inspectDeployment(item.ctx, item.binding);
      expect(observed.registration).toBe('unknown');
      const hidden = output.startsWith('No packages') || output.startsWith('User packages:');
      expect(observed.diagnostics).toContainEqual(expect.objectContaining({ code: hidden ? 'piProjectRegistrationNotVisible' : 'piNativeObservationUnconfirmed' }));
    });

  it('keeps Pi native facts unknown after a query failure despite configured registration and trust', async () => {
    const item = await fixture('pi', true);
    await fs.outputJson(item.layout.activationPath, { packages: [item.layout.packageRoot] });
    await fs.outputJson(path.join(item.host, 'trust.json'), { [item.ctx.cwd]: true });
    item.ctx.runner = async ({ args, cwd }) => {
      expect(args).toEqual(['list']);
      expect(cwd).toBe(item.binding.scope.kind === 'project' ? item.binding.scope.projectRoot : undefined);
      return { exitCode: 1, stdout: '', stderr: 'query unavailable' };
    };
    const observation = await inspectDeployment(item.ctx, item.binding);
    expect(observation).toMatchObject({ registration: 'unknown', configuration: { activation: 'enabled' } });
    expect(observation.consumers[0]).toMatchObject({ activation: 'unknown', load: 'unknown' });
  });

  it.each(['missing-path', 'unexpected-text'] as const)('does not complete Pi registration from %s output', async (format) => {
    const item = await fixture('pi');
    item.setPiList(`User packages:\n  ${item.layout.packageRoot}\n${format === 'unexpected-text' ? `    ${item.layout.packageRoot}\nUnexpected output\n` : ''}`);
    await fs.outputJson(item.layout.activationPath, { packages: [item.layout.packageRoot] });
    expect((await inspectDeployment(item.ctx, item.binding)).registration).toBe('unknown');
  });

  // Test Value Gate: public User status uses a fresh neutral cwd. It must
  // compare the same consumer inputs as the writer, regardless of cwd files.
  it('keeps Pi User consumer evidence independent of neutral execution directories', async () => {
    const item = await fixture('pi');
    const root = path.join(item.host, 'npm/node_modules/@tintinweb/pi-subagents');
    await consumer(root);
    await fs.outputJson(item.layout.activationPath, { packages: ['npm:@tintinweb/pi-subagents@0.22.0'] });
    await fs.outputJson(path.join(item.host, 'subagents.json'), { packageAgents: true });
    const writer = await createScopeContext({ scope: 'user', cwd: item.ctx.cwd, env: item.ctx.env });
    const reader = await createScopeContext({ scope: 'user', cwd: item.ctx.cwd, env: item.ctx.env, readOnly: true });
    try {
      expect(writer.executionCwd).not.toBe(reader.executionCwd);
      const observe = (cwd: string) => inspectDeployment({ ...item.ctx, cwd }, item.binding);
      const prepared = await observe(writer.executionCwd);
      expect((await observe(reader.executionCwd)).prerequisites).toEqual(prepared.prerequisites);
      await fs.outputJson(path.join(reader.executionCwd, '.pi/settings.json'), { extensions: ['unresolved-project-extension'] });
      await fs.outputJson(path.join(reader.executionCwd, '.pi/subagents.json'), { packageAgents: false });
      expect((await observe(reader.executionCwd)).prerequisites).toEqual(prepared.prerequisites);
      await fs.outputJson(path.join(item.host, 'subagents.json'), { packageAgents: false });
      const changed = await observe(reader.executionCwd);
      expect(changed.prerequisites.agentConsumers.candidates[0]?.packageAccess).toBe('denied');
      expect(changed.prerequisites).not.toEqual(prepared.prerequisites);
    } finally {
      await reader.dispose();
      await writer.dispose();
    }
  });

  // Test Value Gate: Project policy also applies to consumers installed in User
  // scope; fixing User evidence must preserve this cross-scope override.
  it('applies Pi Project package policy to User consumers', async () => {
    const item = await fixture('pi', true);
    const root = path.join(item.host, 'npm/node_modules/@tintinweb/pi-subagents');
    await consumer(root);
    await fs.outputJson(path.join(item.host, 'settings.json'), { packages: ['npm:@tintinweb/pi-subagents@0.22.0'] });
    await fs.outputJson(path.join(item.host, 'subagents.json'), { packageAgents: true });
    const before = await inspectDeployment(item.ctx, item.binding);
    expect(before.prerequisites.agentConsumers.candidates[0]).toMatchObject({ scope: { kind: 'user' }, packageAccess: 'allowed' });
    await fs.outputJson(path.join(item.ctx.cwd, '.pi/subagents.json'), { packageAgents: false });
    const after = await inspectDeployment(item.ctx, item.binding);
    expect(after.prerequisites.agentConsumers.candidates[0]).toMatchObject({ scope: { kind: 'user' }, packageAccess: 'denied' });
    expect(after.prerequisites).not.toEqual(before.prerequisites);
  });

  // Test Value Gate: native relative sources must match their exact scope and
  // installed path; publishing output must not change Agent consumer inputs.
  it.each([false, true])('recognizes Pi relative AW registration on a newer CLI with project=%s', async (project) => {
    const item = await fixture('pi', project);
    item.binding.consumers[0]!.version = '1.6.0';
    const before = await inspectDeployment(item.ctx, item.binding);
    await fs.outputJson(path.join(item.layout.packageRoot, 'package.json'), {
      name: item.layout.nativeIdentity.packageId, version: '1.0.0', pi: { skills: ['./skills'] },
    });
    const source = path.relative(path.dirname(item.layout.activationPath), item.layout.packageRoot);
    await fs.outputJson(item.layout.activationPath, { packages: [source] });
    item.setPiList(`${project ? 'Project' : 'User'} packages:\n  ${source}\n    ${item.layout.packageRoot}\n`);
    const installed = await inspectDeployment(item.ctx, item.binding);
    expect(installed.registration).toBe('present');
    expect(installed.prerequisites).toEqual(before.prerequisites);
    await fs.outputJson(item.layout.activationPath, { packages: [`npm:${source}`] });
    expect((await inspectDeployment(item.ctx, item.binding)).registration).toBe('present');
    item.setPiList(`${project ? 'Project' : 'User'} packages:\n  npm:other-package\n`);
    expect((await inspectDeployment(item.ctx, item.binding)).registration).toBe('absent');
  });

  // Test Value Gate: the current list contract can be parsed on newer Pi
  // versions; unknown structures cannot turn a hidden Project into absence.
  it.each(['Unexpected package inventory', 'Project packages:\n  /source\n    relative-path\n',
    'Project packages:\n  /source\nProject packages:\n  /other\n'])('refuses unknown newer Pi list responses: %s', async (list) => {
    const item = await fixture('pi', true);
    item.binding.consumers[0]!.version = '1.6.0';
    item.setPiList(list);
    const result = await inspectDeployment(item.ctx, item.binding);
    expect(result.registration).toBe('unknown');
    expect(result.consumers[0]).toMatchObject({ activation: 'unknown' });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'piNativeObservationUnconfirmed' }));
  });

  // Test Value Gate: Grok's response version must be valid and match the selected
  // entry; a newer known response retains registration and trust facts.
  it.each(['known', 'invalid-version', 'different-version', 'missing-plugins'] as const)('checks newer Grok response identity: %s', async (boundary) => {
    const item = await fixture('grok', true);
    item.binding.consumers[0]!.version = '1.0.82';
    item.ctx.runner = async ({ args }) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'plugin' ? [] : {
      grokVersion: boundary === 'invalid-version' ? 'invalid' : boundary === 'different-version' ? '1.0.83' : '1.0.82',
      projectTrusted: true, plugins: boundary === 'missing-plugins' ? undefined : [{
        name: item.layout.nativeIdentity.packageId, scope: 'project', path: item.layout.packageRoot, enabled: true,
      }], skills: [], agents: [], mcpServers: [],
    }) });
    const result = await inspectDeployment(item.ctx, item.binding);
    if (boundary === 'known') {
      expect(result.registration).toBe('not-applicable');
      expect(result.consumers[0]).toMatchObject({ activation: 'enabled', load: 'not-observed' });
    } else {
      expect(result.registration).toBe('not-applicable');
      expect(result.consumers[0]).toMatchObject({ activation: 'unknown' });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'nativeObservationFailed' }));
    }
  });

  // Test Value Gate: publishing/registering AW output must not change prepared
  // consumer inputs; real consumer registration and filter changes still do.
  it('keeps Pi consumer inputs stable across AW package publication and registration', async () => {
    const item = await fixture('pi');
    const before = await inspectDeployment(item.ctx, item.binding);
    await fs.outputJson(path.join(item.layout.packageRoot, 'package.json'), { name: item.layout.nativeIdentity.packageId, version: '1.0.0', pi: { skills: ['./skills'] } });
    await fs.outputJson(item.layout.activationPath, { packages: [item.layout.packageRoot] });
    item.setPiList(`User packages:\n  ${item.layout.packageRoot}\n    ${item.layout.packageRoot}\n`);
    const installed = await inspectDeployment(item.ctx, item.binding);
    expect(installed.registration).toBe('present');
    expect(installed.prerequisites).toEqual(before.prerequisites);
    const root = path.join(item.host, 'npm/node_modules/@tintinweb/pi-subagents');
    await consumer(root);
    await fs.outputJson(item.layout.activationPath, { packages: [item.layout.packageRoot, 'npm:@tintinweb/pi-subagents@0.22.0'] });
    const consumerInstalled = await inspectDeployment(item.ctx, item.binding);
    expect(consumerInstalled.prerequisites.agentConsumers.configurationEvidence).not.toBe(installed.prerequisites.agentConsumers.configurationEvidence);
    await fs.outputJson(item.layout.activationPath, { packages: [item.layout.packageRoot, { source: 'npm:@tintinweb/pi-subagents@0.22.0', extensions: [] }] });
    const filtered = await inspectDeployment(item.ctx, item.binding);
    expect(filtered.prerequisites.agentConsumers.candidates[0]?.enabled).toBe('no');
    expect(filtered.prerequisites.agentConsumers.configurationEvidence).not.toBe(consumerInstalled.prerequisites.agentConsumers.configurationEvidence);
  });

  // Test Value Gate: actual config and manifests distinguish absence, filtering,
  // trust and package access without granting unqualified invocation semantics.
  it('reports complete Pi absence and actual installed version/filter/allowlist facts through capabilities', async () => {
    const item = await fixture('pi');
    expect((await inspectDeployment(item.ctx, item.binding)).prerequisites.agentConsumers).toMatchObject({ observation: 'complete', candidates: [] });
    expect((await item.caps()).kinds.agent.reasonCodes).toEqual(['consumer-missing']);
    const root = path.join(item.host, 'npm/node_modules/@tintinweb/pi-subagents');
    await consumer(root);
    await fs.outputJson(item.layout.activationPath, { packages: [{ source: 'npm:@tintinweb/pi-subagents@0.22.0', extensions: [] }] });
    expect((await item.caps()).kinds.agent.reasonCodes).toEqual(['consumer-disabled']);
    await fs.outputJson(item.layout.activationPath, { packages: ['npm:@tintinweb/pi-subagents@0.22.0'] });
    await fs.outputJson(path.join(item.layout.packageRoot, 'package.json'), { name: '@team/example' });
    await fs.outputJson(path.join(item.host, 'subagents.json'), { packageAgents: ['different-package'] });
    const denied = await inspectDeployment(item.ctx, item.binding);
    expect(denied.prerequisites.agentConsumers.candidates[0]).toMatchObject({ id: '@tintinweb/pi-subagents', version: '0.22.0',
      enabled: 'yes', trust: 'trusted', packageAccess: 'denied', settings: { promptMode: 'unknown', loadExtensions: 'unknown' } });
    expect((await item.caps()).kinds.agent.reasonCodes).toEqual(['policy-blocked']);
    await fs.outputJson(path.join(item.host, 'subagents.json'), { packageAgents: ['example'] });
    const allowed = await item.caps();
    expect((await inspectDeployment(item.ctx, item.binding)).prerequisites.agentConsumers.candidates[0]).toMatchObject({
      scope: { kind: 'user' }, packageAccess: 'allowed', trust: 'trusted',
      settings: { promptMode: 'unknown', loadExtensions: 'unknown' } });
    expect(allowed.kinds.agent).toMatchObject({ status: 'unverified', reasonCodes: ['capability-unverified'] });
    await consumer(root, '99.0.0');
    expect((await inspectDeployment(item.ctx, item.binding)).prerequisites.agentConsumers.candidates[0]).toMatchObject({ version: '99.0.0', packageAccess: 'unknown' });
  });

  it('observes project trust independently and does not fabricate a consumer from a source string', async () => {
    const item = await fixture('pi', true);
    const root = path.join(item.ctx.cwd, 'consumer'); await consumer(root);
    await fs.outputJson(item.layout.activationPath, { packages: ['../consumer'] });
    const untrusted = await inspectDeployment(item.ctx, item.binding);
    expect(untrusted.prerequisites.agentConsumers.candidates[0]).toMatchObject({ scope: item.binding.scope, enabled: 'yes', trust: 'required' });
    await fs.outputJson(path.join(item.host, 'trust.json'), { [item.ctx.cwd]: true });
    const trusted = await inspectDeployment(item.ctx, item.binding);
    expect(trusted.prerequisites.agentConsumers.candidates[0]?.trust).toBe('trusted');
    expect(trusted.prerequisites.agentConsumers.configurationEvidence).not.toBe(untrusted.prerequisites.agentConsumers.configurationEvidence);
    await fs.outputJson(item.layout.activationPath, { packages: ['git:https://token@example.invalid/pi-subagents'] });
    const unknown = await inspectDeployment(item.ctx, item.binding);
    expect(unknown.prerequisites.agentConsumers).toMatchObject({ observation: 'unknown', candidates: [] });
    expect(JSON.stringify(unknown)).not.toContain('token');
  });

  // Test Value Gate: native enabled, local disabled and effective resource
  // sources are separate facts, including overlapping compatibility sources.
  it('keeps Grok native activation, local configuration, load and Claude overlap independent', async () => {
    const item = await fixture('grok');
    const name = item.layout.nativeIdentity.packageId;
    const installed = path.join(item.host, 'installed-plugins', 'local-123');
    const compatible = path.join(item.ctx.env!.HOME!, '.claude', 'plugins', 'cache', name);
    await fs.outputJson(path.join(compatible, '.claude-plugin/plugin.json'), { name, version: '2.0.0' });
    const extraNative = path.join(item.ctx.cwd, 'extra-native');
    await fs.outputJson(path.join(extraNative, '.grok-plugin/plugin.json'), { name: 'extra-native', version: '3.0.0' });
    const config = path.join(item.host, 'config.toml');
    await fs.outputFile(config, `[plugins]\nenabled=[]\ndisabled=["${name}"]\n`);
    let active = false;
    const list = [{ status: 'installed', name, repo_key: 'local-123', version: '1.0.0', path: installed, source: item.layout.packageRoot }];
    item.ctx.runner = async ({ args }) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'plugin' ? list : {
      grokVersion: '1.0.77', projectTrusted: false, configSources: { layers: [{ role: 'user', path: config }] },
      plugins: [{ name, scope: 'user', path: installed, enabled: true }, { name, scope: 'user', path: compatible, enabled: true },
        { name: 'extra-native', scope: 'user', path: extraNative, enabled: true },
        { name: 'unknown-extra', scope: 'user', path: path.join(item.ctx.cwd, 'unknown-extra'), enabled: true }],
      skills: [{ name: 'compat-skill', source: { type: 'plugin', plugin_name: name, path: path.join(compatible, 'skills/x/SKILL.md') } },
        ...(active ? [{ name: 'native-skill', source: { type: 'plugin', plugin_name: name, path: path.join(installed, 'skills/y/SKILL.md') } }] : [])],
      agents: [], mcpServers: [], hooks: [{ source: { path: installed } }],
    }) });
    const disabled = await inspectDeployment(item.ctx, item.binding);
    expect(disabled).toMatchObject({ registration: 'present', grokScopeAuthorization: 'denied' });
    expect(disabled.ownership).toBe('absent');
    expect(disabled.consumers[0]).toMatchObject({ activation: 'enabled', load: 'not-observed' });
    expect(disabled.configuration).toMatchObject({ scope: 'user', activation: 'disabled' });
    expect(disabled.prerequisites.nativeSources).toMatchObject({ overlaps: [name], sources: [
      { version: '1.0.0', origin: 'native', effectiveComponents: [] },
      { version: '2.0.0', origin: 'compatibility', effectiveComponents: ['skills:compat-skill'] },
      { version: '3.0.0', origin: 'native', effectiveComponents: [] },
      { version: null, origin: 'unknown', effectiveComponents: [] },
    ] });
    active = true; await fs.outputFile(config, `[plugins]\nenabled=["${name}"]\ndisabled=[]\n`);
    const enabled = await inspectDeployment(item.ctx, item.binding);
    expect(enabled.consumers[0]).toMatchObject({ activation: 'enabled', load: 'observed' });
    expect(enabled.ownership).toBe('absent');
    expect(enabled.prerequisites.nativeSources?.configurationEvidence).not.toBe(disabled.prerequisites.nativeSources?.configurationEvidence);
  });

  it('keeps a discovered but untrusted Grok project package distinct from registration', async () => {
    const item = await fixture('grok', true);
    await fs.ensureDir(item.layout.packageRoot);
    const config = path.join(item.host, 'config.toml'); await fs.outputFile(config, '[plugins]\nenabled=[]');
    item.ctx.runner = async ({ args }) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'plugin' ? [] : {
      grokVersion: '1.0.77', projectTrusted: false, configSources: { layers: [{ role: 'user', path: config }] },
      plugins: [{ name: item.layout.nativeIdentity.packageId, scope: 'project', path: item.layout.packageRoot, enabled: false }], skills: [], agents: [], mcpServers: [],
    }) });
    const observation = await inspectDeployment(item.ctx, item.binding);
    expect(observation).toMatchObject({ registration: 'not-applicable', package: 'present', ownership: 'foreign', grokScopeAuthorization: 'denied' });
    expect(observation.consumers[0]).toMatchObject({ activation: 'disabled', load: 'not-observed' });
  });

  // Test Value Gate: supplemental parse failures must preserve native enabled,
  // trust and effective resource facts for the exact project source.
  it('keeps Grok native facts when supplemental configuration and compatibility metadata are damaged', async () => {
    const item = await fixture('grok', true);
    const name = item.layout.nativeIdentity.packageId;
    const compatibility = path.join(item.ctx.cwd, 'compatibility');
    await fs.outputFile(path.join(compatibility, '.claude-plugin/plugin.json'), '{');
    await fs.outputFile(path.join(item.ctx.cwd, '.grok', 'config.toml'), '[plugins');
    item.ctx.runner = async ({ args }) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'plugin' ? [] : {
      grokVersion: '1.0.77', projectTrusted: true, configSources: { layers: [] },
      plugins: [{ name, scope: 'project', path: item.layout.packageRoot, enabled: true },
        { name, scope: 'project', path: compatibility, enabled: true }],
      skills: [{ name: 'native-skill', source: { plugin_name: name, path: path.join(item.layout.packageRoot, 'skills/demo/SKILL.md') } }],
      agents: [], mcpServers: [],
    }) });
    const observation = await inspectDeployment(item.ctx, item.binding);
    expect(observation.registration).toBe('not-applicable');
    expect(observation.consumers[0]).toMatchObject({ activation: 'enabled', load: 'observed' });
    expect(observation.configuration).toMatchObject({ scope: 'project', activation: 'unknown', reasonCodes: ['grokConfigurationUnconfirmed'] });
    expect(observation.prerequisites.nativeSources).toMatchObject({ observation: 'unknown', sources: [
      { path: item.layout.packageRoot, effectiveComponents: ['skills:native-skill'] }, { path: compatibility, origin: 'unknown' },
    ] });
  });

  // Test Value Gate: a same-version configuration update can change the AW
  // source while Grok's copied marker and discovery still claim current content.
  it('compares actual Grok copy bytes and observes recovery without relying on a copied owner marker or version', async () => {
    const item = await fixture('grok');
    const name = item.layout.nativeIdentity.packageId;
    const installed = path.join(item.host, 'installed-plugins/local-123');
    const oldDigest = await grokPackage(item, 'old body');
    await fs.copy(item.layout.packageRoot, installed);
    const currentDigest = await grokPackage(item, 'new body from configuration');
    await fs.copyFile(path.join(item.layout.packageRoot, SKILL_OWNER_MARKER), path.join(installed, SKILL_OWNER_MARKER));
    const config = path.join(item.host, 'config.toml');
    await fs.outputFile(config, `[plugins]\nenabled=["${name}"]\ndisabled=[]\n`);
    item.ctx.runner = async ({ args }) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'plugin'
      ? [{ status: 'installed', name, repo_key: 'local-123', version: '1.0.0', path: installed, source: item.layout.packageRoot }]
      : { grokVersion: '1.0.77', projectTrusted: true, configSources: { layers: [{ role: 'user', path: config }] },
        plugins: [{ name, scope: 'user', path: installed, enabled: true }],
        skills: [{ name: 'demo', description: 'new body from configuration', source: { type: 'plugin', plugin_name: name, path: path.join(installed, 'skills/demo/SKILL.md') } }],
        agents: [], mcpServers: [] }) });
    const stale = await inspectDeployment(item.ctx, item.binding);
    expect(stale).toMatchObject({ ownership: 'aw', registration: 'present', nativePackageContentDigest: oldDigest,
      nativeIdentity: { packageId: name, registrationId: 'local-123', sourceLocation: item.layout.packageRoot },
      components: [{ id: 'skill', presence: 'unknown', reasonCodes: ['nativePackageContentDrift'] }] });
    expect(stale.diagnostics).toContainEqual(expect.objectContaining({ code: 'nativePackageContentDrift' }));
    await fs.copy(item.layout.packageRoot, installed);
    const restored = await inspectDeployment(item.ctx, item.binding);
    expect(restored.nativePackageContentDigest).toBe(currentDigest);
    expect(restored.components).toEqual([{ id: 'skill', presence: 'present', reasonCodes: [] }]);
    expect(restored.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'nativePackageContentDrift' }));
  });

  it.each(['foreign-source', 'shared-repository', 'outside-store'] as const)('does not claim an exact Grok installation for %s', async (boundary) => {
    const item = await fixture('grok');
    const name = item.layout.nativeIdentity.packageId;
    await grokPackage(item, 'managed body');
    const installed = path.join(item.host, boundary === 'outside-store' ? 'outside/local-123' : 'installed-plugins/local-123');
    await fs.copy(item.layout.packageRoot, installed);
    const row = { status: 'installed', name, repo_key: 'local-123', version: '1.0.0', path: installed,
      source: boundary === 'foreign-source' ? path.join(item.ctx.cwd, 'foreign-source') : item.layout.packageRoot };
    item.ctx.runner = async ({ args }) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'plugin'
      ? [row, ...(boundary === 'shared-repository' ? [{ ...row, name: 'other-plugin' }] : [])]
      : { grokVersion: '1.0.77', projectTrusted: true, configSources: { layers: [] },
        plugins: [{ name, scope: 'user', path: installed, enabled: true }], skills: [], agents: [], mcpServers: [] }) });
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.nativePackageContentDigest).toBeUndefined();
    if (boundary === 'outside-store') expect(observed).toMatchObject({ registration: 'present', ownership: 'unknown' });
    else expect(observed).toMatchObject({ registration: 'present', ownership: boundary === 'foreign-source' ? 'foreign' : 'shared' });
  });

  // Test Value Gate: consumer settings changed after preparation must invalidate
  // the real rebuild execution before it can mutate any native package.
  it.each(['user', 'project'] as const)('rejects a prepared Pi %s operation when actual consumer settings change', async (scope) => {
    const item = await fixture('pi', scope === 'project');
    if (scope === 'project') await fs.ensureDir(path.join(item.ctx.cwd, '.git'));
    const bin = path.join(item.ctx.cwd, 'bin'); await fs.outputFile(path.join(bin, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...item.ctx.env, PATH: bin };
    const root = path.join(item.ctx.cwd, 'empty-pi');
    await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), { schemaVersion: 4, name: 'example', version: '1.0.0', description: 'Empty Pi package.',
      platforms: ['pi'], marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } } });
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    Object.assign(plugin, { sourceId: 'team', pluginId: 'team/example', sourceIdentity: item.binding.plugin.sourceIdentity });
    const context: RebuildExecutionContext = { env, nativeCliRunner: async ({ args }) => ({ exitCode: 0, stdout: args.includes('--help') ? 'Pi coding agent' : '1.5.0', stderr: '' }),
      reporter: createNoopReporter(), debugLogger: createNoopDebugLogger(), preparedArtifactRenderResults: new Map() };
    const integration = createRebuildIntegration({ context });
    try {
      const target = await integration.buildTarget({ plugin, platform: 'pi', scope, cwd: item.ctx.cwd, command: 'sync',
        catalog: { rootDir: root, source: 'local', catalogVersion: '1.0.0' } });
      expect(target.platformDeployment?.plans).toHaveLength(1);
      await fs.outputJson(path.join(scope === 'user' ? item.host : path.join(item.ctx.cwd, '.pi'), 'subagents.json'), { packageAgents: false });
      const result = await executeRebuildOperation({ command: 'sync', target, driver: integration.driver });
      expect(result).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('operationPlanStale') } });
      expect(await fs.pathExists(item.layout.packageRoot)).toBe(false);
    } finally { await context.platformRebuildSession?.dispose(); }
  });

  // Test Value Gate: excluding Grok display facts from package inputs must keep
  // the complete raw policy evidence in the locked rebuild stale check.
  it('rejects a prepared Grok operation when only raw native policy evidence changes', async () => {
    const item = await fixture('grok');
    const bin = path.join(item.ctx.cwd, 'bin');
    await fs.outputFile(path.join(bin, 'grok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...item.ctx.env, PATH: bin };
    const root = path.join(item.ctx.cwd, 'empty-grok');
    await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), { schemaVersion: 4, name: 'example', version: '1.0.0', description: 'Empty Grok package.',
      platforms: ['grok'], marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } } });
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    Object.assign(plugin, { sourceId: 'team', pluginId: 'team/example', sourceIdentity: item.binding.plugin.sourceIdentity });
    let policy = 'off';
    const nativeWrites: string[][] = [];
    const runner: NonNullable<RebuildExecutionContext['nativeCliRunner']> = async ({ args }) => {
      let stdout: string;
      if (args.includes('--version')) stdout = 'grok 1.0.77';
      else if (args.includes('--help')) stdout = 'Grok Build plugin install uninstall update enable disable --json';
      else if (args[0] === 'plugin' && args[1] === 'list') stdout = '[]';
      else if (args[0] === 'inspect') stdout = JSON.stringify({ grokVersion: '1.0.77', configSources: { layers: [] },
        plugins: [], skills: [], agents: [], mcpServers: [], permissions: { mcpManagedServersOnly: policy } });
      else { nativeWrites.push([...args]); stdout = ''; }
      return { exitCode: 0, stdout, stderr: '' };
    };
    const context: RebuildExecutionContext = { env, nativeCliRunner: runner,
      reporter: createNoopReporter(), debugLogger: createNoopDebugLogger(), preparedArtifactRenderResults: new Map() };
    const integration = createRebuildIntegration({ context });
    try {
      const target = await integration.buildTarget({ plugin, platform: 'grok', scope: 'user', cwd: item.ctx.cwd, command: 'sync',
        catalog: { rootDir: root, source: 'local', catalogVersion: '1.0.0' } });
      expect(target.platformDeployment?.plans).toHaveLength(1);
      const read = () => inspectDeployment({ ...item.ctx, env, runner }, item.binding);
      const before = await read();
      policy = 'on';
      const after = await read();
      expect(after).toEqual({ ...before, prerequisites: { ...before.prerequisites,
        nativeSources: { ...before.prerequisites.nativeSources!, configurationEvidence: expect.any(String) } } });
      expect(after.prerequisites.nativeSources?.configurationEvidence).not.toBe(before.prerequisites.nativeSources?.configurationEvidence);
      const result = await executeRebuildOperation({ command: 'sync', target, driver: integration.driver });
      expect(result).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('operationPlanStale') } });
      expect(nativeWrites).toEqual([]);
      expect(await fs.pathExists(item.layout.packageRoot)).toBe(false);
    } finally { await context.platformRebuildSession?.dispose(); }
  });
});
