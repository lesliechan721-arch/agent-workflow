import type { Scope } from '../types.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { resolvePartialCatalogOperationContext } from '../utils/catalog-operation-context.js';
import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { addIntentRoot, calculateIntentDigest, createEmptyIntent, type PluginIntent } from '../intent/intent-codec.js';
import { observeIntent, removeRoot, writeIntent, resolveIntentPath } from '../intent/intent-store.js';
import { observePreferences, selectAgents, resolvePreferencesPath } from '../intent/deployment-preferences.js';
import { describeStrongStateProblem } from '../intent/diagnostics.js';
import type { RecoveryDiagnostic, RecoveryReceipt } from '../recovery/receipt.js';

export interface IntentCommandOptions { scope: Scope; cwd: string; env?: NodeJS.ProcessEnv; token?: AwHomeMutationToken }
export interface IntentAddResult { changed: boolean; roots: string[]; errors: RecoveryDiagnostic[]; state?: PluginIntent }

function exactId(selector: string): string {
  const parsed = parsePluginId(selector);
  if (!parsed.sourceId || `${parsed.sourceId}/${parsed.pluginName}` !== selector) throw new Error('invalidArguments');
  return selector;
}

function diagnostic(code: string): RecoveryDiagnostic {
  const messages: Record<string, string> = {
    invalidArguments: '需要精确的 source/plugin ID。', sourceMissing: '插件来源未在本地配置。',
    sourceActiveUnavailable: '本地 Catalog 来源或 Active 不可用。',
    pluginIntentStateInvalid: '插件声明无效或不可读。',
  };
  return { code, message: messages[code] ?? `声明操作失败：${code}。` };
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9-]*$/u.test(code)) return code;
  const prefix = error instanceof Error ? error.message.split(':')[0] : '';
  return /^[A-Za-z][A-Za-z0-9-]*$/u.test(prefix) ? prefix : fallback;
}

export async function addRequirements(options: IntentCommandOptions & {
  selectors: readonly string[]; dryRun?: boolean; installSelectors?: boolean;
}): Promise<IntentAddResult> {
  let roots = [...new Set(options.selectors)];
  let selectors: ReturnType<typeof parsePluginId>[];
  try {
    if (!roots.length) throw new Error('invalidArguments');
    selectors = roots.map((selector) => parsePluginId(options.installSelectors ? selector : exactId(selector)));
  } catch {
    return { changed: false, roots, errors: [diagnostic('invalidArguments')] };
  }
  try {
    return await withAwHomeMutationLock({ env: options.env, token: options.token, action: async (token) => {
      const current = await observeIntent(options);
      if (current.state !== 'valid' && current.state !== 'absent') {
        return { changed: false, roots, errors: [diagnostic('pluginIntentStateInvalid')] };
      }
      const config = await readCatalogSourcesConfigSnapshot(options.env);
      const short = selectors.some((selector) => !selector.sourceId);
      const sourceIds = short ? config.config.sources.map((source) => source.id)
        : [...new Set(selectors.map((selector) => selector.sourceId!))];
      const configured = new Set(config.config.sources.map((source) => source.id));
      if (sourceIds.some((sourceId) => !configured.has(sourceId))) {
        return { changed: false, roots, errors: [diagnostic('sourceMissing')] };
      }
      const context = await resolvePartialCatalogOperationContext({ env: options.env, configSnapshot: config, sourceIds });
      if (short && context.catalog.sources.some((source) => source.error)) {
        return { changed: false, roots, errors: [diagnostic('sourceActiveUnavailable')] };
      }
      const resolved: string[] = [];
      for (const selector of selectors) {
        if (selector.sourceId) { resolved.push(`${selector.sourceId}/${selector.pluginName}`); continue; }
        const matches = context.catalog.sources.filter((source) =>
          source.resolution?.manifest.entries.some((entry) => entry.name === selector.pluginName));
        if (matches.length !== 1) {
          return { changed: false, roots, errors: [diagnostic(matches.length ? 'pluginSelectorAmbiguous' : 'pluginUnavailable')] };
        }
        resolved.push(`${matches[0]!.sourceId}/${selector.pluginName}`);
      }
      roots = [...new Set(resolved)];
      let next = current.state === 'valid' ? current.value : createEmptyIntent();
      for (const root of roots) {
        const [sourceId, pluginName] = root.split('/');
        const source = context.catalog.sources.find((entry) => entry.sourceId === sourceId)?.resolution;
        if (!source) return { changed: false, roots, errors: [diagnostic('sourceActiveUnavailable')] };
        if (!source.manifest.entries.some((entry) => entry.name === pluginName)) {
          return { changed: false, roots, errors: [diagnostic('pluginUnavailable')] };
        }
        next = addIntentRoot(next, root, source.logicalIdentity);
      }
      const changed = calculateIntentDigest(next) !== calculateIntentDigest(current.state === 'valid'
        ? current.value : createEmptyIntent());
      if (!changed || options.dryRun) return { changed, roots, errors: [], state: next };
      const saved = await writeIntent({ ...options, token }, next);
      return { changed: saved.changed, roots, errors: [], state: saved.value };
    } });
  } catch (error) {
    return { changed: false, roots, errors: [diagnostic(errorCode(error, 'sourceUnavailable'))] };
  }
}

