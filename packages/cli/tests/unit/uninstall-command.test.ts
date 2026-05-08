import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { uninstallTargetsOnPlatforms } from '../../src/commands/uninstall.js';
import {
  createMinimalPluginInstallStateFixtureBuilder,
} from '../helpers/minimal-plugin-install-state-fixtures.js';
import {
  refreshDependencyIndexDigestsForP2,
  rewriteSanitizedInstallRecordForP2,
} from '../helpers/install-state-projection-fixtures.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';
import type { ResolvedPluginTarget } from '../../src/commands/common.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeBuilder() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-uninstall-'));
  tempDirs.push(root);
  return createMinimalPluginInstallStateFixtureBuilder(root);
}

async function ensureRepoPlugin(
  repoRoot: string,
  pluginName: string,
  options: {
    uninstallScriptFile?: string;
    markerFileName?: string;
  } = {},
): Promise<PluginMeta> {
  const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
  await fs.copy(
    path.join(fixturePath('repo-template'), 'plugins', 'git-commit'),
    pluginRoot,
  );
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  manifest.name = pluginName;
  if (options.uninstallScriptFile) {
    manifest.scripts = {
      lifecycle: {
        uninstall: {
          linux: {
            runner: 'node',
            path: options.uninstallScriptFile.startsWith('./')
              ? options.uninstallScriptFile
              : `./${options.uninstallScriptFile}`,
          },
          darwin: {
            runner: 'node',
            path: options.uninstallScriptFile.startsWith('./')
              ? options.uninstallScriptFile
              : `./${options.uninstallScriptFile}`,
          },
          win32: {
            runner: 'node',
            path: options.uninstallScriptFile.startsWith('./')
              ? options.uninstallScriptFile
              : `./${options.uninstallScriptFile}`,
          },
        },
      },
    };
    const scriptPath = path.join(pluginRoot, options.uninstallScriptFile);
    await fs.ensureDir(path.dirname(scriptPath));
    await fs.writeFile(
      scriptPath,
      `import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.AW_HOME, '${options.markerFileName ?? 'marker.txt'}'), 'ok', 'utf8');`,
      'utf8',
    );
  }
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  return readPluginManifest(pluginRoot);
}

class FakeAdapter implements PlatformAdapter {
  readonly uninstallPluginCalls: string[] = [];
  readonly uninstallExtensionsCalls: string[] = [];

  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(): Promise<void> {}

  async uninstallPlugin(plugin: PluginMeta): Promise<void> {
    this.uninstallPluginCalls.push(plugin.manifest.name);
  }

  async installExtensions(): Promise<GeneratedArtifact[]> {
    return [];
  }

  async uninstallExtensions(plugin: PluginMeta): Promise<void> {
    this.uninstallExtensionsCalls.push(plugin.manifest.name);
  }

  async upgradePlugin(): Promise<void> {}

  async status(_plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    return {
      platform: 'codex',
      scope,
      initialized: false,
      plugins: [],
    };
  }
}

function makeRuntime(
  env: NodeJS.ProcessEnv,
  adapters?: Partial<Record<PlatformName, PlatformAdapter>>,
) {
  return {
    env,
    adapters: {
      codex: adapters?.codex ?? new FakeAdapter(),
      claude: adapters?.claude ?? new FakeAdapter(),
    } satisfies Record<PlatformName, PlatformAdapter>,
  };
}

