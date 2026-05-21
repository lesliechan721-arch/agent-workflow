import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { vi } from 'vitest';

import {
  assertPathWithinReadableRoots,
  assertPathWithinWritableRoots,
} from '../helpers/test-isolation.js';
import {
  createTestCodexAppServerProcessGuard,
  createTestNativeCliGuard,
} from '../helpers/native-guard.js';
import type {
  TestPathFenceCheck,
  TestRootRegistry,
} from '../helpers/path-fence.js';
import type { CodexAppServerProcessRunner } from '../../src/utils/codex-app-server-client.js';
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

interface DistCodexAppServerModule {
  setCodexAppServerProcessRunnerOverrideForTests: (runner: CodexAppServerProcessRunner | null) => void;
}

interface DistTestPathFenceModule {
  setTestPathFenceHookForTests: (hook: TestPathFenceHook | null) => void;
}

interface DistStateModules {
  paths: DistPathsModule | null;
  marketplace: DistMarketplaceModule | null;
  pluginCatalog: DistPluginCatalogModule | null;
  nativeCli: DistNativeCliModule | null;
  codexAppServer: DistCodexAppServerModule | null;
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
  codexAppServer: 'src/utils/codex-app-server-client.js',
  testPathFence: 'src/utils/test-path-fence.js',
} as const;

const cliPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
let cachedDistStateModules: CachedDistStateModules | null = null;

async function importDistModule<T>(
  relativePath: string,
): Promise<T | null> {
  const modulePath = path.join(cliPackageRoot, 'dist', relativePath);
  if (!await fs.pathExists(modulePath)) {
    return null;
  }

  return import(pathToFileURL(modulePath).href) as Promise<T>;
}

async function resolveDistModuleCacheToken(relativePath: string): Promise<string> {
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

async function loadDistStateModules(): Promise<DistStateModules> {
  const moduleEntries = Object.entries(distStateModulePaths) as Array<
    [keyof typeof distStateModulePaths, string]
  >;
  const cacheTokens = await Promise.all(
    moduleEntries.map(([, relativePath]) => resolveDistModuleCacheToken(relativePath)),
  );
  const cacheKey = cacheTokens.join('|');

  if (cachedDistStateModules?.cacheKey === cacheKey) {
    return cachedDistStateModules.modules;
  }

  if (cachedDistStateModules) {
    vi.resetModules();
  }

  const rawPaths = await importDistModule<DistPathsModule>(distStateModulePaths.paths);
  const rawMarketplace = await importDistModule<DistMarketplaceModule>(distStateModulePaths.marketplace);
  const rawPluginCatalog = await importDistModule<DistPluginCatalogModule>(distStateModulePaths.pluginCatalog);
  const rawNativeCli = await importDistModule<DistNativeCliModule>(distStateModulePaths.nativeCli);
  const rawCodexAppServer = await importDistModule<DistCodexAppServerModule>(distStateModulePaths.codexAppServer);
  const rawTestPathFence = await importDistModule<DistTestPathFenceModule>(distStateModulePaths.testPathFence);

  const modules = {
    paths: hasFunctionExport(rawPaths, 'setEmbeddedPluginsRootOverrideForTests') ? rawPaths : null,
    marketplace: hasFunctionExport(rawMarketplace, 'setCatalogPackageSourceForTests') ? rawMarketplace : null,
    pluginCatalog: hasFunctionExport(rawPluginCatalog, 'clearCurrentCatalogResolutionMemoForTests') ? rawPluginCatalog : null,
    nativeCli: hasFunctionExport(rawNativeCli, 'setNativeCliRunnerOverrideForTests') ? rawNativeCli : null,
    codexAppServer: hasFunctionExport(rawCodexAppServer, 'setCodexAppServerProcessRunnerOverrideForTests') ? rawCodexAppServer : null,
    testPathFence: hasFunctionExport(rawTestPathFence, 'setTestPathFenceHookForTests') ? rawTestPathFence : null,
  };

  if (Object.values(modules).some((entry) => entry !== null)) {
    cachedDistStateModules = {
      cacheKey,
      modules,
    };
  } else {
    cachedDistStateModules = null;
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
): Promise<void> {
  const modules = await loadDistStateModules();

  modules.paths?.setEmbeddedPluginsRootOverrideForTests(null);
  modules.marketplace?.setCatalogPackageSourceForTests(null);
  modules.pluginCatalog?.clearCurrentCatalogResolutionMemoForTests();
  modules.nativeCli?.setNativeCliRunnerOverrideForTests(createTestNativeCliGuard({
    cwdSource: 'dist runNativeCli()/createCommandExecutionContext() invocation.cwd',
    envSource: 'dist runNativeCli()/createCommandExecutionContext() invocation.env',
  }));
  modules.codexAppServer?.setCodexAppServerProcessRunnerOverrideForTests(createTestCodexAppServerProcessGuard({
    cwdSource: 'dist installCodexPluginViaAppServer()/uninstallCodexPluginViaAppServer() invocation.cwd',
    envSource: 'dist installCodexPluginViaAppServer()/uninstallCodexPluginViaAppServer() invocation.env',
  }));
  modules.testPathFence?.setTestPathFenceHookForTests(createDistPathFenceHook(rootRegistry));
}

export async function resetDistStateForTests(): Promise<void> {
  const modules = cachedDistStateModules?.modules;
  if (!modules) {
    return;
  }

  modules.paths?.setEmbeddedPluginsRootOverrideForTests(null);
  modules.marketplace?.setCatalogPackageSourceForTests(null);
  modules.pluginCatalog?.clearCurrentCatalogResolutionMemoForTests();
  modules.nativeCli?.setNativeCliRunnerOverrideForTests(null);
  modules.codexAppServer?.setCodexAppServerProcessRunnerOverrideForTests(null);
  modules.testPathFence?.setTestPathFenceHookForTests(null);
}
