import path from 'node:path';
import * as fs from 'node:fs/promises';

import type { Command } from 'commander';
import { getCommandPackageId, isManagedCommandId, type CommandLaunch } from '@lesliechan721/aw-plugin-core/manifest';

import type { CliExecutionContext } from './runtime.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { withResolvedCatalogPlugin } from '../utils/multi-source-catalog.js';
import { resolveRepoRoot } from '../utils/state-paths.js';
import { sanitizeCatalogSourceError } from '../utils/catalog-public-error.js';
import { syncPluginManagedCommandPackage } from '../utils/managed-command-materialization.js';
import { runManagedCommand } from '../utils/managed-command-runtime.js';
import {
  ManagedCommandError,
  assertUserCommandId,
  inspectManagedCommand,
  installUserCommand,
  listManagedCommandPackages,
  listManagedCommands,
  managedCommandDiagnostic,
  parseManagedCommandLaunch,
  readManagedCommandPackageOwner,
  removeManagedCommandPackage,
  removeUserCommand,
  updateUserCommand,
  validateManagedCommandName,
  type ManagedCommandDiagnostic,
  type ManagedCommandPackageView,
  type ManagedCommandView,
} from '../utils/managed-command-store.js';

export interface CommandManagementResult {
  schemaVersion: 1;
  command: 'command.install' | 'command.update' | 'command.remove' | 'command.list' | 'command.show' | 'command.package.sync' | 'command.package.remove';
  ok: boolean;
  overallState: 'completed' | 'partial' | 'failed';
  commands: ManagedCommandView[];
  packages: ManagedCommandPackageView[];
  changes: Array<{ kind: 'command' | 'package'; id: string; action: 'created' | 'updated' | 'removed' | 'retained' }>;
  errors: ManagedCommandDiagnostic[];
  recoveryActions: string[];
}

const HELP = `Usage:
  aw command install <directory> --name <name> --runner node|executable --entry <relative-file> [--args-json <json>] [--env-json <json>] [--env-from-json <json>] [--cwd caller|resource] [--yes] [--json]
  aw command update <cmdu-id> --from <directory> [--name <name>] [--runner node|executable] [--entry <relative-file>] [--args-json <json>] [--env-json <json>] [--env-from-json <json>] [--cwd caller|resource] [--yes] [--json]
  aw command remove <cmdu-id> [--force] [--yes] [--json]
  aw command list [--json]
  aw command show <command-id> [--json]
  aw command run <command-id> -- <args...>
  aw command package sync <source/plugin> <package-key> --scope user|project [--yes] [--json]
  aw command package remove <source/plugin> <package-key> --scope user|project [--force] [--yes] [--json]
  aw command package remove <pkg-id> [--force] [--yes] [--json]
`;

