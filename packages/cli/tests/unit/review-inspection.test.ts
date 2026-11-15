import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { computeEvalProviderDigest } from '@lesliechan721/agent-skill-eval';
import {
  buildCatalogWorkspace,
  initializeCatalogWorkspace,
  readCatalogWorkspace,
  type PluginManifestSource,
} from '@lesliechan721/aw-plugin-core';

import {
  inspectReviewTarget,
} from '../../src/commands/review-inspection.js';
import { readAwSkillEvalManifest } from '../../src/eval/manifest-v1.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { resolveReviewSelection } from '../../src/review/review-selection.js';
import {
  resolveEvalProfileBindingInput,
  resolveEvalSourceBindingInput,
  resolvePortableProfileBindingInput,
  resolveWorkspaceBindingSource,
  writeAwSourceBinding,
} from '../../src/review/source-binding.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';
import { CLI_RESERVED_IMPORTS } from '../../src/utils/manifest.js';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import { artifactValueDigest } from '../../src/utils/artifact-plan.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';

const roots: string[] = [];

async function tempRoot(label = 'aw-review-inspection-'): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), label)));
  roots.push(root);
  return root;
}

function manifest(name: string, extra: Partial<PluginManifestSource> = {}): PluginManifestSource {
  return {
    schemaVersion: 4,
    name,
    version: '0.1.0',
    description: `${name} inspection fixture.`,
    platforms: ['codex', 'claude', 'generic'],
    mcpServers: './.mcp.json',
    marketplace: {
      category: 'test',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    ...extra,
  };
}

async function writePlugin(root: string, value: PluginManifestSource): Promise<string> {
  const pluginRoot = path.join(root, 'plugins', value.name);
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), value);
  if (value.mcpServers) {
    await fs.outputJson(path.join(pluginRoot, value.mcpServers.replace(/^\.\//u, '')), {
      mcpServers: {},
    });
  }
  return pluginRoot;
}

async function writeSkill(pluginRoot: string, skill: string, collection = 'skills'): Promise<string> {
  const skillRoot = path.join(pluginRoot, collection, skill);
  await fs.outputFile(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${skill}\ndescription: ${skill} fixture.\n---\n\n# ${skill}\n`,
  );
  await fs.outputFile(path.join(skillRoot, 'README.md'), `# ${skill}\n`);
  return skillRoot;
}

async function writeEval(pluginRoot: string, skill: string, options: {
  profiles?: Array<'project' | 'user'>;
} = {}): Promise<void> {
  const evalRoot = path.join(pluginRoot, 'skills', skill, 'evals');
  const profiles = options.profiles ?? ['project'];
  await fs.outputJson(path.join(evalRoot, 'manifest.json'), {
    version: 1,
    defaults: { runs: 2, timeoutMs: 3000 },
    profiles: Object.fromEntries(profiles.map((scope) => [`${scope}-default`, {
      platform: 'codex', scope,
      plugins: { [path.basename(pluginRoot)]: {} },
    }])),
    suites: [{
      id: 'behavior',
      kind: 'conversation',
      cases: 'cases.json',
      profiles: profiles.map((scope) => `${scope}-default`),
    }],
  });
  await fs.outputJson(path.join(evalRoot, 'cases.json'), {
    version: 1,
    suite: { kind: 'conversation', unitUnderTest: skill, runtime: { minimumPassRate: 0.75 } },
    cases: [
      { id: 'selected', split: 'validation', tags: [], prompt: 'Run selected.', assertions: ['Selected.'] },
      { id: 'not-selected', split: 'train', tags: [], prompt: 'Run train.', assertions: ['Train.'] },
    ],
  });
}

async function buildStaticSnapshot(root: string): Promise<void> {
  await buildCatalogWorkspace({
    workspaceRoot: root,
    adapter: {
      async build(options) {
        await bundleLocalPlugin(options.plugin, options.outputRoot, {
          buildMode: 'staging',
          runtimeResolver: createCatalogRuntimeImportResolver(options.plugins),
        });
      },
    },
  });
}

