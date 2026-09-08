import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  catalogPublicationJournalPath,
  catalogPublicationRepositoryPath,
} from '../../src/commands/catalog-publication-journal.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { runCli } from '../../src/index.js';
import {
  createCatalogManagementService,
  type CatalogManagementIntent,
  type CatalogManagementService,
} from '../../src/tui/catalog-management.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);

function quietIo() {
  return { stdout: () => undefined, stderr: () => undefined };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const isolation = getCurrentSourceTestIsolation();
  return (await execFileAsync('git', args, { cwd, env: isolation.env })).stdout.trim();
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ['add', '--all']);
  await git(root, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', message,
  ]);
}

async function createWorkspace(version = '1.0.0'): Promise<string> {
  const isolation = getCurrentSourceTestIsolation();
  const root = path.join(isolation.layout.fixtureCwd, `catalog-workspace-${version.replaceAll('.', '-')}`);
  await fs.ensureDir(root);
  await git(root, ['init', '--quiet']);
  expect(await runCli([
    'catalog', 'init', '--workspace-root', root, '--catalog-version', version,
    '--owner-url', 'https://catalog.example.com/tui-catalog-test',
  ], { cwd: root, env: isolation.env, io: quietIo() })).toBe(0);
  expect(await runCli([
    'plugin', 'init', 'demo', '--description', 'TUI Catalog fixture.', '--no-skills',
    '--workspace-root', root,
  ], { cwd: root, env: isolation.env, io: quietIo() })).toBe(0);
  await commitAll(root, 'initial workspace');
  return root;
}

function service(cwd: string): CatalogManagementService {
  const isolation = getCurrentSourceTestIsolation();
  return createCatalogManagementService(createCliExecutionContext({
    cwd,
    env: isolation.env,
    interactive: false,
  }));
}

async function executeReviewed(
  catalog: CatalogManagementService,
  intent: CatalogManagementIntent,
) {
  const evidence = await catalog.captureEvidence(intent);
  return catalog.execute(intent, evidence);
}

async function buildWorkspace(catalog: CatalogManagementService): Promise<void> {
  await expect(executeReviewed(catalog, {
    kind: 'catalogManagement', action: 'workspaceBuild', force: true,
  })).resolves.toMatchObject({ state: 'succeeded' });
}

async function setTreeTime(root: string, date: Date): Promise<void> {
  const stat = await fs.lstat(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const child of await fs.readdir(root)) await setTreeTime(path.join(root, child), date);
  }
  await fs.utimes(root, date, date);
}

