import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StatusV8Payload } from '../../src/commands/status-v6.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import type {
  CatalogManagementIntent,
  CatalogManagementReviewEvidence,
  CatalogManagementService,
  CatalogPublicationManagementViewModel,
  CatalogStoreManagementViewModel,
  CatalogWorkspaceManagementViewModel,
} from '../../src/tui/catalog-management.js';
import {
  TuiController,
  type OperationIntent,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';

afterEach(() => cleanup());

function status(): TuiStatusLoadResult {
  const payload: StatusV8Payload = {
    schemaVersion: 8,
    catalog: {
      primarySourceId: 'official',
      configDigest: 'sha256:config',
      compositeDigest: 'sha256:composite',
      sources: [{
        id: 'official',
        identity: 'identity:official',
        type: 'git',
        primary: true,
        requestedRef: 'refs/heads/catalog/latest',
        resolvedCommit: 'a'.repeat(40),
        catalogVersion: '1.0.0',
        channel: 'latest',
        freshness: 'active',
      }],
    },
    filters: { plugins: [], platform: 'both', cwd: '/workspace' },
    targets: [],
    errors: [],
  };
  return {
    payload,
    pluginSummaries: [],
    configuredSources: [{
      id: 'official',
      type: 'git',
      primary: true,
      url: 'https://example.test/catalog.git',
      refPolicy: { type: 'cliChannel' },
      autoCheck: true,
    }],
    sourceDetails: [{
      id: 'official',
      type: 'git',
      primary: true,
      locationSummary: 'https://example.test/catalog.git',
      refPolicy: 'cliChannel',
      pluginCount: 0,
      sourceIdentity: 'identity:official',
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'a'.repeat(40),
      catalogVersion: '1.0.0',
      channel: 'latest',
      freshness: 'active',
      configDigest: 'sha256:config',
    }],
    catalogGenerations: [{
      sourceId: 'official',
      sourceType: 'git',
      state: 'ready',
      active: {
        catalogVersion: '1.0.0',
        channel: 'latest',
        requestedRef: 'refs/heads/catalog/latest',
        resolvedCommit: 'a'.repeat(40),
        storeKey: 'official/active',
        digestShort: 'aaaaaaaa',
      },
    }],
  };
}

function controller(overrides: Partial<TuiControllerDependencies> = {}): TuiController {
  const dependencies: TuiControllerDependencies = {
    loadStatus: vi.fn().mockResolvedValue(status()),
    captureEvidence: vi.fn(async (_intent: OperationIntent) => ({
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    })),
    executeIntent: vi.fn(),
    ...overrides,
  };
  return new TuiController(dependencies);
}

const planDigest = `sha256:${'b'.repeat(64)}`;

function workspace(selected = true): CatalogWorkspaceManagementViewModel {
  return {
    state: 'ready',
    selected,
    label: 'team-catalog',
    resolvedFrom: 'explicit',
    identity: 'workspace:team-catalog',
    catalog: {
      version: '1.2.3', channel: 'latest', ownerName: 'team',
      ownerUrl: 'https://example.test/team', displayName: 'Team Catalog',
    },
    plugins: [{ name: 'review', version: '1.2.3', dependencies: [] }],
    dependencyGraphValid: true,
    git: { checked: true, clean: true, hasHead: true },
    snapshot: {
      state: 'current', valid: true, catalogVersion: '1.2.3',
      hasDigest: true, sourceIdentityMatches: true,
    },
    issues: [],
  };
}

function store(): CatalogStoreManagementViewModel {
  const entries = [
    {
      item: { category: 'entry' as const, storeKey: 'reclaimable' },
      itemKey: 'reclaimable', category: 'entry' as const, status: 'reclaimable' as const,
      generationReference: 'none' as const, ageMs: 31 * 24 * 60 * 60 * 1000,
      reclaimableBytes: 2048, reason: 'inactiveOlderThan30Days',
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      item: { category: 'entry' as const, storeKey: `retained-${index + 1}` },
      itemKey: `retained-${index + 1}`, category: 'entry' as const, status: 'retained' as const,
      generationReference: 'none' as const, ageMs: 10, reclaimableBytes: null,
      reason: 'inactiveWithin30Days',
    })),
    {
      item: { category: 'entry' as const, storeKey: 'retained-last' },
      itemKey: 'retained-last', category: 'entry' as const, status: 'retained' as const,
      generationReference: 'none' as const, ageMs: 10, reclaimableBytes: null,
      reason: 'inactiveWithin30Days',
    },
  ];
  return {
    state: 'ready',
    entries,
    totals: { entries: entries.length, reclaimableEntries: 1, reclaimableBytes: 2048, retainedEntries: 9 },
    issues: [],
  };
}

