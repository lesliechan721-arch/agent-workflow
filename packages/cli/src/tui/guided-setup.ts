import { isPlatformTarget, resolvePluginConfigObjectProperties, validatePluginConfigValue, type PluginConfigValue } from '@lesliechan721/aw-plugin-core';
import { publicDiagnostic } from '../commands/public-lifecycle-result.js';
import type { RecoveryPlan } from '../recovery/coordinator.js';
import type { RecoveryDiagnostic, RecoveryTarget } from '../recovery/receipt.js';
import type { ConfigSuggestionsResponseV2 } from '../utils/plugin-config-suggestions.js';
import { mergeObjectSuggestionPatches } from '../utils/plugin-config-suggestion-runner.js';
import { isInstallConfigBlocked } from '../utils/plugin-config-diagnostics.js';
import type { Scope } from '../types.js';
import type { ConfigFieldViewModel, ConfigProfileKey } from './model.js';
import { agentLabel } from './glossary.js';

export interface GuidedConfigTarget {
  pluginId: string;
  profile: ConfigProfileKey;
  context: Scope;
  fieldKeys: string[];
}

type Position = Pick<RecoveryTarget, 'pluginId' | 'agent' | 'scope'>;

function guidedTargetKey(target: GuidedConfigTarget): string {
  return [target.pluginId, target.profile, target.context].join('\0');
}

export interface GuidedSetupPreflight {
  targets: GuidedConfigTarget[];
  readyTargets: Position[];
}

// Consume the actual recovery preview, not the global status summary: a plugin
// without any saved Intent can still introduce missing configuration via dependencies.
export function guidedSetupPreflight(plan: RecoveryPlan): GuidedSetupPreflight {
  if ((plan.command !== 'install' && plan.command !== 'sync' && plan.command !== 'reinstall')
    || (plan.blockExecution && !isInstallConfigBlocked(plan.receipt))
    || (plan.sourceRefreshes?.length ?? 0) > 0) return { targets: [], readyTargets: [] };
  const required = new Map<string, GuidedConfigTarget>();
  const rows = plan.receipt.targetResults;
  const add = (row: Position, raw: RecoveryDiagnostic) => {
    if (raw.code !== 'requiredConfigMissing') return;
    const diagnostic = publicDiagnostic(raw);
    const candidate: GuidedConfigTarget = {
      pluginId: diagnostic.subject?.pluginId ?? row.pluginId,
      profile: isPlatformTarget(diagnostic.subject?.target) ? diagnostic.subject.target : row.agent,
      context: diagnostic.subject?.scope ?? row.scope,
      fieldKeys: diagnostic.detail?.fieldKeys ?? [],
    };
    const key = guidedTargetKey(candidate);
    const previous = required.get(key);
    required.set(key, { ...candidate, fieldKeys: [...new Set([...previous?.fieldKeys ?? [], ...candidate.fieldKeys])] });
  };
  for (const row of rows) for (const blocker of row.blockers) add(row, blocker);
  // Dependency paths are root → provider. Longer paths must be initialized first.
  const depth = (target: GuidedConfigTarget): number => Math.max(0,
    ...(plan.joint?.demand.placements ?? []).flatMap((placement) =>
      placement.pluginId === target.pluginId && placement.target === target.profile
        ? placement.contributions.map((entry) => entry.path.length) : []),
    ...rows.flatMap((row) => row.pluginId === target.pluginId && row.agent === target.profile
      ? row.contributions?.map((entry) => entry.path.length) ?? [] : []));
  const targets = [...required.values()].sort((left, right) => depth(right) - depth(left)
    || left.pluginId.localeCompare(right.pluginId) || left.profile.localeCompare(right.profile));
  if (!targets.length) return { targets, readyTargets: [] };

  // Exact selection still names the original requested roots (not merely the
  // successfully prepared dependencies). The coordinator preserves global Intent.
  const selected = [...plan.joint?.selectedContributions ?? []];
  const candidateRoots = plan.options.exactTargets?.map(({ pluginId, agent, scope }) => ({
    pluginId, agent, scope: scope ?? plan.options.scope,
  })) ?? (plan.joint ? selected.flatMap(([placement, contributions]) =>
    contributions.flatMap((contribution) => contribution.path.filter((id) => plan.receipt.requestedRoots.includes(id))
      .map((pluginId) => ({ pluginId, agent: placement.target, scope: contribution.scope }))))
    : rows.filter((row) => plan.receipt.requestedRoots.includes(row.pluginId))
      .map(({ pluginId, agent, scope }) => ({ pluginId, agent, scope })));
  const readyTargets = [...new Map(candidateRoots.map((target) => [
    [target.pluginId, target.agent, target.scope].join('\0'), target,
  ])).values()].filter((candidate) => {
    const related = rows.filter((row) => row.agent === candidate.agent && (
      row.pluginId === candidate.pluginId && row.scope === candidate.scope
      || row.contributions?.some((entry) => entry.path.includes(candidate.pluginId) && entry.scope === candidate.scope)
      || selected.some(([placement, contributions]) =>
        placement.pluginId === row.pluginId && placement.target === row.agent && placement.scope === row.scope
        && contributions.some((entry) => entry.path.includes(candidate.pluginId) && entry.scope === candidate.scope))
      || !plan.joint && row.scope === candidate.scope && row.requiredBy.includes(candidate.pluginId)
    ));
    return related.length > 0 && related.every((row) => row.blockers.length === 0
      && row.satisfaction !== 'excluded' && row.satisfaction !== 'unsupported' && row.delivery !== null);
  });
  return { targets, readyTargets };
}

export function guidedSkipWarning(targets: readonly GuidedConfigTarget[]): string {
  return `跳过未配置平台：${targets.map(({ pluginId, profile }) =>
    `${pluginId} · ${profile === 'common' ? '公共设置' : agentLabel(profile)}`).join('、')}。保留 requiredConfigMissing 待配置告警，可在状态问题页补齐；不修改平台排除设置。`;
}

export function guidedFieldAvailable(field: ConfigFieldViewModel): boolean {
  return !field.configured && !field.invalidOverrideIssue && field.canSet
    && !field.sensitive && field.effectiveValue === undefined;
}

export function guidedSuggestionValue(
  field: ConfigFieldViewModel, response: ConfigSuggestionsResponseV2, allowHostDefault: boolean,
): { value: PluginConfigValue; badge: string } | undefined {
  const definition = field.definition;
  const nativeExecutor = definition.type === 'object'
    && Object.hasOwn(resolvePluginConfigObjectProperties(definition, { executor: 'native' }).properties, 'executor');
  for (const item of response.items) {
    if ('value' in item) {
      if (item.recommended && validatePluginConfigValue(definition, item.value).length === 0) {
        return { value: item.value, badge: '推荐预选 · 待确认' };
      }
      continue;
    }
    if (definition.type !== 'object') continue;
    const child = item.children?.items.find((candidate) => candidate.recommended);
    if (!child && (item.children || !item.recommended)) continue;
    const patch = child ? mergeObjectSuggestionPatches(item, child) : item;
    const value = { ...(nativeExecutor ? { executor: 'native' } : {}), ...patch.set };
    for (const key of patch.unset ?? []) delete (value as Record<string, unknown>)[key];
    if (validatePluginConfigValue(definition, value).length === 0) {
      return { value, badge: '推荐预选 · 待确认' };
    }
  }
  const fallback = { executor: 'native' };
  if (allowHostDefault && nativeExecutor && validatePluginConfigValue(definition, fallback).length === 0) {
    return { value: fallback, badge: '沿用宿主默认 · 待确认' };
  }
}
