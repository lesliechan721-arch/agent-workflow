import fs from 'fs-extra';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCommandDefinition, normalizeCommandLaunch, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';
import { nativeToolFixture } from '../helpers/native-tools.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import { syncManagedCommandPackage } from '../../src/utils/managed-command-store.js';
import { buildManagedCommandEnvironment, prepareManagedCommandRun, runManagedCommand } from '../../src/utils/managed-command-runtime.js';

// Test Value Gate: installed evidence and real preparation protect pre-spawn failure,
// source-update isolation, nested producer authorization, and reserved environment boundaries.
describe('installed native command preparation', () => {
  let isolated: IsolatedTestEnvironment;
  let source: string;
  let report: string;
  const producer: ProducerIdentity = { sourceId: 'fixture', sourceIdentity: `sha256:${'b'.repeat(64)}`, pluginName: 'native-tool', kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null };
  const ready = { state: 'ready' as const, protocol: 'fixture.job.v1', executable: process.execPath, sha256: `sha256:${'a'.repeat(64)}` };
  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    source = path.join(isolated.layout.fixtureCwd, 'source');
    report = path.join(isolated.layout.fixtureCwd, 'consumer.json');
    await fs.outputFile(path.join(source, 'run.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.env.REPORT, process.env.AW_NATIVE_TOOL_CONTEXT); process.exitCode=31;\n');
  });
  afterEach(async () => { await isolated.cleanup(); });
  async function install(options: { policy?: 'required' | 'preferred'; version?: string; key?: string; envFrom?: Record<string, string> } = {}) {
    const fixture = nativeToolFixture(options);
    for (const [relative, content] of Object.entries(fixture.files)) await fs.outputFile(path.join(source, relative), content);
    const installed = await syncManagedCommandPackage({ producer: { ...producer, key: options.key ?? producer.key }, sourceDirectory: source,
      sets: [{ set: 'tools', state: 'present', entries: [normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'run.mjs', env: { REPORT: report }, envFrom: options.envFrom })] }], nativeTools: fixture.closure, env: isolated.env });
    return { ...installed, fixture };
  }
  function invocation(id: string) { return { id, args: [], cwd: isolated.layout.fixtureCwd, cliEntry: path.join(source, 'aw.js'), env: isolated.env, platform: 'win32' as const, arch: 'x64' }; }

  it('uses the installed descriptor and a ready resolver result without parsing registry configuration', async () => {
    const installed = await install();
    const latest = nativeToolFixture({ version: '2.0.0', policy: 'preferred' });
    for (const [relative, content] of Object.entries(latest.files)) await fs.outputFile(path.join(source, relative), content);
    const resolve = vi.fn(async (_options: unknown) => ready);
    const prepared = await prepareManagedCommandRun({ ...invocation(installed.commandIds[0]!), env: {
      ...isolated.env,
      aw_native_tool_context: 'untrusted', AW_NATIVE_OTHER: 'untrusted',
      // The shared resolver can return a verified cache hit without registry access.
      AW_NATIVE_REGISTRY_CONFIG: '{invalid registry configuration must not block a ready result',
    }, nativeResolver: resolve });
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]![0]).toMatchObject({ descriptor: installed.fixture.closure.definitions[0]!.descriptor, mode: 'network', platform: 'win32', arch: 'x64' });
    expect(prepared.env.aw_native_tool_context).toBeUndefined();
    expect(prepared.env.AW_NATIVE_OTHER).toBeUndefined();
    expect(JSON.parse(prepared.env.AW_NATIVE_TOOL_CONTEXT!)).toEqual({ schemaVersion: 1, tools: { job: ready } });
    expect(prepared.env.AW_NATIVE_RESOLVER_MODE).toBe('cache-only');
  });

  it('rejects environment errors before resolution and required failure before spawn', async () => {
    const installed = await install({ envFrom: { COPY: 'MISSING' } });
    const resolve = vi.fn(async () => { throw Object.assign(new Error('credential must not escape'), { code: 'nativeCacheMiss' }); });
    await expect(runManagedCommand({ ...invocation(installed.commandIds[0]!), nativeResolver: resolve })).rejects.toMatchObject({ code: 'commandEnvironmentSourceMissing' });
    expect(resolve).not.toHaveBeenCalled();
    await expect(runManagedCommand({ ...invocation(installed.commandIds[0]!), env: { ...isolated.env, MISSING: 'present' }, nativeResolver: resolve })).rejects.toMatchObject({ code: 'nativeCacheMiss' });
    expect(await fs.pathExists(report)).toBe(false);
  });

  it('resolves a nested producer from its own evidence with cache-only mode', async () => {
    const first = await install();
    const parent = await prepareManagedCommandRun({ ...invocation(first.commandIds[0]!), nativeResolver: async () => ready });
    const second = await install({ key: 'second', version: '2.0.0' });
    const resolve = vi.fn(async (_options: unknown) => { throw Object.assign(new Error('offline'), { code: 'nativeCacheMiss' }); });
    await expect(prepareManagedCommandRun({ ...invocation(second.commandIds[0]!), env: parent.env, nativeResolver: resolve })).rejects.toMatchObject({ code: 'nativeCacheMiss' });
    expect(resolve.mock.calls[0]![0]).toMatchObject({ descriptor: second.fixture.closure.definitions[0]!.descriptor, mode: 'cache-only' });
  });

  it('fixes preferred selection at launch and preserves native operation failure', async () => {
    const installed = await install({ policy: 'preferred' });
    const unavailable = await prepareManagedCommandRun({ ...invocation(installed.commandIds[0]!), nativeResolver: async () => { throw new Error('private registry'); } });
    expect(JSON.parse(unavailable.env.AW_NATIVE_TOOL_CONTEXT!)).toEqual({ schemaVersion: 1, tools: { job: { state: 'unavailable', protocol: 'fixture.job.v1', code: 'nativeToolUnavailable' } } });
    const resolve = vi.fn(async () => ready);
    expect(await runManagedCommand({ ...invocation(installed.commandIds[0]!), nativeResolver: resolve })).toBe(31);
    expect(resolve).toHaveBeenCalledOnce();
    expect(JSON.parse(await fs.readFile(report, 'utf8')).tools.job).toEqual(ready);
  });

  it('rejects changed installed locks and keeps non-Windows commands offline with no native cache', async () => {
    const installed = await install();
    const resolve = vi.fn(async () => ready);
    await prepareManagedCommandRun({ ...invocation(installed.commandIds[0]!), platform: 'darwin', nativeResolver: resolve });
    expect(resolve).not.toHaveBeenCalled();
    expect(await fs.pathExists(path.join(isolated.layout.awHomeDir, 'native-artifacts'))).toBe(false);
    const changed = nativeToolFixture({ version: '2.0.0' });
    await fs.writeFile(path.join(installed.resourceRoot, '.aw/native-tools/job.lock.json'), changed.files['.aw/native-tools/job.lock.json']!);
    await expect(prepareManagedCommandRun({ ...invocation(installed.commandIds[0]!), nativeResolver: resolve })).rejects.toMatchObject({ code: 'commandBindingInvalid' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([{ env: { aW_nAtIvE_TOOL_CONTEXT: 'override' }, envFrom: {} }, { env: {}, envFrom: { COPY: 'aw_native_registry_config' } }])('refuses native environment overrides on Windows', (maps) => {
    const launch = { ...normalizeCommandLaunch({ runner: 'node', entry: 'run.mjs' }), ...maps };
    expect(() => buildManagedCommandEnvironment({ launch, hostEnvironment: {}, platform: 'win32', host: { schemaVersion: 1, cliEntry: '/aw.js', nodeExecutable: process.execPath, awHome: '/aw-home' } })).toThrowError(expect.objectContaining({ code: 'commandEnvironmentInvalid' }));
  });
});
