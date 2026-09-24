import { describe, expect, it } from 'vitest';
import type { PluginConfigArrayField, PluginConfigJoinSummary } from '@lesliechan721/aw-plugin-core';

import { presentConfigValue } from '../../src/tui/config-value-presentation.js';
import {
  arrayDraftChanged, arrayDraftValue, createConfigArrayDraft, editConfigArrayDraft,
} from '../../src/tui/config-array-draft.js';

describe('array configuration presentation', () => {
  it('keeps empty, unset, false, zero and empty-string lists distinct with complete JSON reading', () => {
    for (const [items, value, text] of [
      [{ type: 'string' }, [''], '[（空字符串）]'],
      [{ type: 'number' }, [0], '[0]'],
      [{ type: 'boolean' }, [false], '[关闭]'],
    ] as const) {
      const definition: PluginConfigArrayField = { type: 'array', items };
      expect(presentConfigValue({ definition, value })).toMatchObject({ text, complete: true });
      expect(presentConfigValue({ definition, value, full: true }).text).toBe(JSON.stringify(value));
      expect(presentConfigValue({ definition, value: [] }).text).toBe('空列表');
      expect(presentConfigValue({ definition }).state).toBe('unset');
    }
  });

  it('shows actual object summaries and makes omitted items and properties available in full', () => {
    const definition: PluginConfigArrayField = { type: 'array', items: {
      type: 'object', properties: { model: { type: 'string', required: true }, effort: { type: 'string' } },
    } };
    const itemSummary: PluginConfigJoinSummary = {
      kind: 'join', parts: [{ path: '/model' }], separator: '/', missing: '未设置',
    };
    const value = [{ model: 'fast', effort: 'high' }, { model: 'review' }, { model: 'last' }];
    expect(presentConfigValue({ definition, value, itemSummary })).toEqual({
      text: 'fast · review +1 项', state: 'value', complete: false,
    });
    expect(presentConfigValue({ definition, value, itemSummary, full: true }).text).toBe(JSON.stringify(value));
    expect(presentConfigValue({ definition, value: [{}], itemSummary }).state).toBe('invalid');
    expect(presentConfigValue({ definition, value: [value[0]], itemSummary }).complete).toBe(false);
    expect(presentConfigValue({ definition, value: [{ model: 'fast' }] }).text).toBe('model=fast');
  });
});

describe('array working copy', () => {
  it('keeps duplicate rows distinct through movement and clears changes when order is restored', () => {
    const original = createConfigArrayDraft([{ model: 'same' }, { model: 'same' }, { model: 'last' }]);
    const rowId = original.rows[1]!.rowId;
    const moved = editConfigArrayDraft(original, { kind: 'move', rowId, offset: 1 });
    expect(moved.selectedRowId).toBe(rowId);
    expect(arrayDraftValue(moved)).toEqual([{ model: 'same' }, { model: 'last' }, { model: 'same' }]);
    expect(arrayDraftChanged(moved)).toBe(true);
    const restored = editConfigArrayDraft(moved, { kind: 'move', rowId, offset: -1 });
    expect(arrayDraftChanged(restored)).toBe(false);
    expect(arrayDraftValue(original)).toEqual([{ model: 'same' }, { model: 'same' }, { model: 'last' }]);
    expect(arrayDraftValue(moved).every((item) => !Object.hasOwn(item, 'rowId'))).toBe(true);
  });

  it('isolates confirmed object edits and retains the prior working copy for cancellation', () => {
    const source = [{ label: 'first' }];
    const original = createConfigArrayDraft(source);
    const item = { label: 'second' };
    const added = editConfigArrayDraft(original, { kind: 'set', value: item });
    item.label = 'unconfirmed';
    source[0]!.label = 'external';
    expect(arrayDraftValue(added)).toEqual([{ label: 'first' }, { label: 'second' }]);
    const removed = editConfigArrayDraft(added, { kind: 'remove', rowId: added.rows[0]!.rowId });
    expect(removed.selectedRowId).toBe(added.rows[1]!.rowId);
    expect(arrayDraftValue(original)).toEqual([{ label: 'first' }]);
    expect(arrayDraftValue(added)).toEqual([{ label: 'first' }, { label: 'second' }]);
    expect(arrayDraftChanged(createConfigArrayDraft([]))).toBe(false);
    expect(arrayDraftChanged(createConfigArrayDraft(undefined))).toBe(true);
  });
});
