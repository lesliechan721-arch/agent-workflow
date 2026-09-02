import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  compareStrictSemVer,
  createBundleSourceManifest,
  normalizeManifestDigestInput,
  createPlatformManifestBase,
  parseStrictSemVer,
  readMarketplaceSourceMeta,
  readPluginManifest,
  STRICT_SEMVER_VALIDATION_CODE,
  validatePluginManifest,
  validateSourcePluginManifest,
} from '../../src/utils/manifest.js';
import {
  scanJavaScriptImportSpecifiers,
  scanNodeImportContract,
} from '../../src/utils/plugin-script-contract.js';
import {
  CLAUDE_NATIVE_HOOK_EVENTS,
  NATIVE_HOOK_EVENT_CONTRACTS,
} from '../../src/utils/hooks-contract.js';
import { getPluginAuthoringAcceptedValues } from '@lesliechan721/aw-plugin-core/manifest';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeTempRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-manifest-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

async function readFixturePluginManifest(repoRoot: string): Promise<Record<string, unknown>> {
  return fs.readJson(
    path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
  );
}

async function writeFixturePluginManifest(
  repoRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await fs.writeJson(
    path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
    manifest,
    { spaces: 2 },
  );
}

async function writeScriptFixture(pluginRoot: string): Promise<void> {
  await fs.ensureDir(path.join(pluginRoot, 'scripts'));
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'lifecycle.mjs'), 'import "./shared.mjs";\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'shared.mjs'), 'export const ok = true;\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'uninstall.sh'), 'echo uninstall\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'uninstall.ps1'), 'Write-Output uninstall\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'aw-config.cjs'), 'module.exports = {};\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'build.mjs'), 'console.log("build");\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'render-artifacts.mjs'), 'import "./shared.mjs";\nconsole.log("{}");\n', 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'lifecycle.test.mjs'), 'import "./shared.mjs";\n', 'utf8');
  await fs.writeJson(
    path.join(pluginRoot, 'scripts', 'package.json'),
    {
      name: 'git-commit-scripts',
      version: '0.1.0',
      type: 'module',
      dependencies: {
        chalk: '^5.0.0',
      },
      devDependencies: {
        vitest: '^3.0.0',
      },
    },
    { spaces: 2 },
  );
  await fs.writeFile(path.join(pluginRoot, 'scripts', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
}

function createMarketplaceWithProducts(products: string[]) {
  return {
    category: 'workflow',
    strict: true,
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
      products,
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('manifest utils', () => {
  it('keeps the public manifest validator aligned with registry installation policies', async () => {
    const repoRoot = await makeTempRepo();
    const rawManifest = await readFixturePluginManifest(repoRoot);
    const accepted = getPluginAuthoringAcceptedValues(
      'manifest',
      'marketplace.policy.installation',
    );

    for (const installation of accepted) {
      const manifest = structuredClone(rawManifest);
      manifest.marketplace.policy.installation = installation;
      expect(validatePluginManifest('/tmp/plugin', manifest).marketplace.policy.installation)
        .toBe(installation);
    }

    const invalid = structuredClone(rawManifest);
    invalid.marketplace.policy.installation = 'UNKNOWN';
    expect(() => validatePluginManifest('/tmp/plugin', invalid)).toThrow(
      '/marketplace/policy/installation',
    );
  });

  it('reads marketplace source metadata and plugin source manifest', async () => {
    const repoRoot = await makeTempRepo();
    const [marketplace, plugin] = await Promise.all([
      readMarketplaceSourceMeta(repoRoot),
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ]);

    expect(marketplace).toEqual({
      owner: {
        name: 'Leslie Chan',
        url: 'https://github.com/LeslieChan/agent-workflows',
      },
      interface: {
        displayName: 'Agent Workflows',
      },
      catalog: {
        version: '0.1.0',
      },
    });

    expect(plugin.manifest.marketplace).toMatchObject({
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    });
    expect(plugin.manifest.marketplace.policy.products).toBeUndefined();
    expect(plugin.manifest.schemaVersion).toBe(3);
    expect(plugin.manifest.extensions?.hooks?.[0]).toMatchObject({
      event: 'before_tool',
      matcher: 'Bash',
    });
  });

  it('rejects an unknown manifest schema version through the CLI bridge', async () => {
    const repoRoot = await makeTempRepo();
    const rawManifest = await readFixturePluginManifest(repoRoot);
    await writeFixturePluginManifest(repoRoot, { ...rawManifest, schemaVersion: 1 });

    await expect(readPluginManifest(
      path.join(repoRoot, 'plugins', 'git-commit'),
    )).rejects.toThrow('Unsupported plugin manifest schemaVersion');
  });

  it('preserves declared capabilities in source and bundle manifests', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const rawManifest = await readFixturePluginManifest(repoRoot);
    rawManifest.requires = { aw: { capabilities: ['aw.future-feature.v3'] } };
    await writeFixturePluginManifest(repoRoot, rawManifest);
    const plugin = await readPluginManifest(pluginRoot);

    expect(plugin.manifest.requires?.aw.capabilities).toEqual(['aw.future-feature.v3']);
    expect(createBundleSourceManifest(plugin).requires?.aw.capabilities)
      .toEqual(['aw.future-feature.v3']);
  });

  it('rejects deprecated top-level claude block', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    manifest.claude = {
      hooks: './hooks/hooks.json',
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ).rejects.toThrow('must NOT have additional properties');
  });

  it('rejects non-strict SemVer plugin versions in source manifests', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const invalidVersions = [
      'v1.2.3',
      '1.2',
      '^1.2.3',
      'latest',
      '1.2.3 || 2.0.0',
      '1.2.3-',
      '1.2.3-+meta',
    ];

    for (const version of invalidVersions) {
      const manifest = await readFixturePluginManifest(repoRoot);
      manifest.version = version;
      await writeFixturePluginManifest(repoRoot, manifest);

      await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
        '/version must match pattern',
      );
    }
  });

  it('rejects prerelease and build metadata only in source plugin manifests', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');

    for (const version of ['1.2.3-beta.1', '1.2.3+build.1']) {
      const manifest = await readFixturePluginManifest(repoRoot);
      manifest.version = version;
      await writeFixturePluginManifest(repoRoot, manifest);

      await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
        'Invalid plugin manifest.version: expected a stable SemVer without prerelease or build metadata.',
      );
      expect(validatePluginManifest(pluginRoot, manifest).version).toBe(version);
    }
  });

  it('parses valid strict SemVer strings and preserves the original raw value', () => {
    const versions = [
      '1.2.3',
      '1.2.3-beta.1',
      '1.2.3+build.1',
      '1.2.3-beta.1+build.5',
    ];

    for (const version of versions) {
      expect(parseStrictSemVer(version, 'test.version')).toMatchObject({
        raw: version,
      });
    }
  });

  it('throws a stable SemVer validation error with field path and value', () => {
    try {
      parseStrictSemVer('latest', 'plugin manifest.version');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        code: STRICT_SEMVER_VALIDATION_CODE,
        fieldPath: 'plugin manifest.version',
        value: 'latest',
      });
      expect((error as Error).message).toContain('plugin manifest.version');
      expect((error as Error).message).toContain('"latest"');
      return;
    }

    throw new Error('expected parseStrictSemVer to throw');
  });

  it('compares strict SemVer precedence and ignores build metadata', () => {
    expect(compareStrictSemVer('1.2.3+build.1', '1.2.3+build.2')).toBe(0);
    expect(compareStrictSemVer('1.2.3-beta.1', '1.2.3')).toBeLessThan(0);
    expect(compareStrictSemVer('1.2.4', '1.2.3')).toBeGreaterThan(0);
  });

  it('rejects hook fields and permission patterns outside the public source contract', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.hooks[0].event = 'command';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unsupported hook event "command"',
    );

    manifest.extensions.hooks[0].event = 'before_tool';
    manifest.extensions.hooks[0].description = 'old field';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      '/extensions/hooks/0 must NOT have additional properties',
    );

    delete manifest.extensions.hooks[0].description;
    manifest.extensions.permissions[0].allow = ['git *'];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'only plain token prefixes are supported',
    );

    manifest.extensions.permissions[0].allow = ['git;rm -rf'];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'shell control characters',
    );
  });

  it('rejects unknown root marketplace metadata fields', async () => {
    const repoRoot = await makeTempRepo();
    const sourcePath = path.join(repoRoot, 'plugins', 'marketplace-source.json');
    const source = await fs.readJson(sourcePath);
    source.metadata = {
      internal: true,
    };
    await fs.writeJson(sourcePath, source, { spaces: 2 });

    await expect(readMarketplaceSourceMeta(repoRoot)).rejects.toThrow(
      'unknown field "metadata"',
    );
  });

  it('rejects unsupported marketplace authentication policies', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.marketplace.policy.authentication = 'NONE';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      '/marketplace/policy/authentication must be equal to one of the allowed values',
    );
  });

  it('rejects undeclared default skills directory', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    delete manifest.skills;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ).rejects.toThrow('found skills but missing "skills" declaration');
  });

  it('rejects declared native asset paths that do not exist', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    await fs.remove(path.join(pluginRoot, 'skills'));
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'skills points to "./skills" but path does not exist',
    );
  });

  it('accepts scripts and config manifest contracts and strips dev-only script fields from bundle manifests', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeScriptFixture(pluginRoot);
    manifest.scripts = {
      postApply: { path: './scripts/lifecycle.mjs', timeoutMs: 45_000 },
      helpers: {
        config: './scripts/aw-config.cjs',
      },
      artifacts: {
        render: {
          runner: 'node',
          path: './scripts/render-artifacts.mjs',
          args: ['--plan'],
        },
      },
      node: {
        packageRoot: './scripts',
        build: {
          runner: 'node',
          path: './scripts/build.mjs',
          args: ['--release'],
        },
      },
      tests: {
        node: ['./scripts/*.test.mjs'],
      },
    };
    manifest.config = {
      fields: {
        enableLightweightInstruction: {
          type: 'boolean',
          writableLayers: ['user', 'project'],
          default: true,
        },
        explorerModel: {
          type: 'string',
          writableLayers: ['user', 'project'],
          default: 'gpt-5.4-mini',
        },
        modelReasoningEffort: {
          type: 'string',
          writableLayers: ['user', 'project'],
          choices: {
            allowCustom: false,
            presets: ['low', 'medium', 'high', 'xhigh'].map((value) => ({
              id: value,
              title: value,
              value,
            })),
          },
          default: 'medium',
        },
        token: {
          type: 'string',
          writableLayers: ['user', 'project'],
          title: 'API Token',
          required: true,
          sensitive: true,
        },
        mode: {
          type: 'string',
          writableLayers: ['user', 'project'],
          choices: {
            allowCustom: false,
            presets: [
              { id: 'safe', title: 'Safe', value: 'safe' },
              { id: 'fast', title: 'Fast', value: 'fast' },
            ],
          },
          default: 'safe',
        },
        limit: {
          type: 'number',
          writableLayers: ['user', 'project'],
          validation: { minimum: 1, maximum: 10 },
          default: 3,
        },
      },
    };
    manifest.dependencies = ['shared-runtime'];
    manifest.requires = { aw: { capabilities: ['aw.future-feature.v3'] } };
    manifest.artifacts = {
      targets: [
        {
          id: 'lightweight-instruction',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.developerInstructionsBlock',
          projectManagedKind: 'instruction',
          states: ['present', 'disabled'],
          refreshKeys: [
            'enableLightweightInstruction',
            'explorerModel',
            'modelReasoningEffort',
          ],
          requiresCodexProjectConfig: true,
        },
        {
          id: 'codex-explorer-role',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.agentRole',
          projectManagedKind: 'agent',
          states: ['present'],
          refreshKeys: ['explorerModel', 'modelReasoningEffort'],
          requiresCodexProjectConfig: true,
          roleKey: 'codex-explorer',
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);

    const plugin = await readPluginManifest(pluginRoot);
    expect(plugin.manifest.scripts).toMatchObject({
      postApply: { path: './scripts/lifecycle.mjs', timeoutMs: 45_000 },
      helpers: {
        config: './scripts/aw-config.cjs',
      },
      artifacts: {
        render: {
          runner: 'node',
          path: './scripts/render-artifacts.mjs',
          args: ['--plan'],
        },
      },
      node: {
        packageRoot: './scripts',
        build: {
          runner: 'node',
          path: './scripts/build.mjs',
          args: ['--release'],
        },
      },
      tests: {
        node: ['./scripts/*.test.mjs'],
      },
    });
    expect(plugin.manifest.config?.fields.mode).toMatchObject({
      type: 'string',
      choices: {
        allowCustom: false,
      },
      default: 'safe',
    });

    const bundleManifest = createBundleSourceManifest(plugin);
    expect(bundleManifest.dependencies).toEqual(['shared-runtime']);
    expect(bundleManifest.scripts?.tests).toBeUndefined();
    expect(bundleManifest.scripts?.node?.build).toBeUndefined();
    expect(bundleManifest.scripts?.node?.packageRoot).toBe('./scripts');
    expect(bundleManifest.scripts?.helpers?.config).toBe('./scripts/aw-config.cjs');
    expect(bundleManifest.scripts?.artifacts?.render).toMatchObject({
      runner: 'node',
      path: './scripts/render-artifacts.mjs',
      args: ['--plan'],
    });
    expect(bundleManifest.artifacts?.targets).toEqual([
      expect.objectContaining({
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        projectManagedKind: 'instruction',
      }),
      expect.objectContaining({
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        projectManagedKind: 'agent',
        roleKey: 'codex-explorer',
      }),
    ]);
    expect(bundleManifest.config?.fields.token.sensitive).toBe(true);
    expect(bundleManifest.config?.fields.token.title).toBe('API Token');

    const platformManifest = createPlatformManifestBase(plugin) as Record<string, unknown>;
    expect(platformManifest.scripts).toBeUndefined();
    expect(platformManifest.artifacts).toBeUndefined();
    expect(platformManifest.config).toBeUndefined();
  });

  it('rejects legacy lifecycle, shell, selector, shorthand, and extra postApply fields', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeScriptFixture(pluginRoot);

    manifest.scripts = { lifecycle: { install: './scripts/lifecycle.mjs' } };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('/scripts must NOT have additional properties');

    manifest.scripts = { postApply: './scripts/lifecycle.mjs' };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('/scripts/postApply must be object');

    manifest.scripts = { postApply: { path: './scripts/uninstall.sh' } };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('Node runnable file extension');

    manifest.scripts = { postApply: { path: './scripts/lifecycle.mjs', runner: 'node' } };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('/scripts/postApply must NOT have additional properties');

    manifest.scripts = { postApply: { path: './scripts/lifecycle.mjs', linux: {} } };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('/scripts/postApply must NOT have additional properties');
  });

  it('rejects unsafe artifact renderer script declarations', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeScriptFixture(pluginRoot);

    manifest.scripts = {
      artifacts: {
        render: {
          runner: 'bash',
          path: './scripts/render-artifacts.mjs',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('must be equal to constant');

    manifest.scripts = {
      artifacts: {
        render: {
          runner: 'node',
          path: '../render-artifacts.mjs',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('path must start with "./"');

    manifest.scripts = {
      artifacts: {
        render: {
          runner: 'node',
          path: './scripts/render-artifacts.sh',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('Node runnable file extension');

    manifest.scripts = {
      artifacts: {
        render: {
          runner: 'node',
          path: './scripts/render-artifacts.mjs',
        },
      },
      unknown: true,
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('/scripts must NOT have additional properties');
  });

  it('rejects unsafe packageRoot metadata before staging install', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeScriptFixture(pluginRoot);

    manifest.scripts = {
      node: {
        packageRoot: './scripts',
      },
    };

    await fs.remove(path.join(pluginRoot, 'scripts', 'pnpm-lock.yaml'));
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('missing pnpm-lock.yaml');

    await fs.writeFile(path.join(pluginRoot, 'scripts', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
    await fs.writeJson(
      path.join(pluginRoot, 'scripts', 'package.json'),
      {
        name: 'git-commit-scripts',
        version: '0.1.0',
        dependencies: {
          local: 'file:../local.tgz',
        },
      },
      { spaces: 2 },
    );
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('not registry-backed');

    await fs.writeJson(
      path.join(pluginRoot, 'scripts', 'package.json'),
      {
        name: 'git-commit-scripts',
        version: '0.1.0',
        dependencies: {
          shortcut: 'owner/repo',
        },
      },
      { spaces: 2 },
    );
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('not registry-backed');

    await fs.writeJson(
      path.join(pluginRoot, 'scripts', 'package.json'),
      {
        name: 'git-commit-scripts',
        version: '0.1.0',
        optionalDependencies: {
          fsevents: '^2.0.0',
        },
      },
      { spaces: 2 },
    );
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('optionalDependencies are not supported');
  });

  it('rejects invalid config schema declarations', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);

    manifest.config = {
      fields: {
        'bad/key': {
          type: 'string',
          writableLayers: ['user', 'project'],
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('config key "bad/key" is not valid');

    manifest.config = {
      fields: {
        'bad-key': {
          type: 'string',
          writableLayers: ['user', 'project'],
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('config key "bad-key" is not valid');

    manifest.config = {
      fields: {
        mode: {
          type: 'string',
          writableLayers: ['user', 'project'],
          choices: {
            allowCustom: false,
            presets: [{ id: 'safe', title: 'Safe', value: 'safe' }],
          },
          default: 'fast',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('Expected a declared preset value');

    manifest.config = {
      fields: {
        limit: {
          type: 'number',
          writableLayers: ['user', 'project'],
          validation: { minimum: 10, maximum: 1 },
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('minimum must be less than or equal to maximum');

    manifest.config = {
      fields: {
        text: {
          type: 'string',
          writableLayers: ['user', 'project'],
          min: 1,
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('must NOT have additional properties');
  });

  it('accepts config presentation and preserves the no-presentation contract', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    const fields = {
      mode: {
        type: 'string',
        writableLayers: ['user', 'project'],
        choices: {
          allowCustom: false,
          presets: [
            { id: 'safe', title: 'Safe', value: 'safe' },
            { id: 'fast', title: 'Fast', value: 'fast' },
          ],
        },
        default: 'safe',
      },
      limit: {
        type: 'number',
        writableLayers: ['user', 'project'],
        validation: { minimum: 1, maximum: 20 },
      },
      trace: {
        type: 'boolean',
        writableLayers: ['user', 'project'],
      },
      token: {
        type: 'string',
        writableLayers: ['user', 'project'],
        sensitive: true,
      },
      rules: {
        type: 'string',
        writableLayers: ['user', 'project'],
        validation: { format: 'path' },
      },
    };

    manifest.config = { fields };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        config: {
          fields,
          presentation: undefined,
        },
      },
    });

    manifest.config = {
      fields,
      presentation: {
        groups: [
          {
            id: 'general',
            title: 'General',
            description: 'Common settings.',
            fields: ['mode', 'limit'],
          },
        ],
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        config: manifest.config,
      },
    });
  });

  it('rejects invalid config presentation declarations', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    const fields = {
      mode: { type: 'string', writableLayers: ['user', 'project'] },
      limit: { type: 'number', writableLayers: ['user', 'project'] },
    };
    const invalidCases = [
      {
        presentation: { unknown: true },
        error: '/config/presentation must NOT have additional properties',
      },
      {
        presentation: {
          groups: [{ id: 'general', title: 'General', fields: ['missing'] }],
        },
        error: 'unknown config key "missing"',
      },
      {
        presentation: {
          groups: [{ id: ' ', title: 'General', fields: [] }],
        },
        error: 'config.presentation.groups[0].id: expected a non-empty string',
      },
      {
        presentation: {
          groups: [
            { id: 'general', title: 'General', fields: ['mode'] },
            { id: 'general', title: 'Other', fields: ['limit'] },
          ],
        },
        error: 'duplicate group id "general"',
      },
      {
        presentation: {
          groups: [
            { id: 'general', title: 'General', fields: ['mode'] },
            { id: 'advanced', title: 'Advanced', fields: ['mode'] },
          ],
        },
        error: 'config key "mode" is assigned to more than one group',
      },
      { presentation: { fields: {} }, error: 'must NOT have additional properties' },
      { presentation: { presets: [] }, error: 'must NOT have additional properties' },
    ];

    for (const invalidCase of invalidCases) {
      manifest.config = {
        fields,
        presentation: invalidCase.presentation,
      };
      await writeFixturePluginManifest(repoRoot, manifest);
      await expect(readPluginManifest(pluginRoot)).rejects.toThrow(invalidCase.error);
    }
  });

  it('rejects invalid dynamic artifact target declarations', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    manifest.config = {
      fields: {
        enabled: {
          type: 'boolean',
          writableLayers: ['user', 'project'],
          default: true,
        },
        model: {
          type: 'string',
          writableLayers: ['user', 'project'],
          default: 'gpt-5.4-mini',
        },
        userOnly: {
          type: 'string',
          writableLayers: ['user'],
        },
      },
    };

    const validTarget = {
      id: 'lightweight-instruction',
      platform: 'codex',
      scopes: ['user', 'project'],
      target: 'codex.developerInstructionsBlock',
      projectManagedKind: 'instruction',
      states: ['present', 'disabled'],
      refreshKeys: ['enabled', 'model'],
      requiresCodexProjectConfig: true,
    };

    manifest.artifacts = {
      targets: [validTarget],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        artifacts: {
          targets: [expect.objectContaining(validTarget)],
        },
      },
    });

    manifest.artifacts = {
      targets: [{
        id: 'native-codex-skill',
        platform: 'codex',
        scopes: ['user'],
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        states: ['present'],
        refreshKeys: ['model'],
        skillKey: 'native-codex-skill',
      }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'native delivery requires a config field with writableLayers ["user"]',
    );

    manifest.artifacts.targets[0].refreshKeys = ['userOnly'];
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        artifacts: {
          targets: [expect.objectContaining({
            delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          })],
        },
      },
    });

    manifest.artifacts = {
      targets: [{ ...validTarget, target: 'codex.unknown' }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('/artifacts/targets/0/target');

    manifest.artifacts = {
      targets: [{ ...validTarget, states: ['present', 'archived'] }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('/artifacts/targets/0/states/1');

    manifest.artifacts = {
      targets: [{ ...validTarget, refreshKeys: ['missingKey'] }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('unknown config key "missingKey"');

    manifest.artifacts = {
      targets: [{ ...validTarget, projectManagedKind: 'codexRole' }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('/artifacts/targets/0/projectManagedKind');

    manifest.artifacts = {
      targets: [{ ...validTarget, projectManagedKind: 'agent' }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('must map to "instruction"');

    manifest.artifacts = {
      targets: [
        {
          ...validTarget,
          id: 'codex-explorer-role',
          target: 'codex.agentRole',
          projectManagedKind: 'agent',
          states: ['present'],
          refreshKeys: ['model'],
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('must declare a static roleKey');

    manifest.artifacts = {
      targets: [
        {
          id: 'codex-explore-skill',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          projectManagedKind: 'skill',
          states: ['present', 'disabled'],
          refreshKeys: ['model'],
          skillKey: 'codex-explore',
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        artifacts: {
          targets: [expect.objectContaining({
            id: 'codex-explore-skill',
            target: 'codex.skill',
            projectManagedKind: 'skill',
            skillKey: 'codex-explore',
          })],
        },
      },
    });

    manifest.artifacts = {
      targets: [
        {
          id: 'codex-explore-skill',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.skill',
          delivery: { mode: 'aw-extension' },
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: ['model'],
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('must declare a static skillKey');

    manifest.artifacts = {
      targets: [
        {
          ...validTarget,
          roleKey: 'should-not-be-here',
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('roleKey is only supported for codex.agentRole targets');

    manifest.artifacts = {
      targets: [
        {
          ...validTarget,
          skillKey: 'should-not-be-here',
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('skillKey is only supported for skill targets');

    manifest.artifacts = {
      targets: [
        validTarget,
        {
          ...validTarget,
          scopes: ['project'],
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('duplicate artifact id + target');

    manifest.artifacts = {
      targets: [
        {
          id: 'claude-skill-one',
          platform: 'claude',
          scopes: ['project'],
          target: 'claude.skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'codex-explore',
        },
        {
          id: 'claude-skill-two',
          platform: 'claude',
          scopes: ['user', 'project'],
          target: 'claude.skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'codex-explore',
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'duplicate dynamic skill owner "claude:project:codex-explore"',
    );

    await fs.ensureDir(path.join(pluginRoot, 'skills', 'codex-explore', 'base'));
    manifest.artifacts = {
      targets: [{
        id: 'codex-explore-skill',
        platform: 'codex',
        scopes: ['project'],
        target: 'codex.skill',
        delivery: { mode: 'aw-extension' },
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'codex-explore',
        sourceDirs: ['./skills/codex-explore/base'],
      }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'must include "./skills/codex-explore" so README.md is published',
    );

    await fs.ensureDir(path.join(pluginRoot, 'skills', 'codex-explore', 'evals'));
    manifest.artifacts.targets[0]!.sourceDirs = [
      './skills/codex-explore',
      './skills/codex-explore/evals',
    ];
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'points inside an author-only Skill directory',
    );

    await fs.ensureDir(path.join(pluginRoot, 'skills', 'codex-explore', 'real'));
    await fs.symlink('real', path.join(pluginRoot, 'skills', 'codex-explore', 'source-link'));
    manifest.artifacts = {
      targets: [{
        id: 'codex-explore-skill',
        platform: 'codex',
        scopes: ['project'],
        target: 'codex.skill',
        delivery: { mode: 'aw-extension' },
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'codex-explore',
        sourceDirs: [
          './skills/codex-explore',
          './skills/codex-explore/source-link',
        ],
      }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'Invalid plugin input tree: symbolic links are not supported (skills/codex-explore/source-link).',
    );
  });

  it('rejects unsupported platform build fields and apps declarations', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);

    manifest.marketplace = createMarketplaceWithProducts(['CODEX']);
    manifest.buildConfig = {
      fileRules: {
        claude: {
          include: ['docs/**'],
          exclude: [],
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'Invalid plugin "git-commit": buildConfig.fileRules.claude requires CLAUDE support, but marketplace.policy.products=[CODEX].',
    );

    manifest.buildConfig = {
      manifestOverrides: {
        claude: {
          userConfig: {
            theme: 'dark',
          },
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'Invalid plugin "git-commit": buildConfig.manifestOverrides.claude requires CLAUDE support, but marketplace.policy.products=[CODEX].',
    );

    manifest.marketplace = createMarketplaceWithProducts(['CLAUDE']);
    manifest.buildConfig = undefined;
    manifest.apps = './.app.json';
    await fs.writeJson(path.join(pluginRoot, '.app.json'), { apps: {} }, { spaces: 2 });
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'Invalid plugin "git-commit": apps requires CODEX support, but marketplace.policy.products=[CLAUDE].',
    );
  });

  it('rejects unsupported Codex artifact targets and keeps dual-platform targets valid', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    const validTarget = {
      id: 'lightweight-instruction',
      platform: 'codex',
      scopes: ['user', 'project'],
      target: 'codex.developerInstructionsBlock',
      projectManagedKind: 'instruction',
      states: ['present', 'disabled'],
      refreshKeys: ['enabled', 'model'],
      requiresCodexProjectConfig: true,
    };

    manifest.marketplace = createMarketplaceWithProducts(['CLAUDE']);
    delete manifest.apps;
    await fs.remove(path.join(pluginRoot, '.app.json'));
    manifest.config = {
      fields: {
        enabled: {
          type: 'boolean',
          writableLayers: ['user', 'project'],
          default: true,
        },
        model: {
          type: 'string',
          writableLayers: ['user', 'project'],
          default: 'gpt-5.4-mini',
        },
      },
    };
    manifest.artifacts = {
      targets: [validTarget],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'Invalid plugin "git-commit": artifacts.targets[0].platform requires CODEX support, but marketplace.policy.products=[CLAUDE].',
    );

    manifest.marketplace = createMarketplaceWithProducts(['CODEX', 'CLAUDE']);
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        artifacts: {
          targets: [expect.objectContaining(validTarget)],
        },
      },
    });
  });

  it('scans Node import contracts for relative closures and undeclared bare specifiers', () => {
    expect(
      scanNodeImportContract({
        entryFiles: ['./scripts/lifecycle.mjs'],
        files: {
          'scripts/lifecycle.mjs': [
            'import "./shared.mjs";',
            'export { value } from "./value.js";',
            'const util = require("./util.cjs");',
            'const resolved = require.resolve("./resolved.cjs");',
            'await import("./lazy.mjs");',
          ].join('\n'),
          'scripts/shared.mjs': 'export const shared = true;',
          'scripts/value.js': 'export const value = 1;',
          'scripts/util.cjs': 'module.exports = require("node:fs");',
          'scripts/resolved.cjs': 'module.exports = true;',
          'scripts/lazy.mjs': 'export default true;',
        },
      }),
    ).toEqual({
      files: [
        'scripts/lazy.mjs',
        'scripts/lifecycle.mjs',
        'scripts/resolved.cjs',
        'scripts/shared.mjs',
        'scripts/util.cjs',
        'scripts/value.js',
      ],
      bareSpecifiers: [],
      errors: [],
    });

    expect(
      scanNodeImportContract({
        entryFiles: ['./scripts/lifecycle.mjs'],
        dependencies: ['chalk'],
        devDependencies: ['vitest'],
        files: {
          'scripts/lifecycle.mjs': [
            'import chalk from "chalk";',
            'import test from "vitest";',
            'import "./escape.mjs";',
          ].join('\n'),
          'scripts/escape.mjs': 'import "../../outside.mjs";',
          'outside.mjs': 'export {};',
        },
      }),
    ).toMatchObject({
      files: ['scripts/escape.mjs', 'scripts/lifecycle.mjs'],
      bareSpecifiers: ['chalk', 'vitest'],
      errors: [
        'Runtime import "vitest" from "scripts/lifecycle.mjs" uses dev dependency "vitest".',
        'Relative import "../../outside.mjs" from "scripts/escape.mjs" escapes the plugin root.',
      ],
    });

    expect(
      scanNodeImportContract({
        entryFiles: ['./scripts/lifecycle.mjs'],
        files: {
          'scripts/lifecycle.mjs': 'import leftPad from "left-pad";',
        },
      }).errors,
    ).toEqual([
      'Runtime import "left-pad" from "scripts/lifecycle.mjs" is not declared in dependencies.',
    ]);

    expect(
      scanNodeImportContract({
        entryFiles: ['./scripts/lifecycle.mjs'],
        files: {
          'scripts/lifecycle.mjs': 'require.resolve("left-pad");',
        },
      }).errors,
    ).toEqual([
      'Runtime import "left-pad" from "scripts/lifecycle.mjs" is not declared in dependencies.',
    ]);
  });

  it('includes static JSON imports as runtime leaves and preserves relative import failures', () => {
    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.cjs'],
      files: {
        'scripts/entry.cjs': [
          'const explicit = require("./config.json");',
          'module.exports = require("./config") ?? explicit;',
        ].join('\n'),
        'scripts/config.json': '{',
      },
    })).toEqual({
      files: ['scripts/config.json', 'scripts/entry.cjs'],
      bareSpecifiers: [],
      errors: [],
    });

    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.cjs'],
      files: {
        'scripts/entry.cjs': [
          'require("./missing.json");',
          'require("../../outside.json");',
        ].join('\n'),
      },
      filePaths: ['scripts/entry.cjs'],
    }).errors).toEqual([
      'Unable to resolve relative import "./missing.json" from "scripts/entry.cjs".',
      'Relative import "../../outside.json" from "scripts/entry.cjs" escapes the plugin root.',
    ]);
  });

  it('uses CommonJS completion but requires explicit ESM relative paths', () => {
    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.cjs', 'scripts/entry.mjs'],
      files: {
        'scripts/entry.cjs': [
          'require("./required");',
          'require.resolve("./resolved");',
          'module.require("./module-required");',
          'require("./explicit.mjs");',
          'require("./explicit.cjs");',
        ].join('\n'),
        'scripts/entry.mjs': [
          'import "./imported";',
          'export * from "./exported";',
          'await import("./dynamic");',
          'import "./explicit-esm.mjs";',
          'export * from "./explicit-esm.js";',
          'await import("./explicit-esm.json", { with: { type: "json" } });',
        ].join('\n'),
        'scripts/required.mjs': 'export default "wrong";',
        'scripts/resolved.mjs': 'export default "wrong";',
        'scripts/module-required.mjs': 'export default "wrong";',
        'scripts/explicit.mjs': 'export default true;',
        'scripts/explicit.cjs': 'module.exports = true;',
        'scripts/explicit-esm.mjs': 'export default true;',
        'scripts/explicit-esm.js': 'export default true;',
        'scripts/imported.mjs': 'export default true;',
        'scripts/exported.mjs': 'export default true;',
        'scripts/dynamic.mjs': 'export default true;',
      },
      filePaths: [
        'scripts/required.json',
        'scripts/resolved.json',
        'scripts/module-required.json',
        'scripts/explicit-esm.json',
        'scripts/imported.json',
        'scripts/exported.json',
        'scripts/dynamic.json',
      ],
    })).toEqual({
      files: [
        'scripts/entry.cjs',
        'scripts/entry.mjs',
        'scripts/explicit-esm.js',
        'scripts/explicit-esm.json',
        'scripts/explicit-esm.mjs',
        'scripts/explicit.cjs',
        'scripts/explicit.mjs',
        'scripts/module-required.json',
        'scripts/required.json',
        'scripts/resolved.json',
      ],
      bareSpecifiers: [],
      errors: [
        'Unable to resolve relative import "./imported" from "scripts/entry.mjs".',
        'Unable to resolve relative import "./exported" from "scripts/entry.mjs".',
        'Unable to resolve relative import "./dynamic" from "scripts/entry.mjs".',
      ],
    });

    expect(scanNodeImportContract({
      entryFiles: ['scripts/native.cjs'],
      files: {
        'scripts/native.cjs': 'require("./binding");',
      },
      filePaths: ['scripts/binding.node'],
    })).toEqual({
      files: ['scripts/native.cjs'],
      bareSpecifiers: [],
      errors: [
        'Unsupported runtime import file "scripts/binding.node" resolved from "./binding" in "scripts/native.cjs".',
      ],
    });
  });

  it('resolves CommonJS directories through package main and index fallback', () => {
    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.cjs'],
      files: {
        'scripts/entry.cjs': [
          'require("./required");',
          'require.resolve("./resolved");',
          'module.require("./fallback");',
          'require("./dot");',
          'require("./feature");',
        ].join('\n'),
        'scripts/required/package.json': JSON.stringify({ main: 'lib/main.cjs' }),
        'scripts/required/lib/main.cjs': 'module.exports = true;',
        'scripts/resolved/package.json': JSON.stringify({ main: './index.json' }),
        'scripts/resolved/index.json': '{}',
        'scripts/fallback/package.json': JSON.stringify({ name: 'fallback' }),
        'scripts/fallback/index.js': 'module.exports = true;',
        'scripts/dot/package.json': JSON.stringify({ main: '.' }),
        'scripts/dot/index.js': 'module.exports = true;',
        'scripts/feature/package.json': JSON.stringify({ main: '../shared.cjs' }),
        'scripts/shared.cjs': 'module.exports = true;',
      },
    })).toEqual({
      files: [
        'scripts/dot/index.js',
        'scripts/dot/package.json',
        'scripts/entry.cjs',
        'scripts/fallback/index.js',
        'scripts/fallback/package.json',
        'scripts/feature/package.json',
        'scripts/required/lib/main.cjs',
        'scripts/required/package.json',
        'scripts/resolved/index.json',
        'scripts/resolved/package.json',
        'scripts/shared.cjs',
      ],
      bareSpecifiers: [],
      errors: [],
    });

    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.mjs'],
      files: {
        'scripts/entry.mjs': 'import "./helper";',
        'scripts/helper/package.json': JSON.stringify({ main: 'index.js' }),
        'scripts/helper/index.js': 'export default true;',
      },
    }).errors).toEqual([
      'Unable to resolve relative import "./helper" from "scripts/entry.mjs".',
    ]);
  });

  it('does not read a nested package manifest when a CommonJS main targets a directory', () => {
    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.cjs'],
      files: {
        'scripts/entry.cjs': 'require("./helper");',
        'scripts/helper/package.json': JSON.stringify({ main: 'nested' }),
        'scripts/helper/nested/package.json': JSON.stringify({ main: 'actual.cjs' }),
        'scripts/helper/nested/actual.cjs': 'module.exports = true;',
      },
    }).errors).toEqual([
      'Unable to resolve relative import "./helper" from "scripts/entry.cjs".',
    ]);
  });

  it('fails closed for invalid, escaping, and native CommonJS directory entries', () => {
    const scan = (packageJson: string, extraFiles: Record<string, string> = {}) => (
      scanNodeImportContract({
        entryFiles: ['scripts/entry.cjs'],
        files: {
          'scripts/entry.cjs': 'require("./helper");',
          'scripts/helper/package.json': packageJson,
          ...extraFiles,
        },
      }).errors
    );

    expect(scan('{')).toEqual([
      'Invalid CommonJS package manifest "scripts/helper/package.json" resolved from "./helper" in "scripts/entry.cjs".',
    ]);
    expect(scan(JSON.stringify({ main: 42 }))).toEqual([
      'Invalid CommonJS package main in "scripts/helper/package.json" resolved from "./helper" in "scripts/entry.cjs".',
    ]);
    expect(scan(JSON.stringify({ main: '../../../outside.cjs' }))).toEqual([
      'CommonJS package main "../../../outside.cjs" in "scripts/helper/package.json" escapes the plugin root.',
    ]);
    expect(scan(JSON.stringify({ main: 'https://example.test/helper.cjs' }))).toEqual([
      'Invalid CommonJS package main in "scripts/helper/package.json" resolved from "./helper" in "scripts/entry.cjs".',
    ]);
    expect(scan(JSON.stringify({ main: 'binding' }), {
      'scripts/helper/binding.node': '',
    })).toEqual([
      'Unsupported runtime import file "scripts/helper/binding.node" resolved from "./helper" in "scripts/entry.cjs".',
    ]);
  });

  it('accepts only authoritative Node builtin specifiers without dependency declarations', () => {
    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.mjs'],
      files: {
        'scripts/entry.mjs': [
          'require("fs");',
          'require("fs/promises");',
          'require("node:fs");',
          'require("fs/not-a-builtin");',
          'require("node:fs/not-a-builtin");',
        ].join('\n'),
      },
    })).toEqual({
      files: ['scripts/entry.mjs'],
      bareSpecifiers: ['fs'],
      errors: [
        'Runtime import "fs/not-a-builtin" from "scripts/entry.mjs" is not declared in dependencies.',
        'Unsupported import specifier "node:fs/not-a-builtin" from "scripts/entry.mjs".',
      ],
    });
  });

  it('scans JavaScript imports through comments and template expressions without regex false positives', () => {
    const source = [
      'const fixture = \'import "../storage/store";\';',
      'const template = `require("../storage/template")`;',
      'const expression = `${import(/* webpackIgnore: true */ "./template-lazy.mjs", { with: { type: "json" } })}`;',
      '// export { value } from "../storage/comment";',
      '/* await import("../storage/block-comment"); */',
      'const pattern = /require("..\\/storage\\/regex")|import("..\\/storage\\/regex-lazy")/gu;',
      'const resolveFixture = \'require.resolve("../storage/resolve-string")\';',
      '// require.resolve("../storage/resolve-comment");',
      'const resolvePattern = /require\\.resolve\("\.\.\\/storage\\/resolve-regex"\)/gu;',
      'if (fixture) /require("ghost-control")/u.test(fixture);',
      '{ void fixture; } /import("ghost-block")/u.test(fixture);',
      'import /* side effect */ "./real.mjs";',
      'import value /* binding */ from /* source */ "./value.mjs";',
      'export { named } /* binding */ from /* source */ "./named.mjs";',
      'const lazy = import /* call */ ("./lazy.mjs", { with: { type: "json" } });',
      'const helper = require(/* dependency */ "./helper.cjs");',
      'const resolved = require.resolve(/* dependency */ "./resolved.cjs");',
      'const quotient = fixture / require("./division.cjs");',
      'count++ / require("./factor.cjs");',
      'count-- / require("./decrement.cjs");',
    ].join('\n');

    expect(scanJavaScriptImportSpecifiers(source)).toEqual(expect.arrayContaining([
      { kind: 'dynamic-import', specifier: './template-lazy.mjs' },
      { kind: 'import', specifier: './real.mjs' },
      { kind: 'import', specifier: './value.mjs' },
      { kind: 'export', specifier: './named.mjs' },
      { kind: 'dynamic-import', specifier: './lazy.mjs' },
      { kind: 'require', specifier: './helper.cjs' },
      { kind: 'require-resolve', specifier: './resolved.cjs' },
      { kind: 'require', specifier: './division.cjs' },
      { kind: 'require', specifier: './factor.cjs' },
      { kind: 'require', specifier: './decrement.cjs' },
    ]));
    expect(scanJavaScriptImportSpecifiers(source)).toHaveLength(10);

    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.mjs'],
      files: {
        'scripts/entry.mjs': [
          'const inside = `${import("./inside.mjs")}`;',
          'const escaped = require(/* boundary */ "../../outside.cjs");',
          'const resolvedEscape = require.resolve("../../resolved-outside.cjs");',
          'const ignored = /import(".\\/missing.mjs")/u;',
        ].join('\n'),
        'scripts/inside.mjs': 'export default true;',
      },
    })).toEqual({
      files: ['scripts/entry.mjs', 'scripts/inside.mjs'],
      bareSpecifiers: [],
      errors: [
        'Relative import "../../outside.cjs" from "scripts/entry.mjs" escapes the plugin root.',
        'Relative import "../../resolved-outside.cjs" from "scripts/entry.mjs" escapes the plugin root.',
      ],
    });
  });

  it('scans static template import specifiers and rejects interpolated template specifiers', () => {
    const source = [
      'const lazy = import(`./helper\\x2emjs`);',
      'const dependency = require(`ya\\u006dl`);',
      'const resolved = require.resolve(`./resolved\\u002ecjs`);',
      'const escaped = require.resolve(`../../outside.cjs`);',
    ].join('\n');

    expect(scanJavaScriptImportSpecifiers(source)).toEqual([
      { kind: 'dynamic-import', specifier: './helper.mjs' },
      { kind: 'require', specifier: 'yaml' },
      { kind: 'require-resolve', specifier: './resolved.cjs' },
      { kind: 'require-resolve', specifier: '../../outside.cjs' },
    ]);
    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.mjs'],
      dependencies: ['yaml'],
      files: {
        'scripts/entry.mjs': [
          source,
          'const dynamicDependency = require(`yaml-${variant}`);',
          'const dynamicResolved = require.resolve(`../../outside-${target}.cjs`);',
          'await import(`./locale-${locale}.mjs`);',
        ].join('\n'),
        'scripts/helper.mjs': 'export default true;',
        'scripts/resolved.cjs': 'module.exports = true;',
      },
    })).toEqual({
      files: ['scripts/entry.mjs', 'scripts/helper.mjs', 'scripts/resolved.cjs'],
      bareSpecifiers: ['yaml'],
      errors: [
        'Relative import "../../outside.cjs" from "scripts/entry.mjs" escapes the plugin root.',
        'Dynamic require specifier in "scripts/entry.mjs" is not supported.',
        'Dynamic require.resolve specifier in "scripts/entry.mjs" is not supported.',
        'Dynamic import specifier in "scripts/entry.mjs" is not supported.',
      ],
    });
  });

  it('rejects every non-literal require and dynamic import specifier', () => {
    const source = [
      'const required = require(packageName);',
      'const partiallyRequired = require("yaml/" + locale);',
      'const resolved = require.resolve(resolveTarget());',
      'const partiallyResolved = require.resolve("./locale-" + locale + ".cjs");',
      'const imported = import(importTarget);',
      'const partiallyImported = import("./locale-" + locale + ".mjs");',
    ].join('\n');
    expect(scanJavaScriptImportSpecifiers(source)).toEqual([
      { kind: 'require', specifier: '', dynamic: true },
      { kind: 'require', specifier: '', dynamic: true },
      { kind: 'require-resolve', specifier: '', dynamic: true },
      { kind: 'require-resolve', specifier: '', dynamic: true },
      { kind: 'dynamic-import', specifier: '', dynamic: true },
      { kind: 'dynamic-import', specifier: '', dynamic: true },
    ]);
    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.mjs'],
      files: {
        'scripts/entry.mjs': source,
      },
    })).toEqual({
      files: ['scripts/entry.mjs'],
      bareSpecifiers: [],
      errors: [
        'Dynamic require specifier in "scripts/entry.mjs" is not supported.',
        'Dynamic require specifier in "scripts/entry.mjs" is not supported.',
        'Dynamic require.resolve specifier in "scripts/entry.mjs" is not supported.',
        'Dynamic require.resolve specifier in "scripts/entry.mjs" is not supported.',
        'Dynamic import specifier in "scripts/entry.mjs" is not supported.',
        'Dynamic import specifier in "scripts/entry.mjs" is not supported.',
      ],
    });
  });

  it('scans direct CommonJS module.require calls without accepting object methods', () => {
    const source = [
      'const helper = module.require("./helper.cjs");',
      'const dependency = module.require(`yaml`);',
      'module.require("../../outside.cjs");',
      'module.require(packageName);',
      'loader.require("ignored-package");',
    ].join('\n');

    expect(scanJavaScriptImportSpecifiers(source)).toEqual([
      { kind: 'require', specifier: './helper.cjs' },
      { kind: 'require', specifier: 'yaml' },
      { kind: 'require', specifier: '../../outside.cjs' },
      { kind: 'require', specifier: '', dynamic: true },
    ]);
    expect(scanNodeImportContract({
      entryFiles: ['scripts/entry.cjs'],
      dependencies: ['yaml'],
      files: {
        'scripts/entry.cjs': source,
        'scripts/helper.cjs': 'module.exports = module.require(`./nested.cjs`);',
        'scripts/nested.cjs': 'module.exports = true;',
      },
    })).toEqual({
      files: ['scripts/entry.cjs', 'scripts/helper.cjs', 'scripts/nested.cjs'],
      bareSpecifiers: ['yaml'],
      errors: [
        'Relative import "../../outside.cjs" from "scripts/entry.cjs" escapes the plugin root.',
        'Dynamic require specifier in "scripts/entry.cjs" is not supported.',
      ],
    });
  });

  it('rejects undeclared default MCP manifest', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    delete manifest.mcpServers;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, '.mcp.json'), { servers: [] }, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'found .mcp.json but missing "mcpServers" declaration',
    );
  });

  it('rejects undeclared default app manifest', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    delete manifest.apps;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, '.app.json'), { apps: [] }, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'found .app.json but missing "apps" declaration',
    );
  });

  it('allows templated JSON native assets at source time but validates non-template JSON shape', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.mcpServers = './.mcp.json';
    manifest.apps = './.app.json';
    manifest.buildConfig = {
      templates: {
        include: ['.mcp.json', '.app.json'],
        vars: {
          serverName: { claude: 'claude-server', codex: 'codex-server' },
        },
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeFile(path.join(pluginRoot, '.mcp.json'), '{"mcpServers": {{serverName}}}', 'utf8');
    await fs.writeFile(path.join(pluginRoot, '.app.json'), '{"apps": {{serverName}}}', 'utf8');

    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        mcpServers: './.mcp.json',
        apps: './.app.json',
      },
    });

    delete manifest.buildConfig;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, '.mcp.json'), { mcpServers: [] }, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, '.app.json'), { apps: {} }, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'expected top-level "mcpServers" object',
    );
  });

  it('loads bundle manifests without applying source-only default asset checks', async () => {
    const repoRoot = await makeTempRepo();
    const sourcePluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const bundlePluginRoot = path.join(repoRoot, 'bundle', 'plugins', 'git-commit');
    await fs.ensureDir(path.join(bundlePluginRoot, '.agents-plugin'));
    const manifest = await fs.readJson(
      path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json'),
    );
    delete manifest.skills;
    await fs.writeJson(
      path.join(bundlePluginRoot, '.agents-plugin', 'plugin.json'),
      manifest,
      { spaces: 2 },
    );
    await fs.ensureDir(path.join(bundlePluginRoot, 'skills'));

    await expect(readPluginManifest(bundlePluginRoot)).rejects.toThrow(
      'found skills but missing "skills" declaration',
    );
    await expect(
      readPluginManifest(bundlePluginRoot, { mode: 'bundle' }),
    ).resolves.toMatchObject({
      manifest: {
        name: 'git-commit',
      },
    });
  });

  it('requires a non-empty native inventory for portable plugins in source and bundle modes', async () => {
    const repoRoot = await makeTempRepo();
    const fixtureManifest = await readFixturePluginManifest(repoRoot);
    const pluginRoot = path.join(repoRoot, 'portable-inventory');
    const manifest = {
      schemaVersion: 3,
      name: 'portable-inventory',
      version: '1.0.0',
      description: 'Portable inventory fixture.',
      marketplace: fixtureManifest.marketplace,
      skills: './skills',
      distributions: { agentSkills: { skills: './portable-skills' } },
    };
    await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
    await fs.ensureDir(path.join(pluginRoot, 'skills'));
    await fs.ensureDir(path.join(pluginRoot, 'portable-skills', 'portable'));
    await fs.writeFile(
      path.join(pluginRoot, 'portable-skills', 'portable', 'SKILL.md'),
      '---\nname: portable\ndescription: Portable fixture.\n---\n',
    );
    await fs.writeFile(path.join(pluginRoot, 'portable-skills', 'portable', 'README.md'), '# Portable\n');
    await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('portable-only plugins');
    await expect(readPluginManifest(pluginRoot, { mode: 'bundle' })).rejects.toThrow('portable-only plugins');

    Object.assign(manifest, {
      artifacts: {
        targets: [{
          id: 'disabled-native',
          platform: 'codex',
          scopes: ['user'],
          target: 'codex.developerInstructionsBlock',
          states: ['disabled'],
          refreshKeys: [],
        }],
      },
    });
    await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('portable-only plugins');
    await expect(readPluginManifest(pluginRoot, { mode: 'bundle' })).rejects.toThrow('portable-only plugins');

    manifest.artifacts.targets[0].states = ['present', 'disabled'];
    await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({ manifest: { name: 'portable-inventory' } });
    await expect(readPluginManifest(pluginRoot, { mode: 'bundle' }))
      .resolves.toMatchObject({ manifest: { name: 'portable-inventory' } });
    delete (manifest as { artifacts?: unknown }).artifacts;

    delete (manifest as { skills?: string }).skills;
    await fs.remove(path.join(pluginRoot, 'skills'));
    Object.assign(manifest, { slashCommands: './commands' });
    await fs.ensureDir(path.join(pluginRoot, 'commands'));
    await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('must contain at least one root "*.md" command file');
    await expect(readPluginManifest(pluginRoot, { mode: 'bundle' })).rejects.toThrow('portable-only plugins');

    delete (manifest as { slashCommands?: string }).slashCommands;
    Object.assign(manifest, { mcpServers: './mcp.json', apps: './apps.json' });
    await fs.writeJson(path.join(pluginRoot, 'mcp.json'), { mcpServers: {} });
    await fs.writeJson(path.join(pluginRoot, 'apps.json'), { apps: {} });
    await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('portable-only plugins');
    await expect(readPluginManifest(pluginRoot, { mode: 'bundle' })).rejects.toThrow('portable-only plugins');

    delete (manifest as { mcpServers?: string }).mcpServers;
    delete (manifest as { apps?: string }).apps;
    Object.assign(manifest, { skills: './skills' });
    await fs.ensureDir(path.join(pluginRoot, 'skills', 'native'));
    await fs.writeFile(
      path.join(pluginRoot, 'skills', 'native', 'SKILL.md'),
      '---\nname: native\ndescription: Native fixture.\n---\n',
    );
    await fs.writeFile(path.join(pluginRoot, 'skills', 'native', 'README.md'), '# Native\n');
    await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({ manifest: { name: 'portable-inventory' } });
    await expect(readPluginManifest(pluginRoot, { mode: 'bundle' }))
      .resolves.toMatchObject({ manifest: { name: 'portable-inventory' } });

    await fs.writeFile(path.join(pluginRoot, 'portable-skills', 'README.md'), '# Invalid root file\n');
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('直接子节点必须是普通目录');
    await fs.remove(path.join(pluginRoot, 'portable-skills', 'README.md'));
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({ manifest: { name: 'portable-inventory' } });
  });

  it('accepts native hooks and public session_start shared matcher values', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.hooks = [
      {
        event: 'session_start',
        matcher: 'startup|resume|clear',
        command: 'echo shared session start',
      },
    ];
    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo claude notification',
        },
        {
          event: 'Stop',
          command: 'echo claude stop',
        },
      ],
      codex: [
        {
          event: 'UserPromptSubmit',
          command: 'echo codex prompt',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        extensions: {
          hooks: [
            {
              event: 'session_start',
              matcher: 'startup|resume|clear',
              command: 'echo shared session start',
            },
          ],
          nativeHooks: {
            claude: [
              {
                event: 'Notification',
                matcher: '*',
                command: 'echo claude notification',
              },
              {
                event: 'Stop',
                command: 'echo claude stop',
              },
            ],
            codex: [
              {
                event: 'UserPromptSubmit',
                command: 'echo codex prompt',
              },
            ],
          },
        },
      },
    });
  });

  it('rejects removed public session_stop and invalid public session_start matchers', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.hooks = [
      {
        event: 'session_stop',
        command: 'echo stop',
      },
    ];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'public event "session_stop" has been removed',
    );

    manifest.extensions.hooks = [
      {
        event: 'before_tool',
        matcher: 'Bash',
        command: 'echo shared',
        agentOverrides: {
          codex: {
            event: 'session_stop',
            command: 'echo codex stop',
          },
        },
      },
    ];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'public event "session_stop" has been removed',
    );

    manifest.extensions.hooks = [
      {
        event: 'session_start',
        matcher: 'compact',
        command: 'echo invalid compact',
      },
    ];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'public session_start only allows startup, resume, clear',
    );

    manifest.extensions.hooks[0].matcher = '*';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'public session_start only allows startup, resume, clear',
    );
  });

  it('rejects invalid native hook platform keys, matcherless matcher, extra fields, and platform duplicates', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.nativeHooks = {
      openai: [],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      '/extensions/nativeHooks must NOT have additional properties',
    );

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'UserPromptSubmit',
          matcher: '*',
          command: 'echo codex prompt',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'does not allow matcher',
    );

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'Stop',
          matcher: '*',
          command: 'echo codex stop',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'does not allow matcher',
    );

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'PreToolUse',
          matcher: '[',
          command: 'echo invalid regex',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'valid Codex matcher pattern',
    );

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'PreToolUse',
          matcher: 'Write(?=File)',
          command: 'echo unsupported lookahead',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'valid Codex matcher pattern',
    );

    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo notify',
          description: 'old field',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      '/extensions/nativeHooks/claude/0 must NOT have additional properties',
    );

    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo notify',
          agentOverrides: {
            codex: null,
          },
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      '/extensions/nativeHooks/claude/0 must NOT have additional properties',
    );

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'Notification',
          command: 'echo wrong platform event',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unsupported codex hook event "Notification"',
    );

    manifest.extensions.hooks = [
      {
        event: 'before_tool',
        matcher: 'Bash',
        command: 'echo duplicate',
      },
    ];
    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          command: 'echo duplicate',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'duplicate codex hook',
    );
  });

  it('rejects unsupported native hooks and non-empty agent overrides, but allows empty or null unsupported overrides', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.marketplace = createMarketplaceWithProducts(['CLAUDE']);
    delete manifest.apps;
    await fs.remove(path.join(pluginRoot, '.app.json'));
    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'UserPromptSubmit',
          command: 'echo codex prompt',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'Invalid plugin "git-commit": extensions.nativeHooks.codex requires CODEX support, but marketplace.policy.products=[CLAUDE].',
    );

    manifest.extensions.nativeHooks = undefined;
    manifest.extensions.instructions = [
      {
        name: 'commit-policy',
        title: '提交规范',
        content: '保持提交规范。',
        agentOverrides: {
          codex: {
            title: 'Codex 提交规范',
          },
        },
      },
    ];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'Invalid plugin "git-commit": extensions.instructions[0].agentOverrides.codex requires CODEX support, but marketplace.policy.products=[CLAUDE].',
    );

    manifest.extensions.instructions[0].agentOverrides = {
      codex: {},
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        extensions: {
          instructions: [
            {
              name: 'commit-policy',
              agentOverrides: {
                codex: {},
              },
            },
          ],
        },
      },
    });

    manifest.extensions.instructions[0].agentOverrides = {
      codex: null,
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        extensions: {
          instructions: [
            {
              name: 'commit-policy',
              agentOverrides: {
                codex: null,
              },
            },
          ],
        },
      },
    });
  });

  it('accepts Rust-regex-only valid Codex native hook matchers in source manifests', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.nativeHooks = {
      codex: [
        {
          event: 'PreToolUse',
          matcher: '(?i:write)',
          command: 'echo inline flags',
        },
        {
          event: 'PostToolUse',
          matcher: '(?P<tool>Write|Bash)',
          command: 'echo named capture',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        extensions: {
          nativeHooks: {
            codex: [
              {
                event: 'PreToolUse',
                matcher: '(?i:write)',
                command: 'echo inline flags',
              },
              {
                event: 'PostToolUse',
                matcher: '(?P<tool>Write|Bash)',
                command: 'echo named capture',
              },
            ],
          },
        },
      },
    });
  });

  it('accepts every Claude native hook event and enforces the full matcher capability table', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const originalManifest = await fs.readJson(manifestPath);

    for (const event of CLAUDE_NATIVE_HOOK_EVENTS) {
      const manifest = structuredClone(originalManifest);
      manifest.extensions.nativeHooks = {
        claude: [
          {
            event,
            ...(NATIVE_HOOK_EVENT_CONTRACTS.claude[event].matcherAllowed
              ? { matcher: '*' }
              : {}),
            command: `echo ${event}`,
          },
        ],
      };
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
      await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
        manifest: {
          extensions: {
            nativeHooks: {
              claude: [
                {
                  event,
                  command: `echo ${event}`,
                },
              ],
            },
          },
        },
      });
    }

    for (const [event, contract] of Object.entries(NATIVE_HOOK_EVENT_CONTRACTS.claude)) {
      const manifest = structuredClone(originalManifest);
      manifest.extensions.nativeHooks = {
        claude: [
          {
            event,
            matcher: '*',
            command: `echo ${event}`,
          },
        ],
      };
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
      if (contract.matcherAllowed) {
        await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
          manifest: {
            extensions: {
              nativeHooks: {
                claude: [
                  {
                    event,
                    matcher: '*',
                    command: `echo ${event}`,
                  },
                ],
              },
            },
          },
        });
      } else {
        await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
          'does not allow matcher',
        );
      }
    }
  });

  it('accepts the portable public session_start matcher variants', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    for (const matcher of ['startup', 'resume', 'clear', 'startup|resume|clear']) {
      manifest.extensions.hooks = [
        {
          event: 'session_start',
          matcher,
          command: 'echo start',
        },
      ];
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
      await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
        manifest: {
          extensions: {
            hooks: [
              {
                event: 'session_start',
                matcher,
                command: 'echo start',
              },
            ],
          },
        },
      });
    }
  });

});
