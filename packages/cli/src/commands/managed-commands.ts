import type { Confirmation } from '../output/public-result.js';
import path from 'node:path';

import type { Command } from 'commander';
import { canonicalizeIdentityValue, type CommandLaunch } from '@lesliechan721/aw-plugin-core/manifest';

import type { CliExecutionContext } from './runtime.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { withResolvedCatalogPlugin } from '../utils/multi-source-catalog.js';
import { sanitizeCatalogSourceError } from '../utils/catalog-public-error.js';
import { describeNativeToolClosure, type NativeToolChange } from '../utils/native-tool-review.js';
import { prepareManagedCommandPackage, publishPreparedManagedCommandPackage } from '../utils/managed-command-materialization.js';
import {
  describeManagedCommandRouteReview,
  describeManagedCommandRuntimeConfigChanges,
  inspectManagedCommandRouteChanges, reviewInstalledInvocationPlatforms, reviewInvocationPlatforms,
  type ManagedCommandRouteReview,
} from '../utils/managed-command-cli-review.js';
import { runManagedCommand } from '../utils/managed-command-runtime.js';
import {
  ManagedCommandError,
  assertUserCommandId,
  captureManagedCommandPackageEvidence,
  inspectManagedCommand,
  installUserCommand,
  isManagedCommandPackageId,
  isUserCommandId,
  listManagedCommands,
  managedCommandDiagnostic,
  parseManagedCommandLaunch,
  parsePluginCommandSelector,
  readManagedCommandPackageView,
  removeManagedCommandPackage,
  removeUserCommand,
  resolveManagedCommandPackageId,
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
  orphanedPackages: ManagedCommandPackageView[];
  changes: Array<{ kind: 'command' | 'package'; id: string; action: 'created' | 'updated' | 'removed' | 'retained' }>;
  errors: ManagedCommandDiagnostic[];
  recoveryActions: string[];
  nativeToolChanges?: NativeToolChange[];
  packageReview?: ManagedCommandRouteReview & {
    runtimeConfigChanges?: Awaited<ReturnType<typeof prepareManagedCommandPackage>>['runtimeConfigChanges'];
  };
  confirmation?: Confirmation | null;
}

