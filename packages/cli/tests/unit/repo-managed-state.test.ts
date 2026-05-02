import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstalledLedger } from '../../src/types.js';
import {
  assertZeroWriteSnapshotUnchanged,
  captureZeroWriteSnapshot,
  writeCorruptedCodexProjectConfig,
  writeCorruptedCodexUserConfig,
  writeCorruptedTrackingManifest,
  writeDegradedInstalledLedger,
  writeInstalledLedgerMissingScopeRecord,
  writeTrackingManifestWithMissingArtifactKey,
} from '../helpers/repo-managed-state.js';

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<{
  root: string;
  repoRoot: string;
  awHome: string;
  codexHome: string;
  claudeHome: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-zero-write-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  const awHome = path.join(root, 'aw-home');
  const codexHome = path.join(root, 'codex-home');
  const claudeHome = path.join(root, 'claude-home');
  await fs.ensureDir(repoRoot);

  return {
    root,
    repoRoot,
    awHome,
    codexHome,
    claudeHome,
    env: {
      ...process.env,
      AW_HOME: awHome,
      AW_CODEX_HOME: codexHome,
      AW_CLAUDE_HOME: claudeHome,
    },
  };
}

function createLedger(): InstalledLedger {
  return {
    version: 1,
    ledgerState: {
      status: 'available',
      degradedAt: null,
      reason: null,
    },
    plugins: {
      'git-commit': {
        lastResolvedVersion: '0.1.0',
        platforms: {
          codex: {
            projectScopes: {
              '/repo': {
                managed: true,
                updatedAt: '2026-04-30T00:00:00.000Z',
                resolvedVersion: '0.1.0',
                capabilitySnapshot: {
                  requiresNativePlugin: false,
                  hasRepoManagedArtifacts: true,
                },
                installOptions: {
                  skillTriggerPreference: 'manual',
                },
              },
            },
          },
        },
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('repo-managed zero-write test helpers', () => {
  it('treats an equivalent installed.json rewrite as unchanged', async () => {
    const workspace = await makeWorkspace();
    const ledger = createLedger();
    const ledgerPath = path.join(workspace.awHome, 'installed.json');
    await fs.outputJson(ledgerPath, ledger, { spaces: 2 });

    const snapshot = await captureZeroWriteSnapshot({
      repoRoot: workspace.repoRoot,
      env: workspace.env,
    });
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({
        plugins: ledger.plugins,
        version: ledger.version,
        ledgerState: ledger.ledgerState,
      }),
      'utf8',
    );

    await expect(assertZeroWriteSnapshotUnchanged(snapshot)).resolves.toBeUndefined();
  });

  it('detects absent directory, directory content, and file content changes', async () => {
    const absentWorkspace = await makeWorkspace();
    const absentSnapshot = await captureZeroWriteSnapshot({
      repoRoot: absentWorkspace.repoRoot,
      env: absentWorkspace.env,
    });
    await fs.ensureDir(path.join(absentWorkspace.repoRoot, '.codex'));
    await expect(assertZeroWriteSnapshotUnchanged(absentSnapshot)).rejects.toThrow(
      'was expected to remain absent',
    );

    const directoryWorkspace = await makeWorkspace();
    const skillPath = path.join(directoryWorkspace.repoRoot, '.agents', 'skills', 'commit', 'SKILL.md');
    await fs.outputFile(skillPath, 'before\n', 'utf8');
    const directorySnapshot = await captureZeroWriteSnapshot({
      repoRoot: directoryWorkspace.repoRoot,
      env: directoryWorkspace.env,
    });
    await fs.writeFile(skillPath, 'after\n', 'utf8');
    await expect(assertZeroWriteSnapshotUnchanged(directorySnapshot)).rejects.toThrow(
      'directory content changed',
    );

    const fileWorkspace = await makeWorkspace();
    const nativeConfigPath = path.join(fileWorkspace.codexHome, 'config.toml');
    await fs.outputFile(nativeConfigPath, 'model = "gpt-5"\n', 'utf8');
    const fileSnapshot = await captureZeroWriteSnapshot({
      repoRoot: fileWorkspace.repoRoot,
      env: fileWorkspace.env,
    });
    await fs.writeFile(nativeConfigPath, 'model = "gpt-5.1"\n', 'utf8');
    await expect(assertZeroWriteSnapshotUnchanged(fileSnapshot)).rejects.toThrow(
      'file content changed',
    );
  });

  it('writes reusable corrupted config, tracking, degraded ledger, and missing-scope ledger fixtures', async () => {
    const workspace = await makeWorkspace();

    await expect(fs.readFile(
      await writeCorruptedCodexUserConfig({ env: workspace.env }),
      'utf8',
    )).resolves.toContain('[plugins."git-commit@aw"');
    await expect(fs.readFile(
      await writeCorruptedCodexProjectConfig({ repoRoot: workspace.repoRoot }),
      'utf8',
    )).resolves.toContain('[mcp_servers."acme.tools v1"');
    await expect(fs.readFile(
      await writeCorruptedTrackingManifest({ repoRoot: workspace.repoRoot }),
      'utf8',
    )).resolves.toContain('"plugins"');

    const tracking = await writeTrackingManifestWithMissingArtifactKey({
      repoRoot: workspace.repoRoot,
      artifactKind: 'mcpServer',
    });
    const artifact = (
      tracking.manifest.plugins as Record<string, { artifacts: Array<Record<string, unknown>> }>
    )['git-commit'].artifacts[0];
    expect(artifact.kind).toBe('mcpServer');
    expect(artifact).not.toHaveProperty('artifactKey');

    const degraded = await writeDegradedInstalledLedger({ env: workspace.env });
    expect(degraded.ledger.ledgerState).toMatchObject({
      status: 'degraded',
      reason: 'operation_interrupted_after_artifact_write',
    });

    const missingScope = await writeInstalledLedgerMissingScopeRecord({
      env: workspace.env,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'project',
    });
    expect(missingScope.ledger.plugins['git-commit'].platforms.codex?.projectScopes).toEqual({});
  });
});
