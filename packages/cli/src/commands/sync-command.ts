import type { PlatformName, Scope } from '../types.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { readPluginIntentState } from '../utils/plugin-intent-state.js';
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
    | 'syncPluginNotDesired';

  constructor(code: SyncCommandError['code'], detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'SyncCommandError';
    this.code = code;
  }
}

function selectedIntentRoots(options: {
  roots: Awaited<ReturnType<typeof readPluginIntentState>>['roots'];
  managedCodexPluginIds: string[];
  selectors: string[];
  all: boolean;
  platform: PlatformName;
}): string[] {
  const eligible = options.roots.filter((root) => root.platforms.includes(options.platform));
  if (options.all) {
    const rootedNames = new Set(eligible.map((root) => parsePluginId(root.pluginId).pluginName));
    const managedNames = options.managedCodexPluginIds.flatMap((pluginId) => {
      const separator = pluginId.lastIndexOf('@');
      if (separator <= 0) return [];
      const pluginName = pluginId.slice(0, separator);
      return rootedNames.has(pluginName) ? [] : [pluginName];
    });
    return [...eligible.map((root) => root.pluginId), ...managedNames];
  }
  return options.selectors.map((selector) => {
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
  });
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
      const requested = selectors.length > 0 || options.all
        ? selectedIntentRoots({
            roots: intent.roots,
            managedCodexPluginIds: intent.managed.codexPluginIds,
            selectors,
            all: options.all === true,
            platform: options.platform,
          })
        : await selectInteractively({
            roots: intent.roots,
            platform: options.platform,
            prompt: options.prompt,
          });
      if (requested.length === 0) {
        throw new SyncCommandError(
          'syncSelectionRequired',
          `No desired ${options.platform} plugins exist in ${options.scope} scope.`,
        );
      }
      return installWriteCommand(requested, {
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
    },
  });
}

export const runSyncCommand = syncCommand;
