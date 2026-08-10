import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { vi } from 'vitest';

import {
  assertPathWithinReadableRoots,
  assertPathWithinWritableRoots,
} from '../helpers/test-isolation.js';
import {
  createTestNativeCliGuard,
} from '../helpers/native-guard.js';
import type {
  TestPathFenceCheck,
  TestRootRegistry,
} from '../helpers/path-fence.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import type { TestPathFenceHook } from '../../src/utils/test-path-fence.js';

interface DistPathsModule {
  setEmbeddedPluginsRootOverrideForTests: (rootDir: string | null) => void;
}

interface DistMarketplaceModule {
  setCatalogPackageSourceForTests: (source: unknown) => void;
}

interface DistPluginCatalogModule {
  clearCurrentCatalogResolutionMemoForTests: () => void;
}

interface DistNativeCliModule {
  setNativeCliRunnerOverrideForTests: (runner: NativeCliRunner | null) => void;
}

interface DistTestPathFenceModule {
  setTestPathFenceHookForTests: (hook: TestPathFenceHook | null) => void;
}

interface DistStateModules {
  paths: DistPathsModule | null;
  marketplace: DistMarketplaceModule | null;
  pluginCatalog: DistPluginCatalogModule | null;
  nativeCli: DistNativeCliModule | null;
  testPathFence: DistTestPathFenceModule | null;
}

interface CachedDistStateModules {
  cacheKey: string;
  modules: DistStateModules;
}

const distStateModulePaths = {
  paths: 'src/utils/paths.js',
  marketplace: 'src/utils/marketplace.js',
  pluginCatalog: 'src/utils/plugin-catalog.js',
  nativeCli: 'src/utils/native-cli.js',
  testPathFence: 'src/utils/test-path-fence.js',
} as const;

const defaultCliPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const cachedDistStateModules = new Map<string, CachedDistStateModules>();

async function importDistModule<T>(
  cliPackageRoot: string,
  relativePath: string,
): Promise<T | null> {
  const modulePath = path.join(cliPackageRoot, 'dist', relativePath);
  if (!await fs.pathExists(modulePath)) {
    return null;
  }

  return import(pathToFileURL(modulePath).href) as Promise<T>;
}

async function resolveDistModuleCacheToken(
  cliPackageRoot: string,
  relativePath: string,
): Promise<string> {
  const modulePath = path.join(cliPackageRoot, 'dist', relativePath);
  if (!await fs.pathExists(modulePath)) {
    return `${relativePath}:missing`;
  }

  const stats = await fs.stat(modulePath);
  return `${relativePath}:${stats.size}:${stats.mtimeMs}`;
}

function hasFunctionExport(
  moduleValue: object | null,
  exportName: string,
): boolean {
  return Boolean(
    moduleValue &&
    typeof (moduleValue as Record<string, unknown>)[exportName] === 'function',
  );
}

async function loadDistStateModules(cliPackageRoot: string): Promise<DistStateModules> {
  const moduleEntries = Object.entries(distStateModulePaths) as Array<
    [keyof typeof distStateModulePaths, string]
  >;
  const cacheTokens = await Promise.all(
    moduleEntries.map(([, relativePath]) => resolveDistModuleCacheToken(cliPackageRoot, relativePath)),
  );
  const cacheKey = cacheTokens.join('|');
  const cached = cachedDistStateModules.get(cliPackageRoot);

  if (cached?.cacheKey === cacheKey) {
    return cached.modules;
  }

  if (cached) {
    vi.resetModules();
  }

  const rawPaths = await importDistModule<DistPathsModule>(cliPackageRoot, distStateModulePaths.paths);
  const rawMarketplace = await importDistModule<DistMarketplaceModule>(cliPackageRoot, distStateModulePaths.marketplace);
  const rawPluginCatalog = await importDistModule<DistPluginCatalogModule>(cliPackageRoot, distStateModulePaths.pluginCatalog);
  const rawNativeCli = await importDistModule<DistNativeCliModule>(cliPackageRoot, distStateModulePaths.nativeCli);
  const rawTestPathFence = await importDistModule<DistTestPathFenceModule>(cliPackageRoot, distStateModulePaths.testPathFence);

  const modules = {
    paths: hasFunctionExport(rawPaths, 'setEmbeddedPluginsRootOverrideForTests') ? rawPaths : null,
    marketplace: hasFunctionExport(rawMarketplace, 'setCatalogPackageSourceForTests') ? rawMarketplace : null,
    pluginCatalog: hasFunctionExport(rawPluginCatalog, 'clearCurrentCatalogResolutionMemoForTests') ? rawPluginCatalog : null,
    nativeCli: hasFunctionExport(rawNativeCli, 'setNativeCliRunnerOverrideForTests') ? rawNativeCli : null,
    testPathFence: hasFunctionExport(rawTestPathFence, 'setTestPathFenceHookForTests') ? rawTestPathFence : null,
  };

  if (Object.values(modules).some((entry) => entry !== null)) {
    cachedDistStateModules.set(cliPackageRoot, {
      cacheKey,
      modules,
    });
  } else {
    cachedDistStateModules.delete(cliPackageRoot);
  }

  return modules;
}

function createDistPathFenceHook(
  rootRegistry: TestRootRegistry,
): (check: TestPathFenceCheck) => void {
  return (check) => {
    if (check.access === 'read') {
      assertPathWithinReadableRoots(rootRegistry, {
        path: check.path,
        source: check.source,
        recommendedFix: check.recommendedFix,
      });
      return;
    }

    assertPathWithinWritableRoots(rootRegistry, {
      path: check.path,
      source: check.source,
      recommendedFix: check.recommendedFix,
    });
  };
}

export async function installDistStateForTests(
  rootRegistry: TestRootRegistry,
  cliPackageRoot = defaultCliPackageRoot,
): Promise<void> {
  const modules = await loadDistStateModules(cliPackageRoot);

  modules.paths?.setEmbeddedPluginsRootOverrideForTests(null);
  modules.marketplace?.setCatalogPackageSourceForTests(null);
  modules.pluginCatalog?.clearCurrentCatalogResolutionMemoForTests();
  modules.nativeCli?.setNativeCliRunnerOverrideForTests(createTestNativeCliGuard({
    cwdSource: 'dist runNativeCli()/createCommandExecutionContext() invocation.cwd',
    envSource: 'dist runNativeCli()/createCommandExecutionContext() invocation.env',
  }));
  modules.testPathFence?.setTestPathFenceHookForTests(createDistPathFenceHook(rootRegistry));
}

export async function resetDistStateForTests(): Promise<void> {
  for (const { modules } of cachedDistStateModules.values()) {
    modules.paths?.setEmbeddedPluginsRootOverrideForTests(null);
    modules.marketplace?.setCatalogPackageSourceForTests(null);
    modules.pluginCatalog?.clearCurrentCatalogResolutionMemoForTests();
    modules.nativeCli?.setNativeCliRunnerOverrideForTests(null);
    modules.testPathFence?.setTestPathFenceHookForTests(null);
  }
}
