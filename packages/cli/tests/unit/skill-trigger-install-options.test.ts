import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstalledLedger, PluginMeta } from '../../src/types.js';
import {
  createResolvedInstallOptionsKey,
  resolveInstallOptionsForTargets,
  type ResolvedPluginTarget,
} from '../../src/commands/common.js';
import { createAvailableLedger } from '../../src/utils/local-marketplace.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey } from '../../src/utils/paths.js';

const tempDirs: string[] = [];

function createPlugin(pluginName: string): PluginMeta {
  return {
    rootDir: `/tmp/${pluginName}`,
    manifestPath: `/tmp/${pluginName}/.agents-plugin/plugin.json`,
    manifest: {
      name: pluginName,
      version: '0.1.0',
      description: `${pluginName} plugin`,
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
      },
    },
  };
}

function createTarget(pluginName: string): ResolvedPluginTarget {
  const plugin = createPlugin(pluginName);
  return {
    pluginName,
    plugin,
    currentPlugin: plugin,
    embeddedPlugin: plugin,
    source: 'currentCatalog',
  };
}

function createDegradedLedger(): InstalledLedger {
  return {
    version: 1,
    ledgerState: {
      status: 'degraded',
      degradedAt: '2026-04-28T00:00:00.000Z',
      reason: 'operation_interrupted_after_native_write',
    },
    plugins: {},
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('skill trigger install options resolver', () => {
  it('reuses available-ledger preferences for repeated install and distinguishes explicit default', async () => {
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
        },
      },
    };

    const target = createTarget('git-commit');
    const repeatedInstall = await resolveInstallOptionsForTargets(
      'install',
      [target],
      ['codex'],
      {
        cwd: '/tmp/workspace',
        scope: 'user',
      },
      ledger,
    );
    const explicitDefault = await resolveInstallOptionsForTargets(
      'install',
      [target],
      ['codex'],
      {
        cwd: '/tmp/workspace',
        scope: 'user',
        requestedSkillTrigger: 'default',
      },
      ledger,
    );

    expect(
      repeatedInstall.get(createResolvedInstallOptionsKey('codex', 'git-commit', 'user')),
    ).toEqual({
      skillTriggerPreference: 'manual',
      skillTriggerSource: 'ledger',
      ledgerTrust: 'available',
    });
    expect(
      explicitDefault.get(createResolvedInstallOptionsKey('codex', 'git-commit', 'user')),
    ).toEqual({
      skillTriggerPreference: 'default',
      skillTriggerSource: 'cli',
      ledgerTrust: 'available',
    });
  });

  it('restores each plugin and platform preference independently from an available ledger', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-trigger-options-'));
    tempDirs.push(cwd);
    const claudeProjectKey = await resolveClaudeProjectKey(cwd);
    const codexProjectKey = await resolveCodexProjectKey(cwd);

    const ledger = createAvailableLedger();
    ledger.plugins['plugin-a'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [codexProjectKey]: {
              managed: true,
              updatedAt: '2026-04-28T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
              },
              installOptions: {
                skillTriggerPreference: 'manual',
              },
            },
          },
        },
        claude: {
          projectScopes: {
            [claudeProjectKey]: {
              managed: true,
              updatedAt: '2026-04-28T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                managedExtensions: ['instructions'],
              },
              installOptions: {
                skillTriggerPreference: 'auto',
              },
            },
          },
        },
      },
    };
    ledger.plugins['plugin-b'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [codexProjectKey]: {
              managed: true,
              updatedAt: '2026-04-28T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
              },
              installOptions: {
                skillTriggerPreference: 'auto',
              },
            },
          },
        },
      },
    };

    const resolved = await resolveInstallOptionsForTargets(
      'upgrade',
      [createTarget('plugin-a'), createTarget('plugin-b')],
      ['codex', 'claude'],
      {
        cwd,
        scope: 'project',
      },
      ledger,
    );

    expect(
      resolved.get(
        createResolvedInstallOptionsKey('codex', 'plugin-a', `project:${codexProjectKey}`),
      ),
    ).toEqual({
      skillTriggerPreference: 'manual',
      skillTriggerSource: 'ledger',
      ledgerTrust: 'available',
    });
    expect(
      resolved.get(
        createResolvedInstallOptionsKey('claude', 'plugin-a', `project:${claudeProjectKey}`),
      ),
    ).toEqual({
      skillTriggerPreference: 'auto',
      skillTriggerSource: 'ledger',
      ledgerTrust: 'available',
    });
    expect(
      resolved.get(
        createResolvedInstallOptionsKey('codex', 'plugin-b', `project:${codexProjectKey}`),
      ),
    ).toEqual({
      skillTriggerPreference: 'auto',
      skillTriggerSource: 'ledger',
      ledgerTrust: 'available',
    });
  });

  it('rejects implicit inheritance for managed targets when the ledger is degraded', async () => {
    const ledger = createDegradedLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
          },
        },
      },
    };

    await expect(
      resolveInstallOptionsForTargets(
        'install',
        [createTarget('git-commit')],
        ['codex'],
        {
          cwd: '/tmp/workspace',
          scope: 'user',
        },
        ledger,
      ),
    ).rejects.toThrow('不能隐式继承旧的 skill trigger 偏好');

    await expect(
      resolveInstallOptionsForTargets(
        'upgrade',
        [createTarget('git-commit')],
        ['codex'],
        {
          cwd: '/tmp/workspace',
          scope: 'user',
        },
        ledger,
      ),
    ).rejects.toThrow('无法从 degraded installed.json 安全恢复');
  });

  it('allows degraded-ledger new installs to default and explicit overrides to continue', async () => {
    const defaultInstall = await resolveInstallOptionsForTargets(
      'install',
      [createTarget('git-commit')],
      ['codex'],
      {
        cwd: '/tmp/workspace',
        scope: 'user',
      },
      createDegradedLedger(),
    );
    const explicitInstall = await resolveInstallOptionsForTargets(
      'install',
      [createTarget('git-commit')],
      ['codex'],
      {
        cwd: '/tmp/workspace',
        scope: 'user',
        requestedSkillTrigger: 'auto',
      },
      createDegradedLedger(),
    );

    expect(
      defaultInstall.get(createResolvedInstallOptionsKey('codex', 'git-commit', 'user')),
    ).toEqual({
      skillTriggerPreference: 'default',
      skillTriggerSource: 'default',
      ledgerTrust: 'degraded',
    });
    expect(
      explicitInstall.get(createResolvedInstallOptionsKey('codex', 'git-commit', 'user')),
    ).toEqual({
      skillTriggerPreference: 'auto',
      skillTriggerSource: 'cli',
      ledgerTrust: 'degraded',
    });
  });
});
