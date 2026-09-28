import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { resolvePartialCatalogOperationContext } from '../utils/catalog-operation-context.js';
import { withAwHomeMutationLock, type AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import {
  addProjectIntentRoot,
  calculateProjectIntentDigest,
  createEmptyProjectIntent,
  observeProjectIntent,
  removeProjectRoot,
  writeProjectIntent,
  type ProjectIntentObservation,
  type ProjectPluginIntentV3,
} from './project-state.js';
import {
  normalizeProjectAgents,
  observeProjectPreferences,
  resetProjectTargets,
  setProjectAgents,
} from './project-preferences.js';
import type { ProjectDiagnostic, ProjectRecoveryReceiptV1 } from './project-types.js';

export interface ProjectCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  token?: AwHomeMutationToken;
}

export interface ProjectRequirementResult {
  changed: boolean;
  roots: string[];
  errors: ProjectDiagnostic[];
  state?: ProjectPluginIntentV3;
}

function exactPluginId(selector: string): string {
  const parsed = parsePluginId(selector);
  if (!parsed.sourceId || `${parsed.sourceId}/${parsed.pluginName}` !== selector) {
    throw new Error('Project plugin ID must be source/plugin.');
  }
  return selector;
}

function diagnostic(error: unknown, fallback: string): ProjectDiagnostic {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : '';
  const namedCode = /^([A-Za-z][A-Za-z0-9]*)(?::|$)/u.exec(message)?.[1];
  return {
    code: typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(code) ? code : namedCode ?? fallback,
    message: fallback === 'invalidArguments' ? '需要精确的 source/plugin ID。'
      : fallback === 'sourceUnavailable' ? '本地 Catalog 来源或 Active 不可用。'
        : '项目声明或本地偏好操作失败。',
  };
}

function rootsOf(observation: ProjectIntentObservation): string[] {
  return observation.state === 'valid'
    ? observation.value.roots.map((root) => root.pluginId) : [];
}

async function receipt(
  command: string,
  options: ProjectCommandOptions,
  result: ProjectRequirementResult,
  preferencesChanged = false,
): Promise<ProjectRecoveryReceiptV1> {
  const [intent, preferences] = await Promise.all([
    observeProjectIntent(options), observeProjectPreferences(options),
  ]);
  const agents = preferences.state === 'valid' ? preferences.value.agents : [];
  return {
    schemaVersion: 1,
    kind: 'aw-project-recovery',
    command,
    ok: result.errors.length === 0,
    intent: {
      state: intent.state,
      ...('digest' in intent ? { digest: intent.digest } : {}),
      roots: intent.state === 'valid' || intent.state === 'absent'
        ? rootsOf(intent) : null,
    },
    requestedRoots: result.roots,
    selection: { agents, origin: agents.length ? 'preference' : 'none' },
    blockers: result.errors,
    targetResults: [],
    remainingTargets: [],
    recoveryActions: result.errors.length ? ['检查项目声明和本地 Catalog 状态后重试。'] : [],
    declarationChanged: result.changed,
    preferencesChanged,
    outputsMayHaveChanged: false,
  };
}

