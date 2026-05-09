import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstalledLedger } from '../../src/types.js';
import { createAvailableLedger } from '../../src/utils/local-marketplace.js';
import {
  buildSkillTriggerMaterializationSignature,
  commitMaterializedSkillTriggerPreference,
  collectSkillTriggerSiblingConflictWarnings,
  getNextSkillTriggerWriteOrder,
  materializeSkillTriggerPreference,
  patchClaudeSkillFrontmatter,
  patchCodexOpenAiYaml,
  readCurrentSkillTriggerRuntimeSignature,
  rematerializeSkillTriggerPreferenceAfterUninstall,
  resolveSkillTriggerPolicies,
  rollbackMaterializedSkillTriggerPreference,
  selectEffectiveSkillTriggerPreference,
  selectEffectiveSkillTriggerRecord,
} from '../../src/utils/skill-trigger-preferences.js';

const tempDirs: string[] = [];

const CLAUDE_SKILL_AUTO_TRUE = `---
name: commit
description: Commit skill
user-invocable: true
disable-model-invocation: false
---

# Commit
`;

const CLAUDE_SKILL_AUTO_FALSE = `---
name: commit
description: Commit skill
user-invocable: false
disable-model-invocation: false
---

# Commit
`;

const CLAUDE_SKILL_PLATFORM_DEFAULTS = `---
name: commit
description: Commit skill
---

# Commit
`;

const CODEX_SKILL_AUTO_TRUE = `policy:
  allow_implicit_invocation: true
`;

const CODEX_SKILL_AUTO_FALSE = `policy:
  allow_implicit_invocation: false
`;

const CODEX_SKILL_EMPTY_POLICY = `policy: {}
`;

const CODEX_SKILL_WITHOUT_POLICY = `name: commit
`;

