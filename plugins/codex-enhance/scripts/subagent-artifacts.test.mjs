import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  renderArtifactPlan,
  renderSubagentRoleDeveloperInstructions,
} from './render-artifacts.mjs';

const SHORT_DESCRIPTION = '子代理任务分类、参数选择、上下文继承、等待与清理原则';
const stagedArtifactSourcePath = fileURLToPath(
  new URL(
    '../.agents-plugin/artifact-sources/codex/codex-subagent-guide-skill/0/',
    import.meta.url,
  ),
);
const stagedExploreArtifactSourcePath = fileURLToPath(
  new URL('../.agents-plugin/artifact-sources/codex/codex-explore-skill/0/', import.meta.url),
);
const artifactSourcePath = existsSync(stagedArtifactSourcePath)
  ? stagedArtifactSourcePath
  : fileURLToPath(new URL('../skills/codex-subagent-guide/', import.meta.url));
const exploreArtifactSourcePath = existsSync(stagedExploreArtifactSourcePath)
  ? stagedExploreArtifactSourcePath
  : fileURLToPath(new URL('../skills/codex-explore/', import.meta.url));
const ROLE_EXPECTATIONS = [
  {
    artifactId: 'codex-subagent-role',
    roleKey: 'codex-subagent',
  },
];
const PROFILE_KEYS = ['simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile'];

function createContext(values = {}) {
  return {
    event: 'install',
    platform: 'codex',
    scope: 'user',
    plugin: {
      name: 'codex-enhance',
      version: '0.2.0',
    },
    requestedArtifactIds: [
      'codex-explore-skill',
      'codex-explore-role',
      'codex-subagent-guide-skill',
      ...ROLE_EXPECTATIONS.map((role) => role.artifactId),
    ],
    artifactSources: [
      {
        id: 'codex-explore-skill',
        target: 'codex.skill',
        sourceDirs: [exploreArtifactSourcePath],
      },
      {
        id: 'codex-subagent-guide-skill',
        target: 'codex.skill',
        sourceDirs: [artifactSourcePath],
      },
    ],
    config: {
      mode: 'artifact-render',
      targetScope: 'user',
      values,
    },
  };
}

function artifactsFrom(plan) {
  assert.equal(plan.version, 2);
  assert.equal(plan.artifacts.length, 4);

  const skill = plan.artifacts.find((artifact) => artifact.id === 'codex-subagent-guide-skill');
  assert.ok(skill, 'missing skill artifact');
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.target, 'codex.skill');
  assert.equal(skill.skillKey, 'codex-subagent-guide');
  assert.deepEqual(skill.refreshKeys, PROFILE_KEYS);
  assert.equal(skill.state, 'present');
  assert.equal('skillFile' in skill.content, false);
  assert.equal('openaiYaml' in skill.content, false);
  assert.equal(typeof skill.content.files['SKILL.md'], 'string');
  assert.equal(skill.content.files['agents/openai.yaml'], undefined);

  const roles = new Map();
  for (const expected of ROLE_EXPECTATIONS) {
    const role = plan.artifacts.find((artifact) => artifact.id === expected.artifactId);
    assert.ok(role, `missing role artifact ${expected.artifactId}`);
    assert.equal(role.kind, 'codexRole');
    assert.equal(role.target, 'codex.agentRole');
    assert.equal(role.roleKey, expected.roleKey);
    assert.deepEqual(role.refreshKeys, []);
    assert.equal(role.state, 'present');
    assert.equal(role.content.roleFile.name, expected.roleKey);
    assert.equal(role.content.registration.description, role.content.roleFile.description);
    roles.set(expected.roleKey, role);
  }

  return {
    skill: {
      ...skill,
      content: {
        ...skill.content,
        skillFile: skill.content.files['SKILL.md'],
      },
    },
    roles,
  };
}

