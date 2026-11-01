import {
  resolvePluginConfigObjectProperties,
  type PluginConfigSchemaField,
  type PluginConfigScalarField,
  type PluginConfigScalar,
  type PluginConfigValueReference,
  type PluginConfigValue,
  type PluginConfigValidationIssue,
  type Scope,
} from '@lesliechan721/aw-plugin-core';

export type ConfigReferenceScalar = PluginConfigScalarField & { valueRef: PluginConfigValueReference };

export interface ConfigReferenceSelection {
  choices: Array<{ value: PluginConfigScalar; title: string }>;
  issues: PluginConfigValidationIssue[];
  source: string;
  entries: Record<string, string>;
}
export interface ConfigReferenceContext {
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

export function configReferenceKey(scalar: PluginConfigScalarField): string {
  return JSON.stringify({ ...scalar, default: undefined });
}

export function configReferenceSelection(context: ConfigReferenceContext | undefined, scalar: PluginConfigScalarField): ConfigReferenceSelection {
  return context?.selections[configReferenceKey(scalar)] ?? {
    choices: [], issues: [], source: 'missing', entries: {},
  };
}

export function configReferenceMessage(scalar: PluginConfigScalarField, selection: ConfigReferenceSelection | undefined, value: unknown): string | undefined {
  if (!selection) return '正在读取引用选项。';
  const source = 'valueRef' in scalar ? scalar.valueRef!.field : '';
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
  fields: Record<string, PluginConfigSchemaField>,
  drafts: Partial<Record<Scope, ConfigReferenceDraft>>,
  contexts: Partial<Record<Scope, ConfigReferenceContext>>,
): Array<{ key: string; source: string }> {
  if (!drafts.user || !drafts.project || !contexts.user || !contexts.project) return [];
  return Object.entries(drafts.project.updates).flatMap(([key, value]) => {
    const field = fields[key];
    if (!field) return [];
    return configReferenceValues(field, value).flatMap(({ scalar, value }) => {
      const ref = scalar.valueRef!;
      if (ref.include?.includes(value) || !(Object.hasOwn(drafts.user!.updates, ref.field) || drafts.user!.removes.includes(ref.field))) return [];
      const project = configReferenceSelection(contexts.project, scalar);
      const user = configReferenceSelection(contexts.user, scalar);
      if (project.source === 'project') return [];
      const identity = JSON.stringify(value);
      return project.entries[identity] !== user.entries[identity] ? [{ key, source: ref.field }] : [];
    });
  });
}