async function conversationEvalInput(options: {
  workspaceRoot: string;
  materializedRoot: string;
  loaded: Awaited<ReturnType<typeof readAwSkillEvalManifest>>;
  caseIds?: readonly string[];
}) {
  await fs.ensureDir(path.join(options.materializedRoot, 'workspace', 'eval'));
  const suite = options.loaded.manifest.suites[0]!;
  return await resolveEvalSourceBindingInput({
    workspaceRoot: options.workspaceRoot,
    evalRoot: options.loaded.evalRoot,
    manifestPath: options.loaded.manifestPath,
    suite,
    defaults: options.loaded.manifest.defaults,
    cases: options.loaded.casesBySuite.get(suite.id)!,
    corpusPaths: options.loaded.manifest.suites.map((entry) => entry.cases),
    selection: {
      caseIds: options.caseIds
        ?? options.loaded.casesBySuite.get(suite.id)!.cases.map((entry) => entry.id),
    },
    providerDigest: computeEvalProviderDigest('codex-conversation'),
    preparedEvalRoot: path.join(options.materializedRoot, 'workspace', 'eval'),
  });
}

async function writeInspectionBinding(workspaceRoot: string, options: Omit<Parameters<typeof writeAwSourceBinding>[0], 'preparation'>) {
  const workspace = await readCatalogWorkspace(workspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS });
  const plugin = workspace.plugins.find((entry) => entry.manifest.name === options.subject.plugin)!;
  const capabilities = getAuthoringPlatformCapabilities(options.profile.platform, options.profile.scope);
  const names = options.artifacts.flatMap((artifact) => artifact.kind === 'review-skill' || artifact.kind === 'portable-skill' || artifact.kind === 'eval-target' ? [artifact.skill] : []);
  const dynamic = Boolean(plugin.manifest.artifacts && !plugin.manifest.skills);
  return writeAwSourceBinding({
...options, preparation: [{
      plugin: plugin.manifest.name, platform: options.profile.platform, renderScope: options.profile.scope, profileId: capabilities.profileId,
      capabilitiesDigest: artifactValueDigest(capabilities), expectedDigest: `sha256:${'a'.repeat(64)}`,
      resourceDigest: `sha256:${'b'.repeat(64)}`, renderInputDigest: `sha256:${'c'.repeat(64)}`, outputs: [],
      components: names.map(name => ({ id: dynamic ? name : `skill:${name}`, kind: 'skill' as const, name, source: dynamic ? 'dynamic' as const : 'static' as const })), omitted: [], unmet: [],
    }]
});
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('AW Review static inspection', () => {
  it('uses only a current snapshot and keeps equal leaf digests distinct by profile', async () => {
    const root = await tempRoot();
    await initializeCatalogWorkspace({ workspaceRoot: root });
    const pluginRoot = await writePlugin(root, manifest('static', {
      platforms: ['codex'],
      skills: './skills',
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    }));
    const skillRoot = await writeSkill(pluginRoot, 'shared');
    await buildStaticSnapshot(root);

    const current = await inspectReviewTarget({ cwd: root, target: root });
    expect(current.snapshot?.state).toBe('current');
    expect(current.ok).toBe(true);
    expect(current.skills.map((entry) => `${entry.profile.platform}-${entry.profile.scope}`))
      .toEqual(['codex-project', 'codex-user']);
    expect(current.skills.every((entry) => entry.state === 'ready')).toBe(true);
    expect(new Set(current.skills.map((entry) => entry.digest)).size).toBe(1);

    await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\nChanged.\n');
    const stale = await inspectReviewTarget({ cwd: root, target: root });
    expect(stale.snapshot?.state).toBe('stale');
    expect(stale.ok).toBe(true);
    expect(stale.skills.every((entry) => entry.state === 'missing' && entry.finalPath === null)).toBe(true);
    expect(stale.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'snapshotStale' }),
      expect.objectContaining({ code: 'requiredFinalMissing' }),
    ]));
  });

  it('matches an explicit export binding against the complete renderer config', async () => {
    const root = await tempRoot();
    const materializedRoot = await tempRoot('aw-review-portable-leaf-config-');
    await initializeCatalogWorkspace({ workspaceRoot: root });
    const pluginRoot = await writePlugin(root, manifest('portable-leaves', {
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.', coverage: ['main'] }] },
      skills: './skills',
      config: {
        fields: {
          one: { type: 'string', default: 'default-one' },
          two: { type: 'string', default: 'default-two' },
          optional: { type: 'string' },
        }
      },
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { configKeys: ['one', 'two'] },
    }));
    const oneRoot = await writeSkill(pluginRoot, 'one', 'skills');
    await writeSkill(pluginRoot, 'two', 'skills');
    await writeSkill(pluginRoot, 'native');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), '// fixture renderer\n');
    const workspace = await readCatalogWorkspace(root, { reservedImports: CLI_RESERVED_IMPORTS });
    await writePluginConfigStore({
      pluginName: 'portable-leaves',
      scope: 'project',
      cwd: root,
      values: { two: 'custom-two' },
    });
    await fs.copy(oneRoot, path.join(materializedRoot, 'one'));
    const binding = await writeInspectionBinding(root, {
      rootDir: materializedRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'portable-leaves' },
      profile: await resolvePortableProfileBindingInput({
        platform: 'generic',
        offlineConfig: { 'portable-leaves': { two: 'custom-two' } },
        plugins: workspace.plugins,
        pluginName: 'portable-leaves',
        scope: 'project',
        cwd: root,
      }),
      artifacts: [{
        kind: 'portable-skill',
        plugin: 'portable-leaves',
        skill: 'one',
        path: 'one',
      }],
    });
    const configFile = path.join(root, 'review-config.json');
    await fs.outputJson(configFile, { 'portable-leaves': { two: 'custom-two' } });
    await writePluginConfigStore({
      pluginName: 'portable-leaves', scope: 'project', cwd: root,
      values: { two: 'changed-after-binding' }
    });

    const receipt = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      platform: 'generic',
      scope: 'project',
      configFile,
      materializations: [binding.bindingPath],
    });

    expect(receipt.skills.find((entry) => entry.skill === 'one'))
      .toMatchObject({ state: 'ready', evidencePath: binding.bindingPath });
    expect(receipt.skills.find((entry) => entry.skill === 'two'))
      .toMatchObject({ state: 'missing' });
    expect(receipt.issues).not.toContainEqual(expect.objectContaining({
      code: 'materializationNotSelected',
      path: binding.bindingPath,
    }));

    const incompatibleConfigFile = path.join(root, 'review-incompatible-config.json');
    await fs.outputJson(incompatibleConfigFile, {
      'portable-leaves': { one: 'ignored-project', two: 'custom-two' },
    });
    const incompatible = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      skills: ['one'],
      platform: 'generic',
      scope: 'project',
      configFile: incompatibleConfigFile,
      materializations: [binding.bindingPath],
    });
    expect(incompatible.skills).toEqual([
      expect.objectContaining({ skill: 'one', state: 'missing' }),
    ]);
    expect(incompatible.issues).toContainEqual(expect.objectContaining({
      code: 'materializationNotSelected',
      path: binding.bindingPath,
    }));
  });

  it('revalidates dependency defaults without reading local config stores', async () => {
    const root = await tempRoot();
    const materializedRoot = await tempRoot('aw-review-portable-cross-config-');
    await initializeCatalogWorkspace({ workspaceRoot: root });
    await writePlugin(root, manifest('portable-config-provider', {
      config: {
        schemaVersion: 5, fields: {
          registry: {
            type: 'array', default: [{ key: 'external' }],
            validation: { uniqueBy: 'key' }, items: {
              type: 'object',
              properties: { key: { type: 'string', required: true } }, additionalProperties: false
            }
          }
        }
      },
    }));
    const pluginRoot = await writePlugin(root, manifest('portable-config-consumer', {
      dependencies: ['portable-config-provider'],
      requires: { aw: { capabilities: ['aw.plugin-config-cross-plugin-value-ref.v1'] } },
      extensions: { instructions: [{ name: 'anchor', title: 'Anchor', content: 'Anchor.', coverage: ['main'] }] },
      skills: './skills',
      config: {
        schemaVersion: 5, fields: {
          selected: {
            type: 'string', default: 'external',
            valueRef: { plugin: 'portable-config-provider', field: 'registry', key: 'key' }
          }
        }
      },
    }));
    const skillRoot = await writeSkill(pluginRoot, 'portable-selected', 'skills');
    const workspace = await readCatalogWorkspace(root, { reservedImports: CLI_RESERVED_IMPORTS });
    await fs.copy(skillRoot, path.join(materializedRoot, 'portable-selected'));
    const binding = await writeInspectionBinding(root, {
      rootDir: materializedRoot,
      source: await resolveWorkspaceBindingSource(workspace), subject: { plugin: 'portable-config-consumer' },
      profile: await resolvePortableProfileBindingInput({
        platform: 'generic', plugins: workspace.plugins,
        pluginName: 'portable-config-consumer', scope: 'project', cwd: root
      }),
      artifacts: [{ kind: 'portable-skill', plugin: 'portable-config-consumer', skill: 'portable-selected', path: 'portable-selected' }],
    });
    await writePluginConfigStore({
      pluginName: 'portable-config-provider', scope: 'project', cwd: root,
      values: { registry: [] }
    });
    const receipt = await inspectReviewTarget({
      cwd: root, target: pluginRoot, platform: 'generic',
      scope: 'project', materializations: [binding.bindingPath]
    });
    expect(receipt.skills).toEqual([expect.objectContaining({ skill: 'portable-selected', state: 'ready' })]);
    expect(receipt.issues.some((issue) => issue.code === 'sourceBindingDrifted')).toBe(false);
  });

  it('uses explicit Eval platform config when selecting Review evidence', async () => {
    const root = await tempRoot();
    const materializedRoot = await tempRoot('aw-review-eval-shared-config-');
    await initializeCatalogWorkspace({ workspaceRoot: root });
    await writePlugin(root, manifest('eval-config-provider', {
      config: {
        schemaVersion: 5, fields: {
          registry: {
            type: 'array', default: [{ key: 'eval-project-only' }],
            validation: { uniqueBy: 'key' }, items: {
              type: 'object',
              properties: { key: { type: 'string', required: true } }, additionalProperties: false
            }
          }
        }
      },
    }));
    const pluginRoot = await writePlugin(root, manifest('eval-shared-config', {
      dependencies: ['eval-config-provider'],
      requires: { aw: { capabilities: ['aw.plugin-config-cross-plugin-value-ref.v1'] } },
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      config: {
        schemaVersion: 5, fields: {
          shared: { type: 'string', default: 'shared-default' },
          projectOnly: {
            type: 'string', default: 'project-default', valueRef: {
              plugin: 'eval-config-provider', field: 'registry', key: 'key', include: ['project-default'],
            }
          },
        }
      },
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { configKeys: ['shared', 'projectOnly'], sourceDirs: ['./templates'] },
    }));
    await writeSkill(pluginRoot, 'native', 'templates');
    const extensionRoot = await writeSkill(pluginRoot, 'extension', 'templates');
    await writeEval(pluginRoot, 'extension');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), '// fixture renderer\n');
    const evalManifestPath = path.join(pluginRoot, 'skills', 'extension', 'evals', 'manifest.json');
    const evalManifest = await fs.readJson(evalManifestPath);
    evalManifest.profiles['project-default'].plugins['eval-shared-config'] = {
      shared: 'eval-project-shared',
      projectOnly: 'eval-project-only',
    };
    await fs.writeJson(evalManifestPath, evalManifest);
    const workspace = await readCatalogWorkspace(root, { reservedImports: CLI_RESERVED_IMPORTS });
    const plugin = workspace.plugins.find((entry) => entry.manifest.name === 'eval-shared-config')!;
    const loaded = await readAwSkillEvalManifest({ plugin, skill: 'extension' });
    await fs.copy(extensionRoot, path.join(materializedRoot, 'target'));
    await fs.outputFile(path.join(materializedRoot, 'workspace', '.keep'), '');
    const sourceInput = await conversationEvalInput({
      workspaceRoot: root,
      materializedRoot,
      loaded,
    });
    await fs.outputJson(path.join(materializedRoot, 'cases.json'), sourceInput.selectedCases);
    const binding = await writeInspectionBinding(root, {
      rootDir: materializedRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'eval-shared-config', skill: 'extension', suite: 'behavior' },
      profile: resolveEvalProfileBindingInput(loaded.manifest.profiles[0]!, workspace.plugins).profile,
      evalInput: sourceInput.input,
      artifacts: [
        { kind: 'eval-target', skill: 'extension', path: 'target' },
        { kind: 'eval-workspace', path: 'workspace' },
        { kind: 'eval-cases', path: 'cases.json' },
      ],
    });
    const matchingConfigFile = path.join(root, 'review-matching-config.json');
    await fs.outputJson(matchingConfigFile, {
      'eval-shared-config': { shared: 'eval-project-shared', projectOnly: 'eval-project-only' },
    });

    const matching = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      skills: ['extension'],
      platform: 'codex',
      scope: 'project',
      configFile: matchingConfigFile,
      materializations: [binding.bindingPath],
    });
    expect(matching.skills).toEqual([
      expect.objectContaining({ skill: 'extension', state: 'ready', evidencePath: binding.bindingPath }),
    ]);

    const incompatibleConfigFile = path.join(root, 'review-incompatible-config.json');
    await fs.outputJson(incompatibleConfigFile, {
      'eval-shared-config': {
        shared: 'different-profile',
        projectOnly: 'eval-project-only',
      },
    });
    const incompatible = await inspectReviewTarget({
      cwd: root,
      target: pluginRoot,
      skills: ['extension'],
      platform: 'codex',
      scope: 'project',
      configFile: incompatibleConfigFile,
      materializations: [binding.bindingPath],
    });
    expect(incompatible.skills).toEqual([
      expect.objectContaining({ skill: 'extension', state: 'missing' }),
    ]);
    expect(incompatible.issues).toContainEqual(expect.objectContaining({
      code: 'materializationNotSelected',
      path: binding.bindingPath,
    }));
  });

  it('navigates a source Skill review and rejects conflicting finals', async () => {
    const root = await tempRoot();
    const firstRoot = await tempRoot('aw-review-navigation-first-');
    const secondRoot = await tempRoot('aw-review-navigation-second-');
    await initializeCatalogWorkspace({ workspaceRoot: root });
    const pluginRoot = await writePlugin(root, manifest('navigation', {
      skills: './skills',
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    }));
    const skillRoot = await writeSkill(pluginRoot, 'navigation-skill');
    await writeEval(pluginRoot, 'navigation-skill');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), '// fixture renderer\n');
    const target = path.join(skillRoot, 'SKILL.md');
    const selection = await resolveReviewSelection({
      cwd: root,
      target,
      skills: ['navigation-skill', 'navigation-skill'],
      platform: 'codex',
      scope: 'project',
    });
    const workspace = selection.workspace;

    const evalRoot = await tempRoot('aw-review-navigation-eval-');
    const loaded = await readAwSkillEvalManifest({
      plugin: workspace.plugins[0]!,
      skill: 'navigation-skill',
    });
    await fs.copy(skillRoot, path.join(evalRoot, 'target'));
    await fs.outputFile(path.join(evalRoot, 'workspace', '.keep'), '');
    const evalSourceInput = await conversationEvalInput({
      workspaceRoot: root,
      materializedRoot: evalRoot,
      loaded,
      caseIds: ['selected'],
    });
    await fs.outputJson(path.join(evalRoot, 'cases.json'), evalSourceInput.selectedCases);
    const evalBinding = await writeInspectionBinding(root, {
      rootDir: evalRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'navigation', skill: 'navigation-skill', suite: 'behavior' },
      profile: resolveEvalProfileBindingInput(loaded.manifest.profiles[0]!, workspace.plugins).profile,
      evalInput: evalSourceInput.input,
      artifacts: [
        { kind: 'eval-target', skill: 'navigation-skill', path: 'target' },
        { kind: 'eval-workspace', path: 'workspace' },
        { kind: 'eval-cases', path: 'cases.json' },
      ],
    });
    const evalReview = await inspectReviewTarget({
      cwd: root,
      target,
      platform: 'codex',
      scope: 'project',
      materializations: [evalBinding.bindingPath],
    });
    expect(evalReview.skills).toEqual([expect.objectContaining({ state: 'ready' })]);
    expect(evalReview.issues).not.toContainEqual(expect.objectContaining({
      code: 'materializationNotSelected',
      path: evalBinding.bindingPath,
    }));
    await fs.copy(skillRoot, path.join(firstRoot, 'navigation-skill'));
    const first = await writeInspectionBinding(root, {
      rootDir: firstRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'navigation', skill: 'navigation-skill' },
      profile: selection.profiles[0]!.profile,
      artifacts: [{
        kind: 'review-skill',
        plugin: 'navigation',
        skill: 'navigation-skill',
        path: 'navigation-skill',
      }],
    });

    const current = await inspectReviewTarget({
      cwd: root,
      target,
      skills: ['navigation-skill'],
      platform: 'codex',
      scope: 'project',
      materializations: [first.bindingPath, first.bindingPath],
    });
    expect(current).toMatchObject({
      schemaVersion: 2,
      command: 'review:inspect',
      view: 'review',
      ok: true,
      target: { kind: 'skill', path: skillRoot },
      skills: [{
        skill: 'navigation-skill',
        sourcePath: skillRoot,
        state: 'ready',
        evidencePath: first.bindingPath,
      }],
    });
    expect(current).not.toHaveProperty('requiredEvals');
    expect(current).not.toHaveProperty('subjects');
    const legacyRoot = await tempRoot('aw-review-navigation-v1-');
    const legacyBinding = await fs.readJson(first.bindingPath);
    legacyBinding.schemaVersion = 1;
    const legacyBindingPath = path.join(legacyRoot, 'aw-source-binding.json');
    await fs.outputJson(legacyBindingPath, legacyBinding);
    await expect(inspectReviewTarget({
      cwd: root,
      target,
      platform: 'codex',
      scope: 'project',
      materializations: [legacyBindingPath],
    })).rejects.toMatchObject({ code: 'sourceBindingInvalid', exitCode: 2 });

    await fs.copy(skillRoot, path.join(secondRoot, 'navigation-skill'));
    await fs.appendFile(path.join(secondRoot, 'navigation-skill', 'SKILL.md'), '\nDifferent final.\n');
    const second = await writeInspectionBinding(root, {
      rootDir: secondRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'navigation', skill: 'navigation-skill' },
      profile: selection.profiles[0]!.profile,
      artifacts: [{
        kind: 'review-skill',
        plugin: 'navigation',
        skill: 'navigation-skill',
        path: 'navigation-skill',
      }],
    });
    const ambiguous = await inspectReviewTarget({
      cwd: root,
      target,
      platform: 'codex',
      scope: 'project',
      materializations: [second.bindingPath, first.bindingPath],
    });
    expect(ambiguous.skills).toEqual([
      expect.objectContaining({ state: 'invalid', finalPath: null, digest: null, evidencePath: null }),
    ]);
    expect(ambiguous.issues).toContainEqual(expect.objectContaining({ code: 'materializationAmbiguous' }));

    await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\nSource drift.\n');
    const stale = await inspectReviewTarget({
      cwd: root,
      target,
      platform: 'codex',
      scope: 'project',
      materializations: [first.bindingPath],
    });
    expect(stale).toMatchObject({
      ok: true,
      skills: [{ state: 'stale', finalPath: path.join(firstRoot, 'navigation-skill') }],
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceBindingDrifted' })]),
    });
  });

  it('navigates the declared source for each dynamic Skill surface', async () => {
    const root = await tempRoot();
    await initializeCatalogWorkspace({ workspaceRoot: root });

    const portableRoot = await writePlugin(root, manifest('declared-portable', {
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.', coverage: ['main'] }] },
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { configKeys: [], sourceDirs: ['./templates/shared-name/source', './templates/shared-name'] },
    }));
    await writeSkill(portableRoot, 'shared-name', 'templates');
    const portableSource = path.join(portableRoot, 'templates', 'shared-name', 'source');
    await fs.outputFile(path.join(portableSource, 'input.txt'), 'portable declared source\n');
    await fs.outputFile(path.join(portableRoot, 'scripts', 'render.mjs'), '// fixture renderer\n');

    const surfacesRoot = await writePlugin(root, manifest('surface-sources', {
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { configKeys: [], sourceDirs: ['./templates/same-skill/codex-source', './templates/same-skill/claude-source'] },
    }));
    const surfaceSkillRoot = await writeSkill(surfacesRoot, 'same-skill', 'templates');
    const codexSource = path.join(surfaceSkillRoot, 'codex-source');
    const claudeSource = path.join(surfaceSkillRoot, 'claude-source');
    await fs.outputFile(path.join(codexSource, 'input.txt'), 'codex source\n');
    await fs.outputFile(path.join(claudeSource, 'input.txt'), 'claude source\n');
    await fs.outputFile(path.join(surfacesRoot, 'scripts', 'render.mjs'), '// fixture renderer\n');

    const extensionRoot = await writePlugin(root, manifest('renderer-source', {
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { configKeys: [] },
      marketplace: {
        category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    }));
    const rendererSource = path.join(extensionRoot, 'scripts', 'render.mjs');
    await fs.outputFile(rendererSource, '// actual extension source\n');

    const assertMappedSource = async (options: {
      pluginRoot: string;
      skill: string;
      platform: 'codex' | 'claude' | 'generic';
      expectedSource: string;
    }): Promise<void> => {
      const review = await inspectReviewTarget({
        cwd: root,
        target: options.pluginRoot,
        skills: [options.skill],
        platform: options.platform,
        scope: 'project',
      });
      expect(review.skills).toEqual([]);
      expect(review.sources).toContain(options.expectedSource);
      expect(review.issues).toContainEqual(expect.objectContaining({ code: 'dynamicComponentsUnprepared' }));
    };

    await assertMappedSource({
      pluginRoot: portableRoot,
      skill: 'shared-name',
      platform: 'generic',
      expectedSource: portableSource,
    });
    await assertMappedSource({
      pluginRoot: surfacesRoot,
      skill: 'same-skill',
      platform: 'codex',
      expectedSource: codexSource,
    });
    await assertMappedSource({
      pluginRoot: surfacesRoot,
      skill: 'same-skill',
      platform: 'claude',
      expectedSource: claudeSource,
    });
    await assertMappedSource({
      pluginRoot: extensionRoot,
      skill: 'placeholder',
      platform: 'codex',
      expectedSource: rendererSource,
    });
  });
});
