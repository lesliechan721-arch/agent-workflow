import path from 'node:path';

import fs from 'fs-extra';

import { bundleLocalPlugin, prepareLocalPluginBundleSource } from '../generators/local-plugin.js';
import type { PluginMeta } from '../types.js';
import { createCatalogRuntimeImportResolver } from '../utils/catalog-runtime-projection.js';

export interface PreparedSkillPluginBundle {
  bundleRoot: string;
  bundlePlugin: PluginMeta;
  cleanup(): Promise<void>;
}

export async function prepareSkillPluginBundle(options: {
  plugin: PluginMeta;
  plugins: readonly PluginMeta[];
  workRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<PreparedSkillPluginBundle> {
  await fs.ensureDir(options.workRoot);
  const tempRoot = await fs.mkdtemp(path.join(options.workRoot, 'bundle-'));
  let prepared: Awaited<ReturnType<typeof prepareLocalPluginBundleSource>> | undefined;
  try {
    prepared = await prepareLocalPluginBundleSource(options.plugin, {
      buildMode: 'staging',
      commandEnv: options.env,
      runtimeResolver: createCatalogRuntimeImportResolver(options.plugins),
    });
    const activePrepared = prepared;
    const bundleRoot = path.join(tempRoot, 'bundle');
    await bundleLocalPlugin(activePrepared.plugin, bundleRoot, {
      buildMode: 'prepared',
      preparedRuntimeContext: activePrepared.runtimeContext,
    });
    const manifestPath = path.join(bundleRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath) as PluginMeta['manifest'];
    return {
      bundleRoot,
      bundlePlugin: {
        ...activePrepared.plugin,
        rootDir: bundleRoot,
        manifestPath,
        manifest,
      },
      cleanup: async () => {
        await activePrepared.cleanup();
        await fs.remove(tempRoot);
      },
    };
  } catch (error) {
    await prepared?.cleanup();
    await fs.remove(tempRoot);
    throw error;
  }
}

export async function createIsolatedSkillEnv(
  baseEnv: NodeJS.ProcessEnv,
  scopeRoot: string,
): Promise<NodeJS.ProcessEnv> {
  const home = path.join(scopeRoot, 'home');
  const temp = path.join(scopeRoot, 'tmp');
  const codexHome = path.join(scopeRoot, 'codex-home');
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(scopeRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(scopeRoot, 'xdg-config'),
    XDG_STATE_HOME: path.join(scopeRoot, 'xdg-state'),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    AW_HOME: path.join(scopeRoot, 'aw-home'),
    AW_CODEX_HOME: codexHome,
    AW_CLAUDE_HOME: path.join(scopeRoot, 'claude-home'),
    CODEX_HOME: codexHome,
    NODE_PATH: '',
  };
  await Promise.all([
    fs.ensureDir(env.HOME!),
    fs.ensureDir(env.XDG_CACHE_HOME!),
    fs.ensureDir(env.XDG_CONFIG_HOME!),
    fs.ensureDir(env.XDG_STATE_HOME!),
    fs.ensureDir(env.TMPDIR!),
    fs.ensureDir(env.AW_HOME!),
    fs.ensureDir(env.AW_CODEX_HOME!),
    fs.ensureDir(env.AW_CLAUDE_HOME!),
  ]);
  return env;
}
