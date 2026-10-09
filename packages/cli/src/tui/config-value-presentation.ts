import { stripVTControlCharacters } from 'node:util';

import {
  validatePluginConfigValue,
  decodePluginConfigSummaryPath,
  matchPluginConfigPreset,
  resolvePluginConfigObjectProperties,
  PLUGIN_CONFIG_SUMMARY_MAX_CODE_POINTS,
  type PluginConfigJoinSummary,
  type PluginConfigArray,
  type PluginConfigObject,
  type PluginConfigSchemaField,
  type PluginConfigScalar,
} from '@lesliechan721/aw-plugin-core';

export interface ValuePresentation {
  text: string;
  state: 'value' | 'unset' | 'invalid' | 'sensitive';
  complete: boolean;
  hiddenProperties?: string[];
}

// Configuration values are not diagnostics: retain ordinary paths and token-like text.
export function safeConfigText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '');
}

export function configObjectHasSensitiveChild(field: PluginConfigSchemaField): boolean {
  if (field.type !== 'object') return false;
  return Object.values(field.properties ?? {}).some((property) => property.sensitive === true)
    || (field.additionalProperties !== false && field.additionalProperties?.sensitive === true);
}

function scalarText(value: PluginConfigScalar): string {
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (value === '') return '（空字符串）';
  return safeConfigText(String(value));
}

function boundedValue(text: string, hiddenProperties: string[] = []): ValuePresentation {
  const points = [...text];
  const abbreviated = points.length > PLUGIN_CONFIG_SUMMARY_MAX_CODE_POINTS;
  return {
    text: abbreviated ? `${points.slice(0, PLUGIN_CONFIG_SUMMARY_MAX_CODE_POINTS - 1).join('')}…` : text,
    state: 'value',
    complete: !abbreviated && hiddenProperties.length === 0,
    ...(hiddenProperties.length > 0 ? { hiddenProperties } : {}),
  };
}

/** Accept safe projected values; callers keep the complete value for editing and diffs. */
export function presentConfigValue(options: {
  definition: PluginConfigSchemaField;
  value?: unknown;
  configured?: boolean;
  privateValue?: boolean;
  invalid?: boolean;
  full?: boolean;
  summary?: PluginConfigJoinSummary;
  itemSummary?: PluginConfigJoinSummary;
}): ValuePresentation {
  const { definition, value } = options;
  const configured = options.configured ?? value !== undefined;
  if (options.privateValue || definition.sensitive === true || configObjectHasSensitiveChild(definition)) {
    return { text: configured ? '已设置' : '未设置', state: 'sensitive', complete: true };
  }
  if (!configured && !options.invalid) {
    if ('const' in definition && definition.const !== undefined) return boundedValue(scalarText(definition.const));
    return { text: '未设置', state: 'unset', complete: true };
  }
  if (options.invalid || validatePluginConfigValue(definition, value).length > 0) {
    return { text: '需修正', state: 'invalid', complete: true };
  }
  if (options.full) return {
    text: definition.type === 'object' || definition.type === 'array'
      ? safeConfigText(JSON.stringify(value)) : scalarText(value as PluginConfigScalar),
    state: 'value', complete: true,
  };
  if (definition.type === 'array') {
    const items = value as PluginConfigArray;
    if (items.length === 0) return boundedValue('空列表');
    const previews = items.slice(0, 2).map((item) => presentConfigValue({
      definition: definition.items,
      value: item,
      summary: options.itemSummary,
    }));
    const text = previews.map((preview) => definition.items.type === 'object'
      ? preview.text : `[${preview.text}]`).join(' · ')
      + (items.length > 2 ? ` +${items.length - 2} 项` : '');
    const result = boundedValue(text);
    return { ...result, complete: result.complete && items.length <= 2 && previews.every((item) => item.complete) };
  }
  if (definition.type !== 'object') return boundedValue(scalarText(value as PluginConfigScalar));

  const object = value as PluginConfigObject;
  const properties = resolvePluginConfigObjectProperties(definition, object).properties;
  if (options.summary && definition.properties) {
    const selected = new Set<string>();
    const text = options.summary.parts.map((part) => {
      const property = decodePluginConfigSummaryPath(part.path);
      selected.add(property);
      const child = properties[property];
      if (!child || !Object.hasOwn(object, property) && !('const' in child && child.const !== undefined)) {
        return safeConfigText(options.summary!.missing);
      }
      const value = object[property] ?? ('const' in child ? child.const : undefined);
      const title = part.format === 'choiceTitle' ? matchPluginConfigPreset(child, value)?.title : undefined;
      return title === undefined ? presentConfigValue({ definition: child, value }).text : safeConfigText(title);
    }).join(safeConfigText(options.summary.separator));
    return boundedValue(text, Object.keys(object).filter((key) => !selected.has(key)));
  }
  const keys = definition.properties
    ? Object.keys(properties).filter((key) => {
      const child = properties[key]!;
      return Object.hasOwn(object, key) || 'const' in child && child.const !== undefined;
    })
    : Object.keys(object).sort((left, right) => left.localeCompare(right, 'en'));
  if (keys.length === 0) return boundedValue('（空对象）');
  const previews = keys.slice(0, 2).map((key) => {
    const child = properties[key] ?? (definition.additionalProperties === false ? undefined : definition.additionalProperties);
    const title = child?.title ?? key;
    const preview = child ? presentConfigValue({ definition: child, value: object[key] })
      : { text: safeConfigText(JSON.stringify(object[key])), complete: true };
    return { text: `${safeConfigText(title)}=${preview.text}`, complete: preview.complete };
  });
  const result = boundedValue(previews.map((preview) => preview.text).join(' · '), keys.slice(2));
  return { ...result, complete: result.complete && previews.every((preview) => preview.complete) };
}
