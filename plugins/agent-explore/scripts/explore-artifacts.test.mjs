import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderArtifactPlan } from './render-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
const platforms = ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'copilot', 'grok', 'generic'];
const skillName = 'explore-facts';
const fields = ['exploreProfile', 'deepExploreProfile', 'exploreCustomProfiles'];
const configured = {
  exploreProfile: { executor: 'fast-external', model: 'fast-model', reasoningEffort: 'low' },
  deepExploreProfile: { executor: 'native', model: 'deep-model', reasoningEffort: 'high' },
  exploreCustomProfiles: [
    { applicability: 'first route|literal`\n<text>', executor: 'other-external', model: 'custom-model' },
    { applicability: 'second route' },
  ],
};

function context(platform, scope, values, allowedOutputKinds = ['skill', 'agent', 'mcp', 'hook', 'instruction']) {
  const agentNamingMode = ['opencode', 'generic'].includes(platform) ? 'unsupported' : platform === 'claude' ? 'host-plugin' : 'aw-prefix';
  const filePrefix = agentNamingMode === 'aw-prefix' ? 'aw-fixture-agent-explore-' : '';
  return {
    schemaVersion: 3, surface: 'agent-plugin', platform, scope, allowedOutputKinds,
    resources: ['./shared', `./skills/${skillName}`].map((name) => ({ kind: 'bundle', name, root: path.join(root, name) })),
    plugin: { pluginId: 'fixture/agent-explore' },
    agentNaming: { mode: agentNamingMode, filePrefix, invocationPrefix: agentNamingMode === 'host-plugin' ? 'agent-explore:' : filePrefix },
    platformCapabilities: { schemaVersion: 3, platform, scope, agentNamingMode },
    config: { values },
  };
}

function row(body, label) {
  return body.split('\n').find((line) => line.startsWith(`| ${label} |`));
}

// Test Value Gate: public manifest options must preserve optional platform-only routing and same-source provider bindings.
test('declares one dependency, platform-only optional profiles and suggestions v2', () => {
  assert.deepEqual(manifest.platforms, platforms);
  assert.deepEqual(manifest.dependencies, ['agent-subagent']);
  assert.deepEqual(manifest.interface.capabilities, ['Skills', 'Instructions']);
  const { definitions, fields: declared } = manifest.config;
  assert.deepEqual(Object.keys(declared), fields);
  assert.ok(Object.values(declared).every((field) => field.platformOnly === true && !field.required && !Object.hasOwn(field, 'default')));
  const executor = definitions?.agentExecutor ?? declared[fields[0]].properties.executor;
  assert.deepEqual(executor.valueRef, {
    plugin: 'agent-subagent', field: 'subagentCommands', key: 'key', include: ['native'],
  });
  assert.deepEqual(executor.clearsOnChange, ['model', 'reasoningEffort']);
  for (const [index, hint] of ['fast', 'strong', 'balanced'].entries()) {
    const suggestion = (index === 2 ? declared[fields[index]].items : declared[fields[index]]).suggestions;
    assert.deepEqual({ plugin: suggestion.plugin, provider: suggestion.provider, hint: suggestion.hint,
      dependsOn: suggestion.dependsOn, targets: suggestion.targets }, {
      plugin: 'agent-subagent', provider: 'executor-model-profile', hint,
      dependsOn: ['executor'], targets: ['model', 'reasoningEffort'],
    });
  }
});

