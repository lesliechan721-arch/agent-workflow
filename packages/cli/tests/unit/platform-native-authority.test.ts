import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';
import { deploymentPackageComponent, inspectDeployment } from '../../src/platforms/inspection.js';
import { geminiExtensionPaths, geminiScopePattern } from '../../src/platforms/gemini-activation.js';
import { readPlatformPackageContentDigest } from '../../src/utils/platform-empty-state.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { NativeCliError, type NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { ReadContext, ScopeRef } from '../../src/platforms/contracts.js';

const platforms = ['codex', 'claude', 'gemini', 'copilot'] as const;
type Platform = typeof platforms[number];

async function fixture(platform: Platform, project = true) {
  const isolated = getCurrentSourceTestIsolation();
  const cwd = isolated.layout.fixtureCwd;
  const ctx: ReadContext = { cwd, env: isolated.env };
  const scope: ScopeRef = project ? { kind: 'project', projectRoot: cwd } : { kind: 'user' };
  const host = resolvePlatformConfigRoot(platform, ctx);
  const resolved = await resolveDeployments(ctx, { plugin: { sourceId: 'team', sourceIdentity: `sha256:${'a'.repeat(64)}`,
    pluginId: 'team/example', version: '1.0.0' }, operation: 'ensure', scope, recoveryCandidates: [], discovery: {
    platform, availability: 'available', diagnostics: [], installations: [{ id: 'client', product: 'cli', availability: 'available',
      version: { codex: '0.167.0', claude: '2.1.317', gemini: '0.67.0', copilot: '1.0.95' }[platform], reasonCodes: [],
      entry: { kind: 'cli', executable: path.join(cwd, platform), configRoot: host } }],
  } });
  const binding = resolved.bindings[0]!;
  const layout = await getDeploymentLayout(ctx, binding);
  const id = layout.nativeIdentity.registrationId ?? layout.nativeIdentity.packageId;
  const calls: NativeCliInvocation[] = [];
  const native = { enabled: true, installed: true, fail: false, marketplaceFail: false,
    marketplace: 'canonical' as 'canonical' | 'foreign' | 'absent', folder: true,
    claudeScope: 'user' as 'user' | 'managed' | 'project' | 'local', claudeProjectPath: cwd };
  ctx.runner = async (request) => {
    calls.push(request);
    const command = request.args.join(' ');
    if (command !== `plugin list --marketplace ${layout.marketplaceName} --json`
      && !['plugin list --json', 'plugin marketplace list --json', 'extensions list --output-format json'].includes(command)) {
      throw new Error('Unexpected native query.');
    }
    if (native.fail || native.marketplaceFail && request.args.includes('marketplace')) {
      return { exitCode: 1, stdout: '', stderr: 'Native query failed.' };
    }
    let value: unknown;
    if (request.args.includes('marketplace')) {
      const root = native.marketplace === 'foreign' ? path.join(cwd, 'foreign-marketplace') : layout.marketplaceRoot;
      value = native.marketplace === 'absent' ? [] : [{ name: layout.marketplaceName,
        source: platform === 'claude' ? 'directory' : root, path: root, installLocation: root }];
    }
    else if (platform === 'codex') value = { installed: native.installed ? [{ pluginId: id, installed: true, enabled: native.enabled }] : [], available: [] };
    else if (platform === 'claude') value = native.installed ? [{ id, scope: native.claudeScope, enabled: native.enabled,
      ...(['local', 'project'].includes(native.claudeScope) ? { projectPath: native.claudeProjectPath } : {}),
      version: '1.0.0', installPath: path.join(host, 'cache', 'example'), ...(native.folder ? { readFromFolder: layout.packageRoot } : {}) }] : [];
    else if (platform === 'gemini') value = native.installed ? [{ name: id, isActive: native.enabled,
      path: path.join(geminiExtensionPaths(ctx).root, id), installMetadata: { type: 'local', source: layout.packageRoot } }] : [];
    else value = native.installed ? [{ name: layout.nativeIdentity.packageId, marketplace: layout.marketplaceName, enabled: native.enabled }] : [];
    return platform === 'gemini'
      ? { exitCode: 0, stdout: '', stderr: `${JSON.stringify(value)}\n` }
      : { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
  };
  const settings = platform === 'codex' ? path.join(layout.activationPath, 'config.toml')
    : platform === 'gemini' ? geminiExtensionPaths(ctx).file
      : path.join(layout.activationPath, project ? 'settings.local.json' : 'settings.json');
  async function configure(enabled: boolean) {
    if (platform === 'codex') await fs.outputFile(settings, `[plugins.${JSON.stringify(id)}]\nenabled = ${enabled}\n`);
    else if (platform === 'gemini') await fs.outputJson(settings, { [id]: { overrides: project
      ? ['!*', `${enabled ? '' : '!'}${geminiScopePattern(cwd)}`] : [enabled ? '*' : '!*'] } });
    else await fs.outputJson(settings, { enabledPlugins: { [id]: enabled } });
  }
  return { ctx, binding, layout, id, host, native, calls, settings, configure };
}

describe('native deployment state authority', () => {
  // Test Value Gate: Gemini 0.67 writes its empty inventory to stderr, not stdout.
  it('reads the Gemini empty stderr inventory as absent', async () => {
    const item = await fixture('gemini', false);
    item.native.installed = false;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('absent');
    expect(observed.diagnostics).toEqual([]);
  });

  // Test Value Gate: native disabled remains authoritative over local enablement.
  it('reads Gemini disabled activation from stderr despite local enablement', async () => {
    const item = await fixture('gemini');
    await item.configure(true);
    item.native.enabled = false;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('disabled');
    expect(observed.configuration?.activation).toBe('enabled');
  });

  // Test Value Gate: invalid or ambiguous streams cannot authorize native absence or activation.
  it.each([
    { label: 'empty streams', stdout: '', stderr: '' },
    { label: 'stdout-only JSON', stdout: '[]', stderr: '' },
    { label: 'conflicting streams', stdout: '[{"name":"demo","isActive":true,"path":"/native/demo"}]', stderr: '[]\n' },
    { label: 'invalid JSON', stdout: '', stderr: 'Warning\n[]' },
    { label: 'invalid envelope', stdout: '', stderr: '{}' },
    { label: 'invalid row', stdout: '', stderr: '[null]' },
    { label: 'missing identity', stdout: '', stderr: '[{"isActive":true,"path":"/native/demo"}]' },
    { label: 'invalid activation', stdout: '', stderr: '[{"name":"demo","isActive":"true","path":"/native/demo"}]' },
    { label: 'invalid path', stdout: '', stderr: '[{"name":"demo","isActive":true,"path":null}]' },
  ])('keeps Gemini state unknown for $label', async ({ stdout, stderr }) => {
    const item = await fixture('gemini');
    await item.configure(true);
    item.ctx.runner = async () => ({ exitCode: 0, stdout, stderr });
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('unknown');
    expect(observed.consumers[0]?.activation).toBe('unknown');
    expect(observed.configuration?.activation).toBe('enabled');
  });

  // Test Value Gate: valid inventory bytes cannot hide native exit, timeout, or cleanup failures.
  it.each(['exit', 'timeout', 'cleanup', 'aborted'] as const)('rejects Gemini %s failures with valid stderr JSON', async (failure) => {
    const item = await fixture('gemini');
    item.ctx.runner = async (invocation) => {
      if (failure === 'exit') return { exitCode: 1, stdout: '', stderr: '[]\n' };
      throw new NativeCliError({ invocation, exitCode: failure === 'timeout' ? 124 : 1, stdout: '', stderr: '[]\n',
        ...(failure === 'cleanup' ? { cleanupError: new Error('cleanup unconfirmed') } : { reason: failure }) });
    };
    const pending = inspectDeployment(item.ctx, item.binding);
    if (failure === 'cleanup' || failure === 'aborted') {
      await expect(pending).rejects.toMatchObject({ name: 'NativeCliError',
        ...(failure === 'cleanup' ? { cleanupError: expect.any(Error) } : { reason: 'aborted' }) });
    } else {
      const observed = await pending;
      expect(observed.registration).toBe('unknown');
      expect(observed.consumers[0]?.activation).toBe('unknown');
    }
  });

  // Test Value Gate: conflicting local entries must not replace native effective activation.
  it.each(platforms)('preserves %s native enabled when local activation is disabled', async (platform) => {
    const item = await fixture(platform);
    await item.configure(false);
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.configuration).toMatchObject({ scope: 'project', activation: 'disabled' });
    expect(item.calls.some((call) => call.cwd === item.ctx.cwd)).toBe(true);
  });

  // Test Value Gate: inherited native activation is distinct from an independent project entry.
  it.each(platforms)('preserves %s inherited activation without a project entry', async (platform) => {
    const item = await fixture(platform);
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.configuration).toMatchObject({ scope: 'project', activation: 'absent' });
  });

  // Test Value Gate: supplemental parse failures cannot erase successful native facts.
  it.each(platforms)('keeps %s native facts when local configuration is malformed', async (platform) => {
    const item = await fixture(platform);
    await fs.outputFile(item.settings, '{ invalid');
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.configuration).toMatchObject({ activation: 'unknown' });
    expect(observed.configuration?.reasonCodes.length).toBeGreaterThan(0);
  });

  // Test Value Gate: a failed native query cannot use local enablement as a fallback.
  it.each(platforms)('keeps %s native state unknown after a failed query', async (platform) => {
    const item = await fixture(platform);
    await item.configure(true);
    item.native.fail = true;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('unknown');
    expect(observed.consumers[0]?.activation).toBe('unknown');
    expect(observed.configuration).toMatchObject({ activation: 'enabled' });
    if (platform === 'claude') expect(observed.scopeRegistration).toBe('unknown');
  });

  // Test Value Gate: inherited and shared-project registrations cannot replace
  // the exact installation record needed for an independent AW scope.
  it.each([
    { scope: 'user', project: true, registered: 'absent' },
    { scope: 'local', project: true, registered: 'present' },
    { scope: 'project', project: true, registered: 'absent' },
    { scope: 'managed', project: false, registered: 'absent' },
    { scope: 'user', project: false, registered: 'present' },
  ] as const)('reports Claude $scope installation independently in project=$project', async ({ scope, project, registered }) => {
    const item = await fixture('claude', project);
    item.native.claudeScope = scope;
    await item.configure(true);
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed).toMatchObject({ registration: 'present', scopeRegistration: registered });
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.consumers[0]?.trust).toBe('unknown');
  });

  // Test Value Gate: another project's local record cannot authorize this scope.
  it('does not claim a Claude local registration from another project', async () => {
    const item = await fixture('claude');
    item.native.claudeScope = 'local';
    item.native.claudeProjectPath = path.join(item.ctx.cwd, 'other-project');
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed).toMatchObject({ registration: 'absent', scopeRegistration: 'absent' });
  });

  // Test Value Gate: User inventory must not include the caller project's merged settings.
  it.each(platforms)('runs %s User queries outside the caller project', async (platform) => {
    const item = await fixture(platform, false);
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(item.calls.length).toBeGreaterThan(0);
    expect(item.calls.every((call) => call.cwd !== item.ctx.cwd && !call.cwd.startsWith(`${item.ctx.cwd}${path.sep}`))).toBe(true);
  });

  // Test Value Gate: marketplace ownership failure cannot erase the independent plugin inventory.
  it.each(['claude', 'copilot'] as const)('keeps %s native activation when marketplace lookup fails', async (platform) => {
    const item = await fixture(platform);
    item.native.marketplaceFail = true;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.ownership).toBe('unknown');
  });

  // Test Value Gate: a native identity with an absent source cannot authorize shared package removal.
  it.each(['claude', 'copilot'] as const)('keeps %s ownership unknown when the native source is absent', async (platform) => {
    const item = await fixture(platform);
    item.native.marketplace = 'absent';
    item.native.folder = false;
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.ownership).toBe('unknown');
  });

  // Test Value Gate: unrecognized row source fields must retain a confirmed foreign marketplace conflict.
  it.each(['claude', 'copilot'] as const)('keeps %s foreign marketplace ownership beside native activation', async (platform) => {
    const item = await fixture(platform);
    item.native.marketplace = 'foreign';
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.ownership).toBe('foreign');
  });

  // Test Value Gate: installed native copies remain observable when their local identity is unreadable.
  it('keeps Gemini native facts when copied metadata is malformed', async () => {
    const item = await fixture('gemini');
    const root = path.join(geminiExtensionPaths(item.ctx).root, item.id);
    await fs.outputFile(path.join(root, '.gemini-extension-install.json'), '{ invalid');
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed.registration).toBe('present');
    expect(observed.consumers[0]?.activation).toBe('enabled');
    expect(observed.ownership).toBe('unknown');
    expect(observed.nativePackageContentDigest).toBeUndefined();
  });

  // Test Value Gate: the actual native copy's owner and digest remain required maintenance evidence.
  it('keeps the Gemini installed copy digest beside native effective activation', async () => {
    const item = await fixture('gemini');
    await fs.outputJson(path.join(item.layout.packageRoot, 'gemini-extension.json'), { name: item.id, version: '1.0.0' });
    const digest = (await readPlatformPackageContentDigest(item.layout.packageRoot))!;
    await writeSkillOwnerMarker({ skillRoot: item.layout.packageRoot, allowedRoot: path.dirname(item.layout.packageRoot),
      identity: deploymentPackageComponent(item.binding, item.layout).identity,
      nativeProjection: { physicalIdentity: item.layout.physicalIdentity, preparation: 'complete', inputDigest: `sha256:${'b'.repeat(64)}`,
        contentDigest: digest, components: [] } });
    const root = path.join(geminiExtensionPaths(item.ctx).root, item.id);
    await fs.copy(item.layout.packageRoot, root);
    await fs.outputJson(path.join(root, '.gemini-extension-install.json'), { type: 'local', source: item.layout.packageRoot });
    const observed = await inspectDeployment(item.ctx, item.binding);
    expect(observed).toMatchObject({ ownership: 'aw', registration: 'present', nativePackageContentDigest: digest });
    expect(observed.consumers[0]?.activation).toBe('enabled');
  });
});
