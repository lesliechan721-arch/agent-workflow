import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createBundleSourceManifest,
  createPlatformManifestBase,
  readMarketplaceSourceMeta,
  readPluginManifest,
} from '../../src/utils/manifest.js';
import {
  resolveLifecycleScriptForOs,
  scanNodeImportContract,
} from '../../src/utils/plugin-script-contract.js';
import {
  CLAUDE_NATIVE_HOOK_EVENTS,
  NATIVE_HOOK_EVENT_CONTRACTS,
} from '../../src/utils/hooks-contract.js';

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
    expect(plugin.manifest.extensions?.hooks?.[0]).toMatchObject({
      event: 'before_tool',
      matcher: 'Bash',
    });
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
    ).rejects.toThrow('unknown field "claude"');
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
      'unknown field "description"',
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
    delete manifest.skillTriggers;
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
    manifest.skills = './missing-skills';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'skills points to "./missing-skills" but path does not exist',
    );
  });

  it('accepts valid skillTriggers declared against source skills', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: true,
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        skillTriggers: {
          commit: {
            allowInstallOverride: true,
          },
        },
      },
    });
  });

  it('accepts scripts and config manifest contracts and strips dev-only script fields from bundle manifests', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeScriptFixture(pluginRoot);
    manifest.scripts = {
      timeoutMs: 45_000,
      lifecycle: {
        install: './scripts/lifecycle.mjs',
        uninstall: {
          unix: { runner: 'sh', path: './scripts/uninstall.sh' },
          windows: { runner: 'powershell', path: './scripts/uninstall.ps1' },
        },
      },
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
      schema: {
        enableLightweightInstruction: {
          type: 'boolean',
          default: true,
        },
        explorerModel: {
          type: 'string',
          default: 'gpt-5.4-mini',
        },
        modelReasoningEffort: {
          type: 'enum',
          values: ['low', 'medium', 'high', 'xhigh'],
          default: 'medium',
        },
        token: {
          type: 'string',
          title: 'API Token',
          required: true,
          sensitive: true,
        },
        mode: {
          type: 'enum',
          values: ['safe', 'fast'],
          default: 'safe',
        },
        limit: {
          type: 'number',
          min: 1,
          max: 10,
          default: 3,
        },
      },
    };
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
      timeoutMs: 45_000,
      lifecycle: {
        install: {
          default: {
            runner: 'auto',
            path: './scripts/lifecycle.mjs',
          },
        },
      },
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
    expect(plugin.manifest.config?.schema.mode).toMatchObject({
      type: 'enum',
      values: ['safe', 'fast'],
      default: 'safe',
    });

    const bundleManifest = createBundleSourceManifest(plugin);
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
    expect(bundleManifest.config?.schema.token.sensitive).toBe(true);
    expect(bundleManifest.config?.schema.token.title).toBe('API Token');

    const platformManifest = createPlatformManifestBase(plugin) as Record<string, unknown>;
    expect(platformManifest.scripts).toBeUndefined();
    expect(platformManifest.artifacts).toBeUndefined();
    expect(platformManifest.config).toBeUndefined();
  });

  it('resolves lifecycle OS selectors with narrow, wide, and default priority', () => {
    const selector = {
      default: { runner: 'node', path: './scripts/default.mjs' },
      unix: { runner: 'sh', path: './scripts/unix.sh' },
      windows: { runner: 'powershell', path: './scripts/windows.ps1' },
      linux: { runner: 'bash', path: './scripts/linux.sh' },
      darwin: { runner: 'node', path: './scripts/darwin.mjs' },
      win32: { runner: 'cmd', path: './scripts/windows.cmd' },
    } as const;

    expect(resolveLifecycleScriptForOs(selector, 'linux')?.path).toBe('./scripts/linux.sh');
    expect(resolveLifecycleScriptForOs({ unix: selector.unix, default: selector.default }, 'linux')?.path).toBe('./scripts/unix.sh');
    expect(resolveLifecycleScriptForOs({ default: selector.default }, 'linux')?.path).toBe('./scripts/default.mjs');
    expect(resolveLifecycleScriptForOs(selector, 'darwin')?.path).toBe('./scripts/darwin.mjs');
    expect(resolveLifecycleScriptForOs({ unix: selector.unix, default: selector.default }, 'darwin')?.path).toBe('./scripts/unix.sh');
    expect(resolveLifecycleScriptForOs(selector, 'win32')?.path).toBe('./scripts/windows.cmd');
    expect(resolveLifecycleScriptForOs({ windows: selector.windows, default: selector.default }, 'win32')?.path).toBe('./scripts/windows.ps1');
  });

  it('rejects unsafe lifecycle, helper, timeout, and node package script declarations', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    await writeScriptFixture(pluginRoot);

    manifest.scripts = {
      lifecycle: {
        install: {
          linux: { runner: 'deno', path: './scripts/lifecycle.mjs' },
          darwin: { runner: 'node', path: './scripts/lifecycle.mjs' },
          win32: { runner: 'node', path: './scripts/lifecycle.mjs' },
        },
      },
      helpers: {
        config: './scripts/aw-config.cjs',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('unsupported runner "deno"');

    manifest.scripts = {
      lifecycle: {
        install: {
          unix: { runner: 'sh', path: './scripts/uninstall.sh' },
        },
      },
      helpers: {
        config: './scripts/aw-config.cjs',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('no lifecycle entry resolves on win32');

    manifest.scripts = {
      timeoutMs: 999,
      helpers: {
        config: './scripts/aw-config.cjs',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('expected an integer between 1000 and 300000');

    manifest.scripts = {
      lifecycle: {
        install: './scripts/lifecycle.mjs --flag',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('inline command strings are not allowed');

    manifest.scripts = {
      lifecycle: {
        install: {
          linux: { runner: 'auto', path: './scripts/lifecycle.py' },
          darwin: { runner: 'node', path: './scripts/lifecycle.mjs' },
          win32: { runner: 'node', path: './scripts/lifecycle.mjs' },
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('runner "auto" requires');

    manifest.scripts = {
      helpers: {
        config: './scripts/uninstall.sh',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('Node runnable file extension');

    manifest.scripts = {
      node: {
        packageRoot: './scripts',
        build: {
          runner: 'bash',
          path: './scripts/build.mjs',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('expected "node"');

    manifest.scripts = {
      helpers: {
        config: '/tmp/aw-config.mjs',
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('absolute paths are not allowed');
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
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('expected "node"');

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
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('unknown field "unknown"');
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
      schema: {
        'bad/key': {
          type: 'string',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('config key "bad/key" is not valid');

    manifest.config = {
      schema: {
        'bad-key': {
          type: 'string',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('config key "bad-key" is not valid');

    manifest.config = {
      schema: {
        mode: {
          type: 'enum',
          values: ['safe'],
          default: 'fast',
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('enum default must be one of values');

    manifest.config = {
      schema: {
        limit: {
          type: 'number',
          min: 10,
          max: 1,
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('min must be less than or equal to max');

    manifest.config = {
      schema: {
        text: {
          type: 'string',
          min: 1,
        },
      },
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('min/max are only supported for number config');
  });

  it('rejects invalid dynamic artifact target declarations', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifest = await readFixturePluginManifest(repoRoot);
    manifest.config = {
      schema: {
        enabled: {
          type: 'boolean',
          default: true,
        },
        model: {
          type: 'string',
          default: 'gpt-5.4-mini',
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
      targets: [{ ...validTarget, target: 'codex.unknown' }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('unsupported artifact target "codex.unknown"');

    manifest.artifacts = {
      targets: [{ ...validTarget, states: ['present', 'archived'] }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('unsupported artifact state "archived"');

    manifest.artifacts = {
      targets: [{ ...validTarget, refreshKeys: ['missingKey'] }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('unknown config key "missingKey"');

    manifest.artifacts = {
      targets: [{ ...validTarget, projectManagedKind: 'codexRole' }],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('unsupported Codex project managed kind "codexRole"');

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
        validTarget,
        {
          ...validTarget,
          scopes: ['project'],
        },
      ],
    };
    await writeFixturePluginManifest(repoRoot, manifest);
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow('duplicate artifact id + target');
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
      schema: {
        enabled: {
          type: 'boolean',
          default: true,
        },
        model: {
          type: 'string',
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
            'await import("./lazy.mjs");',
          ].join('\n'),
          'scripts/shared.mjs': 'export const shared = true;',
          'scripts/value.js': 'export const value = 1;',
          'scripts/util.cjs': 'module.exports = require("node:fs");',
          'scripts/lazy.mjs': 'export default true;',
        },
      }),
    ).toEqual({
      files: [
        'scripts/lazy.mjs',
        'scripts/lifecycle.mjs',
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
  });

  it('rejects skillTriggers without skills or with unknown fields', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    delete manifest.skills;
    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: true,
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      '"skillTriggers" requires a declared "skills" directory',
    );

    manifest.skills = './skills';
    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: true,
        mode: 'manual',
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unknown field "mode"',
    );

    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: 'yes',
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'allowInstallOverride: expected a boolean',
    );
  });

  it('rejects skillTriggers entries that do not match a source skill directory', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.skillTriggers = {
      missing: {
        allowInstallOverride: true,
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'Invalid skillTriggers.missing: expected a skill directory at "skills/missing".',
    );
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
    delete manifest.skillTriggers;
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

  it('preserves skillTriggers in bundle mode without requiring a source skills directory', async () => {
    const repoRoot = await makeTempRepo();
    const sourcePluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const bundlePluginRoot = path.join(repoRoot, 'bundle', 'plugins', 'git-commit');
    await fs.ensureDir(path.join(bundlePluginRoot, '.agents-plugin'));
    const manifest = await fs.readJson(
      path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json'),
    );
    manifest.skillTriggers = {
      commit: {
        allowInstallOverride: true,
      },
    };
    await fs.writeJson(
      path.join(bundlePluginRoot, '.agents-plugin', 'plugin.json'),
      manifest,
      { spaces: 2 },
    );

    await expect(
      readPluginManifest(bundlePluginRoot, { mode: 'bundle' }),
    ).resolves.toMatchObject({
      manifest: {
        skillTriggers: {
          commit: {
            allowInstallOverride: true,
          },
        },
      },
    });
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
      'extensions.nativeHooks: unknown field "openai"',
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
      'unknown field "description"',
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
      'unknown field "agentOverrides"',
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

  it('rejects unsupported native hooks and non-empty agent overrides, but allows null unsupported overrides', async () => {
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
