import path from 'node:path';
import fs from 'fs-extra';
import { vi } from 'vitest';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { getClaudeHome } from '../../src/utils/state-paths.js';
import { renderNpmCmdShim } from '../../src/utils/windows-npm-shim.js';

/** Controlled current Claude CLI; filesystem registration and activation stay observable. */
export async function createClaudeNativeTestRuntime(
  isolation: { env: NodeJS.ProcessEnv; layout: { fixtureCwd: string } },
) {
  const cwd = isolation.layout.fixtureCwd;
  const projectRoot = await fs.realpath(cwd);
  const claudeHome = getClaudeHome(isolation.env);
  const installedPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const knownPath = path.join(claudeHome, 'plugins', 'known_marketplaces.json');
  const marketplaceRoots = new Map<string, string>();
  const packageRoots = new Map<string, string>();
  const binRoot = path.join(cwd, 'claude-native-bin');
  let launcherPath: string | undefined;
  if (process.platform === 'win32') {
    const packageRoot = path.join(binRoot, 'node_modules', '@anthropic-ai', 'claude-code');
    await fs.outputJson(path.join(packageRoot, 'package.json'), { name: '@anthropic-ai/claude-code',
      version: '2.1.292', bin: { claude: 'cli.js' } });
    await fs.outputFile(path.join(packageRoot, 'cli.js'), '// External calls use the controlled runner.\n');
    launcherPath = await fs.realpath(path.join(packageRoot, 'cli.js'));
    await fs.outputFile(path.join(binRoot, 'claude.cmd'),
      renderNpmCmdShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'));
  } else await fs.outputFile(path.join(binRoot, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const executablePath = await fs.realpath(path.join(binRoot, process.platform === 'win32' ? 'claude.cmd' : 'claude'));
  const isClaudeInvocation = (invocation: NativeCliInvocation): boolean => invocation.command === 'claude'
    || invocation.command === executablePath
    || launcherPath !== undefined && invocation.command === process.execPath && invocation.args[0] === launcherPath;
  const inheritedPath = Object.entries(isolation.env).find(([key]) => key.toLowerCase() === 'path')?.[1];
  for (const key of Object.keys(isolation.env)) if (key.toLowerCase() === 'path') delete isolation.env[key];
  isolation.env.PATH = [binRoot, inheritedPath].filter(Boolean).join(path.delimiter);

  const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
    if (!isClaudeInvocation(invocation)) return { exitCode: 0, stdout: invocation.args.includes('--version')
      ? 'codex-cli 0.200.0' : '{"installed":[],"available":[]}', stderr: '' };
    if (invocation.args.includes('--version')) return { exitCode: 0, stdout: '2.1.292 (Claude Code)', stderr: '' };
    const pluginIndex = invocation.args.indexOf('plugin');
    const args = pluginIndex < 0 ? invocation.args : invocation.args.slice(pluginIndex);
    if (args[0] !== 'plugin') throw new Error('Unexpected controlled Claude invocation.');
    const known = await fs.readJson(knownPath).catch(() => ({}));
    if (args[1] === 'marketplace' && args[2] === 'add') {
      const root = args[3]!;
      const { marketplaceName } = await fs.readJson(path.join(root, 'config.json'));
      marketplaceRoots.set(marketplaceName, root);
      await fs.outputJson(knownPath, { ...known, [marketplaceName]: {
        source: { source: 'directory', path: root }, installLocation: root,
      } });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const id = args[2]!;
    const scopeIndex = args.indexOf('--scope');
    const scope = scopeIndex < 0 ? 'user' : args[scopeIndex + 1]!;
    if (scope !== 'user' && scope !== 'local') throw new Error('Unexpected controlled Claude scope.');
    const invocationCwd = invocation.cwd ?? cwd;
    const invocationRoot = await fs.realpath(invocationCwd);
    const settingsPath = scope === 'local' ? path.join(invocationRoot, '.claude', 'settings.local.json')
      : path.join(claudeHome, 'settings.json');
    const settings = await fs.readJson(settingsPath).catch(() => ({}));
    if (['install', 'update', 'uninstall'].includes(args[1]!)) {
      const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} }));
      const records = (installed.plugins[id] ?? []).filter((record: { scope: string; projectPath?: string }) =>
        record.scope !== scope || scope === 'local' && record.projectPath !== invocationRoot);
      if (args[1] !== 'uninstall') {
        const separator = id.lastIndexOf('@');
        const marketplace = id.slice(separator + 1);
        const marketplaceRoot = marketplaceRoots.get(marketplace) ?? known[marketplace]?.installLocation;
        if (!marketplaceRoot) throw new Error(`Unregistered controlled Claude marketplace: ${marketplace}`);
        marketplaceRoots.set(marketplace, marketplaceRoot);
        const root = path.join(marketplaceRoot, 'plugins', id.slice(0, separator));
        const manifest = await fs.readJson(path.join(root, '.claude-plugin', 'plugin.json'));
        packageRoots.set(id, root);
        records.push({ scope, ...(scope === 'local' ? { projectPath: invocationRoot } : {}), version: manifest.version, installPath: root });
      } else packageRoots.delete(id);
      const plugins = { ...installed.plugins };
      if (records.length) plugins[id] = records; else delete plugins[id];
      await fs.outputJson(installedPath, { version: 2, plugins });
    }
    if (['install', 'uninstall', 'enable', 'disable'].includes(args[1]!)) {
      await fs.outputJson(settingsPath, { ...settings, enabledPlugins: { ...settings.enabledPlugins,
        [id]: !['disable', 'uninstall'].includes(args[1]!),
      } });
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { runtime: { env: isolation.env, nativeCliRunner }, nativeCliRunner, installedPath,
    claudeHome, projectRoot, marketplaceRoots, packageRoots, binRoot, isClaudeInvocation };
}
