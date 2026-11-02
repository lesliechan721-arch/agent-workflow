import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  copyNativeToolClosureFiles,
  deriveAwCapabilitiesFromManifest,
  getNativeToolConsumerClosure,
  loadPluginNativeToolClosure,
  materializeNativeToolClosureFiles,
  normalizeInstalledCommandProducer,
  normalizeNativeToolClosure,
  preparePluginNativeTools,
  readPluginManifest,
  validateCommandEnvironment,
  validateNativeToolClosureFiles,
  validatePluginManifest,
  validateSourcePluginManifest,
  type NativeToolClosure,
  type NativeToolDescriptor,
} from '../../src/manifest.js';

const descriptor: NativeToolDescriptor = {
  schemaVersion: 1,
  tool: { id: '@example/job', version: '1.2.3', protocol: 'example.job.v1' },
  variants: [{
    platform: 'win32', arch: 'x64',
    transport: { kind: 'npm', package: '@example/job-win32-x64', version: '1.2.3', archiveIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`, entry: 'package/dist/job.exe' },
    file: { sha256: `sha256:${'a'.repeat(64)}`, size: 128, format: 'pe', machine: '0x8664' },
    limits: { archiveBytes: 4096, expandedBytes: 4096, entries: 8 },
  }],
};
const nativeTools = {
  definitions: [{ key: 'job', protocol: 'example.job.v1', descriptor: './native-tools/job.lock.json' }],
  consumers: [
    { kind: 'managed-command-set', key: 'guide', tools: [{ key: 'job', platforms: ['win32'], policy: 'required' }] },
    { kind: 'plugin-test', key: 'node', tools: [{ key: 'job', platforms: ['win32'], policy: 'preferred', fallback: 'portable' }] },
  ],
};
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3, name: 'example-plugin', version: '1.0.0', description: 'Example',
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    managedCommands: {
      packages: [{ key: 'tools', scope: 'user', platforms: ['codex'], sourceDir: './tools' }],
      sets: [{ set: 'guide', producer: { kind: 'package', packageKey: 'tools' }, mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }] }],
    },
    scripts: { tests: { node: ['tests/job.test.mjs'] } }, nativeTools,
    ...overrides,
  };
}
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-core-'));
  try {
    await fs.mkdir(path.join(root, '.agents-plugin'));
    await fs.mkdir(path.join(root, 'native-tools'));
    await fs.mkdir(path.join(root, 'tools'));
    await fs.writeFile(path.join(root, 'tools', 'run.mjs'), '');
    await fs.writeFile(path.join(root, '.agents-plugin', 'plugin.json'), JSON.stringify(manifest()));
    await fs.writeFile(path.join(root, 'native-tools', 'job.lock.json'), JSON.stringify(descriptor));
    await run(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

describe('native tool author and installed closure contracts', () => {
  it('normalizes a schema 3 declaration and derives its required capability', () => {
    const normalized = validatePluginManifest('/plugin', manifest());
    expect(normalized.schemaVersion).toBe(3);
    expect(normalized.nativeTools).toEqual({ ...nativeTools, reader: './.aw/native-tool-reader.mjs' });
    expect(deriveAwCapabilitiesFromManifest(normalized)).toContain('aw.native-tools.v1');
  });

  it.each([
    { ...nativeTools, consumers: [{ kind: 'hook', key: 'guide', tools: nativeTools.consumers[0]!.tools }] },
    { ...nativeTools, consumers: [{ ...nativeTools.consumers[0], key: 'missing' }] },
    { ...nativeTools, consumers: [{ ...nativeTools.consumers[1], key: 'python' }] },
    { ...nativeTools, consumers: [{ ...nativeTools.consumers[0], tools: [{ key: 'unknown', platforms: ['win32'], policy: 'required' }] }] },
    { ...nativeTools, consumers: [{ ...nativeTools.consumers[0], tools: [{ key: 'job', platforms: ['win32'], policy: 'preferred' }] }] },
    { ...nativeTools, consumers: [{ ...nativeTools.consumers[0], tools: [{ key: 'job', platforms: ['win32'], policy: 'required', fallback: 'portable' }] }] },
    { ...nativeTools, consumers: [nativeTools.consumers[0], nativeTools.consumers[0]] },
    { ...nativeTools, reader: './native-tools/../reader.mjs' },
    { ...nativeTools, definitions: [{ ...nativeTools.definitions[0], descriptor: './node_modules/job.lock.json' }] },
  ])('rejects a native declaration outside its controlled launch boundary %#', (nativeTools) => {
    expect(() => validatePluginManifest('/plugin', manifest({ nativeTools }))).toThrow();
  });

  it('loads ordinary local locks offline and rejects protocol, transport and path violations', async () => {
    await fixture(async (root) => {
      const normalized = validatePluginManifest(root, manifest());
      const closure = await loadPluginNativeToolClosure(root, normalized);
      expect(closure?.definitions[0]).toMatchObject({ key: 'job', protocol: 'example.job.v1', descriptor, descriptorDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) });
      await fs.writeFile(path.join(root, 'native-tools', 'job.lock.json'), JSON.stringify({ ...descriptor, tool: { ...descriptor.tool, protocol: 'different.protocol.v1' } }));
      await expect(loadPluginNativeToolClosure(root, normalized)).rejects.toThrow('nativeProtocolMismatch');
      await fs.writeFile(path.join(root, 'native-tools', 'job.lock.json'), JSON.stringify({ ...descriptor, variants: [{ ...descriptor.variants[0], transport: { ...descriptor.variants[0]!.transport, package: 'https://example.test/job.tgz' } }] }));
      await expect(loadPluginNativeToolClosure(root, normalized)).rejects.toThrow('nativeDescriptorInvalid');
      await fs.unlink(path.join(root, 'native-tools', 'job.lock.json'));
      await fs.symlink(path.join(root, '.agents-plugin', 'plugin.json'), path.join(root, 'native-tools', 'job.lock.json'));
      await expect(loadPluginNativeToolClosure(root, normalized)).rejects.toThrow(/symbolic/u);
    });
  });

  it('materializes a complete producer closure and detects lock tampering without a current manifest', async () => {
    await fixture(async (root) => {
      const normalized = validatePluginManifest(root, manifest());
      await preparePluginNativeTools(root, normalized);
      const original = await loadPluginNativeToolClosure(root, normalized);
      const selected = getNativeToolConsumerClosure(original, 'managed-command-set', ['guide'])!;
      const resource = path.join(root, 'producer');
      await fs.mkdir(resource);
      const copied = await copyNativeToolClosureFiles({ sourceRoot: root, destinationRoot: resource, closure: selected });
      expect(copied).toEqual(materializeNativeToolClosureFiles(selected).closure);
      const record = { schemaVersion: 1, producer: {
        sourceId: 'third-party', sourceIdentity: `sha256:${'b'.repeat(64)}`, pluginName: 'example-plugin', kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null,
      }, sets: [{ set: 'guide', state: 'present', entries: [] }], nativeTools: copied };
      expect(normalizeInstalledCommandProducer(record).nativeTools).toEqual(copied);
      await fs.unlink(path.join(root, '.agents-plugin', 'plugin.json'));
      await expect(validateNativeToolClosureFiles(resource, copied)).resolves.toBeUndefined();
      const incomplete = structuredClone(record);
      delete (incomplete.nativeTools.definitions[0] as Partial<NativeToolClosure['definitions'][number]>).descriptor;
      expect(() => normalizeInstalledCommandProducer(incomplete)).toThrow();
      const altered = { ...descriptor, tool: { ...descriptor.tool, version: '2.0.0' } };
      await fs.writeFile(path.resolve(resource, copied.definitions[0]!.descriptorPath), JSON.stringify(altered));
      await expect(validateNativeToolClosureFiles(resource, copied)).rejects.toThrow('nativeDescriptorDigestMismatch');
      expect(() => normalizeNativeToolClosure({ ...copied, definitions: [{ ...copied.definitions[0], descriptor: altered }] })).toThrow('nativeDescriptorDigestMismatch');
    });
  });

  it('requires the generated offline reader in a bundle and refuses source collisions', async () => {
    await fixture(async (root) => {
      await expect(readPluginManifest(root, { mode: 'bundle' })).rejects.toThrow(/missing file/u);
      const normalized = validatePluginManifest(root, manifest());
      const reader = await preparePluginNativeTools(root, normalized);
      await fs.writeFile(path.join(root, '.agents-plugin', 'plugin.json'), JSON.stringify(manifest({ scripts: undefined })));
      await expect(readPluginManifest(root, { mode: 'bundle' })).resolves.toMatchObject({ manifest: { nativeTools: { reader: './.aw/native-tool-reader.mjs' } } });
      await fs.writeFile(reader!, 'export const unsafe = true;\n');
      await expect(preparePluginNativeTools(root, normalized)).rejects.toThrow('nativeToolReaderMismatch');
      await expect(readPluginManifest(root, { mode: 'bundle' })).rejects.toThrow('nativeToolReaderMismatch');
    });
  });

  it('validates descriptors from the public source validator and protects native environment names on Windows', async () => {
    await fixture(async (root) => {
      await expect(validateSourcePluginManifest(root, manifest())).resolves.toHaveProperty('nativeTools');
      await expect(validateSourcePluginManifest(root, manifest({ scripts: undefined }))).rejects.toThrow(/unknown plugin test runner/u);
      await fs.writeFile(path.join(root, 'native-tools', 'job.lock.json'), '{}');
      await expect(validateSourcePluginManifest(root, manifest())).rejects.toThrow('nativeDescriptorInvalid');
    });
    expect(() => validateCommandEnvironment({ aw_native_tool_context: 'foreign' }, {}, 'win32')).toThrow(/protected/u);
    expect(() => validateCommandEnvironment({}, { TOKEN: 'Aw_Native_Whatever' }, 'win32')).toThrow(/protected/u);
  });
});
