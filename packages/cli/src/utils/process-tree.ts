import { fileURLToPath } from 'node:url';

export {
  assertProcessTreeInspectionAvailable,
  createWindowsJobInvocation,
  observeProcessTree,
  terminateProcessTree,
} from '@lesliechan721/agent-skill-eval';
export type {
  ProcessTreeDependencies,
  ProcessTreeObservation,
  ProcessTreeTerminationOptions,
  WindowsJobInvocation,
} from '@lesliechan721/agent-skill-eval';

import { readNativeToolTestConfig } from '@lesliechan721/aw-native-runtime';

import {
  prepareWindowsJobHelper as prepareEvalWindowsJobHelper,
  type PrepareWindowsJobHelperOptions,
} from '@lesliechan721/agent-skill-eval';

export async function prepareWindowsJobHelper(
  options: PrepareWindowsJobHelperOptions,
): Promise<string> {
  const environment = { ...process.env, ...options.sourceEnv };
  const testConfig = readNativeToolTestConfig(environment);
  const mode = options.mode === 'cache-only' ? 'cache-only'
    : testConfig?.mode ?? options.mode
      ?? (environment.AW_TEST_RUNNER_PROCESS_TREE === '1' ? 'cache-only' : 'network');
  const cacheRoot = testConfig?.cacheRoot ?? options.cacheRoot;
  const descriptorPath = testConfig?.descriptorPath ?? new URL('../native/windows-job.lock.json', import.meta.url);
  try {
    return await prepareEvalWindowsJobHelper({
      ...options,
      mode,
      cacheRoot,
      ...(mode !== 'cache-only' && testConfig?.archivePath ? { archivePath: testConfig.archivePath } : {}),
      descriptorPath,
    });
  } catch (error) {
    if (mode !== 'cache-only' || !error || typeof error !== 'object'
      || !('code' in error) || error.code !== 'nativeCacheMiss') throw error;
    const lock = typeof descriptorPath === 'string' ? descriptorPath : fileURLToPath(descriptorPath);
    const quotedLock = `'${lock.replaceAll("'", "''")}'`;
    const quotedCache = `'${cacheRoot.replaceAll("'", "''")}'`;
    throw Object.assign(new Error([
      'Windows Job helper is missing from the native cache (nativeCacheMiss).',
      'Prepare it explicitly, then retry. In PowerShell, run one of:',
      `aw native prefetch ${quotedLock} --cache-root ${quotedCache}`,
      `aw native import ${quotedLock} --archive '<local-archive.tgz>' --cache-root ${quotedCache}`,
    ].join('\n'), { cause: error }), { code: 'nativeCacheMiss' });
  }
}

export async function resolveWindowsJobHelperPath(
  options: Omit<PrepareWindowsJobHelperOptions, 'mode' | 'archivePath' | 'registry'>,
): Promise<string> {
  return prepareWindowsJobHelper({ ...options, mode: 'cache-only' });
}
