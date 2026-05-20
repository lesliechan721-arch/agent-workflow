import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';

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

const cliPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
let cachedDistStateModules: DistStateModules | null = null;

async function importDistModule<T>(
  relativePath: string,
): Promise<T | null> {
  const modulePath = path.join(cliPackageRoot, 'dist', relativePath);
  if (!await fs.pathExists(modulePath)) {
    return null;
  }

  return import(pathToFileURL(modulePath).href) as Promise<T>;
}

async function loadDistStateModules(): Promise<DistStateModules> {
  if (cachedDistStateModules) {
    return cachedDistStateModules;
  }

  const paths = await importDistModule<DistPathsModule>('src/utils/paths.js');
  const marketplace = await importDistModule<DistMarketplaceModule>('src/utils/marketplace.js');
  const pluginCatalog = await importDistModule<DistPluginCatalogModule>('src/utils/plugin-catalog.js');
  const nativeCli = await importDistModule<DistNativeCliModule>('src/utils/native-cli.js');
  const codexAppServer = await importDistModule<DistCodexAppServerModule>('src/utils/codex-app-server-client.js');
  const testPathFence = await importDistModule<DistTestPathFenceModule>('src/utils/test-path-fence.js');

  const modules = {
    paths,
    marketplace,
    pluginCatalog,
    nativeCli,
    codexAppServer,
    testPathFence,
  };

  if (Object.values(modules).some((entry) => entry !== null)) {
    cachedDistStateModules = modules;
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
  const modules = cachedDistStateModules;
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
