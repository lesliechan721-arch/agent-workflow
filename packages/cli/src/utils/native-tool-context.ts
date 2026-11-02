import path from 'node:path';

import { resolveNativeTool, type NativeToolMode, type NativeToolReady } from '@lesliechan721/aw-native-runtime';
import { getNativeToolConsumerClosure, type NativeToolClosure } from '@lesliechan721/aw-plugin-core/manifest';

export interface NativeToolContext {
  schemaVersion: 1;
  tools: Record<string, NativeToolReady | { state: 'unavailable'; protocol: string; code: string }>;
}

export async function prepareNativeToolContext(options: {
  closure?: NativeToolClosure;
  kind: 'managed-command-set' | 'plugin-test';
  key: string;
  awHome: string;
  platform?: NodeJS.Platform;
  arch?: string;
  mode?: NativeToolMode;
  cacheRoot?: string;
  archivePath?: string;
  resolve?: typeof resolveNativeTool;
  registryEnvironment?: NodeJS.ProcessEnv;
}): Promise<NativeToolContext> {
  const context: NativeToolContext = { schemaVersion: 1, tools: {} };
  if (!options.closure) return context;
  const closure = getNativeToolConsumerClosure(options.closure, options.kind, options.key);
  if (!closure) return context;
  const platform = options.platform ?? process.platform;
  for (const binding of closure.consumers.flatMap((consumer) => consumer.tools)) {
    if (!binding.platforms.includes(platform as 'win32')) continue;
    const definition = closure.definitions.find((entry) => entry.key === binding.key)!;
    try {
      context.tools[binding.key] = await (options.resolve ?? resolveNativeTool)({
        descriptor: definition.descriptor,
        cacheRoot: options.cacheRoot ?? path.join(options.awHome, 'native-artifacts', 'v1'),
        platform,
        arch: options.arch ?? process.arch,
        mode: options.mode ?? 'network',
        ...((options.mode ?? 'network') === 'network' ? { registryEnvironment: options.registryEnvironment ?? process.env } : {}),
        ...(options.archivePath ? { archivePath: options.archivePath } : {}),
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^[A-Za-z][A-Za-z0-9]{0,95}$/u.test(error.code) ? error.code : 'nativeToolUnavailable';
      if (binding.policy === 'required') throw Object.assign(new Error(`Required native tool ${binding.key} is unavailable. Import its locked archive or retry preparation.`), { code });
      context.tools[binding.key] = { state: 'unavailable', protocol: definition.protocol, code };
    }
  }
  return context;
}

export function removeNativeToolEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) if (/^AW_NATIVE_/iu.test(key)) delete environment[key];
}
