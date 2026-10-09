import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import {
  PLUGIN_CONFIG_ARRAY_MAX_ITEMS,
  validatePluginConfigValue,
  type PluginConfigLeafArrayField,
  type PluginConfigLeafObjectField,
  type PluginConfigScalar,
  type PluginConfigScalarArray,
  type PluginConfigScalarObject,
} from '@lesliechan721/aw-plugin-core';

import { ActionRow, ChoiceRow, InputCard } from './components.js';
import { arrayDraftValue, createConfigArrayDraft, editConfigArrayDraft } from './config-array-draft.js';
import { presentConfigValue, safeConfigText } from './config-value-presentation.js';
import { InputDisplay, removeLastGrapheme } from './input-display.js';

type LeafValue = PluginConfigScalarArray | PluginConfigScalarObject;
type EditScreen =
  | { kind: 'list' }
  | { kind: 'tools'; rowId: string }
  | { kind: 'key'; input: string }
  | { kind: 'value'; rowId?: string; key?: string; input: string; mode: 'choices' | 'custom' };

/** Keep a property working copy separate from its parent object until confirmation. */
export function ConfigLeafEditor(props: {
  definition: PluginConfigLeafArrayField | PluginConfigLeafObjectField;
  value: unknown;
  propertyKey: string;
  columns: number;
  rowBudget: number;
  active: boolean;
  error?: string;
  onConfirm: (value: LeafValue) => boolean;
  onCancel: () => void;
  onDraftChange: (revision: string | undefined) => void;
}): React.JSX.Element {
  const [array, setArray] = useState(() => createConfigArrayDraft(Array.isArray(props.value) ? props.value : undefined));
  const [object, setObject] = useState<PluginConfigScalarObject>(() =>
    props.value && typeof props.value === 'object' && !Array.isArray(props.value)
      ? structuredClone(props.value) as PluginConfigScalarObject : {});
  const [screen, setScreen] = useState<EditScreen>({ kind: 'list' });
  const [focus, setFocus] = useState(0);
  const [error, setError] = useState<string>();
  const selectedRowId = useRef<string | undefined>(undefined);
  const isArray = props.definition.type === 'array';
  const scalar = props.definition.type === 'array' ? props.definition.items : props.definition.additionalProperties;
  const value = isArray ? arrayDraftValue(array) as PluginConfigScalarArray : object;
  const rows = isArray
    ? array.rows.map((row, index) => ({ id: row.rowId, title: String(index + 1).padStart(2, '0'), value: row.value as PluginConfigScalar }))
    : Object.keys(object).sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => ({ id: key, title: key, value: object[key]! }));
  const issues = validatePluginConfigValue(props.definition, value);
  if (screen.kind === 'list' && rows[focus]) selectedRowId.current = rows[focus]!.id;
  const issueText = (entries: typeof issues): string => entries.slice(0, 2).map((issue) => issue.message).join('；');
  const revision = JSON.stringify(value) !== JSON.stringify(props.value ?? (isArray ? [] : {}))
    || screen.kind === 'key' && screen.input.length > 0
    || screen.kind === 'value' && (screen.key !== undefined
      || screen.input !== String(screen.rowId === undefined ? '' : rows.find((row) => row.id === screen.rowId)?.value ?? ''))
    ? JSON.stringify([value, screen]) : undefined;
  useEffect(() => { props.onDraftChange(revision); }, [revision, props.onDraftChange]);
  useEffect(() => () => props.onDraftChange(undefined), [props.onDraftChange]);

  const openValue = (rowId?: string, key?: string): void => {
    setError(undefined);
    setFocus(0);
    setScreen({ kind: 'value', rowId, key,
      input: rowId === undefined ? '' : String(rows.find((row) => row.id === rowId)?.value ?? ''),
      mode: scalar.type === 'boolean' || scalar.choices || scalar.const !== undefined ? 'choices' : 'custom' });
  };
  const saveScalar = (candidate: PluginConfigScalar): void => {
    const invalid = validatePluginConfigValue(scalar, candidate);
    if (invalid.length) { setError(issueText(invalid)); return; }
    if (screen.kind !== 'value') return;
    if (props.definition.type === 'array') {
      const next = editConfigArrayDraft(array, { kind: 'set', rowId: screen.rowId, value: candidate });
      setArray(next);
      setFocus(Math.max(0, next.rows.findIndex((row) => row.rowId === next.selectedRowId)));
    } else {
      const key = screen.key ?? screen.rowId!;
      setObject({ ...object, [key]: candidate });
      setFocus(Math.max(0, [...new Set([...Object.keys(object), key])].sort((a, b) => a.localeCompare(b, 'en')).indexOf(key)));
    }
    setError(undefined);
    setScreen({ kind: 'list' });
  };
  const confirm = (): void => {
    if (issues.length) { setError(issueText(issues)); return; }
    props.onConfirm(value);
  };
  const add = (): void => {
    if (props.definition.type === 'array') {
      if (rows.length >= (props.definition.validation?.maxItems ?? PLUGIN_CONFIG_ARRAY_MAX_ITEMS)) {
        setError('已达到列表最大项数。'); return;
      }
      openValue();
    } else { setScreen({ kind: 'key', input: '' }); setError(undefined); }
  };
  const choices: Array<{ title: string; value?: PluginConfigScalar; custom?: boolean }> = scalar.const !== undefined
    ? [{ title: `固定值 · ${presentConfigValue({ definition: scalar, value: scalar.const }).text}`, value: scalar.const }]
    : [
        ...(scalar.choices?.presets ?? []).map((preset) => ({ title: preset.title, value: preset.value })),
        ...(scalar.type === 'boolean' && (!scalar.choices || scalar.choices.allowCustom)
          ? [true, false].filter((item) => !scalar.choices?.presets.some((preset) => preset.value === item))
            .map((item) => ({ title: item ? '开启' : '关闭', value: item })) : []),
        ...(scalar.type !== 'boolean' && scalar.choices?.allowCustom ? [{ title: '自定义', custom: true }] : []),
      ];
  useInput((input, key) => {
    if (key.escape) {
      if (screen.kind === 'list') props.onCancel();
      else { setScreen({ kind: 'list' }); setFocus(0); setError(undefined); }
      return;
    }
    if (screen.kind === 'key' || screen.kind === 'value' && screen.mode === 'custom') {
      if (key.return) {
        if (screen.kind === 'key') {
          if (Object.hasOwn(object, screen.input)) { setError('这个键已存在。'); return; }
          const candidate = Object.fromEntries([...Object.keys(object), screen.input].map((name) => [name, '']));
          const invalid = validatePluginConfigValue({ type: 'object', additionalProperties: { type: 'string' },
            validation: props.definition.type === 'object' ? props.definition.validation : undefined }, candidate)
            .filter((issue) => issue.code === 'maxProperties' || issue.path.property === screen.input);
          if (invalid.length) { setError(issueText(invalid)); return; }
          openValue(undefined, screen.input);
        } else if (scalar.type === 'number') {
          const parsed = screen.input.trim() === '' ? NaN : Number(screen.input);
          if (!Number.isFinite(parsed)) { setError('请输入数字；空输入不会保存为 0。'); return; }
          saveScalar(parsed);
        } else saveScalar(screen.input);
        return;
      }
      const next = input === '\u0015' || key.ctrl && input.toLowerCase() === 'u' ? ''
        : key.backspace || key.delete ? removeLastGrapheme(screen.input)
          : input && !key.ctrl && !key.meta && input >= ' ' ? screen.input + input : screen.input;
      setScreen({ ...screen, input: next }); setError(undefined);
      return;
    }
    const count = screen.kind === 'tools' ? isArray ? 3 : 1
      : screen.kind === 'value' ? choices.length : rows.length + 3;
    if (key.upArrow || key.downArrow) {
      setFocus((index) => (index + (key.upArrow ? -1 : 1) + count) % count); return;
    }
    if (screen.kind === 'list' && input === 'a') { setFocus(rows.length); return; }
    if (screen.kind === 'list' && input === 'c') { confirm(); return; }
    if (!key.return) return;
    if (screen.kind === 'value') {
      const choice = choices[focus];
      if (choice?.custom) setScreen({ ...screen, mode: 'custom' });
      else if (choice?.value !== undefined) saveScalar(choice.value);
    } else if (screen.kind === 'tools') {
      if (isArray) {
        const next = editConfigArrayDraft(array, focus === 2 ? { kind: 'remove', rowId: screen.rowId }
          : { kind: 'move', rowId: screen.rowId, offset: focus === 0 ? -1 : 1 });
        setArray(next);
        setFocus(Math.max(0, next.rows.findIndex((row) => row.rowId === next.selectedRowId)));
      } else {
        const next = { ...object }; delete next[screen.rowId]; setObject(next); setFocus(0);
      }
      setScreen({ kind: 'list' }); setError(undefined);
    } else if (focus < rows.length) openValue(rows[focus]!.id);
    else if (focus === rows.length) add();
    else if (focus === rows.length + 1) {
      if (rows.length) { setScreen({ kind: 'tools', rowId: selectedRowId.current ?? rows[0]!.id }); setFocus(0); }
    } else confirm();
  }, { isActive: props.active });

  const hint = isArray && props.propertyKey === 'args'
    ? '每项是实际后端 argv 值；空参数有效。不做 shell 拆分或展开。'
    : props.propertyKey === 'envFrom' ? '值是宿主环境变量名；这里只保存引用名。'
      : props.propertyKey === 'env' ? '普通字面配置；请勿保存密钥。' : props.definition.description;
  if (screen.kind === 'key' || screen.kind === 'value' && screen.mode === 'custom') return <Box flexDirection="column">
    <Text>{screen.kind === 'key' ? '输入新键名' : isArray ? '编辑列表项' : `编辑 ${safeConfigText(screen.key ?? screen.rowId ?? '')}`}</Text>
    <InputCard focused title={<InputDisplay value={screen.input} columns={Math.max(8, props.columns - 8)} />}
      description={error ?? 'Enter 使用输入 · Ctrl-U 清空 · Esc 取消这一项'} status={error ? 'error' : undefined} />
    {hint ? <Text wrap="wrap">{hint}</Text> : null}
  </Box>;
  if (screen.kind === 'value') return <Box flexDirection="column">
    {choices.map((choice, index) => <ChoiceRow key={index} title={safeConfigText(choice.title)} focused={focus === index}
      selected={choice.value !== undefined && String(choice.value) === screen.input} compact />)}
    {error ? <Text>{error}</Text> : null}
  </Box>;
  if (screen.kind === 'tools') return <Box flexDirection="column">
    <Text>{isArray ? '调整当前项' : `删除 ${safeConfigText(screen.rowId)}`}</Text>
    {(isArray ? ['上移', '下移', '删除这一项'] : ['删除键值']).map((title, index) =>
      <ActionRow key={title} title={title} focused={focus === index} compact />)}
  </Box>;
  const limit = Math.max(1, props.rowBudget - 5);
  const offset = Math.max(0, Math.min(focus, Math.max(0, rows.length - limit)));
  return <Box flexDirection="column">
    {hint ? <Text wrap="truncate-end">{hint}</Text> : null}
    {error || props.error || issues.length ? <Text wrap="truncate-end">{error ?? props.error ?? issueText(issues)}</Text> : null}
    {rows.length === 0 ? <Text>{isArray ? '空列表' : '空键值对象'}</Text> : null}
    {rows.slice(offset, offset + limit).map((row, index) => <ActionRow key={row.id}
      title={`${safeConfigText(row.title)}  ${presentConfigValue({ definition: scalar, value: row.value }).text}`}
      focused={focus === offset + index} compact />)}
    {rows.length > limit ? <Text>{offset + 1}–{Math.min(rows.length, offset + limit)} / {rows.length} 项</Text> : null}
    {['添加一项', isArray ? '调整当前项' : '删除当前键', isArray ? '使用此列表 [c]' : '使用此键值对象 [c]'].map((title, index) =>
      <ActionRow key={title} title={title} focused={focus === rows.length + index} compact />)}
  </Box>;
}
