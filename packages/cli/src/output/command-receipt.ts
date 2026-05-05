import type {
  CatalogResolution,
  GeneratedArtifact,
  NativePluginsByPlatform,
  Scope,
  SkippedUpgradeTarget,
} from '../types.js';

export interface CliMarketplaceReceipt {
  rootDir: string;
  changed: boolean;
  mode?: 'readOnly' | 'runtimeWritable';
  catalog: CatalogResolution;
}

export interface CliCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  skipped?: SkippedUpgradeTarget[];
  nativePlugins?: NativePluginsByPlatform;
  repoManagedArtifacts?: GeneratedArtifact[];
  marketplace?: CliMarketplaceReceipt;
}

export interface CliCommandExecutionGroup {
  scope: Scope;
  platforms: string[];
  plugins: string[];
}

export interface CliCommandReceipt {
  result: CliCommandResult;
  groups: CliCommandExecutionGroup[];
}

export interface CliInitReceipt {
  rootDir: string;
  changed: boolean;
  warnings: string[];
}

export type CliReceiptCommand = 'install' | 'uninstall' | 'upgrade';

interface ReceiptTarget {
  plugin: string;
  platform: string;
  scope: Scope;
}

interface ReceiptAction extends ReceiptTarget {
  type: CliReceiptCommand;
  status: 'succeeded';
}

interface ReceiptArtifact {
  platform: string;
  kind: GeneratedArtifact['kind'];
  path: string;
  artifactKey?: string;
}

interface ReceiptNativePlugin {
  platform: string;
  plugin: string;
}

interface ReceiptNativeSummary {
  plugins: ReceiptNativePlugin[];
  marketplace?: {
    rootDir: string;
    source: CatalogResolution['source'];
    mode: 'readOnly' | 'runtimeWritable';
    changed: boolean;
    reason?: string;
  };
}

interface ReceiptJsonBase {
  ok: true;
  command: 'init' | CliReceiptCommand;
  warnings: string[];
  nextSteps: string[];
}

export interface InitReceiptJson extends ReceiptJsonBase {
  command: 'init';
  rootDir: string;
  changed: boolean;
}

export interface InstallReceiptJson extends ReceiptJsonBase {
  command: 'install';
  plugins: string[];
  targets: ReceiptTarget[];
  actions: ReceiptAction[];
  artifacts: ReceiptArtifact[];
  native: ReceiptNativeSummary;
}

export interface UninstallReceiptJson extends ReceiptJsonBase {
  command: 'uninstall';
  plugins: string[];
  targets: ReceiptTarget[];
  actions: ReceiptAction[];
  artifacts: ReceiptArtifact[];
  native: ReceiptNativeSummary;
}

export interface UpgradeReceiptJson extends ReceiptJsonBase {
  command: 'upgrade';
  upgraded: ReceiptTarget[];
  skipped: SkippedUpgradeTarget[];
  targets: ReceiptTarget[];
  actions: ReceiptAction[];
  artifacts: ReceiptArtifact[];
  native: ReceiptNativeSummary;
}

export type CommandReceiptJson =
  | InstallReceiptJson
  | UninstallReceiptJson
  | UpgradeReceiptJson;

const PLATFORM_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function mergeMarketplaceReceipts(
  results: Array<{ marketplace?: CliMarketplaceReceipt }>,
): CliMarketplaceReceipt | undefined {
  const receipts = results
    .map((result) => result.marketplace)
    .filter((receipt): receipt is CliMarketplaceReceipt => Boolean(receipt));
  if (receipts.length === 0) {
    return undefined;
  }

  return {
    rootDir: receipts[0].rootDir,
    changed: receipts.some((receipt) => receipt.changed),
    mode: receipts.some((receipt) => receipt.mode === 'runtimeWritable')
      ? 'runtimeWritable'
      : receipts[0].mode,
    catalog: receipts.find((receipt) => receipt.catalog.source === 'local')?.catalog ?? receipts[0].catalog,
  };
}

function formatChineseList(values: string[]): string {
  const unique = uniqueStrings(values);
  return unique.length > 0 ? unique.join('、') : '无';
}

function scopeLabel(scope: Scope): string {
  return scope === 'project' ? '当前项目' : '当前用户';
}

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