function publication(pending: boolean): CatalogPublicationManagementViewModel {
  return {
    state: pending ? 'pending' : 'none',
    records: pending ? [{
      catalogVersion: '1.2.3', state: 'prepared', channel: 'latest', pluginCount: 1,
      planDigest, remote: 'origin', branch: 'catalog/release', canApply: true,
      requiresRemoteInput: false, mustIncreaseVersion: false, localRepositoryState: 'present',
    }] : [],
    issues: [],
  };
}

function managementEvidence(intent: CatalogManagementIntent): CatalogManagementReviewEvidence {
  const base: CatalogManagementReviewEvidence = {
    action: intent.action,
    workspaceBinding: intent.action === 'storePrune' ? null : 'workspace:team-catalog',
    evidenceDigest: `sha256:${'c'.repeat(64)}`,
  };
  if (intent.action === 'storePrune') return { ...base, store: store() };
  if (intent.action === 'publishApply') return {
    ...base,
    publication: publication(true).records[0]!,
  };
  if (intent.action === 'publishPlan') return {
    ...base,
    workspace: workspace(),
    target: { remote: intent.remote ?? 'origin', branch: intent.branch ?? 'catalog' },
  };
  if (intent.action === 'devActivate') return {
    ...base,
    workspace: workspace(),
    devActivation: {
      evidenceDigest: `sha256:${'d'.repeat(64)}`,
      sourceId: intent.sourceId ?? 'catalog-dev', catalogVersion: '1.2.3',
      inventoryComplete: true, primaryChange: intent.primary === true,
      references: { installation: 0, config: 0, lifecycle: 0, marketplace: 0 },
      changes: { added: 0, removed: 0, changed: 0, newlyIncompatible: 0,
        dependencyChanged: 0, platformSupportChanged: 0 },
    },
  };
  return { ...base, workspace: workspace() };
}

function managementService(options: { onSelect?: (root?: string) => void; pending?: () => boolean } = {}): CatalogManagementService {
  return {
    selectWorkspace: vi.fn(async (root?: string) => {
      options.onSelect?.(root);
      return workspace();
    }),
    getWorkspace: vi.fn(async () => workspace()),
    validateWorkspace: vi.fn(async () => ({
      state: 'valid', catalogVersion: '1.2.3', channel: 'latest', hasSnapshotDigest: true, issues: [],
    })),
    getDev: vi.fn(async () => ({
      state: 'inactive', ready: false, workspaceIdentity: 'workspace:team-catalog',
      snapshot: { state: 'current', valid: true, hasDigest: true },
      source: { exists: false, id: null, pathMatches: null, primary: null },
      active: { exists: false, ready: false, digestMatchesSnapshot: false, compatibility: null },
      issues: [],
    })),
    getStore: vi.fn(async () => store()),
    getPublication: vi.fn(async () => publication(options.pending?.() ?? false)),
    captureEvidence: vi.fn(async (intent) => managementEvidence(intent)),
    execute: vi.fn(),
  };
}

function catalogController(options: { onSelect?: (root?: string) => void } = {}): {
  value: TuiController;
  executeIntent: ReturnType<typeof vi.fn>;
  service: CatalogManagementService;
} {
  let pendingPublication = false;
  const service = managementService({
    onSelect: options.onSelect,
    pending: () => pendingPublication,
  });
  const executeIntent = vi.fn(async (intent: OperationIntent) => {
    if (intent.kind !== 'catalogManagement') return { overallState: 'succeeded', targetResults: [] };
    if (intent.action === 'storePrune') {
      return {
        action: 'storePrune' as const, state: 'succeeded' as const,
        message: '已清理本次确认的 Catalog Store 项目。', messages: [],
        store: { deletedEntries: 1, deletedBytes: 2048, retainedEntries: 9 },
      };
    }
    if (intent.action === 'publishPlan') {
      pendingPublication = true;
      return {
        action: 'publishPlan' as const, state: 'succeeded' as const,
        message: '发布计划已准备，远端尚未写入。', messages: [], catalogVersion: '1.2.3', planDigest,
        publication: {
          catalogVersion: '1.2.3', planDigest, state: 'prepared' as const,
          remote: intent.remote ?? 'origin', branch: intent.branch ?? 'catalog/release',
        },
      };
    }
    return {
      action: intent.action, state: 'succeeded' as const,
      message: 'Catalog 管理操作已完成。', messages: [],
    };
  });
  const value = controller({
    catalogManagement: service,
    captureEvidence: vi.fn(async (intent: OperationIntent) => ({
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
      ...(intent.kind === 'catalogManagement' ? { catalogManagement: managementEvidence(intent) } : {}),
    })),
    executeIntent,
  });
  return { value, executeIntent, service };
}

