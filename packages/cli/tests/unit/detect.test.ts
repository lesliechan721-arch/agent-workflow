import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  detectCodexSessionState,
  detectEnvironment,
  resolveCodexProjectTrust,
} from '../../src/utils/detect.js';

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<{
  repoRoot: string;
  claudeHome: string;
  codexHome: string;
  binDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-detect-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  const claudeHome = path.join(root, 'claude-home');
  const codexHome = path.join(root, 'codex-home');
  const binDir = path.join(root, 'bin');

  await fs.ensureDir(path.join(repoRoot, '.claude'));
  await fs.ensureDir(path.join(repoRoot, '.codex'));
  await fs.ensureDir(claudeHome);
  await fs.ensureDir(codexHome);
  await fs.ensureDir(binDir);

  return { repoRoot, claudeHome, codexHome, binDir };
}

async function createExecutable(binDir: string, commandName: string): Promise<void> {
  const extension = process.platform === 'win32' ? '.cmd' : '';
  const executablePath = path.join(binDir, `${commandName}${extension}`);
  const content = process.platform === 'win32'
    ? '@echo off\r\nexit /b 0\r\n'
    : '#!/bin/sh\nexit 0\n';

  await fs.writeFile(executablePath, content, 'utf8');
  if (process.platform !== 'win32') {
    await fs.chmod(executablePath, 0o755);
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('detect utils', () => {
  it('reports available scopes for Claude and Codex independently', async () => {
    const { repoRoot, claudeHome, codexHome, binDir } = await makeWorkspace();
    await createExecutable(binDir, 'claude');
    await createExecutable(binDir, 'codex');

    await fs.writeJson(path.join(repoRoot, '.claude', 'settings.json'), { team: true }, { spaces: 2 });
    await fs.writeFile(path.join(codexHome, 'config.toml'), '[marketplaces.test]\nsource = "./test"\n', 'utf8');

    const detection = await detectEnvironment(repoRoot, {
      ...process.env,
      AW_CLAUDE_HOME: claudeHome,
      AW_CODEX_HOME: codexHome,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    });

    expect(detection.claude.available).toBe(true);
    expect(detection.claude.scopes).toEqual(['project', 'user']);
    expect(detection.claude.preferredScope).toBe('project');

    expect(detection.codex.available).toBe(true);
    expect(detection.codex.scopes).toEqual(['project', 'user']);
    expect(detection.codex.preferredScope).toBe('project');
  });

  it('does not mark platforms as available when only config directories exist', async () => {
    const { repoRoot, claudeHome, codexHome } = await makeWorkspace();

    const detection = await detectEnvironment(repoRoot, {
      ...process.env,
      AW_CLAUDE_HOME: claudeHome,
      AW_CODEX_HOME: codexHome,
      PATH: '',
    });

    expect(detection.claude.available).toBe(false);
    expect(detection.claude.scopes).toEqual(['project', 'user']);
    expect(detection.claude.reason).toContain('executable');

    expect(detection.codex.available).toBe(false);
    expect(detection.codex.scopes).toEqual(['project', 'user']);
    expect(detection.codex.reason).toContain('executable');
  });

  it('derives Codex project trust from lookup keys and project-layer presence', () => {
    expect(
      resolveCodexProjectTrust({
        applicable: true,
        lookupKeys: ['/repo/current', '/repo/root'],
        trustLevels: {
          '/repo/root': 'trusted',
        },
        hasProjectLayerArtifacts: true,
      }),
    ).toBe('trusted');

    expect(
      resolveCodexProjectTrust({
        applicable: true,
        lookupKeys: ['/repo/current'],
        trustLevels: {},
        hasProjectLayerArtifacts: true,
      }),
    ).toBe('unknown');

    expect(
      resolveCodexProjectTrust({
        applicable: false,
        lookupKeys: [],
        trustLevels: {},
        hasProjectLayerArtifacts: false,
      }),
    ).toBe('not_applicable');
  });

  it('calculates Codex instructions and repo-managed session state', () => {
    expect(
      detectCodexSessionState({
        scope: 'user',
        declarations: {
          instructions: true,
          permissions: true,
          hooks: true,
          agents: true,
        },
        managed: {
          instructions: true,
          rules: true,
          hooks: true,
          agents: true,
          agentRoleNames: ['aw-git-commit-reviewer'],
        },
        higherPriorityExternal: {
          developerInstructions: false,
          rules: true,
          hooks: true,
          agentRoleNames: ['aw-git-commit-reviewer'],
        },
        projectLayerDeveloperInstructionsDefined: true,
        projectTrust: 'trusted',
      }),
    ).toMatchObject({
      instructions: 'shadowedByProjectDeveloperInstructions',
      rules: 'visible',
      hooks: 'visible',
      agents: 'unknownByExternalLayer',
    });

    expect(
      detectCodexSessionState({
        scope: 'project',
        declarations: {
          instructions: true,
          permissions: true,
          hooks: true,
          agents: true,
        },
        managed: {
          instructions: true,
          rules: true,
          hooks: true,
          agents: true,
          agentRoleNames: ['aw-git-commit-reviewer'],
        },
        higherPriorityExternal: {
          developerInstructions: false,
          rules: false,
          hooks: false,
          agentRoleNames: [],
        },
        projectLayerDeveloperInstructionsDefined: true,
        projectTrust: 'untrusted',
      }),
    ).toMatchObject({
      instructions: 'blockedByProjectTrust',
      rules: 'blockedByProjectTrust',
      hooks: 'blockedByProjectTrust',
      agents: 'blockedByProjectTrust',
    });
  });
});
