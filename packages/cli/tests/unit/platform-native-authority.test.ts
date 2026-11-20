import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';
import { inspectDeployment } from '../../src/platforms/inspection.js';
import { inspectCopilotMarketplaceSource } from '../../src/platforms/inspection-native.js';
import { NativeCliError, type NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createNativeQuerySession, queryNativeDeployment, withNativeObservationBatch } from '../../src/platforms/inspection-query.js';
import type { ReadContext, ScopeRef } from '../../src/platforms/contracts.js';

const platforms = ['codex', 'claude', 'copilot'] as const;
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
      version: { codex: '0.167.0', claude: '2.1.317', copilot: '1.0.95' }[platform], reasonCodes: [],
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
    const command = request.args.slice(request.command === process.execPath ? 1 : 0).join(' ');
    if (command !== `plugin list --marketplace ${layout.marketplaceName} --json`
      && !['plugin list --json', 'plugin marketplace list --json'].includes(command)) {
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
    else value = native.installed ? [{ name: layout.nativeIdentity.packageId, marketplace: layout.marketplaceName, enabled: native.enabled }] : [];
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
  };
  const settings = platform === 'codex' ? path.join(layout.activationPath, 'config.toml')
    : path.join(layout.activationPath, project ? 'settings.local.json' : 'settings.json');
  async function configure(enabled: boolean) {
    if (platform === 'codex') await fs.outputFile(settings, `[plugins.${JSON.stringify(id)}]\nenabled = ${enabled}\n`);
    else await fs.outputJson(settings, { enabledPlugins: { [id]: enabled } });
  }
  return { ctx, binding, layout, id, host, native, calls, settings, configure };
}

