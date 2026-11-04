import { prepareWindowsJobHelper, type PrepareWindowsJobHelperOptions } from '@lesliechan721/agent-skill-eval';
import type { NativeToolContext } from '@lesliechan721/aw-native-runtime/reader';
export type { NativeToolContext } from '@lesliechan721/aw-native-runtime/reader';
import { getNativeToolConsumerClosure, type NativeToolClosure } from '@lesliechan721/aw-plugin-core/manifest';

export function assertSupportedNativeToolProtocol(protocol: string): void {
  if (protocol !== 'aw.windows-job.v1') {
    throw Object.assign(new Error(`The host does not support native tool protocol ${protocol}.`), { code: 'nativeProtocolUnsupported' });
  }
}

export async function prepareNativeToolContext(options: {
  closure?: NativeToolClosure;
  kind: 'managed-command-set' | 'plugin-test';
  key: string;
  platform?: NodeJS.Platform;
  arch?: string;
  prepare?: (options?: PrepareWindowsJobHelperOptions) => Promise<string>;
}): Promise<NativeToolContext> {
  const context: NativeToolContext = { schemaVersion: 1, tools: {} };
  const closure = getNativeToolConsumerClosure(options.closure, options.kind, options.key);
  if (!closure) return context;
  const platform = options.platform ?? process.platform;
  for (const binding of closure.consumers.flatMap((consumer) => consumer.tools)) {
    if (!binding.platforms.includes(platform as 'win32')) continue;
    const definition = closure.definitions.find((entry) => entry.key === binding.key)!;
    assertSupportedNativeToolProtocol(definition.protocol);
    try {
      const executable = await (options.prepare ?? prepareWindowsJobHelper)({ platform, arch: options.arch ?? process.arch });
      context.tools[binding.key] = { state: 'ready', protocol: definition.protocol, executable };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^[A-Za-z][A-Za-z0-9]{0,95}$/u.test(error.code) ? error.code : 'nativeToolUnavailable';
      if (binding.policy === 'required') throw Object.assign(new Error(`Required native tool ${binding.key} is unavailable. Reinstall the current CLI/Eval package and include optional dependencies.`, { cause: error }), { code });
      context.tools[binding.key] = { state: 'unavailable', protocol: definition.protocol, code };
    }
  }
  return context;
}

export function removeNativeToolEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) if (/^AW_NATIVE_/iu.test(key)) delete environment[key];
}