function invalid(message: string): never { throw new ManagedCommandError('invalidArguments', message, true); }
function parseOptions(args: string[], allowed: string[]): { positionals: string[]; options: Record<string, string | true> } {
  const options: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('-')) { positionals.push(token); continue; }
    const equals = token.indexOf('=');
    const name = equals < 0 ? token : token.slice(0, equals);
    if (!allowed.includes(name) || Object.hasOwn(options, name)) invalid(`Unknown or repeated option: ${name}.`);
    if (['--yes', '--json', '--force'].includes(name)) {
      if (equals >= 0) invalid(`${name} does not take a value.`);
      options[name] = true;
    } else {
      const value = equals < 0 ? args[++index] : token.slice(equals + 1);
      if (value === undefined || (equals < 0 && value.startsWith('--'))) invalid(`${name} requires a value.`);
      options[name] = value;
    }
  }
  return { positionals, options };
}
function textOption(options: Record<string, string | true>, name: string, required = false): string | undefined {
  const value = options[name];
  if (typeof value === 'string') return value;
  if (required) invalid(`${name} is required.`);
  return undefined;
}
function launchOptions(options: Record<string, string | true>, required: boolean): Partial<CommandLaunch> {
  const output: Record<string, unknown> = {};
  for (const key of ['runner', 'entry', 'cwd']) {
    const value = textOption(options, `--${key}`, required && key !== 'cwd');
    if (value !== undefined) output[key] = value;
  }
  for (const [option, key] of [['--args-json', 'args'], ['--env-json', 'env'], ['--env-from-json', 'envFrom']] as const) {
    const value = textOption(options, option);
    if (value !== undefined) {
      try { output[key] = JSON.parse(value); } catch { invalid(`${option} must contain one complete JSON value.`); }
    }
  }
  try {
    if (required) return parseManagedCommandLaunch(output);
    // Validate the supplied fields without replacing the stored values for omitted fields.
    parseManagedCommandLaunch({ runner: 'node', entry: 'entry.js', ...output });
  } catch { invalid('The supplied launch options are invalid.'); }
  return output as Partial<CommandLaunch>;
}
function result(command: CommandManagementResult['command']): CommandManagementResult {
  return { schemaVersion: 1, command, ok: true, overallState: 'completed', commands: [], packages: [], changes: [], errors: [], recoveryActions: [] };
}
function finish(receipt: CommandManagementResult): CommandManagementResult {
  receipt.errors.push(...receipt.commands.flatMap((command) => command.errors), ...receipt.packages.flatMap((pkg) => pkg.errors));
  receipt.recoveryActions = [...new Set([...receipt.recoveryActions, ...receipt.commands.flatMap((command) => command.recoveryActions), ...receipt.packages.flatMap((pkg) => pkg.recoveryActions)])];
  if (receipt.errors.length > 0 && receipt.overallState === 'completed') receipt.overallState = receipt.commands.length || receipt.packages.length || receipt.changes.length ? 'partial' : 'failed';
  receipt.ok = receipt.overallState === 'completed';
  return receipt;
}
function render(receipt: CommandManagementResult): string {
  const lines = [`${receipt.command}: ${receipt.overallState}`];
  for (const command of receipt.commands) lines.push(`${command.id}\t${command.name}\t${command.availability}`, ...(receipt.command === 'command.show' ? [JSON.stringify({ owner: command.owner, resourceRoot: command.resourceRoot, launch: command.launch }, null, 2)] : []));
  for (const pkg of receipt.packages) lines.push(`${pkg.id}\t${pkg.producer.sourceId}/${pkg.producer.pluginName}/${pkg.producer.key}\t${pkg.availability}`);
  for (const change of receipt.changes) lines.push(`${change.action}\t${change.id}`);
  for (const error of receipt.errors) lines.push(`${error.code}: ${error.message}`);
  for (const action of receipt.recoveryActions) lines.push(`Recovery: ${action}`);
  return `${lines.join('\n')}\n`;
}
async function confirm(context: CliExecutionContext, options: Record<string, string | true>, message: string): Promise<void> {
  if (options['--yes']) return;
  if (!context.interactive || !context.prompt.confirm) invalid('This write requires --yes in non-interactive mode.');
  const response = await context.prompt.confirm({ message, defaultValue: false });
  if (response.cancelled || response.value !== true) invalid('The managed command write was not confirmed.');
}