test('renders one model-free task role with required metadata and safety invariants', async () => {
  const { skill, roles } = artifactsFrom(await renderArtifactPlan(createContext()));
  const openaiYaml = await readFile(
    new URL('agents/openai.yaml', pathToFileURL(`${artifactSourcePath}/`)),
    'utf8',
  );

  for (const expected of ROLE_EXPECTATIONS) {
    const role = roles.get(expected.roleKey);
    assert.equal(Object.hasOwn(role.content.roleFile, 'model'), false);
    assert.equal(Object.hasOwn(role.content.roleFile, 'model_reasoning_effort'), false);
    assert.equal(
      role.content.roleFile.developer_instructions,
      renderSubagentRoleDeveloperInstructions(),
    );
  }

  // Static contract exception: rendered instructions must not grant delegation authority; behavior test is not suitable because the prohibition is consumed directly by the model.
  assert.match(skill.content.skillFile, /本 Skill 不授予或判断委派权限/);

  // Static contract exception: rendered waiting instructions must prohibit active polling; behavior test is not suitable because no deterministic runner executes model tool choices.
  assert.match(
    skill.content.skillFile,
    /不用短周期轮询、主动探测或工作区变化监控/,
  );

  assert.doesNotMatch(skill.content.skillFile, /{{[^}]+}}/);

  // Static contract exception: Codex consumes Skill frontmatter and invocation metadata as text; behavior test is not suitable because ArtifactPlan does not parse these platform metadata files.
  assert.match(skill.content.skillFile, /name: codex-subagent-guide/);
  assert.match(
    skill.content.skillFile,
    /compatibility: .*spawn_agent\.agent_type.*codex-subagent role/,
  );
  assert.match(openaiYaml, /allow_implicit_invocation: true/);
  assert.match(skill.content.skillFile, new RegExp(`short-description: ${SHORT_DESCRIPTION}`));
  assert.match(openaiYaml, new RegExp(`short_description: "${SHORT_DESCRIPTION}"`));
  assert.ok(Array.from(SHORT_DESCRIPTION).length >= 25);
  assert.ok(Array.from(SHORT_DESCRIPTION).length <= 64);
});

test('renders Skills independently of removed wait settings', async () => {
  const defaults = await renderArtifactPlan(createContext());
  const obsoleteSettings = await renderArtifactPlan(createContext({
    exploreMinimumInitialWaitMinutes: 2,
    subagentMinimumInitialWaitMinutes: 15,
  }));
  assert.deepEqual(obsoleteSettings, defaults);
});

test('renders configured model preferences in the Skill without changing either role', async () => {
  const defaults = await renderArtifactPlan(createContext());
  const configured = await renderArtifactPlan(createContext({
    advancedTaskProfile: { model: 'advanced-specialist', reasoningEffort: 'max' },
  }));
  const { skill, roles } = artifactsFrom(configured);
  for (const id of ['codex-explore-role', 'codex-subagent-role', 'codex-explore-skill']) {
    assert.deepEqual(
      configured.artifacts.find((artifact) => artifact.id === id),
      defaults.artifacts.find((artifact) => artifact.id === id),
    );
  }
  const rows = skill.content.skillFile.split('\n').filter((line) => /^\| (simple|general|complex|advanced) \|/.test(line));
  assert.equal(rows.length, 4);
  const advanced = rows.find((line) => line.startsWith('| advanced |')).split('|').map((cell) => cell.trim());
  assert.deepEqual(advanced.slice(3, 5).map((cell) => JSON.parse(cell.slice(1, -1))), [
    'advanced-specialist', 'max',
  ]);
  assert.equal(roles.size, 1);
  assert.equal(skill.content.skillFile.includes('<!-- model-profiles -->'), false);
});

test('renders only a requested role without requiring any Skill source or config', async () => {
  const plan = await renderArtifactPlan({
    platform: 'codex',
    requestedArtifactIds: ['codex-subagent-role'],
  });
  assert.equal(plan.artifacts.length, 1);
  assert.deepEqual(plan.artifacts[0].refreshKeys, []);
  assert.equal(plan.artifacts[0].roleKey, 'codex-subagent');
});

test('rejects empty, duplicate and unknown artifact requests', async () => {
  for (const requestedArtifactIds of [[], ['codex-subagent-role', 'codex-subagent-role'], ['unknown']]) {
    await assert.rejects(
      renderArtifactPlan(
        { platform: 'codex', requestedArtifactIds },
      ),
      /requestedArtifactIds|Unknown requested artifact/,
    );
  }
});

test('rejects unsupported platforms', async () => {
  await assert.rejects(
    renderArtifactPlan({
      ...createContext(),
      platform: 'claude',
    }),
    /Unsupported platform: claude/,
  );
});
