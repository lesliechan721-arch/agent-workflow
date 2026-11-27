// Deterministic candidate qualification. Only discovery facts are fixtures; use
// the staged Catalog, production capabilities, component preparation and writers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { addOfficialCatalog, qualifyShippedGitInstall, ordinaryGitSkills as ordinarySkills } from './native-platform-shipped-git.mjs';
import { shippedRoles, shippedSkills } from './native-platform-public-catalog.mjs';
import { executePublicAw } from './native-platform-public-process.mjs';
import { prepareEnvironment, repoRoot, sha256 } from './native-platform-runtime.mjs';
import { getAgentPluginAdapters } from '../../packages/cli/dist/src/platforms/registry.js';
import { getQualifiedPlatformProfile } from '../../packages/cli/dist/src/platforms/capabilities.js';
import { COMPONENT_KINDS, readPluginManifest, getComponentFeatureRequirements, normalizeStaticPluginComponents, resolveInvocationPolicy } from '../../packages/cli/dist/src/utils/manifest.js';
import { preparePlatformComponents, resolveArtifactRenderConfig } from '../../packages/cli/dist/src/utils/artifact-renderer.js';
import { writePluginConfigStore } from '../../packages/cli/dist/src/utils/plugin-config.js';
import { finalizePlatformSkillProducers } from '../../packages/cli/dist/src/utils/component-command-preparation.js';

const yaml = createRequire(path.join(repoRoot, 'packages/cli/package.json'))('yaml');
// These expectations are independent of production flags. Regressing a
// capability must fail here even if planning and projection agree on dropping it.
const userTargets = {
  codex: { version: '0.167.0', manual: true },
  claude: { version: '2.1.317', manual: true },
  antigravity: { version: '1.3.4', manual: true },
  pi: { version: '1.5.0', manual: true },
  opencode: { version: '2.0.0', manual: true },
  copilot: { version: '1.0.95', manual: true },
  grok: { version: '1.0.77', manual: true },
  generic: { version: null, manual: false },
  cursor: { version: '2026.11.05-86047df', manual: true },
};

function skillFields(source) {
  const [, header, body] = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source) ?? [];
  assert(header && body.trim(), 'Staged Skill must have frontmatter and a body');
  return { fields: yaml.parse(header), body };
}

async function declaredSkills(directory) {
  const skills = new Map();
  for (const name of await fs.readdir(directory)) {
    const filename = path.join(directory, name, 'SKILL.md');
    const source = await fs.readFile(filename, 'utf8').catch(e => {
      if (e.code !== 'ENOENT') throw e;
    });
    if (source === undefined) continue; // Author-only directory (e.g. eval inputs).
    const { fields, body } = skillFields(source);
    assert.equal(fields.name, name);
    skills.set(name, { fields, body });
  }
  return skills;
}

async function assertGitProjection({ adapter, ctx, binding, unit, capabilities, prepared, manifest, stage, declared }) {
  const platform = adapter.platform;
  assert.deepEqual([...declared.keys()].sort(), ['git-commit', ...ordinarySkills]);
  assert.equal(declared.get('git-commit').fields['user-invocable'], true);
  assert.equal(declared.get('git-commit').fields['disable-model-invocation'], true);
  const projection = await adapter.project({ ...ctx, stagingRoot: stage }, { binding, renderUnit: unit, capabilities,
    components: prepared.expected.components, resources: prepared.resources, policy: resolveInvocationPolicy(manifest, platform) });
  const names = projection.components.map(component => component.id.slice('skill:'.length)).sort();
  assert.deepEqual(names, ['git-commit', ...ordinarySkills]);
  for (const component of projection.components) {
    const name = component.id.slice('skill:'.length);
    const file = component.relativeOutputs.find(relative => relative.endsWith('/SKILL.md'));
    assert(file, `Missing projected SKILL.md for ${platform}/${name}`);
    const directory = projection.bundle
      ? path.join(projection.bundle.stagingRoot, path.dirname(file))
      : projection.supplements.find(item => item.componentIds.includes(component.id)).stagingPath;
    const { fields, body } = skillFields(await fs.readFile(path.join(directory, 'SKILL.md'), 'utf8'));
    assert.equal(body, declared.get(name).body);
    if (name !== 'git-commit') {
      assert.notEqual(fields['disable-model-invocation'], true);
    } else if (platform === 'generic') {
      assert.equal(fields['user-invocable'], undefined);
      assert.equal(fields['disable-model-invocation'], undefined);
      assert.equal(fields.metadata['skill.invocation.manual'], 'true');
      assert.equal(fields.metadata['skill.visibility'], 'visible');
      assert.equal(fields.metadata['skill.invocation.model'], 'false');
    } else if (platform === 'codex') {
      const policyFile = path.join(directory, 'agents/openai.yaml');
      assert.equal(yaml.parse(await fs.readFile(policyFile, 'utf8')).policy.allow_implicit_invocation, false);
      assert.equal(fields['disable-model-invocation'], undefined);
    } else if (platform === 'opencode') {
      // Exercise the generated extension against the registry it populates.
      const { default: extension } = await import(pathToFileURL(path.join(projection.bundle.stagingRoot, 'index.mjs')));
      const definitions = new Map();
      await extension.setup({ skill: { transform(callback) {
        callback({ get: id => definitions.get(id), add: skill => definitions.set(skill.id, skill) });
        return { dispose() {} };
      } } });
      assert.deepEqual([...definitions.keys()].sort(), ['git-commit', ...ordinarySkills]);
      assert.equal(definitions.get(name).autoinvoke, false);
      assert.equal(definitions.get(name).content, body);
      for (const ordinary of ordinarySkills) assert.notEqual(definitions.get(ordinary).autoinvoke, false);
    } else {
      assert.equal(fields['disable-model-invocation'], true);
      assert.notEqual(fields['user-invocable'], false);
    }
  }
  return names;
}

