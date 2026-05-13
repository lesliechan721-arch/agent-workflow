import { describe, expect, it } from 'vitest';

import {
  normalizeUninstallCommandOptions,
  normalizeCleanupCommandOptions,
  normalizeDiagnoseCommandOptions,
  normalizeInstallCommandOptions,
  normalizeRepairCommandOptions,
  normalizeReinstallCommandOptions,
  normalizeUpgradeCommandOptions,
  resolveConfigProjectLayer,
} from '../../src/commands/options.js';

describe('command options normalization', () => {
  it('normalizes diagnose --deep with status filters', () => {
    expect(normalizeDiagnoseCommandOptions({
      cwd: '/tmp/workspace',
      scope: 'project',
      platform: 'codex',
      json: true,
      deep: true,
    })).toMatchObject({
      cwd: '/tmp/workspace',
      scope: 'project',
      platform: 'codex',
      json: true,
      deep: true,
    });
  });

  it('normalizes repair options including adopt-existing and takeover', () => {
    expect(normalizeRepairCommandOptions({
      cwd: '/tmp/workspace',
      scope: 'project',
      platform: 'codex',
      adoptExisting: true,
      skillTrigger: 'manual',
      takeoverSharedRuntime: true,
      json: true,
    })).toMatchObject({
      cwd: '/tmp/workspace',
      scope: 'project',
      platform: 'codex',
      adoptExisting: true,
      dependencyIndex: false,
      requestedSkillTrigger: 'manual',
      takeoverSharedRuntime: true,
      json: true,
    });
  });

  it('rejects repair --dependency-index with --adopt-existing before command execution', () => {
    expect(() => normalizeRepairCommandOptions({
      cwd: '/tmp/workspace',
      dependencyIndex: true,
      adoptExisting: true,
    })).toThrow('--dependency-index 不能与 --adopt-existing 一起使用。');
  });

  it('normalizes cleanup dependency-index prune arguments', () => {
    expect(normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
      dependencyIndex: true,
      pruneStale: 'stale-token',
      yes: true,
      json: true,
    })).toMatchObject({
      cwd: '/tmp/workspace',
      dependencyIndex: true,
      pruneStale: 'stale-token',
      yes: true,
      plan: false,
      removeConfig: false,
      json: true,
    });
  });

  it('fails cleanup dependency-index requests before write when prune token or yes is missing', () => {
    expect(() => normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
      dependencyIndex: true,
      yes: true,
    })).toThrow('cleanup --dependency-index 目前只支持 --prune-stale <token>。');

    expect(() => normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
      dependencyIndex: true,
      pruneStale: 'stale-token',
    })).toThrow('cleanup --dependency-index --prune-stale 需要显式传入 --yes。');

    expect(() => normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
      dependencyIndex: true,
      pruneStale: 'stale-token',
      yes: true,
      plan: true,
    })).toThrow('cleanup --dependency-index --prune-stale 不支持 --plan。');

    expect(() => normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      yes: true,
    })).toThrow('cleanup --yes 只用于 --dependency-index --prune-stale。');
  });

  it('fails standard cleanup and reinstall when the platform is not a single explicit target', () => {
    expect(() => normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
    })).toThrow('cleanup 命令需要显式指定单一平台。');

    expect(() => normalizeReinstallCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'both',
    })).toThrow('reinstall 命令需要显式指定单一平台。');
  });

  it('normalizes uninstall --remove-config and cleanup --plan --force --remove-config', () => {
    expect(normalizeUninstallCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      removeConfig: true,
    })).toMatchObject({
      cwd: '/tmp/workspace',
      platform: 'codex',
      removeConfig: true,
    });

    expect(normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      plan: true,
      force: true,
      removeConfig: true,
    })).toMatchObject({
      cwd: '/tmp/workspace',
      platform: 'codex',
      plan: true,
      force: true,
      removeConfig: true,
      yes: false,
    });
  });

  it('normalizes takeover for install and rejects upgrade --all takeover', () => {
    expect(normalizeInstallCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      takeoverSharedRuntime: true,
    })).toMatchObject({
      cwd: '/tmp/workspace',
      platform: 'codex',
      takeoverSharedRuntime: true,
    });

    expect(() => normalizeUpgradeCommandOptions({
      cwd: '/tmp/workspace',
      all: true,
      takeoverSharedRuntime: true,
    })).toThrow('`upgrade --all` 不支持 `--takeover-shared-runtime`；请改用单目标 upgrade。');
  });

  it('allows config --scope project --local and rejects non-project local scope', () => {
    expect(resolveConfigProjectLayer({
      scope: 'project',
      local: true,
    })).toBe('local');

    expect(resolveConfigProjectLayer({
      scope: 'user',
      local: false,
    })).toBe('shared');

    expect(() => resolveConfigProjectLayer({
      scope: 'user',
      local: true,
    })).toThrow('`--local` 只能与 `--scope project` 一起使用。');
  });
});
