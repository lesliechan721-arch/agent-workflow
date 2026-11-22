import fs from 'fs-extra';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCommandRoutes, normalizeCommandLaunch, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';
import { nativeToolFixture } from '../helpers/native-tools.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import { syncManagedCommandPackage } from '../../src/utils/managed-command-store.js';
import { prepareNativeToolContext } from '../../src/utils/native-tool-context.js';
import { buildManagedCommandEnvironment, prepareManagedCommandRun, runManagedCommand } from '../../src/utils/managed-command-runtime.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { createDefaultCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';

// Test Value Gate: installed evidence and real preparation protect pre-spawn failure,
// source-update isolation, nested producer authorization, and reserved environment boundaries.
describe('installed native command preparation', () => {
  let isolated: IsolatedTestEnvironment;
  let source: string;
  let report: string;
  let producer: ProducerIdentity;
  const ready = { state: 'ready' as const, protocol: 'aw.windows-job.v1', executable: process.execPath };
  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    const official = createDefaultCatalogSourcesConfig().sources[0]!;
    producer = { sourceId: official.id, sourceIdentity: await calculateCatalogSourceIdentity(official), pluginName: 'native-tool' };
    source = path.join(isolated.layout.fixtureCwd, 'source');
    report = path.join(isolated.layout.fixtureCwd, 'consumer.json');
    await fs.outputFile(path.join(source, 'run.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.env.REPORT, process.env.AW_NATIVE_TOOL_CONTEXT); process.exitCode=31;\n');
  });
  afterEach(async () => { await isolated.cleanup(); });
  async function install(options: { policy?: 'required' | 'preferred'; pluginName?: string; envFrom?: Record<string, string> } = {}) {
    const fixture = nativeToolFixture(options);
    for (const [relative, content] of Object.entries(fixture.files)) await fs.outputFile(path.join(source, relative), content);
    const identity = { ...producer, pluginName: options.pluginName ?? producer.pluginName };
    const routes = normalizeCommandRoutes({ fallback: { runner: 'node', entry: 'run.mjs', env: { REPORT: report }, ...(options.envFrom ? { envFrom: options.envFrom } : {}) } });
    const installed = await syncManagedCommandPackage({ producer: identity, sourceDirectory: source,
      record: { schemaVersion: 2, producer: identity, pluginVersion: '1.0.0', sourceContentDigest: `sha256:${'a'.repeat(64)}`,
        routes, nativeTools: fixture.closure, runtimeConfigPlatforms: [] }, env: isolated.env });
    return { ...installed, fixture, selector: `${identity.sourceId}/${identity.pluginName}` };
  }
  function invocation(id: string) { return { id, args: [], cwd: isolated.layout.fixtureCwd, cliEntry: path.join(source, 'aw.js'), env: isolated.env, platform: 'win32' as const, arch: 'x64' }; }

  it('uses the current host helper without changing the installed declaration', async () => {
    const installed = await install();
    const latest = nativeToolFixture({ policy: 'preferred' });
    for (const [relative, content] of Object.entries(latest.files)) await fs.outputFile(path.join(source, relative), content);
    const prepare = vi.fn(async (_options?: unknown) => ready.executable);
    const prepared = await prepareManagedCommandRun({ ...invocation(installed.selector), env: {
      ...isolated.env,
      aw_native_tool_context: 'untrusted', AW_NATIVE_OTHER: 'untrusted',
    }, prepareNativeTool: prepare });
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0]).toMatchObject({ platform: 'win32', arch: 'x64' });
    expect(prepared.env.aw_native_tool_context).toBeUndefined();
    expect(prepared.env.AW_NATIVE_OTHER).toBeUndefined();
    expect(JSON.parse(prepared.env.AW_NATIVE_TOOL_CONTEXT!)).toEqual({ schemaVersion: 1, tools: { job: ready } });
  });

  it('rejects environment errors before resolution and required failure before spawn', async () => {
    const installed = await install({ envFrom: { COPY: 'MISSING' } });
    const prepare = vi.fn(async () => { throw Object.assign(new Error('credential must not escape'), { code: 'nativePackageUnavailable' }); });
    await expect(runManagedCommand({ ...invocation(installed.selector), prepareNativeTool: prepare })).rejects.toMatchObject({ code: 'commandEnvironmentSourceMissing' });
    expect(prepare).not.toHaveBeenCalled();
    await expect(runManagedCommand({ ...invocation(installed.selector), env: { ...isolated.env, MISSING: 'present' }, prepareNativeTool: prepare })).rejects.toMatchObject({ code: 'nativePackageUnavailable' });
    await expect(runManagedCommand({ ...invocation(installed.selector), env: { ...isolated.env, MISSING: 'present' }, prepareNativeTool: prepare })).rejects.toThrow(/Reinstall.*optional dependencies/u);
    expect(await fs.pathExists(report)).toBe(false);
  });

  it('prepares a nested producer independently from its own closure', async () => {
    const first = await install();
    const parent = await prepareManagedCommandRun({ ...invocation(first.selector), prepareNativeTool: async () => ready.executable });
    const second = await install({ pluginName: 'second' });
    const prepare = vi.fn(async (_options?: unknown) => { throw Object.assign(new Error('offline'), { code: 'nativePackageUnavailable' }); });
    await expect(prepareManagedCommandRun({ ...invocation(second.selector), env: parent.env, prepareNativeTool: prepare })).rejects.toMatchObject({ code: 'nativePackageUnavailable' });
    expect(prepare.mock.calls[0]![0]).toMatchObject({ platform: 'win32', arch: 'x64' });
  });

  it('fixes preferred selection at launch and preserves native operation failure', async () => {
    const installed = await install({ policy: 'preferred' });
    const unavailable = await prepareManagedCommandRun({ ...invocation(installed.selector), prepareNativeTool: async () => { throw new Error('private registry'); } });
    expect(JSON.parse(unavailable.env.AW_NATIVE_TOOL_CONTEXT!)).toEqual({ schemaVersion: 1, tools: { job: { state: 'unavailable', protocol: 'aw.windows-job.v1', code: 'nativeToolUnavailable' } } });
    const prepare = vi.fn(async () => ready.executable);
    expect(await runManagedCommand({ ...invocation(installed.selector), prepareNativeTool: prepare })).toBe(31);
    expect(prepare).toHaveBeenCalledOnce();
    expect(JSON.parse(await fs.readFile(report, 'utf8')).tools.job).toEqual(ready);
  });

  it('rejects a changed installed reader and keeps non-Windows commands free of native dependencies', async () => {
    const installed = await install();
    const prepare = vi.fn(async () => ready.executable);
    await prepareManagedCommandRun({ ...invocation(installed.selector), platform: 'darwin', prepareNativeTool: prepare });
    expect(prepare).not.toHaveBeenCalled();
    expect(await fs.pathExists(path.join(isolated.layout.awHomeDir, 'native-artifacts'))).toBe(false);
    await fs.writeFile(path.join(installed.resourceRoot, '.aw/native-tool-reader.mjs'), 'export const foreign = true;');
    await expect(prepareManagedCommandRun({ ...invocation(installed.selector), prepareNativeTool: prepare })).rejects.toMatchObject({ code: 'commandBindingInvalid' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects unsupported protocols before calling the host helper', async () => {
    const fixture = nativeToolFixture();
    const prepare = vi.fn(async () => ready.executable);
    await expect(prepareNativeToolContext({
      closure: { ...fixture.closure, definitions: [{ key: 'job', protocol: 'example.unsupported.v1' }] },
      kind: 'plugin-command', platform: 'win32', prepare,
    })).rejects.toMatchObject({ code: 'nativeProtocolUnsupported' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([{ env: { aW_nAtIvE_TOOL_CONTEXT: 'override' }, envFrom: {} }, { env: {}, envFrom: { COPY: 'aw_native_tool_context' } }])('refuses native environment overrides on Windows', (maps) => {
    const launch = { ...normalizeCommandLaunch({ runner: 'node', entry: 'run.mjs' }), ...maps };
    expect(() => buildManagedCommandEnvironment({ launch, hostEnvironment: {}, platform: 'win32', host: { schemaVersion: 1, cliEntry: '/aw.js', nodeExecutable: process.execPath, awHome: '/aw-home' } })).toThrowError(expect.objectContaining({ code: 'commandEnvironmentInvalid' }));
  });
});
