import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginManifestSource } from '../../src/types.js';
import { resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import {
  createArtifactConfigDigest,
  validateArtifactPlan as validateArtifactPlanExact,
} from '../../src/utils/artifact-plan.js';
import {
  createCodexSkillExpectedTree,
  createCodexSkillStagingTreeContentDigest,
} from '../../src/utils/codex-skill-staging.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';

const tempDirs: string[] = [];

function validateArtifactPlan(
  options: Omit<Parameters<typeof validateArtifactPlanExact>[0], 'requestedArtifactIds'> & {
    requestedArtifactIds?: readonly string[];
  },
) {
  const requestedArtifactIds = options.requestedArtifactIds ??
    (options.manifest.artifacts?.targets ?? [])
      .filter((target) =>
        (target.platform ?? target.distribution) === options.platform
        && target.scopes.includes(options.scope))
      .map((target) => target.id);
  return validateArtifactPlanExact({ ...options, requestedArtifactIds });
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function createManifest(overrides: Partial<PluginManifestSource> = {}): PluginManifestSource {
  const manifest: PluginManifestSource = {
    name: 'dynamic-artifacts',
    version: '0.1.0',
    description: 'Dynamic artifact plan fixture',
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    },
    config: {
      fields: {
        enableLightweightInstruction: {
          type: 'boolean',
          default: true,
        },
        explorerModel: {
          type: 'string',
          default: 'gpt-5.4-mini',
        },
        modelReasoningEffort: {
          type: 'string',
          choices: {
            allowCustom: false,
            presets: ['low', 'medium', 'high', 'xhigh'].map((value) => ({
              id: value,
              title: value,
              value,
            })),
          },
          default: 'medium',
        },
      },
    },
    artifacts: {
      targets: [
        {
          id: 'lightweight-instruction',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.developerInstructionsBlock',
          projectManagedKind: 'instruction',
          states: ['present', 'disabled'],
          refreshKeys: [
            'enableLightweightInstruction',
            'explorerModel',
            'modelReasoningEffort',
          ],
          requiresCodexProjectConfig: true,
        },
        {
          id: 'codex-explorer-role',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.agentRole',
          projectManagedKind: 'agent',
          states: ['present'],
          refreshKeys: ['explorerModel', 'modelReasoningEffort'],
          requiresCodexProjectConfig: true,
          roleKey: 'codex-explorer',
        },
      ],
    },
  };

  return {
    ...manifest,
    ...overrides,
    config: overrides.config ?? manifest.config,
    artifacts: overrides.artifacts ?? manifest.artifacts,
  };
}

function createPresentPlan() {
  return {
    version: 2,
    artifacts: [
      {
        id: 'codex-explorer-role',
        kind: 'codexRole',
        platform: 'codex',
        target: 'codex.agentRole',
        state: 'present',
        roleKey: 'codex-explorer',
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
        content: {
          registration: {
            description: 'Read-only code exploration role.',
          },
          roleFile: {
            name: 'codex-explorer',
            description: 'Read-only code exploration role.',
            developer_instructions: 'Inspect the repository.',
            model: 'gpt-5.4-mini',
            model_reasoning_effort: 'medium',
          },
        },
      },
      {
        id: 'lightweight-instruction',
        kind: 'instruction',
        platform: 'codex',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        refreshKeys: [
          'enableLightweightInstruction',
          'explorerModel',
          'modelReasoningEffort',
        ],
        content: 'Use Codex Explore for repository inspection.',
      },
    ],
  };
}

function createDisabledInstructionPlan() {
  const plan = createPresentPlan();
  plan.artifacts[1] = {
    id: 'lightweight-instruction',
    kind: 'instruction',
    platform: 'codex',
    target: 'codex.developerInstructionsBlock',
    state: 'disabled',
    disabledReason: 'config',
    refreshKeys: [
      'enableLightweightInstruction',
      'explorerModel',
      'modelReasoningEffort',
    ],
  };
  return plan;
}

function createSkillManifest(): PluginManifestSource {
  return createManifest({
    artifacts: {
      targets: [
        {
          id: 'codex-explore-skill',
          platform: 'codex',
          scopes: ['project', 'user'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          projectManagedKind: 'skill',
          states: ['present', 'disabled'],
          refreshKeys: ['explorerModel', 'modelReasoningEffort'],
          skillKey: 'codex-explore',
        },
      ],
    },
  });
}

function createSkillPlan() {
  return {
    version: 2,
    artifacts: [
      {
        id: 'codex-explore-skill',
        kind: 'skill',
        platform: 'codex',
        target: 'codex.skill',
        state: 'present',
        skillKey: 'codex-explore',
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
        content: {
          files: {
            'SKILL.md': '# Codex Explore\n',
            'agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n',
          },
        },
      },
    ],
  };
}

const renderConfig = {
  values: {
    enableLightweightInstruction: true,
    explorerModel: 'gpt-5.4-mini',
    modelReasoningEffort: 'medium',
    unrelated: 'ignored',
  },
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('artifact plan validation', () => {
  it('requires the plan to equal the explicit requested artifact subset', () => {
    const manifest = createManifest();
    const roleOnlyPlan = createPresentPlan();
    roleOnlyPlan.artifacts = [roleOnlyPlan.artifacts[0]];

    expect(validateArtifactPlan({
      manifest,
      plan: roleOnlyPlan,
      platform: 'codex',
      scope: 'user',
      requestedArtifactIds: ['codex-explorer-role'],
      renderConfig,
    }).artifacts.map((artifact) => artifact.id)).toEqual(['codex-explorer-role']);

    expect(() => validateArtifactPlan({
      manifest,
      plan: createPresentPlan(),
      platform: 'codex',
      scope: 'user',
      requestedArtifactIds: ['codex-explorer-role'],
      renderConfig,
    })).toThrow('is not declared');

    expect(() => validateArtifactPlan({
      manifest,
      plan: roleOnlyPlan,
      platform: 'codex',
      scope: 'user',
      requestedArtifactIds: ['codex-explorer-role', 'codex-explorer-role'],
      renderConfig,
    })).toThrow('duplicate artifact ID');

    expect(() => validateArtifactPlan({
      manifest,
      plan: roleOnlyPlan,
      platform: 'codex',
      scope: 'user',
      requestedArtifactIds: ['unknown-artifact'],
      renderConfig,
    })).toThrow('is not declared for codex/user');
  });

  it('accepts present and disabled dynamic artifacts and sorts them stably', () => {
    const manifest = createManifest();
    const validatedPresent = validateArtifactPlan({
      manifest,
      plan: createPresentPlan(),
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    });
    expect(validatedPresent.artifacts.map((artifact) => artifact.id)).toEqual([
      'lightweight-instruction',
      'codex-explorer-role',
    ]);
    expect(validatedPresent.artifacts[0]?.configDigest).toMatch(/^sha256:/);
    expect(validatedPresent.artifacts[1]?.logicalIdentity).toBe(
      'dynamic-artifacts:codex-explorer-role:codex.agentRole',
    );

    const validatedDisabled = validateArtifactPlan({
      manifest,
      plan: createDisabledInstructionPlan(),
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    });
    expect(validatedDisabled.artifacts[0]).toMatchObject({
      id: 'lightweight-instruction',
      state: 'disabled',
      disabledReason: 'config',
    });
  });

  it('accepts Codex declarations on dual-platform manifests and rejects an empty renderer request', () => {
    const baseManifest = createManifest();
    const manifest = createManifest({
      marketplace: {
        ...baseManifest.marketplace,
        policy: {
          ...baseManifest.marketplace.policy,
          products: ['CODEX', 'CLAUDE'],
        },
      },
    });

    const validatedCodex = validateArtifactPlan({
      manifest,
      plan: createPresentPlan(),
      platform: 'codex',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    });
    expect(validatedCodex.artifacts.map((artifact) => artifact.target)).toEqual([
      'codex.developerInstructionsBlock',
      'codex.agentRole',
    ]);

    expect(() => validateArtifactPlan({
      manifest,
      plan: {
        version: 2,
        artifacts: [],
      },
      platform: 'claude',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('requires at least one requested artifact ID');
  });

  it('rejects unknown targets, refresh keys, states, declarations, and project write surfaces', () => {
    const manifest = createManifest();
    const unknownTargetPlan = createPresentPlan();
    unknownTargetPlan.artifacts[0] = {
      ...unknownTargetPlan.artifacts[0],
      target: 'codex.unknownTarget',
    };
    expect(() => validateArtifactPlan({
      manifest,
      plan: unknownTargetPlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('unsupported target');

    const unknownRefreshKeyPlan = createPresentPlan();
    unknownRefreshKeyPlan.artifacts[1] = {
      ...unknownRefreshKeyPlan.artifacts[1],
      refreshKeys: ['enableLightweightInstruction', 'missingKey', 'modelReasoningEffort'],
    };
    expect(() => validateArtifactPlan({
      manifest,
      plan: unknownRefreshKeyPlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('missingKey');

    const undeclaredArtifactPlan = createPresentPlan();
    undeclaredArtifactPlan.artifacts[1] = {
      ...undeclaredArtifactPlan.artifacts[1],
      id: 'unknown-artifact',
    };
    expect(() => validateArtifactPlan({
      manifest,
      plan: undeclaredArtifactPlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('is not declared');

    const undeclaredStatePlan = createPresentPlan();
    undeclaredStatePlan.artifacts[0] = {
      ...undeclaredStatePlan.artifacts[0],
      state: 'disabled',
    };
    expect(() => validateArtifactPlan({
      manifest,
      plan: undeclaredStatePlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('is not declared');

    const projectManifest = createManifest({
      artifacts: {
        targets: createManifest().artifacts?.targets?.map((target) => ({
          ...target,
          requiresCodexProjectConfig: target.id === 'lightweight-instruction'
            ? undefined
            : target.requiresCodexProjectConfig,
        })),
      },
    });
    expect(() => validateArtifactPlan({
      manifest: projectManifest,
      plan: createPresentPlan(),
      platform: 'codex',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('requiresCodexProjectConfig');

    expect(() => validateArtifactPlan({
      manifest: createSkillManifest(),
      plan: createSkillPlan(),
      platform: 'codex',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).not.toThrow();
  });

  it('rejects missing returns, missing disabled refresh keys, role name drift, and reserved config_file', () => {
    const manifest = createManifest();
    const missingArtifactPlan = createPresentPlan();
    missingArtifactPlan.artifacts = [missingArtifactPlan.artifacts[0]];
    expect(() => validateArtifactPlan({
      manifest,
      plan: missingArtifactPlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('must return artifact');

    const missingRefreshKeysPlan = createDisabledInstructionPlan();
    missingRefreshKeysPlan.artifacts[1] = {
      ...missingRefreshKeysPlan.artifacts[1],
      refreshKeys: ['explorerModel', 'modelReasoningEffort'],
    };
    expect(() => validateArtifactPlan({
      manifest,
      plan: missingRefreshKeysPlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('must preserve declared refresh key');

    const roleNameMismatchPlan = createPresentPlan();
    roleNameMismatchPlan.artifacts[0] = {
      ...roleNameMismatchPlan.artifacts[0],
      content: {
        ...roleNameMismatchPlan.artifacts[0].content,
        roleFile: {
          ...roleNameMismatchPlan.artifacts[0].content.roleFile,
          name: 'other-role',
        },
      },
    };
    expect(() => validateArtifactPlan({
      manifest,
      plan: roleNameMismatchPlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('match the declared roleKey');

    const reservedConfigFilePlan = createPresentPlan();
    reservedConfigFilePlan.artifacts[0] = {
      ...reservedConfigFilePlan.artifacts[0],
      content: {
        ...reservedConfigFilePlan.artifacts[0].content,
        registration: {
          ...reservedConfigFilePlan.artifacts[0].content.registration,
          config_file: '/tmp/not-allowed.toml',
        },
      },
    };
    expect(() => validateArtifactPlan({
      manifest,
      plan: reservedConfigFilePlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('config_file');
  });

  it('rejects undeclared path-like fields on artifacts and role content objects', () => {
    const manifest = createManifest();

    const artifactPathPlan = createPresentPlan();
    artifactPathPlan.artifacts[1] = {
      ...artifactPathPlan.artifacts[1],
      path: '/tmp/escape.md',
    } as typeof artifactPathPlan.artifacts[number];
    expect(() => validateArtifactPlan({
      manifest,
      plan: artifactPathPlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('unexpected field "path"');

    const contentPathPlan = createPresentPlan();
    contentPathPlan.artifacts[0] = {
      ...contentPathPlan.artifacts[0],
      content: {
        ...contentPathPlan.artifacts[0].content,
        roleFilePath: '../escape.toml',
      },
    } as typeof contentPathPlan.artifacts[number];
    expect(() => validateArtifactPlan({
      manifest,
      plan: contentPathPlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('roleFilePath');

    const registrationPathPlan = createPresentPlan();
    registrationPathPlan.artifacts[0] = {
      ...registrationPathPlan.artifacts[0],
      content: {
        ...registrationPathPlan.artifacts[0].content,
        registration: {
          description: 'Read-only code exploration role.',
          path: '../../escape.toml',
        },
      },
    } as typeof registrationPathPlan.artifacts[number];
    expect(() => validateArtifactPlan({
      manifest,
      plan: registrationPathPlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('unexpected field "path"');

    const roleFilePathPlan = createPresentPlan();
    roleFilePathPlan.artifacts[0] = {
      ...roleFilePathPlan.artifacts[0],
      content: {
        ...roleFilePathPlan.artifacts[0].content,
        roleFile: {
          ...roleFilePathPlan.artifacts[0].content.roleFile,
          path: '/tmp/escape.toml',
        },
      },
    } as typeof roleFilePathPlan.artifacts[number];
    expect(() => validateArtifactPlan({
      manifest,
      plan: roleFilePathPlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('unexpected field "path"');
  });

  it('accepts codex.skill file maps and rejects invalid skill identity or file maps', () => {
    const manifest = createSkillManifest();

    const validated = validateArtifactPlan({
      manifest,
      plan: createSkillPlan(),
      platform: 'codex',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    });
    expect(validated.artifacts).toMatchObject([
      {
        id: 'codex-explore-skill',
        kind: 'skill',
        target: 'codex.skill',
        skillKey: 'codex-explore',
      },
    ]);

    const missingSkillKeyPlan = createSkillPlan();
    delete (missingSkillKeyPlan.artifacts[0] as Record<string, unknown>).skillKey;
    expect(() => validateArtifactPlan({
      manifest,
      plan: missingSkillKeyPlan,
      platform: 'codex',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('skillKey');

    const mismatchedSkillKeyPlan = createSkillPlan();
    mismatchedSkillKeyPlan.artifacts[0] = {
      ...mismatchedSkillKeyPlan.artifacts[0],
      skillKey: 'other-skill',
    };
    expect(() => validateArtifactPlan({
      manifest,
      plan: mismatchedSkillKeyPlan,
      platform: 'codex',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('expected "codex-explore"');

    const unexpectedPathPlan = createSkillPlan();
    unexpectedPathPlan.artifacts[0] = {
      ...unexpectedPathPlan.artifacts[0],
      content: {
        ...unexpectedPathPlan.artifacts[0].content,
        path: '.agents/skills/codex-explore/SKILL.md',
      },
    } as typeof unexpectedPathPlan.artifacts[number];
    expect(() => validateArtifactPlan({
      manifest,
      plan: unexpectedPathPlan,
      platform: 'codex',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('unexpected field "path"');

    const missingFilesPlan = createSkillPlan();
    missingFilesPlan.artifacts[0] = {
      ...missingFilesPlan.artifacts[0],
      content: {},
    } as typeof missingFilesPlan.artifacts[number];
    expect(() => validateArtifactPlan({
      manifest,
      plan: missingFilesPlan,
      platform: 'codex',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('content.files');

    const invalidFileContentPlan = createSkillPlan();
    invalidFileContentPlan.artifacts[0] = {
      ...invalidFileContentPlan.artifacts[0],
      content: {
        files: {
          'SKILL.md': 42,
        },
      },
    } as typeof invalidFileContentPlan.artifacts[number];
    expect(() => validateArtifactPlan({
      manifest,
      plan: invalidFileContentPlan,
      platform: 'codex',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('expected a string');
  });

  it('builds codex.skill expected trees without changing native invocation metadata', async () => {
    const validated = validateArtifactPlan({
      manifest: createSkillManifest(),
      plan: {
        version: 2,
        artifacts: [{
          ...createSkillPlan().artifacts[0],
          content: {
            files: {
              'SKILL.md': '# Codex Explore\n',
              'agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n',
            },
          },
        }],
      },
      platform: 'codex',
      scope: 'project',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    });
    const artifact = validated.artifacts[0]!;

    const tree = await createCodexSkillExpectedTree({ artifact });

    expect(tree.files['SKILL.md']?.toString('utf8')).toBe('# Codex Explore\n');
    expect(tree.files['agents/openai.yaml']?.toString('utf8')).toContain(
      'allow_implicit_invocation: false',
    );
    expect(createCodexSkillStagingTreeContentDigest(tree)).toBe(
      createCodexSkillStagingTreeContentDigest(await createCodexSkillExpectedTree({ artifact })),
    );
  });

  it('rejects duplicate artifact id + target entries', () => {
    const manifest = createManifest();
    const duplicatePlan = createPresentPlan();
    duplicatePlan.artifacts.push({
      ...duplicatePlan.artifacts[1],
    });
    expect(() => validateArtifactPlan({
      manifest,
      plan: duplicatePlan,
      platform: 'codex',
      scope: 'user',
      renderConfig,
      rendererDigest: 'sha256:renderer-a',
    })).toThrow('duplicate artifact id + target');
  });

  it('limits configDigest changes to refresh keys, digest salt, target, and id', () => {
    const baseDigest = createArtifactConfigDigest({
      artifact: {
        id: 'lightweight-instruction',
        platform: 'codex',
        target: 'codex.developerInstructionsBlock',
        refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      },
      configValues: renderConfig.values,
      digestSalt: 'sha256:renderer-a',
    });
    const unrelatedDigest = createArtifactConfigDigest({
      artifact: {
        id: 'lightweight-instruction',
        platform: 'codex',
        target: 'codex.developerInstructionsBlock',
        refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      },
      configValues: {
        ...renderConfig.values,
        unrelated: 'changed',
      },
      digestSalt: 'sha256:renderer-a',
    });
    const relevantDigest = createArtifactConfigDigest({
      artifact: {
        id: 'lightweight-instruction',
        platform: 'codex',
        target: 'codex.developerInstructionsBlock',
        refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      },
      configValues: {
        ...renderConfig.values,
        explorerModel: 'gpt-5.5',
      },
      digestSalt: 'sha256:renderer-a',
    });
    const otherSaltDigest = createArtifactConfigDigest({
      artifact: {
        id: 'lightweight-instruction',
        platform: 'codex',
        target: 'codex.developerInstructionsBlock',
        refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      },
      configValues: renderConfig.values,
      digestSalt: 'sha256:renderer-b',
    });
    const otherIdDigest = createArtifactConfigDigest({
      artifact: {
        id: 'lightweight-instruction-v2',
        platform: 'codex',
        target: 'codex.developerInstructionsBlock',
        refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      },
      configValues: renderConfig.values,
      digestSalt: 'sha256:renderer-a',
    });
    const otherTargetDigest = createArtifactConfigDigest({
      artifact: {
        id: 'lightweight-instruction',
        platform: 'codex',
        target: 'codex.agentRole',
        refreshKeys: ['enableLightweightInstruction', 'explorerModel', 'modelReasoningEffort'],
      },
      configValues: renderConfig.values,
      digestSalt: 'sha256:renderer-a',
    });
    const objectChildDigest = createArtifactConfigDigest({
      artifact: {
        id: 'lightweight-instruction',
        platform: 'codex',
        target: 'codex.developerInstructionsBlock',
        refreshKeys: ['credentials'],
      },
      configValues: { credentials: { region: 'us', token: 'two' } },
      digestSalt: 'sha256:renderer-a',
    });
    const objectBaseDigest = createArtifactConfigDigest({
      artifact: {
        id: 'lightweight-instruction',
        platform: 'codex',
        target: 'codex.developerInstructionsBlock',
        refreshKeys: ['credentials'],
      },
      configValues: { credentials: { region: 'us', token: 'one' } },
      digestSalt: 'sha256:renderer-a',
    });

    expect(unrelatedDigest).toBe(baseDigest);
    expect(relevantDigest).not.toBe(baseDigest);
    expect(otherSaltDigest).not.toBe(baseDigest);
    expect(otherIdDigest).not.toBe(baseDigest);
    expect(otherTargetDigest).not.toBe(baseDigest);
    expect(objectChildDigest).not.toBe(objectBaseDigest);
  });

  it('keeps user-scope digests stable when project config changes', async () => {
    const root = await makeTempRoot('aw-artifact-plan-digest-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    const env = { AW_HOME: awHome } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);

    const manifest = createManifest();
    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        explorerModel: 'gpt-5.4-mini',
      },
    });
    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'project',
      cwd,
      env,
      values: {
        modelReasoningEffort: 'high',
      },
    });

    const userConfigBefore = await resolveArtifactRenderConfig({
      manifest,
      scope: 'user',
      cwd,
      env,
    });
    const userDigestBefore = validateArtifactPlan({
      manifest,
      plan: createPresentPlan(),
      platform: 'codex',
      scope: 'user',
      renderConfig: userConfigBefore,
      rendererDigest: 'sha256:renderer-a',
    }).artifacts[0]?.configDigest;

    await writePluginConfigStore({
      pluginName: manifest.name,
      scope: 'project',
      cwd,
      env,
      values: {
        explorerModel: 'project-override',
        modelReasoningEffort: 'xhigh',
      },
    });

    const userConfigAfter = await resolveArtifactRenderConfig({
      manifest,
      scope: 'user',
      cwd,
      env,
    });
    const userDigestAfter = validateArtifactPlan({
      manifest,
      plan: createPresentPlan(),
      platform: 'codex',
      scope: 'user',
      renderConfig: userConfigAfter,
      rendererDigest: 'sha256:renderer-a',
    }).artifacts[0]?.configDigest;

    expect(userConfigAfter.sources.explorerModel).toBe('user');
    expect(userConfigAfter.values.explorerModel).toBe('gpt-5.4-mini');
    expect(userDigestAfter).toBe(userDigestBefore);
  });
});
