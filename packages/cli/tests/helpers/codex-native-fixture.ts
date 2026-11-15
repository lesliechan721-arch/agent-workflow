import path from 'node:path';

import fs from 'fs-extra';
import { vi } from 'vitest';

import {
  applyCodexConfigTransactionFile,
  readCodexConfigFile,
  removeCodexMarketplace,
} from '../../src/utils/codex-config.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';

/** Simulate the public Codex CLI while AW writes the real canonical payload. */
export async function createCodexNativeTestRuntime(
  isolation: { env: NodeJS.ProcessEnv; layout: { fixtureCwd: string } },
  options: { rejectAdd?: (pluginId: string) => boolean } = {},
) {
  const binRoot = path.join(isolation.layout.fixtureCwd, 'codex-native-bin');
  if (process.platform === 'win32') {
    const packageRoot = path.join(binRoot, 'node_modules/@openai/codex');
    await fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: '@openai/codex', version: '0.200.0', bin: { codex: 'bin/codex.js' },
    });
    await fs.outputFile(path.join(packageRoot, 'bin/codex.js'), '// Native calls use the injected runner.\n');
    await fs.outputFile(path.join(binRoot, 'codex.cmd'), '@echo off\r\n');
  } else {
    await fs.outputFile(path.join(binRoot, 'codex'), '#!/usr/bin/env node\n', { mode: 0o755 });
  }
  const inheritedPath = Object.entries(isolation.env).find(([key]) => key.toLowerCase() === 'path')?.[1];
  for (const key of Object.keys(isolation.env)) if (key.toLowerCase() === 'path') delete isolation.env[key];
  isolation.env.PATH = [binRoot, inheritedPath].filter(Boolean).join(path.delimiter);
  const installed = new Map<string, string>();
  const marketplaces = new Map<string, string>();
  const packageRoots = new Map<string, string>();
  const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
  const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
    if (invocation.args.includes('--version')) return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
    const index = invocation.args.indexOf('plugin');
    const args = index < 0 ? invocation.args : invocation.args.slice(index);
    if (args[1] === 'marketplace' && args[2] === 'add') {
      const root = args[3]!;
      const { marketplaceName } = await fs.readJson(path.join(root, 'config.json'));
      marketplaces.set(marketplaceName, root);
      const current = await fs.readFile(configPath, 'utf8').catch(() => '');
      if (!(await readCodexConfigFile(configPath)).snapshot.marketplaces[marketplaceName]) {
        await fs.outputFile(configPath, [current, `[marketplaces.${JSON.stringify(marketplaceName)}]`,
          `source = ${JSON.stringify(root)}`, 'source_type = "local"', ''].join('\n'));
      }
    } else if (args[1] === 'marketplace' && args[2] === 'remove') {
      marketplaces.delete(args[3]!);
      await fs.outputFile(configPath, removeCodexMarketplace(await fs.readFile(configPath, 'utf8'), args[3]!));
    } else if (args[1] === 'add') {
      const pluginId = args[2]!;
      if (options.rejectAdd?.(pluginId)) return { exitCode: 1, stdout: '', stderr: 'injected native add failure' };
      const separator = pluginId.lastIndexOf('@');
      const root = marketplaces.get(pluginId.slice(separator + 1));
      if (!root) throw new Error(`Unregistered fixture marketplace: ${pluginId}`);
      const manifest = await fs.readJson(path.join(root, 'plugins', pluginId.slice(0, separator), '.codex-plugin/plugin.json'));
      installed.set(pluginId, manifest.version);
      packageRoots.set(pluginId, path.join(root, 'plugins', pluginId.slice(0, separator)));
      await applyCodexConfigTransactionFile(configPath, { upsertPluginActivations: { [pluginId]: true } });
    } else if (args[1] === 'remove') {
      installed.delete(args[2]!);
      packageRoots.delete(args[2]!);
      await applyCodexConfigTransactionFile(configPath, { removePluginActivations: [args[2]!] });
    }
    if (args[1] === 'list' && args.includes('--json')) {
      const [user, project] = await Promise.all([
        readCodexConfigFile(configPath),
        readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex/config.toml')),
      ]);
      const exactProject = path.resolve(invocation.cwd) === path.resolve(isolation.layout.fixtureCwd);
      const marketplace = args[args.indexOf('--marketplace') + 1];
      return { exitCode: 0, stdout: JSON.stringify({ installed: [...installed]
        .filter(([id]) => id.endsWith(`@${marketplace}`)).map(([pluginId, version]) => ({
          pluginId, installed: true, version,
          enabled: user.snapshot.plugins[pluginId]?.enabled === true
            || exactProject && project.snapshot.plugins[pluginId]?.enabled === true,
        })), available: [] }), stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { nativeCliRunner, installed, marketplaces, packageRoots };
}
