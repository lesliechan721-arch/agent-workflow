import os from 'node:os';
import path from 'node:path';

import { initializeCatalogWorkspace, type PluginManifestSource } from '@lesliechan721/aw-plugin-core';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectReviewTarget } from '../../src/commands/review-inspection.js';
import { prepareSkillEval } from '../../src/commands/skill-eval.js';
import { prepareReviewTarget } from '../../src/commands/review-preparation.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { materializePortableSkills } from '../../src/portable/materializer.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { createAwSourceBindingWorkspaceValidationContext, readAwSourceBinding, validateAwSourceBindingForWorkspace, writeAwSourceBinding } from '../../src/review/source-binding.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });

async function fixture(): Promise<{ root: string; pluginRoot: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-author-profile-v4-')));
  roots.push(root);
  await initializeCatalogWorkspace({ workspaceRoot: root });
  const pluginRoot = path.join(root, 'plugins', 'profile-fixture');
  const manifest: PluginManifestSource = {
    schemaVersion: 4, name: 'profile-fixture', version: '0.1.0', description: 'Author profile fixture.',
    platforms: ['generic', 'codex', 'claude'],
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    artifacts: { configKeys: [], sourceDirs: ['./templates'] },
    scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
  };
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest);
  await fs.outputFile(path.join(pluginRoot, 'templates', 'reference.md'), 'Runtime reference.\n');
  await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (context.surface !== 'agent-plugin' || context.platformCapabilities.basis !== 'profile') process.exit(31);
