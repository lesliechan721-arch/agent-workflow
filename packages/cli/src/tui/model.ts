import type {
  PlatformName,
  PluginConfigFieldType,
  PluginConfigSchema,
  Scope,
} from '../types.js';
import type {
  StatusV4Payload,
  StatusV4PluginSummary,
  StatusV4Target,
} from '../commands/status-v4.js';
import type { ResolvedConfigRead } from '../utils/plugin-config.js';

export type SourceHealthState = 'ready' | 'cache' | 'path' | 'checking' | 'degraded' | 'unavailable';

export interface SourceHealthViewModel {
  sourceId: string;
  state: SourceHealthState;
  issueId?: string;
  message?: string;
}

export type PlatformPlacementSummary =
  | { platform: PlatformName; state: 'notInstalled'; supportedScopes: Scope[] }
  | {
      platform: PlatformName;
      state: 'installed';
      scope: Scope;
      health: 'ready' | 'incomplete' | 'error';
    }
  | {
      platform: PlatformName;
      state: 'scopeConflict';
      placements: Array<{ scope: Scope; health: 'ready' | 'incomplete' | 'error' }>;
    };

export interface PluginListItemViewModel {
  pluginId: string;
  sourceId: string;
  displayName: string;
  description: string;
  sourceLabel: string;
  supportedPlatforms: PlatformName[];
  installedPlacements: PlatformPlacementSummary[];
  aggregateStatus: 'available' | 'installed' | 'needsAttention' | 'unavailable';
}

export interface SourceTabViewModel {
  id: string;
  label: string;
  count?: number;
  primary: boolean;
  state: 'ready' | 'cache' | 'path' | 'error';
}

export interface HomeSummaryViewModel {
  availablePlugins: number;
  installedPlugins: number;
  issueCount: number;
  sourceCount: number;
  unavailableSourceCount: number;
}

export interface ConfigFieldViewModel {
  key: string;
  title: string;
  description?: string;
  type: PluginConfigFieldType;
  displayValue: string;
  required: boolean;
  sensitive: boolean;
  dirty: boolean;
  inherited: boolean;
}

export interface ConfigGroupViewModel {
  id: string;
  title: string;
  description?: string;
  advanced: boolean;
  fields: ConfigFieldViewModel[];
}

export interface UserIssueViewModel {
  issueId: string;
  title: string;
  explanation: string;
  impact: string[];
  entity: { kind: 'plugin' | 'source'; id: string };
  recommendedAction?: string;
  alternativeActions: string[];
  technicalDetails: Array<{ code: string; message: string }>;
}

