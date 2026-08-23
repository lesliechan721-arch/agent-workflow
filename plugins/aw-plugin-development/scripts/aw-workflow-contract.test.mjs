import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const runtimeRoot = context?.platform ? path.join(localRoot, context.platform) : localRoot;
const discover = context
  ? path.join(runtimeRoot, 'skills/review-aw-workflow/scripts/discover-aw-workflow.mjs')
  : path.join(localRoot, 'scripts/discover-aw-workflow.mjs');
const temps = [];
after(async () => Promise.all(temps.map((entry) => rm(entry, { recursive: true, force: true }))));

async function plugin(root, name, imports = [], exports = [`${name}-export`]) {
  await mkdir(path.join(root, '.agents-plugin'), { recursive: true });
  await mkdir(path.join(root, 'skills', `${name}-skill`), { recursive: true });
  await writeFile(path.join(root, 'skills', `${name}-skill`, 'SKILL.md'),
    `---\nname: ${name}-skill\ndescription: ${name} capability.\n---\n`);
  await writeFile(path.join(root, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name,
    version: '0.1.0',
    skills: './skills',
    buildConfig: {
      buildImports: imports.map((dependency) => ({
        plugin: typeof dependency === 'string' ? dependency : dependency.plugin,
        export: typeof dependency === 'string' ? `${dependency}-export` : dependency.export,
        env: 'X',
      })),
      runtimeExports: exports.map((exportName) => ({ name: exportName, source: './x.json' })),
    },
    marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } },
  }));
}

test('AW workflow inventory exposes plugins, imports, products and no semantic verdict', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-'));
  temps.push(temp);
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  await plugin(a, 'a', ['b']);
  await plugin(b, 'b');
  const { stdout } = await execFileAsync(process.execPath, [
    discover, '--entry', 'a-skill', '--plugin', a, '--plugin', b, '--format', 'json',
  ], { encoding: 'utf8' });
  const result = JSON.parse(stdout);
  assert.equal(result.entryResolution.resolved, true);
  assert.deepEqual(result.plugins.map((entry) => entry.name), ['a', 'b']);
  assert.ok(result.edges.some((edge) => edge.from === 'a' && edge.to === 'b'));
  assert.deepEqual(result.unresolvedImports, []);
  assert.deepEqual(result.cycles, []);
  assert.equal('design' in result, false);
  assert.equal('complexity' in result, false);
});

test('AW workflow inventory distinguishes missing providers and exports and accepts the CLI virtual export', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-imports-'));
  temps.push(temp);
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  await plugin(a, 'a', [
    { plugin: 'b', export: 'missing' },
    { plugin: 'missing-plugin', export: 'x' },
    { plugin: '@aw/cli', export: 'skill-frontmatter-capabilities' },
    { plugin: '@aw/cli', export: 'unknown-export' },
  ]);
  await plugin(b, 'b');
  const manifestPath = path.join(a, '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.buildConfig.skillRuntimeFiles = [{
    skill: 'a-skill',
    target: 'references/capabilities.json',
    import: { plugin: '@aw/cli', export: 'skill-frontmatter-capabilities' },
  }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const { stdout } = await execFileAsync(process.execPath, [
    discover, '--entry', 'a', '--plugin', a, '--plugin', b, '--format', 'json',
  ], { encoding: 'utf8' });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.unresolvedImports.map(({ to, export: exportName, reason }) => ({ to, export: exportName, reason })), [
    { to: 'b', export: 'missing', reason: 'missing-export' },
    { to: 'missing-plugin', export: 'x', reason: 'missing-provider' },
    { to: '@aw/cli', export: 'unknown-export', reason: 'missing-export' },
    { to: '@aw/cli', export: 'skill-frontmatter-capabilities', reason: 'unsupported-virtual-import-kind' },
  ]);
});

