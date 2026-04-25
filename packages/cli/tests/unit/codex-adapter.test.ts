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
});
