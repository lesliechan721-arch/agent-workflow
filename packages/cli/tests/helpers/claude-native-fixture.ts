import path from 'node:path';
import fs from 'fs-extra';
import { vi } from 'vitest';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';

export async function createClaudeNativeTestRuntime(
  isolation: { env: NodeJS.ProcessEnv; layout: { fixtureCwd: string } },
) {
  const cwd = isolation.layout.fixtureCwd;
  const projectRoot = await fs.realpath(cwd);
  const claudeHome = isolation.env.AW_CLAUDE_HOME!;
  const installedPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const knownPath = path.join(claudeHome, 'plugins', 'known_marketplaces.json');
  const marketplaceRoots = new Map<string, string>();
  const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
    if (invocation.command !== 'claude') {
      return { exitCode: 0, stdout: invocation.args.includes('--version')
        ? 'codex-cli 0.200.0' : '{"installed":[],"available":[]}', stderr: '' };
    }
    const args = invocation.args;
    const invocationProjectRoot = await fs.realpath(invocation.cwd);
    if (args[0] !== 'plugin') return { exitCode: 0, stdout: '2.1.88 (Claude Code)', stderr: '' };
    const scopeIndex = args.indexOf('--scope');
    const scope = scopeIndex === -1 ? 'user' : args[scopeIndex + 1]!;
    const settingsPath = scope === 'project'
      ? path.join(invocation.cwd, '.claude', 'settings.json')
      : path.join(claudeHome, 'settings.json');
    const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
    if (args[1] === 'marketplace' && args[2] === 'add') {
      const marketplaceRoot = args[3]!;
      const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
        marketplaceName: string;
      };
      marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
      await fs.outputJson(settingsPath, {
        ...settings,
        extraKnownMarketplaces: {
          ...((settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>),
          [config.marketplaceName]: { source: { source: 'directory', path: marketplaceRoot } },
        },
      });
      const known = await fs.readJson(knownPath).catch(() => ({})) as Record<string, unknown>;
      await fs.outputJson(knownPath, {
        ...known,
        [config.marketplaceName]: {
          source: { source: 'directory', path: marketplaceRoot }, installLocation: marketplaceRoot,
        },
      });
    }
    if (args[1] === 'install' || args[1] === 'uninstall') {
      const pluginId = args[2]!;
      const enabled = { ...((settings.enabledPlugins ?? {}) as Record<string, unknown>) };
      if (args[1] === 'install') enabled[pluginId] = true;
      else delete enabled[pluginId];
      await fs.outputJson(settingsPath, { ...settings, enabledPlugins: enabled });
      const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
        plugins?: Record<string, Array<Record<string, unknown>>>;
      };
      const plugins = { ...(installed.plugins ?? {}) };
      const records = [...(plugins[pluginId] ?? [])].filter((record) =>
        record.scope !== scope || (scope === 'project' && record.projectPath !== invocationProjectRoot));
      if (args[1] === 'install') {
        const separator = pluginId.lastIndexOf('@');
        const pluginRoot = path.join(marketplaceRoots.get(pluginId.slice(separator + 1))!, 'plugins', pluginId.slice(0, separator));
        const manifest = await fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'));
        records.push({
          name: pluginId.slice(0, pluginId.lastIndexOf('@')),
          scope,
          ...(scope === 'project' ? { projectPath: invocationProjectRoot } : {}),
          version: manifest.version, installPath: pluginRoot,
        });
      }
      if (records.length > 0) plugins[pluginId] = records;
      else delete plugins[pluginId];
      await fs.outputJson(installedPath, { plugins });
    }
    return { exitCode: 0, stdout: '2.1.88 (Claude Code)', stderr: '' };
  });
  return { runtime: { env: isolation.env, nativeCliRunner }, nativeCliRunner, installedPath, claudeHome, projectRoot };
}
