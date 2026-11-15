import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { initializeCatalogWorkspace, type PluginManifestSource, type PlatformTarget } from '@lesliechan721/aw-plugin-core';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectReviewTarget } from '../../src/commands/review-inspection.js';
import { prepareReviewTarget } from '../../src/commands/review-preparation.js';
import { prepareSkillEval } from '../../src/commands/skill-eval.js';
import { readAwSkillEvalManifest } from '../../src/eval/manifest-v1.js';
import { materializePortableSkills } from '../../src/portable/materializer.js';
import { readAwSourceBinding, resolvePortableProfileBindingInput } from '../../src/review/source-binding.js';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { materializeAwSkillEvalSubject, resolveMaterializedSubjectRoot } from '../../scripts/aw-skill-eval-materializer.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

const platforms = ['codex', 'claude', 'cursor', 'antigravity', 'opencode', 'pi', 'gemini', 'copilot', 'grok', 'generic'] as const;

async function fixture(): Promise<{ root: string; pluginRoot: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-author-platform-')));
  roots.push(root);
  await initializeCatalogWorkspace({ workspaceRoot: root });
  const pluginRoot = path.join(root, 'plugins', 'platform-fixture');
  const manifest: PluginManifestSource = {
    schemaVersion: 4, name: 'platform-fixture', version: '1.0.0', description: 'Platform fixture.',
    platforms: [...platforms], skills: './skills',
    marketplace: { category: 'test', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    config: { schemaVersion: 5, fields: { mode: { type: 'string', default: 'common' } },
      platforms: Object.fromEntries(platforms.map((platform) => [platform, { fields: {
        mode: { type: 'string', default: `${platform}-default` },
        flavor: { type: 'string', default: `${platform}-flavor` },
      } }])) },
    buildConfig: { templates: { include: ['skills/**/*.md'], vars: { host: Object.fromEntries(platforms.map((platform) => [platform, platform])) } },
      skillRuntimeFiles: platforms.map((platform) => ({ skill: 'static', target: 'references/runtime.txt',
        source: `./resources/runtime-${platform}.txt`, platforms: [platform] })) },
    scripts: { node: { build: { runner: 'node', path: './build.mjs' } }, artifacts: { render: { runner: 'node', path: './render.mjs' } } },
    artifacts: { configKeys: ['mode', 'flavor'], sourceDirs: ['./resources'] },
  };
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest);
  await fs.outputFile(path.join(pluginRoot, 'skills', 'static', 'SKILL.md'),
    '---\nname: static\ndescription: Static platform fixture.\n---\n{{host}}\n');
  await fs.outputFile(path.join(pluginRoot, 'skills', 'static', 'README.md'), '# {{host}}\n');
  await fs.outputFile(path.join(pluginRoot, 'skills', 'static', 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
  for (const platform of platforms) await fs.outputFile(path.join(pluginRoot, 'resources', `runtime-${platform}.txt`), `${platform} runtime\n`);
  await fs.outputFile(path.join(pluginRoot, 'README.md'), '# Platform fixture\n');
  await fs.outputFile(path.join(pluginRoot, 'build.mjs'), `import fs from 'node:fs';
for (const platform of ${JSON.stringify(platforms)}) fs.writeFileSync(new URL('./resources/generated-'+platform+'.md', import.meta.url), platform+' generated\\n');
`);
  await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (process.env.AW_PLUGIN_PLATFORM !== context.platform || context.surface !== 'agent-plugin' || context.platformCapabilities.basis !== 'profile') process.exit(42);
const platform = context.platform;
if (!context.allowedOutputKinds.includes('skill')) {
  console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:[]}));
} else if (context.platformCapabilities.kinds.skill.status !== 'supported') {
  console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:[{id:'dynamic',kind:'skill',name:'dynamic',requiredFeatures:[{feature:'component.kind.skill'}],reasonCode:'capability-unverified'}]}));
} else {
  console.log(JSON.stringify({version:3,components:[{id:'dynamic',kind:'skill',name:'dynamic',content:{files:{
    'SKILL.md':{text:'---\\nname: dynamic\\ndescription: Dynamic platform fixture.\\n---\\n'+platform+' '+context.config.values.mode+' '+context.config.values.flavor+'\\n'},
    'README.md':{text:'# Dynamic\\n'},
    'references/runtime.txt':{source:{kind:'bundle',path:'resources/runtime-'+platform+'.txt'}},
    'references/generated.md':{source:{kind:'bundle',path:'resources/generated-'+platform+'.md'}}
  }}}],omitted:[],unmet:[]}));
}
`);
  return { root, pluginRoot, env: { ...process.env, AW_HOME: path.join(root, 'state', 'aw-home'), PATH: '',
    HOME: path.join(root, 'state', 'home'), USERPROFILE: path.join(root, 'state', 'home'),
    CODEX_HOME: path.join(root, 'state', 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'state', 'claude') } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });

describe('author canonical platforms', () => {
  it('binds each explicit target to its own templates, resources, config and qualified capability evidence', async () => {
    const { root, pluginRoot, env } = await fixture();
    const plugin = await readPluginManifest(pluginRoot);
    const digests: string[] = [];
    for (const platform of platforms) {
      const materialized = await materializePortableSkills({ plugins: [plugin], pluginId: plugin.manifest.name,
        platform, scope: 'user', cwd: root, env });
      try {
        const skillRoot = path.join(materialized.rootDir, 'skills');
        if (getAuthoringPlatformCapabilities(platform, 'user').kinds.skill.status === 'supported') {
          expect(materialized.candidates.map((skill) => skill.name)).toEqual(['dynamic', 'static']);
          expect(await fs.readFile(path.join(skillRoot, 'static', 'SKILL.md'), 'utf8')).toContain(platform);
          expect(await fs.readFile(path.join(skillRoot, 'static', 'references', 'runtime.txt'), 'utf8')).toBe(`${platform} runtime\n`);
          expect(await fs.readFile(path.join(skillRoot, 'dynamic', 'SKILL.md'), 'utf8')).toContain(`${platform} ${platform}-default ${platform}-flavor`);
          expect(await fs.readFile(path.join(skillRoot, 'dynamic', 'references', 'runtime.txt'), 'utf8')).toBe(`${platform} runtime\n`);
          expect(await fs.readFile(path.join(skillRoot, 'dynamic', 'references', 'generated.md'), 'utf8')).toBe(`${platform} generated\n`);
          expect(materialized.preparation.flatMap((unit) => unit.components)).toContainEqual({ id: 'dynamic', kind: 'skill', name: 'dynamic', source: 'dynamic' });
        } else {
          expect(materialized.candidates).toEqual([]);
          expect(materialized.preparation.flatMap((unit) => unit.unmet)).toContainEqual(expect.objectContaining({ id: 'dynamic', reasonCode: 'capability-unverified' }));
        }
        expect(materialized.preparation.every((unit) => unit.platform === platform && unit.profileId.startsWith(`${platform}:`))).toBe(true);
        const binding = await resolvePortableProfileBindingInput({ plugins: [plugin], pluginName: plugin.manifest.name,
          platform, scope: 'user', cwd: root, env });
        expect(binding).toMatchObject({ id: `${platform}-user`, platform, inputDigest: materialized.configDigest });
        digests.push(binding.inputDigest);
      } finally { await materialized.cleanup(); }
    }
    expect(new Set(digests).size).toBe(platforms.length);
    expect(await fs.pathExists(path.join(pluginRoot, 'resources', 'generated-generic.md'))).toBe(false);
  });

  it('validates source and renderer fixtures with their canonical profile defaults', async () => {
    const { root, pluginRoot, env } = await fixture();
    await execFileAsync(process.execPath, [path.join(pluginRoot, 'build.mjs')], { cwd: root, env });
    await fs.appendFile(path.join(pluginRoot, 'render.mjs'), "\nif(context.config.values.mode !== platform + '-default') process.exit(43);\n");
    const result = await execFileAsync(process.execPath, [
      path.resolve(import.meta.dirname, '../../authoring/scripts/validate-plugin.mjs'), pluginRoot,
      '--workspace-root', root, '--json',
    ], { cwd: root, env: { ...env, PATH: process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin' } }).catch((error: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(`${error.stdout ?? ''}\n${error.stderr ?? error.message}`);
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, errors: [] });
  });

  it.each([undefined, 'agent-skills', 'codex', 'claude', 'unknown'])('rejects invalid or undeclared export platform %s before a build', async (platform) => {
    const { root, pluginRoot, env } = await fixture();
    const marker = path.join(root, 'build-ran');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.platforms = ['generic'];
    manifest.buildConfig.skillRuntimeFiles = manifest.buildConfig.skillRuntimeFiles.filter((file: { platforms: string[] }) => file.platforms.includes('generic'));
    manifest.scripts.node = { build: { runner: 'node', path: './build.mjs' } };
    await fs.writeJson(manifestPath, manifest);
    await fs.outputFile(path.join(pluginRoot, 'build.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`);
    const plugin = await readPluginManifest(pluginRoot);
    await expect(materializePortableSkills({ plugins: [plugin], pluginId: plugin.manifest.name,
      platform: platform as PlatformTarget, scope: 'user', cwd: root, env })).rejects.toThrow(
        platform === 'codex' || platform === 'claude' ? /does not support platform/u : /explicit canonical platform/u,
      );
    expect(await fs.pathExists(marker)).toBe(false);
  });

  it('materializes an explicit export Eval profile without selecting an execution backend', async () => {
    const { root, pluginRoot, env } = await fixture();
    const plugin = await readPluginManifest(pluginRoot);
    const outputRoot = path.join(root, 'eval-subject');
    const subject = await materializeAwSkillEvalSubject({ plugin, plugins: [plugin],
      profile: { id: 'export', platform: 'generic', scope: 'project', plugins: [{
        name: plugin.manifest.name, configByScope: { user: { mode: 'explicit-generic' } },
      }] }, requiredSkills: new Set(['static', 'dynamic']), initializeGitRepository: false,
      outputRoot, workRoot: path.join(root, 'eval-work'),
      sourceIdentity: `sha256:${'a'.repeat(64)}`, workspaceIdentity: 'fixture-workspace', env });
    const skillRoot = path.join(resolveMaterializedSubjectRoot(outputRoot, subject), '.agents', 'skills');
    expect(await fs.readFile(path.join(skillRoot, 'dynamic', 'SKILL.md'), 'utf8')).toContain('generic explicit-generic');
    expect(await fs.readFile(path.join(skillRoot, 'static', 'references', 'runtime.txt'), 'utf8')).toBe('generic runtime\n');
  });

  it('keeps Review evidence on its concrete platform and rejects the old consumer profile', async () => {
    const { root, env } = await fixture();
    const out = path.join(root, 'review-generic');
    const configFile = path.join(root, 'review-config.json');
    await fs.writeJson(configFile, { 'platform-fixture': { flavor: 'selected-generic-flavor' } });
    const prepared = await prepareReviewTarget({ cwd: root, target: 'platform-fixture', platform: 'generic',
      scope: 'project', out, env, configFile });
    expect(prepared.receipt.issues).toEqual([]);
    expect(prepared.exitCode).toBe(0);
    expect(await fs.readFile(path.join(out, 'skills', 'dynamic', 'SKILL.md'), 'utf8')).toContain('selected-generic-flavor');
    const binding = await readAwSourceBinding(prepared.receipt.sourceBindingPath!);
    expect(binding.profile).toMatchObject({ platform: 'generic', id: 'generic-project' });
    const inspected = await inspectReviewTarget({ cwd: root, target: 'platform-fixture', platform: 'pi', scope: 'project',
      materializations: [prepared.receipt.sourceBindingPath!], env });
    expect(inspected.skills.every((skill) => skill.state === 'missing')).toBe(true);
    const invalid = await prepareReviewTarget({ cwd: root, target: 'platform-fixture', platform: 'agent-skills' as PlatformTarget,
      scope: 'project', out: path.join(root, 'invalid'), env });
    expect(invalid.exitCode).toBe(2);
    expect(await fs.pathExists(path.join(root, 'invalid'))).toBe(false);
  });

  it('requires Eval platform and rejects an unsupported execution backend before materialization', async () => {
    const { root, pluginRoot, env } = await fixture();
    const evalRoot = path.join(pluginRoot, 'skills', 'static', 'evals');
    const manifest = { version: 1, defaults: {}, profiles: { selected: {
      scope: 'project', plugins: { 'platform-fixture': {} },
    } }, suites: [{ id: 'trigger', kind: 'trigger', cases: 'cases.json' }] };
    await fs.outputJson(path.join(evalRoot, 'cases.json'), { version: 1,
      suite: { kind: 'trigger', unitUnderTest: 'static' }, cases: [{ id: 'loads', split: 'validation', tags: [],
        input: { query: 'Use static.', expectedLoad: true } }] });
    await fs.outputJson(path.join(evalRoot, 'manifest.json'), manifest);
    const plugin = await readPluginManifest(pluginRoot);
    await expect(readAwSkillEvalManifest({ plugin, skill: 'static' })).rejects.toThrow(/explicit canonical platform/u);
    const profile = manifest.profiles.selected as typeof manifest.profiles.selected & { platform: string };
    profile.platform = 'agent-skills';
    await fs.writeJson(path.join(evalRoot, 'manifest.json'), manifest);
    await expect(readAwSkillEvalManifest({ plugin, skill: 'static' })).rejects.toThrow(/explicit canonical platform/u);
    profile.platform = 'pi';
    await fs.writeJson(path.join(evalRoot, 'manifest.json'), manifest);
    await expect(prepareSkillEval({ workspaceRoot: root, workspaceRootResolvedFrom: 'explicit',
      pluginName: plugin.manifest.name, skillName: 'static', cwd: root, output: path.join(root, 'eval-output'), env }))
      .rejects.toThrow(/no supported backend for platform "pi"/u);
    expect(await fs.pathExists(path.join(root, 'eval-output'))).toBe(false);
  });
});
