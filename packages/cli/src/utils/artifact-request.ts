import {
  getPluginConfigDependencyKeys,
  type ComponentKind,
  type PlatformRenderContextV2,
  type PlatformTarget,
  type PluginConfigSchemaField,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { NormalizedPluginManifest, Scope } from '../types.js';
import type { ResolvedArtifactRenderConfig } from './artifact-renderer.js';
import { redactPluginScriptOutput } from './plugin-scripts.js';

export function resolvePlatformComponentBatches(options: {
  manifest: NormalizedPluginManifest; platform: PlatformTarget; renderScope: Scope; kinds: readonly ComponentKind[];
  config: ResolvedArtifactRenderConfig;
}): Array<Pick<PlatformRenderContextV2, 'allowedOutputKinds' | 'config'>> {
  const { artifacts, platforms } = options.manifest;
  if (!artifacts || (platforms?.length && !platforms.includes(options.platform))
    || (artifacts.scopes && !artifacts.scopes.includes(options.renderScope))) return [];
  const kinds = new Set(options.kinds);
  const groups: ComponentKind[][] = [['skill'], ['mcp', 'agent', 'hook', 'instruction']];
  return groups.map((group) => group.filter((kind) => kinds.has(kind)))
    .filter((batch) => batch.length > 0)
    .map((allowedOutputKinds) => ({ allowedOutputKinds,
      config: selectPlatformRenderConfig({ resolved: options.config, keys: artifacts.configKeys,
        nonSensitive: allowedOutputKinds.includes('skill') }) }));
}

export function selectPlatformRenderConfigKeys(options: {
  resolved: ResolvedArtifactRenderConfig; keys: readonly string[]; nonSensitive: boolean;
}): string[] {
  const fields = options.resolved.schema ?? {};
  const definition = options.resolved.definition ?? { schemaVersion: 5 as const, fields };
  const keys = new Set<string>();
  for (const key of options.keys) {
    const closure = getPluginConfigDependencyKeys(definition, [key], options.resolved.referenceContext);
    if (options.nonSensitive && closure.some((dependency) => fields[dependency]?.sensitive === true)) continue;
    for (const dependency of closure) keys.add(dependency);
  }
  return [...keys];
}

export function selectPlatformRenderConfig(options: {
  resolved: ResolvedArtifactRenderConfig; keys: readonly string[]; nonSensitive: boolean;
}): PlatformRenderContextV2['config'] {
  const keys = new Set(selectPlatformRenderConfigKeys(options));
  const select = <T>(values: Record<string, T>): Record<string, T> => Object.fromEntries(
    Object.entries(values).filter(([key]) => keys.has(key)));
  const tokens = (value: unknown): string[] => value !== null && typeof value === 'object'
    ? Object.values(value).flatMap(tokens) : value === undefined || value === null || value === '' ? [] : [String(value)];
  const sensitiveValues = Object.entries(options.resolved.schema ?? {}).flatMap(([key, field]) =>
    field.sensitive ? tokens(options.resolved.values[key]) : []);
  return {
    schema: { schemaVersion: 5, fields: select<PluginConfigSchemaField>(options.resolved.schema ?? {}) },
    values: select(options.resolved.values),
    sources: Object.fromEntries([...keys].map((key) => [key, options.resolved.sources[key] ?? 'missing'])),
    issues: options.resolved.issues.filter((issue) => keys.has(issue.key)).map((issue) => ({
      code: issue.code ?? issue.type, path: { field: issue.key },
      message: redactPluginScriptOutput(issue.message, sensitiveValues), recoverable: true,
    })),
  };
}

export function selectManagedCommandRenderConfig(resolved: ResolvedArtifactRenderConfig, refreshKeys: readonly string[]):
Pick<ResolvedArtifactRenderConfig, 'schema' | 'values' | 'sources' | 'issues'> {
  const selected = selectPlatformRenderConfig({ resolved, keys: refreshKeys, nonSensitive: true });
  if (resolved.targetScope !== 'user' || resolved.referenceContext?.platform !== undefined
    || Object.values(selected.sources).includes('platform')) {
    throw new Error('Command routes require common user configuration.');
  }
  if (refreshKeys.some((key) => !Object.hasOwn(selected.sources, key))) {
    throw new Error('managedCommandSensitiveConfigDenied: Command inputs and their dependencies must be non-sensitive.');
  }
  const issues = resolved.issues.filter((issue) => Object.hasOwn(selected.sources, issue.key));
  return { schema: selected.schema.fields, values: selected.values, sources: selected.sources, issues };
}