export async function qualifyShippedCatalog({ staticOnly = false } = {}) {
  const catalog = path.join(repoRoot, 'packages/cli/plugins-dist');
  const snapshot = await fs.readFile(path.join(catalog, 'catalog-manifest.json'));
  const sourceIdentity = `sha256:${sha256(snapshot)}`;
  const { entries } = JSON.parse(snapshot);
  const adapters = getAgentPluginAdapters();
  assert.deepEqual(adapters.map(adapter => adapter.platform).sort(), Object.keys(userTargets).sort());
  const authors = new Map();
  const pluginDirectory = path.join(repoRoot, 'plugins');
  for (const entry of await fs.readdir(pluginDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(pluginDirectory, entry.name);
    const source = await fs.readFile(path.join(directory, '.agents-plugin/plugin.json'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (source === undefined) continue;
    const manifest = JSON.parse(source);
    authors.set(manifest.name, { manifest, skills: manifest.skills && await declaredSkills(path.join(directory, manifest.skills)) });
  }
  assert.deepEqual(entries.map(entry => entry.name).sort(), [...authors.keys()].sort(), 'Shipped Catalog must include every repository plugin');
  const plugins = [];
  for (const entry of entries) {
    const plugin = await readPluginManifest(path.join(catalog, entry.source), { mode: 'bundle' });
    assert.equal(plugin.manifest.name, entry.name);
    assert.deepEqual([...plugin.manifest.platforms].sort(), [...authors.get(entry.name).manifest.platforms].sort(), entry.name);
    plugins.push({ ...plugin, sourceId: 'official', pluginId: `official/${entry.name}`, sourceIdentity });
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-shipped-catalog-user-'));
  const report = { level: staticOnly ? 'static-preparation-with-simulated-darwin-arm64-cli-discovery' : 'candidate-projection-with-simulated-darwin-arm64-cli-discovery', scopes: ['user', 'project'], plugins: {}, projectPlugins: {}, gitToolkit: {} };
  try {
    const ctx = { env: await prepareEnvironment(root), cwd: root };
    for (const platform of Object.keys(userTargets)) {
      await writePluginConfigStore({ ...ctx, sourceId: 'official', sourceIdentity, pluginName: 'agent-subagent',
        scope: 'user', platform, values: { generalTaskProfile: { executor: 'native' } } });
    }
    for (const [scope, pluginInventory] of [['user', report.plugins], ['project', report.projectPlugins]]) {
      for (const plugin of plugins) {
        const { manifest } = plugin;
        if (staticOnly && !manifest.skills) continue;
        const inventory = { requiredAwCapabilities: manifest.requires.aw.capabilities, dependencies: manifest.dependencies ?? [],
          producer: manifest.scripts?.artifacts?.render ? 'renderer' : 'static', platforms: {} };
        pluginInventory[manifest.name] = inventory;
        for (const adapter of adapters.filter(adapter => manifest.platforms.includes(adapter.platform))) {
          const platform = adapter.platform;
          const expectation = userTargets[platform];
          const configRoot = path.join(ctx.env.HOME, platform);
          await fs.mkdir(configRoot, { recursive: true });
          const product = platform === 'generic'
            ? { product: 'generic', availability: 'notApplicable', entry: { kind: 'generic', root: configRoot } }
            : { product: 'cli', availability: 'available', entry: { kind: 'cli', executable: path.join(configRoot, platform), configRoot } };
          const installation = { id: platform, ...product, version: expectation.version, reasonCodes: [] };
          const resolution = await adapter.resolve(ctx, { plugin: { ...plugin, version: manifest.version },
            scope: scope === 'user' ? { kind: scope } : { kind: scope, projectRoot: root }, operation: 'ensure', recoveryCandidates: [],
            discovery: { platform, installations: [installation], availability: product.availability, diagnostics: [] } });
          const [binding] = resolution.bindings;
          const unit = resolution.renderUnits.find(item => item.kinds.includes('skill'));
          assert(binding && unit, `Missing ${scope} Skill render unit for ${platform}`);
          const capabilities = adapter.capabilities({ binding, renderUnit: unit, profile: getQualifiedPlatformProfile(platform) });
          const staticResourceRoot = manifest.skills ? path.join(plugin.rootDir, platform) : plugin.rootDir;
          const options = { pluginRoot: plugin.rootDir, staticResourceRoot, manifest, platform, capabilities };
          const expected = await normalizeStaticPluginComponents(options);
          const subagent = manifest.name === 'agent-subagent';
          const claudeSubagent = subagent && platform === 'claude';
          let prepared = { expected };
          if (!staticOnly && (manifest.scripts?.artifacts?.render || manifest.name === 'git-toolkit')) {
            const config = await resolveArtifactRenderConfig({ sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
              pluginName: manifest.name, manifest, platform, ...ctx, referencePlugins: plugins, scope: unit.renderScope.kind });
            if (claudeSubagent) config.values.subagentCommands = [{ key: 'qualification', adapter: 'codex' }];
            prepared = await preparePlatformComponents({ plugin, platform, ...ctx, config, capabilities, renderScope: unit.renderScope.kind,
              kinds: COMPONENT_KINDS, staticResourceRoot, staticExpected: expected, commandEnv: ctx.env });
          }
          const { components, unmet, omitted } = prepared.expected;
          const label = `${manifest.name}/${platform}/${scope}`;
          assert(components.length + unmet.length + omitted.length > 0, `${label} silently produced no outcomes`);
          inventory.platforms[platform] = { prepared: components.map(c => ({ id: c.id, requires: getComponentFeatureRequirements(c) })),
            unmet: unmet.map(({ id, reasonCode, requiredFeatures }) => ({ id, reasonCode, requiredFeatures })), omitted };
          if (manifest.skills) {
            const declared = await declaredSkills(path.join(staticResourceRoot, manifest.skills));
            // Source declarations form the independent delivery oracle for this
            // Catalog. Invocation preferences do not remove a shipped Skill.
            const authorSkills = authors.get(manifest.name).skills;
            const names = [...authorSkills.keys()].sort();
            assert.deepEqual([...declared.keys()].sort(), names, label);
            for (const [name, { fields, body }] of authorSkills) {
              assert.equal(declared.get(name).body, body, `${label}/${name}/SKILL.md`);
              for (const flag of ['user-invocable', 'disable-model-invocation']) {
                assert.equal(declared.get(name).fields[flag], fields[flag], `${label}/${name}/${flag}`);
              }
            }
            // All current static Skills have deliverable bodies. The invocation
            // and visibility preferences in their headers are checked separately.
            const staticSkills = component => prepared.expected.sources[component.id] === 'static' && component.kind === 'skill';
            assert.deepEqual(components.filter(staticSkills).map(c => c.name).sort(), names, label);
            assert.deepEqual(unmet.filter(staticSkills), [], label);
            inventory.platforms[platform].authoredInvocation = Object.fromEntries([...declared]
              .filter(([, { fields }]) => Object.hasOwn(fields, 'user-invocable') || Object.hasOwn(fields, 'disable-model-invocation'))
              .map(([name, { fields }]) => [name, { userInvocable: fields['user-invocable'],
                disableModelInvocation: fields['disable-model-invocation'] }]));
            if (!staticOnly && manifest.name === 'git-toolkit' && scope === 'user') {
              const proven = capabilities.features['skill.invocation.model'];
              assert.equal(proven.status === 'supported' && proven.values.includes('false'), expectation.manual, label);
              report.gitToolkit[platform] = await assertGitProjection({ adapter, ctx, binding, unit, capabilities, prepared,
                manifest, declared, stage: path.join(root, 'projection', platform) });
            }
          }
          if (!staticOnly && manifest.scripts?.artifacts?.render) {
            // Each shipped renderer needs an independent output expectation.
            const skill = shippedSkills[manifest.name];
            assert(skill, `Add an independent output expectation for shipped renderer ${manifest.name}`);
            assert.deepEqual(components.filter(c => c.kind === 'skill').map(c => c.name), [skill], label);
            assert.deepEqual(unmet.filter(c => c.kind === 'skill'), [], label);
            if (!subagent) {
              const trigger = `${skill}-trigger`;
              assert.deepEqual(components.filter(c => c.kind === 'instruction').map(c => c.name), platform === 'generic' ? [] : [trigger], label);
              assert.deepEqual(unmet.filter(c => c.kind === 'instruction'), [], label);
              assert.deepEqual(omitted.map(c => c.id), platform === 'generic' ? [`${trigger}-instruction`] : [], label);
            } else assert.deepEqual(omitted, [], label);
            const roles = shippedRoles[manifest.name];
            let roleSet = prepared.expected;
            if (subagent && scope === 'project' && platform === 'codex') {
              const roleUnit = resolution.renderUnits.find(unit => unit.output === 'supplement');
              assert.equal(roleUnit?.renderScope.kind, 'project');
              const roleConfig = await resolveArtifactRenderConfig({ sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
                pluginName: manifest.name, manifest, platform, ...ctx, referencePlugins: plugins, scope: 'project' });
              const roleCapabilities = adapter.capabilities({ binding, renderUnit: roleUnit, profile: getQualifiedPlatformProfile(platform) });
              roleSet = (await preparePlatformComponents({ plugin, platform, ...ctx, config: roleConfig, capabilities: roleCapabilities,
                renderScope: 'project', kinds: roleUnit.kinds, staticResourceRoot, commandEnv: ctx.env })).expected;
              inventory.platforms[platform].projectSupplement = roleSet.components.map(component => component.id);
            }
            assert.deepEqual(roleSet.components.filter(c => c.kind === 'agent').map(c => c.name).sort(), roles, label);
            assert.deepEqual(roleSet.unmet.filter(c => c.kind === 'agent').map(c => c.name).sort(), [], label);
            if (claudeSubagent) {
              const stage = path.join(root, 'projection', label);
              const finalized = await finalizePlatformSkillProducers({ plugin, plugins, platform, renderUnit: unit, prepared,
                ...ctx, skillWorkRoot: path.join(stage, 'skills') });
              const projected = await adapter.project({ ...ctx, stagingRoot: path.join(stage, 'package') }, {
                binding, renderUnit: unit, capabilities, components: finalized.prepared.expected.components,
                resources: finalized.prepared.resources, policy: finalized.invocationPolicy.policy,
              });
              assert(projected.bundle, label);
              const guide = projected.components.find(c => c.id === 'spawn-subagent-skill');
              assert.equal(projected.components.find(c => c.kind === 'agent'), undefined, label);
              const skillFile = guide?.relativeOutputs.find(file => file.endsWith('/SKILL.md'));
              assert(skillFile, label);
              const bundle = projected.bundle.stagingRoot;
              const reference = await fs.readFile(path.join(bundle, path.dirname(skillFile), 'references/external-execution.md'), 'utf8');
              assert.match(reference, /^aw command run official\/agent-subagent\/claude -- start --executor /m, label);
            }
          }
        }
      }
    }
    if (staticOnly) return report;
    assert.deepEqual(Object.keys(report.gitToolkit).sort(), Object.keys(userTargets).sort());
    // Generic has a real local writer and needs no host CLI. Its public receipt
    // and installed files catch errors downstream from adapter projection.
    const generic = { ...ctx, root, project: root, platform: 'generic', async aw(args, cwd = root, expectation = {}) {
      const result = await executePublicAw({ executable: process.execPath, prefix: [path.join(repoRoot, 'packages/cli/dist/index.js')] },
        [...args, '--json'], { cwd, env: ctx.env, timeoutMs: expectation.timeoutMs ?? 60_000 });
      const envelope = JSON.parse(result.stdout);
      assert.equal(result.exitCode, expectation.expectedExitCode ?? 0, JSON.stringify(envelope.diagnostics));
      assert.equal(envelope.schemaVersion, 2);
      assert.equal(envelope.status, expectation.expectedStatus ?? 'success');
      return envelope;
    } };
    await addOfficialCatalog(generic);
    await generic.aw(['target', 'set', 'generic']);
    report.publicGeneric = await qualifyShippedGitInstall(generic);
    return report;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const staticOnly = args.includes('--static-only');
  const output = args.find(arg => arg !== '--static-only');
  const report = await qualifyShippedCatalog({ staticOnly });
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ level: report.level, plugins: Object.keys(report.plugins), gitToolkit: report.gitToolkit }));
}