export interface TuiViewModel {
  plugins: PluginListItemViewModel[];
  sourceTabs: SourceTabViewModel[];
  issues: UserIssueViewModel[];
  home: HomeSummaryViewModel;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function targetHealth(target: StatusV4Target): 'ready' | 'incomplete' | 'error' {
  if (target.state === 'present') return 'ready';
  if (target.state === 'partial') return 'incomplete';
  return 'error';
}

export function projectPlatformPlacement(
  platform: PlatformName,
  targets: StatusV4Target[],
): PlatformPlacementSummary {
  const supportedScopes = [...new Set(targets.map((target) => target.scope))];
  const installed = targets.filter((target) => target.state !== 'absent');
  if (installed.length === 0) return { platform, state: 'notInstalled', supportedScopes };
  if (installed.length === 1) {
    const target = installed[0]!;
    return { platform, state: 'installed', scope: target.scope, health: targetHealth(target) };
  }
  return {
    platform,
    state: 'scopeConflict',
    placements: installed.map((target) => ({
      scope: target.scope,
      health: targetHealth(target),
    })).sort((left, right) => compareText(left.scope, right.scope)),
  };
}

function sourceState(
  source: StatusV4Payload['catalog']['sources'][number],
  health?: SourceHealthViewModel,
): SourceTabViewModel['state'] {
  if (health?.state === 'degraded') return 'cache';
  if (health?.state === 'unavailable') return 'error';
  if (source.error) return 'error';
  if (source.type === 'path' || source.freshness === 'path') return 'path';
  return source.freshness === 'cache' ? 'cache' : 'ready';
}

function sourceIssue(
  health: SourceHealthViewModel,
): UserIssueViewModel | undefined {
  if (health.state !== 'degraded' && health.state !== 'unavailable') return undefined;
  const cached = health.state === 'degraded';
  const issueId = health.issueId ?? `source:${health.sourceId}:${cached ? 'cache' : 'unavailable'}`;
  return {
    issueId,
    title: `${health.sourceId} · ${cached ? '来源使用缓存' : '来源不可用'}`,
    explanation: cached
      ? '远端检查失败。当前仍使用已验证的缓存数据。'
      : '远端检查失败，并且没有可用缓存数据。',
    impact: [cached ? '插件仍可浏览，但数据可能不是最新。' : '当前不能浏览或安装这个来源的插件。'],
    entity: { kind: 'source', id: health.sourceId },
    recommendedAction: '重新检查来源',
    alternativeActions: cached ? ['继续使用缓存'] : ['修复来源配置', '稍后重试'],
    technicalDetails: [{ code: cached ? 'catalogSourceDegraded' : 'catalogSourceUnavailable', message: health.message ?? '来源检查失败。' }],
  };
}

function targetIssues(payload: StatusV4Payload): UserIssueViewModel[] {
  const issues: UserIssueViewModel[] = [];
  const byPlacement = new Map<string, StatusV4Target[]>();
  for (const target of payload.targets) {
    const key = `${target.pluginId}\0${target.platform}`;
    byPlacement.set(key, [...(byPlacement.get(key) ?? []), target]);
    if (target.state !== 'partial' && target.state !== 'error') continue;
    const issueId = `target:${target.pluginId}:${target.platform}:${target.scope}:${target.state}`;
    issues.push({
      issueId,
      title: `${target.pluginId} · ${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${target.state === 'partial' ? '安装不完整' : '检查失败'}`,
      explanation: target.state === 'partial'
        ? '必要内容缺失，插件可能不能稳定运行。'
        : '当前目标不能安全分类为正常安装。',
      impact: ['写操作前需要重新检查这个目标。'],
      entity: { kind: 'plugin', id: target.pluginId },
      recommendedAction: target.state === 'partial' ? '重新安装' : undefined,
      alternativeActions: ['查看技术详情'],
      technicalDetails: target.errors.length > 0 ? target.errors : [{ code: 'targetStateError', message: '目标状态异常。' }],
    });
  }
  for (const [key, targets] of byPlacement) {
    const installed = targets.filter((target) => target.state !== 'absent');
    if (new Set(installed.map((target) => target.scope)).size < 2) continue;
    const sample = installed[0]!;
    issues.push({
      issueId: `scope:${sample.pluginId}:${sample.platform}`,
      title: `${sample.pluginId} · ${sample.platform === 'codex' ? 'Codex' : 'Claude Code'} · 安装位置冲突`,
      explanation: '所有项目和当前项目同时发现了这个插件。',
      impact: ['正常状态只能保留一个位置。'],
      entity: { kind: 'plugin', id: sample.pluginId },
      recommendedAction: '选择保留一个位置',
      alternativeActions: ['查看两个位置的详情'],
      technicalDetails: [{ code: 'scopeConflict', message: key.replace('\0', '/') }],
    });
  }
  return issues;
}

function statusIssues(payload: StatusV4Payload): UserIssueViewModel[] {
  const targetCodes = new Set(payload.targets.flatMap((target) =>
    target.errors.map((error) => error.code)));
  const issues = new Map<string, UserIssueViewModel>();
  for (const error of payload.errors) {
    if (targetCodes.has(error.code) || issues.has(error.code)) continue;
    const projection = error.code === 'legacyStateUnsupported'
      ? {
          title: '发现旧版状态',
          explanation: '当前状态使用不受支持的旧格式。',
          impact: '在迁移或清理旧状态前，部分操作不可用。',
        }
      : error.code === 'nativeStateUnreadable'
        ? {
            title: '平台状态不可读',
            explanation: '当前不能安全读取平台状态。',
            impact: '部分安装状态可能不可用。',
          }
        : {
            title: '状态清单不可用',
            explanation: '当前不能完成状态清单检查。',
            impact: '部分安装状态可能不可用。',
          };
    issues.set(error.code, {
      issueId: `status:${error.code}`,
      title: projection.title,
      explanation: projection.explanation,
      impact: [projection.impact],
      entity: { kind: 'source', id: payload.catalog.primarySourceId },
      alternativeActions: ['稍后重试'],
      technicalDetails: [{ code: error.code, message: projection.explanation }],
    });
  }
  return [...issues.values()];
}

export function buildTuiViewModel(options: {
  status: StatusV4Payload;
  pluginSummaries: StatusV4PluginSummary[];
  sourceHealth?: ReadonlyMap<string, SourceHealthViewModel>;
}): TuiViewModel {
  const summaryById = new Map(options.pluginSummaries.map((summary) => [summary.pluginId, summary]));
  const targetsByPlugin = new Map<string, StatusV4Target[]>();
  for (const target of options.status.targets) {
    targetsByPlugin.set(target.pluginId, [...(targetsByPlugin.get(target.pluginId) ?? []), target]);
  }
  const pluginIds = new Set([...summaryById.keys(), ...targetsByPlugin.keys()]);
  const plugins = [...pluginIds].map((pluginId): PluginListItemViewModel => {
    const summary = summaryById.get(pluginId);
    const targets = targetsByPlugin.get(pluginId) ?? [];
    const sourceId = targets[0]?.sourceId ?? pluginId.slice(0, pluginId.indexOf('/'));
    const placements = (['codex', 'claude'] as const).flatMap((platform) => {
      const platformTargets = targets.filter((target) => target.platform === platform);
      return platformTargets.length > 0 ? [projectPlatformPlacement(platform, platformTargets)] : [];
    });
    const attention = placements.some((placement) => placement.state === 'scopeConflict'
      || (placement.state === 'installed' && placement.health !== 'ready'));
    const installed = placements.some((placement) => placement.state !== 'notInstalled');
    const unavailable = options.sourceHealth?.get(sourceId)?.state === 'unavailable';
    return {
      pluginId,
      sourceId,
      displayName: summary?.pluginName ?? targets[0]?.pluginName ?? pluginId,
      description: summary?.description ?? '',
      sourceLabel: sourceId,
      supportedPlatforms: placements.map((placement) => placement.platform),
      installedPlacements: placements,
      aggregateStatus: unavailable ? 'unavailable' : attention ? 'needsAttention' : installed ? 'installed' : 'available',
    };
  }).sort((left, right) => compareText(left.displayName, right.displayName)
    || compareText(left.sourceId, right.sourceId));
  const sourceTabs = options.status.catalog.sources.map((source) => ({
    id: source.id,
    label: source.id,
    count: plugins.filter((plugin) => plugin.sourceId === source.id).length,
    primary: source.primary,
    state: sourceState(source, options.sourceHealth?.get(source.id)),
  }));
  const issues = [
    ...targetIssues(options.status),
    ...statusIssues(options.status),
    ...[...(options.sourceHealth?.values() ?? [])].flatMap((health) => sourceIssue(health) ?? []),
  ];
  return {
    plugins,
    sourceTabs,
    issues,
    home: {
      availablePlugins: plugins.filter((plugin) => plugin.aggregateStatus === 'available').length,
      installedPlugins: plugins.filter((plugin) => plugin.aggregateStatus === 'installed'
        || plugin.aggregateStatus === 'needsAttention').length,
      issueCount: issues.length,
      sourceCount: sourceTabs.length,
      unavailableSourceCount: sourceTabs.filter((source) => source.state === 'error').length,
    },
  };
}

function displayConfigValue(options: {
  privateValue: boolean;
  inherited: boolean;
  configured: boolean;
  value: unknown;
}): string {
  if (!options.configured) return options.inherited ? '继承' : '未设置';
  if (options.privateValue) return '已设置';
  if (typeof options.value === 'string') return options.value;
  if (options.value === undefined || options.value === null) return '已设置';
  return String(options.value);
}

export function buildConfigGroups(options: {
  schema: PluginConfigSchema;
  read: ResolvedConfigRead;
  dirtyKeys?: ReadonlySet<string>;
}): ConfigGroupViewModel[] {
  const entryByKey = new Map(options.read.fields.map((field) => [field.key, field]));
  const fieldModel = (key: string): ConfigFieldViewModel => {
    const schema = options.schema.schema[key]!;
    const entry = entryByKey.get(key);
    const inherited = entry?.storedSourceLayer === undefined;
    const configured = entry?.valueState === 'configured' || entry?.valueState === 'default';
    return {
      key,
      title: schema.title ?? key,
      ...(schema.description ? { description: schema.description } : {}),
      type: schema.type,
      displayValue: displayConfigValue({
        privateValue: schema.sensitive === true || schema.type === 'file' || schema.type === 'directory',
        inherited,
        configured,
        value: entry?.effectiveValue,
      }),
      required: schema.required === true,
      sensitive: schema.sensitive === true,
      dirty: options.dirtyKeys?.has(key) === true,
      inherited,
    };
  };
  const assigned = new Set<string>();
  const groups = (options.schema.presentation?.groups ?? []).map((group) => {
    group.fields.forEach((key) => assigned.add(key));
    return {
      id: group.id,
      title: group.title,
      ...(group.description ? { description: group.description } : {}),
      advanced: group.advanced === true,
      fields: group.fields.map(fieldModel),
    };
  });
  const remaining = Object.keys(options.schema.schema).filter((key) => !assigned.has(key));
  if (remaining.length > 0 || groups.length === 0) {
    groups.push({
      id: 'general',
      title: '常规设置',
      advanced: false,
      fields: (groups.length === 0 ? Object.keys(options.schema.schema) : remaining).map(fieldModel),
    });
  }
  return groups;
}