export async function addProjectRequirements(
  options: ProjectCommandOptions & { selectors: readonly string[]; dryRun?: boolean; installSelectors?: boolean },
): Promise<ProjectRequirementResult> {
  let roots = [...new Set(options.selectors)];
  let selectors: ReturnType<typeof parsePluginId>[];
  try {
    selectors = roots.map((selector) => parsePluginId(options.installSelectors ? selector : exactPluginId(selector)));
    if (selectors.length === 0) throw new Error('Project add requires a plugin ID.');
  } catch (error) {
    return { changed: false, roots, errors: [{ code: 'invalidArguments', message: options.installSelectors
      ? '插件选择器必须是 plugin 或 source/plugin。' : '需要精确的 source/plugin ID。' }] };
  }
  try {
    return await withAwHomeMutationLock({ env: options.env, token: options.token, action: async (token) => {
      const observation = await observeProjectIntent(options);
      if (observation.state !== 'valid' && observation.state !== 'absent') {
        return { changed: false, roots, errors: [{
          code: 'pluginIntentStateInvalid', message: `项目声明处于 ${observation.state} 状态，不能增加需求。`,
        }] };
      }
      const config = await readCatalogSourcesConfigSnapshot(options.env);
      const hasShortSelector = selectors.some((selector) => !selector.sourceId);
      const sourceIds = hasShortSelector
        ? config.config.sources.map((source) => source.id)
        : [...new Set(selectors.map((selector) => selector.sourceId!))];
      const configured = new Set(config.config.sources.map((source) => source.id));
      if (sourceIds.some((sourceId) => !configured.has(sourceId))) {
        return { changed: false, roots, errors: [{ code: 'sourceMissing', message: '项目插件来源未在本地配置。' }] };
      }
      const context = await resolvePartialCatalogOperationContext({
        env: options.env, configSnapshot: config, sourceIds,
      });
      if (hasShortSelector && context.catalog.sources.some((source) => source.error)) {
        return { changed: false, roots, errors: [{ code: 'sourceActiveUnavailable', message: '无法核验所有本地 Active 来源中的插件短名。' }] };
      }
      const resolved: string[] = [];
      for (const selector of selectors) {
        if (selector.sourceId) {
          resolved.push(`${selector.sourceId}/${selector.pluginName}`);
          continue;
        }
        const matches = context.catalog.sources.filter((source) =>
          source.resolution?.manifest.entries.some((entry) => entry.name === selector.pluginName));
        if (matches.length !== 1) {
          return { changed: false, roots, errors: [{ code: matches.length ? 'pluginSelectorAmbiguous' : 'pluginUnavailable',
            message: matches.length ? `插件 ${selector.pluginName} 在多个来源中存在，请使用 source/plugin。`
              : `本地 Active 中没有插件 ${selector.pluginName}。` }] };
        }
        resolved.push(`${matches[0]!.sourceId}/${selector.pluginName}`);
      }
      roots = [...new Set(resolved)];
      let next: ProjectPluginIntentV3 = observation.state === 'valid'
        ? observation.value : createEmptyProjectIntent();
      for (const root of roots) {
        const [sourceId, pluginName] = root.split('/');
        const source = context.catalog.sources.find((entry) => entry.sourceId === sourceId)?.resolution;
        if (!source) return { changed: false, roots, errors: [{ code: 'sourceActiveUnavailable', message: '插件来源没有可用的本地 Active。' }] };
        if (!source.manifest.entries.some((entry) => entry.name === pluginName)) {
          return { changed: false, roots, errors: [{ code: 'pluginUnavailable', message: `本地 Active 中没有 ${root}。` }] };
        }
        next = addProjectIntentRoot(next, root, source.logicalIdentity);
      }
      const changed = calculateProjectIntentDigest(next)
        !== calculateProjectIntentDigest(observation.state === 'valid' ? observation.value : createEmptyProjectIntent());
      if (!changed || options.dryRun) return { changed, roots, errors: [], state: next };
      const written = await writeProjectIntent({ cwd: options.cwd, env: options.env, token }, next);
      return { changed: written.changed, roots, errors: [], state: written.state };
    } });
  } catch (error) {
    return { changed: false, roots, errors: [diagnostic(error, 'sourceUnavailable')] };
  }
}

export async function projectAdd(options: ProjectCommandOptions & { selectors: readonly string[] }) {
  return receipt('project:add', options, await addProjectRequirements(options));
}

export async function projectRemove(options: ProjectCommandOptions & { selector: string }) {
  let root: string;
  try { root = exactPluginId(options.selector); }
  catch (error) { return receipt('project:remove', options, { changed: false, roots: [options.selector], errors: [diagnostic(error, 'invalidArguments')] }); }
  try {
    const result = await removeProjectRoot(options, root);
    return receipt('project:remove', options, { changed: result.changed, roots: [root], errors: [] });
  } catch (error) {
    return receipt('project:remove', options, { changed: false, roots: [root], errors: [diagnostic(error, 'pluginIntentStateInvalid')] });
  }
}

export async function projectTargetsSet(options: ProjectCommandOptions & { agents: readonly string[] }) {
  try {
    const result = await setProjectAgents(options, normalizeProjectAgents(options.agents));
    return receipt('project:targets:set', options, { changed: false, roots: [], errors: [] }, result.changed);
  } catch (error) {
    return receipt('project:targets:set', options, { changed: false, roots: [], errors: [diagnostic(error, 'invalidArguments')] });
  }
}

export async function projectTargetsReset(options: ProjectCommandOptions) {
  try {
    const result = await resetProjectTargets(options);
    return receipt('project:targets:reset', options, { changed: false, roots: [], errors: [] }, result.changed);
  } catch (error) {
    return receipt('project:targets:reset', options, { changed: false, roots: [], errors: [diagnostic(error, 'projectPreferencesInvalid')] });
  }
}

