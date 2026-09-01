import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { runRebuildCommand } from '../../src/commands/rebuild-command.js';
import type { CatalogResolution } from '../../src/types.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import { writeOwnedTextFile } from '../../src/utils/ownership.js';
import { resolveClaudePaths } from '../../src/utils/paths.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function emptyCatalog(root: string): Promise<CatalogResolution> {
  const catalogRoot = path.join(root, 'empty-upgrade-catalog');
  await fs.ensureDir(path.join(catalogRoot, 'plugins'));
  return { rootDir: catalogRoot, source: 'local' };
}

function discoveryRunner(calls: string[]): NativeCliRunner {
  return async (invocation) => {
    calls.push([invocation.command, ...invocation.args].join(' '));
    if (invocation.args.length === 1 && invocation.args[0] === '--version') {
      return {
        exitCode: 0,
        stdout: invocation.command === 'codex'
          ? 'codex-cli 0.145.0'
          : '2.1.88 (Claude Code)',
        stderr: '',
      };
    }
    if (invocation.command === 'codex' && invocation.args.includes('list')) {
      return { exitCode: 0, stdout: 'codex-user-residue@aw\n', stderr: '' };
    }
    if (invocation.command === 'claude' && invocation.args.includes('list')) {
      return {
        exitCode: 0,
        stdout: 'claude-list-ghost@aw\n',
        stderr: 'warning-ghost@aw',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('upgrade --all live discovery', () => {
  it('keeps unconfirmed Codex residue without blocking cleanup --all when inventory has invalid JSON', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: `sha256:${'1'.repeat(64)}`,
        marketplaceName: 'aw-team',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
        name: 'aw-team',
      }),
    ]);
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw-team]',
      `source = ${JSON.stringify(marketplaceRoot)}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    const manifestPath = path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'broken@aw-team',
      'manifest.json',
    );
    await fs.outputFile(manifestPath, '{');
    const calls: string[] = [];

    const result = await runRebuildCommand({
      command: 'cleanup',
      pluginNames: [],
      commandOptions: {
        all: true,
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      },
      all: true,
      runtime: {
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          calls.push([invocation.command, ...invocation.args].join(' '));
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    });

    expect(result.overallState).toBe('succeeded');
    expect(result.receiptTargets).toEqual([]);
    expect(calls).toEqual([]);
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe('{');
  });

  it('discovers Codex and Claude user residue with --platform both and fails catalog-missing targets independently', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
      'source_type = "local"',
      '',
      '[plugins."codex-user-residue@aw"]',
      'enabled = true',
      '',
    ].join('\n'));
    const claudePaths = resolveClaudePaths(isolation.layout.fixtureCwd, 'user', isolation.env);
    await fs.outputJson(claudePaths.knownMarketplacesPath, {
      marketplaces: { aw: { installLocation: isolation.layout.awHomeDir } },
    });
    await fs.outputJson(claudePaths.installedPluginsPath, {
      plugins: {
        'claude-user-residue@aw': [{
          name: 'claude-user-residue', marketplace: 'aw', scope: 'user', version: '1.0.0',
        }],
      },
    });
    const calls: string[] = [];
    const commandOptions = {
      all: true,
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'user',
    } as const;
    const result = await runRebuildCommand({
      command: 'upgrade',
      pluginNames: [],
      commandOptions,
      all: true,
      runtime: {
      env: isolation.env,
      catalogResolution: await emptyCatalog(isolation.layout.rootDir),
      bypassDependencyPlan: true,
      nativeCliRunner: discoveryRunner(calls),
      },
    });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginName: 'codex-user-residue', platform: 'codex', scope: 'user' }),
        state: 'failed',
        message: expect.stringContaining('当前不在 current catalog 中'),
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginName: 'claude-user-residue', platform: 'claude', scope: 'user' }),
        state: 'failed',
      }),
    ]));
    expect(calls.some((call) => call.startsWith('claude plugin list'))).toBe(false);
    expect(calls.some((call) => call.startsWith('codex plugin list'))).toBe(false);
    expect(result.targetResults.some((entry) => entry.target.pluginName.includes('ghost'))).toBe(false);
  });

  it('isolates project discovery with validated Claude project records', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const rulesRoot = path.join(cwd, '.codex', 'rules');
    await fs.ensureDir(rulesRoot);
    await writeOwnedTextFile({
      path: path.join(rulesRoot, 'owned.rules'),
      allowedRoot: rulesRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'official',
        pluginId: 'official/codex-project-residue',
        plugin: 'codex-project-residue',
        artifactKey: 'owned-rule',
        platform: 'codex',
        scope: 'project',
      },
      content: 'prefix_rule(pattern = ["git"], decision = "allow")\n',
    });
    const claudePaths = resolveClaudePaths(cwd, 'project', isolation.env);
    await fs.outputJson(claudePaths.knownMarketplacesPath, {
      marketplaces: { aw: { installLocation: isolation.layout.awHomeDir } },
    });
    await fs.outputJson(claudePaths.installedPluginsPath, {
      plugins: {
        'claude-project-residue@aw': [{
          name: 'claude-project-residue', marketplace: 'aw', scope: 'project',
          projectPath: cwd, version: '1.0.0',
        }],
      },
    });
    const calls: string[] = [];
    const commandOptions = {
      all: true,
      cwd,
      platform: 'both',
      scope: 'project',
    } as const;
    const result = await runRebuildCommand({
      command: 'upgrade',
      pluginNames: [],
      commandOptions,
      all: true,
      runtime: {
      env: isolation.env,
      catalogResolution: await emptyCatalog(isolation.layout.rootDir),
      bypassDependencyPlan: true,
      nativeCliRunner: discoveryRunner(calls),
      },
    });

    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginName: 'codex-project-residue', platform: 'codex', scope: 'project' }),
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginName: 'claude-project-residue', platform: 'claude', scope: 'project' }),
      }),
    ]));
    expect(result.targetResults.some((entry) =>
      entry.target.pluginName === 'codex-user-residue')).toBe(false);
    expect(calls.some((call) => call.startsWith('claude plugin list'))).toBe(false);
    expect(calls.some((call) => call.startsWith('codex plugin list'))).toBe(false);
    expect(result.targetResults.some((entry) => entry.target.pluginName.includes('ghost'))).toBe(false);
  });
});
