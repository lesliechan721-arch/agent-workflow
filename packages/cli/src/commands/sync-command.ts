import type { PlatformName, Scope } from '../types.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import {
  canonicalMarketplaceRegistrationNames,
  inventoryCatalogSourceReferences,
  type CatalogSourceReferenceInventory,
} from '../utils/catalog-source-references.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { readPluginIntentState } from '../utils/plugin-intent-state.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import type { CliPrompt } from './runtime.js';
import {
  installWriteCommand,
} from './write-commands.js';
import type {
  RebuildCommandResult,
  RebuildCommandRuntime,
} from './rebuild-command.js';

export interface SyncCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform: PlatformName;
  scope: Scope;
  all?: boolean;
  json?: boolean;
  interactive?: boolean;
  prompt?: CliPrompt;
  allowManagedCodexInstall?: boolean;
  yes?: boolean;
}

export class SyncCommandError extends Error {
  readonly code:
    | 'syncSelectorConflict'
    | 'syncSelectionRequired'
    | 'syncSelectionCancelled'
    | 'syncPlatformUnsupported'
    | 'syncPluginNotDesired'
    | 'syncManagedIdentityUnresolved';

  constructor(code: SyncCommandError['code'], detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'SyncCommandError';
    this.code = code;
  }
}

function selectedIntentRoots(options: {
  roots: Awaited<ReturnType<typeof readPluginIntentState>>['roots'];
  managedCodexPluginIds: string[];
  inventory: CatalogSourceReferenceInventory;
  configuredSources: Array<{ id: string; primary: boolean }>;
  selectors: string[];
  all: boolean;
  platform: PlatformName;
}): { selectors: string[]; preservedManagedIds: string[] } {
  const eligible = options.roots.filter((root) => root.platforms.includes(options.platform));
  if (options.all) {
    const marketplaceSources = new Map<string, Set<string>>();
    const configuredSourceById = new Map(options.configuredSources.map((source) => [source.id, source]));
    for (const reference of options.inventory.references) {
      if (reference.kind !== 'namespacedMarketplace'
        || reference.pluginName !== undefined
        || !reference.sourceId
        || !reference.marketplaceName) continue;
      const sources = marketplaceSources.get(reference.marketplaceName) ?? new Set<string>();
      sources.add(reference.sourceId);
      marketplaceSources.set(reference.marketplaceName, sources);
    }
    for (const source of options.configuredSources) {
      if (canonicalMarketplaceRegistrationNames(options.inventory.references, source.id).length > 0) {
        continue;
      }
      const marketplaceName = source.primary ? 'aw' : `aw-${source.id}`;
      if (!marketplaceSources.has(marketplaceName)) {
        marketplaceSources.set(marketplaceName, new Set([source.id]));
      }
    }
    const desiredNativeIds = new Set(eligible.flatMap((root) => {
      const parsed = parsePluginId(root.pluginId);
      if (!parsed.sourceId) return [];
      const source = configuredSourceById.get(parsed.sourceId);
      if (!source) return [];
      const registeredNames = canonicalMarketplaceRegistrationNames(
        options.inventory.references,
        source.id,
      );
      if (registeredNames.length > 1) {
        throw new SyncCommandError(
          'syncManagedIdentityUnresolved',
          `Catalog source ${source.id} has multiple canonical native marketplace registrations.`,
        );
      }
      const marketplaceName = registeredNames[0]
        ?? (source.primary ? 'aw' : `aw-${source.id}`);
      const mappedSources = marketplaceSources.get(marketplaceName);
      return mappedSources?.size === 1 && mappedSources.has(source.id)
        ? [`${parsed.pluginName}@${marketplaceName}`]
        : [];
    }));
    const preservedManagedIds: string[] = [];
    const managedSelectors = options.managedCodexPluginIds.flatMap((pluginId) => {
      if (desiredNativeIds.has(pluginId)) return [];
      const separator = pluginId.lastIndexOf('@');
      if (separator <= 0 || separator === pluginId.length - 1) {
        throw new SyncCommandError(
          'syncManagedIdentityUnresolved',
          `Managed Codex plugin ID ${pluginId} is invalid.`,
        );
      }
      const pluginName = pluginId.slice(0, separator);
      const marketplaceName = pluginId.slice(separator + 1);
      const sources = marketplaceSources.get(marketplaceName);
      if (sources && sources.size > 1) {
        throw new SyncCommandError(
          'syncManagedIdentityUnresolved',
          `Managed Codex plugin ID ${pluginId} does not map to one canonical Catalog source.`,
        );
      }
      if (!sources || sources.size === 0) {
        preservedManagedIds.push(pluginId);
        return [];
      }
      return [`${[...sources][0]!}/${pluginName}`];
    });
    const desiredSelectors = eligible.map((root) => root.pluginId);
    const duplicateSelector = managedSelectors.find((selector, index) =>
      managedSelectors.indexOf(selector) !== index || desiredSelectors.includes(selector));
    if (duplicateSelector) {
      throw new SyncCommandError(
        'syncManagedIdentityUnresolved',
        `Multiple native identities map to ${duplicateSelector}; exact reconciliation is unavailable.`,
      );
    }
    return { selectors: [...managedSelectors, ...desiredSelectors], preservedManagedIds };
  }
  return {
    selectors: options.selectors.map((selector) => {
    const parsed = parsePluginId(selector);
    const matches = eligible.filter((root) => {
      const rootParsed = parsePluginId(root.pluginId);
      return rootParsed.pluginName === parsed.pluginName
        && (parsed.sourceId === undefined || rootParsed.sourceId === parsed.sourceId);
    });
    if (matches.length !== 1) {
      throw new SyncCommandError(
        'syncPluginNotDesired',
        matches.length === 0
          ? `${selector} is not a desired ${options.platform} root in this scope.`
          : `${selector} is ambiguous across desired Catalog sources.`,
      );
    }
    return matches[0]!.pluginId;
    }),
    preservedManagedIds: [],
  };
}

