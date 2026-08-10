import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { upgradeWriteCommand } from '../../src/commands/write-commands.js';
import type { CatalogResolution } from '../../src/types.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import { writeOwnedTextFile } from '../../src/utils/ownership.js';
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
      const project = invocation.args.includes('project');
      return {
        exitCode: 0,
        stdout: project ? 'claude-project-residue@aw\n' : 'claude-user-residue@aw\n',
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('upgrade --all live discovery', () => {
  it('discovers Codex and Claude user residue with --platform both and fails catalog-missing targets independently', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const calls: string[] = [];
    const result = await upgradeWriteCommand([], {
      all: true,
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'user',
    }, {
      env: isolation.env,
      catalogResolution: await emptyCatalog(isolation.layout.rootDir),
      nativeCliRunner: discoveryRunner(calls),
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
    expect(calls).toContain('claude plugin list --scope user');
    expect(calls.some((call) => call.startsWith('codex plugin list'))).toBe(true);
  });

  it('isolates project discovery: Codex uses current-project owners and Claude uses project native list', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const rulesRoot = path.join(cwd, '.codex', 'rules');
    await fs.ensureDir(rulesRoot);
    await writeOwnedTextFile({
      path: path.join(rulesRoot, 'owned.rules'),
      allowedRoot: rulesRoot,
      identity: {
        owner: 'agent-workflows',
        plugin: 'codex-project-residue',
        artifactKey: 'owned-rule',
        platform: 'codex',
        scope: 'project',
      },
      content: 'prefix_rule(pattern = ["git"], decision = "allow")\n',
    });
    const calls: string[] = [];
    const result = await upgradeWriteCommand([], {
      all: true,
      cwd,
      platform: 'both',
      scope: 'project',
    }, {
      env: isolation.env,
      catalogResolution: await emptyCatalog(isolation.layout.rootDir),
      nativeCliRunner: discoveryRunner(calls),
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
    expect(calls).toContain('claude plugin list --scope project');
    expect(calls.some((call) => call.startsWith('codex plugin list'))).toBe(false);
  });
});
