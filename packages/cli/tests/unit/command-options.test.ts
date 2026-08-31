import { describe, expect, it } from 'vitest';

import {
  normalizeCleanupCommandOptions,
  normalizeInstallCommandOptions,
  normalizeReinstallCommandOptions,
  normalizeUninstallCommandOptions,
  normalizeUpgradeCommandOptions,
  parseDependencyScopeOverrides,
} from '../../src/commands/options.js';

describe('write command options', () => {
  it('requires explicit platforms for every write command', () => {
    for (const normalize of [
      normalizeInstallCommandOptions,
      normalizeUpgradeCommandOptions,
      normalizeReinstallCommandOptions,
      normalizeUninstallCommandOptions,
    ]) {
      expect(() => normalize({})).toThrow(/platform/u);
    }
    expect(() => normalizeCleanupCommandOptions({ platform: 'codex' })).toThrow(/scope/u);
    expect(normalizeCleanupCommandOptions({
      cwd: '/workspace', platform: 'codex', scope: 'project', force: true,
    })).toMatchObject({ force: true, platform: 'codex', scope: 'project' });
  });

  it('parses repeatable dependency scopes by plugin and platform', () => {
    expect(parseDependencyScopeOverrides([
      'team/policy=user',
      'team/context#codex=project',
    ])).toEqual([
      { pluginId: 'team/context', platform: 'codex', scope: 'project' },
      { pluginId: 'team/policy', scope: 'user' },
    ]);
    expect(normalizeInstallCommandOptions({
      platform: 'codex',
      dependencyScope: ['team/policy=user'],
    }).dependencyScopeOverrides).toEqual([
      { pluginId: 'team/policy', scope: 'user' },
    ]);
    const normalized = normalizeInstallCommandOptions({
      platform: 'codex',
      dependencyScope: ['team/policy=user'],
    });
    expect(normalizeInstallCommandOptions(normalized).dependencyScopeOverrides)
      .toEqual(normalized.dependencyScopeOverrides);
  });

  it('fails closed for conflicting or invalid dependency scope selectors', () => {
    expect(() => parseDependencyScopeOverrides([
      'team/policy=user',
      'team/policy=project',
    ])).toThrow('dependencyScopeOverrideConflict');
    expect(() => parseDependencyScopeOverrides([
      'team/policy#codex=user',
      'team/policy#codex=project',
    ])).toThrow('dependencyScopeOverrideConflict');
    for (const invalid of [
      'policy=user',
      'team/policy#other=user',
      'team/policy=global',
      'team/policy',
    ]) {
      expect(() => parseDependencyScopeOverrides([invalid])).toThrow();
    }
  });
});
