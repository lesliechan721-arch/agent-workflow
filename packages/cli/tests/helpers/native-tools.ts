import { materializeNativeToolClosureFiles, type NativeToolClosure } from '@lesliechan721/aw-plugin-core/manifest';

export function nativeToolFixture(options: { policy?: 'required' | 'preferred'; protocol?: string; kind?: 'managed-command-set' | 'plugin-test'; consumer?: string } = {}) {
  const policy = options.policy ?? 'required';
  const closure: NativeToolClosure = { reader: './.aw/native-tool-reader.mjs',
    definitions: [{ key: 'job', protocol: options.protocol ?? 'aw.windows-job.v1' }],
    consumers: [{ kind: options.kind ?? 'managed-command-set', key: options.consumer ?? 'tools', tools: [{ key: 'job', platforms: ['win32'], policy,
      ...(policy === 'preferred' ? { fallback: 'portable' } : {}) }] }],
  };
  return materializeNativeToolClosureFiles(closure);
}
