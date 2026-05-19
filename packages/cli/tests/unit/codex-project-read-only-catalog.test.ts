import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { preparePluginTargetsForCommand } from '../../src/commands/common.js';
import { createHistoricalPluginTarget } from '../../src/commands/common.js';
import { statusCommand } from '../../src/commands/status.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import { getCatalogFullPackageRoot } from '../../src/utils/bundle-layout.js';
import { upsertTrackingRecord } from '../../src/utils/tracking.js';
import { initializeLocalMarketplace } from '../../src/utils/local-marketplace.js';
import { resolveCurrentCatalog } from '../../src/utils/plugin-catalog.js';
import { getCodexProjectManagedKinds } from '../../src/utils/codex-project-surface.js';
import { resolveCodexPaths } from '../../src/utils/paths.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import {
  runWithZeroWriteSnapshot,
  writeDegradedInstalledLedger,
} from '../helpers/repo-managed-state.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'codex-project-repo-managed',
    ...segments,
  );
}

async function makeWorkspace(pluginDirs: string[] = ['mcp-only']): Promise<{
  root: string;
  repoRoot: string;
  awHome: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-project-read-only-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.ensureDir(path.join(repoRoot, 'plugins'));
  await fs.copy(
    fixturePath('plugins', 'marketplace-source.json'),
    path.join(repoRoot, 'plugins', 'marketplace-source.json'),
  );

  for (const pluginDir of pluginDirs) {
    await fs.copy(
      fixturePath('plugins', pluginDir),
      path.join(repoRoot, 'plugins', pluginDir),
    );
  }

  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

  const awHome = path.join(root, 'aw-home');
  return {
    root,
    repoRoot,
    awHome,
    embeddedRoot,
    env: {
      ...process.env,
      AW_HOME: awHome,
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      PATH: '',
    },
  };
}

async function writeStaleLocalMarketplaceConfig(awHome: string): Promise<void> {
  await fs.ensureDir(awHome);
  await fs.writeJson(
    path.join(awHome, 'config.json'),
    {
      version: 1,
      initializedAt: '2026-04-30T00:00:00.000Z',
      sourcePackage: '@yiliang/aw',
      sourceVersion: '0.1.0',
      bundleFingerprint: 'sha256:stale',
    },
    { spaces: 2 },
  );
}

async function writeAheadLocalMarketplaceConfig(
  env: NodeJS.ProcessEnv,
  awHome: string,
): Promise<void> {
  await initializeLocalMarketplace({ force: true, env });
  const configPath = path.join(awHome, 'config.json');
  const config = await fs.readJson(configPath);
  config.sourceVersion = '999.0.0';
  await fs.writeJson(configPath, config, { spaces: 2 });
}

async function breakLocalMarketplaceLayout(
  env: NodeJS.ProcessEnv,
  awHome: string,
): Promise<void> {
  await initializeLocalMarketplace({ force: true, env });
  await fs.remove(path.join(awHome, 'plugins', 'mcp-only', '.agents-plugin', 'plugin.json'));
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe.each([
  {
    label: 'install',
    allowHistoricalFallback: false,
  },
  {
    label: 'explicit upgrade',
    allowHistoricalFallback: true,
  },
] as const)('Codex project $label read-only target preparation', ({ allowHistoricalFallback }) => {
  it.each([
    {
      label: '~/.aw 缺失',
      setup: async (_workspace: { awHome: string; env: NodeJS.ProcessEnv }) => {},
      expectedCatalogSource: 'local',
    },
    {
      label: '~/.aw stale',
      setup: async (workspace: { awHome: string; env: NodeJS.ProcessEnv }) => {
        await writeStaleLocalMarketplaceConfig(workspace.awHome);
      },
      expectedCatalogSource: 'local',
    },
    {
      label: '~/.aw sourceVersion 领先',
      setup: async (workspace: { awHome: string; env: NodeJS.ProcessEnv }) => {
        await writeAheadLocalMarketplaceConfig(workspace.env, workspace.awHome);
      },
      expectedCatalogSource: 'local',
    },
    {
      label: '~/.aw 布局损坏',
      setup: async (workspace: { awHome: string; env: NodeJS.ProcessEnv }) => {
        await breakLocalMarketplaceLayout(workspace.env, workspace.awHome);
      },
      expectedCatalogSource: 'local',
    },
    {
      label: 'installed.json degraded',
      setup: async (workspace: { awHome: string; env: NodeJS.ProcessEnv }) => {
        await initializeLocalMarketplace({ force: true, env: workspace.env });
        await writeDegradedInstalledLedger({
          env: workspace.env,
          reason: 'rebuilt_from_missing_or_invalid',
        });
      },
    },
  ] as const)('does not create or repair shared runtime when $label', async ({ setup, expectedCatalogSource }) => {
    const workspace = await makeWorkspace(['mcp-only']);
    await setup(workspace);

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        async () => {
          const catalog = await resolveCurrentCatalog(workspace.env);
          if (expectedCatalogSource) {
            expect(catalog).toMatchObject({
              rootDir: getCatalogFullPackageRoot(workspace.embeddedRoot),
              source: expectedCatalogSource,
            });
          }

          const prepared = await preparePluginTargetsForCommand(
            workspace.repoRoot,
            'project',
            ['mcp-only'],
            {
              ensureLocalMarketplace: false,
              allowHistoricalFallback,
              env: workspace.env,
            },
          );

          expect(prepared.targets).toMatchObject([
            {
              pluginName: 'mcp-only',
              source: 'currentCatalog',
            },
          ]);
          if (!expectedCatalogSource) {
            expect(prepared.ledger.ledgerState.status).toBe('degraded');
          }
        },
      ),
    ).resolves.toBeUndefined();
  });
});