function makeTarget(plugin: PluginMeta): ResolvedPluginTarget {
  return {
    pluginName: plugin.manifest.name,
    plugin,
    currentPlugin: plugin,
    source: 'currentCatalog',
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('uninstall command (P9 install-state path)', () => {
  it('blocks uninstall when a verified dependent still references the target', async () => {
    const builder = await makeBuilder();
    const child = builder.createTarget({ pluginName: 'cleanup-child', platform: 'codex', scope: 'user' });
    const parent = builder.createTarget({ pluginName: 'cleanup-parent', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(child);
    const childLifecycle = await builder.writeHistoricalLifecycleRuntime(child);
    const childRecord = await builder.writeInstallRecord(child, childLifecycle);
    await builder.writeExternalNativeEvidence(child);
    const childRecordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${child.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(childRecordPath);

    const parentRecord = await builder.writeInstallRecord(parent);
    const parentRecordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${parent.recordId}.json`,
    );
    const patchedParent = {
      ...parentRecord,
      record: {
        ...parentRecord.record,
        dependencyEdges: [{
          dependency: child.location,
          declaration: {
            name: child.location.plugin,
          },
        }],
      },
    };
    await fs.writeJson(parentRecordPath, patchedParent, { spaces: 2 });
    await rewriteSanitizedInstallRecordForP2(parentRecordPath);
    await builder.writeDependencyIndex([
      { target: child, record: childRecord },
      { target: parent, record: patchedParent },
    ]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    const childPlugin = await ensureRepoPlugin(builder.paths.repoRoot, 'cleanup-child');
    const codex = new FakeAdapter();
    const env = {
      ...process.env,
      AW_HOME: builder.paths.awHome,
      AW_CODEX_HOME: builder.paths.codexHome,
      AW_CLAUDE_HOME: builder.paths.claudeHome,
    };

    await expect(
      uninstallTargetsOnPlatforms(
        [makeTarget(childPlugin)],
        ['codex'],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        makeRuntime(env, { codex }),
      ),
    ).rejects.toThrow(/cleanup-parent/);

    expect(codex.uninstallPluginCalls).toEqual([]);
    expect(codex.uninstallExtensionsCalls).toEqual([]);
  });

  it('runs uninstall lifecycle from the historical runtime instead of current catalog', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    await builder.writeExternalNativeEvidence(target);
    const recordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    const currentPlugin = await ensureRepoPlugin(
      builder.paths.repoRoot,
      'git-commit',
      {
        uninstallScriptFile: 'scripts/current-uninstall.mjs',
        markerFileName: 'current-catalog.txt',
      },
    );
    const historicalManifestPath = path.join(lifecycle.bundleRoot, '.agents-plugin', 'plugin.json');
    await fs.ensureDir(path.dirname(historicalManifestPath));
    const historicalManifest = await fs.readJson(currentPlugin.manifestPath) as Record<string, unknown>;
    historicalManifest.scripts = {
      lifecycle: {
        uninstall: {
          linux: { runner: 'node', path: './scripts/uninstall.mjs' },
          darwin: { runner: 'node', path: './scripts/uninstall.mjs' },
          win32: { runner: 'node', path: './scripts/uninstall.mjs' },
        },
      },
    };
    await fs.ensureDir(path.join(lifecycle.bundleRoot, 'scripts'));
    await fs.writeFile(
      path.join(lifecycle.bundleRoot, 'scripts', 'uninstall.mjs'),
      `import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.AW_HOME, 'historical-runtime.txt'), 'historical', 'utf8');`,
      'utf8',
    );
    await fs.writeJson(historicalManifestPath, historicalManifest, { spaces: 2 });
    const codex = new FakeAdapter();
    const runtime = {
      env: {
        ...process.env,
        AW_HOME: builder.paths.awHome,
        AW_CODEX_HOME: builder.paths.codexHome,
        AW_CLAUDE_HOME: builder.paths.claudeHome,
      },
      adapters: {
        codex,
        claude: new FakeAdapter(),
      } satisfies Record<PlatformName, PlatformAdapter>,
    };

    await uninstallTargetsOnPlatforms(
      [makeTarget(currentPlugin)],
      ['codex'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      runtime,
    );

    await expect(fs.readFile(path.join(builder.paths.awHome, 'historical-runtime.txt'), 'utf8')).resolves.toBe('historical');
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'current-catalog.txt'))).resolves.toBe(false);
  });

  it('fails closed when the historical lifecycle runtime is missing and does not run current catalog lifecycle', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    await builder.writeExternalNativeEvidence(target);
    const recordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    await fs.remove(lifecycle.runtimeRoot);

    const currentPlugin = await ensureRepoPlugin(
      builder.paths.repoRoot,
      'git-commit',
      {
        uninstallScriptFile: 'scripts/current-uninstall.mjs',
        markerFileName: 'current-catalog.txt',
      },
    );
    const codex = new FakeAdapter();
    const runtime = {
      env: {
        ...process.env,
        AW_HOME: builder.paths.awHome,
        AW_CODEX_HOME: builder.paths.codexHome,
        AW_CLAUDE_HOME: builder.paths.claudeHome,
      },
      adapters: {
        codex,
        claude: new FakeAdapter(),
      } satisfies Record<PlatformName, PlatformAdapter>,
    };

    await expect(
      uninstallTargetsOnPlatforms(
        [makeTarget(currentPlugin)],
        ['codex'],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        runtime,
      ),
    ).rejects.toThrow();

    expect(codex.uninstallPluginCalls).toEqual([]);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'current-catalog.txt'))).resolves.toBe(false);
  });
});