describe('native deployment state authority', () => {
  // Test Value Gate: a full client inventory serves multiple roots in the same
  // read operation; a new operation and reads outside a session remain fresh.
  it('shares Claude inventories across roots and owns the neutral query directory', async () => {
    const item = await fixture('claude', false);
    const session = createNativeQuerySession();
    const ctx = { ...item.ctx, nativeQuerySession: session };
    let cwd = '';
    try {
      const sibling = { ...item.binding, plugin: { ...item.binding.plugin, pluginId: 'team/sibling' } };
      await Promise.all([inspectDeployment(ctx, item.binding), inspectDeployment(ctx, sibling)]);
      expect(item.calls.map((call) => call.args)).toEqual(expect.arrayContaining([
        ['plugin', 'list', '--json'], ['plugin', 'marketplace', 'list', '--json'],
      ]));
      expect(item.calls).toHaveLength(2);
      cwd = item.calls[0]!.cwd!;
      expect(item.calls.every((call) => call.cwd === cwd)).toBe(true);
      expect(await fs.pathExists(cwd)).toBe(true);
    } finally { await session.dispose(); }
    expect(await fs.pathExists(cwd)).toBe(false);
    await inspectDeployment(item.ctx, item.binding);
    expect(item.calls).toHaveLength(4);
    const next = createNativeQuerySession();
    try { await inspectDeployment({ ...item.ctx, nativeQuerySession: next }, item.binding); }
    finally { await next.dispose(); }
    expect(item.calls).toHaveLength(6);
  });

  // Test Value Gate: scope, real entry, config namespace, source arguments and
  // observation mode must not reuse another native result, even within a session.
  it('shares only matching native inventory inputs', async () => {
    const item = await fixture('claude', false);
    const session = createNativeQuerySession();
    const calls: NativeCliInvocation[] = [];
    const ctx: ReadContext = { ...item.ctx, nativeQuerySession: session, runner: async (invocation) => {
      calls.push(invocation); return { exitCode: 0, stdout: '[]', stderr: '' };
    } };
    const args = (cwd: string) => ['plugin', 'list', '--location', cwd, '--json'];
    try {
      expect(await queryNativeDeployment(ctx, item.binding, args)).toBe('[]');
      expect(await queryNativeDeployment(ctx, item.binding, args)).toBe('[]');
      expect(calls).toHaveLength(1);
      await queryNativeDeployment(ctx, { ...item.binding, scope: { kind: 'project', projectRoot: ctx.cwd } }, args);
      const product = item.binding.consumers[0]!;
      await queryNativeDeployment(ctx, { ...item.binding, consumers: [{ ...product,
        entry: { kind: 'cli', executable: path.join(ctx.cwd, 'other-client'), configRoot: item.host } }] }, args);
      await queryNativeDeployment(ctx, { ...item.binding, consumers: [{ ...product,
        entry: { kind: 'cli', executable: path.join(ctx.cwd, 'claude'), configRoot: path.join(item.host, 'other') } }] }, args);
      await queryNativeDeployment(ctx, item.binding, ['plugin', 'list', '--marketplace', 'other-source', '--json']);
      await queryNativeDeployment({ ...ctx, env: { ...ctx.env, CLAUDE_CONFIG_DIR: path.join(item.host, 'alternate') } }, item.binding, args);
      await queryNativeDeployment({ ...ctx, observeNative: true }, item.binding, args);
      expect(calls).toHaveLength(7);
      expect(calls[0]!.cwd).not.toBe(calls[1]!.cwd);
      expect(calls[0]!.args).toEqual(['plugin', 'list', '--location', calls[0]!.cwd, '--json']);
    } finally { await session.dispose(); }
    expect((await Promise.all(calls.filter((call) => call.cwd !== ctx.cwd).map((call) => fs.pathExists(call.cwd!)))).every((present) => !present)).toBe(true);
  });

  // Test Value Gate: one failed snapshot preserves its native reason without
  // retry storms, but a new operation retries and cancellation cannot return cache.
  it('retains native failure evidence only inside its operation', async () => {
    const item = await fixture('claude', false);
    const cwds: string[] = [];
    const failure = new NativeCliError({ invocation: { command: 'claude', args: [] }, exitCode: 124,
      stdout: '', stderr: '', reason: 'timeout' });
    const controller = new AbortController();
    const cancellation = new Error('cancelled');
    let recovered = false;
    const runner = async (invocation: NativeCliInvocation) => {
      cwds.push(invocation.cwd!);
      if (!recovered) throw failure;
      return { exitCode: 0, stdout: '[]', stderr: '' };
    };
    const read = (ctx: ReadContext) => queryNativeDeployment(ctx, item.binding, ['plugin', 'list', '--json']);
    await expect(withNativeObservationBatch({ runner, signal: controller.signal }, async (batch) => {
      const ctx = { ...item.ctx, ...batch };
      await expect(read(ctx)).rejects.toBe(failure);
      await expect(read(ctx)).rejects.toBe(failure);
      expect(cwds).toHaveLength(1);
      controller.abort(cancellation);
      await expect(read(ctx)).rejects.toBe(cancellation);
      expect(cwds).toHaveLength(1);
      throw cancellation;
    })).rejects.toBe(cancellation);
    expect(await fs.pathExists(cwds[0]!)).toBe(false);

    recovered = true;
    await withNativeObservationBatch({ runner }, async (batch) => {
      await expect(read({ ...item.ctx, ...batch })).resolves.toBe('[]');
    });
    expect(cwds).toHaveLength(2);
    expect(cwds[1]).not.toBe(cwds[0]);
    expect(await fs.pathExists(cwds[1]!)).toBe(false);
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
    expect(observed.consumers[0]).not.toHaveProperty('trust');
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

  // A Windows Copilot marketplace read can time out beside a healthy plugin
  // list. Sibling inspections must share bounded, fresh marketplace evidence.
  it.each(['healthy', 'canonical after timeout', 'foreign after timeout', 'persistent timeout', 'cleanup failed', 'exit 124', 'cancelled'] as const)(
    'preserves Windows Copilot marketplace evidence on %s', async (scenario) => {
      const item = await fixture('copilot');
      const product = item.binding.consumers[0]!;
      const binding = { ...item.binding, consumers: [{ ...product, entry: { kind: 'cli' as const,
        executable: path.join(item.ctx.cwd, 'npm-loader.js'), configRoot: item.host } }] };
      let reads = 0;
      const controller = new AbortController();
      const runner = async (invocation: NativeCliInvocation) => {
        if (invocation.args.includes('marketplace')) {
          reads++;
          if (scenario === 'exit 124') return { exitCode: 124, stdout: '', stderr: '' };
          if (scenario === 'cancelled') controller.abort();
          if (scenario === 'persistent timeout' || reads === 1 && scenario !== 'healthy') {
            throw new NativeCliError({ invocation, reason: 'timeout', exitCode: 124, stdout: '', stderr: '',
              ...(scenario === 'cleanup failed' ? { cleanupError: new Error('unconfirmed') } : {}) });
          }
        }
        return item.ctx.runner!(invocation);
      };
      item.native.marketplace = scenario === 'foreign after timeout' ? 'foreign' : 'canonical';
      await withNativeObservationBatch({ runner, signal: controller.signal }, async (batch) => {
        const ctx = { ...item.ctx, ...batch, platform: 'win32' as const };
        const read = () => inspectCopilotMarketplaceSource(ctx, binding, item.layout.marketplaceName!, item.layout.marketplaceRoot!);
        const observed = Promise.all([read(), read()]);
        if (scenario === 'foreign after timeout') await expect(observed).resolves.toEqual(['foreign', 'foreign']);
        else if (scenario === 'healthy' || scenario === 'canonical after timeout') await expect(observed).resolves.toEqual(['canonical', 'canonical']);
        else if (scenario === 'cancelled') await expect(observed).rejects.toMatchObject({ name: 'AbortError' });
        else await expect(observed).rejects.toMatchObject({ reason: scenario === 'exit 124' ? 'exit' : 'timeout' });
      });
      expect(reads).toBe(['canonical after timeout', 'foreign after timeout', 'persistent timeout'].includes(scenario) ? 2 : 1);
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
});
