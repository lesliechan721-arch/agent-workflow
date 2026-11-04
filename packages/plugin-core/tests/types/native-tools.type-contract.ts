import type { NativeToolClosure, NativeToolDefinition } from '../../src/manifest.js';
import type { PluginManifestSourceV3 } from '../../src/index.js';

type SourceDefinition = NonNullable<PluginManifestSourceV3['nativeTools']>['definitions'][number];

export const sourceDefinition: SourceDefinition = { key: 'job', protocol: 'aw.windows-job.v1' };
export const normalizedDefinition: NativeToolDefinition = sourceDefinition;
export const closure: NativeToolClosure = {
  reader: './.aw/native-tool-reader.mjs',
  definitions: [normalizedDefinition],
  consumers: [{ kind: 'plugin-test', key: 'node', tools: [{ key: 'job', platforms: ['win32'], policy: 'required' }] }],
};

export const sourceRejectsDescriptor: SourceDefinition = {
  key: 'job', protocol: 'aw.windows-job.v1',
  // @ts-expect-error Host protocol declarations do not accept an artifact lock.
  descriptor: './job.lock.json',
};