async function nextTurn(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await nextTurn(2);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (check()) return;
    await nextTurn();
  }
  throw new Error('Timed out waiting for TUI action.');
}

async function confirmReview(instance: ReturnType<typeof render>, value: TuiController): Promise<void> {
  await waitFor(() => value.snapshot.activeReview !== undefined);
  if (value.snapshot.activeReview?.requiresConfirmation) {
    await input(instance, '\r', '\u001B[B', '\r');
  } else await input(instance, '\r');
  await waitFor(() => value.snapshot.result !== undefined);
}

describe('TUI Catalog management v7', () => {
  it('shows the exact target version in the Workspace risk authorization', async () => {
    const { value, executeIntent } = catalogController();
    await value.load();
    value.push({ name: 'catalogWorkspace', view: 'overview' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    await input(instance, '\u001B[B', '\r', '\r');
    await waitFor(() => value.snapshot.activeReview?.title === '修改 Catalog 版本');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('操作：修改 Catalog 版本');
    expect(instance.lastFrame()).toContain('版本：1.2.3 → 1.2.4');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('opens Catalog management from sources and applies an explicitly entered workspace root', async () => {
    const selectedRoots: Array<string | undefined> = [];
    const { value } = catalogController({ onSelect: (root) => selectedRoots.push(root) });
    await value.load();
    value.push({ name: 'sourceList' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('catalogManagement');
    expect(instance.lastFrame()).toContain('工作区、开发来源、本地存储和发布状态只在打开对应页面后读取。');

    await input(instance, '\r', '\r', '/workspace/team-catalog', '\r');
    await waitFor(() => selectedRoots.length === 1);
    expect(selectedRoots).toEqual(['/workspace/team-catalog']);
    expect(value.snapshot.router.current.route).toEqual({ name: 'catalogWorkspace', view: 'overview' });
  });

  it('restores Workspace and publication fields across Esc and guards Home navigation', async () => {
    const { value, service } = catalogController();
    service.getWorkspace = vi.fn(async () => ({
      ...workspace(), state: 'missing', catalog: {
        version: null, channel: null, ownerName: null, ownerUrl: null, displayName: null,
      }, plugins: [], identity: null,
    }));
    await value.load();
    value.push({ name: 'catalogWorkspace', view: 'overview' });
    const navigate = vi.fn(async () => value.hasSessionDraft ? 'draftBlocked' as const : 'completed' as const);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }}
      onSessionNavigation={navigate} />);
    await nextTurn(5);

    await input(instance, '\u001B[B', '\r', 'team-owner', '\r',
      ...Array.from('https://user:owner-secret@example.test/team'));
    expect(instance.frames.join('\n')).not.toMatch(/user:owner-secret|owner-secret/u);
    await input(instance, '\u0015', 'https://example.test/team');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'catalogWorkspace', step: 'ownerName' });
    expect(instance.lastFrame()).toContain('team-owner');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await input(instance, 'H');
    expect(instance.lastFrame()).toContain('放弃未保存修改');
    expect(navigate).toHaveBeenCalledWith('reload', expect.objectContaining({ discardDrafts: false }));
    await input(instance, '\r');

    instance.unmount();
    const publish = catalogController();
    await publish.value.load();
    publish.value.push({ name: 'catalogPublish', step: 'overview' });
    const publishInstance = render(<ConsoleAppV4 controller={publish.value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(5);
    await input(publishInstance, '\r', 'origin/team', '\r', '\u0015', 'catalog/release');
    publishInstance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(publish.value.snapshot.router.current.route).toEqual({ name: 'catalogPublish', step: 'target' });
    expect(publishInstance.lastFrame()).toContain('已输入远程目标');
  });

  it('clears the consumed Workspace draft after successful creation', async () => {
    const { value, service } = catalogController();
    service.getWorkspace = vi.fn(async () => ({
      ...workspace(), state: 'missing', catalog: {
        version: null, channel: null, ownerName: null, ownerUrl: null, displayName: null,
      }, plugins: [], identity: null,
    }));
    await value.load();
    value.push({ name: 'catalogWorkspace', view: 'overview' });
    const navigate = vi.fn().mockResolvedValue('completed');
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }}
      onSessionNavigation={navigate} />);
    await nextTurn(5);

    await input(instance, '\u001B[B', '\r', 'team-owner', '\r',
      'https://example.test/team', '\r', 'Team Catalog', '\r', '\r');
    await waitFor(() => value.snapshot.router.current.route.name === 'review');
    await confirmReview(instance, value);
    await waitFor(() => value.snapshot.result?.state === 'succeeded');

    expect(value.hasSessionDraft).toBe(false);
    await input(instance, '\r', 'h');
    expect(navigate).toHaveBeenCalledWith('home', { discardDrafts: false });
    expect(instance.lastFrame()).not.toContain('放弃未保存修改');
  });

  it('paginates a narrow Store, then reviews and reports only actual prune effects', async () => {
    const { value, executeIntent } = catalogController();
    await value.load();
    value.push({ name: 'catalogStore' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(5);

    expect(instance.lastFrame()).toContain('可安全清理');
    await input(instance, ...Array.from({ length: 8 }, () => '\u001B[6~'));
    const finalPage = instance.lastFrame() ?? '';
    expect(finalPage).toContain('retained-last');
    expect(finalPage.split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, '\r');
    await waitFor(() => value.snapshot.activeReview !== undefined);
    expect(instance.lastFrame()).toContain('删除 1 个可回收项目');
    await confirmReview(instance, value);

    const result = instance.lastFrame() ?? '';
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'catalogManagement', action: 'storePrune',
      items: [{ category: 'entry', storeKey: 'reclaimable' }],
    }), expect.anything());
    expect(result).toContain('实际删除');
    expect(result).toContain('实际保留');
    expect(result).toContain('2048 bytes');
  });

  it('requires a separate build before development-source activation', async () => {
    const { value, executeIntent, service } = catalogController();
    service.getDev = vi.fn(async () => ({
      state: 'needsAttention', ready: false, workspaceIdentity: 'workspace:team-catalog',
      snapshot: { state: 'stale', valid: true, hasDigest: true },
      source: { exists: false, id: null, pathMatches: null, primary: null },
      active: { exists: false, ready: false, digestMatchesSnapshot: false, compatibility: null },
      issues: [],
    }));
    await value.load();
    value.push({ name: 'catalogDev' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    expect(instance.lastFrame()).toContain('先重新构建 Catalog');
    expect(instance.lastFrame()).not.toContain('启用开发来源…');
    await input(instance, '\u001B[B', '\r');
    await waitFor(() => value.snapshot.activeReview?.operationKind === 'catalogManagement');
    expect(value.snapshot.activeReview?.title).toContain('构建 Catalog');
    expect(executeIntent).not.toHaveBeenCalled();
    await confirmReview(instance, value);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'catalogManagement', action: 'workspaceBuild', force: true,
    }), expect.anything());
    expect(instance.lastFrame()).toContain('Catalog 管理操作已完成');
  });

  it('keeps retry activation reachable after a committed source has a partial sync', async () => {
    const { value, executeIntent, service } = catalogController();
    service.getDev = vi.fn(async () => ({
      state: 'needsAttention', ready: false, workspaceIdentity: 'workspace:team-catalog',
      snapshot: { state: 'current', valid: true, hasDigest: true },
      source: { exists: true, id: 'catalog-dev', pathMatches: true, primary: false },
      active: { exists: false, ready: false, digestMatchesSnapshot: false, compatibility: null },
      issues: [{ code: 'catalogDevSyncFailed', message: 'Sync did not finish.', blocking: true }],
    }));
    await value.load();
    value.push({ name: 'catalogDev' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    expect(instance.lastFrame()).toContain('重新启用并同步开发来源');
    expect(instance.lastFrame()).toContain('停用开发来源');
    await input(instance, '\u001B[B', '\r');
    await waitFor(() => value.snapshot.activeReview?.operationKind === 'catalogManagement');
    expect(value.snapshot.activeReview?.title).toContain('启用 Catalog 开发源');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('prepares a publication from remote and branch input, then cancels its separate apply Review', async () => {
    const { value, executeIntent } = catalogController();
    await value.load();
    value.push({ name: 'catalogPublish', step: 'overview' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    await input(instance, '\r', 'origin', '\r', '\u0015', 'catalog/release', '\r');
    await waitFor(() => value.snapshot.activeReview?.operationKind === 'catalogManagement');
    expect(instance.lastFrame()).toContain('准备 Catalog 发布计划');
    expect(executeIntent).not.toHaveBeenCalled();
    await confirmReview(instance, value);

    const planned = instance.lastFrame() ?? '';
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(executeIntent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'catalogManagement', action: 'publishPlan', remote: 'origin', branch: 'catalog/release',
    }), expect.anything());
    expect(planned).toContain('发布计划已准备');
    expect(planned).toContain('prepared');
    expect(planned).toContain('应用此发布计划');

    await input(instance, '\r');
    await waitFor(() => value.snapshot.activeReview?.operationKind === 'catalogManagement'
      && value.snapshot.activeReview?.title === '发布 Catalog');
    expect(executeIntent).toHaveBeenCalledTimes(1);
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('操作：发布 Catalog');
    expect(instance.lastFrame()).toContain('1.2.3');
    expect(instance.lastFrame()).toContain('origin');
    expect(instance.lastFrame()).toContain('catalog/release');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await input(instance, 'b');
    await waitFor(() => value.snapshot.router.current.route.name === 'catalogPublish'
      && value.snapshot.activeReview === undefined);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(instance.lastFrame()).toContain('prepared');
    expect(instance.lastFrame()).toContain('应用 1.2.3');
  });

  it('re-enters a direct remote URL when applying the exact pending plan', async () => {
    const { value, executeIntent, service } = catalogController();
    service.getPublication = vi.fn(async () => ({
      ...publication(true),
      records: [{ ...publication(true).records[0]!, remote: null, requiresRemoteInput: true }],
    }));
    await value.load();
    value.push({ name: 'catalogPublish', step: 'overview' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    await input(instance, '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('重新输入原目标');
    await input(instance, 'ssh://token@example.test/private/catalog.git', '\r', '\r');
    await waitFor(() => value.snapshot.activeReview?.operationKind === 'catalogManagement');
    expect(executeIntent).not.toHaveBeenCalled();
    await confirmReview(instance, value);

    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'catalogManagement', action: 'publishApply', expectedPlanDigest: planDigest,
      remoteUrl: 'ssh://token@example.test/private/catalog.git', branch: 'catalog/release',
    }), expect.anything());
    expect(executeIntent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'publishPlan' }), expect.anything());
  });

  it('keeps the direct remote URL draft for the separate Apply Review after planning', async () => {
    const { value, executeIntent } = catalogController();
    await value.load();
    value.push({ name: 'catalogPublish', step: 'overview' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    const remoteUrl = 'ssh://token@example.test/private/catalog.git';
    await input(instance, '\r', ...Array.from(remoteUrl));
    expect(instance.frames.join('\n')).not.toContain('token@example.test');
    await input(instance, '\r', '\u0015', 'catalog/release', '\r');
    await confirmReview(instance, value);
    await input(instance, '\r');
    await waitFor(() => value.snapshot.activeReview?.operationKind === 'catalogManagement');
    await confirmReview(instance, value);

    expect(executeIntent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'catalogManagement', action: 'publishApply', expectedPlanDigest: planDigest,
      remoteUrl, branch: 'catalog/release',
    }), expect.anything());
    expect(value.hasSessionDraft).toBe(false);
  });

  it('keeps source type selection separate from the automatic-check setting', async () => {
    const typeController = controller();
    await typeController.load();
    typeController.push({ name: 'sourceList' });
    const instance = render(<ConsoleAppV4 controller={typeController} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\u001B[B', '\r');
    const typeFrame = instance.lastFrame() ?? '';
    expect(typeFrame).toContain('Git 仓库');
    expect(typeFrame).toContain('本地目录');
    expect(typeFrame).not.toContain('关闭自动检查');
    instance.unmount();

    const captureEvidence = vi.fn(async (_intent: OperationIntent) => ({
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    }));
    const editController = controller({ captureEvidence });
    await editController.load();
    editController.push({ name: 'sourceEdit', sourceId: 'official' });
    const edit = render(<ConsoleAppV4 controller={editController} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await input(edit, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\u001B[B', '\r');
    expect(editController.snapshot.router.current.route.name).toBe('sourceSave');
    await input(edit, '\u001B[B', '\r');
    await waitFor(() => captureEvidence.mock.calls.length === 1);
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sourceMutation',
      action: 'update',
      sourceId: 'official',
      update: expect.objectContaining({ autoCheck: false }),
    }), expect.any(AbortSignal));
  });
});