describe('TUI Catalog management backend', { timeout: 30_000 }, () => {
  it('reports a missing Workspace while the independent store remains readable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const catalog = service(isolation.layout.fixtureCwd);

    await expect(catalog.getWorkspace()).resolves.toMatchObject({
      state: 'missing', selected: false, identity: null,
    });
    await expect(catalog.getStore()).resolves.toMatchObject({
      state: 'ready', entries: [],
      totals: { entries: 0, reclaimableEntries: 0, retainedEntries: 0 },
    });
  });

  it('selects a Workspace, changes its version, builds it, and validates the snapshot', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = await createWorkspace();
    const catalog = service(isolation.layout.fixtureCwd);

    await expect(catalog.selectWorkspace(root)).resolves.toMatchObject({
      state: 'ready', selected: true,
      catalog: { version: '1.0.0', channel: 'latest' },
      snapshot: { state: 'absent', valid: false },
      git: { checked: true, clean: true, hasHead: true },
    });
    await expect(executeReviewed(catalog, {
      kind: 'catalogManagement', action: 'workspaceVersion', version: '1.1.0',
    })).resolves.toMatchObject({ state: 'succeeded', catalogVersion: '1.1.0' });
    await buildWorkspace(catalog);

    await expect(catalog.getWorkspace()).resolves.toMatchObject({
      state: 'ready', catalog: { version: '1.1.0' },
      plugins: [{ name: 'demo', version: expect.any(String), dependencies: [] }],
      dependencyGraphValid: true,
      snapshot: { state: 'current', valid: true, catalogVersion: '1.1.0', hasDigest: true },
    });
    await expect(catalog.validateWorkspace()).resolves.toMatchObject({
      state: 'valid', catalogVersion: '1.1.0', channel: 'latest',
      hasSnapshotDigest: true, issues: [],
    });
  });

  it('makes a dirty stale Workspace build Review stale when source content changes again', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = await createWorkspace();
    const catalog = service(isolation.layout.fixtureCwd);
    await catalog.selectWorkspace(root);
    await buildWorkspace(catalog);
    const readme = path.join(root, 'plugins', 'demo', 'README.md');
    await fs.writeFile(readme, 'first dirty source\n');
    const intent = { kind: 'catalogManagement' as const, action: 'workspaceBuild' as const, force: true };
    const evidence = await catalog.captureEvidence(intent);
    await fs.writeFile(readme, 'second dirty source\n');

    await expect(catalog.execute(intent, evidence)).rejects.toMatchObject({
      code: 'operationReviewStale',
    });
  });

  it('activates, reports, and deactivates a development source in isolated AW_HOME', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = await createWorkspace();
    const catalog = service(isolation.layout.fixtureCwd);
    await catalog.selectWorkspace(root);
    await buildWorkspace(catalog);

    await expect(catalog.getDev()).resolves.toMatchObject({
      state: 'inactive', ready: false, source: { exists: false }, active: { exists: false },
    });
    await expect(executeReviewed(catalog, {
      kind: 'catalogManagement', action: 'devActivate', sourceId: 'tui-dev',
    })).resolves.toMatchObject({ state: 'succeeded' });
    await expect(catalog.getDev()).resolves.toMatchObject({
      state: 'ready', ready: true,
      snapshot: { state: 'current', valid: true, hasDigest: true },
      source: { exists: true, id: 'tui-dev', pathMatches: true },
      active: { exists: true, ready: true, digestMatchesSnapshot: true, compatibility: 'supported' },
    });

    const deactivateIntent = {
      kind: 'catalogManagement' as const, action: 'devDeactivate' as const,
    };
    const deactivationEvidence = await catalog.captureEvidence(deactivateIntent);
    expect(deactivationEvidence.devImpact).toMatchObject({
      inventoryComplete: true,
      primaryChange: false,
      references: { installation: 0, config: 0, lifecycle: 0, marketplace: 0 },
    });
    await expect(catalog.execute(deactivateIntent, deactivationEvidence))
      .resolves.toMatchObject({ state: 'succeeded' });
    await expect(catalog.getDev()).resolves.toMatchObject({
      state: 'inactive', ready: false, source: { exists: false }, active: { exists: false },
    });
    expect(isolation.env.AW_HOME).toBeTruthy();
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'catalog-store'))).resolves.toBe(true);
  });

  it('refreshes the main Controller source list after dev activation and deactivation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = await createWorkspace();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const controller = new TuiController(dependencies);
    await controller.load();
    await controller.selectCatalogWorkspace(root);
    await buildWorkspace(dependencies.catalogManagement!);

    const activate = await controller.buildOperationReview({
      kind: 'catalogManagement', action: 'devActivate', sourceId: 'tui-dev',
    });
    await expect(controller.executeOperation(activate.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(controller.listSources().some((source) => source.id === 'tui-dev')).toBe(true);

    const deactivate = await controller.buildOperationReview({
      kind: 'catalogManagement', action: 'devDeactivate',
    });
    await expect(controller.executeOperation(deactivate.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(controller.listSources().some((source) => source.id === 'tui-dev')).toBe(false);
    controller.dispose();
  });

  it('binds and applies the primary-source change during dev activation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = await createWorkspace();
    const catalog = service(isolation.layout.fixtureCwd);
    await catalog.selectWorkspace(root);
    await buildWorkspace(catalog);
    const intent = {
      kind: 'catalogManagement' as const,
      action: 'devActivate' as const,
      sourceId: 'tui-primary-dev',
      primary: true,
    };
    const evidence = await catalog.captureEvidence(intent);
    expect(evidence.devActivation?.primaryChange).toBe(true);
    await expect(catalog.execute(intent, evidence)).resolves.toMatchObject({ state: 'succeeded' });
    await expect(catalog.getDev()).resolves.toMatchObject({
      state: 'ready', source: { id: 'tui-primary-dev', primary: true },
    });
  });

  it.each(['absent', 'stale'] as const)(
    'rejects dev activation Review for a %s snapshot without building output',
    async (snapshotState) => {
      const isolation = getCurrentSourceTestIsolation();
      const root = await createWorkspace();
      const catalog = service(isolation.layout.fixtureCwd);
      await catalog.selectWorkspace(root);
      const outputRoot = path.join(root, '.aw', 'catalog');
      if (snapshotState === 'stale') {
        await buildWorkspace(catalog);
        await fs.writeFile(path.join(root, 'plugins', 'demo', 'README.md'), 'stale source\n');
      }
      const outputBefore = await fs.pathExists(outputRoot)
        ? await fs.readJson(path.join(outputRoot, '.aw-generated.json'))
        : null;

      await expect(catalog.captureEvidence({
        kind: 'catalogManagement', action: 'devActivate', sourceId: 'tui-dev',
      })).rejects.toMatchObject({ code: expect.any(String) });
      expect(await fs.pathExists(outputRoot)).toBe(snapshotState === 'stale');
      if (outputBefore !== null) {
        await expect(fs.readJson(path.join(outputRoot, '.aw-generated.json')))
          .resolves.toEqual(outputBefore);
      }
    },
  );

  it('binds safe activation evidence, shows impact counts, and blocks source config drift', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = await createWorkspace();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const controller = new TuiController(dependencies);
    await controller.selectCatalogWorkspace(root);
    await buildWorkspace(dependencies.catalogManagement!);
    const intent = {
      kind: 'catalogManagement' as const, action: 'devActivate' as const, sourceId: 'tui-dev',
    };

    const evidence = await dependencies.catalogManagement!.captureEvidence(intent);
    expect(evidence).toMatchObject({
      devActivation: {
        evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        sourceId: 'tui-dev', catalogVersion: '1.0.0', inventoryComplete: true,
        primaryChange: false,
        references: { installation: 0, config: 0, lifecycle: 0, marketplace: 0 },
        changes: {
          added: expect.any(Number), removed: 0, changed: 0, newlyIncompatible: 0,
          dependencyChanged: 0, platformSupportChanged: 0,
        },
      },
    });
    expect(JSON.stringify(evidence)).not.toContain(root);
    const review = await controller.buildOperationReview(intent);
    expect(review.changes).toContainEqual(expect.objectContaining({
      title: '已检查现有来源引用', description: '0 个引用',
    }));

    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          ...current.config.sources,
          { id: 'parallel-change', type: 'path', path: path.join(root, '.aw', 'catalog'), primary: false },
        ],
      },
      expectedDigest: current.digest,
      env: isolation.env,
    });
    const result = await controller.executeOperation(review.reviewToken);
    expect(['stale', 'blocked']).toContain(result.state);
    if (result.state === 'blocked') expect(result.code).toBe('operationReviewStale');
    controller.dispose();
  });

  it('blocks dev activation when Active changes after Review', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = await createWorkspace();
    const competing = service(isolation.layout.fixtureCwd);
    await competing.selectWorkspace(root);
    await buildWorkspace(competing);
    await executeReviewed(competing, {
      kind: 'catalogManagement', action: 'devActivate', sourceId: 'tui-dev',
    });
    await fs.writeFile(path.join(root, 'plugins', 'demo', 'README.md'), 'new candidate\n');
    await buildWorkspace(competing);

    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const controller = new TuiController(dependencies);
    await controller.selectCatalogWorkspace(root);
    const intent = {
      kind: 'catalogManagement' as const, action: 'devActivate' as const, sourceId: 'tui-dev',
    };
    const review = await controller.buildOperationReview(intent);

    await executeReviewed(competing, intent);
    const result = await controller.executeOperation(review.reviewToken);
    expect(['stale', 'blocked']).toContain(result.state);
    if (result.state === 'blocked') expect(result.code).toBe('operationReviewStale');
    controller.dispose();
  });

  it('deletes only the reclaimable store item confirmed by Review', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = await createWorkspace();
    const catalog = service(isolation.layout.fixtureCwd);
    await catalog.selectWorkspace(root);
    await buildWorkspace(catalog);
    await executeReviewed(catalog, {
      kind: 'catalogManagement', action: 'devActivate', sourceId: 'tui-dev',
    });

    for (const content of ['second\n', 'third\n']) {
      await fs.writeFile(path.join(root, 'plugins', 'demo', 'README.md'), content);
      await buildWorkspace(catalog);
      await executeReviewed(catalog, {
        kind: 'catalogManagement', action: 'devActivate', sourceId: 'tui-dev',
      });
    }
    const beforeAging = await catalog.getStore();
    const inactive = beforeAging.entries.filter((entry) =>
      entry.category === 'entry' && entry.status !== 'active');
    expect(inactive).toHaveLength(2);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    for (const entry of inactive) {
      await setTreeTime(path.join(isolation.env.AW_HOME!, 'catalog-store', entry.item.storeKey), old);
    }
    const reclaimable = (await catalog.getStore()).entries.filter((entry) =>
      entry.category === 'entry' && entry.status === 'reclaimable');
    expect(reclaimable).toHaveLength(2);
    const selected = reclaimable[0]!;
    const retained = reclaimable[1]!;

    await expect(executeReviewed(catalog, {
      kind: 'catalogManagement', action: 'storePrune', items: [selected.item],
    })).resolves.toMatchObject({
      state: 'succeeded', store: { deletedEntries: 1 },
    });
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'catalog-store', selected.item.storeKey),
    )).resolves.toBe(false);
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'catalog-store', retained.item.storeKey),
    )).resolves.toBe(true);
  });
});

