import { describe, expect, it } from 'vitest';
import { normalizePluginConfigDefinition, type PluginConfigSchemaField } from '@lesliechan721/aw-plugin-core';

import { presentConfigValue, safeConfigText } from '../../src/tui/config-value-presentation.js';

const profile: PluginConfigSchemaField = {
  type: 'object',
  properties: {
    model: { type: 'string', title: '模型', required: true },
    reasoningEffort: { type: 'string', title: '强度', required: true },
    extra: { type: 'boolean', title: '附加' },
  },
  additionalProperties: false,
};

describe('config value presentation', () => {
  it('shows actual object values and identifies properties available through full reading', () => {
    const value = { model: 'gpt-5.6-sol', reasoningEffort: 'high', extra: false };
    expect(presentConfigValue({ definition: profile, value })).toEqual({
      text: '模型=gpt-5.6-sol · 强度=high', state: 'value', complete: false,
      hiddenProperties: ['extra'],
    });
    expect(value).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high', extra: false });
  });

  it('shows own values from a normalized key-value definition and identifies hidden entries', () => {
    const definition = normalizePluginConfigDefinition({ fields: { settings: {
      type: 'object', additionalProperties: { type: 'string' },
    } } }).fields.settings!;
    expect(presentConfigValue({ definition, value: { model: 'alpha', zone: 'west', extra: 'yes' } })).toEqual({
      text: 'extra=yes · model=alpha', state: 'value', complete: false, hiddenProperties: ['zone'],
    });
    expect(presentConfigValue({ definition, value: { zone: 'west' } }).text).toBe('zone=west');
  });

  it('distinguishes empty strings, zero, false, unset and valid empty objects', () => {
    for (const [definition, value, text] of [
      [{ type: 'string' }, '', '（空字符串）'],
      [{ type: 'number' }, 0, '0'],
      [{ type: 'boolean' }, false, '关闭'],
      [{ type: 'object', properties: {}, additionalProperties: false }, {}, '（空对象）'],
    ] as const) {
      expect(presentConfigValue({ definition, value })).toEqual({
        text, state: 'value', complete: true,
      });
    }
    expect(presentConfigValue({ definition: { type: 'string' }, value: undefined })).toEqual({
      text: '未设置', state: 'unset', complete: true,
    });
  });

  it('uses the production validator and never borrows defaults for invalid values', () => {
    expect(presentConfigValue({ definition: profile, value: { model: 'x' } }).state).toBe('invalid');
    expect(presentConfigValue({ definition: { type: 'number', default: 1 }, value: '' })).toEqual({
      text: '需修正', state: 'invalid', complete: true,
    });
  });

  it('exposes only presence for sensitive values and old unsupported sensitive children', () => {
    const definition: PluginConfigSchemaField = { type: 'string', sensitive: true };
    expect(presentConfigValue({ definition, configured: true, value: 'PRIVATE_SECRET' })).toEqual({
      text: '已设置', state: 'sensitive', complete: true,
    });
    expect(presentConfigValue({ definition, configured: false })).toEqual({
      text: '未设置', state: 'sensitive', complete: true,
    });
    const legacy = {
      type: 'object', properties: { token: { type: 'string', sensitive: true } },
    } as unknown as PluginConfigSchemaField;
    expect(presentConfigValue({ definition: legacy, value: { token: 'PRIVATE_SECRET' } })).toEqual({
      text: '已设置', state: 'sensitive', complete: true,
    });
  });

  it('removes terminal control sequences without redacting ordinary configuration strings', () => {
    expect(safeConfigText('\x1b[31m模型\x1b[0m\x1b]52;c;hidden\x07\u202e\x00')).toBe('模型');
    const value = '/workspace/config.json?key=example';
    expect(presentConfigValue({ definition: { type: 'string' }, value }).text).toBe(value);
  });

  it('keeps the complete safe value reachable without exposing private values', () => {
    const value = { model: 'x'.repeat(300), reasoningEffort: 'high', extra: false };
    expect(presentConfigValue({ definition: profile, value, full: true })).toEqual({
      text: JSON.stringify(value), state: 'value', complete: true,
    });
    expect(presentConfigValue({ definition: { type: 'string', sensitive: true }, value: 'SECRET', full: true }).text).toBe('已设置');
    expect(presentConfigValue({ definition: { type: 'number' }, configured: false, invalid: true }).state).toBe('invalid');
  });

  it('bounds by Unicode code points and marks abbreviated values as incomplete', () => {
    const value = '😀'.repeat(300);
    const output = presentConfigValue({ definition: { type: 'string' }, value });
    expect([...output.text]).toHaveLength(256);
    expect(output.text.endsWith('…')).toBe(true);
    expect(output.complete).toBe(false);
  });
});

