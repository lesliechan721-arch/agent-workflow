#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError, InvalidArgumentError } from 'commander';

import { initCommand } from './commands/init.js';
import { installCommand } from './commands/install.js';
import { statusCommand } from './commands/status.js';
import { uninstallCommand } from './commands/uninstall.js';
import { upgradeCommand } from './commands/upgrade.js';
import {
  CommandWarningError,
  isCommandWarningError,
  type CommandOptions,
  type InstallCommandOptions,
  type PlatformSelection,
  type Scope,
  type SkillTriggerPreference,
  type UpgradeCommandOptions,
} from './types.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliRuntimeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: Partial<CliIo>;
}

function createDefaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function writeLine(write: (text: string) => void, line: string): void {
  write(`${line}\n`);
}

function writeWarnings(write: (text: string) => void, warnings: string[]): void {
  for (const warning of [...new Set(warnings)]) {
    writeLine(write, `Warning: ${warning}`);
  }
}

function parseScope(scope: string): Scope {
  if (scope === 'project' || scope === 'user') {
    return scope;
  }
  throw new InvalidArgumentError(`Unsupported scope "${scope}".`);
}

function parsePlatform(platform: string): PlatformSelection {
  if (platform === 'codex' || platform === 'claude' || platform === 'both' || platform === 'auto') {
    return platform;
  }
  throw new InvalidArgumentError(`Unsupported platform "${platform}".`);
}

export function parseSkillTriggerPreference(preference: string): SkillTriggerPreference {
  if (preference === 'default' || preference === 'manual' || preference === 'auto') {
    return preference;
  }

  throw new InvalidArgumentError(
    `Unsupported skill trigger preference "${preference}". Expected one of: default, manual, auto.`,
  );
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

function toInstallCommandOptions(
  cwd: string,
  rawOptions: { scope?: string; platform?: string; skillTrigger?: SkillTriggerPreference },
): InstallCommandOptions {
  return {
    ...toCommandOptions(cwd, rawOptions),
    requestedSkillTrigger: rawOptions.skillTrigger,
  };
}

function toUpgradeCommandOptions(
  cwd: string,
  rawOptions: {
    all?: boolean;
    scope?: string;
    platform?: string;
    skillTrigger?: SkillTriggerPreference;
  },
): UpgradeCommandOptions {
  return {
    ...toCommandOptions(cwd, rawOptions),
    all: rawOptions.all,
    requestedSkillTrigger: rawOptions.skillTrigger,
  };
}

export function buildProgram(options: CliRuntimeOptions = {}): Command {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const io = {
    ...createDefaultIo(),
    ...options.io,
  };

  const program = new Command();
  program
    .name('aw')
    .description('Agent workflow marketplace installer')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
      outputError: (text, write) => write(text),
    });

  program
    .command('init')
    .option('--force', 'refresh the local marketplace bundle', false)
    .action(async (rawOptions: { force?: boolean }) => {
      const result = await initCommand({ force: rawOptions.force, env });
      writeLine(
        io.stdout,
        `${result.changed ? 'Initialized' : 'Reused'} local marketplace at ${result.rootDir}.`,
      );
      writeWarnings(io.stderr, result.warnings);
    });

  program
    .command('install')
    .argument('<plugins...>')
    .option('--scope <scope>', 'project or user', 'project')
    .option('--platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('--skill-trigger <preference>', 'default | manual | auto', parseSkillTriggerPreference)
    .action(
      async (
        plugins: string[],
        rawOptions: {
          scope?: string;
          platform?: string;
          skillTrigger?: SkillTriggerPreference;
        },
      ) => {
        const result = await installCommand(
          plugins,
          toInstallCommandOptions(cwd, rawOptions),
          { env },
        );
        writeLine(
          io.stdout,
          `Installed ${result.plugins.join(', ')} on ${result.platforms.join(', ')}.`,
        );
        writeWarnings(io.stderr, result.warnings);
      },
    );

  program
    .command('uninstall')
    .argument('<plugins...>')
    .option('--scope <scope>', 'project or user', 'project')
    .option('--platform <platform>', 'codex | claude | both | auto', 'auto')
    .action(async (plugins: string[], rawOptions: { scope?: string; platform?: string }) => {
      const result = await uninstallCommand(plugins, toCommandOptions(cwd, rawOptions), { env });
      writeLine(
        io.stdout,
        `Uninstalled ${result.plugins.join(', ')} from ${result.platforms.join(', ')}.`,
      );
      writeWarnings(io.stderr, result.warnings);
    });

  program
    .command('upgrade')
    .argument('[plugins...]')
    .option('--all', 'upgrade all plugins', false)
    .option('--scope <scope>', 'project or user', 'project')
    .option('--platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('--skill-trigger <preference>', 'default | manual | auto', parseSkillTriggerPreference)
    .action(
      async (
        plugins: string[],
        rawOptions: {
          all?: boolean;
          scope?: string;
          platform?: string;
          skillTrigger?: SkillTriggerPreference;
        },
      ) => {
        const result = await upgradeCommand(
          plugins,
          toUpgradeCommandOptions(cwd, rawOptions),
          { env },
        );
        writeLine(
          io.stdout,
          `Upgraded ${result.plugins.join(', ')} on ${result.platforms.join(', ')}.`,
        );
        writeWarnings(io.stderr, result.warnings);
      },
    );

  program
    .command('status')
    .argument('[plugins...]')
    .option('--scope <scope>', 'project or user', 'project')
    .option('--platform <platform>', 'codex | claude | both | auto', 'auto')
    .action(async (plugins: string[], rawOptions: { scope?: string; platform?: string }) => {
      const result = await statusCommand(plugins, toCommandOptions(cwd, rawOptions), { env });
      writeLine(io.stdout, result.output);
    });

  return program;
}

function handleCliError(
  error: unknown,
  writeError: (text: string) => void,
): number {
  if (error instanceof CommanderError) {
    return error.exitCode;
  }

  if (isCommandWarningError(error)) {
    writeWarnings(writeError, error.warnings);
    writeLine(writeError, error.message);
    return error.exitCode;
  }

  writeLine(writeError, error instanceof Error ? error.message : String(error));
  return 1;
}

export async function runCli(
  argv: string[],
  options: CliRuntimeOptions = {},
): Promise<number> {
  const io = {
    ...createDefaultIo(),
    ...options.io,
  };

  try {
    const program = buildProgram({
      ...options,
      io,
    });
    await program.parseAsync(['node', 'aw', ...argv]);
    return 0;
  } catch (error) {
    return handleCliError(error, io.stderr);
  }
}

export async function main(
  argv = process.argv.slice(2),
  options: CliRuntimeOptions = {},
): Promise<number> {
  return runCli(argv, options);
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedPath === currentEntryPath) {
  void main().then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}