describe('TUI Catalog publication backend', { timeout: 30_000 }, () => {
  it('writes a plan only after controller Review execution and applies that plan after source changes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const root = await createWorkspace();
    const remote = path.join(isolation.layout.fixtureCwd, 'catalog-remote.git');
    await fs.ensureDir(remote);
    await git(remote, ['init', '--bare', '--quiet']);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const controller = new TuiController(dependencies);
    await controller.selectCatalogWorkspace(root);

    const planIntent = {
      kind: 'catalogManagement' as const,
      action: 'publishPlan' as const,
      remoteUrl: remote,
      branch: 'catalog/latest',
    };
    const planReview = await controller.buildOperationReview(planIntent);
    const publishRoot = path.join(root, '.aw', 'publish');
    await expect(fs.pathExists(publishRoot)).resolves.toBe(false);

    const planned = await controller.executeOperation(planReview.reviewToken);
    expect(planned).toMatchObject({
      state: 'succeeded',
      summary: {
        catalogManagement: {
          action: 'publishPlan', state: 'succeeded', catalogVersion: '1.0.0',
          planDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      },
    });
    const planDigest = planned.state === 'succeeded'
      ? planned.summary?.catalogManagement?.planDigest
      : undefined;
    expect(planDigest).toBeDefined();
    await expect(fs.pathExists(catalogPublicationJournalPath(root, '1.0.0'))).resolves.toBe(true);
    await expect(fs.pathExists(catalogPublicationRepositoryPath(root, '1.0.0'))).resolves.toBe(true);
    let targetRequired: unknown;
    try {
      await controller.buildOperationReview({
        kind: 'catalogManagement', action: 'publishApply', expectedPlanDigest: planDigest!,
        branch: 'catalog/latest',
      });
    } catch (error) {
      targetRequired = error;
    }
    expect(targetRequired).toMatchObject({ code: 'catalogPublicationTargetRequired' });
    expect(String((targetRequired as Error).message)).not.toContain(remote);

    const otherRemote = path.join(isolation.layout.fixtureCwd, 'other-catalog-remote.git');
    await fs.ensureDir(otherRemote);
    await git(otherRemote, ['init', '--bare', '--quiet']);
    await expect(controller.buildOperationReview({
      kind: 'catalogManagement', action: 'publishApply', expectedPlanDigest: planDigest!,
      remoteUrl: otherRemote, branch: 'catalog/latest',
    })).rejects.toMatchObject({ code: 'catalogPublicationTargetMismatch' });

    const metadataPath = path.join(root, 'plugins', 'marketplace-source.json');
    const metadata = await fs.readJson(metadataPath) as Record<string, unknown>;
    await fs.writeJson(metadataPath, {
      ...metadata,
      catalog: { ...(metadata.catalog as Record<string, unknown>), version: '1.0.1' },
    }, { spaces: 2 });
    await commitAll(root, 'change source after publication review');

    const applyReview = await controller.buildOperationReview({
      kind: 'catalogManagement', action: 'publishApply',
      expectedPlanDigest: planDigest!, remoteUrl: remote, branch: 'catalog/latest',
    });
    const applied = await controller.executeOperation(applyReview.reviewToken);
    expect(applied).toMatchObject({
      state: 'succeeded',
      summary: { catalogManagement: {
        action: 'publishApply', state: 'succeeded', planDigest,
        publication: { state: 'published', planDigest },
      } },
    });
    const journal = await fs.readJson(catalogPublicationJournalPath(root, '1.0.0')) as {
      expectedCommit: string;
    };
    expect(await git(remote, ['rev-parse', 'refs/heads/catalog/latest']))
      .toBe(journal.expectedCommit);
    await expect(controller.getCatalogPublicationManagement()).resolves.toMatchObject({
      state: 'published', records: [{
        catalogVersion: '1.0.0', state: 'published', canApply: true,
        mustIncreaseVersion: false, localRepositoryState: 'notRequired',
      }],
    });
    controller.dispose();
  });

  it.each(['prepared', 'uncertain'] as const)(
    'projects a %s journal without its isolated repository as damaged',
    async (state) => {
      const isolation = getCurrentSourceTestIsolation();
      const root = await createWorkspace();
      const remote = path.join(isolation.layout.fixtureCwd, `catalog-${state}-remote.git`);
      await fs.ensureDir(remote);
      await git(remote, ['init', '--bare', '--quiet']);
      const catalog = service(isolation.layout.fixtureCwd);
      await catalog.selectWorkspace(root);
      const result = await executeReviewed(catalog, {
        kind: 'catalogManagement', action: 'publishPlan',
        remoteUrl: remote, branch: 'catalog/latest',
      });
      const journalPath = catalogPublicationJournalPath(root, '1.0.0');
      if (state === 'uncertain') {
        const journal = await fs.readJson(journalPath) as Record<string, unknown>;
        await fs.writeJson(journalPath, {
          ...journal, state, uncertainAt: new Date().toISOString(),
        }, { spaces: 2 });
      }
      await fs.remove(catalogPublicationRepositoryPath(root, '1.0.0'));

      expect(result.planDigest).toMatch(/^sha256:/u);
      await expect(catalog.getPublication()).resolves.toMatchObject({
        state: 'needsAttention',
        records: [{
          catalogVersion: '1.0.0', state: 'damaged', canApply: false,
          mustIncreaseVersion: true, localRepositoryState: 'absent',
        }],
        issues: [{ code: 'catalogPublicationStateDamaged', blocking: true }],
      });
    },
  );
});
