import { Box } from 'ink';

import {
  Callout,
  SectionCard,
  StaticRow,
  StatusCard,
} from './components.js';

export interface CatalogWorkspaceScreenModel {
  label: string;
  state: string;
  workspaceIdentity?: string;
  catalogVersion?: string;
  channel?: string;
  pluginCount?: number;
  snapshotState?: string;
  gitState?: string;
  issues?: readonly string[];
}

export interface CatalogStoreScreenEntry {
  key: string;
  title: string;
  meta: string;
  status: 'reclaimable' | 'retained' | 'deleted' | 'unsafe';
}

export interface CatalogPublicationScreenRecord {
  key: string;
  catalogVersion: string;
  state: 'prepared' | 'uncertain' | 'published' | 'damaged';
  branch?: string;
  message?: string;
}

export function CatalogManagementIntro(): React.JSX.Element {
  return <StatusCard status="info" title="Catalog 目录管理">
    <StaticRow title="工作区、开发来源、本地存储和发布状态只在打开对应页面后读取。" compact />
    <StaticRow title="普通首页不会扫描 Store、Workspace 或远端。" compact />
  </StatusCard>;
}

export function CatalogWorkspaceSummary(props: {
  model?: CatalogWorkspaceScreenModel;
  loading?: boolean;
}): React.JSX.Element {
  if (props.loading) return <StatusCard status="info" title="正在读取 Catalog 工作区" />;
  if (!props.model) return <StatusCard status="warning" title="尚未选择 Catalog 工作区" />;
  const model = props.model;
  return <Box flexDirection="column">
    <SectionCard title="当前工作区">
      <StaticRow title={model.label} meta={model.state} status={model.state === 'ready' ? 'success' : 'warning'} compact />
      {model.catalogVersion ? <StaticRow title="Catalog 版本" meta={`${model.catalogVersion}${model.channel ? ` · ${model.channel}` : ''}`} compact /> : null}
      {model.pluginCount !== undefined ? <StaticRow title="Canonical plugins" meta={String(model.pluginCount)} compact /> : null}
      {model.snapshotState ? <StaticRow title="生成目录" meta={model.snapshotState} compact /> : null}
      {model.gitState ? <StaticRow title="Git" meta={model.gitState} compact /> : null}
    </SectionCard>
    {model.issues?.length ? <Callout status="warning" title="工作区需要处理" description={model.issues.join('；')} /> : null}
  </Box>;
}

export function CatalogStoreSummary(props: {
  reclaimableCount: number;
  reclaimableBytes: number;
  retainedCount: number;
  retainedBytes?: number;
  deletedCount?: number;
  deletedBytes?: number;
  entries: readonly CatalogStoreScreenEntry[];
  before: number;
  after: number;
}): React.JSX.Element {
  const visible = props.entries.slice(props.before, props.after);
  return <Box flexDirection="column">
    <SectionCard title="本地 Catalog Store">
      <StaticRow title="可安全清理" meta={`${props.reclaimableCount} 项 · ${props.reclaimableBytes} bytes`} status={props.reclaimableCount ? 'warning' : 'muted'} compact />
      <StaticRow title="保留" meta={props.retainedBytes === undefined
        ? `${props.retainedCount} 项 · 大小未计算`
        : `${props.retainedCount} 项 · ${props.retainedBytes} bytes`} compact />
      {props.deletedCount !== undefined ? <StaticRow title="本次实际删除" meta={`${props.deletedCount} 项 · ${props.deletedBytes ?? 0} bytes`} status="success" compact /> : null}
      {props.before > 0 ? <StaticRow title={`↑ 前面还有 ${props.before} 项`} status="muted" compact /> : null}
      {visible.map((entry) => <StaticRow key={entry.key} title={entry.title} meta={entry.meta}
        status={entry.status === 'reclaimable' ? 'warning' : entry.status === 'unsafe' ? 'error' : entry.status === 'deleted' ? 'success' : 'muted'} compact />)}
      {props.after < props.entries.length ? <StaticRow title={`↓ 后面还有 ${props.entries.length - props.after} 项`} status="muted" compact /> : null}
    </SectionCard>
  </Box>;
}

export function CatalogPublicationSummary(props: {
  records: readonly CatalogPublicationScreenRecord[];
  before: number;
  after: number;
}): React.JSX.Element {
  const visible = props.records.slice(props.before, props.after);
  return <SectionCard title="本地发布记录">
    {props.records.length === 0 ? <StaticRow title="没有本地发布记录" status="muted" compact /> : null}
    {props.before > 0 ? <StaticRow title={`↑ 前面还有 ${props.before} 项`} status="muted" compact /> : null}
    {visible.map((record) => <StaticRow key={record.key}
      title={`${record.catalogVersion} · ${record.state}`}
      meta={record.message ?? record.branch}
      status={record.state === 'damaged' ? 'error' : record.state === 'uncertain' ? 'warning' : record.state === 'published' ? 'success' : 'info'} compact />)}
    {props.after < props.records.length ? <StaticRow title={`↓ 后面还有 ${props.records.length - props.after} 项`} status="muted" compact /> : null}
  </SectionCard>;
}
