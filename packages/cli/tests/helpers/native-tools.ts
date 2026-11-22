import { materializeNativeToolClosureFiles, type NativeToolClosure } from '@lesliechan721/aw-plugin-core/manifest';

export function nativeToolFixture(options: { policy?: 'required' | 'preferred'; protocol?: string; kind?: 'plugin-command' | 'plugin-test'; consumer?: 'node' } = {}) {
  const tools: NativeToolClosure['consumers'][number]['tools'] = options.policy === 'preferred'
    ? [{ key: 'job', platforms: ['win32'], policy: 'preferred', fallback: 'portable' }]
    : [{ key: 'job', platforms: ['win32'], policy: 'required' }];
  const closure: NativeToolClosure = { reader: './.aw/native-tool-reader.mjs',
    definitions: [{ key: 'job', protocol: options.protocol ?? 'aw.windows-job.v1' }],
    consumers: options.kind === 'plugin-test'
      ? [{ kind: 'plugin-test', key: options.consumer ?? 'node', tools }]
      : [{ kind: 'plugin-command', tools }],
  };
  return materializeNativeToolClosureFiles(closure);
}