// Test Value Gate: runtime component partition, generic omission, callable Skill metadata and inline prompt closure.
for (const platform of platforms) {
  for (const scope of ['user', 'project']) {
    test(`${platform}/${scope}: delivers the intended components and independent routing branches`, async () => {
      for (const values of [{}, { exploreProfile: configured.exploreProfile }, { deepExploreProfile: configured.deepExploreProfile }, { exploreCustomProfiles: configured.exploreCustomProfiles }, configured]) {
        const request = context(platform, scope, values);
        const plan = await renderArtifactPlan(request);
        const generic = platform === 'generic';
        assert.equal(plan.version, 3);
        assert.deepEqual(plan.unmet, []);
        assert.deepEqual(plan.components.map(({ kind, name }) => ({ kind, name })), [
          { kind: 'skill', name: skillName }, ...(generic ? [] : [{ kind: 'instruction', name: `${skillName}-trigger` }]),
        ]);
        assert.deepEqual(plan.omitted, generic ? [{ id: `${skillName}-trigger-instruction`, kind: 'instruction', reason: 'not-offered' }] : []);
        if (!generic) {
          const instruction = plan.components[1].content;
          assert.deepEqual(instruction.coverage, ['main']);
          assert.equal(instruction.content.split('\n').length, 3);
          // A delegated execution must not recursively start another exploration.
          assert.match(instruction.content, /受委派[^\n]+忽略本规则/u);
        }
        const files = plan.components[0].content.files;
        assert.deepEqual(Object.keys(files).sort(), ['README.md', 'SKILL.md', ...(generic ? [] : ['agents/openai.yaml'])].sort());
        if (!generic) {
          const metadata = await readFile(path.join(root, files['agents/openai.yaml'].source.path), 'utf8');
          assert.match(metadata, /allow_implicit_invocation:\s*true/u);
        }
        const body = files['SKILL.md'].text;
        assert.doesNotMatch(body, /<!--|@@[A-Z0-9_]+@@|Antigravity|swarm|\bbrief\b|--instructions-file|assets\/[^\s]*-instructions\.md|codex-(?:enhance|advisor|explore)/u);
        // Static contract exception: a reference to undeclared workflow or decision capabilities would misroute the consumer; behavior test is not suitable because the delivered prompt itself must be free of these references.
        assert.doesNotMatch(body, /dev-(?:workflow|design|correct|verify(?:-author)?|investigate|debug|architect|arena|tdd|review(?:-code|-spec)?|benchmark|implement)|decision-(?:kit|shape|grill|prototype)/u);
        assert.match(body, /^name: explore-facts$/mu);
        assert.match(body, /^description: .+通过 spawn-subagent 委派[^\n]+$/mu);
        assert.match(body, /^> 你已经是本次只读事实调查的执行者/mu);
        assert.match(body, /## Coverage & Gaps/u);
        assert.match(body, /任何“未找到”仅限已查范围/u);
        if (Object.keys(values).length === 0) {
          assert.doesNotMatch(body, /^\|/mu);
        } else {
          const normal = row(body, '常规 / 快速探索');
          const deep = row(body, '深度探索');
          assert.ok(normal && deep);
          if (values.exploreProfile) assert.match(normal, /`"fast-model"` \| `"low"`/u);
          else assert.match(normal, /`simple`.+`general`/u);
          if (values.deepExploreProfile) assert.match(deep, /`"deep-model"` \| `"high"`/u);
          else assert.match(deep, /`complex`/u);
          if (values.exploreCustomProfiles) {
            const rows = body.split('\n').filter((line) => /^\| `"/u.test(line));
            assert.equal(rows.length, 2);
            assert.equal(JSON.parse(rows[0].split('|')[1].trim().slice(1, -1)), configured.exploreCustomProfiles[0].applicability);
            assert.match(rows[0], /`"custom-model"`/u);
            assert.match(rows[1], /`"second route"`/u);
          }
        }
        const skillOnly = await renderArtifactPlan({ ...request, allowedOutputKinds: ['skill'] });
        const nonSkill = await renderArtifactPlan({ ...request, allowedOutputKinds: ['instruction', 'agent', 'mcp', 'hook'] });
        assert.deepEqual(skillOnly.components, plan.components.slice(0, 1));
        assert.deepEqual(skillOnly.omitted, []);
        assert.deepEqual(nonSkill.components, plan.components.slice(1));
        assert.deepEqual(nonSkill.omitted, plan.omitted);
      }
    });
  }
}
