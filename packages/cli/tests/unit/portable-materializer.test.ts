import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginManifestSource, PluginMeta } from '../../src/types.js';
import {
  materializePortableSkills,
  materializePortableSkillsFromCatalog,
} from '../../src/portable/materializer.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import * as processTree from '../../src/utils/process-tree.js';
import * as pluginScripts from '../../src/utils/plugin-scripts.js';

const roots: string[] = [];

async function tempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
}

function baseManifest(name: string): PluginManifestSource {
  return {
    schemaVersion: 4,
    name,
    version: '0.1.0',
    description: `${name} fixture`,
    marketplace: {
      category: 'test',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    platforms: ['generic'], skills: './skills',
  };
}

async function writeSkill(root: string, name: string, body = 'Body.'): Promise<void> {
  await fs.outputFile(
    path.join(root, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`,
  );
  await fs.outputFile(
    path.join(root, 'skills', name, 'README.md'),
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
  if (manifest.skills) await fs.ensureDir(path.join(rootDir, 'skills'));
  return {
    sourceId: 'fixture',
    sourceIdentity: `sha256:${'1'.repeat(64)}`,
    pluginId: `fixture/${manifest.name}`,
    rootDir,
    manifestPath,
    manifest,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('portable materializer', () => {
  it.skipIf(process.platform === 'win32').each(['static', 'missing-dependency', 'ready-dependency'] as const)(
    'prepares the installed Windows helper before renderer startup (%s)',
    async (kind) => {
      const root = await tempRoot('aw-portable-native-admission-');
      const manifest = baseManifest('native-admission');
      const marker = path.join(root, 'renderer-started');
      if (kind !== 'static') {
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
        manifest.skills = undefined;
        manifest.artifacts = { configKeys: [], scopes: ['user'] };
      }
      const plugin = await pluginFixture(root, manifest);
      if (kind === 'static') await writeSkill(plugin.rootDir, 'portable');
      if (kind !== 'static') {
        await fs.outputFile(path.join(plugin.rootDir, 'render.mjs'), `
          import fs from 'node:fs';
          fs.writeFileSync(${JSON.stringify(marker)}, 'started');
          console.log(JSON.stringify({ version: 3, components: [{
            id: 'portable', kind: 'skill', name: 'portable',
            content: { files: {
              'SKILL.md': { text: '---\\nname: portable\\ndescription: Portable fixture.\\n---\\nBody.\\n' },
              'README.md': { text: '# Portable\\n' },
            } },
          }], omitted: [], unmet: [] }));
        `);
      }
      const env = { ...process.env, AW_HOME: path.join(root, 'aw-home') };
      // Simulate only Windows admission after the real host paths are resolved.
      const prepareDirectories = pluginScripts.preparePluginScriptDirectories;
      let platform: ReturnType<typeof vi.spyOn> | undefined;
      vi.spyOn(pluginScripts, 'preparePluginScriptDirectories').mockImplementation(async (directory) => {
        await prepareDirectories(directory);
        platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      });
      const prepare = vi.spyOn(processTree, 'prepareWindowsJobHelper').mockImplementation(async () => {
        platform?.mockRestore();
        if (kind === 'missing-dependency') throw Object.assign(new Error('Reinstall the current CLI/Eval package and include optional dependencies.'), { code: 'nativePackageUnavailable' });
        return process.execPath;
      });
      const result = materializePortableSkills({
      platform: 'generic',
        plugins: [plugin], pluginId: plugin.pluginId!, scope: 'user', cwd: root, env,
      });
      if (kind === 'missing-dependency') {
        const failure = await result.catch((error: unknown) => error) as Error & { code: string };
        expect(failure.code).toBe('nativePackageUnavailable');
        expect(failure.message).toContain('optional dependencies');
      } else {
        const materialized = await result;
        expect(materialized.candidates.map((candidate) => candidate.name)).toEqual(['portable']);
        await materialized.cleanup();
      }
      platform?.mockRestore();
      expect(prepare).toHaveBeenCalledTimes(kind === 'static' ? 0 : 1);
      await expect(fs.pathExists(marker)).resolves.toBe(kind === 'ready-dependency');
      await expect(fs.pathExists(path.join(env.AW_HOME, 'native-artifacts'))).resolves.toBe(false);
    },
  );

  it.each(['static', 'dynamic'] as const)(
    'rejects local managed command references in %s Portable content before publishing output',
    async (kind) => {
      const root = await tempRoot('aw-portable-managed-command-');
      const manifest = baseManifest('local-command');
      manifest.requires = { aw: { capabilities: ['aw.managed-commands.v1'] } };
      if (kind === 'dynamic') {
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
        manifest.skills = undefined;
        manifest.artifacts = { configKeys: [], scopes: ['user'] };
      }
      const plugin = await pluginFixture(root, manifest);
      if (kind === 'static') {
        await writeSkill(plugin.rootDir, 'portable', 'Use {{aw.command:tools/run}}.');
      } else {
        await fs.ensureDir(path.join(plugin.rootDir, 'scripts'));
        await fs.outputFile(path.join(plugin.rootDir, 'render.mjs'), `
          console.log(JSON.stringify({ version: 3, components: [{
            id: 'portable', kind: 'skill', name: 'portable',
            content: { files: {
              'SKILL.md': { text: '---\\nname: portable\\ndescription: Portable fixture.\\n---\\nBody.\\n' },
              'README.md': { text: '# Portable\\n' },
              'references/command.md': { text: 'Use {{aw.command:tools/run}}.' },
            } },
          }], omitted: [], unmet: [] }));
        `);
      }
      const outputRoot = path.join(root, 'output');
      const env = { ...process.env, AW_HOME: path.join(root, 'home') };
      await expect(materializePortableSkills({
      platform: 'generic',
        plugins: [plugin], pluginId: plugin.pluginId!, scope: 'user', cwd: root,
        env, outputRoot,
      })).rejects.toThrow(/commandReferenceInvalid.*Generic Skills cannot bind native managed commands/u);
      await expect(fs.pathExists(outputRoot)).resolves.toBe(false);
      await expect(fs.pathExists(path.join(env.AW_HOME, 'commands'))).resolves.toBe(false);
    },
  );

  it('keeps selector materialization valid after the Catalog generation lease ends', async () => {
    const root = await tempRoot('aw-portable-catalog-wrapper-');
    const snapshotRoot = path.join(root, 'snapshot');
    await createCatalogSnapshotFixture(snapshotRoot, 'portable', [], 'portable\n', (manifest) => {
      manifest.extensions = { instructions: [{ name: 'native', title: 'Native', content: 'Native.', coverage: ['main'] }] };
      manifest.platforms = ['generic']; manifest.skills = './skills';
    });
    await writeSkill(path.join(snapshotRoot, 'plugins', 'portable', 'generic'), 'catalog-skill');
    const plugin = await readPluginManifest(path.join(snapshotRoot, 'plugins', 'portable'), { mode: 'bundle' });
    await fs.writeJson(
      path.join(plugin.rootDir, 'generic', 'skills', 'catalog-skill', 'aw-plugin-requirements.json'),
      createAwPluginRequirementsReceipt(
        { name: plugin.manifest.name, version: plugin.manifest.version },
        plugin.manifest.requires?.aw.capabilities ?? [],
      ),
    );
    const { createCatalogManifestV7, createCatalogManifestV7Entry } = await import('../../src/utils/catalog-manifest-v7.js');
    await fs.writeJson(path.join(snapshotRoot, 'catalog-manifest.json'), createCatalogManifestV7({
      catalogVersion: '1.0.0', channel: 'latest',
      requires: { aw: { capabilities: ['aw.catalog-snapshot.v7'] } },
      marketplace: {
        owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
        interface: { displayName: 'Fixture Marketplace' },
      },
      release: { state: 'development' },
      entries: [await createCatalogManifestV7Entry(plugin, plugin.rootDir)],
    }));
    const env = { ...process.env, AW_HOME: path.join(root, 'home') };
    const config = {
      schemaVersion: 2 as const,
      sources: [{ id: 'fixture', type: 'path' as const, path: snapshotRoot, primary: true }],
    };
    const configSnapshot = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({
      config,
      expectedDigest: configSnapshot.digest,
      env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'fixture', cliVersion: '1.0.0', env,
    });
    const materialized = await materializePortableSkillsFromCatalog({
      platform: 'generic',
      selector: 'portable', scope: 'user', cwd: root, cliVersion: '1.0.0',
      configSnapshot: await readCatalogSourcesConfigSnapshot(env),
      env,
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
      platform: 'generic',
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
    for (const candidate of materialized.candidates) {
      await expect(fs.readJson(path.join(
        materialized.rootDir,
        'skills',
        candidate.name,
        'aw-plugin-requirements.json',
      ))).resolves.toMatchObject({
        schemaVersion: 1,
        kind: 'aw-plugin-requirements',
        plugin: { version: '0.1.0' },
        requiredCapabilities: ['aw.plugin-manifest.v4', 'aw.plugin-skills.v1', 'aw.portable-skills.v1'],
        digest: expect.stringMatching(/^sha256:/u),
      });
    }
    await materialized.cleanup();
    expect(await fs.pathExists(materialized.rootDir)).toBe(false);
  });

  it('reads candidate descriptions from CRLF and EOF-closing portable frontmatter', async () => {
    const root = await tempRoot('aw-portable-frontmatter-');
    const plugin = await pluginFixture(root, baseManifest('frontmatter'));
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'crlf-skill', 'SKILL.md'),
      '---\r\nname: crlf-skill\r\ndescription: CRLF description.\r\n---\r\nBody.\r\n',
    );
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'crlf-skill', 'README.md'),
      '# CRLF\n',
    );
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'eof-skill', 'SKILL.md'),
      '---\nname: eof-skill\ndescription: EOF description.\n---',
    );
    await fs.outputFile(
      path.join(plugin.rootDir, 'skills', 'eof-skill', 'README.md'),
      '# EOF\n',
    );

    const materialized = await materializePortableSkills({
      platform: 'generic',
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

  it('projects safe short metadata and bounded description fallbacks for selection rows', async () => {
    const root = await tempRoot('aw-portable-short-description-');
    const plugin = await pluginFixture(root, baseManifest('short-description'));
    const descriptions = [
      { name: 'metadata', description: 'A detailed description. More information.',
        short: '\u001b[31m简短说明\u001b[0m\n下一行', expected: '简短说明 下一行', source: 'metadata' },
      { name: 'fallback', description: '第一句话。后续不进入短行。',
        expected: '第一句话。', source: 'fallback' },
      { name: 'bounded', description: '长'.repeat(200),
        expected: `${'长'.repeat(119)}…`, source: 'fallback' },
    ];
    for (const entry of descriptions) {
      await writeSkill(plugin.rootDir, entry.name);
      await fs.writeFile(path.join(plugin.rootDir, 'skills', entry.name, 'SKILL.md'),
        `---\nname: ${entry.name}\ndescription: ${JSON.stringify(entry.description)}\n`
        + (entry.short === undefined ? '' : `metadata:\n  short-description: ${JSON.stringify(entry.short)}\n`)
        + '---\nBody.\n');
    }
    const materialized = await materializePortableSkills({
      platform: 'generic',
      plugins: [plugin], pluginId: plugin.pluginId!, scope: 'project', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home') },
    });
    for (const entry of descriptions) {
      expect(materialized.candidates.find((candidate) => candidate.name === entry.name)).toMatchObject({
        description: entry.description,
        shortDescription: entry.expected,
        shortDescriptionSource: entry.source,
      });
    }
    await materialized.cleanup();
  });

  it('publishes the explicit dynamic resource closure and omits disabled components', async () => {
    const root = await tempRoot('aw-portable-dynamic-');
    const manifest: PluginManifestSource = {
      ...baseManifest('dynamic'), skills: undefined,
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { configKeys: [], sourceDirs: ['./resources'], scopes: ['project'] },
    };
    const plugin = await pluginFixture(root, manifest);
    await fs.outputFile(path.join(plugin.rootDir, 'resources', 'source.txt'), 'source');
    await fs.outputFile(path.join(plugin.rootDir, 'resources', 'undeclared.txt'), 'must-not-copy');
    const render = (authorOnly = false): string => `console.log(JSON.stringify({version:3,components:[
      {id:'enabled',kind:'skill',name:'owned',content:{files:{
        'SKILL.md':{text:'---\\nname: owned\\ndescription: rendered\\n---\\nRendered.\\n'},
        'README.md':{text:'# Owned\\n'},
        'references/source.txt':{source:{kind:'bundle',path:'resources/source.txt'}},
        ${authorOnly ? "'evals/private.md':{text:'author-only'}," : ''}
      }}}
    ],omitted:[{id:'disabled',kind:'skill',reason:'config-disabled'}],unmet:[]}))`;
    await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'render.mjs'), render());
    const materialized = await materializePortableSkills({
      platform: 'generic', plugins: [plugin], pluginId: plugin.pluginId!, scope: 'project', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home') },
    });
    expect(materialized.candidates).toMatchObject([{ name: 'owned', description: 'rendered', dynamic: true }]);
    expect(await fs.readFile(path.join(materialized.rootDir, 'skills', 'owned', 'references', 'source.txt'), 'utf8')).toBe('source');
    expect(await fs.pathExists(path.join(materialized.rootDir, 'skills', 'owned', 'undeclared.txt'))).toBe(false);
    expect(await fs.pathExists(path.join(materialized.rootDir, 'skills', 'disabled'))).toBe(false);
    expect(materialized.preparation.flatMap((unit) => unit.omitted)).toContainEqual({ id: 'disabled', kind: 'skill', reason: 'config-disabled' });
    await materialized.cleanup();
    await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'render.mjs'), render(true));
    await expect(materializePortableSkills({
      platform: 'generic', plugins: [plugin], pluginId: plugin.pluginId!, scope: 'project', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-author-only') },
    })).rejects.toThrow(/reserved Skill file.*evals\/private.md/u);
  });

  it('rejects name collisions, sensitive config leaks, and invalid portable SKILL.md', async () => {
    const root = await tempRoot('aw-portable-invalid-');
    const left = await pluginFixture(root, baseManifest('left'));
    const right = await pluginFixture(root, { ...baseManifest('right'), dependencies: ['left'] });
    await writeSkill(left.rootDir, 'duplicate');
    await writeSkill(right.rootDir, 'duplicate');
    await expect(materializePortableSkills({
      platform: 'generic',
      plugins: [left, right], pluginId: right.pluginId!, scope: 'user', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-a') },
    })).rejects.toThrow('name collision');

    const secretManifest: PluginManifestSource = {
      ...baseManifest('secret'),
      config: {
        fields: {
          token: { type: 'string', sensitive: true },
        },
      },
    };
    const secret = await pluginFixture(root, secretManifest);
    secret.sourceIdentity = `sha256:${'1'.repeat(64)}`;
    secret.catalogLogicalIdentity = 'fixture-catalog';
    await writeSkill(secret.rootDir, 'leak', 'plain-secret');
    const secretEnv = { ...process.env, AW_HOME: path.join(root, 'home-b') };
    await writePluginConfigStore({
      sourceId: secret.sourceId,
      sourceIdentity: secret.sourceIdentity,
      logicalIdentity: secret.catalogLogicalIdentity,
      pluginName: secret.manifest.name,
      scope: 'user',
      cwd: root,
      env: secretEnv,
      values: { token: 'plain-secret' },
    });
    const contentFailure = await materializePortableSkills({
      platform: 'generic',
      plugins: [secret], pluginId: secret.pluginId!, scope: 'user', cwd: root,
      env: secretEnv,
    }).then(() => undefined, (error: unknown) => error);
    expect(String(contentFailure)).toContain('componentSensitiveConfigExposed');
    expect(String(contentFailure)).not.toContain('plain-secret');

    await writeSkill(secret.rootDir, 'leak', 'Safe content.');
    await fs.outputFile(
      path.join(secret.rootDir, 'skills', 'leak', 'references', 'plain-secret.txt'),
      'Safe content.',
    );
    const pathFailure = await materializePortableSkills({
      platform: 'generic',
      plugins: [secret], pluginId: secret.pluginId!, scope: 'user', cwd: root,
      env: secretEnv,
    }).then(() => undefined, (error: unknown) => error);
    expect(String(pathFailure)).toContain('componentSensitiveConfigExposed');
    expect(String(pathFailure)).not.toContain('plain-secret');

    const receiptName = 'receipt-safe-secret';
    const receiptPlugin = await pluginFixture(root, {
      ...baseManifest(receiptName),
      config: { fields: { token: { type: 'string', sensitive: true } } },
    });
    receiptPlugin.sourceIdentity = `sha256:${'2'.repeat(64)}`;
    receiptPlugin.catalogLogicalIdentity = 'fixture-catalog';
    await writeSkill(receiptPlugin.rootDir, 'receipt-safe', 'Safe content.');
    const receiptEnv = { ...process.env, AW_HOME: path.join(root, 'home-receipt-safe') };
    await writePluginConfigStore({
      sourceId: receiptPlugin.sourceId,
      sourceIdentity: receiptPlugin.sourceIdentity,
      logicalIdentity: receiptPlugin.catalogLogicalIdentity,
      pluginName: receiptPlugin.manifest.name,
      scope: 'user',
      cwd: root,
      env: receiptEnv,
      values: { token: receiptName },
    });
    const receiptMaterialized = await materializePortableSkills({
      platform: 'generic',
      plugins: [receiptPlugin], pluginId: receiptPlugin.pluginId!, scope: 'user', cwd: root,
      env: receiptEnv,
    });
    expect(receiptMaterialized.candidates.map((candidate) => candidate.name)).toEqual(['receipt-safe']);
    await receiptMaterialized.cleanup();

    const invalid = await pluginFixture(root, baseManifest('invalid'));
    await fs.outputFile(path.join(invalid.rootDir, 'skills', 'bad', 'SKILL.md'), 'no frontmatter');
    await expect(materializePortableSkills({
      platform: 'generic',
      plugins: [invalid], pluginId: invalid.pluginId!, scope: 'user', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-c') },
    })).rejects.toThrow('frontmatter');

    const reserved = await pluginFixture(root, baseManifest('reserved'));
    await writeSkill(reserved.rootDir, 'reserved');
    await fs.outputJson(path.join(
      reserved.rootDir,
      'skills',
      'reserved',
      'aw-plugin-requirements.json',
    ), {});
    await expect(materializePortableSkills({
      platform: 'generic',
      plugins: [reserved], pluginId: reserved.pluginId!, scope: 'user', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-reserved') },
    })).rejects.toThrow(/reserved.*receipt/iu);

    const uppercase = await pluginFixture(root, baseManifest('uppercase'));
    await fs.outputFile(
      path.join(uppercase.rootDir, 'skills', 'Foo', 'SKILL.md'),
      '---\nname: Foo\ndescription: Must not bypass an installed lowercase foo.\n---\n',
    );
    await fs.outputFile(path.join(uppercase.rootDir, 'skills', 'Foo', 'README.md'), '# Foo\n');
    await expect(materializePortableSkills({
      platform: 'generic',
      plugins: [uppercase], pluginId: uppercase.pluginId!, scope: 'user', cwd: root,
      env: { ...process.env, AW_HOME: path.join(root, 'home-uppercase') },
    })).rejects.toThrow('ASCII lowercase hyphen-case');
  });

  it('uses only verified runtime imports and the declared resource closure for a dynamic owner', async () => {
    const root = await tempRoot('aw-portable-exact-projection-');
    const provider = await pluginFixture(root, {
      ...baseManifest('provider'), skills: undefined,
      buildConfig: { runtimeExports: [{ name: 'runtime', source: './runtime.txt', requires: { aw: { capabilities: [] } } }] },
    });
    await fs.outputFile(path.join(provider.rootDir, 'runtime.txt'), 'projected');
    const consumer = await pluginFixture(root, {
      ...baseManifest('consumer'), skills: undefined,
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { configKeys: [], sourceDirs: ['./resources'], scopes: ['project'],
        runtimeImports: [{ name: 'runtime', plugin: 'provider', export: 'runtime' }] },
    });
    await fs.outputFile(path.join(consumer.rootDir, 'resources', 'SKILL.md'), '---\nname: owned\ndescription: dynamic source\n---\nSource.\n');
    await fs.outputFile(path.join(consumer.rootDir, 'resources', 'README.md'), '# Owned\n');
    await fs.outputFile(path.join(consumer.rootDir, 'scripts', 'render.mjs'), `import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (context.platform !== 'generic' || context.surface !== 'agent-plugin') process.exit(2);
if (!context.resources.some(resource=>resource.kind==='runtime-import' && resource.name==='runtime')) process.exit(3);
console.log(JSON.stringify({version:3,components:[{id:'owned',kind:'skill',name:'owned',content:{files:{
  'SKILL.md':{source:{kind:'bundle',path:'resources/SKILL.md'}},
  'README.md':{source:{kind:'bundle',path:'resources/README.md'}},
  'references/runtime.txt':{source:{kind:'runtime-import',name:'runtime',path:'runtime'}}
}}}],omitted:[],unmet:[]}));`);
    const bundleRoot = path.join(root, 'bundle');
    await bundleLocalPlugin(consumer, bundleRoot, { runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]) });
    await fs.outputFile(path.join(bundleRoot, 'resources', 'undeclared.txt'), 'must-not-copy');
    const bundled = await readPluginManifest(bundleRoot, { mode: 'bundle' });
    Object.assign(bundled, { sourceId: 'fixture', sourceIdentity: `sha256:${'2'.repeat(64)}`, pluginId: 'fixture/consumer' });
    const options = { platform: 'generic' as const, plugins: [bundled], pluginId: bundled.pluginId!, scope: 'project' as const,
      cwd: root, env: { ...process.env, AW_HOME: path.join(root, 'home') }, inputMode: 'bundle' as const };
    const materialized = await materializePortableSkills(options);
    expect(materialized.candidates).toMatchObject([{ name: 'owned', providerPluginId: 'fixture/consumer', relation: 'requested', dynamic: true }]);
    expect(await fs.readFile(path.join(materialized.rootDir, 'skills', 'owned', 'references', 'runtime.txt'), 'utf8')).toBe('projected');
    expect(await fs.pathExists(path.join(materialized.rootDir, 'skills', 'owned', 'undeclared.txt'))).toBe(false);
    await materialized.cleanup();
    await fs.remove(path.join(bundleRoot, 'resources', 'SKILL.md'));
    await expect(materializePortableSkills(options)).rejects.toThrow(/resource.*(?:missing|exist)|ENOENT/iu);
  });

  it('renders only the selected scope without treating dynamic source files as static Skills', async () => {
    const root = await tempRoot('aw-portable-cross-scope-');
    const plugin = await pluginFixture(root, {
      ...baseManifest('cross-scope'), skills: undefined,
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { configKeys: [], sourceDirs: ['./resources'] },
    });
    await fs.outputFile(path.join(plugin.rootDir, 'resources', 'unused.txt'), 'must-not-copy');
    await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'render.mjs'), `
import fs from 'node:fs';
const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
fs.appendFileSync(new URL('../render.log', import.meta.url), context.scope + '\\n');
const key = context.scope + '-only';
console.log(JSON.stringify({version:3,components:[{id:key,kind:'skill',name:key,content:{files:{
  'SKILL.md':{text:'---\\nname: '+key+'\\ndescription: Selected scope.\\n---\\nBody.\\n'},
  'README.md':{text:'# Selected scope\\n'}
}}}],omitted:[],unmet:[]}));
`);
    for (const scope of ['project', 'user'] as const) {
      const materialized = await materializePortableSkills({ platform: 'generic', plugins: [plugin], pluginId: plugin.pluginId!, scope, cwd: root,
        env: { ...process.env, AW_HOME: path.join(root, `home-${scope}`) } });
      expect(materialized.candidates.map((candidate) => candidate.name)).toEqual([`${scope}-only`]);
      expect(await fs.pathExists(path.join(materialized.rootDir, 'skills', `${scope}-only`, 'unused.txt'))).toBe(false);
      expect(materialized.preparation.every((unit) => unit.renderScope === scope)).toBe(true);
      await materialized.cleanup();
    }
    expect(await fs.pathExists(path.join(plugin.rootDir, 'render.log'))).toBe(false);
  });
});
