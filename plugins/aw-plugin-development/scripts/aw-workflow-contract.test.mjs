import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
const sourceRoot = context?.sourceRoot ?? localRoot;
const repositoryRoot = path.resolve(sourceRoot, '..', '..');
const runtimeRoot = context?.platform ? path.join(localRoot, context.platform) : localRoot;
const discover = context
  ? path.join(runtimeRoot, 'skills/review-aw-workflow/scripts/discover-aw-workflow.mjs')
  : path.join(localRoot, 'scripts/discover-aw-workflow.mjs');
const temps = [];
after(async () => Promise.all(temps.map((entry) => rm(entry, { recursive: true, force: true }))));

async function plugin(root, name, imports = [], exports = [`${name}-export`], options = {}) {
  await mkdir(path.join(root, '.agents-plugin'), { recursive: true });
  await mkdir(path.join(root, 'skills', `${name}-skill`), { recursive: true });
  await writeFile(path.join(root, 'skills', `${name}-skill`, 'SKILL.md'),
    `---\nname: ${name}-skill\ndescription: ${name} capability.\n---\n`);
  await writeFile(path.join(root, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name,
    version: '0.1.0',
    skills: './skills',
    dependencies: options.dependencies ?? [...new Set(imports
      .map((dependency) => typeof dependency === 'string' ? dependency : dependency.plugin)
      .filter((dependency) => dependency !== '@aw/cli'))],
    buildConfig: {
      buildImports: imports.map((dependency) => ({
        plugin: typeof dependency === 'string' ? dependency : dependency.plugin,
        export: typeof dependency === 'string' ? `${dependency}-export` : dependency.export,
        env: 'X',
      })),
      runtimeExports: exports.map((exportName) => ({ name: exportName, source: './x.json' })),
    },
    marketplace: { policy: { products: options.products ?? ['CODEX', 'CLAUDE'] } },
  }));
}

