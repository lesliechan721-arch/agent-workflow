import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { initializeCatalogWorkspace, type PluginManifestSource } from '@lesliechan721/aw-plugin-core';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectReviewTarget } from '../../src/commands/review-inspection.js';
import { prepareReviewTarget } from '../../src/commands/review-preparation.js';
import { prepareSkillEval } from '../../src/commands/skill-eval.js';
import { readAwSkillEvalManifest } from '../../src/eval/manifest-v1.js';
import { materializePortableSkills } from '../../src/portable/materializer.js';
import { readAwSourceBinding, resolvePortableProfileBindingInput } from '../../src/review/source-binding.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { materializeAwSkillEvalSubject, resolveMaterializedSubjectRoot } from '../../scripts/aw-skill-eval-materializer.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function fixture(): Promise<{ root: string; pluginRoot: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-author-platform-')));
  roots.push(root);
  await initializeCatalogWorkspace({ workspaceRoot: root });
  const pluginRoot = path.join(root, 'plugins', 'platform-fixture');
  const manifest: PluginManifestSource = {
    schemaVersion: 3, name: 'platform-fixture', version: '1.0.0', description: 'Platform fixture.',
    platforms: ['cursor', 'pi'], skills: './skills',
    marketplace: { category: 'test', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    config: { schemaVersion: 5, fields: { mode: { type: 'string', default: 'common' } }, platforms: {
      cursor: { fields: { mode: { type: 'string', default: 'cursor-default' }, flavor: { type: 'string', default: 'cursor-flavor' } } },
      pi: { fields: { mode: { type: 'string', default: 'pi-default' }, flavor: { type: 'string', default: 'pi-flavor' } } },
    } },
    buildConfig: { templates: { include: ['skills/**/*.md'], vars: { host: { cursor: 'Cursor', pi: 'Pi' } } },
      skillRuntimeFiles: [
        { skill: 'static', target: 'references/runtime.txt', source: './runtime-cursor.txt', platforms: ['cursor'] },
        { skill: 'static', target: 'references/runtime.txt', source: './runtime-pi.txt', platforms: ['pi'] },
        { skill: 'dynamic', target: 'references/runtime.txt', source: './runtime-cursor.txt', platforms: ['cursor'] },
        { skill: 'dynamic', target: 'references/runtime.txt', source: './runtime-pi.txt', platforms: ['pi'] },
      ], generatedSkillRuntimeFiles: [{ skill: 'dynamic', target: 'references/generated.md', platforms: ['cursor', 'pi'] }] },
    scripts: { node: { build: { runner: 'node', path: './build.mjs' } }, artifacts: { render: { runner: 'node', path: './render.mjs' } } },
    artifacts: { targets: (['cursor', 'pi'] as const).map((platform) => ({
      id: `${platform}-dynamic`, platform, distribution: 'agent-skills', target: 'agent-skills.skill',
      kind: 'skill', skillKey: 'dynamic', sourceDirs: ['./skills/dynamic'], scopes: ['user', 'project'], states: ['present'], refreshKeys: ['mode', 'flavor'],
    })) },
  };
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest);
  await fs.outputFile(path.join(pluginRoot, 'skills', 'static', 'SKILL.md'),
    '---\nname: static\ndescription: Static platform fixture.\n---\n{{host}}\n');
  await fs.outputFile(path.join(pluginRoot, 'skills', 'static', 'README.md'), '# {{host}}\n');
  await fs.outputFile(path.join(pluginRoot, 'runtime-cursor.txt'), 'Cursor runtime\n');
  await fs.outputFile(path.join(pluginRoot, 'runtime-pi.txt'), 'Pi runtime\n');
  await fs.outputFile(path.join(pluginRoot, 'README.md'), '# Platform fixture\n');
  await fs.outputFile(path.join(pluginRoot, 'skills', 'dynamic', 'README.md'), '# Dynamic\n');
  await fs.outputFile(path.join(pluginRoot, 'build.mjs'), `import fs from 'node:fs';
const output = new URL('./skills/dynamic/references/generated.md', import.meta.url);
fs.mkdirSync(new URL('.', output), {recursive:true}); fs.writeFileSync(output, '{{host}} generated\\n');
`);
  await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (process.env.AW_PLUGIN_PLATFORM !== context.platform || process.env.AW_PLUGIN_DISTRIBUTION !== 'agent-skills') process.exit(42);
const platform = context.platform;
console.log(JSON.stringify({version:2,artifacts:context.requestedArtifactIds.map(id=>({
  id,platform,distribution:'agent-skills',target:'agent-skills.skill',kind:'skill',state:'present',
  skillKey:'dynamic',refreshKeys:['mode','flavor'],content:{files:{
    'SKILL.md':'---\\nname: dynamic\\ndescription: Dynamic platform fixture.\\n---\\n'+platform+' '+context.config.values.mode+' '+context.config.values.flavor+'\\n',
    'README.md':'# Dynamic\\n'
  }}
}))}));
`);
  return { root, pluginRoot, env: { ...process.env, AW_HOME: path.join(root, 'state', 'aw-home'),
    HOME: path.join(root, 'state', 'home'), USERPROFILE: path.join(root, 'state', 'home'),
    CODEX_HOME: path.join(root, 'state', 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'state', 'claude') } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });

describe('author canonical platforms', () => {
  it('uses the same target for static templates, runtime files, dynamic config and binding identity', async () => {
    const { root, pluginRoot, env } = await fixture();
    const plugin = await readPluginManifest(pluginRoot);
    const digests: string[] = [];
    for (const platform of ['cursor', 'pi'] as const) {
      const materialized = await materializePortableSkills({ plugins: [plugin], pluginId: plugin.manifest.name,
        platform, scope: 'user', cwd: root, env });
      try {
        const skillRoot = path.join(materialized.rootDir, 'skills');
        expect(await fs.readFile(path.join(skillRoot, 'static', 'SKILL.md'), 'utf8'))
          .toContain(platform === 'cursor' ? 'Cursor' : 'Pi');
        expect(await fs.readFile(path.join(skillRoot, 'static', 'references', 'runtime.txt'), 'utf8'))
          .toBe(platform === 'cursor' ? 'Cursor runtime\n' : 'Pi runtime\n');
        expect(await fs.readFile(path.join(skillRoot, 'dynamic', 'SKILL.md'), 'utf8'))
          .toContain(`${platform} ${platform}-default`);
        expect(await fs.readFile(path.join(skillRoot, 'dynamic', 'references', 'runtime.txt'), 'utf8'))
          .toBe(platform === 'cursor' ? 'Cursor runtime\n' : 'Pi runtime\n');
        expect(await fs.readFile(path.join(skillRoot, 'dynamic', 'references', 'generated.md'), 'utf8'))
          .toBe(platform === 'cursor' ? 'Cursor generated\n' : 'Pi generated\n');
        const binding = await resolvePortableProfileBindingInput({ plugins: [plugin], pluginName: plugin.manifest.name,
          platform, scope: 'user', cwd: root, env });
        expect(binding).toMatchObject({ id: `${platform}-user`, platform, inputDigest: materialized.configDigest });
        digests.push(binding.inputDigest);
      } finally { await materialized.cleanup(); }
    }
    expect(digests[0]).not.toBe(digests[1]);
  });

  it('validates Portable-only source and renderer fixtures with their canonical target defaults', async () => {
    const { root, pluginRoot, env } = await fixture();
    await fs.appendFile(path.join(pluginRoot, 'render.mjs'), "\nif(context.config.values.mode !== platform + '-default') process.exit(43);\n");
    const result = await execFileAsync(process.execPath, [
      path.resolve(import.meta.dirname, '../../authoring/scripts/validate-plugin.mjs'), pluginRoot,
      '--workspace-root', root, '--json',
    ], { cwd: root, env }).catch((error: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(`${error.stdout ?? ''}\n${error.stderr ?? error.message}`);
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, errors: [] });
  });

  it.each([undefined, 'agent-skills', 'codex', 'claude', 'unknown', 'generic'])('rejects invalid or unsupported Portable platform %s before a build', async (platform) => {
    const { root, pluginRoot, env } = await fixture();
    const marker = path.join(root, 'build-ran');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.scripts.node = { build: { runner: 'node', path: './build.mjs' } };
    await fs.writeJson(manifestPath, manifest);
    await fs.outputFile(path.join(pluginRoot, 'build.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`);
    const plugin = await readPluginManifest(pluginRoot);
    await expect(materializePortableSkills({ plugins: [plugin], pluginId: plugin.manifest.name,
      platform: platform as 'cursor', scope: 'user', cwd: root, env })).rejects.toThrow(
        platform === 'generic' ? /does not support platform/u : /explicit Portable canonical platform/u,
      );
    expect(await fs.pathExists(marker)).toBe(false);
  });

  it('materializes an explicit Portable Eval profile without selecting an execution backend', async () => {
    const { root, pluginRoot, env } = await fixture();
    const plugin = await readPluginManifest(pluginRoot);
    const outputRoot = path.join(root, 'eval-subject');
    const subject = await materializeAwSkillEvalSubject({ plugin, plugins: [plugin],
      profile: { id: 'portable', platform: 'pi', scope: 'project', plugins: [{
        name: plugin.manifest.name, configByScope: { user: { mode: 'explicit-pi' } },
      }] }, requiredSkills: new Set(['static', 'dynamic']), initializeGitRepository: false,
      outputRoot, workRoot: path.join(root, 'eval-work'),
      sourceIdentity: `sha256:${'a'.repeat(64)}`, workspaceIdentity: 'fixture-workspace', env });
    const skillRoot = path.join(resolveMaterializedSubjectRoot(outputRoot, subject), '.agents', 'skills');
    expect(await fs.readFile(path.join(skillRoot, 'dynamic', 'SKILL.md'), 'utf8')).toContain('pi explicit-pi');
    expect(await fs.readFile(path.join(skillRoot, 'static', 'references', 'runtime.txt'), 'utf8')).toBe('Pi runtime\n');
  });

  it('keeps Review evidence on its concrete platform and rejects the old consumer profile', async () => {
    const { root, env } = await fixture();
    const out = path.join(root, 'review-cursor');
    const configFile = path.join(root, 'review-config.json');
    await fs.writeJson(configFile, { 'platform-fixture': { flavor: 'selected-cursor-flavor' } });
    const prepared = await prepareReviewTarget({ cwd: root, target: 'platform-fixture', platform: 'cursor',
      scope: 'project', out, env, configFile });
    expect(prepared.receipt.issues).toEqual([]);
    expect(prepared.exitCode).toBe(0);
    expect(await fs.readFile(path.join(out, 'skills', 'dynamic', 'SKILL.md'), 'utf8')).toContain('selected-cursor-flavor');
    const binding = await readAwSourceBinding(prepared.receipt.sourceBindingPath!);
    expect(binding.profile).toMatchObject({ platform: 'cursor', id: 'cursor-project' });
    const inspected = await inspectReviewTarget({ cwd: root, target: 'platform-fixture', platform: 'pi', scope: 'project',
      materializations: [prepared.receipt.sourceBindingPath!], env });
    expect(inspected.skills.every((skill) => skill.state === 'missing')).toBe(true);
    const invalid = await prepareReviewTarget({ cwd: root, target: 'platform-fixture', platform: 'agent-skills' as 'cursor',
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
