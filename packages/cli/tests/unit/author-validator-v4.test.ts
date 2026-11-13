import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });
async function fixture(platform = 'generic') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-source-validator-v4-')));
  roots.push(root);
  const plugin = path.join(root, 'fixture');
  await fs.outputJson(path.join(plugin, '.agents-plugin', 'plugin.json'), {
    schemaVersion: 4, name: 'fixture', version: '1.0.0', description: 'A source validation fixture.', platforms: [platform],
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    artifacts: { configKeys: [] }, scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
  });
  await fs.outputFile(path.join(plugin, 'README.md'), '# Fixture\n');
  return { root, plugin };
}
async function validate(plugin: string) {
  const result = await execute(process.execPath, [path.resolve(import.meta.dirname, '../../authoring/scripts/validate-plugin.mjs'), plugin, '--json'],
    { maxBuffer: 1024 * 1024 }).catch((cause: { stdout: string; stderr: string }) => ({ stdout: cause.stdout, stderr: cause.stderr }));
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as { ok: boolean; errors: string[]; warnings: string[] };
}

// Each case starts the real author CLI (twice in the v3 rejection case).
// The full two-worker filesystem run needs 10–15s per case for cold imports
// and isolated profile preparation; keep this allowance local to these tools.
describe('Manifest v4 source validator', { timeout: 30_000 }, () => {
  it('validates the real full v3 collection with the production author context', async () => {
    const { plugin } = await fixture();
    await fs.outputFile(path.join(plugin, 'render.mjs'), `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (context.schemaVersion !== 1 || context.surface !== 'agent-plugin' || context.platformCapabilities.basis !== 'profile'
 || context.requestedArtifactIds !== undefined || !Array.isArray(context.allowedOutputKinds)) throw new Error('Invalid author context.');
console.log(JSON.stringify({version:3,components:context.allowedOutputKinds.includes('skill')?[{id:'computed',kind:'skill',name:'computed-name',content:{files:{
 'SKILL.md':{text:'---\\nname: computed-name\\ndescription: A computed validation Skill.\\n---\\nBody.\\n'},'README.md':{text:'# Computed\\n'}
}}}]:[],omitted:[],unmet:[]}));
`);
    expect(await validate(plugin)).toMatchObject({ ok: true, errors: [] });
    await fs.writeFile(path.join(plugin, 'render.mjs'), 'console.log(JSON.stringify({version:2,artifacts:[]}));\n');
    const invalid = await validate(plugin);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join('\n')).toMatch(/component|version|v3/iu);
  });

  it('keeps source legality separate from the fixed profile capability gaps', async () => {
    const { plugin } = await fixture('cursor');
    await fs.outputFile(path.join(plugin, 'render.mjs'), `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:context.allowedOutputKinds.includes('skill')?[{
 id:'expected',kind:'skill',name:'expected',requiredFeatures:[{feature:'component.kind.skill'}],reasonCode:'capability-unverified'
}]:[]}));
`);
    const result = await validate(plugin);
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.warnings.join('\n')).toContain('component unmet (cursor/user)');
  });

  it('uses an already installed declared renderer dependency without changing its source', async () => {
    const { plugin } = await fixture();
    const manifestPath = path.join(plugin, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.scripts.node = { packageRoot: './scripts' };
    manifest.scripts.artifacts.render.path = './scripts/render.mjs';
    await fs.writeJson(manifestPath, manifest);
    await fs.outputJson(path.join(plugin, 'scripts/package.json'), {
      type: 'module', dependencies: { 'source-render-contract': '1.0.0' },
    });
    await fs.outputFile(path.join(plugin, 'scripts/pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const installedPackage = path.join(plugin, 'scripts/node_modules/source-render-contract');
    await fs.outputJson(path.join(installedPackage, 'package.json'), {
      name: 'source-render-contract', version: '1.0.0', type: 'module', exports: './index.mjs',
    });
    const dependencySource = 'export default {version:3,components:[],omitted:[],unmet:[]};\n';
    await fs.outputFile(path.join(installedPackage, 'index.mjs'), dependencySource);
    await fs.outputFile(path.join(plugin, 'scripts/render.mjs'),
      "import plan from 'source-render-contract'; console.log(JSON.stringify(plan));\n");
    expect(await validate(plugin)).toMatchObject({ ok: true, errors: [] });
    expect(await fs.readFile(path.join(installedPackage, 'index.mjs'), 'utf8')).toBe(dependencySource);
  });

  it('preserves invocation metadata in source when its target profile cannot enforce it', async () => {
    const { plugin } = await fixture();
    const manifestPath = path.join(plugin, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    delete manifest.artifacts;
    delete manifest.scripts;
    manifest.skills = './skills';
    await fs.writeJson(manifestPath, manifest);
    await fs.outputFile(path.join(plugin, 'skills/manual/SKILL.md'),
      '---\nname: manual\ndescription: An explicitly invoked Skill.\ndisable-model-invocation: true\n---\nBody.\n');
    await fs.outputFile(path.join(plugin, 'skills/manual/README.md'), '# Manual\n');
    const result = await validate(plugin);
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.warnings.join('\n')).toContain('skill.invocation.model');
  });

  it('projects declared static MCP beside the selected platform Skill input', async () => {
    const { plugin } = await fixture();
    const manifestPath = path.join(plugin, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    delete manifest.artifacts;
    delete manifest.scripts;
    manifest.platforms = ['codex', 'claude'];
    manifest.skills = './skills';
    manifest.mcpServers = './.mcp.json';
    await fs.writeJson(manifestPath, manifest);
    await fs.outputJson(path.join(plugin, '.mcp.json'), { mcpServers: { local: { type: 'stdio', command: 'node' } } });
    await fs.outputFile(path.join(plugin, 'skills/notes/SKILL.md'),
      '---\nname: notes\ndescription: A static source fixture.\n---\nBody.\n');
    await fs.outputFile(path.join(plugin, 'skills/notes/README.md'), '# Notes\n');
    await fs.outputFile(path.join(plugin, 'skills/notes/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
    expect(await validate(plugin)).toMatchObject({ ok: true, errors: [] });
  });

  it('keeps an Eval-only source directory separate from static publication', async () => {
    const { plugin } = await fixture();
    const manifestPath = path.join(plugin, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    delete manifest.artifacts;
    delete manifest.scripts;
    manifest.skills = './skills';
    await fs.writeJson(manifestPath, manifest);
    await fs.outputFile(path.join(plugin, 'skills/computed-name/evals/input.txt'), 'Author input only.\n');
    expect(await validate(plugin)).toMatchObject({ ok: true, errors: [] });
  });

  it('accepts declared source generation without executing a build or reporting a verified final', async () => {
    const { root, plugin } = await fixture();
    const manifestPath = path.join(plugin, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    delete manifest.artifacts;
    manifest.skills = './skills';
    manifest.scripts = { node: { build: { runner: 'node', path: './build.mjs' } } };
    manifest.buildConfig = { generatedSkillRuntimeFiles: [{ skill: 'source-skill', target: 'scripts/generated.mjs' }] };
    await fs.writeJson(manifestPath, manifest);
    await fs.outputFile(path.join(plugin, 'skills/source-skill/SKILL.md'),
      '---\nname: source-skill\ndescription: A source generation fixture.\n---\nRun `node scripts/generated.mjs`.\n');
    await fs.outputFile(path.join(plugin, 'skills/source-skill/README.md'), '# Source Skill\n');
    const marker = path.join(root, 'build-ran');
    await fs.outputFile(path.join(plugin, 'build.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const result = await validate(plugin);
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.warnings.join('\n')).toContain('component profile unverified (generic/user)');
    expect(await fs.pathExists(marker)).toBe(false);
  });
});