function sanitizeHumanText(text: string): string {
  return text
    .replaceAll('project scope', '当前项目')
    .replaceAll('user scope', '当前用户')
    .replaceAll('repo-managed', '当前仓库文件')
    .replaceAll('app-server', '本地服务')
    .replaceAll('RPC', '接口调用')
    .replaceAll('rpc', '接口调用')
    .replaceAll('breadcrumb', '恢复标记')
    .replaceAll('ledger', '安装记录')
    .replaceAll('marketplace', '插件目录')
    .replaceAll('cache', '本地缓存')
    .replaceAll('healthSource', '状态来源')
    .replaceAll('config health', '配置状态')
    .replaceAll('script health', '脚本状态');
}

function dedupeTargets(targets: ReceiptTarget[]): ReceiptTarget[] {
  const seen = new Set<string>();
  const entries: ReceiptTarget[] = [];
  for (const target of targets) {
    const key = `${target.plugin}\0${target.platform}\0${target.scope}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(target);
  }
  return entries;
}

function collectSucceededTargets(receipt: CliCommandReceipt): ReceiptTarget[] {
  const targets: ReceiptTarget[] = [];
  for (const group of receipt.groups) {
    for (const plugin of uniqueStrings(group.plugins)) {
      for (const platform of uniqueStrings(group.platforms)) {
        targets.push({
          plugin,
          platform,
          scope: group.scope,
        });
      }
    }
  }
  return dedupeTargets(targets);
}

function mapSkippedTargets(skipped: SkippedUpgradeTarget[]): ReceiptTarget[] {
  return skipped.map((entry) => ({
    plugin: entry.plugin,
    platform: entry.platform,
    scope: entry.scope,
  }));
}

function collectArtifacts(artifacts: GeneratedArtifact[] | undefined): ReceiptArtifact[] {
  return (artifacts ?? []).map((artifact) => ({
    platform: artifact.platform,
    kind: artifact.kind,
    path: artifact.path,
    ...(artifact.artifactKey ? { artifactKey: artifact.artifactKey } : {}),
  }));
}

function collectNativeSummary(result: CliCommandResult): ReceiptNativeSummary {
  const plugins = Object.entries(result.nativePlugins ?? {})
    .flatMap(([platform, names]) =>
      (names ?? []).map((plugin) => ({
        platform,
        plugin,
      })),
    );

  return {
    plugins,
    ...(result.marketplace
      ? {
          marketplace: {
            rootDir: result.marketplace.catalog.rootDir,
            source: result.marketplace.catalog.source,
            mode: result.marketplace.mode ?? 'runtimeWritable',
            changed: result.marketplace.changed,
            ...(result.marketplace.catalog.reason
              ? { reason: result.marketplace.catalog.reason }
              : {}),
          },
        }
      : {}),
  };
}

function buildStatusCommand(result: CliCommandResult): string {
  const firstPlugin = result.plugins[0];
  const uniquePlatforms = uniqueStrings(result.platforms);
  let platformFlag = '';
  if (uniquePlatforms.length === 1) {
    platformFlag = ` -p ${uniquePlatforms[0]}`;
  } else if (uniquePlatforms.length > 1) {
    platformFlag = ' -p both';
  }
  return `aw status${firstPlugin ? ` ${firstPlugin}` : ''}${platformFlag}`;
}

function buildCommandNextSteps(result: CliCommandResult): string[] {
  return [`运行 ${buildStatusCommand(result)} 查看当前状态。`];
}

export function buildInitReceiptJson(result: CliInitReceipt): InitReceiptJson {
  return {
    ok: true,
    command: 'init',
    rootDir: result.rootDir,
    changed: result.changed,
    warnings: [...new Set(result.warnings)],
    nextSteps: ['运行 aw status 查看当前环境与插件状态。'],
  };
}

export function buildCommandReceiptJson(
  command: CliReceiptCommand,
  receipt: CliCommandReceipt,
): CommandReceiptJson {
  const warnings = [...new Set(receipt.result.warnings)];
  const nextSteps = buildCommandNextSteps(receipt.result);
  const actions = collectSucceededTargets(receipt).map((target) => ({
    ...target,
    type: command,
    status: 'succeeded' as const,
  }));
  const artifacts = collectArtifacts(receipt.result.repoManagedArtifacts);
  const native = collectNativeSummary(receipt.result);

  if (command === 'install') {
    return {
      ok: true,
      command,
      plugins: uniqueStrings(receipt.result.plugins),
      targets: actions.map(({ plugin, platform, scope }) => ({ plugin, platform, scope })),
      actions,
      artifacts,
      native,
      warnings,
      nextSteps,
    };
  }

  if (command === 'uninstall') {
    return {
      ok: true,
      command,
      plugins: uniqueStrings(receipt.result.plugins),
      targets: actions.map(({ plugin, platform, scope }) => ({ plugin, platform, scope })),
      actions,
      artifacts,
      native,
      warnings,
      nextSteps,
    };
  }

  const upgraded = actions.map(({ plugin, platform, scope }) => ({ plugin, platform, scope }));
  const skipped = receipt.result.skipped ?? [];
  return {
    ok: true,
    command,
    upgraded,
    skipped,
    targets: dedupeTargets([...upgraded, ...mapSkippedTargets(skipped)]),
    actions,
    artifacts,
    native,
    warnings,
    nextSteps,
  };
}

function formatArtifactSurfaces(artifacts: GeneratedArtifact[] | undefined): string | undefined {
  const surfaces = new Set<string>();
  for (const artifact of artifacts ?? []) {
    if (artifact.platform !== 'codex') {
      continue;
    }
    switch (artifact.kind) {
      case 'skill':
        surfaces.add('.agents/skills');
        break;
      case 'mcpServer':
      case 'instruction':
        surfaces.add('.codex/config.toml');
        break;
      case 'permission':
        surfaces.add('.codex/rules');
        break;
      case 'hook':
        surfaces.add('.codex/hooks.json');
        break;
      case 'agent':
        surfaces.add('.codex/agents');
        break;
    }
  }

  if (surfaces.size === 0) {
    return undefined;
  }
  surfaces.add('.codex/.agent-workflows-manifest.json');
  return [...surfaces].join('、');
}

function formatTargetSummary(targets: ReceiptTarget[]): string {
  const platforms = formatChineseList(targets.map((target) => platformLabel(target.platform)));
  const scopes = formatChineseList(targets.map((target) => scopeLabel(target.scope)));
  return `${platforms}；${scopes}`;
}

export function renderInitReceipt(result: CliInitReceipt): string[] {
  return [
    `${result.changed ? '已准备好' : '已复用'}本地插件目录：${result.rootDir}。`,
    '下一步：运行 aw status 查看当前环境与插件状态。',
  ];
}

export function renderCommandReceipt(
  command: CliReceiptCommand,
  receipt: CliCommandReceipt,
): string[] {
  const payload = buildCommandReceiptJson(command, receipt);
  const lines: string[] = [];
  const artifacts = formatArtifactSurfaces(receipt.result.repoManagedArtifacts);

  if (payload.command === 'upgrade') {
    const upgradedPlugins = formatChineseList(payload.upgraded.map((target) => target.plugin));
    if (payload.upgraded.length === 0 && payload.skipped.length > 0) {
      lines.push(`这次没有完成升级，已跳过 ${payload.skipped.length} 个目标。`);
    } else {
      lines.push(`已升级 ${upgradedPlugins}。`);
    }
    if (payload.targets.length > 0) {
      lines.push(`目标：${formatTargetSummary(payload.targets)}。`);
    }
    if (artifacts) {
      lines.push(`已更新项目文件：${artifacts}。`);
    }
    if (payload.skipped.length > 0) {
      lines.push(`未处理 ${payload.skipped.length} 个目标：`);
      for (const entry of payload.skipped) {
        lines.push(
          `- ${platformLabel(entry.platform)} / ${scopeLabel(entry.scope)} / ${entry.plugin}：${sanitizeHumanText(entry.reason)}`,
        );
      }
    }
    lines.push(`下一步：${payload.nextSteps[0]}`);
    return lines;
  }

  if (payload.command !== 'install' && payload.command !== 'uninstall') {
    return lines;
  }

  const plugins = formatChineseList(payload.plugins);
  lines.push(`${payload.command === 'install' ? '已安装' : '已卸载'} ${plugins}。`);
  if (payload.targets.length > 0) {
    lines.push(`目标：${formatTargetSummary(payload.targets)}。`);
  }
  if (artifacts) {
    lines.push(`${payload.command === 'install' ? '已更新' : '已清理'}项目文件：${artifacts}。`);
  } else if (payload.command === 'uninstall') {
    lines.push('已清理相关文件和已安装项。');
  }
  lines.push(`下一步：${payload.nextSteps[0]}`);
  return lines;
}