export async function intentReceipt(command: string, options: IntentCommandOptions, result: IntentAddResult,
  preferencesChanged = false): Promise<RecoveryReceipt> {
  const [intent, preferences] = await Promise.all([observeIntent(options), observePreferences(options)]);
  let selection: RecoveryReceipt['selection'];
  try { selection = selectAgents({ preferences }); }
  catch { selection = { agents: [], origin: 'none', preferences: preferences.state }; }
  const roots = intent.state === 'valid' ? intent.value.roots.map((root) => root.pluginId)
    : intent.state === 'absent' ? [] : null;
  const errors = await Promise.all(result.errors.map(async (entry) => {
    if (entry.code === 'pluginIntentStateInvalid'
      && intent.state !== 'absent' && intent.state !== 'valid') {
      return describeStrongStateProblem({ kind: 'intent', scope: options.scope, state: intent.state,
        filePath: await resolveIntentPath(options) });
    }
    if (entry.code === 'deploymentPreferencesInvalid'
      && preferences.state !== 'absent' && preferences.state !== 'valid') {
      return describeStrongStateProblem({ kind: 'preferences', scope: options.scope, state: preferences.state,
        filePath: await resolvePreferencesPath(options) });
    }
    return entry;
  }));
  return {
    schemaVersion: 1, kind: 'aw-recovery', scope: options.scope, command,
    ok: errors.length === 0, intent: { state: intent.state,
      ...('digest' in intent ? { digest: intent.digest } : {}), roots },
    requestedRoots: result.roots, requestedTargets: [], selection, blockers: errors, errors,
    targetResults: [], remainingTargets: [], recoveryActions: errors.length ? ['检查声明和本地 Catalog 状态后重试。'] : [],
    declarationChanged: result.changed, preferencesChanged, configChanged: false, outputsMayHaveChanged: false,
  };
}

export async function intentAdd(options: IntentCommandOptions & { selectors: readonly string[] }): Promise<RecoveryReceipt> {
  return intentReceipt('intent:add', options, await addRequirements(options));
}

export async function intentRemove(options: IntentCommandOptions & { selector: string }): Promise<RecoveryReceipt> {
  let root: string;
  try { root = exactId(options.selector); }
  catch { return intentReceipt('intent:remove', options, { changed: false, roots: [options.selector], errors: [diagnostic('invalidArguments')] }); }
  try {
    const saved = await removeRoot(options, root);
    return intentReceipt('intent:remove', options, { changed: saved.changed, roots: [root], errors: [] });
  } catch (error) {
    return intentReceipt('intent:remove', options, { changed: false, roots: [root], errors: [diagnostic(errorCode(error, 'pluginIntentStateInvalid'))] });
  }
}

export async function intentList(options: IntentCommandOptions): Promise<RecoveryReceipt> {
  const intent = await observeIntent(options);
  return intentReceipt('intent:list', options, { changed: false, roots: intent.state === 'valid'
    ? intent.value.roots.map((root) => root.pluginId) : [], errors: intent.state === 'valid' || intent.state === 'absent'
      ? [] : [diagnostic('pluginIntentStateInvalid')] });
}
