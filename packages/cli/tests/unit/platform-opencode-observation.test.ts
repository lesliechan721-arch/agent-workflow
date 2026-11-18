import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import type { ReadContext, ScopeRef } from '../../src/platforms/contracts.js';
import { unknownDeployment } from '../../src/platforms/inspection.js';
import { inspectOpenCodeDeployment } from '../../src/platforms/inspection-opencode.js';
import { getDeploymentLayout, getDeploymentResourceKey, resolveDeployments } from '../../src/platforms/layout.js';
import { NativeCliError, type NativeCliInvocation, type NativeCliRunner } from '../../src/utils/native-cli.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(scope: 'user' | 'project' = 'project', version = '2.0.0') {
  const isolated = getCurrentSourceTestIsolation();
  const cwd = isolated.layout.fixtureCwd;
  const ctx: ReadContext = { cwd, env: isolated.env };
  const scopeRef: ScopeRef = scope === 'project' ? { kind: 'project', projectRoot: cwd } : { kind: 'user' };
  const resolved = await resolveDeployments(ctx, {
    plugin: { sourceId: 'team', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'team/example', version: '1.0.0' },
    operation: 'ensure', scope: scopeRef, recoveryCandidates: [], discovery: {
      platform: 'opencode', availability: 'available', diagnostics: [], installations: [{
        id: 'client', product: 'cli', availability: 'available', version, reasonCodes: [],
        entry: { kind: 'cli', executable: path.join(cwd, 'opencode'), configRoot: path.join(isolated.env.XDG_CONFIG_HOME!, 'opencode') },
      }],
    },
  });
  const binding = resolved.bindings[0]!;
  const layout = await getDeploymentLayout(ctx, binding);
  const result = unknownDeployment(binding);
  result.diagnostics = [];
  result.package = 'absent';
  result.configuration = { scope, activation: 'disabled', reasonCodes: [] };
  const row = (status: 'active' | 'failed' = 'active') => ({ id: getDeploymentResourceKey(binding.plugin),
    source: { type: 'local', path: path.join(layout.packageRoot, 'index.mjs') }, features: { server: true },
    state: status === 'active' ? { status } : { status, error: 'Plugin setup failed' } });
  const response = (invocation: NativeCliInvocation, data: unknown[]) => ({ exitCode: 0,
    stdout: JSON.stringify({ location: { directory: invocation.cwd }, data }), stderr: '' });
  const observe = async (runner?: NativeCliRunner, observeNative = true) => {
    await inspectOpenCodeDeployment({ ...ctx, runner, observeNative }, binding, layout, result);
    return result;
  };
  return { ctx, binding, layout, result, row, response, observe };
}

