import { createHash } from 'node:crypto';
import { canonicalizeIdentityValue } from '@lesliechan721/aw-plugin-core/manifest';
import {
  resolvePluginConfigObjectProperties,
  validatePluginConfigValue,
  type PluginConfigObjectField,
  type PluginConfigObject,
} from '@lesliechan721/aw-plugin-core';
import type {
  ObjectSuggestionItemV2,
  ObjectSuggestionPatch,
} from '../utils/plugin-config-suggestions.js';
import { configValuesEqual } from './model.js';

export function objectSuggestionContext(definition: PluginConfigObjectField, draft: PluginConfigObject) {
  const declaration = definition.suggestions;
  if (!declaration) return undefined;
  const initialized = { ...draft };
  // An unset object has no saved dependencies. Use only the dependency defaults
  // the schema actually declares, never an arbitrary dynamic candidate.
  for (const key of declaration.dependsOn ?? []) {
    if (Object.hasOwn(initialized, key)) continue;
    const property = resolvePluginConfigObjectProperties(definition, initialized).properties[key];
    if (!property) continue;
    const value = definition.default?.[key]
      ?? (definition.variants?.discriminator === key ? definition.variants.missing : undefined)
      ?? ('const' in property ? property.const : undefined)
      ?? ('valueRef' in property && property.valueRef?.include?.length === 1 ? property.valueRef.include[0] : undefined);
    if (value !== undefined && validatePluginConfigValue(property, value).length === 0) initialized[key] = value;
  }
  const properties = resolvePluginConfigObjectProperties(definition, initialized).properties;
  const targets = declaration.targets.filter((key) => Object.hasOwn(properties, key));
  return targets.length ? { declaration, draft: initialized, properties, targets } : undefined;
}

export function applyObjectSuggestionPatch(draft: PluginConfigObject, patch: ObjectSuggestionPatch): PluginConfigObject {
  const next = { ...draft, ...patch.set };
  for (const key of patch.unset ?? []) delete next[key];
  return next;
}

export function objectSuggestionFallback(
  definition: PluginConfigObjectField,
  context: NonNullable<ReturnType<typeof objectSuggestionContext>>,
): ObjectSuggestionItemV2[] {
  const { draft, declaration, targets, properties } = context;
  return (definition.choices?.presets ?? []).flatMap((preset) => {
    if (!(declaration.dependsOn ?? []).every((key) => Object.hasOwn(draft, key)
      ? configValuesEqual(draft[key], preset.value[key])
      : !Object.hasOwn(preset.value, key))) return [];
    const set: NonNullable<ObjectSuggestionPatch['set']> = {};
    const unset: string[] = [];
    for (const key of targets) {
      const value = preset.value[key];
      if (value !== undefined && typeof value !== 'object' && !validatePluginConfigValue(properties[key]!, value).length) {
        set[key] = value;
      } else if (value === undefined && !properties[key]!.required) unset.push(key);
    }
    if (!Object.keys(set).length && !unset.length) return [];
    return [{ title: preset.title, description: preset.description, recommended: preset.recommended,
      set, unset, source: 'builtin' as const }];
  });
}

/** A title is display text, not a group ID. Match the same group's patches
 * after a refresh, including no-patch grouping parents with distinct leaves. */
export function objectSuggestionGroupKey(item: ObjectSuggestionItemV2): string {
  const patchKey = (patch: ObjectSuggestionPatch): string => canonicalizeIdentityValue({
    set: patch.set ?? {}, unset: [...patch.unset ?? []].sort(),
  });
  const identity = {
    title: item.title, patch: patchKey(item),
    childTitle: item.children?.title ?? '',
    children: (item.children?.items ?? []).map((child) =>
      canonicalizeIdentityValue({ title: child.title, patch: patchKey(child) })).sort(),
  };
  return createHash('sha256').update(canonicalizeIdentityValue(identity)).digest('hex');
}
