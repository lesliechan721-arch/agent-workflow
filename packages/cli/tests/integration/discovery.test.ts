import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCommandCandidates,
  discoverManagedPluginNames,
} from '../../src/commands/discovery.js';
import type { InstalledLedger } from '../../src/types.js';
import {
  createAvailableLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import {
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { upsertCodexPluginEnabledFile } from '../../src/utils/codex-config.js';
import { getTrackingManifestPath, upsertTrackingRecord } from '../../src/utils/tracking.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{
  repoRoot: string;
  awHome: string;
  codexHome: string;
  claudeHome: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-discovery-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await fs.ensureDir(path.join(repoRoot, '.git'));
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

  const env = {
    ...process.env,
    AW_HOME: path.join(root, 'aw-home'),
    AW_CODEX_HOME: path.join(root, 'codex-home'),
    AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    AW_FORCE_CODEX_AVAILABLE: '1',
    PATH: '',
  } as NodeJS.ProcessEnv;

  return {
    repoRoot,
    awHome: env.AW_HOME!,
    codexHome: env.AW_CODEX_HOME!,
    claudeHome: env.AW_CLAUDE_HOME!,
    env,
  };
}

function scopeRecord(capabilitySnapshot: Record<string, unknown>) {
  return {
    managed: true,
    updatedAt: '2026-04-25T00:00:00.000Z',
    resolvedVersion: '0.1.0',
    capabilitySnapshot,
  };
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});
describe('managed plugin discovery', () => {
  it('lists current-catalog-missing plugins from project ledger evidence without inventing user evidence', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const codexProjectKey = await resolveCodexProjectKey(repoRoot);
    const ledger: InstalledLedger = {
      ...createAvailableLedger(),
      plugins: {
        'legacy-plugin': {
          lastResolvedVersion: '0.1.0',
          platforms: {
            codex: {
              projectScopes: {
                [codexProjectKey]: scopeRecord({
                  requiresNativePlugin: false,
                  hasRepoManagedArtifacts: false,
                }),
              },
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, env);

    const candidates = await buildCommandCandidates({
      command: 'status',
      cwd: repoRoot,
      platformFilter: 'codex',
      pluginNames: ['legacy-plugin'],
      env,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      pluginName: 'legacy-plugin',
      platform: 'codex',
      scope: 'project',
      projectKey: codexProjectKey,
      selectable: true,
    });
    expect(candidates[0].target.source).toBe('historical');
  });

  it('anchors Codex project tracking evidence to the repo root when discovery runs from a subdirectory', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const subdir = path.join(repoRoot, 'packages', 'feature');
    await fs.ensureDir(subdir);
    const codexProjectKey = await resolveCodexProjectKey(subdir);
    const codexPaths = resolveCodexPaths(subdir, 'project', env);
    await upsertTrackingRecord(codexPaths.trackingDir, 'tracked-only', [
      {
        path: path.join(codexPaths.rulesDir, 'tracked-only.rules'),
        kind: 'hook',
        platform: 'codex',
        hookGroups: [
          {
            event: 'PreToolUse',
            matcher: 'Bash',
            command: 'echo tracked',
          },
        ],
      },
    ]);

    const candidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: subdir,
      scopeFilter: 'project',
      platformFilter: 'codex',
      pluginNames: ['tracked-only'],
      env,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      platform: 'codex',
      scope: 'project',
      projectKey: codexProjectKey,
      executionCwd: await fs.realpath(repoRoot),
      selectable: true,
    });
    expect(candidates[0].target.plugin.manifest.extensions?.hooks).toHaveLength(1);
  });

  it('keeps Claude project discovery scoped to the invocation directory realpath', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const subdir = path.join(repoRoot, 'packages', 'feature');
    await fs.ensureDir(subdir);
    await upsertTrackingRecord(
      resolveClaudePaths(repoRoot, 'project', env).trackingDir,
      'root-only',
      [{
        path: path.join(repoRoot, '.claude', 'root-only.md'),
        kind: 'instruction',
        platform: 'claude',
      }],
    );
    await upsertTrackingRecord(
      resolveClaudePaths(subdir, 'project', env).trackingDir,
      'subdir-only',
      [{
        path: path.join(subdir, '.claude', 'subdir-only.md'),
        kind: 'instruction',
        platform: 'claude',
      }],
    );

    const rootOnly = await discoverManagedPluginNames({
      cwd: subdir,
      scopeFilter: 'project',
      platformFilter: 'claude',
      pluginNames: ['root-only'],
      includeCurrentCatalog: false,
      env,
    });
    const subdirOnly = await discoverManagedPluginNames({
      cwd: subdir,
      scopeFilter: 'project',
      platformFilter: 'claude',
      pluginNames: ['subdir-only'],
      includeCurrentCatalog: false,
      env,
    });

    expect(Object.keys(rootOnly[0].evidenceByPlatformScope)).toEqual([]);
    const evidence = Object.values(subdirOnly[0].evidenceByPlatformScope)[0];
    expect(evidence).toMatchObject({
      platform: 'claude',
      scope: 'project',
      projectKey: await resolveClaudeProjectKey(subdir),
    });
  });

  it('does not turn Codex ledger-only coarse repo-managed booleans into concrete historical capabilities', async () => {
    const { repoRoot, env } = await makeWorkspace();
    await writeInstalledLedger(
      {
        ...createAvailableLedger(),
        plugins: {
          'repo-only-history': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: scopeRecord({
                  requiresNativePlugin: false,
                  hasRepoManagedArtifacts: true,
                }),
              },
            },
          },
        },
      },
      env,
    );

    const candidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['repo-only-history'],
      env,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].selectable).toBe(false);
    expect(candidates[0].disabledReason).toContain('粗粒度 repo-managed 标记');
    expect(candidates[0].target.plugin.manifest.extensions).toBeUndefined();
  });

  it('discovers Codex native config evidence even when ledger and tracking are absent', async () => {
    const { repoRoot, env } = await makeWorkspace();
    await upsertCodexPluginEnabledFile(
      resolveCodexPaths(repoRoot, 'user', env).configTomlPath,
      'native-only@aw',
      { enabled: true },
    );

    const candidates = await buildCommandCandidates({
      command: 'status',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['native-only'],
      env,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      pluginName: 'native-only',
      platform: 'codex',
      scope: 'user',
      selectable: true,
    });
    expect(candidates[0].evidence.sources).toContain('codexNativeConfig');
    expect(candidates[0].target.plugin.manifest.skills).toBe('./historical-skills');
  });

  it('keeps requested status targets as unknown candidates when tracking cannot be read', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const codexPaths = resolveCodexPaths(repoRoot, 'user', env);
    await fs.outputFile(getTrackingManifestPath(codexPaths.trackingDir), '{broken json');

    const statusCandidates = await buildCommandCandidates({
      command: 'status',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['legacy-plugin'],
      env,
    });
    const uninstallCandidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['legacy-plugin'],
      env,
    });

    expect(statusCandidates).toHaveLength(1);
    expect(statusCandidates[0].target.source).toBe('historical');
    expect(statusCandidates[0].evidence.readErrors.join('\n')).toContain('tracking manifest');
    expect(uninstallCandidates).toHaveLength(1);
    expect(uninstallCandidates[0].selectable).toBe(false);
    expect(uninstallCandidates[0].disabledReason).toContain('读取失败');
  });

  it('records Codex native config read failures on requested candidates', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const codexPaths = resolveCodexPaths(repoRoot, 'user', env);
    await fs.outputFile(codexPaths.configTomlPath, '[plugins."git-commit@aw"\nenabled = true\n');

    const candidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['git-commit'],
      env,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.readErrors.join('\n')).toContain('Codex config');
    expect(candidates[0].selectable).toBe(false);
    expect(candidates[0].disabledReason).toContain('读取失败');
  });

  it('records Claude runtime read failures on requested candidates', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const claudePaths = resolveClaudePaths(repoRoot, 'user', env);
    await fs.outputFile(claudePaths.settingsPath, '{broken json');
    await fs.outputFile(claudePaths.installedPluginsPath, '{also broken');

    const candidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'claude',
      pluginNames: ['git-commit'],
      env,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.readErrors.join('\n')).toContain('Claude settings');
    expect(candidates[0].evidence.readErrors.join('\n')).toContain('Claude installed plugins');
    expect(candidates[0].selectable).toBe(false);
    expect(candidates[0].disabledReason).toContain('读取失败');
  });
});