async function setSkillRuntimeFiles(root, entries) {
  const manifestPath = path.join(root, '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.buildConfig.skillRuntimeFiles = entries;
  await writeFile(manifestPath, JSON.stringify(manifest));
}

async function discoverJson(entry, roots) {
  const { stdout } = await execFileAsync(process.execPath, [
    discover,
    '--entry', entry,
    ...roots.flatMap((root) => ['--plugin', root]),
    '--format', 'json',
  ], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

async function addPortableSkill(root, directory, name = directory) {
  const skillRoot = path.join(root, 'portable-skills', directory);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} portable capability.\n---\n`);
  const manifestPath = path.join(root, '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.distributions = { agentSkills: { skills: './portable-skills' } };
  await writeFile(manifestPath, JSON.stringify(manifest));
}

test('AW workflow inventory exposes four typed edge collections and no untyped machine truth', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-'));
  temps.push(temp);
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  await plugin(a, 'a', ['b']);
  await plugin(b, 'b');
  const manifestPath = path.join(a, '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.buildConfig.skillRuntimeFiles = [{
    skill: 'a-skill',
    target: 'references/b.json',
    import: { plugin: 'b', export: 'b-export' },
  }];
  manifest.artifacts = { targets: [{
    id: 'portable-a',
    runtimeImports: [{ name: 'b-data', plugin: 'b', export: 'b-export' }],
  }] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const { stdout } = await execFileAsync(process.execPath, [
    discover, '--entry', 'a-skill', '--plugin', a, '--plugin', b, '--format', 'json',
  ], { encoding: 'utf8' });
  const result = JSON.parse(stdout);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.entryResolution.resolved, true);
  assert.deepEqual(result.plugins.map((entry) => entry.name), ['a', 'b']);
  assert.deepEqual(result.dependencyEdges.map(({ from, to }) => ({ from, to })), [{ from: 'a', to: 'b' }]);
  assert.deepEqual(result.buildImportEdges.map(({ from, to }) => ({ from, to })), [{ from: 'a', to: 'b' }]);
  assert.deepEqual(result.skillRuntimeFileImportEdges.map(({ from, to }) => ({ from, to })), [{ from: 'a', to: 'b' }]);
  assert.deepEqual(result.artifactRuntimeImportEdges.map(({ from, to }) => ({ from, to })), [{ from: 'a', to: 'b' }]);
  assert.equal('edges' in result, false);
  assert.equal('imports' in result.plugins[0], false);
  assert.ok(Object.values(result.unresolved).every((entries) => entries.length === 0));
  assert.ok(Object.values(result.cycles).every((entries) => entries.length === 0));
  assert.equal('design' in result, false);
  assert.equal('complexity' in result, false);
});

test('AW workflow inventory keeps manifest dependencies separate from typed imports', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-imports-'));
  temps.push(temp);
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  await plugin(a, 'a', [
    { plugin: 'b', export: 'missing' },
    { plugin: 'missing-plugin', export: 'x' },
    { plugin: 'b', export: 'b-export' },
  ], ['a-export'], { dependencies: ['missing-dependency'] });
  await plugin(b, 'b');
  const manifestPath = path.join(a, '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.buildConfig.skillRuntimeFiles = [
    { skill: 'a-skill', target: 'references/missing-provider.json', import: { plugin: 'missing-plugin', export: 'x' } },
    { skill: 'a-skill', target: 'references/missing-export.json', import: { plugin: 'b', export: 'missing' } },
    { skill: 'a-skill', target: 'references/valid.json', import: { plugin: 'b', export: 'b-export' } },
  ];
  manifest.artifacts = { targets: [{
    id: 'portable-a',
    runtimeImports: [
      { name: 'missing-provider', plugin: 'missing-plugin', export: 'x' },
      { name: 'missing-export', plugin: 'b', export: 'missing' },
      { name: 'valid', plugin: 'b', export: 'b-export' },
    ],
  }] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const { stdout } = await execFileAsync(process.execPath, [
    discover, '--entry', 'a', '--plugin', a, '--plugin', b, '--format', 'json',
  ], { encoding: 'utf8' });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.unresolved.dependencyEdges.map(({ to, reason }) => ({ to, reason })), [
    { to: 'missing-dependency', reason: 'missing-provider' },
  ]);
  for (const edgeType of ['buildImportEdges', 'skillRuntimeFileImportEdges', 'artifactRuntimeImportEdges']) {
    assert.deepEqual(
      result.unresolved[edgeType]
        .map(({ to, export: exportName, reason }) => ({ to, export: exportName, reason }))
        .sort((left, right) => left.reason.localeCompare(right.reason)),
      [
        { to: 'b', export: 'missing', reason: 'missing-export' },
        { to: 'missing-plugin', export: 'x', reason: 'missing-provider' },
      ],
    );
  }
});

test('AW workflow inventory rejects removed CLI capability exports', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-cli-import-'));
  temps.push(temp);
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  await plugin(a, 'a', [
    { plugin: '@aw/cli', export: 'skill-frontmatter-capabilities' },
    { plugin: '@aw/agent-skill-eval', export: 'case-corpus-digest' },
  ], ['a-export'], { dependencies: [] });
  await plugin(b, 'b');
  const manifestPath = path.join(a, '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.buildConfig.skillRuntimeFiles = [
    {
      skill: 'a-skill',
      target: 'scripts/corpus-digest.mjs',
      import: { plugin: '@aw/agent-skill-eval', export: 'case-corpus-digest' },
    },
    {
      skill: 'a-skill',
      target: 'references/capabilities.json',
      import: { plugin: '@aw/cli', export: 'skill-frontmatter-capabilities' },
    },
  ];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const { stdout } = await execFileAsync(process.execPath, [
    discover, '--entry', 'a', '--plugin', a, '--plugin', b, '--format', 'json',
  ], { encoding: 'utf8' });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.unresolved.buildImportEdges.map(({ to, reason }) => ({ to, reason })), [
    { to: '@aw/cli', reason: 'missing-provider' },
  ]);
  assert.deepEqual(result.unresolved.skillRuntimeFileImportEdges.map(({ to, reason }) => ({ to, reason })), [
    { to: '@aw/cli', reason: 'missing-provider' },
  ]);
});

test('AW workflow inventory resolves the real four-plugin author and review workflow', async () => {
  const pluginRoots = [
    'agent-content-toolkit',
    'agent-skill-toolkit',
    'aw-plugin-development',
    'aw-skill-eval-runner',
  ].map((name) => path.join(repositoryRoot, 'plugins', name));
  const { stdout } = await execFileAsync(process.execPath, [
    discover,
    '--entry', 'aw-plugin-development',
    ...pluginRoots.flatMap((root) => ['--plugin', root]),
    '--format', 'json',
  ], { encoding: 'utf8' });
  const result = JSON.parse(stdout);
  assert.equal(result.entryResolution.resolved, true);
  assert.deepEqual(result.plugins.map((entry) => entry.name), [
    'agent-content-toolkit',
    'agent-skill-toolkit',
    'aw-plugin-development',
    'aw-skill-eval-runner',
  ]);
  assert.ok(Object.values(result.unresolved).every((entries) => entries.length === 0));
  assert.ok(Object.values(result.cycles).every((entries) => entries.length === 0));
});

test('AW workflow inventory resolves a static portable-only Skill entry', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-portable-entry-'));
  temps.push(temp);
  const owner = path.join(temp, 'owner');
  const peer = path.join(temp, 'peer');
  await plugin(owner, 'owner');
  await plugin(peer, 'peer');
  await addPortableSkill(owner, 'portable-only');

  const result = await discoverJson('portable-only', [owner, peer]);
  assert.equal(result.entryResolution.resolved, true);
  assert.equal(result.entryResolution.ambiguous, false);
  assert.deepEqual(result.entryResolution.skills, [{
    name: 'portable-only',
    owners: ['owner'],
    candidates: [{
      plugin: 'owner',
      surface: 'agent-skills',
      declarations: [{ kind: 'static', path: 'portable-only/SKILL.md' }],
      materializations: [],
      profiles: [],
    }],
  }]);
});

test('AW workflow inventory resolves materialized Skills and merges declared portable profiles', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-dynamic-entry-'));
  temps.push(temp);
  const owner = path.join(temp, 'owner');
  const peer = path.join(temp, 'peer');
  const project = path.join(temp, 'project-skills');
  const user = path.join(temp, 'user-skills');
  await plugin(owner, 'owner');
  await plugin(peer, 'peer');
  const manifestPath = path.join(owner, '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.distributions = { agentSkills: {} };
  manifest.artifacts = { targets: [{
    id: 'dynamic-portable',
    distribution: 'agent-skills',
    target: 'agent-skills.skill',
    scopes: ['project', 'user'],
    states: ['present'],
    refreshKeys: [],
    skillKey: 'dynamic-portable',
  }] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  for (const root of [project, user]) {
    await mkdir(path.join(root, 'dynamic-portable'), { recursive: true });
    await writeFile(path.join(root, 'dynamic-portable', 'SKILL.md'),
      '---\nname: dynamic-portable\ndescription: Materialized portable capability.\n---\n');
  }
  await mkdir(path.join(project, 'materialized-only'), { recursive: true });
  await writeFile(path.join(project, 'materialized-only', 'SKILL.md'),
    '---\nname: materialized-only\ndescription: Materialized-only capability.\n---\n');

  const { stdout } = await execFileAsync(process.execPath, [
    discover, '--entry', 'dynamic-portable', '--plugin', owner, '--plugin', peer,
    '--materialized', `owner=user=${user}`,
    '--materialized', `owner=project=${project}`,
    '--format', 'json',
  ], { encoding: 'utf8' });
  const result = JSON.parse(stdout);
  assert.equal(result.entryResolution.resolved, true);
  assert.equal(result.entryResolution.ambiguous, false);
  const [candidate] = result.entryResolution.skills[0].candidates;
  assert.equal(candidate.surface, 'agent-skills');
  assert.deepEqual(candidate.declarations, [{
    kind: 'dynamic', targetId: 'dynamic-portable', source: 'artifacts.targets[0]',
  }]);
  assert.deepEqual(candidate.profiles, ['project', 'user']);
  assert.deepEqual(candidate.materializations.map(({ profile, path: skillPath }) => ({
    profile, path: skillPath,
  })), [
    { profile: 'project', path: 'dynamic-portable/SKILL.md' },
    { profile: 'user', path: 'dynamic-portable/SKILL.md' },
  ]);

  const { stdout: materializedStdout } = await execFileAsync(process.execPath, [
    discover, '--entry', 'materialized-only', '--plugin', owner, '--plugin', peer,
    '--materialized', `owner=project=${project}`, '--format', 'json',
  ], { encoding: 'utf8' });
  const materializedResult = JSON.parse(materializedStdout);
  assert.equal(materializedResult.entryResolution.resolved, true);
  assert.deepEqual(materializedResult.entryResolution.skills[0].candidates.map((entry) => ({
    plugin: entry.plugin, surface: entry.surface, profiles: entry.profiles,
  })), [{ plugin: 'owner', surface: 'materialized', profiles: ['project'] }]);
});

test('AW workflow inventory does not resolve cross-plugin or cross-surface Skill names', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-surface-ambiguity-'));
  temps.push(temp);
  const owner = path.join(temp, 'owner');
  const peer = path.join(temp, 'peer');
  await plugin(owner, 'owner');
  await plugin(peer, 'peer');
  await addPortableSkill(owner, 'owner-skill');
  await rm(path.join(peer, 'skills', 'peer-skill'), { recursive: true });
  await mkdir(path.join(peer, 'skills', 'owner-skill'));
  await writeFile(path.join(peer, 'skills', 'owner-skill', 'SKILL.md'),
    '---\nname: owner-skill\ndescription: Conflicting peer capability.\n---\n');

  let result;
  try {
    await execFileAsync(process.execPath, [
      discover, '--entry', 'owner-skill', '--plugin', owner, '--plugin', peer, '--format', 'json',
    ], { encoding: 'utf8' });
  } catch (error) {
    result = JSON.parse(error.stdout);
  }
  assert.equal(result.entryResolution.resolved, false);
  assert.equal(result.entryResolution.ambiguous, true);
  assert.deepEqual(
    result.entryResolution.skills[0].candidates.map(({ plugin: pluginName, surface }) => ({
      plugin: pluginName, surface,
    })),
    [
      { plugin: 'owner', surface: 'agent-skills' },
      { plugin: 'owner', surface: 'native' },
      { plugin: 'peer', surface: 'native' },
    ],
  );
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

  manifest.distributions = { agentSkills: { skills: '../outside' } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    execFileAsync(process.execPath, [discover, '--entry', 'safe', '--plugin', safe, '--plugin', peer, '--format', 'json']),
    (error) => !error.stdout.includes('outside-secret') && !error.stderr.includes('outside-secret'),
  );

  manifest.distributions.agentSkills.skills = './portable-link/nested';
  await symlink(outside, path.join(safe, 'portable-link'));
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    execFileAsync(process.execPath, [discover, '--entry', 'safe', '--plugin', safe, '--plugin', peer, '--format', 'json']),
    (error) => !error.stdout.includes('outside-secret') && !error.stderr.includes('outside-secret'),
  );
  delete manifest.distributions;
  await writeFile(manifestPath, JSON.stringify(manifest));

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

test('AW workflow inventory reports dependency and each import cycle independently', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-cycle-'));
  temps.push(temp);
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  await plugin(a, 'a', ['b']);
  await plugin(b, 'b', ['a']);
  for (const [root, ownName, peerName] of [[a, 'a', 'b'], [b, 'b', 'a']]) {
    const manifestPath = path.join(root, '.agents-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.buildConfig.skillRuntimeFiles = [{
      skill: `${ownName}-skill`,
      target: `references/${peerName}.json`,
      import: { plugin: peerName, export: `${peerName}-export` },
    }];
    manifest.artifacts = { targets: [{
      id: `portable-${ownName}`,
      runtimeImports: [{ name: peerName, plugin: peerName, export: `${peerName}-export` }],
    }] };
    await writeFile(manifestPath, JSON.stringify(manifest));
  }
  let output;
  try {
    await execFileAsync(process.execPath, [
      discover, '--entry', 'a', '--plugin', a, '--plugin', b, '--format', 'json',
    ], { encoding: 'utf8' });
  } catch (error) {
    output = JSON.parse(error.stdout);
  }
  for (const edgeType of ['dependencyEdges', 'buildImportEdges', 'skillRuntimeFileImportEdges', 'artifactRuntimeImportEdges']) {
    assert.deepEqual(output.cycles[edgeType], [['a', 'b', 'a']]);
  }
});

test('AW workflow inventory does not create a cycle by mixing import edge types', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-no-union-cycle-'));
  temps.push(temp);
  const a = path.join(temp, 'a');
  const b = path.join(temp, 'b');
  await plugin(a, 'a', ['b']);
  await plugin(b, 'b', [], ['b-export'], { dependencies: ['a'] });
  const manifestPath = path.join(b, '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.buildConfig.skillRuntimeFiles = [{
    skill: 'b-skill', target: 'references/a.json', import: { plugin: 'a', export: 'a-export' },
  }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  let output;
  try {
    await execFileAsync(process.execPath, [
      discover, '--entry', 'a', '--plugin', a, '--plugin', b, '--format', 'json',
    ], { encoding: 'utf8' });
  } catch (error) {
    output = JSON.parse(error.stdout);
  }
  assert.deepEqual(output.cycles.dependencyEdges, [['a', 'b', 'a']]);
  assert.deepEqual(output.cycles.buildImportEdges, []);
  assert.deepEqual(output.cycles.skillRuntimeFileImportEdges, []);
});

test('AW workflow inventory applies canonical default and normalized product coverage semantics', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-products-'));
  temps.push(temp);
  const both = path.join(temp, 'both');
  const codexConsumer = path.join(temp, 'codex-consumer');
  const codexProvider = path.join(temp, 'codex-provider');
  await plugin(both, 'both', [
    { plugin: 'codex-provider', export: 'provider-export' },
  ], ['both-export'], { dependencies: ['codex-provider'], products: [] });
  await plugin(codexConsumer, 'codex-consumer', [], ['consumer-export'], {
    dependencies: ['codex-provider'],
    products: [' codex '],
  });
  await plugin(codexProvider, 'codex-provider', [], ['provider-export'], { products: ['CODEX'] });
  const bothManifestPath = path.join(both, '.agents-plugin', 'plugin.json');
  const bothManifest = JSON.parse(await readFile(bothManifestPath, 'utf8'));
  bothManifest.buildConfig.skillRuntimeFiles = [
    {
      skill: 'both-skill',
      target: 'references/default.json',
      import: { plugin: 'codex-provider', export: 'provider-export' },
    },
    {
      skill: 'both-skill',
      target: 'references/codex.json',
      platforms: ['codex'],
      import: { plugin: 'codex-provider', export: 'provider-export' },
    },
  ];
  await writeFile(bothManifestPath, JSON.stringify(bothManifest));
  const { stdout } = await execFileAsync(process.execPath, [
    discover, '--entry', 'both', '--plugin', both, '--plugin', codexConsumer,
    '--plugin', codexProvider, '--format', 'json',
  ], { encoding: 'utf8' });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.unresolved.dependencyEdges.map(({ from, reason, missingPlatforms }) => ({
    from, reason, missingPlatforms,
  })), [{
    from: 'both', reason: 'incomplete-product-coverage', missingPlatforms: ['claude'],
  }]);
  assert.deepEqual(result.unresolved.buildImportEdges.map(({ from, reason, missingPlatforms }) => ({
    from, reason, missingPlatforms,
  })), [{
    from: 'both', reason: 'incomplete-product-coverage', missingPlatforms: ['claude'],
  }]);
  assert.deepEqual(result.unresolved.skillRuntimeFileImportEdges.map(({
    from, target, reason, missingPlatforms,
  }) => ({ from, target, reason, missingPlatforms })), [{
    from: 'both',
    target: 'references/default.json',
    reason: 'incomplete-product-coverage',
    missingPlatforms: ['claude'],
  }]);
});

test('AW workflow inventory treats distributions-only Skill runtime imports as portable-only', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-portable-runtime-'));
  temps.push(temp);
  const consumer = path.join(temp, 'consumer');
  const provider = path.join(temp, 'provider');
  await plugin(consumer, 'consumer', [], ['consumer-export'], {
    dependencies: [],
    products: ['CLAUDE', 'CODEX'],
  });
  await plugin(provider, 'provider', [], ['provider-export'], { products: ['CODEX'] });
  await setSkillRuntimeFiles(consumer, [{
    skill: 'consumer-skill',
    target: 'references/portable.json',
    distributions: ['agent-skills'],
    import: { plugin: 'provider', export: 'provider-export' },
  }]);

  const result = await discoverJson('consumer', [consumer, provider]);
  assert.deepEqual(result.skillRuntimeFileImportEdges.map((edge) => ({
    platforms: edge.platforms,
    distributions: edge.distributions,
  })), [{ platforms: null, distributions: ['agent-skills'] }]);
  assert.deepEqual(result.unresolved.skillRuntimeFileImportEdges, []);
  assert.deepEqual(result.unresolved.dependencyEdges, []);
  assert.deepEqual(result.unresolved.buildImportEdges, []);
  assert.deepEqual(result.unresolved.artifactRuntimeImportEdges, []);
});

test('AW workflow inventory checks explicit native-only Skill runtime platforms', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-native-runtime-'));
  temps.push(temp);
  const consumer = path.join(temp, 'consumer');
  const provider = path.join(temp, 'provider');
  await plugin(consumer, 'consumer', [], ['consumer-export'], {
    dependencies: [],
    products: ['CLAUDE', 'CODEX'],
  });
  await plugin(provider, 'provider', [], ['provider-export'], { products: ['CLAUDE'] });
  await setSkillRuntimeFiles(consumer, [{
    skill: 'consumer-skill',
    target: 'references/native.json',
    platforms: ['codex'],
    import: { plugin: 'provider', export: 'provider-export' },
  }]);

  const result = await discoverJson('consumer', [consumer, provider]);
  assert.deepEqual(result.skillRuntimeFileImportEdges.map((edge) => ({
    platforms: edge.platforms,
    distributions: edge.distributions,
  })), [{ platforms: ['codex'], distributions: null }]);
  assert.deepEqual(result.unresolved.skillRuntimeFileImportEdges.map((edge) => ({
    reason: edge.reason,
    missingPlatforms: edge.missingPlatforms,
  })), [{ reason: 'incomplete-product-coverage', missingPlatforms: ['codex'] }]);
});

test('AW workflow inventory checks native platforms when Skill runtime imports target both surfaces', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-both-runtime-'));
  temps.push(temp);
  const consumer = path.join(temp, 'consumer');
  const provider = path.join(temp, 'provider');
  await plugin(consumer, 'consumer', [], ['consumer-export'], {
    dependencies: [],
    products: ['CLAUDE', 'CODEX'],
  });
  await plugin(provider, 'provider', [], ['provider-export'], { products: ['CLAUDE'] });
  await setSkillRuntimeFiles(consumer, [{
    skill: 'consumer-skill',
    target: 'references/both.json',
    platforms: ['codex'],
    distributions: ['agent-skills'],
    import: { plugin: 'provider', export: 'provider-export' },
  }]);

  const result = await discoverJson('consumer', [consumer, provider]);
  assert.deepEqual(result.skillRuntimeFileImportEdges.map((edge) => ({
    platforms: edge.platforms,
    distributions: edge.distributions,
  })), [{ platforms: ['codex'], distributions: ['agent-skills'] }]);
  assert.deepEqual(result.unresolved.skillRuntimeFileImportEdges.map((edge) => ({
    reason: edge.reason,
    missingPlatforms: edge.missingPlatforms,
  })), [{ reason: 'incomplete-product-coverage', missingPlatforms: ['codex'] }]);
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

test('release-required workflow archive fixture delegates component digests to the capsule CLI', async () => {
  const fixtureDocument = JSON.parse(await readFile(
    path.join(sourceRoot, 'skills/review-aw-workflow/evals/behavior-cases.json'),
    'utf8',
  ));
  const fixture = fixtureDocument.evals.find((entry) =>
    entry.id === 'delta-archive-writes-aw-workflow-scope-and-supersedes');
  assert.ok(fixture);
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-workflow-release-fixture-'));
  temps.push(temp);
  for (const [relativePath, content] of Object.entries(fixture.workspace_files)) {
    const target = path.join(temp, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(path.join(temp, 'pnpm-workspace.yaml'), 'packages: []\n');
  const fakeAw = path.join(temp, 'fixtures/bin/aw');
  await chmod(fakeAw, 0o755);
  const cliEntry = path.join(repositoryRoot, 'packages/cli/dist/index.js');
  const env = {
    ...process.env,
    AW_PLUGIN_EVAL_CLI_NODE: process.execPath,
    AW_PLUGIN_EVAL_CLI_ENTRY: cliEntry,
  };
  const runFakeAw = (args) => execFileAsync(fakeAw, args, { cwd: temp, env });
  const runProductionDigest = async (componentPath) => JSON.parse((await execFileAsync(
    process.execPath,
    [cliEntry, 'review', 'digest', componentPath, '--json'],
    { cwd: temp, env },
  )).stdout);

  const expectedAuthor = await runProductionDigest('plugins/author-side');
  const expectedReviewer = await runProductionDigest('plugins/reviewer-side');
  const author = JSON.parse((await runFakeAw([
    'review', 'digest', 'plugins/author-side', '--json',
  ])).stdout);
  const reviewer = JSON.parse((await runFakeAw([
    'review', 'digest', 'plugins/reviewer-side', '--json',
  ])).stdout);
  assert.deepEqual(author, expectedAuthor);
  assert.deepEqual(reviewer, expectedReviewer);

  const scope = {
    schemaVersion: 1,
    kind: 'aw-workflow',
    id: 'author-review-flow',
    userOutcome: 'author-side produces one handoff and reviewer-side reviews it.',
    entry: 'plugins/author-side/skills/author/SKILL.md',
    components: [
      { kind: 'aw-plugin', id: 'author-side', path: author.path, digest: author.digest },
      { kind: 'aw-plugin', id: 'reviewer-side', path: reviewer.path, digest: reviewer.digest },
    ],
    representativePaths: ['author-side -> reviewer-side'],
    externalDependencies: [],
    excluded: ['real model execution and release check'],
  };
  const scopePath = path.join(temp, 'outputs/scope.json');
  const publishArgs = [
    'review', 'publish', '--kind', 'aw-workflow', '--target', 'author-review-flow',
    '--scope', 'outputs/scope.json', '--report', 'outputs/report.md',
    '--supersedes', '20260824T120000Z-cccccccc-dddddddd',
  ];

  await writeFile(scopePath, JSON.stringify(scope));
  await writeFile(path.join(temp, 'outputs/aw-command-log.txt'), '');
  await assert.rejects(
    runFakeAw(publishArgs),
    (error) => /missing required component digest before publication/u.test(
      `${error.stderr ?? ''}${error.message ?? ''}`,
    ),
  );
  await runFakeAw(['review', 'digest', 'plugins/author-side', '--json']);
  await runFakeAw(['review', 'digest', 'plugins/reviewer-side', '--json']);

  scope.components[0].digest = `sha256:${'0'.repeat(64)}`;
  await writeFile(scopePath, JSON.stringify(scope));
  await assert.rejects(
    runFakeAw(publishArgs),
    (error) => /scope components must use real review digest results/u.test(
      `${error.stderr ?? ''}${error.message ?? ''}`,
    ),
  );

  scope.components[0].digest = author.digest;
  await writeFile(scopePath, JSON.stringify(scope));
  const published = await runFakeAw(publishArgs);
  const recordPath = /: (reports\/reviews\/[^\n]+)/u.exec(published.stdout)?.[1];
  assert.ok(recordPath);
  assert.match((await runFakeAw(['review', 'verify', recordPath])).stdout, /verified/u);
  assert.match((await runFakeAw(['review', 'list'])).stdout, /author-review-flow/u);
  assert.match((await runFakeAw(['review', 'show', '20260825T130000Z-aaaaaaaa-bbbbbbbb'])).stdout, /Review:/u);
});
