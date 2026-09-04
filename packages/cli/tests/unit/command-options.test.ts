import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  normalizeCleanupCommandOptions,
  normalizeInstallCommandOptions,
  normalizeReinstallCommandOptions,
  normalizeUninstallCommandOptions,
  parseDependencyScopeOverrides,
} from '../../src/commands/options.js';
import { runNativeCli } from '../../src/utils/native-cli.js';
import { TestNativeCliGuardError } from '../helpers/native-guard.js';

describe('write command options', () => {
  it('uses the minimal pure test isolation and keeps external I/O guards', async () => {
    const sentinelHome = process.env.HOME;
    const npmUserConfigPath = process.env.npm_config_userconfig;

    expect(sentinelHome).toContain('aw-pure-test-home-');
    expect(npmUserConfigPath).toBe(path.join(sentinelHome!, '.npmrc'));
    await expect(fs.stat(sentinelHome!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(npmUserConfigPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(process.cwd().startsWith(sentinelHome!)).toBe(false);

    await expect(fetch('https://example.invalid/pure-test')).rejects.toThrow(
      'Network access is disabled in tests',
    );
    await expect(runNativeCli({
      command: 'codex',
      args: ['exec', 'must-not-run'],
      agentKind: 'codex',
    })).rejects.toBeInstanceOf(TestNativeCliGuardError);
  });

  it('requires explicit platforms for every write command', () => {
    for (const normalize of [
      normalizeInstallCommandOptions,
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
