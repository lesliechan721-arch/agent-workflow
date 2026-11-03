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
} from '../../src/manifest.js';

const nativeTools = {
  definitions: [{ key: 'job', protocol: 'aw.windows-job.v1' }],
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
    await fs.mkdir(path.join(root, 'tools'));
    await fs.writeFile(path.join(root, 'tools', 'run.mjs'), '');
    await fs.writeFile(path.join(root, '.agents-plugin', 'plugin.json'), JSON.stringify(manifest()));
    await run(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

describe('native tool author and installed closure contracts', () => {
  it('normalizes a schema 3 declaration and derives its required capability', () => {
    const normalized = validatePluginManifest('/plugin', manifest());
    expect(normalized.schemaVersion).toBe(3);
    expect(normalized.nativeTools).toEqual({ ...nativeTools, reader: './.aw/native-tool-reader.mjs' });
    expect(deriveAwCapabilitiesFromManifest(normalized)).toContain('aw.native-tools.v2');
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

  it('loads host requirements without any descriptor or native dependency', async () => {
    await fixture(async (root) => {
      const normalized = validatePluginManifest(root, manifest());
      expect(await loadPluginNativeToolClosure(root, normalized)).toEqual({ ...nativeTools, reader: './.aw/native-tool-reader.mjs' });
      expect((await fs.readdir(root)).sort()).toEqual(['.agents-plugin', 'tools']);
    });
  });

  it('materializes only a reader and protocol bindings without a current manifest', async () => {
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
      expect(Object.keys(materializeNativeToolClosureFiles(selected).files)).toEqual(['.aw/native-tool-reader.mjs']);
      expect(() => normalizeNativeToolClosure({ ...copied, definitions: [{ ...copied.definitions[0], protocol: '' }] })).toThrow();
      await fs.writeFile(path.resolve(resource, copied.reader), 'export const foreign = true;');
      await expect(validateNativeToolClosureFiles(resource, copied)).rejects.toThrow('nativeToolReaderMismatch');
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

  it('validates host requirements from the public source validator and protects native environment names on Windows', async () => {
    await fixture(async (root) => {
      await expect(validateSourcePluginManifest(root, manifest())).resolves.toHaveProperty('nativeTools');
      await expect(validateSourcePluginManifest(root, manifest({ scripts: undefined }))).rejects.toThrow(/unknown plugin test runner/u);
    });
    expect(() => validateCommandEnvironment({ aw_native_tool_context: 'foreign' }, {}, 'win32')).toThrow(/protected/u);
    expect(() => validateCommandEnvironment({}, { TOKEN: 'Aw_Native_Whatever' }, 'win32')).toThrow(/protected/u);
  });
});
