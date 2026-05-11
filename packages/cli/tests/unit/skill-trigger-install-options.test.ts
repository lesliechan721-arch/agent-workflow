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

async function createPlugin(
  pluginName: string,
  options: {
    codexSkills?: string[];
    claudeSkills?: string[];
    dynamicCodexSkills?: string[];
    skillTriggers?: Record<string, { allowInstallOverride: boolean }>;
  } = {},
): Promise<PluginMeta> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `aw-skill-trigger-plugin-${pluginName}-`));
  tempDirs.push(rootDir);
  const manifestPath = path.join(rootDir, '.agents-plugin', 'plugin.json');
  await fs.ensureDir(path.dirname(manifestPath));
  const codexSkills = options.codexSkills ?? ['commit'];
  const claudeSkills = options.claudeSkills ?? ['commit'];

  await fs.writeJson(
    manifestPath,
    {
      name: pluginName,
      version: '0.1.0',
      description: `${pluginName} plugin`,
      ...(codexSkills.length > 0 || claudeSkills.length > 0 ? { skills: './skills' } : {}),
      ...(options.skillTriggers ? { skillTriggers: options.skillTriggers } : {}),
      ...(options.dynamicCodexSkills
        ? {
            artifacts: {
              targets: options.dynamicCodexSkills.map((skillKey) => ({
                id: `${skillKey}-dynamic-skill`,
                platform: 'codex',
                scopes: ['user', 'project'],
                target: 'codex.skill',
                projectManagedKind: 'skill',
                states: ['present'],
                skillKey,
              })),
            },
          }
        : {}),
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
      },
    },
    { spaces: 2 },
  );

  await Promise.all([
    ...codexSkills.map(async (skillName) => {
      await fs.outputFile(
        path.join(rootDir, 'codex', 'skills', skillName, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      );
    }),
    ...claudeSkills.map(async (skillName) => {
      await fs.outputFile(
        path.join(rootDir, 'claude', 'skills', skillName, 'SKILL.md'),
        `---\nname: ${skillName}\ndescription: ${skillName}\n---\n`,
      );
    }),
  ]);

  return {
    rootDir,
    manifestPath,
    manifest: await fs.readJson(manifestPath),
  };
}