const HELP = `Usage:
  aw command install <directory> --name <name> --runner node|executable --entry <relative-file> [--args-json <json>] [--env-json <json>] [--env-from-json <json>] [--cwd caller|resource] [--yes] [--json]
  aw command update <cmdu-id> --from <directory> [--name <name>] [--runner node|executable] [--entry <relative-file>] [--args-json <json>] [--env-json <json>] [--env-from-json <json>] [--cwd caller|resource] [--yes] [--json]
  aw command remove <cmdu-id> [--force] [--yes] [--json]
  aw command list [--json]
  aw command show <source/plugin | cmdu-id> [--json]
  aw command run <source/plugin> [--no-fallback] -- [args...]
  aw command run <source/plugin/platform> [--no-fallback] -- [args...]
  aw command run <cmdu-id> -- [args...]
  aw command package sync <source/plugin> [--yes] [--json]
  aw command package remove <source/plugin | pkg-id> [--force] [--yes] [--json]
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
  return { schemaVersion: 1, command, ok: true, overallState: 'completed', commands: [], packages: [], orphanedPackages: [], changes: [], errors: [], recoveryActions: [] };
}
function finish(receipt: CommandManagementResult): CommandManagementResult {
  const views = [...receipt.commands, ...receipt.packages, ...receipt.orphanedPackages];
  receipt.errors.push(...views.flatMap((view) => view.errors));
  receipt.recoveryActions = [...new Set([...receipt.recoveryActions, ...views.flatMap((view) => view.recoveryActions)])];
  if (receipt.errors.length > 0 && receipt.overallState === 'completed') receipt.overallState = views.length || receipt.changes.length ? 'partial' : 'failed';
  receipt.ok = receipt.overallState === 'completed';
  return receipt;
}
function render(receipt: CommandManagementResult): string {
  const lines = [`${receipt.command}: ${receipt.overallState}`];
  for (const command of receipt.commands) {
    lines.push(`${'selector' in command ? command.selector : command.id}\t${command.availability}`);
    if (receipt.command === 'command.show') lines.push(JSON.stringify(command, null, 2));
  }
  for (const change of receipt.nativeToolChanges ?? []) for (const phase of ['before', 'after'] as const) if (change[phase]) lines.push(...describeNativeToolClosure(change[phase]!).map((description) => `原生工具 ${change.producer.sourceId}/${change.producer.pluginName} ${phase}: ${description}`));
  for (const pkg of receipt.packages) lines.push(`${pkg.selector}\t${pkg.packageId}\t${pkg.availability}\t${pkg.subcommands.join(', ')}${pkg.hasFallback ? ' (+ fallback)' : ''}`);
  for (const pkg of receipt.orphanedPackages) lines.push(`Orphaned package\t${pkg.packageId}\t${pkg.selector}`);
  if (receipt.packageReview) lines.push(...describeManagedCommandRouteReview(receipt.packageReview),
    ...describeManagedCommandRuntimeConfigChanges(receipt.packageReview.runtimeConfigChanges ?? []));
  for (const change of receipt.changes) lines.push(`${change.action}\t${change.id}`);
  for (const error of receipt.errors) lines.push(`${error.code}: ${error.message}`);
  for (const action of receipt.recoveryActions) lines.push(`Recovery: ${action}`);
  return `${lines.join('\n')}\n`;
}

async function confirm(context: CliExecutionContext, options: Record<string, string | true>, message: string): Promise<void> {
  if (options['--yes']) return;
  if (!context.interactive || !context.prompt.confirm) throw new ManagedCommandError('confirmationRequired', 'This operation requires --yes.');
  const response = await context.prompt.confirm({ message, defaultValue: false });
  if (response.cancelled || response.value !== true) invalid('The managed command write was not confirmed.');
}

function nativeToolChange(receipt: CommandManagementResult, change: NativeToolChange): string[] {
  if (canonicalizeIdentityValue(change.before) === canonicalizeIdentityValue(change.after)) return [];
  receipt.nativeToolChanges = [change];
  return (['before', 'after'] as const).flatMap((phase) => {
    const closure = change[phase];
    return closure ? describeNativeToolClosure(closure).map((line) => `Native tool ${phase}: ${line}`) : [];
  });
}

function setConfirmation(receipt: CommandManagementResult, options: Record<string, string | true>, selector: string, message: string): void {
  const required = receipt.command !== 'command.install';
  const packageOperation = receipt.command.startsWith('command.package.');
  receipt.confirmation = {
    required,
    provided: options['--yes'] === true,
    effects: required ? [{
      code: receipt.command.endsWith('.remove') ? 'removeOwnedOutput' : 'replaceSharedOutput',
      message,
      impact: packageOperation ? 'shared' : 'user-wide',
      ...(packageOperation && !isManagedCommandPackageId(selector) ? { subject: { pluginId: selector } } : {}),
    }] : [],
  };
}

async function syncPackage(options: {
  selector: string;
  cliVersion: string;
  context: CliExecutionContext;
  flags: Record<string, string | true>;
  receipt: CommandManagementResult;
}): Promise<void> {
  const { selector, cliVersion, context, flags, receipt } = options;
  const lookup = { selector, cliVersion, env: context.env, signal: context.signal };
  await withResolvedCatalogPlugin({ ...lookup, consume: async ({ plugin }) => {
    if (!plugin.manifest.command) {
      receipt.recoveryActions.push(`aw command package remove ${selector} --yes`, `aw plugin sync ${selector}`);
      throw new ManagedCommandError('commandPackageDeclarationMissing', 'The Active Catalog plugin has no command declaration. Remove its package explicitly or synchronize the plugin.');
    }
    const prepare = { cwd: context.cwd, env: context.env, signal: context.signal };
    const candidate = await prepareManagedCommandPackage({ ...prepare, plugin, operation: { kind: 'explicit-sync' } });
    try {
      const reviewInput = { ...prepare, selector, inspectInactiveRestrictions: true, before: candidate.previous?.record.routes, beforePlatforms: reviewInvocationPlatforms(candidate.previous?.record), after: candidate.record.routes, afterPlatforms: reviewInvocationPlatforms(candidate.record) };
      const routeReview = await inspectManagedCommandRouteChanges(reviewInput);
      const packageReview = { ...routeReview, runtimeConfigChanges: candidate.runtimeConfigChanges };
      receipt.packageReview = packageReview;
      const native = nativeToolChange(receipt, {
        producer: candidate.record.producer,
        before: candidate.previous?.record.nativeTools ?? null,
        after: candidate.record.nativeTools ?? null,
      });
      const message = `Synchronize the shared command package for ${selector}?`;
      setConfirmation(receipt, flags, selector, message);
      await confirm(context, flags, [message, ...describeManagedCommandRouteReview(packageReview),
        ...describeManagedCommandRuntimeConfigChanges(packageReview.runtimeConfigChanges), ...native].join('\n'));

      await withAwHomeMutationLock({ env: context.env, signal: context.signal, action: async () => {
        let found = false;
        try {
          await withResolvedCatalogPlugin({ ...lookup, consume: async ({ plugin: currentPlugin }) => {
            found = true;
            if (!currentPlugin.manifest.command) {
              throw new ManagedCommandError('operationReviewStale', 'The Active Catalog plugin changed. Review the package again.');
            }
            if (canonicalizeIdentityValue(await inspectManagedCommandRouteChanges(reviewInput)) !== canonicalizeIdentityValue(routeReview)) {
              throw new ManagedCommandError('operationReviewStale', 'The visible permission impact changed. Review the package again.');
            }
            const synced = await publishPreparedManagedCommandPackage({ ...prepare, plugin: currentPlugin, candidate });
            const { id } = synced;
            receipt.errors.push(...synced.errors);
            receipt.recoveryActions.push(...synced.recoveryActions);
            receipt.changes.push({ kind: 'package', id, action: candidate.expectedPackage ? 'updated' : 'created' });
            receipt.packages.push(await readManagedCommandPackageView(id, context.env));
          } });
        } catch (error) {
          if (found || context.signal?.aborted) throw error;
          throw new ManagedCommandError('operationReviewStale', 'The Active Catalog plugin changed. Review the package again.');
        }
      } });
    } finally {
      await candidate.cleanup();
    }
  } });
}

async function removePackage(options: {
  selector: string;
  context: CliExecutionContext;
  flags: Record<string, string | true>;
  receipt: CommandManagementResult;
}): Promise<void> {
  const { selector, context, flags, receipt } = options;
  const exact = isManagedCommandPackageId(selector);
  const id = exact ? selector : await resolveManagedCommandPackageId(selector, context.env);
  const view = await readManagedCommandPackageView(id, context.env);
  const force = flags['--force'] === true;
  const expectedPackage = await captureManagedCommandPackageEvidence(view, context.env, { force });
  const currentNamedId = () => resolveManagedCommandPackageId(view.selector, context.env).catch(() => undefined);
  const readRouteImpact = async (namedId: string | undefined) => inspectManagedCommandRouteChanges({
    selector: view.selector,
    before: namedId === id ? view.routes ?? undefined : undefined,
    beforePlatforms: await reviewInstalledInvocationPlatforms(view),
    cwd: context.cwd,
    env: context.env,
  });
  const packageReview = await readRouteImpact(exact ? await currentNamedId() : id);
  receipt.packageReview = packageReview;
  const native = nativeToolChange(receipt, { producer: view.owner.producer, before: view.nativeTools ?? null, after: null });
  const message = `Remove shared command package ${id} for ${view.selector}? Calls to this package will become unavailable.`;
  setConfirmation(receipt, flags, selector, message);
  await confirm(context, flags, [message, ...describeManagedCommandRouteReview(packageReview), ...native].join('\n'));

  await withAwHomeMutationLock({ env: context.env, signal: context.signal, action: async () => {
    const namedId = await currentNamedId();
    if (!exact && namedId !== id) {
      throw new ManagedCommandError('operationReviewStale', 'The Catalog source binding changed. Review the package again.');
    }
    if (canonicalizeIdentityValue(await readRouteImpact(namedId)) !== canonicalizeIdentityValue(packageReview)) {
      throw new ManagedCommandError('operationReviewStale', 'The visible permission impact changed. Review the package again.');
    }
    await removeManagedCommandPackage(id, context.env, { force, expectedPackage });
    receipt.changes.push({ kind: 'package', id, action: 'removed' });
  } });
}

function parseRunArguments(args: string[]): { id: string; args: string[]; noFallback: boolean } {
  const [selector] = args;
  const delimiter = args.indexOf('--');
  const noFallback = delimiter === 2 && args[1] === '--no-fallback';
  if (!selector || (delimiter !== 1 && !noFallback)) invalid('Usage: aw command run <source/plugin[/platform]> [--no-fallback] -- [args...] or aw command run <cmdu-id> -- [args...]');
  return { id: selector, args: args.slice(delimiter + 1), noFallback };
}

export async function runManagedCommandCli(args: string[], context: CliExecutionContext, host: { cliEntry: string; cliVersion: string; onResult?: (receipt: CommandManagementResult) => void }): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    // Target arguments belong to the child, including --help.
    const delimiter = args[0] === 'run' ? args.indexOf('--') : -1;
    const helpBeforeDelimiter = delimiter < 0 || args.slice(0, delimiter).some((arg) => arg === '--help' || arg === '-h');
    if (helpBeforeDelimiter) { context.io.stdout(HELP); return 0; }
  }
  if (args[0] === 'run') {
    try {
      return await runManagedCommand({ ...parseRunArguments(args.slice(1)), cwd: context.cwd, env: context.env, cliEntry: host.cliEntry });
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
        : action === 'remove' || action === 'package.remove' ? ['--force', '--yes', '--json']
          : action === 'package.sync' ? ['--yes', '--json'] : ['--json'];
    const { positionals, options } = parseOptions(args.slice(action.startsWith('package.') ? 2 : 1), allowed);
    const [selector] = positionals;
    if (action === 'list') {
      if (positionals.length) invalid('list does not accept positional arguments.');
      Object.assign(receipt, await listManagedCommands(context.env));
    } else {
      if (!selector || positionals.length !== 1) invalid(`${action} requires exactly one positional argument.`);
      if (action === 'show') {
        if (!isUserCommandId(selector)) parsePluginCommandSelector(selector);
        receipt.commands = [await inspectManagedCommand(selector, context.env)];
      } else if (action === 'package.sync') {
        parsePluginCommandSelector(selector);
        await syncPackage({ selector, cliVersion: host.cliVersion, context, flags: options, receipt });
      } else if (action === 'package.remove') {
        if (!isManagedCommandPackageId(selector)) parsePluginCommandSelector(selector);
        await removePackage({ selector, context, flags: options, receipt });
      } else {
        const launch = action === 'install' || action === 'update' ? launchOptions(options, action === 'install') : undefined;
        if (action !== 'install') assertUserCommandId(selector);
        if (action === 'install' || options['--name'] !== undefined) validateManagedCommandName(textOption(options, '--name', action === 'install'));
        const from = action === 'update' ? textOption(options, '--from', true) : undefined;
        const message = `Apply ${command} to ${selector}?`;
        setConfirmation(receipt, options, selector, message);
        if (receipt.confirmation?.required) await confirm(context, options, message);

        await withAwHomeMutationLock({ env: context.env, signal: context.signal, action: async () => {
          if (action === 'install') {
            const id = await installUserCommand({ sourceDirectory: path.resolve(context.cwd, selector),
              name: textOption(options, '--name', true)!, launch: launch as CommandLaunch, env: context.env });
            receipt.commands = [await inspectManagedCommand(id, context.env)];
            receipt.changes.push({ kind: 'command', id, action: 'created' });
          } else if (action === 'update') {
            const updated = await updateUserCommand({ id: selector, sourceDirectory: path.resolve(context.cwd, from!),
              name: textOption(options, '--name'), launch, env: context.env });
            receipt.errors.push(...updated.errors);
            receipt.recoveryActions.push(...updated.recoveryActions);
            receipt.commands = [await inspectManagedCommand(selector, context.env)];
            receipt.changes.push({ kind: 'command', id: selector, action: 'updated' });
          } else {
            await removeUserCommand(selector, context.env);
            receipt.changes.push({ kind: 'command', id: selector, action: 'removed' });
          }
        } });
      }
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
  if (host.onResult) host.onResult(receipt);
  else context.io.stdout(args.includes('--json') ? `${JSON.stringify(receipt)}\n` : render(receipt));
  return exitCode || (receipt.ok ? 0 : 1);
}

export function registerManagedCommandCli(program: Command, context: (options?: { verbose?: boolean; debug?: boolean; logFile?: string }) => CliExecutionContext, host: { cliEntry: string; cliVersion: string }, setExitCode: (code: number) => void): void {
  const group = program.command('command').description('Install, inspect, and run managed commands');
  const packages = group.command('package').description('Manage plugin command packages');
  const launch = ['--runner <runner>', '--entry <file>', '--args-json <json>', '--env-json <json>', '--env-from-json <json>', '--cwd <mode>'];
  const entries: Array<{ parent: Command; name: string; args: string; flags: string[] }> = [
    { parent: group, name: 'install', args: '<directory>', flags: ['--name <name>', ...launch, '--yes'] },
    { parent: group, name: 'update', args: '<id>', flags: ['--from <directory>', '--name <name>', ...launch, '--yes'] },
    { parent: group, name: 'remove', args: '<id>', flags: ['--force', '--yes'] },
    { parent: group, name: 'list', args: '', flags: [] },
    { parent: group, name: 'show', args: '<selector>', flags: [] },
    { parent: packages, name: 'sync', args: '<source/plugin>', flags: ['--yes'] },
    { parent: packages, name: 'remove', args: '<selector>', flags: ['--force', '--yes'] },
  ];
  for (const entry of entries) {
    const cmd = entry.parent.command(entry.name);
    if (entry.args) cmd.arguments(entry.args);
    for (const flag of entry.flags) cmd.option(flag, `Set ${flag.split(' ')[0]!.slice(2)}`);
    cmd.option('-j, --json', 'Output JSON').action(async (...args: unknown[]) => {
      const current = args.at(-1) as Command;
      const tokens = [...(entry.parent === packages ? ['package'] : []), entry.name, ...current.args];
      for (const option of current.options) {
        if (['verbose', 'debug', 'logFile'].includes(option.attributeName())) continue;
        const value = current.getOptionValue(option.attributeName());
        if (value === undefined || value === false) continue;
        tokens.push(option.long!);
        if (value !== true) tokens.push(String(value));
      }
      const execution = context(current.opts());
      setExitCode(await runManagedCommandCli(tokens, execution, { ...host, onResult: execution.io.result }));
    });
  }
  group.command('run').description('Run a managed command with byte and exit-code passthrough')
    .argument('<selector>', 'source/plugin, source/plugin/platform when runtime config is required, or a user command ID')
    .option('--no-fallback', 'Require a named plugin subcommand')
    .argument('[args...]', 'Target arguments after the required -- separator').allowUnknownOption(true)
    .action(async (_id: string, _args: string[], cmd: Command) => {
      setExitCode(await runManagedCommandCli(['run', ...cmd.args], context(), host));
    });
}