interface BundleSkillDefinition {
  claude: string;
  codex: string;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeBundlePlugin(options: {
  rootDir: string;
  pluginName?: string;
  skillTriggers?: Record<string, { allowInstallOverride: boolean }>;
  artifacts?: {
    targets: Array<Record<string, unknown>>;
  };
  skills: Record<string, BundleSkillDefinition>;
}): Promise<string> {
  const pluginName = options.pluginName ?? 'git-commit';
  const pluginRoot = path.join(options.rootDir, 'plugins', pluginName);

  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    {
      name: pluginName,
      version: '0.1.0',
      description: `${pluginName} plugin`,
      skills: './skills',
      skillTriggers: options.skillTriggers,
      artifacts: options.artifacts,
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

  for (const [skillName, skill] of Object.entries(options.skills)) {
    const claudePath = path.join(pluginRoot, 'claude', 'skills', skillName, 'SKILL.md');
    const codexPath = path.join(pluginRoot, 'codex', 'skills', skillName, 'agents', 'openai.yaml');
    await fs.ensureDir(path.dirname(claudePath));
    await fs.ensureDir(path.dirname(codexPath));
    await fs.writeFile(claudePath, skill.claude, 'utf8');
    await fs.writeFile(codexPath, skill.codex, 'utf8');
  }

  return pluginRoot;
}

async function copyToMarketplace(embeddedRoot: string): Promise<string> {
  const marketplaceRoot = await makeTempDir('aw-skill-trigger-marketplace-');
  await fs.copy(embeddedRoot, marketplaceRoot);
  return marketplaceRoot;
}

function codexSkillPath(rootDir: string, skillName = 'commit', pluginName = 'git-commit'): string {
  return path.join(rootDir, 'plugins', pluginName, 'codex', 'skills', skillName, 'agents', 'openai.yaml');
}

function claudeSkillPath(rootDir: string, skillName = 'commit', pluginName = 'git-commit'): string {
  return path.join(rootDir, 'plugins', pluginName, 'claude', 'skills', skillName, 'SKILL.md');
}

async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

function createLedgerScopeRecord(options: {
  preference?: 'default' | 'manual' | 'auto';
  updatedAt?: string;
  writeOrder?: number;
} = {}) {
  return {
    managed: true,
    updatedAt: options.updatedAt ?? '2026-04-28T00:00:00.000Z',
    resolvedVersion: '0.1.0',
    capabilitySnapshot: {
      requiresNativePlugin: true,
    },
    installOptions: options.preference
      ? {
          skillTriggerPreference: options.preference,
        }
      : undefined,
    skillTriggerWriteOrder: options.writeOrder,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('skill trigger preferences', () => {
  it('materializes Codex manual/auto/default and ignores tampered local manifests', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-embedded-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });

    const marketplaceRoot = await copyToMarketplace(embeddedRoot);
    await fs.writeJson(
      path.join(marketplaceRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
      {
        name: 'git-commit',
        version: '0.1.0',
        description: 'tampered local manifest',
        skills: './skills',
        skillTriggers: {
          commit: {
            allowInstallOverride: false,
          },
        },
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

    const policies = await resolveSkillTriggerPolicies({
      embeddedRoot,
      pluginName: 'git-commit',
      platform: 'codex',
    });
    expect(policies.policies).toEqual([
      expect.objectContaining({
        skillName: 'commit',
        allowInstallOverride: true,
      }),
    ]);
    expect(policies.applicability).toBe('overridable');

    await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'manual',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });
    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toContain('allow_implicit_invocation: false');

    await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'auto',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });
    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toContain('allow_implicit_invocation: true');

    await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'default',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'bestEffortReplay',
    });
    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toBe(CODEX_SKILL_AUTO_TRUE);
  });

  it('excludes manifest-declared codex.skill keys from static Codex materialization and uninstall rematerialize', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-dynamic-embedded-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      artifacts: {
        targets: [{
          id: 'commit-skill',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.skill',
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'commit',
        }],
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });

    const marketplaceRoot = await copyToMarketplace(embeddedRoot);
    const policies = await resolveSkillTriggerPolicies({
      embeddedRoot,
      pluginName: 'git-commit',
      platform: 'codex',
    });
    expect(policies.applicability).toBe('none');
    expect(policies.policies).toEqual([]);

    const materialization = await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'manual',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });
    expect(materialization.generatedArtifacts).toEqual([]);
    expect(materialization.summary.status).toBe('skipped');
    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toBe(CODEX_SKILL_AUTO_TRUE);

    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: createLedgerScopeRecord({
            preference: 'manual',
            writeOrder: 1,
          }),
        },
      },
    };
    const rematerialization = await rematerializeSkillTriggerPreferenceAfterUninstall({
      pluginName: 'git-commit',
      platform: 'codex',
      ledgerAfterUninstall: ledger,
      embeddedRoot,
      marketplaceRoot,
    });
    expect(rematerialization.materialization?.generatedArtifacts ?? []).toEqual([]);
    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toBe(CODEX_SKILL_AUTO_TRUE);
  });

  it('materializes Claude manual/auto/default and restores pristine user-invocable values', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-embedded-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_FALSE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });
    const marketplaceRoot = await copyToMarketplace(embeddedRoot);

    await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'claude',
      resolvedOptions: {
        skillTriggerPreference: 'manual',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });
    const manualContent = await readFile(claudeSkillPath(marketplaceRoot));
    expect(manualContent).toContain('disable-model-invocation: true');
    expect(manualContent).toContain('user-invocable: true');

    await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'claude',
      resolvedOptions: {
        skillTriggerPreference: 'auto',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });
    const autoContent = await readFile(claudeSkillPath(marketplaceRoot));
    expect(autoContent).toContain('disable-model-invocation: false');
    expect(autoContent).toContain('user-invocable: false');

    await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'claude',
      resolvedOptions: {
        skillTriggerPreference: 'default',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'bestEffortReplay',
    });
    await expect(readFile(claudeSkillPath(marketplaceRoot))).resolves.toBe(CLAUDE_SKILL_AUTO_FALSE);
  });

  it('resolves skill trigger inventory per platform without cross-reading foreign skills', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-platform-scope-');
    const pluginRoot = await writeBundlePlugin({
      rootDir: embeddedRoot,
      pluginName: 'platform-scoped-plugin',
      skillTriggers: {
        'codex-only': {
          allowInstallOverride: true,
        },
      },
      skills: {
        'codex-only': {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });
    await fs.remove(path.join(pluginRoot, 'claude', 'skills', 'codex-only'));
    await fs.ensureDir(path.join(pluginRoot, 'claude', 'skills', 'claude-only'));
    await fs.writeFile(
      path.join(pluginRoot, 'claude', 'skills', 'claude-only', 'SKILL.md'),
      CLAUDE_SKILL_AUTO_TRUE,
      'utf8',
    );

    const codexPolicies = await resolveSkillTriggerPolicies({
      embeddedRoot,
      pluginName: 'platform-scoped-plugin',
      platform: 'codex',
    });
    const claudePolicies = await resolveSkillTriggerPolicies({
      embeddedRoot,
      pluginName: 'platform-scoped-plugin',
      platform: 'claude',
    });

    expect(codexPolicies.applicability).toBe('overridable');
    expect(codexPolicies.policies.map((policy) => policy.skillName)).toEqual(['codex-only']);
    expect(claudePolicies.applicability).toBe('fixed');
    expect(claudePolicies.policies.map((policy) => policy.skillName)).toEqual(['claude-only']);
  });

  it('supports Codex project repoSkill materialization targets without touching shared runtime layout', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-repo-skill-embedded-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      pluginName: 'repo-skill-plugin',
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });
    const repoSkillsRoot = await makeTempDir('aw-skill-trigger-repo-skills-');

    const result = await materializeSkillTriggerPreference({
      pluginName: 'repo-skill-plugin',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'manual',
      },
      embeddedRoot,
      target: {
        platform: 'codex',
        scope: 'project',
        kind: 'repoSkill',
        root: repoSkillsRoot,
      },
      mode: 'strictExplicit',
    });

    await expect(
      readFile(path.join(repoSkillsRoot, 'commit', 'agents', 'openai.yaml')),
    ).resolves.toContain('allow_implicit_invocation: false');
    expect(result.rollbackHandle.operations).toHaveLength(1);
    await commitMaterializedSkillTriggerPreference(result.rollbackHandle);
    expect(result.rollbackHandle.committed).toBe(false);
  });

  it('keeps pristine skills and warns when manual or auto targets non-overridable skills', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-embedded-');
    const invalidYaml = 'policy: [\n';
    const invalidFrontmatter = `---
name: commit
description: Broken skill
user-invocable: "true"
---

# Broken
`;
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {},
      skills: {
        commit: {
          claude: invalidFrontmatter,
          codex: invalidYaml,
        },
      },
    });
    const marketplaceRoot = await copyToMarketplace(embeddedRoot);

    const codexResult = await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'manual',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });
    expect(codexResult.summary.status).toBe('skipped');
    expect(codexResult.warnings[0]).toContain('allowInstallOverride');
    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toBe(invalidYaml);

    const claudeResult = await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'claude',
      resolvedOptions: {
        skillTriggerPreference: 'auto',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });
    expect(claudeResult.summary.status).toBe('skipped');
    expect(claudeResult.warnings[0]).toContain('allowInstallOverride');
    await expect(readFile(claudeSkillPath(marketplaceRoot))).resolves.toBe(invalidFrontmatter);
  });

  it('does not let malformed non-overridable skills block other overridable skills', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-embedded-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
        locked: {
          claude: '---\nname: locked\ndescription: locked\nuser-invocable: "oops"\n---\n',
          codex: 'policy: [\n',
        },
      },
    });
    const marketplaceRoot = await copyToMarketplace(embeddedRoot);

    await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'manual',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });

    await expect(readFile(codexSkillPath(marketplaceRoot, 'commit'))).resolves.toContain('allow_implicit_invocation: false');
    await expect(readFile(codexSkillPath(marketplaceRoot, 'locked'))).resolves.toBe('policy: [\n');
  });

  it('does not parse malformed skills on the default path', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-embedded-');
    const malformedClaude = `---
name: commit
description: Broken
user-invocable: "true"
---
`;
    const malformedCodex = 'policy: [\n';
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: malformedClaude,
          codex: malformedCodex,
        },
      },
    });
    const marketplaceRoot = await copyToMarketplace(embeddedRoot);

    await expect(
      materializeSkillTriggerPreference({
        pluginName: 'git-commit',
        platform: 'codex',
        resolvedOptions: {
          skillTriggerPreference: 'default',
        },
        embeddedRoot,
        marketplaceRootOrStagingRoot: marketplaceRoot,
        mode: 'bestEffortReplay',
      }),
    ).resolves.toMatchObject({
      summary: {
        status: 'pristine',
      },
    });
    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toBe(malformedCodex);
  });

  it('fails fast for malformed overridable Codex skills and leaves the marketplace untouched before commit', async () => {
    const cases = [
      {
        name: 'missing openai.yaml',
        skill: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
        mutate: async (embeddedRoot: string) => {
          await fs.remove(codexSkillPath(embeddedRoot));
        },
        expected: '缺少 agents/openai.yaml',
      },
      {
        name: 'invalid yaml',
        skill: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: 'policy: [\n',
        },
        expected: 'YAML 解析失败',
      },
      {
        name: 'policy not object',
        skill: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: 'policy: false\n',
        },
        expected: 'policy 必须是 object',
      },
    ] as const;

    for (const testCase of cases) {
      const embeddedRoot = await makeTempDir(`aw-skill-trigger-codex-${testCase.name.replace(/\s+/g, '-')}-`);
      await writeBundlePlugin({
        rootDir: embeddedRoot,
        skillTriggers: {
          commit: {
            allowInstallOverride: true,
          },
        },
        skills: {
          commit: testCase.skill,
        },
      });
      await testCase.mutate?.(embeddedRoot);
      const marketplaceRoot = await copyToMarketplace(embeddedRoot);
      await fs.writeFile(codexSkillPath(marketplaceRoot), '# local-before\n', 'utf8');

      await expect(
        materializeSkillTriggerPreference({
          pluginName: 'git-commit',
          platform: 'codex',
          resolvedOptions: {
            skillTriggerPreference: 'manual',
          },
          embeddedRoot,
          marketplaceRootOrStagingRoot: marketplaceRoot,
          mode: 'strictExplicit',
        }),
      ).rejects.toThrow(testCase.expected);
      await expect(
        materializeSkillTriggerPreference({
          pluginName: 'git-commit',
          platform: 'codex',
          resolvedOptions: {
            skillTriggerPreference: 'manual',
          },
          embeddedRoot,
          marketplaceRootOrStagingRoot: marketplaceRoot,
          mode: 'strictExplicit',
        }),
      ).rejects.toThrow(/git-commit.*codex.*commit.*openai\.yaml/);
      await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toBe('# local-before\n');
    }
  });

  it('fails fast for malformed overridable Claude skills and leaves the marketplace untouched before commit', async () => {
    const cases = [
      {
        name: 'missing frontmatter',
        skill: {
          claude: '# missing frontmatter\n',
          codex: CODEX_SKILL_AUTO_TRUE,
        },
        expected: '缺少 YAML frontmatter',
      },
      {
        name: 'invalid frontmatter yaml',
        skill: {
          claude: '---\nname: [\n---\n',
          codex: CODEX_SKILL_AUTO_TRUE,
        },
        expected: 'frontmatter YAML 解析失败',
      },
      {
        name: 'frontmatter root not object',
        skill: {
          claude: '---\n- item\n---\n',
          codex: CODEX_SKILL_AUTO_TRUE,
        },
        expected: 'frontmatter 根节点必须是 object',
      },
    ] as const;

    for (const testCase of cases) {
      const embeddedRoot = await makeTempDir(`aw-skill-trigger-claude-${testCase.name.replace(/\s+/g, '-')}-`);
      await writeBundlePlugin({
        rootDir: embeddedRoot,
        skillTriggers: {
          commit: {
            allowInstallOverride: true,
          },
        },
        skills: {
          commit: testCase.skill,
        },
      });
      const marketplaceRoot = await copyToMarketplace(embeddedRoot);
      await fs.writeFile(claudeSkillPath(marketplaceRoot), '# local-before\n', 'utf8');

      await expect(
        materializeSkillTriggerPreference({
          pluginName: 'git-commit',
          platform: 'claude',
          resolvedOptions: {
            skillTriggerPreference: 'manual',
          },
          embeddedRoot,
          marketplaceRootOrStagingRoot: marketplaceRoot,
          mode: 'strictExplicit',
        }),
      ).rejects.toThrow(testCase.expected);
      await expect(
        materializeSkillTriggerPreference({
          pluginName: 'git-commit',
          platform: 'claude',
          resolvedOptions: {
            skillTriggerPreference: 'manual',
          },
          embeddedRoot,
          marketplaceRootOrStagingRoot: marketplaceRoot,
          mode: 'strictExplicit',
        }),
      ).rejects.toThrow(/git-commit.*claude.*commit.*SKILL\.md/);
      await expect(readFile(claudeSkillPath(marketplaceRoot))).resolves.toBe('# local-before\n');
    }
  });

  it('restores the previous subtree when rollback runs after a committed materialization', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-embedded-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });
    const marketplaceRoot = await copyToMarketplace(embeddedRoot);
    const originalContent = 'policy:\n  allow_implicit_invocation: false\n  note: local\n';
    await fs.writeFile(codexSkillPath(marketplaceRoot), originalContent, 'utf8');

    const result = await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'auto',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });

    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toContain('allow_implicit_invocation: true');
    await rollbackMaterializedSkillTriggerPreference(result.rollbackHandle);
    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toBe(originalContent);
  });

  it('materializes Codex project repo skills into .agents/skills and reports tracking artifacts', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-embedded-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });
    const repoRoot = await makeTempDir('aw-repo-skill-root-');
    const repoSkillsRoot = path.join(repoRoot, '.agents', 'skills');

    const result = await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'manual',
      },
      embeddedRoot,
      target: {
        platform: 'codex',
        scope: 'project',
        kind: 'repoSkill',
        root: repoSkillsRoot,
      },
      mode: 'strictExplicit',
    });

    await expect(
      readFile(path.join(repoSkillsRoot, 'commit', 'agents', 'openai.yaml')),
    ).resolves.toContain('allow_implicit_invocation: false');
    expect(result.generatedArtifacts).toEqual([{
      path: path.join(repoSkillsRoot, 'commit'),
      kind: 'skill',
      platform: 'codex',
      artifactKey: 'commit',
    }]);
    await expect(readFile(codexSkillPath(embeddedRoot))).resolves.toContain('allow_implicit_invocation: true');
  });

  it('cleans the previous subtree backup after a committed materialization is finalized', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-embedded-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });
    const marketplaceRoot = await copyToMarketplace(embeddedRoot);
    const originalContent = 'policy:\n  allow_implicit_invocation: false\n';
    await fs.writeFile(codexSkillPath(marketplaceRoot), originalContent, 'utf8');

    const result = await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'auto',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });

    const backupSkillsRoot = result.rollbackHandle.backupSkillsRoot;
    expect(backupSkillsRoot).not.toBeNull();
    await expect(fs.pathExists(backupSkillsRoot!)).resolves.toBe(true);

    await commitMaterializedSkillTriggerPreference(result.rollbackHandle);

    await expect(fs.pathExists(backupSkillsRoot!)).resolves.toBe(false);
    expect(result.rollbackHandle.committed).toBe(false);
    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toContain('allow_implicit_invocation: true');
  });

  it('bestEffortReplay skips malformed overridable skills while strictExplicit fails on the same fixture', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-embedded-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: 'policy: [\n',
        },
      },
    });
    const marketplaceRoot = await copyToMarketplace(embeddedRoot);

    const bestEffort = await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'manual',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'bestEffortReplay',
    });
    expect(bestEffort.summary.status).toBe('skipped');
    expect(bestEffort.warnings[0]).toContain('跳过覆盖');
    await expect(readFile(codexSkillPath(marketplaceRoot))).resolves.toBe('policy: [\n');

    await expect(
      materializeSkillTriggerPreference({
        pluginName: 'git-commit',
        platform: 'codex',
        resolvedOptions: {
          skillTriggerPreference: 'manual',
        },
        embeddedRoot,
        marketplaceRootOrStagingRoot: marketplaceRoot,
        mode: 'strictExplicit',
      }),
    ).rejects.toThrow('YAML 解析失败');
  });

  it('builds semantic signatures that ignore YAML formatting and distinguishes equivalent and different preferences', async () => {
    const equivalentRoot = await makeTempDir('aw-skill-trigger-equivalent-');
    await writeBundlePlugin({
      rootDir: equivalentRoot,
      pluginName: 'equivalent-plugin',
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: `---
disable-model-invocation: false
description: Commit skill
name: commit
user-invocable: true
---

# Commit
`,
          codex: '# comment\npolicy:\n  allow_implicit_invocation: true\n',
        },
      },
    });
    const equivalentOtherRoot = await makeTempDir('aw-skill-trigger-equivalent-alt-');
    await writeBundlePlugin({
      rootDir: equivalentOtherRoot,
      pluginName: 'equivalent-plugin',
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });

    const signatureA = await buildSkillTriggerMaterializationSignature({
      pluginName: 'equivalent-plugin',
      platform: 'codex',
      preference: 'default',
      embeddedRoot: equivalentRoot,
    });
    const signatureB = await buildSkillTriggerMaterializationSignature({
      pluginName: 'equivalent-plugin',
      platform: 'codex',
      preference: 'default',
      embeddedRoot: equivalentOtherRoot,
    });

    expect(signatureA).toMatchObject({ status: 'known' });
    expect(signatureB).toMatchObject({ status: 'known' });
    if (signatureA.status === 'known' && signatureB.status === 'known') {
      expect(signatureA.signature).toBe(signatureB.signature);
    }

    const defaultSignature = await buildSkillTriggerMaterializationSignature({
      pluginName: 'equivalent-plugin',
      platform: 'codex',
      preference: 'default',
      embeddedRoot: equivalentRoot,
    });
    const autoSignature = await buildSkillTriggerMaterializationSignature({
      pluginName: 'equivalent-plugin',
      platform: 'codex',
      preference: 'auto',
      embeddedRoot: equivalentRoot,
    });
    if (defaultSignature.status === 'known' && autoSignature.status === 'known') {
      expect(defaultSignature.signature).toBe(autoSignature.signature);
    }

    const differentRoot = await makeTempDir('aw-skill-trigger-different-');
    await writeBundlePlugin({
      rootDir: differentRoot,
      pluginName: 'different-plugin',
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_FALSE,
          codex: CODEX_SKILL_AUTO_FALSE,
        },
      },
    });

    const differentDefault = await buildSkillTriggerMaterializationSignature({
      pluginName: 'different-plugin',
      platform: 'codex',
      preference: 'default',
      embeddedRoot: differentRoot,
    });
    const differentAuto = await buildSkillTriggerMaterializationSignature({
      pluginName: 'different-plugin',
      platform: 'codex',
      preference: 'auto',
      embeddedRoot: differentRoot,
    });
    if (differentDefault.status === 'known' && differentAuto.status === 'known') {
      expect(differentDefault.signature).not.toBe(differentAuto.signature);
    }
  });

  it('normalizes Codex platform default values when building skill trigger signatures', async () => {
    const cases = [
      {
        pluginName: 'codex-empty-policy-plugin',
        codex: CODEX_SKILL_EMPTY_POLICY,
      },
      {
        pluginName: 'codex-without-policy-plugin',
        codex: CODEX_SKILL_WITHOUT_POLICY,
      },
    ];

    for (const testCase of cases) {
      const embeddedRoot = await makeTempDir(`aw-skill-trigger-${testCase.pluginName}-`);
      await writeBundlePlugin({
        rootDir: embeddedRoot,
        pluginName: testCase.pluginName,
        skillTriggers: {
          commit: {
            allowInstallOverride: true,
          },
        },
        skills: {
          commit: {
            claude: CLAUDE_SKILL_AUTO_TRUE,
            codex: testCase.codex,
          },
        },
      });

      const defaultSignature = await buildSkillTriggerMaterializationSignature({
        pluginName: testCase.pluginName,
        platform: 'codex',
        preference: 'default',
        embeddedRoot,
      });
      const autoSignature = await buildSkillTriggerMaterializationSignature({
        pluginName: testCase.pluginName,
        platform: 'codex',
        preference: 'auto',
        embeddedRoot,
      });

      expect(defaultSignature).toMatchObject({ status: 'known' });
      expect(autoSignature).toMatchObject({ status: 'known' });
      if (defaultSignature.status === 'known' && autoSignature.status === 'known') {
        expect(defaultSignature.signature).toBe(autoSignature.signature);
        expect(defaultSignature.entries).toEqual([
          {
            skillName: 'commit',
            allowInstallOverride: true,
            allowImplicitInvocation: true,
          },
        ]);
      }

      const marketplaceRoot = await copyToMarketplace(embeddedRoot);
      const runtimeSignature = await readCurrentSkillTriggerRuntimeSignature({
        pluginName: testCase.pluginName,
        platform: 'codex',
        marketplaceRoot,
        embeddedRoot,
      });
      expect(runtimeSignature).toMatchObject({ status: 'known' });
      if (runtimeSignature.status === 'known' && defaultSignature.status === 'known') {
        expect(runtimeSignature.signature).toBe(defaultSignature.signature);
      }
    }
  });

  it('normalizes platform default values when building Claude skill trigger signatures', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-claude-defaults-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      pluginName: 'claude-defaults-plugin',
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_PLATFORM_DEFAULTS,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });

    const defaultSignature = await buildSkillTriggerMaterializationSignature({
      pluginName: 'claude-defaults-plugin',
      platform: 'claude',
      preference: 'default',
      embeddedRoot,
    });
    const autoSignature = await buildSkillTriggerMaterializationSignature({
      pluginName: 'claude-defaults-plugin',
      platform: 'claude',
      preference: 'auto',
      embeddedRoot,
    });
    expect(defaultSignature).toMatchObject({ status: 'known' });
    expect(autoSignature).toMatchObject({ status: 'known' });
    if (defaultSignature.status === 'known' && autoSignature.status === 'known') {
      expect(defaultSignature.signature).toBe(autoSignature.signature);
      expect(defaultSignature.entries).toEqual([
        {
          skillName: 'commit',
          allowInstallOverride: true,
          disableModelInvocation: false,
          userInvocable: true,
        },
      ]);
    }

    const marketplaceRoot = await copyToMarketplace(embeddedRoot);
    await materializeSkillTriggerPreference({
      pluginName: 'claude-defaults-plugin',
      platform: 'claude',
      resolvedOptions: {
        skillTriggerPreference: 'auto',
      },
      embeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });
    const runtimeSignature = await readCurrentSkillTriggerRuntimeSignature({
      pluginName: 'claude-defaults-plugin',
      platform: 'claude',
      marketplaceRoot,
      embeddedRoot,
    });
    expect(runtimeSignature).toMatchObject({ status: 'known' });
    if (runtimeSignature.status === 'known' && defaultSignature.status === 'known') {
      expect(runtimeSignature.signature).toBe(defaultSignature.signature);
    }
  });

  it('returns structured unknown signatures for malformed pristine skills and reads runtime coverage from embedded policies', async () => {
    const embeddedRoot = await makeTempDir('aw-skill-trigger-embedded-');
    await writeBundlePlugin({
      rootDir: embeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: 'policy: [\n',
        },
      },
    });
    const signature = await buildSkillTriggerMaterializationSignature({
      pluginName: 'git-commit',
      platform: 'codex',
      preference: 'manual',
      embeddedRoot,
    });
    expect(signature).toMatchObject({
      status: 'unknown',
      pluginName: 'git-commit',
      platform: 'codex',
      preference: 'manual',
    });
    if (signature.status === 'unknown') {
      expect(signature.diagnostics[0]).toMatchObject({
        skillName: 'commit',
      });
      expect(signature.diagnostics[0].filePath).toContain('openai.yaml');
      expect(signature.diagnostics[0].reason).toContain('YAML 解析失败');
    }

    const readableEmbeddedRoot = await makeTempDir('aw-skill-trigger-embedded-readable-');
    await writeBundlePlugin({
      rootDir: readableEmbeddedRoot,
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });
    const marketplaceRoot = await copyToMarketplace(readableEmbeddedRoot);
    await fs.writeJson(
      path.join(marketplaceRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
      {
        name: 'git-commit',
        version: '0.1.0',
        description: 'tampered local manifest',
        skills: './skills',
        skillTriggers: {},
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

    await materializeSkillTriggerPreference({
      pluginName: 'git-commit',
      platform: 'codex',
      resolvedOptions: {
        skillTriggerPreference: 'manual',
      },
      embeddedRoot: readableEmbeddedRoot,
      marketplaceRootOrStagingRoot: marketplaceRoot,
      mode: 'strictExplicit',
    });
    const runtimeSignature = await readCurrentSkillTriggerRuntimeSignature({
      pluginName: 'git-commit',
      platform: 'codex',
      marketplaceRoot,
      embeddedRoot: readableEmbeddedRoot,
    });
    const manualSignature = await buildSkillTriggerMaterializationSignature({
      pluginName: 'git-commit',
      platform: 'codex',
      preference: 'manual',
      embeddedRoot: readableEmbeddedRoot,
    });
    expect(runtimeSignature).toMatchObject({ status: 'known' });
    expect(manualSignature).toMatchObject({ status: 'known' });
    if (runtimeSignature.status === 'known' && manualSignature.status === 'known') {
      expect(runtimeSignature.signature).toBe(manualSignature.signature);
    }
  });

  it('selects stable winners and next write orders from available ledgers', () => {
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: createLedgerScopeRecord({
            preference: 'default',
            updatedAt: '2026-04-28T00:00:00.000Z',
            writeOrder: 3,
          }),
          projectScopes: {
            '/repo-b': createLedgerScopeRecord({
              preference: 'manual',
              updatedAt: '2026-04-28T00:00:00.000Z',
              writeOrder: 4,
            }),
            '/repo-a': createLedgerScopeRecord({
              preference: 'auto',
              updatedAt: '2026-04-28T00:00:00.000Z',
              writeOrder: 4,
            }),
          },
        },
      },
    };

    expect(getNextSkillTriggerWriteOrder({
      ledger,
      pluginName: 'git-commit',
      platform: 'codex',
    })).toBe(5);
    expect(selectEffectiveSkillTriggerRecord({
      ledger,
      pluginName: 'git-commit',
      platform: 'codex',
    })).toMatchObject({
      scopeIdentity: 'user',
      preference: 'default',
    });
    expect(selectEffectiveSkillTriggerPreference({
      ledger,
      pluginName: 'git-commit',
      platform: 'codex',
    })).toBe('default');
  });

  it('collects sibling conflict warnings based on runtime semantics and skips deterministic warnings for unknown or degraded signatures', async () => {
    const changingRoot = await makeTempDir('aw-skill-trigger-conflict-changing-');
    await writeBundlePlugin({
      rootDir: changingRoot,
      pluginName: 'changing-plugin',
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });

    const ledgerBefore = createAvailableLedger();
    ledgerBefore.plugins['changing-plugin'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: createLedgerScopeRecord({
            preference: 'default',
            writeOrder: 5,
          }),
          projectScopes: {
            '/repo-project': createLedgerScopeRecord({
              preference: 'default',
              writeOrder: 4,
            }),
          },
        },
      },
    };
    const ledgerAfter = structuredClone(ledgerBefore) as InstalledLedger;
    ledgerAfter.plugins['changing-plugin'].platforms.codex!.userScope = createLedgerScopeRecord({
      preference: 'manual',
      writeOrder: 6,
    });

    const warnings = await collectSkillTriggerSiblingConflictWarnings({
      ledgerBefore,
      ledgerAfter,
      pluginName: 'changing-plugin',
      platform: 'codex',
      writtenScopeIdentity: 'user',
      runtimeSignatureBefore: await buildSkillTriggerMaterializationSignature({
        pluginName: 'changing-plugin',
        platform: 'codex',
        preference: 'default',
        embeddedRoot: changingRoot,
      }),
      plannedRuntimeSignatureAfter: await buildSkillTriggerMaterializationSignature({
        pluginName: 'changing-plugin',
        platform: 'codex',
        preference: 'manual',
        embeddedRoot: changingRoot,
      }),
      embeddedRoot: changingRoot,
    });
    expect(warnings.warnings).toEqual([]);
    expect(warnings.diagnostics).toEqual([]);

    const equivalentRoot = await makeTempDir('aw-skill-trigger-conflict-equivalent-');
    await writeBundlePlugin({
      rootDir: equivalentRoot,
      pluginName: 'equivalent-plugin',
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: CODEX_SKILL_AUTO_TRUE,
        },
      },
    });
    const equivalentBefore = createAvailableLedger();
    equivalentBefore.plugins['equivalent-plugin'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: createLedgerScopeRecord({
            preference: 'default',
            writeOrder: 5,
          }),
          projectScopes: {
            '/repo-project': createLedgerScopeRecord({
              preference: 'auto',
              writeOrder: 4,
            }),
          },
        },
      },
    };
    const equivalentAfter = structuredClone(equivalentBefore) as InstalledLedger;
    equivalentAfter.plugins['equivalent-plugin'].platforms.codex!.projectScopes!['/repo-project'] = createLedgerScopeRecord({
      preference: 'auto',
      writeOrder: 6,
    });
    const equivalentWarnings = await collectSkillTriggerSiblingConflictWarnings({
      ledgerBefore: equivalentBefore,
      ledgerAfter: equivalentAfter,
      pluginName: 'equivalent-plugin',
      platform: 'codex',
      writtenScopeIdentity: 'project:/repo-project',
      runtimeSignatureBefore: await buildSkillTriggerMaterializationSignature({
        pluginName: 'equivalent-plugin',
        platform: 'codex',
        preference: 'default',
        embeddedRoot: equivalentRoot,
      }),
      plannedRuntimeSignatureAfter: await buildSkillTriggerMaterializationSignature({
        pluginName: 'equivalent-plugin',
        platform: 'codex',
        preference: 'auto',
        embeddedRoot: equivalentRoot,
      }),
      embeddedRoot: equivalentRoot,
    });
    expect(equivalentWarnings.warnings).toEqual([]);

    const unknownRoot = await makeTempDir('aw-skill-trigger-conflict-unknown-');
    await writeBundlePlugin({
      rootDir: unknownRoot,
      pluginName: 'unknown-plugin',
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      skills: {
        commit: {
          claude: CLAUDE_SKILL_AUTO_TRUE,
          codex: 'policy: [\n',
        },
      },
    });
    const unknownLedger = createAvailableLedger();
    unknownLedger.plugins['unknown-plugin'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: createLedgerScopeRecord({
            preference: 'default',
            writeOrder: 5,
          }),
          projectScopes: {
            '/repo-project': createLedgerScopeRecord({
              preference: 'manual',
              writeOrder: 4,
            }),
          },
        },
      },
    };
    const unknownResult = await collectSkillTriggerSiblingConflictWarnings({
      ledgerBefore: unknownLedger,
      ledgerAfter: unknownLedger,
      pluginName: 'unknown-plugin',
      platform: 'codex',
      writtenScopeIdentity: 'user',
      runtimeSignatureBefore: await buildSkillTriggerMaterializationSignature({
        pluginName: 'unknown-plugin',
        platform: 'codex',
        preference: 'default',
        embeddedRoot: unknownRoot,
      }),
      plannedRuntimeSignatureAfter: await buildSkillTriggerMaterializationSignature({
        pluginName: 'unknown-plugin',
        platform: 'codex',
        preference: 'manual',
        embeddedRoot: unknownRoot,
      }),
      embeddedRoot: unknownRoot,
    });
    expect(unknownResult.warnings).toEqual([]);
    expect(unknownResult.diagnostics.join('\n')).toContain('跳过 skill trigger sibling 冲突判断');

    const degradedLedger = structuredClone(ledgerBefore) as InstalledLedger;
    degradedLedger.ledgerState = {
      status: 'degraded',
      degradedAt: '2026-04-28T00:00:00.000Z',
      reason: 'operation_interrupted_after_native_write',
    };
    const degradedResult = await collectSkillTriggerSiblingConflictWarnings({
      ledgerBefore: degradedLedger,
      ledgerAfter: degradedLedger,
      pluginName: 'changing-plugin',
      platform: 'codex',
      writtenScopeIdentity: 'user',
      runtimeSignatureBefore: await buildSkillTriggerMaterializationSignature({
        pluginName: 'changing-plugin',
        platform: 'codex',
        preference: 'default',
        embeddedRoot: changingRoot,
      }),
      plannedRuntimeSignatureAfter: await buildSkillTriggerMaterializationSignature({
        pluginName: 'changing-plugin',
        platform: 'codex',
        preference: 'manual',
        embeddedRoot: changingRoot,
      }),
      embeddedRoot: changingRoot,
    });
    expect(degradedResult.warnings).toEqual([]);
    expect(degradedResult.diagnostics[0]).toContain('installed.json 不是 available');
  });

  it('supports direct patch helpers for Codex and Claude skill metadata', async () => {
    const rootDir = await makeTempDir('aw-skill-trigger-patch-');
    const codexPath = path.join(rootDir, 'openai.yaml');
    const claudePath = path.join(rootDir, 'SKILL.md');
    await fs.writeFile(codexPath, CODEX_SKILL_AUTO_FALSE, 'utf8');
    await fs.writeFile(claudePath, CLAUDE_SKILL_AUTO_FALSE, 'utf8');

    await patchCodexOpenAiYaml(codexPath, 'auto');
    await patchClaudeSkillFrontmatter(claudePath, 'manual');

    await expect(readFile(codexPath)).resolves.toContain('allow_implicit_invocation: true');
    const claude = await readFile(claudePath);
    expect(claude).toContain('disable-model-invocation: true');
    expect(claude).toContain('user-invocable: true');
  });
});
