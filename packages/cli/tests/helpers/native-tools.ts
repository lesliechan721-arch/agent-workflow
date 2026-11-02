import { nativeToolDescriptorDigest, parseNativeToolDescriptor } from '@lesliechan721/aw-native-runtime/descriptor';
import { materializeNativeToolClosureFiles, type NativeToolClosure } from '@lesliechan721/aw-plugin-core/manifest';

export function nativeToolFixture(options: { policy?: 'required' | 'preferred'; version?: string; kind?: 'managed-command-set' | 'plugin-test'; consumer?: string } = {}) {
  const descriptor = parseNativeToolDescriptor({ schemaVersion: 1,
    tool: { id: '@fixture/job', version: options.version ?? '1.0.0', protocol: 'fixture.job.v1' },
    variants: [{ platform: 'win32', arch: 'x64',
      transport: { kind: 'npm', package: '@fixture/job-win32-x64', version: options.version ?? '1.0.0', archiveIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`, entry: 'package/dist/job.exe' },
      file: { sha256: `sha256:${'a'.repeat(64)}`, size: 256, format: 'pe', machine: '0x8664' },
      limits: { archiveBytes: 4096, expandedBytes: 4096, entries: 8 } }],
  });
  const policy = options.policy ?? 'required';
  const closure: NativeToolClosure = { reader: './.aw/native-tool-reader.mjs',
    definitions: [{ key: 'job', protocol: descriptor.tool.protocol, descriptorPath: './job.lock.json', descriptor, descriptorDigest: nativeToolDescriptorDigest(descriptor) }],
    consumers: [{ kind: options.kind ?? 'managed-command-set', key: options.consumer ?? 'tools', tools: [{ key: 'job', platforms: ['win32'], policy,
      ...(policy === 'preferred' ? { fallback: 'portable' } : {}) }] }],
  };
  return materializeNativeToolClosureFiles(closure);
}
