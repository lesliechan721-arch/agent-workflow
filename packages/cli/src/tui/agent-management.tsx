import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { PLATFORM_TARGETS, type PlatformTarget } from '@lesliechan721/aw-plugin-core';
import type { TuiController } from './controller.js';
import type { AgentSettings, AgentSettingsPreview } from './agent-settings.js';
import { wrapDisplayText } from './viewport.js';
import { agentLabel, scopeLabel } from './glossary.js';
import { tuiTheme } from './theme.js';
import { TechnicalDetails } from './components.js';
import { requiresTargetConfirmation, TargetSelectionConfirmationRequiredError,
  type TargetAvailabilityView } from '../platforms/discovery.js';

const availabilityLabels: Record<string, string> = { available: '可用', missing: '未安装',
  unsupported: '不支持', unknown: '无法确认', notApplicable: '通用输出，无需客户端' };
const availabilityLabel = (value: string): string => availabilityLabels[value] ?? '无法确认';
const reasonLabel = (target?: TargetAvailabilityView): string => {
  const code = target?.installations.flatMap((product) => product.reasonCodes)[0] ?? target?.diagnostics[0]?.code;
  const labels: Record<string, string> = { clientVersionUnsupported: '版本过低', clientVersionUnknown: '版本未取得',
    clientIdentityUnconfirmed: '身份未确认', clientProbeFailed: '检查失败', clientInstallEntryUnavailable: '自动安装入口不可用',
    clientInstallInterfaceUnsupported: '安装接口不支持', appDiscoveryUnverified: '桌面端未确认', clientDiscoveryIncomplete: '发现未完成' };
  return code ? labels[code] ?? '检查未完成' : '未发现可信客户端';
};
const sortedTargets = (availability: readonly TargetAvailabilityView[]): PlatformTarget[] => {
  const rank = (id: PlatformTarget): number => availability.find((item) => item.id === id)?.availability === 'available'
    ? 0 : id === 'generic' ? 1 : 2;
  return [...PLATFORM_TARGETS].sort((left, right) => rank(left) - rank(right));
};