if (!context.allowedOutputKinds.includes('skill')) {
  console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:[]}));
} else if (context.platformCapabilities.kinds.skill.status !== 'supported') {
  console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:[{id:'computed',kind:'skill',name:'computed-name',requiredFeatures:[{feature:'component.kind.skill'}],reasonCode:'capability-unverified'}]}));
} else {
  console.log(JSON.stringify({version:3,components:[{id:'computed',kind:'skill',name:'computed-name',content:{files:{
    'SKILL.md':{text:'---\\nname: computed-name\\ndescription: A computed author Skill.\\n---\\nRead references/reference.md.\\n'},
    'README.md':{text:'# Computed Skill\\n'},
    'references/reference.md':{source:{kind:'bundle',path:'templates/reference.md'}}
  }}}],omitted:[],unmet:[]}));
}
`);
  const env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    AW_HOME: path.join(root, 'aw-home'), CODEX_HOME: path.join(root, 'codex-home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'), PATH: '' };
  await fs.ensureDir(env.HOME);
  return { root, pluginRoot, env };
}

describe('v4 author profile consumers', () => {
  it('prepares actual dynamic names without a local client and inspects only bound evidence', async () => {
    const { root, pluginRoot, env } = await fixture();
    const before = await inspectReviewTarget({ cwd: root, target: pluginRoot, platform: 'generic', scope: 'user', env });
    expect(before.skills).toEqual([]);
    expect(before.issues).toContainEqual(expect.objectContaining({ code: 'dynamicComponentsUnprepared' }));
    const out = path.join(root, 'review-final');
    const prepared = await prepareReviewTarget({ cwd: root, target: pluginRoot, platform: 'generic', scope: 'user', out, env });
    expect(prepared.receipt.issues).toEqual([]);
    expect(prepared.exitCode).toBe(0);
    expect(prepared.receipt.skills.map((skill) => skill.skill)).toEqual(['computed-name']);
    expect(await fs.readFile(path.join(out, 'skills', 'computed-name', 'references', 'reference.md'), 'utf8')).toBe('Runtime reference.\n');
    const binding = await readAwSourceBinding(path.join(out, 'aw-source-binding.json'));
    expect(binding.preparation).toContainEqual(expect.objectContaining({ platform: 'generic',
      components: [{ id: 'computed', kind: 'skill', name: 'computed-name', source: 'dynamic' }] }));
    const inspected = await inspectReviewTarget({ cwd: root, target: pluginRoot, platform: 'generic', scope: 'user',
      materializations: [path.join(out, 'aw-source-binding.json')], env });
    expect(inspected.skills).toContainEqual(expect.objectContaining({ skill: 'computed-name', state: 'ready' }));
    const changedPackageFile = path.join(out, binding.preparation[0]!.outputs[0]!.path, 'changed.txt');
    await fs.outputFile(changedPackageFile, 'Package drift.');
    expect((await validateAwSourceBindingForWorkspace({ bindingPath: path.join(out, 'aw-source-binding.json'),
      context: await createAwSourceBindingWorkspaceValidationContext(root), expectedSubject: binding.subject, cwd: root, env })).state).toBe('drifted');
    await fs.remove(changedPackageFile);
    const wrongCapabilitiesRoot = path.join(root, 'wrong-capabilities');
    await fs.copy(out, wrongCapabilitiesRoot);
    await fs.remove(path.join(wrongCapabilitiesRoot, 'aw-source-binding.json'));
    const wrongCapabilities = structuredClone(binding.preparation);
    wrongCapabilities[0]!.capabilitiesDigest = `sha256:${'f'.repeat(64)}`;
    const wrongBinding = await writeAwSourceBinding({ rootDir: wrongCapabilitiesRoot, source: binding.source,
      subject: binding.subject, profile: binding.profile, preparation: wrongCapabilities,
      artifacts: binding.artifacts.map(({ digest: _digest, ...artifact }) => artifact) });
    expect((await validateAwSourceBindingForWorkspace({ bindingPath: wrongBinding.bindingPath,
      context: await createAwSourceBindingWorkspaceValidationContext(root), expectedSubject: binding.subject, cwd: root, env })).issues)
      .toContainEqual(expect.objectContaining({ code: 'sourceBindingProfileDrift' }));
    await fs.appendFile(path.join(pluginRoot, 'templates', 'reference.md'), 'Source drift.\n');
    expect((await validateAwSourceBindingForWorkspace({ bindingPath: path.join(out, 'aw-source-binding.json'),
      context: await createAwSourceBindingWorkspaceValidationContext(root), expectedSubject: binding.subject, cwd: root, env })).state).toBe('drifted');
  });

  it('keeps native profile capability gaps without requiring or inventing a client', async () => {
    const { root, pluginRoot, env } = await fixture();
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.platforms = ['generic', 'codex', 'cursor'];
    manifest.requires = { aw: { capabilities: ['aw.managed-commands.v1'] } };
    manifest.managedCommands = { sets: [{ set: 'tools',
      producer: { kind: 'artifact', platform: 'cursor', artifactId: 'computed' }, mode: 'static',
      entries: [{ key: 'run', variant: 'default', runner: 'node', entry: 'scripts/run.mjs' }],
    }] };
    manifest.extensions = { permissions: [{ name: 'command-permission',
      allow: [{ command: { set: 'tools', key: 'run', variant: 'default' } }],
      agentOverrides: { codex: null, generic: null },
    }] };
    await fs.writeJson(manifestPath, manifest);
    const out = path.join(root, 'native-review');
    const result = await prepareReviewTarget({ cwd: root, target: pluginRoot, platform: 'cursor', scope: 'project',
      out, env });
    expect(result.receipt.issues).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.receipt.skills).toEqual([]);
    expect(result.receipt.preparation?.flatMap((unit) => unit.unmet)).toContainEqual(expect.objectContaining({
      id: 'computed', reasonCode: 'capability-unverified', requiredFeatures: [{ feature: 'component.kind.skill' }],
    }));
    expect(result.receipt.preparation?.every((unit) => unit.outputs.length === 0)).toBe(true);
    expect(await fs.pathExists(path.join(out, 'native'))).toBe(false);
    const inspected = await inspectReviewTarget({ cwd: root, target: pluginRoot, platform: 'cursor', scope: 'project',
      materializations: [result.receipt.sourceBindingPath!], env });
    expect(inspected.issues).toContainEqual(expect.objectContaining({ code: 'componentUnmet' }));
    expect(inspected.issues.some((issue) => issue.code === 'dynamicComponentsUnprepared')).toBe(false);
  });

  it('exports standard Skills with an explicit profile through the same component preparation', async () => {
    const { root, pluginRoot, env } = await fixture();
    const plugin = await readPluginManifest(pluginRoot);
    const exported = await materializePortableSkills({ plugins: [plugin], pluginId: plugin.manifest.name,
      platform: 'generic', scope: 'user', cwd: root, env, outputRoot: path.join(root, 'exported') });
    expect(exported.candidates.map((skill) => skill.name)).toEqual(['computed-name']);
    expect(await fs.pathExists(path.join(exported.rootDir, 'skills', 'computed-name', 'SKILL.md'))).toBe(true);
    expect(exported.preparation[0]?.profileId).toContain('generic:');
    await exported.cleanup();
  });

  it('prepares Eval from the actual computed Skill and binds the complete profile evidence', async () => {
    const { root, pluginRoot, env } = await fixture();
    const evalRoot = path.join(pluginRoot, 'skills', 'computed-name', 'evals');
    await fs.outputJson(path.join(evalRoot, 'manifest.json'), {
      version: 1, defaults: { profile: 'offline' },
      profiles: { offline: { platform: 'generic', scope: 'user', plugins: { 'profile-fixture': {} } } },
      suites: [{ id: 'custom', kind: 'custom-process', cases: 'cases.json',
        provider: { type: 'custom-process', command: ['node', 'provider.mjs'] } }],
    });
    await fs.outputJson(path.join(evalRoot, 'cases.json'), { version: 1,
      suite: { kind: 'custom-process', unitUnderTest: 'computed-name' },
      cases: [{ id: 'offline-case', split: 'validation', tags: [], input: { prompt: 'Check the fixture.' },
        expected: { ok: true }, assertions: ['Returns the fixture result.'] }],
    });
    await fs.outputFile(path.join(evalRoot, 'provider.mjs'), 'export async function runEvalProvider() { return {}; }\n');
    const evalOutputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-author-profile-eval-output-'));
    roots.push(evalOutputRoot);
    const out = path.join(evalOutputRoot, 'eval-final');
    await prepareSkillEval({ workspaceRoot: root, workspaceRootResolvedFrom: 'explicit', pluginName: 'profile-fixture',
      skillName: 'computed-name', suiteId: 'custom', profileId: 'offline', output: out, cwd: root, env });
    expect(await fs.pathExists(path.join(out, 'targets', 'current', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(out, 'workspace', 'subject', '.agents', 'skills', 'computed-name'))).toBe(false);
    const binding = await readAwSourceBinding(path.join(out, 'aw-source-binding.json'));
    expect(binding.profile.kind).toBe('eval');
    expect(binding.preparation[0]?.components).toEqual([{ id: 'computed', kind: 'skill', name: 'computed-name', source: 'dynamic' }]);
    expect((await validateAwSourceBindingForWorkspace({ bindingPath: path.join(out, 'aw-source-binding.json'),
      context: await createAwSourceBindingWorkspaceValidationContext(root), expectedSubject: binding.subject, cwd: root, env })).state).toBe('verified');
  });

  it('bundles global v4 runtime imports and rejects retired author fields', async () => {
    const { root, pluginRoot } = await fixture();
    const providerRoot = path.join(root, 'plugins', 'provider');
    const base = await fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'));
    await fs.outputFile(path.join(providerRoot, 'shared', 'runtime.mjs'), 'export const value = 1;\n');
    await fs.outputJson(path.join(providerRoot, '.agents-plugin', 'plugin.json'), {
      ...base, name: 'provider', artifacts: undefined, scripts: undefined,
      buildConfig: { runtimeExports: [{ name: 'runtime', source: './shared/runtime.mjs', requires: { aw: { capabilities: [] } } }] },
    });
    base.artifacts.runtimeImports = [{ name: 'runtime', plugin: 'provider', export: 'runtime' }];
    await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), base);
    const plugins = await Promise.all([pluginRoot, providerRoot].map((directory) => readPluginManifest(directory)));
    const out = path.join(root, 'bundle');
    await bundleLocalPlugin(plugins[0]!, out, { runtimeResolver: createCatalogRuntimeImportResolver(plugins) });
    expect(await fs.readFile(path.join(out, '.agents-plugin', 'runtime-imports', 'runtime'), 'utf8')).toBe('export const value = 1;\n');
    expect((await fs.readJson(path.join(out, '.agents-plugin', 'plugin.json'))).artifacts.runtimeImports[0].resolved.path)
      .toBe('./.agents-plugin/runtime-imports/runtime');
    base.artifacts.targets = [];
    await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), base);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(/artifacts.*additional properties/);
  });
});