test('AW workflow inventory rejects escaping and symlinked Skill roots without reading outside content', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-boundary-'));
  temps.push(temp);
  const safe = path.join(temp, 'safe');
  const peer = path.join(temp, 'peer');
  const outside = path.join(temp, 'outside');
  await plugin(safe, 'safe');
  await plugin(peer, 'peer');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'SKILL.md'), '---\nname: outside-secret\ndescription: must not be read\n---\n');

  const manifestPath = path.join(safe, '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.skills = '../outside';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    execFileAsync(process.execPath, [discover, '--entry', 'safe', '--plugin', safe, '--plugin', peer, '--format', 'json']),
    (error) => !error.stdout.includes('outside-secret') && !error.stderr.includes('outside-secret'),
  );

  manifest.skills = outside;
  await rm(path.join(safe, 'skills'), { recursive: true, force: true });
  await mkdir(path.join(safe, 'skills'), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    execFileAsync(process.execPath, [discover, '--entry', 'safe', '--plugin', safe, '--plugin', peer, '--format', 'json']),
    (error) => !error.stdout.includes('outside-secret') && !error.stderr.includes('outside-secret'),
  );

  manifest.skills = './skills';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rm(path.join(safe, 'skills'), { recursive: true, force: true });
  await symlink(outside, path.join(safe, 'skills'));
  await assert.rejects(
    execFileAsync(process.execPath, [discover, '--entry', 'safe', '--plugin', safe, '--plugin', peer, '--format', 'json']),
    (error) => !error.stdout.includes('outside-secret') && !error.stderr.includes('outside-secret'),
  );

  await rm(path.join(safe, 'skills'), { recursive: true, force: true });
  await mkdir(path.join(safe, 'skills', 'safe-skill'), { recursive: true });
  await writeFile(path.join(safe, 'skills', 'safe-skill', 'SKILL.md'),
    '---\nname: safe-skill\ndescription: Safe capability.\n---\n');

  const linkedRoot = path.join(temp, 'linked-safe');
  await symlink(safe, linkedRoot);
  await assert.rejects(
    execFileAsync(process.execPath, [discover, '--entry', 'safe', '--plugin', linkedRoot, '--plugin', peer, '--format', 'json']),
    /Plugin root must be a regular directory/u,
  );

  await assert.rejects(
    execFileAsync(process.execPath, [
      discover, '--entry', 'peer', '--plugin', safe, '--plugin', peer,
      '--materialized', `peer=project=${linkedRoot}`, '--format', 'json',
    ]),
    /Skill root must be a regular directory/u,
  );

  const outsideManifestDirectory = path.join(temp, 'outside-manifest');
  await mkdir(outsideManifestDirectory, { recursive: true });
  await writeFile(path.join(outsideManifestDirectory, 'plugin.json'), JSON.stringify({
    name: 'outside-plugin-secret',
    version: '0.1.0',
    skills: './skills',
  }));
  await rm(path.join(safe, '.agents-plugin'), { recursive: true, force: true });
  await symlink(outsideManifestDirectory, path.join(safe, '.agents-plugin'));
  await assert.rejects(
    execFileAsync(process.execPath, [discover, '--entry', 'safe', '--plugin', safe, '--plugin', peer, '--format', 'json']),
    (error) => !error.stdout.includes('outside-plugin-secret') && !error.stderr.includes('outside-plugin-secret'),
  );
});

test('AW workflow inventory detects cycles before semantic review', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-cycle-'));
  temps.push(temp);
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  await plugin(a, 'a', ['b']);
  await plugin(b, 'b', ['a']);
  let output;
  try {
    await execFileAsync(process.execPath, [
      discover, '--entry', 'a', '--plugin', a, '--plugin', b, '--format', 'json',
    ], { encoding: 'utf8' });
  } catch (error) {
    output = JSON.parse(error.stdout);
  }
  assert.ok(output.cycles.length > 0);
});

test('AW reviewers have non-overlapping boundaries', async () => {
  // Static contract exception: installed AW reviewer instructions must expose non-overlapping review units; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  const pluginReview = await readFile(
    path.join(runtimeRoot, 'skills', 'review-aw-plugin', 'SKILL.md'), 'utf8');
  const workflowReview = await readFile(
    path.join(runtimeRoot, 'skills', 'review-aw-workflow', 'SKILL.md'), 'utf8');
  assert.match(pluginReview, /只评审一个 `.agents-plugin\/plugin.json`/u);
  assert.match(pluginReview, /不评审跨多个 AW 插件/u);
  assert.match(workflowReview, /跨多个 AW 插件/u);
  assert.match(workflowReview, /## Scope Admission/u);
  assert.doesNotMatch(pluginReview, /target_level=plugin/u);
});
