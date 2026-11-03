import { readNativeTool } from '../../packages/native-runtime/src/reader.mjs';

// Explicit native jobs provide a candidate context. Ordinary tests use the
// existing system process inspection and cleanup when no context is supplied.
export async function prepareNativeTestEnvironment(environment = process.env, platform = process.platform) {
  if (platform !== 'win32') return environment;
  if (!Object.keys(environment).some((key) => key.toUpperCase() === 'AW_NATIVE_TOOL_CONTEXT')) return { ...environment };
  if (readNativeTool('windows-job', 'aw.windows-job.v1', environment).state !== 'ready') throw new Error('Windows tests require an explicitly prepared native context.');
  return { ...environment };
}
