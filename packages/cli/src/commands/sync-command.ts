import type { PlatformSelection, Scope } from '../types.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { readPluginIntentState } from '../utils/plugin-intent-state.js';
import { syncCatalogSourceGeneration } from '../utils/catalog-generation-service.js';
import type { CliPrompt } from './runtime.js';
import { syncWriteCommand } from './write-commands.js';
import type {
  RebuildCommandResult,
  RebuildCommandRuntime,
} from './rebuild-command.js';
import { createOperationPlan } from './operation-plan.js';
import type { ReconcileOperationPlan } from './reconcile-operation-plan.js';

export interface SyncCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform: PlatformSelection;
  scope: Scope;
  all?: boolean;
  json?: boolean;
  interactive?: boolean;
  prompt?: CliPrompt;
  allowManagedCodexInstall?: boolean;
  yes?: boolean;
  refresh?: boolean;
  cliVersion?: string;
}

export class SyncCommandError extends Error {
  readonly code:
    | 'syncSelectorConflict'
    | 'syncSelectionRequired'
    | 'syncSelectionCancelled'
    | 'syncPluginNotDesired'
    | 'syncManagedIdentityUnresolved';

  constructor(code: SyncCommandError['code'], detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'SyncCommandError';
    this.code = code;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergedSyncOverallState(
  results: readonly RebuildCommandResult[],
  plan: ReconcileOperationPlan | undefined,
): RebuildCommandResult['overallState'] {
  if (results.every((result) => result.overallState === 'succeeded')) return 'succeeded';
  if (results.some((result) => result.overallState === 'partial')) return 'partial';
  if (!plan) return 'failed';
  const requested = new Set(plan.targets
    .filter((target) => target.relation === 'requested')
    .map((target) => `${target.pluginId}\0${target.platform}`));
  const completedRequested = results.some((result) => result.targetResults.some((target) =>
    target.state === 'completed'
    && target.action !== 'skipped'
    && target.target.pluginId !== undefined
    && requested.has(`${target.target.pluginId}\0${target.target.platform}`)));
  return completedRequested ? 'partial' : 'failed';
}

function mergeSyncResults(results: RebuildCommandResult[]): RebuildCommandResult {
  const operationPlans = results.flatMap((result) => result.operationPlan ? [result.operationPlan] : []);
  const dependencyPlans = results.flatMap((result) =>
    result.dependencyPlan ? [result.dependencyPlan] : []);
  const dependencyPlan: ReconcileOperationPlan | undefined = dependencyPlans.length > 0
    ? {
        requestedPluginIds: [...new Set(dependencyPlans.flatMap((plan) =>
          plan.requestedPluginIds))].sort(),
        resolvedPluginIds: [...new Set(dependencyPlans.flatMap((plan) =>
          plan.resolvedPluginIds))].sort(),
        dependencyEdges: dependencyPlans.flatMap((plan) => plan.dependencyEdges).sort((left, right) =>
          compareText(
            `${left.platform}\0${left.from}\0${left.to}`,
            `${right.platform}\0${right.from}\0${right.to}`,
          )),
        scopeOverrides: dependencyPlans.flatMap((plan) => plan.scopeOverrides).sort((left, right) =>
          compareText(`${left.platform}\0${left.pluginId}`, `${right.platform}\0${right.pluginId}`)),
        targets: dependencyPlans.flatMap((plan) => plan.targets).sort((left, right) =>
          compareText(
            `${left.platform}\0${left.pluginId}\0${left.resolvedScope}\0${left.order}`,
            `${right.platform}\0${right.pluginId}\0${right.resolvedScope}\0${right.order}`,
          )),
      }
    : undefined;
  return {
    platforms: [...new Set(results.flatMap((result) => result.platforms))],
    plugins: [...new Set(results.flatMap((result) => result.plugins))],
    warnings: results.flatMap((result) => result.warnings),
    rebuildResults: results.flatMap((result) => result.rebuildResults),
    targetResults: results.flatMap((result) => result.targetResults),
    overallState: mergedSyncOverallState(results, dependencyPlan),
    receiptTargets: results.flatMap((result) => result.receiptTargets),
    ...(dependencyPlan ? { dependencyPlan } : {}),
    ...(results.some((result) => result.codexReconcilePlans !== undefined)
      ? { codexReconcilePlans: results.flatMap((result) => result.codexReconcilePlans ?? []) }
      : {}),
    ...(operationPlans.length > 0 ? {
      operationPlan: createOperationPlan({
        intentChanges: operationPlans.flatMap((plan) => plan.intentChanges),
        actions: operationPlans.flatMap((plan) => plan.actions),
        changes: operationPlans.flatMap((plan) => plan.changes),
        warnings: operationPlans.flatMap((plan) => plan.warnings),
        evidence: {
          catalogDigests: operationPlans.flatMap((plan) => plan.evidence.catalogDigests),
          intentDigests: operationPlans.flatMap((plan) => plan.evidence.intentDigests),
          configDigests: operationPlans.flatMap((plan) => plan.evidence.configDigests),
          targetOwnerFingerprints: operationPlans.flatMap((plan) =>
            plan.evidence.targetOwnerFingerprints),
        },
      }),
    } : {}),
  };
}

function selectedIntentRoots(options: {
  roots: Awaited<ReturnType<typeof readPluginIntentState>>['roots'];
  selectors: string[];
  all: boolean;
  platform: PlatformSelection;
}): string[] {
  const eligible = options.roots.filter((root) => options.platform === 'both'
    || root.platforms.includes(options.platform));
  if (options.all) return eligible.map((root) => root.pluginId);
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
  platform: PlatformSelection;
  prompt?: CliPrompt;
}): Promise<string[]> {
  const eligible = options.roots.filter((root) => options.platform === 'both'
    || root.platforms.includes(options.platform));
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
  const initialIntent = await readPluginIntentState({
    scope: options.scope,
    cwd: options.cwd,
    env,
  });
  const requested = selectors.length > 0 || options.all
    ? selectedIntentRoots({
        roots: initialIntent.roots,
        selectors,
        all: options.all === true,
        platform: options.platform,
      })
    : await selectInteractively({
        roots: initialIntent.roots,
        platform: options.platform,
        prompt: options.prompt,
      });
  if (requested.length === 0) {
    throw new SyncCommandError(
      'syncSelectionRequired',
      `No desired ${options.platform} plugins exist in ${options.scope} scope.`,
    );
  }
  const refreshWarnings: string[] = [];
  if (options.refresh) {
    if (!options.cliVersion) throw new Error('syncRefreshCliVersionRequired');
    const sourceIds = [...new Set(requested.map((selector) => parsePluginId(selector).sourceId!))];
    for (const sourceId of sourceIds) {
      await syncCatalogSourceGeneration({
        sourceId,
        cliVersion: options.cliVersion,
        cwd: options.cwd,
        impactConfirmed: options.yes === true,
        env,
        runtime: runtime.catalogGenerationRuntime,
      }).catch((error) => {
        refreshWarnings.push(
          `catalogSourceRefreshFailed: ${sourceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }
  return withAwHomeMutationLock({
    env,
    token: runtime.awHomeMutationToken,
    action: async (token) => {
      const intent = await readPluginIntentState({
        scope: options.scope,
        cwd: options.cwd,
        env,
      });
      const currentRequested = selectedIntentRoots({
        roots: intent.roots,
        selectors: requested,
        all: false,
        platform: options.platform,
      });
      if (JSON.stringify(currentRequested) !== JSON.stringify(requested)) {
        throw new SyncCommandError('syncPluginNotDesired', 'Desired plugin intent changed during Catalog refresh.');
      }
      const work = new Map<string, { platform: 'codex' | 'claude'; selectors: string[] }>();
      for (const selector of requested) {
        const sourceId = parsePluginId(selector).sourceId!;
        const root = intent.roots.find((candidate) => candidate.pluginId === selector)!;
        for (const platform of (options.platform === 'both'
          ? root.platforms
          : [options.platform])) {
          const key = `${sourceId}\0${platform}`;
          const current = work.get(key) ?? { platform, selectors: [] };
          current.selectors.push(selector);
          work.set(key, current);
        }
      }
      const sourceResults: RebuildCommandResult[] = [];
      for (const item of work.values()) {
        try {
          sourceResults.push(await syncWriteCommand(item.selectors, {
            cwd: options.cwd,
            scope: options.scope,
            platform: item.platform,
            ...(options.yes ? { yes: true } : {}),
            ...(options.allowManagedCodexInstall ? { allowManagedCodexInstall: true } : {}),
          }, {
            ...runtime,
            env,
            awHomeMutationToken: token,
            directCli: true,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const targets = item.selectors.map((selector) => ({
            pluginName: parsePluginId(selector).pluginName,
            pluginId: selector,
            sourceId: parsePluginId(selector).sourceId!,
            platform: item.platform,
            scope: options.scope,
          }));
          sourceResults.push({
            platforms: [item.platform],
            plugins: [],
            warnings: [],
            rebuildResults: [],
            targetResults: targets.map((target) => ({
              target,
              action: 'sync',
              state: 'failed',
              message,
            })),
            overallState: 'failed',
            receiptTargets: targets,
          });
        }
      }
      const result = mergeSyncResults(sourceResults);
      return refreshWarnings.length > 0
        ? { ...result, warnings: [...result.warnings, ...refreshWarnings] }
        : result;
    },
  });
}

export const runSyncCommand = syncCommand;