async function selectInteractively(options: {
  roots: Awaited<ReturnType<typeof readPluginIntentState>>['roots'];
  platform: PlatformName;
  prompt?: CliPrompt;
}): Promise<string[]> {
  const eligible = options.roots.filter((root) => root.platforms.includes(options.platform));
  if (!options.prompt?.multiSelect) {
    throw new SyncCommandError(
      'syncSelectionRequired',
      'Specify one or more plugins or use --all.',
    );
  }
  const result = await options.prompt.multiSelect({
    message: 'Select desired plugins to reconcile',
    choices: eligible.map((root) => ({ value: root.pluginId, label: root.pluginId })),
    defaultValues: eligible.map((root) => root.pluginId),
  });
  if (result.cancelled) {
    throw new SyncCommandError('syncSelectionCancelled', 'Plugin selection was cancelled.');
  }
  if (!result.value || result.value.length === 0) {
    throw new SyncCommandError('syncSelectionRequired', 'Select at least one desired plugin.');
  }
  return result.value;
}

export async function syncCommand(
  selectors: string[],
  options: SyncCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  if (options.platform !== 'codex') {
    throw new SyncCommandError(
      'syncPlatformUnsupported',
      'The public sync rollout currently supports only --platform codex.',
    );
  }
  if (options.all && selectors.length > 0) {
    throw new SyncCommandError(
      'syncSelectorConflict',
      'Plugin selectors and --all are mutually exclusive.',
    );
  }
  if (options.json && !options.all && selectors.length === 0) {
    throw new SyncCommandError(
      'syncSelectionRequired',
      'JSON sync requires plugin selectors or --all.',
    );
  }
  if (!options.all && selectors.length === 0 && !options.interactive) {
    throw new SyncCommandError(
      'syncSelectionRequired',
      'Non-interactive sync requires plugin selectors or --all.',
    );
  }

  const env = options.env ?? runtime.env ?? process.env;
  return withAwHomeMutationLock({
    env,
    token: runtime.awHomeMutationToken,
    action: async (token) => {
      const intent = await readPluginIntentState({
        scope: options.scope,
        cwd: options.cwd,
        env,
      });
      const inventory = options.all
        ? await (runtime.inventoryCatalogSourceReferences
          ?? inventoryCatalogSourceReferences)({ cwd: options.cwd, env })
        : { inventorySchemaVersion: 1 as const, references: [], errors: [] };
      const configuredSources = options.all
        ? (await readCatalogSourcesConfigSnapshot(env)).config.sources
        : [];
      const selection = selectors.length > 0 || options.all
        ? selectedIntentRoots({
            roots: intent.roots,
            managedCodexPluginIds: intent.managed.codexPluginIds,
            inventory,
            configuredSources,
            selectors,
            all: options.all === true,
            platform: options.platform,
          })
        : {
            selectors: await selectInteractively({
              roots: intent.roots,
              platform: options.platform,
              prompt: options.prompt,
            }),
            preservedManagedIds: [],
          };
      const requested = selection.selectors;
      const preservedWarning = selection.preservedManagedIds.length > 0
        ? `syncManagedIdentityPreserved: ${selection.preservedManagedIds.join(', ')} does not map to a canonical Catalog source.`
        : undefined;
      if (requested.length === 0) {
        if (options.all && intent.managed.codexPluginIds.length > 0) {
          return {
            platforms: [options.platform],
            plugins: [],
            warnings: preservedWarning ? [preservedWarning] : [],
            rebuildResults: [],
            targetResults: [],
            overallState: 'succeeded',
            receiptTargets: [],
          };
        }
        throw new SyncCommandError(
          'syncSelectionRequired',
          `No desired ${options.platform} plugins exist in ${options.scope} scope.`,
        );
      }
      const result = await installWriteCommand(requested, {
        cwd: options.cwd,
        scope: options.scope,
        platform: options.platform,
        ...(options.yes ? { yes: true } : {}),
        ...(options.allowManagedCodexInstall ? { allowManagedCodexInstall: true } : {}),
      }, {
        ...runtime,
        env,
        awHomeMutationToken: token,
        reconcileIntentOnly: true,
        directCli: true,
      });
      return preservedWarning
        ? { ...result, warnings: [...result.warnings, preservedWarning] }
        : result;
    },
  });
}

export const runSyncCommand = syncCommand;
