import { describe, expect, it } from 'vitest';

import {
  normalizeUninstallCommandOptions,
  normalizeCleanupCommandOptions,
  normalizeDiagnoseCommandOptions,
  normalizeInstallCommandOptions,
  normalizeReinstallCommandOptions,
  normalizeStatusCommandOptions,
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

  it('normalizes install adopt-existing for project scope', () => {
    expect(normalizeInstallCommandOptions({
      cwd: '/tmp/workspace',
      scope: 'project',
      platform: 'codex',
      adoptExisting: true,
      json: true,
    })).toMatchObject({
      cwd: '/tmp/workspace',
      scope: 'project',
      platform: 'codex',
      adoptExisting: true,
    });
  });

  it('rejects install --adopt-existing outside project scope before command execution', () => {
    expect(() => normalizeInstallCommandOptions({
      cwd: '/tmp/workspace',
      adoptExisting: true,
    })).toThrow('`install --adopt-existing` 只允许 `--scope project`。');
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
      plan: true,
    })).toThrow('`cleanup --plan` 已移除；请直接运行 `aw cleanup`，或先用 `aw status --verbose` 查看当前状态。');

    expect(() => normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      yes: true,
    })).toThrow('cleanup --yes 只用于 --dependency-index --prune-stale。');
  });

  it('requires an explicit platform for standard cleanup and reinstall', () => {
    expect(() => normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
    })).toThrow('cleanup 命令需要显式指定 `--platform codex|claude|both`。');

    expect(() => normalizeReinstallCommandOptions({
      cwd: '/tmp/workspace',
    })).toThrow('reinstall 命令需要显式指定 `--platform codex|claude|both`。');
  });

  it('rejects legacy platform auto for public write commands', () => {
    expect(() => normalizeInstallCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'auto',
    })).toThrow('Unsupported platform "auto". Expected one of: codex, claude, both.');

    expect(() => normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'auto',
    })).toThrow('Unsupported platform "auto". Expected one of: codex, claude, both.');

    expect(() => normalizeReinstallCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'auto',
    })).toThrow('Unsupported platform "auto". Expected one of: codex, claude, both.');
  });

  it('normalizes uninstall --remove-config and rejects removed cleanup --plan', () => {
    expect(normalizeUninstallCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      removeConfig: true,
    })).toMatchObject({
      cwd: '/tmp/workspace',
      platform: 'codex',
      removeConfig: true,
    });

    expect(() => normalizeCleanupCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      plan: true,
      force: true,
      removeConfig: true,
    })).toThrow('`cleanup --plan` 已移除；请直接运行 `aw cleanup`，或先用 `aw status --verbose` 查看当前状态。');
  });

  it('rejects removed takeover flags for install, upgrade, and reinstall', () => {
    expect(() => normalizeInstallCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      takeoverSharedRuntime: true,
    } as any)).toThrow('`install` 不再接受 `--takeover-shared-runtime`');

    expect(() => normalizeUpgradeCommandOptions({
      cwd: '/tmp/workspace',
      all: true,
      takeoverSharedRuntime: true,
    } as any)).toThrow('`upgrade` 不再接受 `--takeover-shared-runtime`');

    expect(() => normalizeReinstallCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      takeoverSharedRuntime: true,
    } as any)).toThrow('`reinstall` 不再接受 `--takeover-shared-runtime`');
  });

  it('normalizes catalog selector options and keeps them independent from platform defaults', () => {
    expect(normalizeInstallCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      catalogChannel: 'beta',
    })).toMatchObject({
      catalogChannel: 'beta',
    });

    expect(normalizeStatusCommandOptions({
      cwd: '/tmp/workspace',
      catalogVersion: '1.2.3',
    })).toMatchObject({
      platform: 'both',
      catalogVersion: '1.2.3',
    });
  });

  it('rejects mutually exclusive catalog selector flags before command dispatch', () => {
    expect(() => normalizeInstallCommandOptions({
      cwd: '/tmp/workspace',
      platform: 'codex',
      catalogChannel: 'beta',
      catalogVersion: '1.2.3',
    })).toThrow('`--catalog-channel` 与 `--catalog-version` 互斥，不能同时指定。');
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