it('keeps Codex project upgrade --all read-only preflight zero-write when ledger is degraded', async () => {
  const workspace = await makeWorkspace(['mcp-only']);
  await initializeLocalMarketplace({ force: true, env: workspace.env });
  await writeDegradedInstalledLedger({
    env: workspace.env,
    reason: 'rebuilt_from_missing_or_invalid',
  });

  await expect(
    runWithZeroWriteSnapshot(
      {
        repoRoot: workspace.repoRoot,
        env: workspace.env,
      },
      () => upgradeCommand(
        [],
        {
          all: true,
          cwd: workspace.repoRoot,
          platform: 'codex',
          scope: 'project',
        },
        {
          env: workspace.env,
        },
      ),
    ),
  ).rejects.toThrow('installed.json 处于 degraded 状态');
});

it('exposes embedded catalog fallback diagnostics in status JSON without repairing ~/.aw', async () => {
  const workspace = await makeWorkspace(['mcp-only']);
  await writeAheadLocalMarketplaceConfig(workspace.env, workspace.awHome);

  await expect(
    runWithZeroWriteSnapshot(
      {
        repoRoot: workspace.repoRoot,
        env: workspace.env,
      },
      async () => {
        const result = await statusCommand(
          ['mcp-only'],
          {
            cwd: workspace.repoRoot,
            platform: 'codex',
            scope: 'project',
            verbose: true,
            json: true,
          },
          { env: workspace.env },
        );
        const payload = JSON.parse(result.output) as {
          reports: Array<{
            plugins: Array<{
              currentCatalog?: {
                source: string;
                reasonCode?: string;
              };
            }>;
          }>;
        };

        expect(payload.reports[0]?.plugins[0]?.currentCatalog).toMatchObject({
          source: 'local',
          available: true,
        });
      },
    ),
  ).resolves.toBeUndefined();
});

it('reconstructs historical codex.skill targets as project-managed skills without project config backing', async () => {
  const workspace = await makeWorkspace([]);
  const trackingDir = resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).trackingDir;
  await upsertTrackingRecord(trackingDir, 'codex-explore', [{
    path: path.join(workspace.repoRoot, '.agents', 'skills', 'codex-explore'),
    kind: 'skill',
    platform: 'codex',
    artifactKey: 'codex-explore',
    id: 'codex-explore-skill',
    target: 'codex.skill',
    state: 'present',
    refreshKeys: ['explorerModel', 'modelReasoningEffort'],
  }]);

  const target = await createHistoricalPluginTarget(
    workspace.repoRoot,
    'project',
    'codex-explore',
    undefined,
    workspace.env,
  );

  expect(target.plugin.manifest.artifacts?.targets).toMatchObject([
    {
      id: 'codex-explore-skill',
      target: 'codex.skill',
      kind: 'skill',
      projectManagedKind: 'skill',
      skillKey: 'codex-explore',
      requiresCodexProjectConfig: false,
    },
  ]);
  expect(getCodexProjectManagedKinds(target.plugin)).toEqual(['skill']);
});
