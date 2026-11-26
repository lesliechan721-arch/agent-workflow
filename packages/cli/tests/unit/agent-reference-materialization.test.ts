import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { PLATFORM_TARGETS, type AgentDefinition, type FeatureRequirement } from '@lesliechan721/aw-plugin-core/manifest';

import { materializePortableSkills } from '../../src/portable/materializer.js';
import { createIsolatedSkillEnv, materializeProfilePluginComponents, prepareSkillPluginBundle } from '../../src/review/skill-materialization.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import type { PlatformTarget, PluginManifestSource, Scope } from '../../src/types.js';
import { isDeliveryCapabilityGap } from '../../src/utils/component-gap.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });

function skillDocument(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: "Use the reviewer when needed."\n---\n${body}\n`;
}

type RoleMode = 'normal' | 'scoped' | 'project-only' | 'omitted' | 'omitted-id' | 'missing' | 'model-gap' | 'tools-gap' | 'mixed-gap';
const unreferenceableOmittedId = '未启用';
const unreferenceableUnmetId = 'x'.repeat(129);

async function referenceFixture(options: {
  staticSkill?: boolean;
  staticRole?: boolean;
  dynamicSkill?: boolean;
  dynamicRole?: RoleMode;
  directSkill?: boolean;
  missingCapability?: boolean;
  runtimeRequirement?: FeatureRequirement;
  staticRename?: boolean;
  reverseReferences?: boolean;
  artifactScopes?: Scope[];
  extraStaticAgents?: AgentDefinition[];
  unreferenceableDynamicEntries?: boolean;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-agent-reference-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  const trace = path.join(root, 'render.jsonl');
  const dynamic = options.dynamicSkill || options.dynamicRole;
  const manifest: PluginManifestSource = {
    schemaVersion: 4, name: 'reference-demo', version: '1.0.0',
    description: 'Agent reference fixture.', platforms: [...PLATFORM_TARGETS],
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    ...(options.staticSkill ? { skills: './skills' } : {}),
    ...(options.staticRole ? { extensions: { agents: [{
      name: 'reviewer', description: 'Read-only review.', prompt: 'Review the files.',
      ...(options.staticRename ? { agentOverrides: { claude: { name: 'renamed-reviewer' } } } : {}),
    }, ...(options.extraStaticAgents ?? [])] } } : {}),
    ...(dynamic ? {
      artifacts: { configKeys: [], sourceDirs: ['./templates'], ...(options.artifactScopes ? { scopes: options.artifactScopes } : {}) },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      ...(!options.missingCapability && options.dynamicSkill ? { requires: { aw: { capabilities: ['aw.skill-agent-placeholder.v1'] } } } : {}),
    } : {}),
  };
  await fs.outputJson(path.join(sourceRoot, '.agents-plugin/plugin.json'), manifest);
  await fs.outputFile(path.join(sourceRoot, 'README.md'), '# Reference fixture\n');
  if (options.staticSkill) {
    await fs.outputFile(path.join(sourceRoot, 'skills/consumer/SKILL.md'),
      '---\nname: consumer\ndescription: "Use {{aw.agent:reviewer}}."\n---\nAsk {{aw.agent:Reviewer}}.\n');
    await fs.outputFile(path.join(sourceRoot, 'skills/consumer/README.md'), 'Ask {{aw.agent:reviewer}}.\n');
    await fs.outputFile(path.join(sourceRoot, 'skills/consumer/references/usage.md'), 'Invoke {{aw.agent:reviewer}}.\n');
    await fs.chmod(path.join(sourceRoot, 'skills/consumer/references/usage.md'), 0o755);
    await fs.outputFile(path.join(sourceRoot, 'skills/independent/SKILL.md'), skillDocument('independent', 'Independent work.'));
    await fs.outputFile(path.join(sourceRoot, 'skills/independent/README.md'), '# Independent\n');
  }
  if (dynamic) {
    await fs.outputFile(path.join(sourceRoot, 'templates/usage.md'), 'Invoke {{aw.agent:reviewer}}.\n');
    const references = options.dynamicRole !== 'mixed-gap' ? ['reviewer']
      : options.reverseReferences ? ['tool-reviewer', 'reviewer'] : ['reviewer', 'tool-reviewer'];
    const files = {
      'SKILL.md': { text: skillDocument('consumer', 'Ask ' + references.map((name) => '{{aw.agent:' + name + '}}').join(' and ') + '.') },
      'README.md': { text: 'Invoke {{aw.agent:reviewer}}.\n' },
      'references/usage.md': { source: { kind: 'bundle', path: 'templates/usage.md' } },
    };
    await fs.outputFile(path.join(sourceRoot, 'render.mjs'), [
      "import fs from 'node:fs';",
      "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      'const plan = {version:3,components:[],omitted:[],unmet:[]};',
      `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({scope:context.scope,kinds:context.allowedOutputKinds})+'\\n');`,
      'if (context.allowedOutputKinds.includes("agent")) {',
      ...(options.dynamicRole === 'omitted' ? ['  plan.omitted.push({id:"opaque-role-id",kind:"agent",name:"reviewer",reason:"config-disabled"});']
        : options.dynamicRole === 'omitted-id' ? ['  plan.omitted.push({id:"agent:reviewer",kind:"agent",reason:"config-disabled"});']
        : options.dynamicRole === 'mixed-gap' ? [
          'plan.unmet.push({id:"opaque-role-id",kind:"agent",name:"reviewer",reasonCode:"config-missing",requiredFeatures:[]});',
          'plan.components.push({id:"tool-role",kind:"agent",name:"tool-reviewer",content:{description:"Review.",prompt:"Review.",tools:["Read"]}});',
        ]
        : options.dynamicRole === 'missing' || !options.dynamicRole ? []
          : [
            ...(options.dynamicRole === 'normal' ? ['if (context.platformCapabilities.kinds.agent.status === "supported") {']
              : options.dynamicRole === 'project-only' ? ['if (context.scope === "project") {'] : []),
            `const name = ${options.dynamicRole === 'scoped' ? 'context.scope === "user" ? "reviewer" : "project-reviewer"' : '"reviewer"'};`,
            `plan.components.push({id:"computed-role",kind:"agent",name,content:{description:"Review only.",prompt:"Read the files."${options.dynamicRole === 'model-gap' ? ',model:"unaccepted-exact-model"' : options.dynamicRole === 'tools-gap' ? ',tools:["Read"]' : ''}}});`,
            ...(options.dynamicRole === 'normal' || options.dynamicRole === 'project-only' ? ['}'] : []),
          ]),
      ...(options.unreferenceableDynamicEntries ? [
        `plan.omitted.push({id:${JSON.stringify(unreferenceableOmittedId)},kind:"agent",reason:"config-disabled"});`,
        `plan.unmet.push({id:${JSON.stringify(unreferenceableUnmetId)},kind:"agent",reasonCode:"config-missing",requiredFeatures:[]});`,
      ] : []),
      '}',
      ...(options.dynamicSkill ? [
        'if (context.allowedOutputKinds.includes("skill")) {',
        `plan.components.push({id:"computed-skill",kind:"skill",name:"consumer",${options.runtimeRequirement ? `requires:[${JSON.stringify(options.runtimeRequirement)}],` : ''}content:{files:${JSON.stringify(files)}}});`,
        `plan.components.push({id:"independent-skill",kind:"skill",name:"independent",content:{files:${JSON.stringify({
          'SKILL.md': { text: skillDocument('independent', 'Independent work.') }, 'README.md': { text: '# Independent\n' },
        })}}});`,
        ...(options.directSkill ? [
          `plan.components.push({id:"direct-skill",kind:"skill",name:"direct",content:{files:{"SKILL.md":{text:${JSON.stringify(skillDocument('direct', 'Ask ROLE.'))}.replace('ROLE',context.agentNaming.invocationPrefix+'reviewer')},"README.md":{text:"# Direct\\n"}}}});`,
        ] : []),
        '}',
      ] : []),
      'process.stdout.write(JSON.stringify(plan));',
    ].join('\n'));
  }
  const env = await createIsolatedSkillEnv(process.env, path.join(root, 'isolated'));
  const source = await readPluginManifest(sourceRoot);
  const prepared = await prepareSkillPluginBundle({ plugin: source, plugins: [source], workRoot: path.join(root, 'work'), env });
  return { root, env, trace, source, prepared };
}

async function materialize(item: Awaited<ReturnType<typeof referenceFixture>>, platform: PlatformTarget, scope: Scope = 'user') {
  return materializeProfilePluginComponents({
    plugin: item.prepared.bundlePlugin, platform, scope, cwd: item.root, env: item.env,
    outputRoot: path.join(item.root, 'final', platform, scope),
  });
}

async function expectBoundSkill(skillRoot: string, invocationName: string) {
  for (const file of ['SKILL.md', 'README.md', 'references/usage.md']) {
    const body = await fs.readFile(path.join(skillRoot, file), 'utf8');
    expect(body, file).toContain(invocationName);
    expect(body, file).not.toContain('{{aw.agent:');
  }
}

describe('same-plugin Agent references in real component preparation', () => {
  it('binds static aliases and Markdown sources on every native writer, and leaves independent Skills on unsupported platforms', async () => {
    // Test Value Gate: prove actual writer bytes and whole-component gaps, not just the naming helper.
    const item = await referenceFixture({ staticSkill: true, staticRole: true, staticRename: true });
    for (const platform of PLATFORM_TARGETS) {
      const result = await materialize(item, platform);
      expect(result.skills.map(({ name }) => name)).toContain('independent');
      const consumer = result.skills.find(({ name }) => name === 'consumer');
      if (platform === 'opencode' || platform === 'generic') {
        expect(consumer, platform).toBeUndefined();
        expect(result.preparation.flatMap(({ unmet }) => unmet)).toContainEqual(expect.objectContaining({
          id: 'skill:consumer', kind: 'skill', name: 'consumer', reasonCode: 'interface-unsupported',
          requiredFeatures: [{ feature: 'component.kind.agent' }],
        }));
        expect(await fs.pathExists(path.join(item.root, 'final', platform, 'user', 'skills', 'consumer'))).toBe(false);
      } else {
        const name = platform === 'claude' ? 'reference-demo:renamed-reviewer' : 'aw-authoring-reference-demo-reviewer';
        expect(consumer, platform).toBeDefined();
        await expectBoundSkill(consumer!.path, name);
        expect(result.preparation.flatMap(({ unmet }) => unmet).some(({ id }) => id === 'skill:consumer')).toBe(false);
      }
    }
  }, 60_000);

  it('evaluates only the missing User Agent view for a Codex Project-only preparation', async () => {
    const item = await referenceFixture({ dynamicSkill: true, dynamicRole: 'scoped', directSkill: true });
    const result = await materialize(item, 'codex', 'project');
    await expectBoundSkill(result.skills.find(({ name }) => name === 'consumer')!.path, 'aw-authoring-reference-demo-reviewer');
    const direct = await fs.readFile(path.join(result.skills.find(({ name }) => name === 'direct')!.path, 'SKILL.md'), 'utf8');
    expect(direct).toContain('Ask aw-authoring-reference-demo-reviewer.');
    expect(result.codexRoleFiles.map((file) => path.basename(file))).toEqual(['aw-authoring-reference-demo-project-reviewer.toml']);
    const calls = (await fs.readFile(item.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.filter(({ kinds }) => kinds.includes('agent'))).toEqual(expect.arrayContaining([
      { scope: 'user', kinds: ['agent'] }, { scope: 'project', kinds: ['agent'] },
    ]));
    expect(calls.filter(({ kinds, scope }) => kinds.includes('agent') && scope === 'user')).toHaveLength(1);
  });

  it('resolves native portable Skill-only exports from an in-memory dynamic Agent batch without exporting Agents', async () => {
    const item = await referenceFixture({ dynamicSkill: true, dynamicRole: 'normal' });
    for (const platform of ['claude', 'codex', 'antigravity', 'pi'] as const) {
      const outputRoot = path.join(item.root, 'export', platform);
      const exported = await materializePortableSkills({
        plugins: [item.prepared.bundlePlugin], pluginId: 'reference-demo', platform,
        scope: 'user', cwd: item.root, env: item.env, outputRoot, inputMode: 'bundle',
      });
      try {
        const name = platform === 'claude' ? 'reference-demo:reviewer' : 'aw-authoring-reference-demo-reviewer';
        expect(exported.candidates.map((candidate) => candidate.name)).toEqual(expect.arrayContaining(['consumer', 'independent']));
        await expectBoundSkill(path.join(exported.rootDir, 'skills', 'consumer'), name);
        expect(exported.preparation.flatMap(({ components }) => components).every(({ kind }) => kind === 'skill')).toBe(true);
        expect(await fs.pathExists(path.join(exported.rootDir, 'agents'))).toBe(false);
      } finally { await exported.cleanup(); }
    }
  }, 60_000);

  it.each([
    { platform: 'opencode', dynamicRole: 'missing', feature: 'component.kind.agent' },
    { platform: 'generic', dynamicRole: 'missing', feature: 'component.kind.agent' },
    { platform: 'antigravity', dynamicRole: 'model-gap', feature: 'agent.model' },
    { platform: 'codex', dynamicRole: 'tools-gap', feature: 'agent.tools' },
  ] as const)('omits the referencing dynamic Skill when $feature is unavailable on $platform', async ({ platform, dynamicRole, feature }) => {
    const item = await referenceFixture({ dynamicSkill: true, dynamicRole,
      ...(platform === 'generic' ? { runtimeRequirement: { feature: 'component.kind.mcp' } } : {}),
    });
    const result = await materialize(item, platform);
    expect(result.skills.map(({ name }) => name)).toEqual(['independent']);
    const unmet = result.preparation.flatMap((unit) => unit.unmet);
    expect(unmet).toContainEqual(expect.objectContaining({
      id: 'computed-skill', kind: 'skill', name: 'consumer', reasonCode: 'interface-unsupported',
      requiredFeatures: expect.arrayContaining([expect.objectContaining({ feature })]),
    }));
    expect(unmet.some(({ id, componentId }) => id === 'computed-skill:runtime-gap' || componentId === 'computed-skill')).toBe(false);
    if (platform === 'generic') {
      expect(unmet.find(({ id }) => id === 'computed-skill')!.requiredFeatures).toContainEqual({ feature: 'component.kind.mcp' });
    }
  });

  it.each([
    { platform: 'codex', dynamicRole: 'project-only', scope: 'project' },
    { platform: 'claude', dynamicRole: 'omitted', scope: 'user' },
    { platform: 'claude', dynamicRole: 'omitted-id', scope: 'user' },
    { platform: 'codex', dynamicRole: 'missing', scope: 'user' },
  ] as const)('rejects a $dynamicRole Agent referenced from the $platform $scope Skill view', async ({ platform, dynamicRole, scope }) => {
    const item = await referenceFixture({ dynamicSkill: true, dynamicRole });
    await expect(materialize(item, platform, scope)).rejects.toThrow('agentReferenceInvalid');
  });

  it('requires the dynamic Agent placeholder capability even for a valid same-bundle role', async () => {
    const item = await referenceFixture({ dynamicSkill: true, dynamicRole: 'normal', missingCapability: true });
    await expect(materialize(item, 'codex')).rejects.toThrow('agentReferenceInvalid');
  });

  it.each([false, true])('retains actionable Agent gaps in a Skill-only export (reverse references: %s)', async (reverseReferences) => {
    const item = await referenceFixture({ dynamicSkill: true, dynamicRole: 'mixed-gap', reverseReferences });
    const exported = await materializePortableSkills({
      plugins: [item.prepared.bundlePlugin], pluginId: 'reference-demo', platform: 'codex',
      scope: 'project', cwd: item.root, env: item.env, outputRoot: path.join(item.root, 'mixed-gap-export'), inputMode: 'bundle',
    });
    try {
      expect(exported.candidates.map(({ name }) => name)).toEqual(['independent']);
      const gaps = exported.preparation.flatMap(({ unmet }) => unmet);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({ id: 'computed-skill', reasonCode: 'config-missing',
        requiredFeatures: [{ feature: 'agent.tools', values: ['allowlist'] }] });
      expect(isDeliveryCapabilityGap(gaps[0]!)).toBe(false);
    } finally { await exported.cleanup(); }
  });

  it('keeps a mixed static Skill referencing a User dynamic Agent valid until the exact Agent view is prepared', async () => {
    const item = await referenceFixture({ staticSkill: true, dynamicRole: 'scoped' });
    const result = await materialize(item, 'codex', 'project');
    await expectBoundSkill(result.skills.find(({ name }) => name === 'consumer')!.path, 'aw-authoring-reference-demo-reviewer');
    expect(result.codexRoleFiles.map((file) => path.basename(file))).toEqual(['aw-authoring-reference-demo-project-reviewer.toml']);
  });

  it('delivers a mixed static Skill where its dynamic Agent can be rendered and records a whole-Skill gap elsewhere', async () => {
    const item = await referenceFixture({ staticSkill: true, dynamicRole: 'normal' });
    const supported = await materialize(item, 'claude');
    await expectBoundSkill(supported.skills.find(({ name }) => name === 'consumer')!.path, 'reference-demo:reviewer');
    for (const platform of ['opencode', 'generic'] as const) {
      const result = await materialize(item, platform);
      expect(result.skills.map(({ name }) => name)).toEqual(['independent']);
      expect(result.preparation.flatMap(({ unmet }) => unmet)).toEqual([
        { id: 'skill:consumer', name: 'consumer', kind: 'skill', reasonCode: 'interface-unsupported',
          requiredFeatures: [{ feature: 'component.kind.agent' }] },
      ]);
      expect(await fs.pathExists(path.join(item.root, 'final', platform, 'user', 'skills', 'consumer'))).toBe(false);
    }
  });

  it.each([
    { platform: 'opencode', dynamicRole: 'omitted' },
    { platform: 'claude', dynamicRole: 'missing' },
  ] as const)('rejects a mixed static Skill referencing an $dynamicRole Agent on $platform', async ({ platform, dynamicRole }) => {
    const item = await referenceFixture({ staticSkill: true, dynamicRole });
    await expect(materialize(item, platform)).rejects.toThrow('agentReferenceInvalid');
  });

  it.each(['opencode', 'generic'] as const)('rejects a mixed static Skill on %s when no renderer applies to its scope', async (platform) => {
    const item = await referenceFixture({ staticSkill: true, dynamicRole: 'normal', artifactScopes: ['project'] });
    await expect(materialize(item, platform, 'user')).rejects.toThrow('agentReferenceInvalid');
  });

  it('keeps a valid Skill reference beside an independent Agent with an unreferenceable public name', async () => {
    const item = await referenceFixture({ staticSkill: true, staticRole: true, extraStaticAgents: [{
      name: '审阅员', description: 'Independent reviewer.', prompt: 'Review.', agentOverrides: { codex: { name: 'extra-reviewer' } },
    }] });
    const result = await materialize(item, 'codex');
    await expectBoundSkill(result.skills.find(({ name }) => name === 'consumer')!.path, 'aw-authoring-reference-demo-reviewer');
    expect(result.codexRoleFiles.map((file) => path.basename(file)).sort()).toEqual([
      'aw-authoring-reference-demo-extra-reviewer.toml', 'aw-authoring-reference-demo-reviewer.toml',
    ]);
  });

  it.each([
    ['Reviewer', 'agentReferenceInvalid: multiple Agents project to reviewer'],
    ['审阅员', 'platformProjectionNameInvalid'],
  ])('still rejects invalid or colliding projected names (%s) in a Skill-only view', async (projectedName, error) => {
    const item = await referenceFixture({ staticSkill: true, staticRole: true, extraStaticAgents: [{
      name: '审阅员', description: 'Independent reviewer.', prompt: 'Review.', agentOverrides: { codex: { name: projectedName } },
    }] });
    await expect(materializePortableSkills({
      plugins: [item.prepared.bundlePlugin], pluginId: 'reference-demo', platform: 'codex',
      scope: 'user', cwd: item.root, env: item.env,
      outputRoot: path.join(item.root, 'export'), inputMode: 'bundle',
    })).rejects.toThrow(error);
  });

  it('retains valid dynamic Agent references beside omitted and unmet entries with opaque non-referenceable IDs', async () => {
    const item = await referenceFixture({ dynamicSkill: true, dynamicRole: 'normal', unreferenceableDynamicEntries: true });
    const result = await materialize(item, 'codex');
    await expectBoundSkill(result.skills.find(({ name }) => name === 'consumer')!.path, 'aw-authoring-reference-demo-reviewer');
    expect(result.preparation.flatMap(({ omitted }) => omitted)).toContainEqual({
      id: unreferenceableOmittedId, kind: 'agent', reason: 'config-disabled',
    });
    expect(result.preparation.flatMap(({ unmet }) => unmet)).toContainEqual({
      id: unreferenceableUnmetId, kind: 'agent', reasonCode: 'config-missing', requiredFeatures: [],
    });
  });
});
