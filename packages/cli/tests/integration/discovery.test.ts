import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildCommandCandidates,
  discoverManagedPluginNames,
} from '../../src/commands/discovery.js';
import { statusCommand } from '../../src/commands/status.js';
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
import { writeCodexNativeRecoveryBreadcrumb } from '../../src/utils/codex-native-recovery.js';
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

async function writeCodexActiveCache(
  env: NodeJS.ProcessEnv,
  pluginName: string,
  version = '0.1.0',
): Promise<string> {
  const versionPath = path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName, version);
  await fs.outputFile(path.join(versionPath, 'plugin.json'), '{}\n', 'utf8');
  return versionPath;
}

function resolveCodexCacheVersionPath(
  env: NodeJS.ProcessEnv,
  pluginName: string,
  version = '0.1.0',
): string {
  return path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName, version);
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

  it('builds historical Codex repo skill and MCP targets from tracking when the current catalog is missing', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const codexProjectKey = await resolveCodexProjectKey(repoRoot);
    const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
    await upsertTrackingRecord(codexPaths.trackingDir, 'repo-history', [
      {
        path: path.join(repoRoot, '.agents', 'skills', 'commit'),
        kind: 'skill',
        platform: 'codex',
        artifactKey: 'commit',
      },
      {
        path: path.join(repoRoot, '.codex', 'config.toml'),
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: 'acme.tools v1',
      },
    ]);

    const candidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'project',
      platformFilter: 'codex',
      pluginNames: ['repo-history'],
      env,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      pluginName: 'repo-history',
      platform: 'codex',
      scope: 'project',
      projectKey: codexProjectKey,
      selectable: true,
    });
    expect(candidates[0].evidence.trackingKinds).toEqual(['skill', 'mcpServer']);
    expect(candidates[0].target.source).toBe('historical');
    expect(candidates[0].target.plugin.manifest.skills).toBe('./historical-skills');
    expect(candidates[0].target.plugin.manifest.mcpServers).toBe('./historical-mcp.json');
    expect(candidates[0].target.plugin.manifest.extensions).toBeUndefined();
  });

  it('reuses artifact-aware historical fallback for Codex dynamic uninstall candidates', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
    const rolePath = path.join(codexPaths.configDir, 'agents', 'aw-history-role.toml');
    await upsertTrackingRecord(codexPaths.trackingDir, 'dynamic-history', [
      {
        path: codexPaths.configTomlPath,
        paths: [codexPaths.configTomlPath],
        kind: 'instruction',
        platform: 'codex',
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        state: 'disabled',
        disabledReason: 'config',
        refreshKeys: ['enableLightweightInstruction'],
      },
      {
        path: rolePath,
        paths: [codexPaths.configTomlPath, rolePath],
        kind: 'agent',
        platform: 'codex',
        artifactKey: 'codex-explorer',
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        state: 'present',
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      },
    ]);

    const candidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'project',
      platformFilter: 'codex',
      pluginNames: ['dynamic-history'],
      env,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].target.source).toBe('historical');
    expect(candidates[0].target.historicalArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        paths: [codexPaths.configTomlPath],
        state: 'disabled',
      }),
      expect.objectContaining({
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        paths: [codexPaths.configTomlPath, rolePath],
        roleKey: 'codex-explorer',
        artifactKey: 'codex-explorer',
        state: 'present',
      }),
    ]));
    expect(candidates[0].target.plugin.manifest.extensions?.agents).toBeUndefined();
    expect(candidates[0].target.plugin.manifest.artifacts?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        scopes: ['project'],
        states: ['disabled'],
      }),
      expect.objectContaining({
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        roleKey: 'codex-explorer',
        scopes: ['project'],
      }),
    ]));
  });

  it('marks historical Codex dynamic role identities as unavailable when tracking cannot recover the real roleKey', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
    const rolePath = path.join(codexPaths.configDir, 'agents', 'aw-history-role.toml');
    await upsertTrackingRecord(codexPaths.trackingDir, 'dynamic-history-broken', [
      {
        path: rolePath,
        paths: [codexPaths.configTomlPath, rolePath],
        kind: 'agent',
        platform: 'codex',
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        state: 'present',
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      },
    ]);

    const [uninstallCandidate] = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'project',
      platformFilter: 'codex',
      pluginNames: ['dynamic-history-broken'],
      env,
    });
    const [upgradeCandidate] = await buildCommandCandidates({
      command: 'upgrade',
      cwd: repoRoot,
      scopeFilter: 'project',
      platformFilter: 'codex',
      pluginNames: ['dynamic-history-broken'],
      env,
    });

    expect(uninstallCandidate.selectable).toBe(false);
    expect(uninstallCandidate.disabledReason).toContain('无法恢复 codex.agentRole 的真实 roleKey');
    expect(upgradeCandidate.selectable).toBe(false);
    expect(upgradeCandidate.disabledReason).toContain('无法恢复 codex.agentRole 的真实 roleKey');

    const result = await statusCommand(
      ['dynamic-history-broken'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env,
      },
    );
    const roleArtifact = result.reports[0]?.plugins[0]?.managedArtifacts?.find((artifact) =>
      artifact.id === 'codex-explorer-role');

    expect(roleArtifact).toMatchObject({
      target: 'codex.agentRole',
      health: 'unavailable',
      sessionVisibility: 'absent',
    });
    expect(roleArtifact?.diagnostics[0]).toContain('无法从 tracking 或静态 metadata 恢复');
  });

  it('marks historical Codex repo skill targets with missing artifactKey as non-selectable for uninstall', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const codexProjectKey = await resolveCodexProjectKey(repoRoot);
    const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
    await fs.outputJson(
      getTrackingManifestPath(codexPaths.trackingDir),
      {
        version: 1,
        plugins: {
          'repo-history-broken': {
            name: 'repo-history-broken',
            generatedAt: '2026-04-30T00:00:00.000Z',
            artifacts: [
              {
                path: path.join(repoRoot, '.agents', 'skills', 'commit'),
                kind: 'skill',
                platform: 'codex',
              },
            ],
          },
        },
      },
      { spaces: 2 },
    );

    const candidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'project',
      platformFilter: 'codex',
      pluginNames: ['repo-history-broken'],
      env,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      pluginName: 'repo-history-broken',
      platform: 'codex',
      scope: 'project',
      projectKey: codexProjectKey,
      selectable: false,
    });
    expect(candidates[0].disabledReason).toContain('缺少 artifactKey');
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

  it('discovers cache-only Codex native evidence, but keeps uninstall non-selectable without ownership proof', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const activeCachePath = await writeCodexActiveCache(env, 'cache-only');

    const statusCandidates = await buildCommandCandidates({
      command: 'status',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['cache-only'],
      env,
    });
    const uninstallCandidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['cache-only'],
      env,
    });

    expect(statusCandidates).toHaveLength(1);
    expect(statusCandidates[0].evidence.sources).toContain('codexNativeCache');
    expect(statusCandidates[0].target.plugin.manifest.skills).toBe('./historical-skills');

    expect(uninstallCandidates).toHaveLength(1);
    expect(uninstallCandidates[0].selectable).toBe(false);
    expect(uninstallCandidates[0].disabledReason).toContain('Codex cache 残留');

    const status = await statusCommand(
      ['cache-only'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
      { env },
    );
    const payload = JSON.parse(status.output) as {
      cells: Array<{ health: string }>;
      reports: Array<{
        plugins: Array<{
          native: {
            pluginInstalled: boolean;
            pluginEnabled?: boolean;
            activeCachePath?: string;
            recovery: {
              present: boolean;
              state: string | null;
              reason: string | null;
              evidenceMatches: boolean | null;
              suggestion: string | null;
            };
          };
        }>;
      }>;
    };

    expect(payload.cells[0]?.health).toBe('needsAttention');
    expect(payload.reports[0]?.plugins[0]?.native).toMatchObject({
      pluginInstalled: true,
      pluginEnabled: false,
      activeCachePath,
      recovery: {
        present: false,
        state: null,
        reason: null,
        evidenceMatches: null,
        suggestion: null,
      },
    });
  });

  it('discovers ambiguous and invalid Codex cache residues as diagnostics only', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const firstPath = await writeCodexActiveCache(env, 'multi-version', '0.1.0');
    const secondPath = await writeCodexActiveCache(env, 'multi-version', '0.2.0');
    const invalidVersionPath = resolveCodexCacheVersionPath(env, 'invalid-cache', '0.1.0');
    const ignoredEntryPath = resolveCodexCacheVersionPath(env, 'file-entry', '0.1.0');
    await fs.ensureDir(invalidVersionPath);
    await fs.outputFile(ignoredEntryPath, 'not a directory\n', 'utf8');

    const statusCandidates = await buildCommandCandidates({
      command: 'status',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['multi-version', 'invalid-cache', 'file-entry'],
      env,
    });
    const uninstallCandidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['multi-version', 'invalid-cache', 'file-entry'],
      env,
    });

    expect(statusCandidates.map((candidate) => candidate.pluginName).sort()).toEqual([
      'file-entry',
      'invalid-cache',
      'multi-version',
    ]);
    expect(statusCandidates.every((candidate) => candidate.evidence.sources.includes('codexNativeCache'))).toBe(true);
    expect(uninstallCandidates).toHaveLength(3);
    expect(uninstallCandidates.every((candidate) => candidate.selectable === false)).toBe(true);
    expect(uninstallCandidates.every((candidate) => candidate.disabledReason?.includes('Codex cache 残留'))).toBe(true);

    const status = await statusCommand(
      ['multi-version', 'invalid-cache', 'file-entry'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
      { env },
    );
    const payload = JSON.parse(status.output) as {
      cells: Array<{ plugin: string; health: string }>;
      reports: Array<{
        plugins: Array<{
          pluginName: string;
          native: {
            pluginInstalled: boolean;
            cacheStatus?: string;
            validCachePaths?: string[];
            invalidCachePaths?: string[];
            ignoredCacheEntries?: string[];
          };
        }>;
      }>;
    };
    const plugins = new Map(
      payload.reports.flatMap((report) => report.plugins).map((plugin) => [plugin.pluginName, plugin]),
    );

    expect(payload.cells.every((cell) => cell.health === 'needsAttention')).toBe(true);
    expect(plugins.get('multi-version')?.native).toMatchObject({
      pluginInstalled: false,
      cacheStatus: 'ambiguous',
      validCachePaths: [firstPath, secondPath],
    });
    expect(plugins.get('invalid-cache')?.native).toMatchObject({
      pluginInstalled: false,
      cacheStatus: 'invalid',
      invalidCachePaths: [invalidVersionPath],
    });
    expect(plugins.get('file-entry')?.native).toMatchObject({
      pluginInstalled: false,
      cacheStatus: 'invalid',
      ignoredCacheEntries: [ignoredEntryPath],
    });
  });

  it('keeps shared-ref-only, cache-only, and breadcrumb-only Codex user targets out of upgrade-ready candidates', async () => {
    const { repoRoot, env } = await makeWorkspace();
    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        'git-commit': {
          lastResolvedVersion: '0.1.0',
          platforms: {
            codex: {
              sharedNativeRefs: {
                user: true,
                projects: [],
              },
            },
          },
        },
      },
    }, env);
    await writeCodexActiveCache(env, 'cache-only');
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'recovery-only',
      state: 'post_check_failed',
      reason: 'post check failed',
      env,
    });

    const sharedRefCandidates = await buildCommandCandidates({
      command: 'upgrade',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['git-commit'],
      env,
    });
    const cacheOnlyCandidates = await buildCommandCandidates({
      command: 'upgrade',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['cache-only'],
      env,
    });
    const breadcrumbCandidates = await buildCommandCandidates({
      command: 'upgrade',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['recovery-only'],
      env,
    });

    expect(sharedRefCandidates).toHaveLength(1);
    expect(sharedRefCandidates[0].selectable).toBe(false);
    expect(sharedRefCandidates[0].disabledReason).toContain('shared native ref');

    expect(cacheOnlyCandidates).toHaveLength(1);
    expect(cacheOnlyCandidates[0].selectable).toBe(false);
    expect(cacheOnlyCandidates[0].disabledReason).toContain('Codex cache 残留');

    expect(breadcrumbCandidates).toHaveLength(1);
    expect(breadcrumbCandidates[0].selectable).toBe(false);
    expect(breadcrumbCandidates[0].disabledReason).toContain('native recovery breadcrumb');
  });

  it('ignores disabled-only Codex config entries when there is no cache or recovery evidence', async () => {
    const { repoRoot, env } = await makeWorkspace();
    await upsertCodexPluginEnabledFile(
      resolveCodexPaths(repoRoot, 'user', env).configTomlPath,
      'disabled-only@aw',
      { enabled: false },
    );

    const candidates = await buildCommandCandidates({
      command: 'status',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      env,
    });

    expect(candidates.some((candidate) => candidate.pluginName === 'disabled-only')).toBe(false);
  });

  it('discovers breadcrumb-only Codex native recovery evidence and exposes stable recovery JSON', async () => {
    const { repoRoot, env } = await makeWorkspace();
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'recovery-only',
      state: 'post_check_failed',
      reason: 'post check failed',
      env,
    });

    const candidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      pluginNames: ['recovery-only'],
      env,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].selectable).toBe(true);
    expect(candidates[0].evidence.sources).toContain('codexNativeRecovery');

    const status = await statusCommand(
      ['recovery-only'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
      { env },
    );
    const humanStatus = await statusCommand(
      ['recovery-only'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      { env },
    );
    const payload = JSON.parse(status.output) as {
      cells: Array<{ health: string }>;
      reports: Array<{
        plugins: Array<{
          native: {
            pluginInstalled: boolean;
            pluginEnabled?: boolean;
            recovery: {
              present: boolean;
              state: string | null;
              reason: string | null;
              evidenceMatches: boolean | null;
              suggestion: string | null;
            };
          };
        }>;
      }>;
    };

    expect(payload.cells[0]?.health).toBe('needsAttention');
    expect(payload.reports[0]?.plugins[0]?.native).toMatchObject({
      pluginInstalled: false,
      pluginEnabled: false,
      recovery: {
        present: true,
        state: 'post_check_failed',
        reason: 'post check failed',
        evidenceMatches: false,
      },
    });
    expect(payload.reports[0]?.plugins[0]?.native.recovery.suggestion).toContain('aw uninstall recovery-only -p codex -s user');
    expect(humanStatus.output).toContain('native 写入已完成');
    expect(humanStatus.output).toContain('recovery breadcrumb 仍在');
  });

  it('keeps recovery evidenceMatches false when only ledger and shared native refs remain', async () => {
    const { repoRoot, env } = await makeWorkspace();
    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        'git-commit': {
          lastResolvedVersion: '0.1.0',
          platforms: {
            codex: {
              userScope: scopeRecord({
                requiresNativePlugin: true,
              }),
              sharedNativeRefs: {
                user: true,
                projects: [],
              },
            },
          },
        },
      },
    }, env);
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      state: 'post_check_failed',
      reason: 'post check failed',
      env,
    });

    const status = await statusCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
      { env },
    );
    const payload = JSON.parse(status.output) as {
      reports: Array<{
        plugins: Array<{
          native: {
            pluginInstalled: boolean;
            pluginEnabled?: boolean;
            recovery: {
              present: boolean;
              evidenceMatches: boolean | null;
              suggestion: string | null;
            };
          };
          scopeManagedEvidence?: {
            ledger: boolean;
            sharedNativeRef: boolean;
          };
        }>;
      }>;
    };
    const plugin = payload.reports[0]?.plugins[0];

    expect(plugin).toMatchObject({
      native: {
        pluginInstalled: false,
        pluginEnabled: false,
        recovery: {
          present: true,
          evidenceMatches: false,
        },
      },
      scopeManagedEvidence: {
        ledger: true,
        sharedNativeRef: true,
      },
    });
    expect(plugin?.native.recovery.suggestion).toContain('aw uninstall git-commit -p codex -s user');
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

  it('keeps default status and interactive candidates unknown when tracking cannot be read', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const codexPaths = resolveCodexPaths(repoRoot, 'user', env);
    await fs.outputFile(getTrackingManifestPath(codexPaths.trackingDir), '{broken json');

    const statusCandidates = await buildCommandCandidates({
      command: 'status',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      env,
    });
    const statusCandidate = statusCandidates.find((candidate) =>
      candidate.pluginName === 'git-commit' &&
      candidate.platform === 'codex' &&
      candidate.scope === 'user',
    );

    expect(statusCandidate?.evidence.readErrors.join('\n')).toContain('tracking manifest');

    const uninstallCandidates = await buildCommandCandidates({
      command: 'uninstall',
      cwd: repoRoot,
      scopeFilter: 'user',
      platformFilter: 'codex',
      env,
    });
    const uninstallCandidate = uninstallCandidates.find((candidate) =>
      candidate.pluginName === 'git-commit' &&
      candidate.platform === 'codex' &&
      candidate.scope === 'user',
    );

    expect(uninstallCandidate?.selectable).toBe(false);
    expect(uninstallCandidate?.disabledReason).toContain('读取失败');

    const codexStatus = vi.fn(async () => {
      throw new Error('status should not run for unreadable discovery cells');
    });
    const result = await statusCommand(
      [],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
      {
        adapters: {
          codex: { status: codexStatus } as never,
          claude: { status: vi.fn() } as never,
        },
        env,
      },
    );
    const payload = JSON.parse(result.output) as {
      cells: Array<{ pluginName: string; platform: string; scope: string; health: string; error?: string }>;
    };
    const gitCommitCell = payload.cells.find((cell) =>
      cell.pluginName === 'git-commit' &&
      cell.platform === 'codex' &&
      cell.scope === 'user',
    );

    expect(gitCommitCell).toMatchObject({
      health: 'unknown',
    });
    expect(gitCommitCell?.error).toContain('tracking manifest');
    expect(codexStatus).not.toHaveBeenCalled();
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
