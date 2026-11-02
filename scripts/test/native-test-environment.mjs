import { readFile } from 'node:fs/promises';
import { readNativeTool, readNativeToolTestConfig, resolveNativeTool } from '../../packages/native-runtime/src/index.mjs';

// This is an explicit test input. It is never selected from PATH, optional
// dependencies, source PE files or the presence of a local package.
export async function prepareNativeTestEnvironment(environment = process.env, platform = process.platform, arch = process.arch) {
  if (platform !== 'win32') return environment;
  const next = { ...environment };
  if (!environment.AW_NATIVE_TEST_CONFIG) {
    if (readNativeTool('windows-job', 'aw.windows-job.v1', environment).state !== 'ready') throw new Error('Windows tests require an explicitly prepared native context.');
    return next;
  }
  const config = readNativeToolTestConfig({ ...environment, AW_TEST_RUNNER_PROCESS_TREE: '1' });
  const descriptorPath = config.descriptorPath ?? new URL('../../native-tools/windows-job/windows-job.lock.json', import.meta.url);
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  const ready = await resolveNativeTool({ descriptor, cacheRoot: config.cacheRoot, platform, arch, mode: config.mode, archivePath: config.archivePath });
  next.AW_NATIVE_TOOL_CONTEXT = JSON.stringify({ schemaVersion: 1, tools: { 'windows-job': ready } });
  next.AW_NATIVE_RESOLVER_MODE = config.mode;
  return next;
}