export function AgentManagement(props: {
  controller: TuiController; settings: AgentSettings; pluginId?: string;
  summaries?: Partial<Record<PlatformTarget, { symbol: string; label: string; count: number }>>;
  columns: number; rows: number; active?: boolean; onBack(): void; onExit(): void;
  onHome?(): void; onReload?(): void; onHelp?(): void;
  onSaved(settings: AgentSettings): void; onSync(): void;
}): React.JSX.Element {
  const [settings, setSettings] = useState(props.settings);
  const [draft, setDraft] = useState(() => !props.pluginId && props.settings.preferences.targets.length === 0
    ? { ...props.settings.preferences, targets: props.settings.availability.filter((target) => target.availability === 'available').map((target) => target.id) }
    : props.settings.preferences);
  const [availability, setAvailability] = useState(props.settings.availability);
  const [targets, setTargets] = useState(() => sortedTargets(props.settings.availability));
  const [confirmed, setConfirmed] = useState<PlatformTarget[]>([]);
  const [pendingSelection, setPendingSelection] = useState<{ items: TargetAvailabilityView[]; save: boolean }>();
  const [refreshing, setRefreshing] = useState(false);
  const [focus, setFocus] = useState(0);
  const focusedTarget = useRef<PlatformTarget | undefined>(undefined);
  focusedTarget.current = targets[focus];
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
  const detailAvailable = Boolean(!props.pluginId || preview?.reasons.length || preview?.conflicts.length);
  const actionCount = PLATFORM_TARGETS.length + 1 + Number(detailAvailable);
  const detailLines = (technical ? preview?.conflicts.flatMap((conflict) => conflict.technical ?? []) ?? [] : [
    ...(preview?.reasons.flatMap((reason) => reason.path ? [
      `${reason.scope ? scopeLabel(reason.scope) : ''} · ${reason.target ? agentLabel(reason.target) : ''}`,
      ...reason.path.map((id, index) => `${'  '.repeat(index)}${index ? '└─ ' : ''}${id.split('/').at(-1)}`),
    ] : [reason.message]) ?? []),
    ...(preview?.conflicts.flatMap((conflict) => [conflict.message,
      ...(conflict.plugins?.length ? [`影响插件：${conflict.plugins.map((id) => id.split('/').at(-1)).join(' · ')}`] : []),
      '处理方式：关闭其中一个冲突 Agent，或在插件设置中排除冲突项后重新检查。']) ?? []),
    ...(!props.pluginId ? availability.flatMap((target) => [
      `${target.displayName}：${availabilityLabel(target.availability)}`,
      ...target.installations.map((product) => `  ${product.product} · ${product.version ?? '版本未取得'} · ${availabilityLabel(product.availability)}${product.reasonCodes.length ? ` · ${product.reasonCodes.join(', ')}` : ''}`),
      ...target.recovery,
    ]) : []),
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
    if (!props.pluginId && !enabled(target)) {
      const observed = availability.find((item) => item.id === target);
      if (observed && requiresTargetConfirmation(observed.availability)) {
        setPendingSelection({ items: [observed], save: false }); setDialogFocus(0); return;
      }
    }
    if (enabled(target)) setConfirmed((current) => current.filter((id) => id !== target));
    if (props.pluginId) setDraft({ ...draft, exclusions: enabled(target)
      ? [...draft.exclusions, { plugin: props.pluginId, target }]
      : draft.exclusions.filter((entry) => entry.plugin !== props.pluginId || entry.target !== target) });
    else setDraft({ ...draft, targets: enabled(target) ? draft.targets.filter((entry) => entry !== target)
      : PLATFORM_TARGETS.filter((entry) => draft.targets.includes(entry) || entry === target) });
  };
  const updateAvailability = (next: TargetAvailabilityView[]): void => {
    const focused = focusedTarget.current;
    const ordered = sortedTargets(next);
    setAvailability(next); setTargets(ordered);
    if (focused) setFocus(ordered.indexOf(focused));
  };
  const refresh = (): void => {
    if (refreshing) return;
    setRefreshing(true);
    void props.controller.readAgentSettings().then((next) => {
      updateAvailability(next.availability); setRefreshing(false); setError(undefined);
    }).catch(() => { setRefreshing(false); setError('无法重新检查客户端，请重试。'); });
  };
  const save = (confirmedTargets = confirmed): void => {
    if (checking || saving || preview?.blocked || !preview || !usable) return;
    setSaving(true);
    void props.controller.saveAgentSettings({ expectedRevision: settings.revision,
      preferences: draft, confirmedUnavailableTargets: confirmedTargets,
      ...(props.pluginId ? { pluginId: props.pluginId } : {}) }).then((saved) => {
      setSettings(saved); setDraft(saved.preferences); setSaving(false);
      updateAvailability(saved.availability);
      props.onSaved(saved); setDialogFocus(0); setDialog('saved');
    }).catch((failure: unknown) => {
      setSaving(false);
      if (failure instanceof TargetSelectionConfirmationRequiredError) {
        updateAvailability(availability.map((item) => failure.availability.find((target) => target.id === item.id) ?? item));
        setPendingSelection({ items: failure.availability, save: true }); setDialogFocus(0); return;
      }
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
    if (pendingSelection) {
      if (key.escape) { setPendingSelection(undefined); return; }
      if (key.upArrow || key.downArrow) { setDialogFocus((value) => 1 - value); return; }
      if (key.return) {
        const pending = pendingSelection; setPendingSelection(undefined);
        if (dialogFocus === 1) {
          const selected = pending.items[0]!;
          const accepted = [...new Set([...confirmed, selected.id])];
          setConfirmed(accepted);
          if (pending.items.length > 1) {
            setPendingSelection({ ...pending, items: pending.items.slice(1) }); setDialogFocus(0);
          } else if (pending.save) save(accepted);
          else setDraft({ ...draft, targets: PLATFORM_TARGETS.filter((id) => draft.targets.includes(id) || selected.id === id) });
        }
      }
      return;
    }
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
    if (input === 'r' && !props.pluginId) { refresh(); return; }
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
      if (focus < PLATFORM_TARGETS.length) toggle(targets[focus]!);
      else if (focus === PLATFORM_TARGETS.length) save();
      else { setDetails(true); setTechnical(false); setDetailOffset(0); }
    }
  });
  if (pendingSelection) return <Box width={props.columns - 2} height={Math.max(5, props.rows - 7)} justifyContent="center" flexDirection="column">
    <Box borderStyle="round" borderColor={tuiTheme.roles.warning} paddingX={1} flexDirection="column">
      <Text bold>仍选择不可用的 Agent？</Text>
      <Text>{pendingSelection.items[0]!.displayName}：{availabilityLabel(pendingSelection.items[0]!.availability)} · {reasonLabel(pendingSelection.items[0])}</Text>
      {pendingSelection.items.length > 1 ? <Text>还有 {pendingSelection.items.length - 1} 个 Agent 需要逐项确认。</Text> : null}
      <Text>只保存选择。安装前仍须修复客户端和满足安装条件。</Text>
      <Text>安装或修复客户端后，按 r 重新检查。</Text>
      {['取消', '仍选择'].map((label, index) => <Text key={label} color={dialogFocus === index ? tuiTheme.roles.focus : undefined}>{dialogFocus === index ? '› ' : '  '}{label}</Text>)}
    </Box>
  </Box>;
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
      {targets.slice(start, start + listRows).map((target, index) => {
        const unavailableReason = unavailable(target);
        const on = enabled(target);
        const before = props.pluginId ? !settings.preferences.exclusions.some((entry) =>
          entry.plugin === props.pluginId && entry.target === target) : settings.preferences.targets.includes(target);
        const blocked = preview?.reasons.find((reason) => reason.target === target);
        const conflict = preview?.conflicts.some((entry) => entry.targets.includes(target));
        const observed = availability.find((item) => item.id === target);
        const availabilityHint = !props.pluginId ? `${availabilityLabel(observed?.availability ?? 'unknown')}${observed?.availability !== 'available' && observed?.availability !== 'notApplicable' ? ` · ${reasonLabel(observed)}` : ''}` : undefined;
        const hint = unavailableReason ?? availabilityHint ?? (blocked ? `× ${blocked.root?.split('/').at(-1) ?? '其他插件'} 需要` : on !== before
          ? on ? `+ 将安装${props.pluginId ? '' : ` ${preview?.counts[target] ?? 0} 个插件`}`
            : `− 将移除${props.pluginId ? '' : ` ${props.summaries?.[target]?.count ?? 0} 个插件`}` : conflict ? '! 有冲突'
            : on ? props.pluginId ? `${props.summaries?.[target]?.symbol ?? '?'} ${props.summaries?.[target]?.label ?? '未确认'}`
              : `${props.summaries?.[target]?.symbol ?? '?'} ${preview?.counts[target] ?? 0} 个插件` : '');
        return <Box key={target} justifyContent="space-between">
          <Text color={unavailableReason ? tuiTheme.roles.secondary : focus === index + start
            ? tuiTheme.roles.focus : undefined} bold={focus === index + start}>
            {focus === index + start ? '› ' : '  '}{unavailableReason ? '–' : on ? '◆' : '◇'} {observed?.displayName ?? agentLabel(target)}
          </Text>
          <Text color={blocked ? tuiTheme.roles.error : conflict ? tuiTheme.roles.warning : tuiTheme.roles.secondary}>{hint}</Text>
        </Box>;
      })}
      <Text color={error || preview?.blocked ? tuiTheme.roles.error : tuiTheme.roles.secondary} wrap="wrap">
        {error ?? (refreshing ? '正在重新检查客户端…' : checking ? '正在检查…' : preview?.blocked ? '其他插件仍需要此 Agent，不能保存。'
          : preview?.conflicts.length ? '! 存在目录冲突，可保存；同步时跳过冲突项。'
            : `◆ 已选 ${PLATFORM_TARGETS.filter(enabled).length} 个${!props.pluginId ? ' · r 重新检查' : ''}`)}
      </Text>
    </Box>
    <Text color={preview?.blocked || checking || error ? tuiTheme.roles.secondary : tuiTheme.roles.focus}>
      {focus === PLATFORM_TARGETS.length ? '› ' : '  '}{saving ? '正在保存…' : '保存'}  [s]
    </Text>
    {detailAvailable ? <Text color={focus === PLATFORM_TARGETS.length + 1 ? tuiTheme.roles.focus : undefined}>
      {focus === PLATFORM_TARGETS.length + 1 ? '› ' : '  '}{preview?.blocked ? '为什么不能关闭？' : !props.pluginId ? '查看客户端与冲突说明' : '查看冲突说明'}
    </Text> : null}
  </Box>;
}
