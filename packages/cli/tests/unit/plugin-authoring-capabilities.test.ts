import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';
import {
  readPluginManifest,
  validateSourcePluginManifest,
} from '../../src/utils/manifest.js';
import {
  parsePluginAuthoringCapabilityRegistry,
  PLUGIN_AUTHORING_CAPABILITIES,
} from '../../src/utils/plugin-authoring-capabilities.js';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

function marketplace() {
  return {
    category: 'workflow',
    strict: true,
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
  };
}

function sourceManifest(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    version: '0.1.0',
    description: `${name} test plugin.`,
    compatibility: { aw: { minVersion: '0.1.0' } },
    skills: './skills',
    marketplace: marketplace(),
    distributions: { agentSkills: { skills: './portable-skills' } },
    ...extra,
  };
}

async function writeSourcePlugin(options: {
  name: string;
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
}): Promise<{ pluginRoot: string; manifest: Record<string, unknown> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-capabilities-'));
  tempRoots.push(root);
  const pluginRoot = path.join(root, options.name);
  const manifest = options.manifest ?? sourceManifest(options.name);
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, { spaces: 2 });
  await Promise.all([
    fs.outputFile(
      path.join(pluginRoot, 'skills', 'native-status', 'SKILL.md'),
      '---\nname: native-status\ndescription: Native status.\n---\n',
    ),
    fs.outputFile(path.join(pluginRoot, 'skills', 'native-status', 'README.md'), '# Native status\n'),
    fs.outputFile(
      path.join(pluginRoot, 'portable-skills', 'portable-status', 'SKILL.md'),
      '---\nname: portable-status\ndescription: Portable status.\n---\n',
    ),
    fs.outputFile(path.join(pluginRoot, 'portable-skills', 'portable-status', 'README.md'), '# Portable status\n'),
    fs.outputFile(path.join(pluginRoot, 'runtime', 'status-fields.json'), '{"fields":["state"]}\n'),
    ...Object.entries(options.files ?? {}).map(([relativePath, content]) =>
      fs.outputFile(path.join(pluginRoot, relativePath), content),
    ),
  ]);
  return { pluginRoot, manifest };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.remove(root)));
});

