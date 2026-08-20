import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { renderArtifactPlan } from './render-artifacts.mjs';

const pluginRoot = new URL('../', import.meta.url);
const skillSourceDirs = Object.fromEntries([
  'codex-clarifier',
  'codex-explore',
  'codex-subagent-guide',
].map((skillKey) => {
  const staged = fileURLToPath(new URL(
    `../.agents-plugin/artifact-sources/codex/${skillKey}-skill/0/`,
    import.meta.url,
  ));
  const source = fileURLToPath(new URL(`../skills/${skillKey}/`, import.meta.url));
  return [skillKey, existsSync(staged) ? staged : source];
}));

test('renders codex-clarifier as an implicit Codex Skill without a production gate', async () => {
  const [plan, manifest, openaiYaml] = await Promise.all([
    renderArtifactPlan({
      platform: 'codex',
      config: { values: {} },
      artifactSources: Object.entries(skillSourceDirs).map(([skillKey, sourceDir]) => ({
        id: `${skillKey}-skill`,
        target: 'codex.skill',
        sourceDirs: [sourceDir],
      })),
    }),
    readFile(new URL('.agents-plugin/plugin.json', pluginRoot), 'utf8').then(JSON.parse),
    readFile(
      new URL('agents/openai.yaml', pathToFileURL(`${skillSourceDirs['codex-clarifier']}/`)),
      'utf8',
    ),
  ]);

  const target = manifest.artifacts.targets.find((entry) => entry.id === 'codex-clarifier-skill');
  assert.deepEqual({ ...target, kind: target.kind ?? 'skill' }, {
    id: 'codex-clarifier-skill',
    platform: 'codex',
    scopes: ['user', 'project'],
    target: 'codex.skill',
    kind: 'skill',
    projectManagedKind: 'skill',
    states: ['present'],
    refreshKeys: [],
    skillKey: 'codex-clarifier',
    sourceDirs: ['./skills/codex-clarifier'],
  });

  const artifact = plan.artifacts.find((entry) => entry.id === 'codex-clarifier-skill');
  assert.ok(artifact);
  assert.equal(artifact.target, 'codex.skill');
  assert.equal(artifact.skillKey, 'codex-clarifier');
  assert.equal(artifact.state, 'present');
  assert.deepEqual(artifact.refreshKeys, []);
  assert.match(artifact.content.files['SKILL.md'], /^name: codex-clarifier$/m);
  assert.match(artifact.content.files['SKILL.md'], /`request_user_input`/);
  assert.doesNotMatch(artifact.content.files['SKILL.md'], /AskUserQuestion|{{[^}]+}}/);
  assert.match(openaiYaml, /allow_implicit_invocation: true/);

  assert.equal(manifest.config?.schema?.qualityGateEnabled, undefined);
  assert.equal(
    manifest.artifacts.targets.some((entry) => entry.target === 'codex.developerInstructionsBlock'),
    false,
  );
});
