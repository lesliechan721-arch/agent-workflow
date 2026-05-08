import path from 'node:path';
import crypto from 'node:crypto';

import fs from 'fs-extra';

import { readInstallRecordFileAt } from './facade.js';
import { createHistoricalLifecycleRuntimePaths } from './paths.js';
import type { InstallStateTransactionStage } from './transactions.js';
import type {
  HistoricalLifecycleRuntimePathSet,
  HistoricalLifecycleRuntimeRef,
  InstallRecordFile,
  PluginLocation,
} from './types.js';
import { resolveAwHome } from '../utils/paths.js';

export const AW_RUNTIME_STATE_PRESERVE_DIRS = [
  'plugin-config',
  'dependency-index',
  'lifecycle-runtimes',
  'native-recovery',
  'shared-runtime-owners',
] as const;

export const AW_RUNTIME_STATE_PRESERVE_DIR_SET = new Set<string>(AW_RUNTIME_STATE_PRESERVE_DIRS);

export function isAwRuntimeStatePreserveDir(directoryName: string): boolean {
  return AW_RUNTIME_STATE_PRESERVE_DIR_SET.has(directoryName);
}

export interface HistoricalLifecycleRuntimeStageHandle extends InstallStateTransactionStage {
  runtimeRef: HistoricalLifecycleRuntimeRef;
  runtimePaths: HistoricalLifecycleRuntimePathSet;
  stagingRoot: string;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removePathIfExists(targetPath: string): Promise<void> {
  if (await fs.pathExists(targetPath)) {
    await fs.remove(targetPath);
  }
}

async function pruneEmptyParentsUntil(rootDir: string, fromDir: string): Promise<void> {
  let current = fromDir;
  const normalizedRoot = path.resolve(rootDir);
  while (path.resolve(current).startsWith(`${normalizedRoot}${path.sep}`)) {
    const entries = await fs.readdir(current).catch(() => []);
    if (entries.length > 0) {
      return;
    }
    await fs.remove(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

export async function stageHistoricalLifecycleRuntime(options: {
  cwd: string;
  location: PluginLocation;
  sourceBundleRoot: string;
  pluginVersion: string;
  manifestDigest: string;
  bundleFingerprint: string;
  events: Array<'install' | 'upgrade' | 'uninstall'>;
  createdAt?: string;
  recordId?: string;
  manifestRelativePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<HistoricalLifecycleRuntimeStageHandle> {
  const nonce = crypto.randomUUID();
  const runtimePaths = createHistoricalLifecycleRuntimePaths({
    cwd: options.cwd,
    location: options.location,
    recordId: options.recordId,
    manifestDigest: options.manifestDigest,
    bundleFingerprint: options.bundleFingerprint,
    nonce,
    env: options.env,
    manifestRelativePath: options.manifestRelativePath,
  });
  const runtimeDir = path.dirname(runtimePaths.runtimeRoot);
  const stagingRoot = path.join(runtimeDir, 'pending', runtimePaths.runtimeId);
  const stagingBundleRoot = path.join(stagingRoot, 'bundle');

  await fs.ensureDir(path.dirname(stagingRoot));
  await fs.copy(options.sourceBundleRoot, stagingBundleRoot, {
    overwrite: false,
    errorOnExist: true,
  });
  if (!(await fs.pathExists(path.join(stagingBundleRoot, path.relative(runtimePaths.bundleRoot, runtimePaths.manifestPath))))) {
    await fs.remove(stagingRoot);
    throw new Error(`Historical lifecycle runtime manifest is missing from staged bundle: ${runtimePaths.manifestPath}`);
  }

  let committed = false;

  return {
    label: 'historical lifecycle runtime',
    runtimePaths,
    stagingRoot,
    runtimeRef: {
      runtimeRoot: runtimePaths.runtimeRoot,
      bundleRoot: runtimePaths.bundleRoot,
      manifestPath: runtimePaths.manifestPath,
      pluginVersion: options.pluginVersion,
      sourceManifestDigest: options.manifestDigest,
      bundleFingerprint: options.bundleFingerprint,
      events: options.events,
      createdAt: options.createdAt ?? new Date().toISOString(),
    },
    async commit() {
      if (committed) {
        return;
      }
      if (await fs.pathExists(runtimePaths.runtimeRoot)) {
        throw new Error(`Historical lifecycle runtime already exists: ${runtimePaths.runtimeRoot}`);
      }
      await fs.ensureDir(path.dirname(runtimePaths.runtimeRoot));
      await fs.move(stagingRoot, runtimePaths.runtimeRoot, { overwrite: false });
      committed = true;
    },
    async rollback() {
      try {
        if (committed) {
          await removePathIfExists(runtimePaths.runtimeRoot);
        } else {
          await removePathIfExists(stagingRoot);
        }
        return undefined;
      } catch (error) {
        return {
          code: 'historicalLifecycleRollbackFailed',
          message: 'Historical lifecycle runtime rollback failed.',
          path: committed ? runtimePaths.runtimeRoot : stagingRoot,
          error: formatError(error),
        };
      }
    },
    async finalize() {
      try {
        await removePathIfExists(stagingRoot);
        await pruneEmptyParentsUntil(runtimeDir, path.join(runtimeDir, 'pending'));
        return undefined;
      } catch (error) {
        return {
          code: 'historicalLifecycleFinalizeFailed',
          message: 'Historical lifecycle runtime finalize failed.',
          path: stagingRoot,
          error: formatError(error),
        };
      }
    },
  };
}

export interface HistoricalLifecycleRuntimeCoverage {
  trusted: boolean;
  verifiedRecordPaths: string[];
  reason?: string;
}

export interface HistoricalLifecycleRuntimeGcResult {
  status: 'deleted' | 'skipped';
  deletedRuntimeRoots: string[];
  retainedRuntimeRoots: string[];
  reason?: string;
}

export async function buildHistoricalLifecycleRuntimeCoverage(options: {
  verifiedRecords: Array<InstallRecordFile | { path: string; value: InstallRecordFile }>;
}): Promise<HistoricalLifecycleRuntimeCoverage> {
  const verifiedRecordPaths = options.verifiedRecords.map((entry) => 'path' in entry ? entry.path : entry.record.lifecycle?.runtimeRoot ?? '');
  return {
    trusted: true,
    verifiedRecordPaths: verifiedRecordPaths.filter((entry) => entry.length > 0),
  };
}

async function listHistoricalLifecycleRuntimeRoots(rootDir: string): Promise<string[]> {
  if (!(await fs.pathExists(rootDir))) {
    return [];
  }

  const output: string[] = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isDirectory() && entry.name === 'bundle')) {
      output.push(current);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'pending') {
        continue;
      }
      queue.push(path.join(current, entry.name));
    }
  }

  return output.sort();
}

export async function garbageCollectHistoricalLifecycleRuntimes(options: {
  coverage: HistoricalLifecycleRuntimeCoverage;
  env?: NodeJS.ProcessEnv;
}): Promise<HistoricalLifecycleRuntimeGcResult> {
  const awHome = resolveAwHome(options.env);
  const runtimeRoot = path.join(awHome, 'lifecycle-runtimes');
  const existingRuntimeRoots = await listHistoricalLifecycleRuntimeRoots(runtimeRoot);

  if (!options.coverage.trusted) {
    return {
      status: 'skipped',
      deletedRuntimeRoots: [],
      retainedRuntimeRoots: existingRuntimeRoots,
      reason: options.coverage.reason ?? 'verified record coverage is not trusted',
    };
  }

  const referencedRuntimeRoots = new Set<string>();
  for (const recordPath of options.coverage.verifiedRecordPaths) {
    const record = await readInstallRecordFileAt(recordPath, { env: options.env });
    if (record.status !== 'ok') {
      return {
        status: 'skipped',
        deletedRuntimeRoots: [],
        retainedRuntimeRoots: existingRuntimeRoots,
        reason: `verified record is unreadable: ${recordPath}`,
      };
    }
    const lifecycle = record.value.record.lifecycle;
    if (!lifecycle) {
      continue;
    }
    if (!path.resolve(lifecycle.runtimeRoot).startsWith(path.resolve(runtimeRoot))) {
      return {
        status: 'skipped',
        deletedRuntimeRoots: [],
        retainedRuntimeRoots: existingRuntimeRoots,
        reason: `record lifecycle runtime escapes ${runtimeRoot}: ${lifecycle.runtimeRoot}`,
      };
    }
    if (!(await fs.pathExists(lifecycle.runtimeRoot))) {
      return {
        status: 'skipped',
        deletedRuntimeRoots: [],
        retainedRuntimeRoots: existingRuntimeRoots,
        reason: `referenced lifecycle runtime is missing: ${lifecycle.runtimeRoot}`,
      };
    }
    referencedRuntimeRoots.add(path.resolve(lifecycle.runtimeRoot));
  }

  const deletedRuntimeRoots: string[] = [];
  const retainedRuntimeRoots: string[] = [];
  for (const candidate of existingRuntimeRoots) {
    if (referencedRuntimeRoots.has(path.resolve(candidate))) {
      retainedRuntimeRoots.push(candidate);
      continue;
    }
    await fs.remove(candidate);
    deletedRuntimeRoots.push(candidate);
  }

  return {
    status: 'deleted',
    deletedRuntimeRoots,
    retainedRuntimeRoots,
  };
}