describe('Config v3 join presentation', () => {
  const config = normalizePluginConfigDefinition({ schemaVersion: 3, fields: { profile: {
    type: 'object', properties: {
      'model/name': { type: 'string', required: true },
      '~effort': { type: 'string', choices: { allowCustom: true, presets: [{ id: 'high', title: '\x1b[31m较高\x1b[0m', value: 'high' }] } },
      extra: { type: 'boolean' }, zero: { type: 'number' },
    },
  } }, presentation: { summaries: { compact: { kind: 'join', parts: [
    { path: '/model~1name' }, { path: '/~0effort', format: 'choiceTitle' },
  ], separator: '/', missing: '未设置' } }, fieldViews: { profile: { summary: 'compact' } } } });
  const definition = config.fields.profile!;
  const summary = config.presentation!.summaries!.compact!;
  it('joins own scalar properties with pointer decoding, choice titles and explicit missing values', () => {
    expect(presentConfigValue({ definition, summary, value: { 'model/name': 'local', '~effort': 'high' } }))
      .toEqual({ text: 'local/较高', state: 'value', complete: true });
    expect(presentConfigValue({ definition, summary, value: { 'model/name': '' } }).text).toBe('（空字符串）/未设置');
    expect(presentConfigValue({ definition, summary, value: { 'model/name': 'local', '~effort': 'custom' } }).text).toBe('local/custom');
    const inherited = Object.assign(Object.create({ '~effort': 'high' }), { 'model/name': 'local' });
    expect(presentConfigValue({ definition, summary, value: inherited }).text).toBe('local/未设置');
    expect(presentConfigValue({ definition, summary, value: { '~effort': 'high' } }).state).toBe('invalid');
    expect(presentConfigValue({ definition, summary, configured: false }).state).toBe('unset');
  });
  it('keeps hidden and abbreviated values available in full and strips terminal controls from all parts', () => {
    const value = { 'model/name': '😀'.repeat(270) + '\x1b]52;c;hidden\x07\u202eEND', '~effort': 'high', extra: false };
    const output = presentConfigValue({ definition, summary, value });
    expect([...output.text]).toHaveLength(256);
    expect(output).toMatchObject({ state: 'value', complete: false, hiddenProperties: ['extra'] });
    expect(presentConfigValue({ definition, summary, value, full: true }).text).toContain('END');
    expect(presentConfigValue({ definition, summary, value, full: true }).text).toContain('"extra":false');
    const controls = { ...summary, separator: '\x1b[31m/\x1b[0m', missing: '\x1b]52;c;hidden\x07缺失\u202e' };
    expect(presentConfigValue({ definition, summary: controls, value: { 'model/name': 'safe' } }).text).toBe('safe/缺失');
    expect(presentConfigValue({ definition: { type: 'string', sensitive: true }, summary, value: 'SECRET' }).text).toBe('已设置');
  });
  it('preserves false and zero in raw joins', () => {
    const scalarSummary = { ...summary, parts: [{ path: '/extra' }, { path: '/zero' }] };
    expect(presentConfigValue({ definition, summary: scalarSummary, value: { 'model/name': 'local', extra: false, zero: 0 } }))
      .toEqual({ text: '关闭/0', state: 'value', complete: false, hiddenProperties: ['model/name'] });
  });
});
