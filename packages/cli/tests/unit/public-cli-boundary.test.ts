import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/index.js';
import path from 'node:path';
import fs from 'fs-extra';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { projectReceipt } from '../../src/output/receipt-projection.js';
import { renderPublicResult } from '../../src/output/public-result.js';

async function invoke(args: string[], options: Parameters<typeof runCli>[1] = {}) {
  let stdout = '';
  let stderr = '';
  let prompts = 0;
  const code = await runCli(args, {
    ...options,
    interactive: true,
    prompt: { confirm: async () => { prompts++; throw new Error('A CLI command must not prompt.'); } },
    io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr, prompts };
}

describe('public CLI result boundary', () => {
  // Test Value Gate: the explicit status mode must be accepted and disclose native startup effects in both outputs.
  it.each([false, true])('keeps user-only status free of app-server startup (observeNative=%s)', async (observeNative) => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const calls: string[][] = [];
    const output = await invoke(['plugin', 'status', '--context', 'user', ...(observeNative ? ['--observe-native'] : []), '--json'], {
      cwd: layout.fixtureCwd, env,
      nativeCliRunner: async (invocation) => {
        calls.push(invocation.args);
        throw new Error('No native client is needed without a requirement.');
      },
    });
    const result = JSON.parse(output.stdout);
    expect(result.command).toBe('plugin.status');
    expect(result.diagnostics.some((entry: { code: string }) => entry.code === 'nativeObservationSideEffects')).toBe(observeNative);
    expect(output.stderr.includes('nativeObservationSideEffects')).toBe(observeNative);
    expect(calls.some((args) => args.includes('app-server'))).toBe(false);
    expect(output.prompts).toBe(0);
  });

  // Protect useful local evidence when a separate read-only remote probe fails.
  it('keeps local source facts and partial status when the remote path goes offline', async () => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const source = path.join(layout.fixtureCwd, 'offline-source');
    await createDependencyCatalogSnapshotFixture(source, [{ name: 'demo' }]);
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    await fs.remove(source);
    const output = await invoke(['source', 'status', 'team', '--remote', '--json'], { cwd: layout.fixtureCwd, env });
    expect(output.code, output.stderr).toBe(4);
    expect(JSON.parse(output.stdout)).toMatchObject({ status: 'partial', data: { sources: [expect.objectContaining({ sourceId: 'team', activeReady: true })], remote: [expect.objectContaining({ sourceId: 'team', checked: false })] }, diagnostics: expect.arrayContaining([expect.objectContaining({ severity: 'error', subject: { sourceId: 'team' } })]) });
  });

  // A human must be able to bind apply to the exact prepared plan without JSON.
  it('renders the prepared publication identity and an unconfirmed exact next step', () => {
    const planDigest = `sha256:${'a'.repeat(64)}`;
    const result = projectReceipt('dev.catalog.publish.plan', { ok: true, state: 'prepared', planDigest, workspaceRoot: '/workspace', catalogVersion: '1.0.0', remote: 'release', branch: 'catalog-beta', tag: 'catalog-v1.0.0' });
    const text = renderPublicResult(result);
    for (const fact of ['prepared', planDigest, 'release', 'catalog-beta', 'catalog-v1.0.0']) expect(text).toContain(fact);
    expect(result.nextActions).toContainEqual(expect.objectContaining({ kind: 'command', argv: ['aw', 'dev', 'catalog', 'publish', 'apply', '--workspace-root', '/workspace', '--remote', 'release', '--branch', 'catalog-beta', '--expected-plan-digest', planDigest], requiresConfirmation: true }));
    expect(text).not.toContain('--yes');
  });

  // Missing prerequisites must guide explicit creation and leave the folder alone.
  it.each([
    ['dev', 'plugin', 'create', 'demo'],
    ['dev', 'plugin', 'create', 'demo', '--workspace-root', '.'],
    ['dev', 'plugin', 'build', 'plugins/demo'],
    ['dev', 'catalog', 'version'],
    ['dev', 'catalog', 'publish', 'plan'],
  ].map((args) => [args]))('guides explicit workspace creation for %j', async (args) => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const cwd = path.join(layout.fixtureCwd, 'empty-author-folder');
    await fs.ensureDir(cwd);
    const output = await invoke([...args, '--json'], { cwd, env });
    expect(output.code, output.stdout + output.stderr).toBe(3);
    expect(JSON.parse(output.stdout)).toMatchObject({ status: 'blocked', diagnostics: [expect.objectContaining({ code: 'catalogWorkspaceMissing' })], nextActions: [{ kind: 'command', argv: ['aw', 'dev', 'catalog', 'create', ...(args.includes('--workspace-root') ? ['--workspace-root', args[args.indexOf('--workspace-root') + 1]!] : [])], requiresConfirmation: false }] });
    expect(await fs.readdir(cwd)).toEqual([]);
    expect(output.prompts).toBe(0);
  });

  // Each adapter has a distinct error conversion boundary. Preserve only the
  // missing-marker prerequisite and retain the user's exact creation target.
  it.each([
    { name: 'catalog status', args: ['dev', 'catalog', 'status'] },
    { name: 'plugin requirements', args: ['dev', 'plugin', 'requirements', 'plugins/demo'] },
    { name: 'review inspect', args: ['dev', 'review', 'inspect', 'catalog'] },
    { name: 'review prepare', args: ['dev', 'review', 'prepare', 'plugins/demo', '--platform', 'cursor', '--scope', 'user', '--out', 'final'] },
  ].flatMap((route) => [false, true].flatMap((explicit) => [false, true].map((damaged) => ({ ...route, explicit, damaged })))))
  ('preserves the workspace prerequisite for $name (explicit=$explicit, damaged=$damaged)', async ({ args, explicit, damaged }) => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const cwd = path.join(layout.fixtureCwd, 'caller');
    const otherRoot = path.join(layout.fixtureCwd, 'target workspace');
    await Promise.all([fs.ensureDir(cwd), fs.ensureDir(otherRoot)]);
    const selectedRoot = explicit ? otherRoot : cwd;
    const marker = path.join(selectedRoot, '.aw-workspace.json');
    if (damaged) await fs.writeFile(marker, '{ invalid');
    const output = await invoke([...args, ...(explicit ? ['--workspace-root', '../target workspace'] : []), '--json'], { cwd, env });
    const result = JSON.parse(output.stdout);
    const creationActions = result.nextActions.filter((action: { kind: string; argv?: string[] }) => action.kind === 'command'
      && action.argv?.slice(0, 4).join(' ') === 'aw dev catalog create');
    if (damaged) {
      expect(output.code).not.toBe(0);
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'catalogWorkspaceMissing' }));
      expect(creationActions).toEqual([]);
      expect(await fs.readFile(marker, 'utf8')).toBe('{ invalid');
    } else {
      expect(output.code, output.stdout + output.stderr).toBe(3);
      expect(result.status).toBe('blocked');
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'catalogWorkspaceMissing' }));
      expect(creationActions).toEqual([expect.objectContaining({
        argv: ['aw', 'dev', 'catalog', 'create', ...(explicit ? ['--workspace-root', '../target workspace'] : [])],
        requiresConfirmation: false,
      })]);
    }
    expect(await fs.readdir(selectedRoot)).toEqual(damaged ? ['.aw-workspace.json'] : []);
    expect(await fs.readdir(explicit ? cwd : otherRoot)).toEqual([]);
    expect(output.prompts).toBe(0);
  });

  it('keeps an identified command and safe option diagnostics before normalization', async () => {
    const output = await invoke(['dev', 'catalog', 'create', '--unknown=/private/customer-secret', '--json']);
    expect(output.code).toBe(2);
    expect(JSON.parse(output.stdout)).toMatchObject({ schemaVersion: 1, command: 'dev.catalog.create', status: 'failed', data: {} });
    expect(output.stdout + output.stderr).not.toContain('customer-secret');
    expect(output.prompts).toBe(0);
  });
  it('identifies invalid context values without inventing lifecycle facts', async () => {
    const output = await invoke(['plugin', 'install', 'official/demo', '--scope', 'user', '--context', 'invalid', '--json']);
    expect(output.code).toBe(2);
    expect(JSON.parse(output.stdout)).toMatchObject({ command: 'plugin.install', data: {}, diagnostics: [{ code: 'invalidOptionValue', subject: { field: 'context' } }] });
  });
  it('recognizes JSON in a short option group before a parse failure', async () => {
    const output = await invoke(['plugin', 'config', 'apply', 'official/demo', '-yj', '--unknown']);
    expect(output.code).toBe(2);
    expect(JSON.parse(output.stdout)).toMatchObject({ command: 'plugin.config.apply', status: 'failed', data: {} });
  });
  it('does not interpret an option value as a presentation switch', async () => {
    const output = await invoke(['plugin', 'config', 'set', 'official/demo', 'token', '--value-json', '--json', '--unknown']);
    expect(output.code, output.stdout + output.stderr).toBe(2);
    expect(output.stdout).toMatch(/^FAILED/u);
  });
  it('returns registered help without requiring business arguments or starting a prompt', async () => {
    const output = await invoke(['plugin', 'remove', '--help', '--json']);
    expect(output.code).toBe(0);
    const help = JSON.parse(output.stdout);
    expect(help.command).toBe('help');
    expect(help.data.command).toBe('plugin.remove');
    expect(help.data.options).toEqual(expect.arrayContaining([expect.objectContaining({ flags: '--only <mode>', choices: ['requirements', 'outputs'] })]));
    expect(output.prompts).toBe(0);
  });
  it('returns concrete confirmation without invoking a prompt or source deletion', async () => {
    const output = await invoke(['dev', 'plugin', 'remove', 'demo', '--json']);
    expect(output.code).toBe(3);
    expect(JSON.parse(output.stdout)).toMatchObject({ command: 'dev.plugin.remove', status: 'blocked', data: { confirmation: { required: true, provided: false, effects: [{ code: 'deletePluginSource', subject: { pluginId: 'demo' } }] } } });
    expect(output.prompts).toBe(0);
  });
  it('does not claim an unknown route as a recognized command', async () => {
    const output = await invoke(['plugin', 'cleanup', '--json']);
    expect(output.code).toBe(2);
    expect(JSON.parse(output.stdout)).toMatchObject({ command: null, status: 'failed', data: {} });
  });
});
