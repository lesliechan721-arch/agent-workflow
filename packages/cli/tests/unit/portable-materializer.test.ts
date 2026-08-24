import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { PluginManifestSource, PluginMeta } from '../../src/types.js';
import {
  materializePortableSkills,
  materializePortableSkillsFromCatalog,
} from '../../src/portable/materializer.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { getArtifactSourceBundleRelativePath } from '../../src/utils/artifact-sources.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { validateCatalogSnapshot } from '../../src/utils/catalog-snapshot.js';
import { calculateCatalogSourcesConfigDigest } from '../../src/utils/catalog-sources.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';

const roots: string[] = [];

async function tempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
}

function baseManifest(name: string): PluginManifestSource {
  return {
    name,
    version: '0.1.0',
    description: `${name} fixture`,
    compatibility: { aw: { minVersion: '0.1.0' } },
    marketplace: {
      category: 'test',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    distributions: { agentSkills: { skills: './agent-skills/skills' } },
  };
}

async function writeSkill(root: string, name: string, body = 'Body.'): Promise<void> {
  await fs.outputFile(
    path.join(root, 'agent-skills', 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`,
  );
  await fs.outputFile(
    path.join(root, 'agent-skills', 'skills', name, 'README.md'),
    `# ${name}\n`,
  );
}

async function pluginFixture(
  parent: string,
  manifest: PluginManifestSource,
): Promise<PluginMeta> {
  const rootDir = path.join(parent, manifest.name);
  const manifestPath = path.join(rootDir, '.agents-plugin', 'plugin.json');
  await fs.outputJson(manifestPath, manifest);
  return {
    sourceId: 'fixture',
    sourceIdentity: 'fixture-generation',
    pluginId: `fixture/${manifest.name}`,
    rootDir,
    manifestPath,
    manifest,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('portable materializer', () => {
  it('keeps selector materialization valid after the Catalog generation lease ends', async () => {
    const root = await tempRoot('aw-portable-catalog-wrapper-');
    const snapshotRoot = path.join(root, 'snapshot');
    await createCatalogSnapshotFixture(snapshotRoot, 'portable', '0.1.0', 'portable\n', (manifest) => {
      manifest.extensions = { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] };
      manifest.distributions = { agentSkills: { skills: './agent-skills/skills' } };
    });
    await writeSkill(path.join(snapshotRoot, 'plugins', 'portable'), 'catalog-skill');
    const plugin = await readPluginManifest(path.join(snapshotRoot, 'plugins', 'portable'), { mode: 'bundle' });
    const { createCatalogManifestV4, createCatalogManifestV4Entry } = await import('../../src/utils/catalog-manifest-v4.js');
    await fs.writeJson(path.join(snapshotRoot, 'catalog-manifest.json'), createCatalogManifestV4({
      catalogVersion: '1.0.0', channel: 'latest', compatibility: { aw: { minVersion: '0.1.0' } },
      release: { state: 'development' },
      entries: [await createCatalogManifestV4Entry(plugin, plugin.rootDir)],
    }));
    const validation = await validateCatalogSnapshot(snapshotRoot);
    const config = {
      schemaVersion: 1 as const,
      sources: [{ id: 'fixture', type: 'path' as const, path: snapshotRoot, primary: true }],
    };
    const materialized = await materializePortableSkillsFromCatalog({
      selector: 'portable', scope: 'user', cwd: root, cliVersion: '1.0.0',
      configSnapshot: { config, digest: calculateCatalogSourcesConfigDigest(config), materialized: true },
      providers: {
        git: async () => { throw new Error('unused'); },
        path: async () => ({
          sourceId: 'fixture', sourceIdentity: 'fixture-generation', requestedRef: 'path',
          resolvedCommit: `path:${validation.snapshotDigest}`, rootDir: snapshotRoot,
          manifest: validation.manifest, manifestDigest: validation.manifestDigest,
          snapshotDigest: validation.snapshotDigest, cacheEntryKey: 'fixture', source: 'path',
          cacheFallback: false,
        }),
      },
    });

    await expect(fs.readFile(path.join(materialized.rootDir, 'skills', 'catalog-skill', 'SKILL.md'), 'utf8'))
      .resolves.toContain('catalog-skill');
    expect(JSON.stringify({
      pluginId: materialized.pluginId,
      candidates: materialized.candidates,
      dependencyPluginIds: materialized.dependencyPluginIds,
      digest: materialized.digest,
    })).not.toContain(snapshotRoot);
    expect(JSON.stringify(materialized.candidates)).not.toContain('aw-catalog-generation-');
    await materialized.cleanup();
  });

  it('materializes static and dependency candidates with direct and transitive provenance', async () => {
    const root = await tempRoot('aw-portable-static-');
    const transitive = await pluginFixture(root, baseManifest('transitive'));
    const directManifest = { ...baseManifest('direct'), dependencies: ['transitive'] };
    const direct = await pluginFixture(root, directManifest);
    const requestedManifest = { ...baseManifest('requested'), dependencies: ['direct'] };
    const requested = await pluginFixture(root, requestedManifest);
    await writeSkill(transitive.rootDir, 'transitive-skill');
    await writeSkill(direct.rootDir, 'direct-skill');
    await writeSkill(requested.rootDir, 'requested-skill');

    const materialized = await materializePortableSkills({
      plugins: [requested, transitive, direct],
      pluginId: 'fixture/requested',
      scope: 'project',
      cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home') },
    });

    expect(materialized.candidates.map(({ name, relation, dynamic }) => ({ name, relation, dynamic })))
      .toEqual([
        { name: 'direct-skill', relation: 'direct', dynamic: false },
        { name: 'requested-skill', relation: 'requested', dynamic: false },
        { name: 'transitive-skill', relation: 'transitive', dynamic: false },
      ]);
    expect(await fs.readJson(materialized.provenancePath)).toMatchObject({
      schemaVersion: 1,
      dependencyPluginIds: ['fixture/transitive', 'fixture/direct'],
    });
    await materialized.cleanup();
    expect(await fs.pathExists(materialized.rootDir)).toBe(false);
  });

  it('reads candidate descriptions from CRLF and EOF-closing portable frontmatter', async () => {
    const root = await tempRoot('aw-portable-frontmatter-');
    const plugin = await pluginFixture(root, baseManifest('frontmatter'));
    await fs.outputFile(
      path.join(plugin.rootDir, 'agent-skills', 'skills', 'crlf-skill', 'SKILL.md'),
      '---\r\nname: crlf-skill\r\ndescription: CRLF description.\r\n---\r\nBody.\r\n',
    );
    await fs.outputFile(
      path.join(plugin.rootDir, 'agent-skills', 'skills', 'crlf-skill', 'README.md'),
      '# CRLF\n',
    );
    await fs.outputFile(
      path.join(plugin.rootDir, 'agent-skills', 'skills', 'eof-skill', 'SKILL.md'),
      '---\nname: eof-skill\ndescription: EOF description.\n---',
    );
    await fs.outputFile(
      path.join(plugin.rootDir, 'agent-skills', 'skills', 'eof-skill', 'README.md'),
      '# EOF\n',
    );

    const materialized = await materializePortableSkills({
      plugins: [plugin], pluginId: plugin.pluginId!, scope: 'project', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home') },
    });
    expect(materialized.candidates.map(({ name, description }) => ({ name, description })))
      .toEqual([
        { name: 'crlf-skill', description: 'CRLF description.' },
        { name: 'eof-skill', description: 'EOF description.' },
      ]);
    await materialized.cleanup();
  });

  it('merges dynamic sources, static runtime files, and renderer overlay while omitting disabled targets', async () => {
    const root = await tempRoot('aw-portable-dynamic-');
    const manifest: PluginManifestSource = {
      ...baseManifest('dynamic'),
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: {
        targets: [
          {
            id: 'enabled',
            distribution: 'agent-skills',
            target: 'agent-skills.skill',
            kind: 'skill',
            scopes: ['project'],
            states: ['present'],
            refreshKeys: [],
            skillKey: 'owned',
            sourceDirs: ['./source/owned'],
          },
          {
            id: 'disabled',
            distribution: 'agent-skills',
            target: 'agent-skills.skill',
            kind: 'skill',
            scopes: ['project'],
            states: ['disabled'],
            refreshKeys: [],
            skillKey: 'disabled',
          },
        ],
      },
    };
    const plugin = await pluginFixture(root, manifest);
    await writeSkill(plugin.rootDir, 'owned', 'Static runtime input.');
    await fs.outputFile(path.join(
      plugin.rootDir,
      getArtifactSourceBundleRelativePath({ distribution: 'agent-skills', artifactId: 'enabled', index: 0 }),
      'references',
      'source.txt',
    ), 'source');
    await fs.outputFile(path.join(
      plugin.rootDir,
      getArtifactSourceBundleRelativePath({ distribution: 'agent-skills', artifactId: 'enabled', index: 0 }),
      'README.md',
    ), '# Owned\n');
    await fs.outputFile(
      path.join(plugin.rootDir, 'scripts', 'render.mjs'),
      `console.log(JSON.stringify({version:2,artifacts:[
        {id:'enabled',distribution:'agent-skills',target:'agent-skills.skill',kind:'skill',state:'present',skillKey:'owned',refreshKeys:[],content:{files:{'SKILL.md':'---\\nname: owned\\ndescription: rendered\\n---\\nRendered.\\n','references/source.txt':'overlay'}}},
        {id:'disabled',distribution:'agent-skills',target:'agent-skills.skill',kind:'skill',state:'disabled',skillKey:'disabled',refreshKeys:[]}
      ]}))`,
    );

    const materialized = await materializePortableSkills({
      plugins: [plugin],
      pluginId: plugin.pluginId!,
      scope: 'project',
      cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home') },
    });
    expect(materialized.candidates).toMatchObject([
      { name: 'owned', description: 'rendered', dynamic: true },
    ]);
    expect(await fs.readFile(path.join(materialized.rootDir, 'skills', 'owned', 'references', 'source.txt'), 'utf8'))
      .toBe('overlay');
    expect(await fs.pathExists(path.join(materialized.rootDir, 'skills', 'disabled'))).toBe(false);
    await materialized.cleanup();

    await fs.outputFile(
      path.join(plugin.rootDir, 'scripts', 'render.mjs'),
      `console.log(JSON.stringify({version:2,artifacts:[
        {id:'enabled',distribution:'agent-skills',target:'agent-skills.skill',kind:'skill',state:'present',skillKey:'owned',refreshKeys:[],content:{files:{'evals/private.md':'author-only'}}},
        {id:'disabled',distribution:'agent-skills',target:'agent-skills.skill',kind:'skill',state:'disabled',skillKey:'disabled',refreshKeys:[]}
      ]}))`,
    );
    await expect(materializePortableSkills({
      plugins: [plugin],
      pluginId: plugin.pluginId!,
      scope: 'project',
      cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-author-only') },
    })).rejects.toThrow('renderer returned author-only path "evals/private.md"');
  });

  it('rejects name collisions, sensitive config leaks, and invalid portable SKILL.md', async () => {
    const root = await tempRoot('aw-portable-invalid-');
    const left = await pluginFixture(root, baseManifest('left'));
    const right = await pluginFixture(root, { ...baseManifest('right'), dependencies: ['left'] });
    await writeSkill(left.rootDir, 'duplicate');
    await writeSkill(right.rootDir, 'duplicate');
    await expect(materializePortableSkills({
      plugins: [left, right], pluginId: right.pluginId!, scope: 'user', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-a') },
    })).rejects.toThrow('name collision');

    const secretManifest: PluginManifestSource = {
      ...baseManifest('secret'),
      config: { schema: { token: { type: 'string', sensitive: true, default: 'plain-secret' } } },
    };
    const secret = await pluginFixture(root, secretManifest);
    await writeSkill(secret.rootDir, 'leak', 'plain-secret');
    await expect(materializePortableSkills({
      plugins: [secret], pluginId: secret.pluginId!, scope: 'user', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-b') },
    })).rejects.toThrow('sensitive config');

    const invalid = await pluginFixture(root, baseManifest('invalid'));
    await fs.outputFile(path.join(invalid.rootDir, 'agent-skills', 'skills', 'bad', 'SKILL.md'), 'no frontmatter');
    await expect(materializePortableSkills({
      plugins: [invalid], pluginId: invalid.pluginId!, scope: 'user', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-c') },
    })).rejects.toThrow('frontmatter');

    const uppercase = await pluginFixture(root, baseManifest('uppercase'));
    await fs.outputFile(
      path.join(uppercase.rootDir, 'agent-skills', 'skills', 'Foo', 'SKILL.md'),
      '---\nname: Foo\ndescription: Must not bypass an installed lowercase foo.\n---\n',
    );
    await fs.outputFile(path.join(uppercase.rootDir, 'agent-skills', 'skills', 'Foo', 'README.md'), '# Foo\n');
    await expect(materializePortableSkills({
      plugins: [uppercase], pluginId: uppercase.pluginId!, scope: 'user', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-uppercase') },
    })).rejects.toThrow('ASCII lowercase hyphen-case');
  });

  it('uses only exact portable runtime projections for a dynamic owner', async () => {
    const root = await tempRoot('aw-portable-exact-projection-');
    const providerManifest: PluginManifestSource = {
      ...baseManifest('provider'),
      distributions: undefined,
      skills: './skills',
      buildConfig: { runtimeExports: [{ name: 'runtime', source: './runtime.txt' }] },
    };
    const provider = await pluginFixture(root, providerManifest);
    await fs.outputFile(path.join(provider.rootDir, 'skills', 'native', 'SKILL.md'), '---\nname: native\ndescription: native\n---\n');
    await fs.outputFile(path.join(provider.rootDir, 'runtime.txt'), 'projected');
    const consumerManifest: PluginManifestSource = {
      ...baseManifest('consumer'),
      skills: './skills',
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: [{
        id: 'owned', distribution: 'agent-skills', target: 'agent-skills.skill', kind: 'skill',
        scopes: ['project'], states: ['present'], refreshKeys: [], skillKey: 'owned',
        sourceDirs: ['./dynamic-source'],
        runtimeImports: [{ name: 'runtime', plugin: 'provider', export: 'runtime' }],
      }] },
      buildConfig: { skillRuntimeFiles: [{
        skill: 'owned', target: 'references/runtime.txt', distributions: ['agent-skills'],
        import: { plugin: 'provider', export: 'runtime' },
      }] },
    };
    const consumer = await pluginFixture(root, consumerManifest);
    await fs.outputFile(path.join(consumer.rootDir, 'skills', 'native', 'SKILL.md'), '---\nname: native\ndescription: native\n---\n');
    await writeSkill(consumer.rootDir, 'owned', 'Static file must not own the dynamic candidate.');
    await fs.outputFile(path.join(consumer.rootDir, 'agent-skills', 'skills', 'owned', 'undeclared.txt'), 'must-not-copy');
    await fs.outputFile(path.join(consumer.rootDir, 'dynamic-source', 'SKILL.md'), '---\nname: owned\ndescription: dynamic source\n---\nSource.\n');
    await fs.outputFile(path.join(consumer.rootDir, 'dynamic-source', 'README.md'), '# Owned\n');
    await fs.outputFile(path.join(consumer.rootDir, 'scripts', 'render.mjs'), `import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (process.env.AW_PLUGIN_PLATFORM !== undefined || process.env.AW_PLUGIN_DISTRIBUTION !== 'agent-skills') process.exit(2);
if (context.runtimeImports[0]?.artifactId !== 'owned' || context.runtimeImports[0]?.providerPluginId !== 'provider') process.exit(3);
console.log(JSON.stringify({version:2,artifacts:[{id:'owned',distribution:'agent-skills',target:'agent-skills.skill',kind:'skill',state:'present',skillKey:'owned',refreshKeys:[],content:{files:{}}}]}));`);
    const bundleRoot = path.join(root, 'bundle');
    await bundleLocalPlugin(consumer, bundleRoot, {
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    });
    const bundled = await readPluginManifest(bundleRoot, { mode: 'bundle' });
    bundled.sourceId = 'fixture';
    bundled.sourceIdentity = 'generation';
    bundled.pluginId = 'fixture/consumer';
    const materialized = await materializePortableSkills({
      plugins: [bundled], pluginId: bundled.pluginId, scope: 'project', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home') },
    });
    expect(await fs.readFile(path.join(materialized.rootDir, 'skills', 'owned', 'references', 'runtime.txt'), 'utf8'))
      .toBe('projected');
    expect(await fs.pathExists(path.join(materialized.rootDir, 'skills', 'owned', 'undeclared.txt'))).toBe(false);
    await materialized.cleanup();

    await fs.remove(path.join(bundleRoot, '.agents-plugin', 'artifact-sources', 'agent-skills', 'owned', '0', 'SKILL.md'));
    await expect(materializePortableSkills({
      plugins: [bundled], pluginId: bundled.pluginId, scope: 'project', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-failure') },
    })).rejects.toThrow('缺少 SKILL.md');
  });

  it('excludes all dynamic keys from the static root while rendering only the selected scope', async () => {
    const root = await tempRoot('aw-portable-cross-scope-');
    const manifest: PluginManifestSource = {
      ...baseManifest('cross-scope'),
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: (['project', 'user'] as const).map((scope) => ({
        id: `${scope}-only`, distribution: 'agent-skills' as const,
        target: 'agent-skills.skill' as const, kind: 'skill' as const,
        scopes: [scope], states: ['present' as const], refreshKeys: [], skillKey: `${scope}-only`,
        sourceDirs: [`./agent-skills/skills/${scope}-only`],
      })) },
    };
    const plugin = await pluginFixture(root, manifest);
    await writeSkill(plugin.rootDir, 'project-only');
    await writeSkill(plugin.rootDir, 'user-only');
    for (const scope of ['project', 'user'] as const) {
      await fs.copy(
        path.join(plugin.rootDir, 'agent-skills', 'skills', `${scope}-only`),
        path.join(plugin.rootDir, getArtifactSourceBundleRelativePath({
          distribution: 'agent-skills', artifactId: `${scope}-only`, index: 0,
        })),
      );
    }
    await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'render.mjs'), [
      "import fs from 'node:fs';",
      "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      "fs.appendFileSync(new URL('../render.log', import.meta.url), context.scope + '\\n');",
      "const key = context.scope + '-only';",
      "console.log(JSON.stringify({version:2,artifacts:[{id:key,distribution:'agent-skills',target:'agent-skills.skill',kind:'skill',state:'present',skillKey:key,refreshKeys:[],content:{files:{}}}]}));",
    ].join('\n'));
    const renderLog = path.join(plugin.rootDir, 'render.log');

    const project = await materializePortableSkills({
      plugins: [plugin], pluginId: plugin.pluginId!, scope: 'project', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-project') },
    });
    expect(project.candidates.map((candidate) => candidate.name)).toEqual(['project-only']);
    await project.cleanup();
    const user = await materializePortableSkills({
      plugins: [plugin], pluginId: plugin.pluginId!, scope: 'user', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-user') },
    });
    expect(user.candidates.map((candidate) => candidate.name)).toEqual(['user-only']);
    expect(await fs.readFile(renderLog, 'utf8')).toBe('project\nuser\n');
    await user.cleanup();
  });
});