async function createTarget(
  pluginName: string,
  options?: Parameters<typeof createPlugin>[1],
): Promise<ResolvedPluginTarget> {
  const plugin = await createPlugin(pluginName, options);
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

    const target = await createTarget('git-commit', {
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
    });
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
      applicability: 'overridable',
      skillTriggerPreference: 'manual',
      skillTriggerSource: 'ledger',
      ledgerTrust: 'available',
    });
    expect(
      explicitDefault.get(createResolvedInstallOptionsKey('codex', 'git-commit', 'user')),
    ).toEqual({
      applicability: 'overridable',
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
      [
        await createTarget('plugin-a', {
          skillTriggers: {
            commit: {
              allowInstallOverride: true,
            },
          },
        }),
        await createTarget('plugin-b', {
          skillTriggers: {
            commit: {
              allowInstallOverride: true,
            },
          },
        }),
      ],
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
      applicability: 'overridable',
      skillTriggerPreference: 'manual',
      skillTriggerSource: 'ledger',
      ledgerTrust: 'available',
    });
    expect(
      resolved.get(
        createResolvedInstallOptionsKey('claude', 'plugin-a', `project:${claudeProjectKey}`),
      ),
    ).toEqual({
      applicability: 'overridable',
      skillTriggerPreference: 'auto',
      skillTriggerSource: 'ledger',
      ledgerTrust: 'available',
    });
    expect(
      resolved.get(
        createResolvedInstallOptionsKey('codex', 'plugin-b', `project:${codexProjectKey}`),
      ),
    ).toEqual({
      applicability: 'overridable',
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
        [await createTarget('git-commit', {
          skillTriggers: {
            commit: {
              allowInstallOverride: true,
            },
          },
        })],
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
        [await createTarget('git-commit', {
          skillTriggers: {
            commit: {
              allowInstallOverride: true,
            },
          },
        })],
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
      [await createTarget('git-commit', {
        skillTriggers: {
          commit: {
            allowInstallOverride: true,
          },
        },
      })],
      ['codex'],
      {
        cwd: '/tmp/workspace',
        scope: 'user',
      },
      createDegradedLedger(),
    );
    const explicitInstall = await resolveInstallOptionsForTargets(
      'install',
      [await createTarget('git-commit', {
        skillTriggers: {
          commit: {
            allowInstallOverride: true,
          },
        },
      })],
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
      applicability: 'overridable',
      skillTriggerPreference: 'default',
      skillTriggerSource: 'default',
      ledgerTrust: 'degraded',
    });
    expect(
      explicitInstall.get(createResolvedInstallOptionsKey('codex', 'git-commit', 'user')),
    ).toEqual({
      applicability: 'overridable',
      skillTriggerPreference: 'auto',
      skillTriggerSource: 'cli',
      ledgerTrust: 'degraded',
    });
  });

  it('treats dynamic codex.skill targets as overridable install options while excluding them from static materialization', async () => {
    const resolved = await resolveInstallOptionsForTargets(
      'install',
      [await createTarget('dynamic-skill', {
        codexSkills: ['explore'],
        claudeSkills: [],
        dynamicCodexSkills: ['explore'],
        skillTriggers: {
          explore: {
            allowInstallOverride: true,
          },
        },
      })],
      ['codex'],
      {
        cwd: '/tmp/workspace',
        scope: 'user',
        requestedSkillTrigger: 'auto',
      },
      createAvailableLedger(),
    );

    expect(
      resolved.get(createResolvedInstallOptionsKey('codex', 'dynamic-skill', 'user')),
    ).toEqual({
      applicability: 'overridable',
      skillTriggerPreference: 'auto',
      skillTriggerSource: 'cli',
      ledgerTrust: 'available',
    });
  });

  it('returns none/fixed applicability without fabricating skill trigger preferences', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-trigger-applicability-'));
    tempDirs.push(cwd);

    const noneResolved = await resolveInstallOptionsForTargets(
      'install',
      [await createTarget('mcp-only', {
        codexSkills: [],
        claudeSkills: [],
      })],
      ['codex'],
      {
        cwd,
        scope: 'project',
      },
      createAvailableLedger(),
    );
    const fixedResolved = await resolveInstallOptionsForTargets(
      'install',
      [await createTarget('slash-commands-only', {
        codexSkills: ['review'],
        claudeSkills: [],
      })],
      ['codex'],
      {
        cwd,
        scope: 'project',
        requestedSkillTrigger: 'auto',
      },
      createAvailableLedger(),
    );

    expect(
      noneResolved.get(createResolvedInstallOptionsKey('codex', 'mcp-only', `project:${await resolveCodexProjectKey(cwd)}`)),
    ).toEqual({
      applicability: 'none',
      ledgerTrust: 'available',
    });
    expect(
      fixedResolved.get(createResolvedInstallOptionsKey('codex', 'slash-commands-only', `project:${await resolveCodexProjectKey(cwd)}`)),
    ).toEqual({
      applicability: 'fixed',
      ledgerTrust: 'available',
    });
  });

  it('refuses tracking-only Codex project overridable installs without an explicit skill trigger, but allows fixed targets', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-trigger-tracking-only-'));
    tempDirs.push(cwd);
    const projectKey = await resolveCodexProjectKey(cwd);
    const trackingDir = path.join(cwd, '.codex');
    await fs.ensureDir(trackingDir);
    await fs.writeJson(
      path.join(trackingDir, '.agent-workflows-manifest.json'),
      {
        version: 1,
        plugins: {
          'overridable-plugin': {
            name: 'overridable-plugin',
            generatedAt: '2026-04-28T00:00:00.000Z',
            artifacts: [{
              path: path.join(cwd, '.agents', 'skills', 'commit'),
              kind: 'skill',
              platform: 'codex',
              artifactKey: 'commit',
            }],
          },
          'fixed-plugin': {
            name: 'fixed-plugin',
            generatedAt: '2026-04-28T00:00:00.000Z',
            artifacts: [{
              path: path.join(cwd, '.agents', 'skills', 'review'),
              kind: 'skill',
              platform: 'codex',
              artifactKey: 'review',
            }],
          },
        },
      },
      { spaces: 2 },
    );

    await expect(
      resolveInstallOptionsForTargets(
        'install',
        [await createTarget('overridable-plugin', {
          skillTriggers: {
            commit: {
              allowInstallOverride: true,
            },
          },
        })],
        ['codex'],
        {
          cwd,
          scope: 'project',
        },
        createAvailableLedger(),
      ),
    ).rejects.toThrow('tracking 只能证明 repo artifact 归属');

    const explicit = await resolveInstallOptionsForTargets(
      'install',
      [await createTarget('overridable-plugin', {
        skillTriggers: {
          commit: {
            allowInstallOverride: true,
          },
        },
      })],
      ['codex'],
      {
        cwd,
        scope: 'project',
        requestedSkillTrigger: 'manual',
      },
      createAvailableLedger(),
    );
    expect(
      explicit.get(createResolvedInstallOptionsKey('codex', 'overridable-plugin', `project:${projectKey}`)),
    ).toEqual({
      applicability: 'overridable',
      skillTriggerPreference: 'manual',
      skillTriggerSource: 'cli',
      ledgerTrust: 'available',
    });

    const fixed = await resolveInstallOptionsForTargets(
      'install',
      [await createTarget('fixed-plugin', {
        codexSkills: ['review'],
        claudeSkills: [],
      })],
      ['codex'],
      {
        cwd,
        scope: 'project',
      },
      createAvailableLedger(),
    );
    expect(
      fixed.get(createResolvedInstallOptionsKey('codex', 'fixed-plugin', `project:${projectKey}`)),
    ).toEqual({
      applicability: 'fixed',
      ledgerTrust: 'available',
    });
  });
});