export async function runManagedCommandCli(args: string[], context: CliExecutionContext, host: { cliEntry: string; cliVersion: string }): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // Target arguments belong to the child, including --help.
    const delimiter = args[0] === 'run' ? args.indexOf('--') : -1;
    const helpBeforeDelimiter = delimiter < 0 || args.slice(0, delimiter).some((arg) => arg === '--help' || arg === '-h');
    if (helpBeforeDelimiter) { context.io.stdout(HELP); return 0; }
  }
  if (args[0] === 'run') {
    try {
      if (args[2] !== '--' || !args[1] || !isManagedCommandId(args[1])) invalid('Usage: aw command run <command-id> -- <args...>');
      return await runManagedCommand({ id: args[1], args: args.slice(3), cwd: context.cwd, env: context.env, cliEntry: host.cliEntry });
    } catch (error) {
      const diagnostic = managedCommandDiagnostic(error);
      context.io.stderr(`aw: ${diagnostic.code}: ${diagnostic.message}\n`);
      return error instanceof ManagedCommandError && error.argumentError ? 2 : 1;
    }
  }
  const action = args[0] === 'package' ? `package.${args[1] ?? ''}` : args[0] ?? '';
  const known = ['install', 'update', 'remove', 'list', 'show', 'package.sync', 'package.remove'];
  const command = (known.includes(action) ? `command.${action}` : 'command.list') as CommandManagementResult['command'];
  const receipt = result(command);
  let exitCode = 0;
  try {
    if (!known.includes(action)) invalid('An install, update, remove, list, show, run, or package command is required.');
    const launchFlags = ['--runner', '--entry', '--args-json', '--env-json', '--env-from-json', '--cwd'];
    const allowed = action === 'install' ? ['--name', ...launchFlags, '--yes', '--json']
      : action === 'update' ? ['--from', '--name', ...launchFlags, '--yes', '--json']
        : action === 'remove' ? ['--force', '--yes', '--json']
          : action.startsWith('package.') ? ['--scope', '--force', '--yes', '--json'].filter((flag) => action === 'package.remove' || flag !== '--force')
            : ['--json'];
    const { positionals, options } = parseOptions(args.slice(action.startsWith('package.') ? 2 : 1), allowed);
    if (action === 'list') {
      if (positionals.length) invalid('list does not accept positional arguments.');
      Object.assign(receipt, await listManagedCommands(context.env));
    } else if (action === 'show') {
      if (positionals.length !== 1 || !isManagedCommandId(positionals[0])) invalid('show requires one canonical command ID.');
      const commandView = await inspectManagedCommand(positionals[0]!, context.env);
      receipt.commands = [commandView];
      if (commandView.owner.kind === 'plugin' && commandView.owner.producer.kind === 'package') {
        const id = getCommandPackageId(commandView.owner.producer);
        const packages = await listManagedCommandPackages(context.env);
        receipt.packages = packages.packages.filter((pkg) => pkg.id === id);
        receipt.errors.push(...packages.errors.filter((error) => error.subject === `commands/packages/${id}`));
      }
    } else {
      // Parse every argument before confirmation and before the mutation lock creates state.
      const launch = action === 'install' || action === 'update' ? launchOptions(options, action === 'install') : undefined;
      if (action === 'install' || action === 'update' || action === 'remove') {
        if (positionals.length !== 1) invalid(`${action} requires exactly one positional argument.`);
        if (action !== 'install') assertUserCommandId(positionals[0]!);
        if (action === 'install' || options['--name'] !== undefined) validateManagedCommandName(textOption(options, '--name', action === 'install'));
        if (action === 'update') textOption(options, '--from', true);
      }
      const exactPackage = action === 'package.remove' && positionals.length === 1 && /^pkg_[0-9a-f]{64}$/u.test(positionals[0]!);
      if (action.startsWith('package.')) {
        if (exactPackage && options['--scope'] !== undefined) invalid('Exact package removal does not accept --scope.');
        if (!exactPackage && (positionals.length !== 2 || positionals[0]!.split('/').length !== 2 || !['user', 'project'].includes(textOption(options, '--scope', true)!))) invalid('Package selection requires source/plugin, package-key, and --scope user|project.');
      }
      const execute = async (): Promise<void> => {
        if (action === 'install') {
          const id = await installUserCommand({ sourceDirectory: path.resolve(context.cwd, positionals[0]!), name: textOption(options, '--name', true)!, launch: launch as CommandLaunch, env: context.env });
          receipt.commands = [await inspectManagedCommand(id, context.env)];
          receipt.changes.push({ kind: 'command', id, action: 'created' });
        } else if (action === 'update') {
          const id = positionals[0]!;
          const updated = await updateUserCommand({ id, sourceDirectory: path.resolve(context.cwd, textOption(options, '--from', true)!), name: textOption(options, '--name'), launch, env: context.env });
          receipt.errors.push(...updated.errors);
          receipt.recoveryActions.push(...updated.recoveryActions);
          receipt.commands = [await inspectManagedCommand(id, context.env)];
          receipt.changes.push({ kind: 'command', id, action: 'updated' });
        } else if (action === 'remove') {
          const id = positionals[0]!;
          await removeUserCommand(id, context.env);
          receipt.changes.push({ kind: 'command', id, action: 'removed' });
        } else if (exactPackage) {
          const id = positionals[0]!;
          const removed = await removeManagedCommandPackage(id, context.env);
          receipt.changes.push({ kind: 'package', id, action: 'removed' }, ...removed.removedCommandIds.map((commandId) => ({ kind: 'command' as const, id: commandId, action: 'removed' as const })));
        } else {
          await withResolvedCatalogPlugin({ selector: positionals[0]!, cliVersion: host.cliVersion, env: context.env, consume: async ({ plugin }) => {
            const scope = textOption(options, '--scope', true)! as 'user' | 'project';
            if (action === 'package.sync') {
              const synced = await syncPluginManagedCommandPackage({ plugin, packageKey: positionals[1]!, scope, cwd: context.cwd, env: context.env });
              receipt.errors.push(...synced.errors);
              receipt.recoveryActions.push(...synced.recoveryActions);
              if (synced.state !== 'completed') receipt.overallState = synced.state;
              receipt.changes.push({ kind: 'package', id: getCommandPackageId(synced.producer), action: 'updated' }, ...synced.commandIds.map((id) => ({ kind: 'command' as const, id, action: 'updated' as const })), ...synced.removedCommandIds.map((id) => ({ kind: 'command' as const, id, action: 'removed' as const })));
              for (const id of synced.commandIds) receipt.commands.push(await inspectManagedCommand(id, context.env));
              receipt.packages = (await listManagedCommandPackages(context.env)).packages.filter((pkg) => pkg.id === getCommandPackageId(synced.producer));
            } else {
              let projectRoot = scope === 'project' ? path.normalize(await fs.realpath(await resolveRepoRoot(context.cwd))) : null;
              if (projectRoot && process.platform === 'win32') projectRoot = projectRoot.replace(/^[a-z]:/u, (drive) => drive.toUpperCase());
              const inventory = await listManagedCommandPackages(context.env);
              const candidates = inventory.packages.filter((pkg) => pkg.producer.sourceId === plugin.sourceId && pkg.producer.sourceIdentity === plugin.sourceIdentity && pkg.producer.pluginName === plugin.manifest.name && pkg.producer.key === positionals[1] && pkg.producer.scope === scope && pkg.producer.projectRoot === projectRoot);
              if (candidates.length !== 1) throw new ManagedCommandError('commandIdentityConflict', `Package selection did not match exactly one owned package. Candidate IDs: ${candidates.map((pkg) => pkg.id).join(', ') || 'none'}. Use exact package remove.`);
              const id = candidates[0]!.id;
              const removed = await removeManagedCommandPackage(id, context.env);
              receipt.changes.push({ kind: 'package', id, action: 'removed' }, ...removed.removedCommandIds.map((commandId) => ({ kind: 'command' as const, id: commandId, action: 'removed' as const })));
            }
          } });
        }
      };
      let message = `Apply ${command}?`;
      if (exactPackage) {
        const owner = await readManagedCommandPackageOwner(positionals[0]!, context.env);
        message += ` Producer: ${JSON.stringify(owner.producer)}. All commands in this package will become unavailable.`;
      }
      await confirm(context, options, message);
      await withAwHomeMutationLock({ env: context.env, action: execute });
    }
  } catch (error) {
    const safeError = error instanceof ManagedCommandError ? error : sanitizeCatalogSourceError(error, context.env, [context.cwd]);
    receipt.errors.push(error instanceof ManagedCommandError ? managedCommandDiagnostic(error) : { code: safeError.code, message: safeError.message });
    if (!(error instanceof ManagedCommandError && error.argumentError) && receipt.recoveryActions.length === 0) {
      receipt.recoveryActions.push(action === 'install' ? 'Correct the tool directory and retry command install.' : action.startsWith('package.') ? 'Use command list to inspect package IDs, then use package sync or exact package remove.' : 'Use command list to inspect ownership, then update or safely remove the affected user command.');
    }
    receipt.overallState = receipt.changes.length ? 'partial' : 'failed';
    exitCode = error instanceof ManagedCommandError && error.argumentError ? 2 : 1;
  }
  finish(receipt);
  context.io.stdout(args.includes('--json') ? `${JSON.stringify(receipt)}\n` : render(receipt));
  return exitCode || (receipt.ok ? 0 : 1);
}

export function registerManagedCommandCli(program: Command, context: () => CliExecutionContext, host: { cliEntry: string; cliVersion: string }, setExitCode: (code: number) => void): void {
  program.enablePositionalOptions();
  program.command('command [arguments...]').description('Install, inspect, and run managed commands')
    .allowUnknownOption(true).allowExcessArguments(true).passThroughOptions()
    .addHelpText('after', HELP)
    .action(async (args: string[]) => { setExitCode(await runManagedCommandCli(args, context(), host)); });
}
