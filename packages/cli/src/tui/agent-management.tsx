import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { PLATFORM_TARGETS, type PlatformTarget } from '@lesliechan721/aw-plugin-core';
import type { TuiController } from './controller.js';
import type { AgentSettings, AgentSettingsPreview } from './agent-settings.js';
import { wrapDisplayText } from './viewport.js';
import { agentLabel, scopeLabel } from './glossary.js';
import { tuiTheme } from './theme.js';
import { TechnicalDetails } from './components.js';

export function AgentManagement(props: {
  controller: TuiController; settings: AgentSettings; pluginId?: string;
  summaries?: Partial<Record<PlatformTarget, { symbol: string; label: string; count: number }>>;
  columns: number; rows: number; active?: boolean; onBack(): void; onExit(): void;
  onHome?(): void; onReload?(): void; onHelp?(): void;
  onSaved(settings: AgentSettings): void; onSync(): void;
}): React.JSX.Element {
  const [settings, setSettings] = useState(props.settings);
  const [draft, setDraft] = useState(props.settings.preferences);
  const [focus, setFocus] = useState(0);
  const [preview, setPreview] = useState<AgentSettingsPreview>();
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState<'saved' | 'discard'>();
  const [dialogFocus, setDialogFocus] = useState(0);
  const [details, setDetails] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [detailOffset, setDetailOffset] = useState(0);
  const request = useRef(0);
  const pendingNavigation = useRef<() => void>(props.onBack);
  const plugin = settings.plugins.find((entry) => entry.pluginId === props.pluginId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.preferences);
  const usable = props.columns >= 60 && props.rows >= 18;
  const contentRows = Math.max(1, props.rows - 10);
  const listRows = Math.min(PLATFORM_TARGETS.length, contentRows);
  const start = Math.max(0, Math.min(PLATFORM_TARGETS.length - listRows,
    Math.min(focus, PLATFORM_TARGETS.length - 1) - listRows + 1));
  const detailAvailable = Boolean(preview?.reasons.length || preview?.conflicts.length);
  const actionCount = PLATFORM_TARGETS.length + 1 + Number(detailAvailable);
  const detailLines = (technical ? preview?.conflicts.flatMap((conflict) => conflict.technical ?? []) ?? [] : [
    ...(preview?.reasons.flatMap((reason) => reason.path ? [
      `${reason.scope ? scopeLabel(reason.scope) : ''} · ${reason.target ? agentLabel(reason.target) : ''}`,
      ...reason.path.map((id, index) => `${'  '.repeat(index)}${index ? '└─ ' : ''}${id.split('/').at(-1)}`),
    ] : [reason.message]) ?? []),
    ...(preview?.conflicts.flatMap((conflict) => [conflict.message,
      ...(conflict.plugins?.length ? [`影响插件：${conflict.plugins.map((id) => id.split('/').at(-1)).join(' · ')}`] : []),
      '处理方式：关闭其中一个冲突 Agent，或在插件设置中排除冲突项后重新检查。']) ?? []),
  ]).flatMap((line) => wrapDisplayText(line, Math.max(1, props.columns - 6)));
  const detailVisibleRows = Math.max(1, contentRows - (technical ? 3 : 2));
  const detailMaxOffset = Math.max(0, detailLines.length - detailVisibleRows);
  const visibleDetailOffset = Math.min(detailOffset, detailMaxOffset);
  useEffect(() => { setFocus((value) => Math.min(value, actionCount - 1)); }, [actionCount]);

  useEffect(() => {
    const current = ++request.current;
    setChecking(true);
    void props.controller.previewAgentSettings(draft, props.pluginId).then((result) => {
      if (request.current !== current) return;
      setPreview(result); setChecking(false); setError(undefined);
    }).catch(() => {
      if (request.current !== current) return;
      setChecking(false); setError('无法检查当前插件需求，请重试。');
    });
    return () => { request.current += 1; };
  }, [draft, props.controller, props.pluginId]);

  const enabled = (target: PlatformTarget): boolean => props.pluginId
    ? settings.preferences.targets.includes(target)
      && !draft.exclusions.some((entry) => entry.plugin === props.pluginId && entry.target === target)
    : draft.targets.includes(target);
  const unavailable = (target: PlatformTarget): string | undefined => !props.pluginId ? undefined
    : !plugin?.supportedTargets.includes(target) ? '不支持'
      : !settings.preferences.targets.includes(target) ? '本机未启用' : undefined;
  const toggle = (target: PlatformTarget): void => {
    if (unavailable(target)) return;
    if (props.pluginId) setDraft({ ...draft, exclusions: enabled(target)
      ? [...draft.exclusions, { plugin: props.pluginId, target }]
      : draft.exclusions.filter((entry) => entry.plugin !== props.pluginId || entry.target !== target) });
    else setDraft({ ...draft, targets: enabled(target) ? draft.targets.filter((entry) => entry !== target)
      : PLATFORM_TARGETS.filter((entry) => draft.targets.includes(entry) || entry === target) });
  };
  const save = (): void => {
    if (checking || saving || preview?.blocked || !preview || !usable) return;
    setSaving(true);
    void props.controller.saveAgentSettings({ expectedRevision: settings.revision,
      preferences: draft, ...(props.pluginId ? { pluginId: props.pluginId } : {}) }).then((saved) => {
      setSettings(saved); setDraft(saved.preferences); setSaving(false);
      props.onSaved(saved); setDialogFocus(0); setDialog('saved');
    }).catch((failure: unknown) => {
      setSaving(false);
      setError(failure instanceof Error && failure.message.startsWith('operationReviewStale')
        ? '设置已变化，请返回后重新打开。' : '保存未完成，请检查插件需求后重试。');
    });
  };
  const leave = (action: () => void): void => {
    if (dirty) {
      pendingNavigation.current = action;
      setDialogFocus(0); setDialog('discard');
    } else action();
  };
  useInput((input, key) => {
    if (props.active === false || !usable || saving) return;
    if (dialog) {
      if (key.escape) { setDialog(undefined); return; }
      if (key.upArrow || key.downArrow) { setDialogFocus((value) => 1 - value); return; }
      if (key.return) {
        const selected = dialog; setDialog(undefined);
        if (selected === 'saved' && dialogFocus === 0) props.onSync();
        if (selected === 'discard' && dialogFocus === 1) pendingNavigation.current();
      }
      return;
    }
    if (input === 'q' || key.ctrl && input.toLowerCase() === 'c') { leave(props.onExit); return; }
    if (input === 'h' && props.onHome) { leave(props.onHome); return; }
    if (input === 'H' && props.onReload) { leave(props.onReload); return; }
    if (input === '?') { props.onHelp?.(); return; }
    if (details) {
      if (key.escape || input === 'b') { if (technical) setTechnical(false); else setDetails(false); setDetailOffset(0); return; }
      if (input === 'd' && preview?.conflicts.length) { setTechnical((value) => !value); setDetailOffset(0); return; }
      if (key.upArrow || key.pageUp) setDetailOffset(Math.max(0, visibleDetailOffset - (key.pageUp ? detailVisibleRows : 1)));
      if (key.downArrow || key.pageDown) setDetailOffset(Math.min(detailMaxOffset,
        visibleDetailOffset + (key.pageDown ? detailVisibleRows : 1)));
      return;
    }
    if (key.escape || input === 'b') {
      leave(props.onBack);
      return;
    }
    if (key.upArrow || key.downArrow) {
      setFocus((value) => Math.max(0, Math.min(actionCount - 1, value + (key.upArrow ? -1 : 1)))); return;
    }
    if (input === 's') { save(); return; }
    if (key.return || input === ' ') {
      if (focus < PLATFORM_TARGETS.length) toggle(PLATFORM_TARGETS[focus]!);
      else if (focus === PLATFORM_TARGETS.length) save();
      else { setDetails(true); setTechnical(false); setDetailOffset(0); }
    }
  });
  if (dialog) {
    const saved = dialog === 'saved';
    const choices = saved ? ['同步', '暂不同步'] : ['继续编辑', '放弃修改'];
    return <Box width={props.columns - 2} height={Math.max(5, props.rows - 7)} justifyContent="center" flexDirection="column">
      <Box borderStyle="round" borderColor={tuiTheme.roles.focus} paddingX={2} flexDirection="column">
        <Text bold color={tuiTheme.roles.focus}>{saved ? '已保存，是否同步？' : '还有未保存的修改'}</Text>
        <Text>{saved ? '同步插件，使 Agent 选择生效。' : '返回会丢弃当前修改。'}</Text>
        {choices.map((choice, index) => <Text key={choice}
          color={index === dialogFocus ? tuiTheme.roles.focus : undefined}>
          {index === dialogFocus ? '› ' : '  '}{choice}
        </Text>)}
      </Box>
    </Box>;
  }
  if (details && technical) return <Box width={props.columns - 2} flexDirection="column"><TechnicalDetails title="冲突目录依据">
    {detailLines.slice(visibleDetailOffset, visibleDetailOffset + detailVisibleRows)
      .map((message, index) => <Text key={index}>{message}</Text>)}
    <Text color={tuiTheme.roles.secondary}>↑↓ 阅读 · d 返回说明 · Esc 返回</Text>
  </TechnicalDetails></Box>;
  if (details) return <Box width={props.columns - 2} flexDirection="column">
    <Text bold>{preview?.blocked ? '为什么不能关闭？' : 'Agent 目录冲突'}</Text>
    {detailLines.slice(visibleDetailOffset, visibleDetailOffset + detailVisibleRows)
      .map((message, index) => <Text key={index}>{message}</Text>)}
    <Text color={tuiTheme.roles.secondary}>↑↓ 阅读{preview?.conflicts.length ? ' · d 技术详情' : ''} · Esc 返回</Text>
  </Box>;
  return <Box width={props.columns - 2} flexDirection="column" height={Math.max(5, props.rows - 7)}>
    <Box flexDirection="column" flexGrow={1}>
      {PLATFORM_TARGETS.slice(start, start + listRows).map((target, index) => {
        const unavailableReason = unavailable(target);
        const on = enabled(target);
        const before = props.pluginId ? !settings.preferences.exclusions.some((entry) =>
          entry.plugin === props.pluginId && entry.target === target) : settings.preferences.targets.includes(target);
        const blocked = preview?.reasons.find((reason) => reason.target === target);
        const conflict = preview?.conflicts.some((entry) => entry.targets.includes(target));
        const hint = unavailableReason ?? (blocked ? `× ${blocked.root?.split('/').at(-1) ?? '其他插件'} 需要` : on !== before
          ? on ? `+ 将安装${props.pluginId ? '' : ` ${preview?.counts[target] ?? 0} 个插件`}`
            : `− 将移除${props.pluginId ? '' : ` ${props.summaries?.[target]?.count ?? 0} 个插件`}` : conflict ? '! 有冲突'
            : on ? props.pluginId ? `${props.summaries?.[target]?.symbol ?? '?'} ${props.summaries?.[target]?.label ?? '未确认'}`
              : `${props.summaries?.[target]?.symbol ?? '?'} ${preview?.counts[target] ?? 0} 个插件` : '');
        return <Box key={target} justifyContent="space-between">
          <Text color={unavailableReason ? tuiTheme.roles.secondary : focus === index + start
            ? tuiTheme.roles.focus : undefined} bold={focus === index + start}>
            {focus === index + start ? '› ' : '  '}{unavailableReason ? '–' : on ? '◆' : '◇'} {agentLabel(target)}
          </Text>
          <Text color={blocked ? tuiTheme.roles.error : conflict ? tuiTheme.roles.warning : tuiTheme.roles.secondary}>{hint}</Text>
        </Box>;
      })}
      <Text color={error || preview?.blocked ? tuiTheme.roles.error : tuiTheme.roles.secondary} wrap="wrap">
        {error ?? (checking ? '正在检查…' : preview?.blocked ? '其他插件仍需要此 Agent，不能保存。'
          : preview?.conflicts.length ? '! 存在目录冲突，可保存；同步时跳过冲突项。'
            : `◆ 已选 ${PLATFORM_TARGETS.filter(enabled).length} 个`)}
      </Text>
    </Box>
    <Text color={preview?.blocked || checking || error ? tuiTheme.roles.secondary : tuiTheme.roles.focus}>
      {focus === PLATFORM_TARGETS.length ? '› ' : '  '}{saving ? '正在保存…' : '保存'}  [s]
    </Text>
    {detailAvailable ? <Text color={focus === PLATFORM_TARGETS.length + 1 ? tuiTheme.roles.focus : undefined}>
      {focus === PLATFORM_TARGETS.length + 1 ? '› ' : '  '}{preview?.blocked ? '为什么不能关闭？' : '查看冲突说明'}
    </Text> : null}
  </Box>;
}
