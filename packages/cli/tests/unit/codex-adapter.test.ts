import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex.js';
import { buildGeneratedName } from '../../src/generators/shared.js';
import { initializeLocalMarketplace } from '../../src/utils/local-marketplace.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  resolveCodexPaths,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { upsertTrackingRecord } from '../../src/utils/tracking.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{
  repoRoot: string;
  cwd: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-adapter-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await fs.writeFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8');

  const cwd = path.join(repoRoot, 'packages', 'app');
  await fs.ensureDir(cwd);

  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  return {
    repoRoot,
    cwd,
    embeddedRoot,
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    },
  };
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('CodexAdapter', () => {
  it('preserves foreign and unresolved historical shared hook groups while rerendering the current plugin', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await upsertTrackingRecord(paths.trackingDir, 'history-only', [
      {
        path: paths.hooksPath,
        kind: 'hook',
        platform: 'codex',
        hookGroups: [
          {
            event: 'PreToolUse',
            matcher: 'Edit',
            command: 'echo historical',
          },
        ],
      },
    ]);
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo historical' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: 'ignored',
            hooks: [{ type: 'command', command: 'echo foreign prompt' }],
          },
        ],
      },
    }, { spaces: 2 });

    await adapter.installExtensions(plugin, 'project');

    await expect(fs.readJson(paths.hooksPath)).resolves.toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo historical' }],
          },
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo git hook' }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: 'ignored',
            hooks: [{ type: 'command', command: 'echo foreign prompt' }],
          },
        ],
      },
    });
  });

  it('installs and uninstalls nativeHooks-only Codex plugins without removing foreign shared groups', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const basePlugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const plugin = {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        extensions: {
          nativeHooks: {
            codex: [
              {
                event: 'Stop',
                command: 'echo native stop',
              },
            ],
          },
        },
      },
    };
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    await fs.ensureDir(path.dirname(paths.hooksPath));
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
      },
    }, { spaces: 2 });

    const artifacts = await adapter.installExtensions(plugin, 'project');
    const hookArtifact = artifacts.find((artifact) => artifact.kind === 'hook');
    expect(hookArtifact?.path).toBeTruthy();
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    expect(await fs.pathExists(hookArtifact!.path)).toBe(true);
    const installedHooks = await fs.readJson(hookArtifact!.path).catch((error: Error) => {
      throw new Error(`read after install failed: ${error.message}`);
    });
    expect(installedHooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: 'command', command: 'echo native stop' }],
          },
        ],
      },
    });

    await adapter.uninstallExtensions(plugin, 'project', artifacts);

    expect(await fs.pathExists(hookArtifact!.path)).toBe(true);
    const remainingHooks = await fs.readJson(hookArtifact!.path).catch((error: Error) => {
      throw new Error(`read after uninstall failed: ${error.message}`);
    });
    expect(remainingHooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'echo foreign', timeout: 1000 }],
          },
        ],
      },
    });
  });

  it('writes the Codex marketplace source using the canonical AW_HOME path', async () => {
    const { repoRoot, cwd, embeddedRoot, env } = await makeWorkspace();
    const realAwHome = `${env.AW_HOME}-real`;
    const aliasAwHome = `${env.AW_HOME}-alias`;
    await fs.ensureDir(realAwHome);
    await fs.symlink(realAwHome, aliasAwHome);
    env.AW_HOME = aliasAwHome;
    process.env.AW_HOME = aliasAwHome;
    process.env.AW_CODEX_HOME = env.AW_CODEX_HOME;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);

    await adapter.installPlugin(plugin, 'user');

    const configPath = resolveCodexPaths(cwd, 'user', env).configTomlPath;
    const configSnapshot = await readCodexConfigFile(configPath);
    const canonicalAwHome = await fs.realpath(aliasAwHome);

    expect(configSnapshot.snapshot.marketplaces.aw).toMatchObject({
      source: canonicalAwHome,
      sourceType: 'local',
    });
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain(
      `source = ${JSON.stringify(canonicalAwHome)}`,
    );
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain(
      `source = ${JSON.stringify(aliasAwHome)}`,
    );
  });

  it('detects enabled higher-priority current/tree/repo layers in user scope status', async () => {
    const { repoRoot, cwd, embeddedRoot, env } = await makeWorkspace();
    process.env.AW_HOME = env.AW_HOME;
    process.env.AW_CODEX_HOME = env.AW_CODEX_HOME;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env });

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const userPaths = resolveCodexPaths(cwd, 'user', env);
    await fs.ensureDir(path.dirname(userPaths.configTomlPath));
    await fs.writeFile(
      userPaths.configTomlPath,
      `[projects.${JSON.stringify(repoRoot)}]\ntrust_level = "trusted"\n`,
      'utf8',
    );

    const artifacts = await adapter.installExtensions(plugin, 'user');
    await upsertTrackingRecord(userPaths.trackingDir, plugin.manifest.name, artifacts);
    await expect(readCodexConfigFile(userPaths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        projects: {
          [repoRoot]: {
            trustLevel: 'trusted',
          },
        },
      },
    });
    await fs.writeFile(
      path.join(cwd, 'config.toml'),
      'developer_instructions = "cwd layer"\n',
      'utf8',
    );

    const generatedAgentId = buildGeneratedName(plugin.manifest.name, 'commit-reviewer');
    const ancestorCodexDir = path.join(repoRoot, 'packages', '.codex');
    await fs.ensureDir(path.join(ancestorCodexDir, 'rules'));
    await fs.ensureDir(path.join(ancestorCodexDir, 'agents'));
    await fs.writeFile(
      path.join(ancestorCodexDir, 'config.toml'),
      'developer_instructions = "tree layer"\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(ancestorCodexDir, 'rules', 'overlay.rules'),
      'allow = []\n',
      'utf8',
    );
    await fs.writeJson(path.join(ancestorCodexDir, 'hooks.json'), { hooks: [] }, { spaces: 2 });
    await fs.writeFile(
      path.join(ancestorCodexDir, 'agents', `${generatedAgentId}.toml`),
      'name = "tree-reviewer"\ndescription = "tree"\ndeveloper_instructions = "tree"\n',
      'utf8',
    );

    const repoCodexDir = path.join(repoRoot, '.codex');
    await fs.ensureDir(repoCodexDir);
    await fs.writeFile(
      path.join(repoCodexDir, 'config.toml'),
      'developer_instructions = "repo layer"\n',
      'utf8',
    );

    const status = await adapter.status(plugin, 'user');

    expect(status.plugins[0]).toMatchObject({
      projectTrust: 'trusted',
      repoManagedSessionState: {
        instructions: 'unknownByExternalLayer',
        rules: 'visible',
        hooks: 'visible',
        agents: 'unknownByExternalLayer',
      },
    });
    expect(status.plugins[0].repoManagedSessionState?.diagnostics).toContain(
      'effective exec policy 还叠加了外部 layer 的 rules。',
    );
    expect(status.plugins[0].repoManagedSessionState?.diagnostics).toContain(
      'effective hooks registry 还叠加了外部 layer 的 hooks。',
    );
  });

  it('removes repo-managed Codex artifacts without relying on tracking records', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    const permissionArtifact = artifacts.find((artifact) => artifact.kind === 'permission');
    const agentArtifact = artifacts.find((artifact) => artifact.kind === 'agent');
    const hookArtifact = artifacts.find((artifact) => artifact.kind === 'hook');

    expect(permissionArtifact?.path).toBeTruthy();
    expect(agentArtifact?.path).toBeTruthy();
    expect(hookArtifact?.path).toBeTruthy();
    await expect(readCodexConfigFile(paths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        developerInstructions: {
          defined: true,
        },
      },
    });

    await adapter.uninstallExtensions(plugin, 'project', artifacts);

    await expect(readCodexConfigFile(paths.configTomlPath)).resolves.toMatchObject({
      snapshot: {
        developerInstructions: {
          defined: false,
          managedBlocks: {},
        },
      },
    });
    await expect(fs.pathExists(permissionArtifact!.path)).resolves.toBe(false);
    await expect(fs.pathExists(agentArtifact!.path)).resolves.toBe(false);
    await expect(fs.pathExists(hookArtifact!.path)).resolves.toBe(false);
  });

  it('reports Codex hook drift when the shared hooks file loses this plugin handlers', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [],
      },
    }, { spaces: 2 });

    const status = await adapter.status(plugin, 'project');

    expect(status.plugins[0].repoManagedSessionState?.hooks).toBe('absent');
    expect(status.plugins[0].driftWarnings).toContain(
      'Codex hooks artifact 中缺少当前插件声明的 hook handlers。',
    );
  });

  it('does not treat invalid Codex matcher groups as satisfying managed hooks', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: '[',
            hooks: [{ type: 'command', command: 'echo git hook' }],
          },
        ],
      },
    }, { spaces: 2 });

    const status = await adapter.status(plugin, 'project');

    expect(status.plugins[0].repoManagedSessionState?.hooks).toBe('absent');
    expect(status.plugins[0].driftWarnings).toContain(
      'Codex hooks artifact 中缺少当前插件声明的 hook handlers。',
    );
  });

  it('falls back to tracked hook identities when the current Codex catalog entry is missing', async () => {
    const { repoRoot, cwd, embeddedRoot, env } = await makeWorkspace();
    process.env.AW_HOME = env.AW_HOME;
    process.env.AW_CODEX_HOME = env.AW_CODEX_HOME;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'user', env);

    const artifacts = await adapter.installExtensions(plugin, 'user');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    for (const manifestPath of [
      path.join(embeddedRoot, '.claude-plugin', 'marketplace.json'),
      path.join(embeddedRoot, '.agents', 'plugins', 'marketplace.json'),
    ]) {
      const manifest = await fs.readJson(manifestPath);
      manifest.plugins = (manifest.plugins ?? []).filter(
        (entry: { name?: string }) => entry.name !== plugin.manifest.name,
      );
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    }

    const status = await adapter.status(plugin, 'user');

    expect(status.plugins[0]).toMatchObject({
      catalogCompatibility: 'missing',
      repoManagedSessionState: {
        hooks: 'visible',
      },
    });
    expect(status.plugins[0].driftWarnings).not.toContain(
      'Codex hooks artifact 中缺少当前插件声明的 hook handlers。',
    );
  });

  it('rejects existing Codex hooks with unsupported native event names before rewriting', async () => {
    const { repoRoot, cwd, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new CodexAdapter(cwd, env);
    const paths = resolveCodexPaths(cwd, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await fs.writeJson(paths.hooksPath, {
      hooks: {
        sessionStop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo done' }],
          },
        ],
      },
    }, { spaces: 2 });

    await expect(adapter.uninstallExtensions(plugin, 'project', artifacts)).rejects.toThrow(
      'codex.hooks.hooks.sessionStop',
    );
  });
});
