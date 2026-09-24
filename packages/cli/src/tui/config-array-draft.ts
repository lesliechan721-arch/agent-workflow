import {
  stablePluginConfigStringify,
  type PluginConfigArray,
  type PluginConfigObject,
  type PluginConfigScalar,
} from '@lesliechan721/aw-plugin-core';

export interface ConfigArrayRow {
  rowId: string;
  value: PluginConfigScalar | PluginConfigObject;
}

/** Session state only. Persist arrayDraftValue after whole-field validation. */
export interface ConfigArrayDraft {
  initial: PluginConfigArray | undefined;
  rows: ConfigArrayRow[];
  nextRowId: number;
  selectedRowId?: string;
}

export function createConfigArrayDraft(value: PluginConfigArray | undefined): ConfigArrayDraft {
  const initial = structuredClone(value);
  const rows = (value ?? []).map((item, index) => ({
    rowId: String(index), value: structuredClone(item),
  }));
  return { initial, rows, nextRowId: rows.length, selectedRowId: rows[0]?.rowId };
}

export function arrayDraftValue(draft: ConfigArrayDraft): PluginConfigArray {
  // Items share the field schema; the caller validates the whole value before staging.
  return structuredClone(draft.rows.map((row) => row.value)) as PluginConfigArray;
}

export function arrayDraftChanged(draft: ConfigArrayDraft): boolean {
  return draft.initial === undefined
    || stablePluginConfigStringify(draft.initial) !== stablePluginConfigStringify(arrayDraftValue(draft));
}

export type ConfigArrayEdit =
  | { kind: 'set'; rowId?: string; value: PluginConfigScalar | PluginConfigObject }
  | { kind: 'move'; rowId: string; offset: -1 | 1 }
  | { kind: 'remove'; rowId: string };

/** Apply confirmed item edits without mutating the previous working copy. */
export function editConfigArrayDraft(draft: ConfigArrayDraft, edit: ConfigArrayEdit): ConfigArrayDraft {
  if (edit.kind === 'set' && edit.rowId === undefined) {
    const rowId = String(draft.nextRowId);
    return {
      ...draft,
      rows: [...draft.rows, { rowId, value: structuredClone(edit.value) }],
      nextRowId: draft.nextRowId + 1,
      selectedRowId: rowId,
    };
  }
  const index = draft.rows.findIndex((row) => row.rowId === edit.rowId);
  if (index < 0) return draft;
  const rows = [...draft.rows];
  if (edit.kind === 'set') rows[index] = { rowId: edit.rowId!, value: structuredClone(edit.value) };
  if (edit.kind === 'move') {
    const target = index + edit.offset;
    if (target < 0 || target >= rows.length) return draft;
    [rows[index], rows[target]] = [rows[target]!, rows[index]!];
  }
  if (edit.kind === 'remove') rows.splice(index, 1);
  return {
    ...draft,
    rows,
    selectedRowId: edit.kind === 'remove' ? rows[Math.min(index, rows.length - 1)]?.rowId : edit.rowId,
  };
}
