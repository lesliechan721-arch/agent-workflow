import {
  resolvePluginConfigObjectProperties,
  type PluginConfigSchemaField,
  type PluginConfigScalarField,
  type PluginConfigScalar,
  type PluginConfigValueReference,
  type PluginConfigValue,
  type PluginConfigValidationIssue,
  type PlatformTarget,
} from '@lesliechan721/aw-plugin-core';
import type { ConfigProfileKey } from './model.js';

export type ConfigReferenceScalar = PluginConfigScalarField & { valueRef: PluginConfigValueReference };

export interface ConfigReferenceSelection {
  choices: Array<{ value: PluginConfigScalar; title: string }>;
  issues: PluginConfigValidationIssue[];
  source: string;
  entries: Record<string, string>;
}
export interface ConfigReferenceContext {
  platform?: PlatformTarget;
  selections: Record<string, ConfigReferenceSelection>;
}
export interface ConfigReferenceDraft {
  updates: Record<string, PluginConfigValue>;
  removes: string[];
}

/** Inspect all schema branches before the editor chooses its target layer. */
export function configReferenceScalars(field: PluginConfigSchemaField): ConfigReferenceScalar[] {
  if (field.type === 'array') return configReferenceScalars(field.items as PluginConfigSchemaField);
  if (field.type !== 'object') return 'valueRef' in field && field.valueRef ? [field as ConfigReferenceScalar] : [];
  if (!field.properties) return field.additionalProperties ? configReferenceScalars(field.additionalProperties) : [];
  return [field.properties, ...Object.values(field.variants?.cases ?? {}).map((entry) => entry.properties),
    ...(field.variants?.otherwise ? [field.variants.otherwise.properties] : [])]
    .flatMap((properties) => Object.values(properties).flatMap((child) => configReferenceScalars(child as PluginConfigSchemaField)));
}

export function configReferenceKey(scalar: PluginConfigScalarField, platform?: PlatformTarget): string {
  return JSON.stringify({ profile: platform ?? 'common', field: { ...scalar, default: undefined } });
}

export function configReferenceSelection(context: ConfigReferenceContext | undefined, scalar: PluginConfigScalarField): ConfigReferenceSelection {
  return context?.selections[configReferenceKey(scalar, context.platform)] ?? {
    choices: [], issues: [], source: 'missing', entries: {},
  };
}

export function configReferenceSource(scalar: PluginConfigScalarField): string {
  if (!('valueRef' in scalar) || !scalar.valueRef) return '';
  return `${scalar.valueRef.plugin ? `${scalar.valueRef.plugin}.` : ''}${scalar.valueRef.field}`;
}

export function configReferenceMessage(scalar: PluginConfigScalarField, selection: ConfigReferenceSelection | undefined, value: unknown): string | undefined {
  if (!selection) return '正在读取引用选项。';
  const source = configReferenceSource(scalar);
  if (selection.issues.length) return `来源 ${source} 配置无效：${selection.issues[0]!.message} 请返回修复来源配置。`;
  if (!selection.choices.length) return `来源 ${source} 没有可选值。请返回修改来源配置。`;
  if (value !== undefined && !selection.choices.some((choice) => choice.value === value)) {
    return `原值 ${JSON.stringify(value)} 已失效；不符合来源 ${source} 的引用或标量约束。请选择有效值或删除此属性。`;
  }
  return undefined;
}

/** Only active leaves with actual values create a cross-layer dependency. */
export function configReferenceValues(field: PluginConfigSchemaField, value: unknown): Array<{ scalar: ConfigReferenceScalar; value: PluginConfigScalar }> {
  if (field.type === 'array') return Array.isArray(value) ? value.flatMap((item) => configReferenceValues(field.items as PluginConfigSchemaField, item)) : [];
  if (field.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const properties = resolvePluginConfigObjectProperties(field, value).properties;
    return Object.entries(value).flatMap(([key, item]) => {
      const child = properties[key] ?? field.additionalProperties;
      return child ? configReferenceValues(child as PluginConfigSchemaField, item) : [];
    });
  }
  return 'valueRef' in field && field.valueRef && value !== undefined ? [{ scalar: field as ConfigReferenceScalar, value: value as PluginConfigScalar }] : [];
}

export function configCrossLayerDependencies(
  fields: Partial<Record<ConfigProfileKey, Record<string, PluginConfigSchemaField>>>,
  drafts: Partial<Record<ConfigProfileKey, ConfigReferenceDraft>>,
  contexts: Partial<Record<ConfigProfileKey, ConfigReferenceContext>>,
): Array<{ profile: ConfigProfileKey; key: string; source: string }> {
  if (!drafts.common || !contexts.common) return [];
  const commonDraft = drafts.common;
  const commonContext = contexts.common;
  return (Object.entries(drafts) as Array<[ConfigProfileKey, ConfigReferenceDraft]>)
    .filter(([profile]) => profile !== 'common' && contexts[profile])
    .flatMap(([profile, draft]) => Object.entries(draft.updates).flatMap(([key, value]) => {
      const field = fields[profile]?.[key];
      if (!field) return [];
      return configReferenceValues(field, value).flatMap(({ scalar, value }) => {
        const ref = scalar.valueRef!;
        if (ref.plugin) return [];
        if (ref.include?.includes(value)
          || !(Object.hasOwn(commonDraft.updates, ref.field) || commonDraft.removes.includes(ref.field))) return [];
        const platform = configReferenceSelection(contexts[profile], scalar);
        const common = configReferenceSelection(commonContext, scalar);
        if (platform.source === 'platform') return [];
        const identity = JSON.stringify(value);
        return platform.entries[identity] !== common.entries[identity] ? [{ profile, key, source: ref.field }] : [];
      });
    }));
}