describe('OpenCode native deployment observation', () => {
  // Test Value Gate: routine status must not start a service or infer disabled from missing AW output.
  it('keeps native state unknown without explicit observation', async () => {
    const item = await fixture();
    let calls = 0;
    const result = await item.observe(async () => { calls += 1; throw new Error('Unexpected native process'); }, false);
    expect(calls).toBe(0);
    expect(result).toMatchObject({ package: 'absent', ownership: 'unknown', registration: 'not-applicable',
      consumers: [{ activation: 'unknown', load: 'unknown' }] });
  });

  // Test Value Gate: exact native activation and loading must survive contradictory local scope and ownership evidence.
  it.each(['directory', 'entrypoint'] as const)('retains active state from a local %s with one private API request', async (sourceForm) => {
    const item = await fixture();
    item.binding.consumers.push({ id: 'desktop', product: 'app', availability: 'available', version: '2.0.0', reasonCodes: [],
      entry: { kind: 'directory', configRoot: path.dirname(item.layout.activationPath) } });
    item.result.consumers.push({ productId: 'desktop', activationKey: item.binding.activationKey,
      activation: 'unknown', load: 'unknown' });
    const calls: NativeCliInvocation[] = [];
    const result = await item.observe(async (invocation) => {
      calls.push(invocation);
      expect(invocation.cwd).toBe(item.ctx.cwd);
      expect(invocation.args).toHaveLength(4);
      expect(invocation.args.slice(0, 2)).toEqual(['api', 'GET']);
      expect(invocation.args[3]).toBe('--standalone');
      const request = new URL(invocation.args[2]!, 'http://127.0.0.1');
      expect(request.pathname).toBe('/api/plugin');
      expect([...request.searchParams]).toEqual([['location[directory]', invocation.cwd!]]);
      expect(invocation.env).toMatchObject({ OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' });
      expect(invocation.timeoutMs).toBeGreaterThan(0);
      const row = item.row();
      if (sourceForm === 'directory') row.source.path = item.layout.packageRoot;
      return item.response(invocation, [row]);
    });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ package: 'absent', ownership: 'unknown', registration: 'not-applicable',
      configuration: { activation: 'disabled' }, consumers: [
        { productId: 'client', activation: 'enabled', load: 'observed' },
        { productId: 'desktop', activation: 'unknown', load: 'unknown' },
      ] });
  });

  // Test Value Gate: a User API request must bind to its neutral directory and must not load caller project configuration.
  it('binds User results to a disposed neutral directory', async () => {
    const item = await fixture('user');
    let queryCwd: string | undefined;
    await item.observe(async (invocation) => {
      queryCwd = invocation.cwd;
      expect(queryCwd).not.toBe(item.ctx.cwd);
      expect(new URL(invocation.args[2]!, 'http://127.0.0.1').searchParams.get('location[directory]')).toBe(queryCwd);
      expect(invocation.env?.OPENCODE_CONFIG_PROJECT_DISABLE).toBe('1');
      return item.response(invocation, [item.row()]);
    });
    expect(item.result.consumers[0]).toMatchObject({ activation: 'enabled', load: 'observed' });
    expect(await fs.pathExists(queryCwd!)).toBe(false);
  });

  // Test Value Gate: native setup failure is load evidence; it does not prove that configuration disabled the plugin.
  it.each([true, false])('keeps failed activation unknown with native ID present=%s', async (includeId) => {
    const item = await fixture();
    const row: Record<string, unknown> = item.row('failed');
    if (!includeId) delete row.id;
    await item.observe(async (invocation) => item.response(invocation, [row]));
    expect(item.result.consumers[0]).toMatchObject({ activation: 'unknown', load: 'not-observed' });
    expect(item.result.diagnostics).toContainEqual(expect.objectContaining({ code: 'opencodePluginLoadFailed' }));
  });

  // Test Value Gate: cold inventory, identity collisions, unsupported states, and wrong locations cannot establish native status.
  it.each(['empty', 'foreign-source', 'wrong-id', 'duplicate', 'disabled', 'wrong-location', 'invalid-json'] as const)(
    'keeps %s native results unknown', async (kind) => {
      const item = await fixture();
      await item.observe(async (invocation) => {
        let rows: unknown[] = [item.row()];
        if (kind === 'empty') rows = [];
        if (kind === 'foreign-source') rows = [{ ...item.row(), source: { type: 'local', path: path.join(item.layout.packageRoot, 'foreign.mjs') } }];
        if (kind === 'wrong-id') rows = [{ ...item.row(), id: 'other-plugin' }];
        if (kind === 'duplicate') rows.push(item.row());
        if (kind === 'disabled') rows = [{ ...item.row(), state: { status: 'disabled' } }];
        const response = item.response(invocation, rows);
        if (kind === 'wrong-location') response.stdout = JSON.stringify({ location: { directory: path.dirname(invocation.cwd!) }, data: rows });
        if (kind === 'invalid-json') response.stdout = 'ID VERSION SOURCE';
        return response;
      });
      expect(item.result.consumers[0]).toMatchObject({ activation: 'unknown', load: 'unknown' });
      expect(item.result.registration).toBe('not-applicable');
      expect(item.result.configuration?.activation).toBe('disabled');
      expect(item.result.diagnostics.length).toBeGreaterThan(0);
    },
  );

  // Test Value Gate: API failure must not fall back to owned or absent local directories.
  it('retains native query failure without replacing local package facts', async () => {
    const item = await fixture();
    item.result.package = 'present';
    item.result.ownership = 'aw';
    await item.observe(async () => ({ exitCode: 1, stdout: '', stderr: 'HTTP 500 failed' }));
    expect(item.result).toMatchObject({ package: 'present', ownership: 'aw',
      consumers: [{ activation: 'unknown', load: 'unknown' }] });
    expect(item.result.diagnostics).toContainEqual(expect.objectContaining({ code: 'opencodeNativeObservationFailed' }));
  });

  // Test Value Gate: newer CLIs use the actual V2 response; older CLIs do not start a service.
  it('accepts a newer CLI response and keeps the interface minimum', async () => {
    const item = await fixture('project', '2.0.1');
    let calls = 0;
    await item.observe(async (invocation) => { calls += 1; return item.response(invocation, [item.row()]); });
    expect(calls).toBe(1);
    expect(item.result.consumers[0]).toMatchObject({ activation: 'enabled', load: 'observed' });
    const old = await fixture('project', '1.9.9');
    await old.observe(async () => { throw new Error('Unexpected native process'); });
    expect(old.result.consumers[0]).toMatchObject({ activation: 'unknown', load: 'unknown' });
    expect(old.result.diagnostics).toContainEqual(expect.objectContaining({ code: 'opencodeNativeVersionUnverified' }));
  });

  // Test Value Gate: cancellation and unconfirmed process cleanup must reach the operation owner.
  it.each(['aborted', 'cleanup'] as const)('preserves fatal native %s failures', async (kind) => {
    const item = await fixture();
    let failure: NativeCliError | undefined;
    const caught = await item.observe(async (invocation) => {
      failure = new NativeCliError({ invocation, exitCode: 1, stdout: '', stderr: '',
        reason: kind === 'aborted' ? 'aborted' : 'timeout',
        ...(kind === 'cleanup' ? { cleanupError: new Error('Process cleanup unconfirmed') } : {}) });
      throw failure;
    }).catch((error: unknown) => error);
    expect(failure !== undefined && caught === failure).toBe(true);
  });
});
