#!/usr/bin/env node

import { Command } from 'commander';

import { initCommand } from './commands/init.js';
import { installCommand } from './commands/install.js';
import { statusCommand } from './commands/status.js';
import { uninstallCommand } from './commands/uninstall.js';
import { upgradeCommand } from './commands/upgrade.js';
import type { CommandOptions, PlatformSelection, Scope } from './types.js';

function parseScope(scope: string): Scope {
  if (scope === 'project' || scope === 'user') {
    return scope;
  }
  throw new Error(`Unsupported scope "${scope}".`);
}

function parsePlatform(platform: string): PlatformSelection {
  if (platform === 'codex' || platform === 'claude' || platform === 'both' || platform === 'auto') {
    return platform;
  }
  throw new Error(`Unsupported platform "${platform}".`);
}

function toCommandOptions(
  cwd: string,
  rawOptions: { scope?: string; platform?: string },
): CommandOptions {
  return {
    cwd,
    scope: parseScope(rawOptions.scope ?? 'project'),
    platform: parsePlatform(rawOptions.platform ?? 'auto'),
  };
}

async function main(): Promise<void> {
  const program = new Command();
  program.name('aw').description('Agent workflow marketplace installer');

  program
    .command('init')
    .option('--force', 'refresh the local marketplace bundle', false)
    .action(async (rawOptions: { force?: boolean }) => {
      const result = await initCommand({ force: rawOptions.force });
      console.log(
        `${result.changed ? 'Initialized' : 'Reused'} local marketplace at ${result.rootDir}.`,
      );
    });

  program
    .command('install')
    .argument('<plugins...>')
    .option('--scope <scope>', 'project or user', 'project')
    .option('--platform <platform>', 'codex | claude | both | auto', 'auto')
    .action(async (plugins: string[], rawOptions: { scope?: string; platform?: string }) => {
      const result = await installCommand(plugins, toCommandOptions(process.cwd(), rawOptions));
      console.log(`Installed ${result.plugins.join(', ')} on ${result.platforms.join(', ')}.`);
      for (const warning of result.warnings) {
        console.warn(`Warning: ${warning}`);
      }
    });

  program
    .command('uninstall')
    .argument('<plugins...>')
    .option('--scope <scope>', 'project or user', 'project')
    .option('--platform <platform>', 'codex | claude | both | auto', 'auto')
    .action(async (plugins: string[], rawOptions: { scope?: string; platform?: string }) => {
      const result = await uninstallCommand(plugins, toCommandOptions(process.cwd(), rawOptions));
      console.log(`Uninstalled ${result.plugins.join(', ')} from ${result.platforms.join(', ')}.`);
      for (const warning of result.warnings) {
        console.warn(`Warning: ${warning}`);
      }
    });

  program
    .command('upgrade')
    .argument('[plugins...]')
    .option('--all', 'upgrade all plugins', false)
    .option('--scope <scope>', 'project or user', 'project')
    .option('--platform <platform>', 'codex | claude | both | auto', 'auto')
    .action(
      async (
        plugins: string[],
        rawOptions: { all?: boolean; scope?: string; platform?: string },
      ) => {
        const result = await upgradeCommand(plugins, {
          ...toCommandOptions(process.cwd(), rawOptions),
          all: rawOptions.all,
        });
        console.log(`Upgraded ${result.plugins.join(', ')} on ${result.platforms.join(', ')}.`);
        for (const warning of result.warnings) {
          console.warn(`Warning: ${warning}`);
        }
      },
    );

  program
    .command('status')
    .argument('[plugins...]')
    .option('--scope <scope>', 'project or user', 'project')
    .option('--platform <platform>', 'codex | claude | both | auto', 'auto')
    .action(async (plugins: string[], rawOptions: { scope?: string; platform?: string }) => {
      const result = await statusCommand(plugins, toCommandOptions(process.cwd(), rawOptions));
      console.log(result.output);
    });

  await program.parseAsync();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