describe('plugin authoring capability registry', () => {
  it('publishes real Portable Agent Skills validator sources and plan semantics', async () => {
    // Static contract exception: installed authors use these validator links as a public authoring contract; behavior tests below exercise the source and public validators, but cannot prove a published link stays accurate.
    const entries = Object.values(PLUGIN_AUTHORING_CAPABILITIES.surfaces)
      .flatMap((surface) => surface.entries);
    const portableContracts = [
      {
        field: 'distributions.agentSkills',
        verifiedSource: 'packages/cli/src/utils/manifest.ts validateSourcePluginManifest',
        sources: [['src/utils/manifest.ts', 'validateSourcePluginManifest']],
      },
      {
        field: 'distributions.agentSkills.skills',
        verifiedSource: 'packages/cli/src/utils/manifest.ts validateSourcePluginManifest',
        sources: [['src/utils/manifest.ts', 'validateSourcePluginManifest']],
      },
      {
        field: 'skillRuntimeFiles[].distributions',
        verifiedSource: 'packages/cli/src/utils/manifest.ts validateSourcePluginManifest',
        sources: [['src/utils/manifest.ts', 'validateSourcePluginManifest']],
      },
      {
        field: 'generatedSkillRuntimeFiles[].distributions',
        verifiedSource: 'packages/cli/src/utils/manifest.ts validateSourcePluginManifest; packages/cli/src/generators/local-plugin.ts validateGeneratedSkillRuntimeFiles',
        profiles: 'agent-skills',
        sources: [
          ['src/utils/manifest.ts', 'validateSourcePluginManifest'],
          ['src/generators/local-plugin.ts', 'validateGeneratedSkillRuntimeFiles'],
        ],
      },
      {
        field: 'scripts.artifacts.render',
        verifiedSource: 'packages/cli/authoring/scripts/validate-plugin.mjs validateDynamicArtifactsLightweight',
        sources: [['authoring/scripts/validate-plugin.mjs', 'validateDynamicArtifactsLightweight']],
      },
      {
        field: 'artifacts.targets[]',
        verifiedSource: 'packages/cli/authoring/scripts/validate-plugin.mjs validateDynamicArtifactsLightweight',
        sources: [['authoring/scripts/validate-plugin.mjs', 'validateDynamicArtifactsLightweight']],
      },
      {
        field: 'artifacts.targets[agent-skills.skill]',
        verifiedSource: 'packages/cli/src/utils/manifest.ts validateSourcePluginManifest; packages/cli/authoring/scripts/validate-plugin.mjs validateDynamicArtifactsLightweight',
        profiles: 'agent-skills',
        sources: [
          ['src/utils/manifest.ts', 'validateSourcePluginManifest'],
          ['authoring/scripts/validate-plugin.mjs', 'validateDynamicArtifactsLightweight'],
        ],
      },
      {
        field: 'artifacts.targets[agent-skills.skill].runtimeImports',
        verifiedSource: 'packages/cli/src/utils/manifest.ts validateSourcePluginManifest; packages/cli/src/generators/local-plugin.ts resolveArtifactRuntimeImports',
        profiles: 'agent-skills',
        sources: [
          ['src/utils/manifest.ts', 'validateSourcePluginManifest'],
          ['src/generators/local-plugin.ts', 'resolveArtifactRuntimeImports'],
        ],
      },
      {
        field: 'ArtifactPlan.artifacts[agent-skills.skill]',
        verifiedSource: 'packages/cli/src/utils/artifact-plan.ts validateArtifactPlan',
        profiles: 'agent-skills',
        required: 'for every declared target in the current agent-skills distribution and scope, including disabled',
        sources: [['src/utils/artifact-plan.ts', 'validateArtifactPlan']],
      },
    ];
    const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

    for (const contract of portableContracts) {
      const entry = entries.find((candidate) => candidate.field === contract.field);
      expect(entry, contract.field).toMatchObject({
        verifiedSource: contract.verifiedSource,
      });
      if (contract.profiles) {
        expect(entry?.profiles, contract.field).toContain(contract.profiles);
      }
      expect(entry?.requires ?? entry?.required, contract.field).toBeTruthy();
      if (contract.required) {
        expect(entry?.required, contract.field).toBe(contract.required);
      }
      for (const [relativePath, functionName] of contract.sources) {
        const source = await fs.readFile(path.join(cliRoot, relativePath), 'utf8');
        expect(source, `${relativePath} must define ${functionName}`).toMatch(
          new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\b`, 'u'),
        );
      }
    }
  });

  it('rejects invalid Portable source declarations through the claimed source validator', async () => {
    const { pluginRoot, manifest } = await writeSourcePlugin({ name: 'portable-source-contract' });

    const { pluginRoot: portableOnlyRoot, manifest: portableOnly } = await writeSourcePlugin({
      name: 'portable-only-source-contract',
    });
    delete (portableOnly as { skills?: unknown }).skills;
    await fs.remove(path.join(portableOnlyRoot, 'skills'));
    await expect(validateSourcePluginManifest(portableOnlyRoot, portableOnly))
      .rejects.toThrow('portable-only plugins');

    const invalidPortableRoot = structuredClone(manifest);
    (invalidPortableRoot.distributions as { agentSkills: { skills: string } }).agentSkills.skills
      = './broken-portable-skills';
    await fs.outputFile(path.join(pluginRoot, 'broken-portable-skills', 'broken', 'README.md'), '# Broken\n');
    await expect(validateSourcePluginManifest(pluginRoot, invalidPortableRoot))
      .rejects.toThrow();

    const invalidProjection = structuredClone(manifest);
    invalidProjection.buildConfig = {
      skillRuntimeFiles: [{
        skill: 'missing-portable-skill',
        target: 'references/status-fields.json',
        distributions: ['agent-skills'],
        source: './runtime/status-fields.json',
      }],
    };
    await expect(validateSourcePluginManifest(pluginRoot, invalidProjection))
      .rejects.toThrow('not a declared portable Skill key');

    const invalidGeneratedProjection = structuredClone(manifest);
    invalidGeneratedProjection.buildConfig = {
      generatedSkillRuntimeFiles: [{
        skill: 'missing-portable-skill',
        target: 'references/status-fields.generated.md',
        distributions: ['agent-skills'],
      }],
    };
    invalidGeneratedProjection.scripts = {
      node: { build: { runner: 'node', path: './scripts/build.mjs' } },
    };
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'build.mjs'), 'export {};\n');
    await expect(validateSourcePluginManifest(pluginRoot, invalidGeneratedProjection))
      .rejects.toThrow('not a declared portable Skill key');

    const authorSuppliedResolvedImport = structuredClone(manifest);
    authorSuppliedResolvedImport.artifacts = {
      targets: [{
        id: 'dynamic-portable',
        distribution: 'agent-skills',
        target: 'agent-skills.skill',
        scopes: ['user'],
        states: ['present'],
        refreshKeys: [],
        skillKey: 'dynamic-portable',
        runtimeImports: [{
          name: 'status-registry',
          plugin: 'status-registry-provider',
          export: 'status-registry',
          resolved: {
            path: './.agents-plugin/runtime-imports/dynamic-portable/status-registry',
            digest: `sha256:${'0'.repeat(64)}`,
            providerPluginId: 'status-registry-provider',
            providerVersion: '0.1.0',
            source: './runtime/status-registry.json',
          },
        }],
      }],
    };
    await expect(validateSourcePluginManifest(pluginRoot, authorSuppliedResolvedImport))
      .rejects.toThrow('resolved metadata is build-owned');
  });

  it('uses the public author validator to reject an unpaired artifact target or renderer', async () => {
    const artifactTarget = {
      id: 'native-instructions',
      platform: 'codex',
      target: 'codex.developerInstructionsBlock',
      scopes: ['user'],
      states: ['present'],
      refreshKeys: [],
    };
    const { pluginRoot, manifest } = await writeSourcePlugin({
      name: 'artifact-pairing',
      manifest: sourceManifest('artifact-pairing', {
        extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
        artifacts: { targets: [artifactTarget] },
      }),
    });
    const validator = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'authoring',
      'scripts',
      'validate-plugin.mjs',
    );

    await expect(execFileAsync(process.execPath, [validator, pluginRoot], {
      cwd: pluginRoot,
      maxBuffer: 10 * 1024 * 1024,
    })).rejects.toMatchObject({
      stdout: expect.stringContaining('artifacts.targets requires scripts.artifacts.render'),
    });

    const unpairedRenderer = structuredClone(manifest);
    delete (unpairedRenderer as { artifacts?: unknown }).artifacts;
    unpairedRenderer.scripts = {
      artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
    };
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), 'console.log("{}")\n');
    await fs.outputJson(
      path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      unpairedRenderer,
      { spaces: 2 },
    );
    await expect(execFileAsync(process.execPath, [validator, pluginRoot], {
      cwd: pluginRoot,
      maxBuffer: 10 * 1024 * 1024,
    })).rejects.toMatchObject({
      stdout: expect.stringContaining('scripts.artifacts.render requires artifacts.targets'),
    });
  });

  it('resolves runtime imports into consumer-local bundle bytes without manifest dependencies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-runtime-import-capability-'));
    tempRoots.push(root);
    const providerRoot = path.join(root, 'status-registry-provider');
    const consumerRoot = path.join(root, 'portable-observer');
    await Promise.all([
      fs.outputJson(path.join(providerRoot, '.agents-plugin', 'plugin.json'), {
        name: 'status-registry-provider',
        version: '0.1.0',
        description: 'Provider.',
        compatibility: { aw: { minVersion: '0.1.0' } },
        extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
        marketplace: marketplace(),
        buildConfig: {
          runtimeExports: [{ name: 'status-registry', source: './runtime/status-registry.json' }],
        },
      }, { spaces: 2 }),
      fs.outputFile(path.join(providerRoot, 'runtime', 'status-registry.json'), '{"states":["ready"]}\n'),
      fs.outputJson(path.join(consumerRoot, '.agents-plugin', 'plugin.json'), {
        name: 'portable-observer',
        version: '0.1.0',
        description: 'Consumer.',
        compatibility: { aw: { minVersion: '0.1.0' } },
        extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
        marketplace: marketplace(),
        distributions: { agentSkills: {} },
        artifacts: {
          targets: [{
            id: 'observe-project',
            distribution: 'agent-skills',
            target: 'agent-skills.skill',
            scopes: ['project'],
            states: ['present'],
            refreshKeys: [],
            skillKey: 'observe-project',
            runtimeImports: [{
              name: 'status-registry',
              plugin: 'status-registry-provider',
              export: 'status-registry',
            }],
          }],
        },
      }, { spaces: 2 }),
    ]);
    const [provider, consumer] = await Promise.all([
      readPluginManifest(providerRoot),
      readPluginManifest(consumerRoot),
    ]);
    expect(consumer.manifest.dependencies).toBeUndefined();

    const bundleRoot = path.join(root, 'portable-observer-bundle');
    await bundleLocalPlugin(consumer, bundleRoot, {
      runtimeResolver: createCatalogRuntimeImportResolver([provider, consumer]),
    });

    const bundleManifest = await fs.readJson(path.join(bundleRoot, '.agents-plugin', 'plugin.json'));
    const resolved = bundleManifest.artifacts.targets[0].runtimeImports[0].resolved;
    expect(resolved).toMatchObject({
      providerPluginId: 'status-registry-provider',
      source: './runtime/status-registry.json',
    });
    await expect(fs.readFile(path.join(bundleRoot, resolved.path), 'utf8'))
      .resolves.toBe('{"states":["ready"]}\n');
  });

  it('validates and bundles generated Skill files on their declared native or Portable surface', async () => {
    const { pluginRoot, manifest } = await writeSourcePlugin({
      name: 'generated-surface-contract',
      files: { 'scripts/build.mjs': 'export {};\n' },
    });
    manifest.scripts = {
      node: { build: { runner: 'node', path: './scripts/build.mjs' } },
    };
    manifest.buildConfig = {
      generatedSkillRuntimeFiles: [
        {
          skill: 'native-status',
          target: 'references/native-generated.md',
        },
        {
          skill: 'portable-status',
          target: 'references/portable-generated.md',
          distributions: ['agent-skills'],
        },
      ],
    };

    const validated = await validateSourcePluginManifest(pluginRoot, manifest);
    const runner = {
      async installPackageRoot() {},
      async runNodeBuild({ pluginRoot: stagingRoot }: { pluginRoot: string }) {
        await Promise.all([
          fs.outputFile(
            path.join(stagingRoot, 'skills', 'native-status', 'references', 'native-generated.md'),
            'native generated\n',
          ),
          fs.outputFile(
            path.join(stagingRoot, 'portable-skills', 'portable-status', 'references', 'portable-generated.md'),
            'portable generated\n',
          ),
        ]);
      },
    };
    const bundleRoot = path.join(path.dirname(pluginRoot), 'generated-surface-bundle');

    await bundleLocalPlugin({
      rootDir: pluginRoot,
      manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      manifest: validated,
    }, bundleRoot, {
      buildMode: 'staging',
      stagingRunner: runner,
    });

    await expect(fs.readFile(
      path.join(bundleRoot, 'codex', 'skills', 'native-status', 'references', 'native-generated.md'),
      'utf8',
    )).resolves.toBe('native generated\n');
    await expect(fs.readFile(
      path.join(bundleRoot, 'claude', 'skills', 'native-status', 'references', 'native-generated.md'),
      'utf8',
    )).resolves.toBe('native generated\n');
    await expect(fs.readFile(
      path.join(bundleRoot, 'agent-skills', 'skills', 'portable-status', 'references', 'portable-generated.md'),
      'utf8',
    )).resolves.toBe('portable generated\n');
    await expect(fs.pathExists(
      path.join(bundleRoot, 'codex', 'skills', 'portable-status', 'references', 'portable-generated.md'),
    )).resolves.toBe(false);
  });

  it('rejects malformed entries before consumers use the registry', () => {
    expect(() => parsePluginAuthoringCapabilityRegistry({
      schemaVersion: 1,
      verifiedSource: 'manifest.ts',
      surfaces: {
        manifest: {
          title: 'Manifest',
          entries: [{ field: 'name', type: 'string' }],
        },
      },
    })).toThrow('entry "manifest"[0]');
  });
});
