import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';
import { createRebuildIntegration, disposePreparedPlatformRebuildSession, discoverRebuildTargetNames, inspectCodexSharedNativeLive, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { projectTargetRevision } from '../../src/commands/status-v6.js';
import type { NativeCliInvocation, NativeCliRunner } from '../../src/utils/native-cli.js';
import { createSharedOwnerToken, writeOwnedTextFile } from '../../src/utils/ownership.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('rebuild native observation and ownership boundaries', () => {
  it('uses official exact and neutral Codex list evidence for shared registration', async () => {
      const isolation = getCurrentSourceTestIsolation();
      const pluginName = 'list-evidence';
      const cacheRoot = path.join(
        isolation.layout.codexHomeDir, 'plugins', 'cache', 'aw', pluginName, '1.0.0',
      );
      await fs.outputJson(path.join(cacheRoot, 'plugin.json'), {
        name: pluginName, version: '1.0.0',
      });
      const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'official');
      const sourceRoot = path.join(marketplaceRoot, 'plugins', pluginName);
      await fs.outputJson(path.join(sourceRoot, 'plugin.json'), {
        name: pluginName, version: '1.0.0',
      });
      await fs.ensureDir(isolation.layout.awHomeDir);
      await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(marketplaceRoot)}`,
        'source_type = "local"',
        '',
      ].join('\n'));
      const calls: NativeCliInvocation[] = [];
      const inspected = await inspectCodexSharedNativeLive({
        pluginName,
        sourceId: 'official',
        desiredVersion: '1.0.0',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        marketplaceRoot,
        nativeCliRunner: async (invocation) => {
          calls.push(invocation);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              installed: invocation.cwd === isolation.layout.fixtureCwd ? [{
                pluginId: `${pluginName}@aw`, installed: true,
                enabled: true,
                version: '1.0.0',
              }] : [],
              available: [],
            }),
            stderr: '',
          };
        },
      });

      expect(inspected).toMatchObject({
        sharedNative: { state: 'usable', version: '1.0.0' },
      });
      expect(calls.map((call) => call.cwd)).toEqual(expect.arrayContaining([
        isolation.layout.fixtureCwd,
        expect.stringMatching(/aw-user-neutral-/u),
      ]));
      expect(calls.every((call) =>
        call.args.join(' ') === 'plugin list --marketplace aw --json')).toBe(true);
      await expect(fs.pathExists(calls.find((call) =>
        call.cwd !== isolation.layout.fixtureCwd)!.cwd!)).resolves.toBe(false);
    });

  it('blocks shared native inspection when exact and neutral Codex lists are unreadable', async () => {
      const isolation = getCurrentSourceTestIsolation();
      await fs.ensureDir(isolation.layout.awHomeDir);
      const calls: NativeCliInvocation[] = [];
      const inspected = await inspectCodexSharedNativeLive({
        pluginName: 'unreadable-list',
        sourceId: 'official',
        desiredVersion: '1.0.0',
        expectedPayloadDigest: `sha256:${'1'.repeat(64)}`,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        marketplaceRoot: path.join(isolation.layout.awHomeDir, 'marketplaces', 'official'),
        nativeCliRunner: async (invocation) => {
          calls.push(invocation);
          return { exitCode: 0, stdout: '{invalid', stderr: '' };
        },
      });

      expect(inspected).toMatchObject({
        sharedNative: {
          state: 'blocked', reason: 'unreadable', diagnostic: 'pluginListUnavailable',
        },
      });
      expect(calls).toHaveLength(2);
      expect(calls.every((call) =>
        call.args.join(' ') === 'plugin list --marketplace aw --json')).toBe(true);
    });

  it('fails closed when one Codex list succeeds and the other fails', async () => {
      const isolation = getCurrentSourceTestIsolation();
      await fs.ensureDir(isolation.layout.awHomeDir);
      const inspected = await inspectCodexSharedNativeLive({
        pluginName: 'degraded-list',
        sourceId: 'official',
        desiredVersion: '1.0.0',
        expectedPayloadDigest: `sha256:${'1'.repeat(64)}`,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        marketplaceRoot: path.join(isolation.layout.awHomeDir, 'marketplaces', 'official'),
        nativeCliRunner: async (invocation) => invocation.cwd === isolation.layout.fixtureCwd
          ? { exitCode: 1, stdout: '', stderr: 'project unavailable' }
          : {
              exitCode: 0,
              stdout: JSON.stringify({
                installed: [{
                  pluginId: 'degraded-list@aw', installed: true, enabled: true, version: '1.0.0',
                }],
                available: [],
              }),
              stderr: '',
            },
      });

      expect(inspected).toMatchObject({
        sharedNative: {
          state: 'blocked', reason: 'unreadable', diagnostic: 'pluginListUnavailable',
        },
      });
    });

  it.skipIf(process.platform === 'win32')(
      'blocks an installed Codex plugin when its marketplace root is a symlink',
      async () => {
        const isolation = getCurrentSourceTestIsolation();
        const pluginName = 'unsafe-marketplace';
        const marketplacesRoot = path.join(isolation.layout.awHomeDir, 'marketplaces');
        const marketplaceRoot = path.join(marketplacesRoot, 'official');
        const foreignRoot = path.join(isolation.layout.fixtureCwd, 'foreign-marketplace');
        await fs.ensureDir(foreignRoot);
        await fs.ensureDir(marketplacesRoot);
        await fs.symlink(foreignRoot, marketplaceRoot, 'dir');
        await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
          '[marketplaces.aw]',
          `source = ${JSON.stringify(marketplaceRoot)}`,
          'source_type = "local"',
          '',
        ].join('\n'));

        const inspected = await inspectCodexSharedNativeLive({
          pluginName,
          sourceId: 'official',
          desiredVersion: '1.0.0',
          inspectionMode: 'shallow',
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          marketplaceRoot,
          nativeCliRunner: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              installed: [{
                pluginId: `${pluginName}@aw`, installed: true, enabled: true, version: '1.0.0',
              }],
              available: [],
            }),
            stderr: '',
          }),
        });

        expect(inspected.sharedNative).toMatchObject({
          state: 'blocked', reason: 'foreign', diagnostic: 'marketplacePathUnsafe',
        });
      },
    );

  it.skipIf(process.platform === 'win32')(
      'blocks a Codex marketplace below a symlinked marketplaces ancestor',
      async () => {
        const isolation = getCurrentSourceTestIsolation();
        const pluginName = 'unsafe-marketplaces-ancestor';
        const marketplacesRoot = path.join(isolation.layout.awHomeDir, 'marketplaces');
        const foreignRoot = path.join(isolation.layout.fixtureCwd, 'foreign-marketplaces');
        const marketplaceRoot = path.join(marketplacesRoot, 'official');
        await fs.ensureDir(path.join(foreignRoot, 'official'));
        await fs.ensureDir(isolation.layout.awHomeDir);
        await fs.symlink(foreignRoot, marketplacesRoot, 'dir');

        const inspected = await inspectCodexSharedNativeLive({
          pluginName,
          sourceId: 'official',
          desiredVersion: '1.0.0',
          inspectionMode: 'shallow',
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          marketplaceRoot,
          nativeCliRunner: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({ installed: [], available: [] }),
            stderr: '',
          }),
        });

        expect(inspected.sharedNative).toEqual({
          state: 'blocked', reason: 'foreign', diagnostic: 'marketplacePathUnsafe',
        });
      },
    );

  it('projects only lower strict SemVer evidence as an available upgrade', () => {
      expect(projectTargetRevision('2.0.0', '1.0.0')).toEqual({
        state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0',
      });
      expect(projectTargetRevision('2.0.0', '3.0.0')).toEqual({
        state: 'unknown', availableVersion: '2.0.0', installedVersion: '3.0.0',
      });
      expect(projectTargetRevision('2.0.0', 'not-semver')).toEqual({
        state: 'unknown', availableVersion: '2.0.0', installedVersion: 'not-semver',
      });
    });

  it('does not call native list during Claude owner discovery', async () => {
      const isolation = getCurrentSourceTestIsolation();
      const rulePath = path.join(isolation.layout.claudeHomeDir, 'rules', 'owned.md');
      await writeOwnedTextFile({
        path: rulePath,
        allowedRoot: isolation.layout.claudeHomeDir,
        identity: {
          owner: 'agent-workflows',
          sourceId: 'team',
          pluginId: 'team/owner-only',
          plugin: 'owner-only',
          artifactKey: 'owned',
          platform: 'claude',
          scope: 'user',
        },
        content: 'owned\n',
      });
      const failingRunner: NativeCliRunner = async () => {
        throw new Error('claude missing');
      };
      await expect(discoverRebuildTargetNames({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        platform: 'claude',
        scope: 'user',
        nativeCliRunner: failingRunner,
        nativeFailureMode: 'ignore',
      })).resolves.toContain('owner-only');
      await expect(discoverRebuildTargetNames({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        platform: 'claude',
        scope: 'user',
        nativeCliRunner: failingRunner,
        nativeFailureMode: 'error',
      })).resolves.toContain('owner-only');
    });

  it('does not discover a Codex plugin from a private installed manifest', async () => {
      const isolation = getCurrentSourceTestIsolation();
      await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
        'source_type = "local"',
        '',
      ].join('\n'));
      await fs.outputJson(path.join(
        isolation.layout.codexHomeDir,
        'plugins',
        'manifest-only@aw',
        'manifest.json',
      ), { id: 'manifest-only@aw', version: '2.0.0' });
      await expect(discoverRebuildTargetNames({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        platform: 'codex',
        scope: 'user',
        nativeCliRunner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ installed: [], available: [] }),
          stderr: '',
        }),
        nativeFailureMode: 'error',
      })).resolves.not.toContain('manifest-only');
    });

  it.each(['EACCES', 'EBUSY', 'EIO'])(
      'does not read Codex private cache during discovery when readdir returns %s',
      async (code) => {
        const isolation = getCurrentSourceTestIsolation();
        await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
          '[marketplaces.aw]',
          `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
          'source_type = "local"',
          '',
        ].join('\n'));
        const cacheRoot = path.join(isolation.layout.codexHomeDir, 'plugins', 'cache', 'aw');
        await fs.ensureDir(cacheRoot);
        const originalReaddir = fs.readdir.bind(fs);
        vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
          if (path.resolve(String(args[0])) === path.resolve(cacheRoot)) {
            throw Object.assign(new Error(`injected ${code}`), { code });
          }
          return originalReaddir(...args);
        });

        await expect(discoverRebuildTargetNames({
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          platform: 'codex',
          scope: 'user',
          nativeCliRunner: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              installed: [{
                pluginId: 'official-only@aw', installed: true, enabled: true, version: '1.0.0',
              }],
              available: [],
            }),
            stderr: '',
          }),
          nativeFailureMode: 'error',
        })).resolves.toContain('official-only');
      },
    );

  it('ignores an invalid Codex private installed manifest during discovery', async () => {
      const isolation = getCurrentSourceTestIsolation();
      await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
        'source_type = "local"',
        '',
      ].join('\n'));
      await fs.outputFile(path.join(
        isolation.layout.codexHomeDir,
        'plugins',
        'broken@aw',
        'manifest.json',
      ), '{');

      await expect(discoverRebuildTargetNames({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        platform: 'codex',
        scope: 'user',
        nativeCliRunner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ installed: [], available: [] }),
          stderr: '',
        }),
        nativeFailureMode: 'error',
      })).resolves.not.toContain('broken');
      await expect(fs.pathExists(path.join(
        isolation.layout.codexHomeDir,
        'plugins',
        'broken@aw',
        'manifest.json',
      ))).resolves.toBe(true);
    });

  it('keeps current Claude permission overlaps without restoring later removals', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const settingsPath = path.join(isolation.layout.claudeHomeDir, 'settings.json');
    const stalePermissionOwner = createSharedOwnerToken({
      owner: 'agent-workflows', sourceId: 'team', pluginId: 'team/stale-permission',
      plugin: 'stale-permission', artifactKey: 'permissions', platform: 'claude', scope: 'user',
    });
    await fs.outputJson(settingsPath, {
      sandbox: { enabled: true, excludedCommands: ['manual', 'owned', 'shared', 'overlap'] },
      permissions: {
        defaultMode: 'default',
        allow: ['Manual', 'AddedLater', 'OldGenerated', 'RetainedOverlap', 'OtherGenerated'],
      },
      awGenerated: {
        permissions: {
          [stalePermissionOwner]: {
            allow: ['OldGenerated', 'RetainedOverlap', 'RemovedOverlap'], ask: [], deny: [],
            excludedCommands: ['owned', 'shared', 'overlap'],
          },
          other: { allow: ['OtherGenerated'], ask: [], deny: [], excludedCommands: ['shared'] },
        },
        manualPermissions: {
          allow: ['Manual', 'RemovedLater', 'RetainedOverlap', 'RemovedOverlap'], ask: [], deny: [],
          excludedCommands: ['manual', 'overlap'],
        },
      },
    });
    const context: RebuildExecutionContext = createCommandExecutionContext({ env: isolation.env,
      nativeCliRunner: async () => { throw new Error('Ownership cleanup must not call a client.'); } });
    const integration = createRebuildIntegration({ context });
    await integration.driver.ownership.removeShared({ kind: 'shared-config',
      identity: { owner: 'agent-workflows', sourceId: 'team', pluginId: 'team/stale-permission',
        plugin: 'stale-permission', artifactKey: 'permissions', platform: 'claude', scope: 'user' },
      label: settingsPath, locator: { kind: 'claude-permissions', settingsPath, ownerKey: stalePermissionOwner } });
    await disposePreparedPlatformRebuildSession(context.preparedArtifactRenderResults!);
    const settings = await fs.readJson(settingsPath);
    expect(settings.awGenerated.permissions).toEqual({
      other: { allow: ['OtherGenerated'], ask: [], deny: [], excludedCommands: ['shared'] },
    });
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.excludedCommands.toSorted()).toEqual(['manual', 'overlap', 'shared']);
    expect(settings.permissions.defaultMode).toBe('default');
    expect(settings.awGenerated.manualPermissions.allow).toHaveLength(3);
    expect(settings.awGenerated.manualPermissions.allow).toEqual(expect.arrayContaining([
      'Manual', 'AddedLater', 'RetainedOverlap',
    ]));
    expect(settings.permissions.allow).toHaveLength(4);
    expect(settings.permissions.allow).toEqual(expect.arrayContaining([
      'Manual', 'AddedLater', 'RetainedOverlap', 'OtherGenerated',
    ]));
  });

});
