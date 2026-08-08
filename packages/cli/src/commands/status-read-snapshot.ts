import type {
  CatalogResolution,
  EnvironmentDetection,
  InstalledLedger,
  PluginMeta,
} from '../types.js';
import {
  inspectCodexNativeEvidence,
  type CodexNativeEvidence,
  type InstallEvidenceReadSnapshot,
} from '../install-state/evidence.js';
import type { GlobalDependencyIndexInspection } from '../install-state/types.js';
import { inspectGlobalDependencyIndex } from '../install-state/facade.js';
import {
  readCodexNativeRecoveryBreadcrumb,
} from '../utils/codex-native-recovery.js';
import { readCodexNativePluginState } from '../utils/codex-native-state.js';
import { detectEnvironment } from '../utils/detect.js';
import { readInstalledLedger } from '../utils/local-marketplace.js';
import { resolvePluginsFromCatalog } from '../utils/manifest.js';
import type { NativeCliRunner } from '../utils/native-cli.js';

type CodexNativePluginState = Awaited<ReturnType<typeof readCodexNativePluginState>>;
type CodexNativeRecoveryBreadcrumb = Awaited<ReturnType<typeof readCodexNativeRecoveryBreadcrumb>>;

export interface StatusReadSnapshot extends InstallEvidenceReadSnapshot {
  readInstalledLedger(env: NodeJS.ProcessEnv): Promise<InstalledLedger>;
  resolveCatalogPlugins(catalog: CatalogResolution): Promise<PluginMeta[]>;
  detectEnvironment(options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    nativeCliRunner?: NativeCliRunner;
  }): Promise<EnvironmentDetection>;
  readCodexNativePluginState(options: {
    pluginName: string;
    env: NodeJS.ProcessEnv;
  }): Promise<CodexNativePluginState>;
  readCodexNativeRecoveryBreadcrumb(options: {
    pluginName: string;
    env: NodeJS.ProcessEnv;
  }): Promise<CodexNativeRecoveryBreadcrumb>;
}

export function createStatusReadSnapshot(): StatusReadSnapshot {
  let ledger: Promise<InstalledLedger> | undefined;
  let detection: Promise<EnvironmentDetection> | undefined;
  let dependencyIndex: Promise<GlobalDependencyIndexInspection> | undefined;
  const nativeEvidence = new Map<string, Promise<CodexNativeEvidence>>();
  const nativePluginStates = new Map<string, Promise<CodexNativePluginState>>();
  const nativeRecovery = new Map<string, Promise<CodexNativeRecoveryBreadcrumb>>();
  const catalogPlugins = new Map<string, Promise<PluginMeta[]>>();

  return {
    readInstalledLedger(env) {
      ledger ??= readInstalledLedger(env);
      return ledger;
    },
    resolveCatalogPlugins(catalog) {
      let current = catalogPlugins.get(catalog.rootDir);
      if (!current) {
        current = resolvePluginsFromCatalog(catalog.rootDir, undefined);
        catalogPlugins.set(catalog.rootDir, current);
      }
      return current;
    },
    detectEnvironment(options) {
      detection ??= detectEnvironment(options.cwd, options.env, {
        includeAgentVersions: true,
        nativeCliRunner: options.nativeCliRunner,
      });
      return detection;
    },
    inspectGlobalDependencyIndex(env) {
      dependencyIndex ??= inspectGlobalDependencyIndex(env);
      return dependencyIndex;
    },
    inspectCodexNativeEvidence(options) {
      const pluginId = options.pluginIdHint ?? `${options.pluginName}@aw`;
      const key = `${options.pluginName}\0${pluginId}`;
      let current = nativeEvidence.get(key);
      if (!current) {
        current = inspectCodexNativeEvidence(
          options.pluginName,
          options.pluginIdHint,
          options.env,
        );
        nativeEvidence.set(key, current);
      }
      return current;
    },
    readCodexNativePluginState(options) {
      let current = nativePluginStates.get(options.pluginName);
      if (!current) {
        current = readCodexNativePluginState(options.pluginName, options.env);
        nativePluginStates.set(options.pluginName, current);
      }
      return current;
    },
    readCodexNativeRecoveryBreadcrumb(options) {
      let current = nativeRecovery.get(options.pluginName);
      if (!current) {
        current = readCodexNativeRecoveryBreadcrumb(options.pluginName, options.env);
        nativeRecovery.set(options.pluginName, current);
      }
      return current;
    },
  };
}
