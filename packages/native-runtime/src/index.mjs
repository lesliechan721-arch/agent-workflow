import path from 'node:path';
import { NativeToolError, parseNativeToolDescriptor, selectNativeToolVariant } from './descriptor.mjs';
import { readNativeCandidate, readNativeFile, publishNativeCandidate } from './cache.mjs';
import { extractNativeArchive } from './archive.mjs';
import { downloadNativeArchive, resolveNativeRegistryConfig } from './transport.mjs';
export * from './descriptor.mjs';
export * from './reader.mjs';
export { resolveNativeRegistryConfig } from './transport.mjs';

export function readNativeToolTestConfig(environment = process.env) {
  const raw = environment.AW_NATIVE_TEST_CONFIG;
  if (raw === undefined) return undefined;
  const reject = () => { throw new NativeToolError('nativeTestConfigInvalid'); };
  if (environment.AW_TEST_RUNNER_PROCESS_TREE !== '1' || typeof raw !== 'string' || raw.length > 128 * 1024) reject();
  let config;
  try { config = JSON.parse(raw); } catch { reject(); }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some((key) => !['mode', 'archivePath', 'cacheRoot', 'descriptorPath'].includes(key))
    || !['fixture', 'cache-only', 'network', 'source-candidate'].includes(config.mode)) reject();
  for (const key of ['cacheRoot', 'archivePath', 'descriptorPath']) {
    const value = config[key];
    if (value === undefined && key !== 'cacheRoot') continue;
    if (typeof value !== 'string' || value.length > 32_768 || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value)) reject();
  }
  if (['fixture', 'source-candidate'].includes(config.mode) && config.archivePath === undefined) reject();
  return { ...config };
}

export async function resolveNativeTool(options) {
  try { return await resolve(options); }
  catch (error) {
    if (error instanceof NativeToolError) throw error;
    throw new NativeToolError('nativePreparationFailed');
  }
}

async function resolve(options) {
  const descriptor = parseNativeToolDescriptor(options.descriptor);
  const variant = selectNativeToolVariant(descriptor, options.platform, options.arch);
  if (typeof options.cacheRoot !== 'string' || !options.cacheRoot) throw new NativeToolError('nativeCacheRootInvalid');
  const mode = options.mode ?? 'cache-only';
  if (!['fixture', 'cache-only', 'network', 'source-candidate'].includes(mode)) throw new NativeToolError('nativeResolverModeInvalid');
  // Current-source qualification cannot accidentally run an old cache hit.
  if (mode === 'source-candidate' && !options.archivePath) throw new NativeToolError('nativeSourceCandidateRequired');
  if (mode !== 'source-candidate') {
    const existing = await readNativeCandidate(options.cacheRoot, descriptor, variant);
    if (existing.state === 'ready') return existing;
  }
  let archive;
  if (options.archivePath && mode !== 'cache-only') archive = await readNativeFile(options.archivePath, variant.limits.archiveBytes);
  else if (mode === 'network') archive = await downloadNativeArchive(variant,
    options.registry ?? resolveNativeRegistryConfig(options.registryEnvironment ?? process.env));
  else throw new NativeToolError('nativeCacheMiss');
  const bytes = extractNativeArchive(archive, variant);
  return await publishNativeCandidate(options.cacheRoot, descriptor, variant, bytes);
}

export async function importNativeTool(options) {
  return await resolveNativeTool({ ...options, mode: 'source-candidate' });
}
