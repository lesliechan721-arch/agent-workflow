import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { absolutePath, fail, NATIVE_PLATFORMS, object, text } from './contracts.mjs';

function parsePluginSelector(value) {
  if (typeof value !== 'string') return;
  const match = /^([a-z][a-z0-9-]{0,31}\/[a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([a-z]+))?$/u.exec(value);
  if (!match || match[2] && !NATIVE_PLATFORMS.includes(match[2])) return;
  return { packageSelector: match[1], platform: match[2] };
}

export const isPluginCommandSelector = (value) => parsePluginSelector(value) !== undefined;
export const isUserCommandId = (value) => typeof value === 'string' && /^cmdu_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export const isCommandSubcommand = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value);

const sha256 = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
const unavailable = () => fail('managedCommandUnavailable', 'The installed managed command could not be verified. Sync or reinstall the original producer.');
const invalidHost = () => fail('managedCommandHostInvalid', 'The managed command host is invalid. Use the generated AW command with its fixed AW_HOME.');

export async function validateCommandHost(environment) {
  const raw = environment.AW_COMMAND_HOST;
  if (raw === undefined) fail('managedCommandHostMissing', 'Start this executor through the generated AW command to supply its managed command host.');
  let host;
  try { host = JSON.parse(raw); } catch { invalidHost(); }
  if (host?.awHome !== environment.AW_HOME) invalidHost();
  return validateCommandHostCoordinates(host);
}

export async function validateCommandHostCoordinates(host) {
  try {
    if (!object(host) || Object.keys(host).length !== 4 || host.schemaVersion !== 1 ||
      !['nodeExecutable', 'cliEntry', 'awHome'].every((key) => typeof host[key] === 'string' && host[key].isWellFormed() && !host[key].includes('\0') && path.isAbsolute(host[key]))) throw new Error();
    const [cli, home] = await Promise.all([fs.lstat(host.cliEntry), fs.stat(host.awHome)]);
    if (!cli.isFile() || cli.isSymbolicLink() || !home.isDirectory()) throw new Error();
    await fs.access(host.cliEntry, constants.R_OK);
    const node = await fs.stat(host.nodeExecutable);
    if (!node.isFile()) throw new Error();
    await fs.access(host.nodeExecutable, constants.X_OK);
  } catch { invalidHost(); }
  return host;
}

function launchDefinition(launch) {
  if (!object(launch) || !['node', 'executable'].includes(launch.runner) || !text(launch.entry) || !launch.entry ||
    !Array.isArray(launch.args) || !launch.args.every(text) ||
    !object(launch.env) || !Object.values(launch.env).every(text) ||
    !object(launch.envFrom) || !Object.values(launch.envFrom).every(text) ||
    !['caller', 'resource'].includes(launch.cwd)) unavailable();
  const { runner, entry, args, env, envFrom, cwd } = launch;
  return { runner, entry, args, env, envFrom, cwd };
}

function verifyPluginCommand(result, selector) {
  const { packageSelector } = parsePluginSelector(selector);
  const [sourceId, pluginName] = packageSelector.split('/');
  const { owner, pluginVersion, sourceContentDigest, routes } = result;
  const sourceIdentity = owner?.producer?.sourceIdentity;
  if (result.selector !== packageSelector || owner?.kind !== 'plugin' ||
    typeof result.requiresPlatformContext !== 'boolean' ||
    !sha256(sourceIdentity) || !isDeepStrictEqual(owner.producer, { sourceId, sourceIdentity, pluginName }) ||
    !text(pluginVersion) || !pluginVersion || !sha256(sourceContentDigest) || !Array.isArray(routes?.subcommands)) unavailable();
  const names = routes.subcommands.map((route) => route?.name);
  if (!names.every(isCommandSubcommand) || new Set(names).size !== names.length) unavailable();
}

export async function managedLaunch(host, commandId, environment, workspace, subcommand, { signal } = {}) {
  const user = isUserCommandId(commandId);
  if ((!user && !isPluginCommandSelector(commandId)) || (subcommand !== undefined && !isCommandSubcommand(subcommand))) {
    fail('executorInvalid', 'Use a source/plugin selector or a user command ID and a valid optional subcommand.');
  }
  const result = await inspectCommand(host, user ? commandId : parsePluginSelector(commandId).packageSelector, environment, workspace, signal);
  const { owner, resourceRoot } = result;
  if (user) {
    if (result.id !== commandId || owner?.kind !== 'user' || result.availability !== 'ready') unavailable();
    if (subcommand !== undefined) fail('executorInvalid', 'A user command ID cannot have a subcommand.');
    return { id: commandId, owner, resourceRoot, route: { kind: 'user' }, launch: launchDefinition(result.launch) };
  }

  verifyPluginCommand(result, commandId);
  const { platform } = parsePluginSelector(commandId);
  if (!platform && result.requiresPlatformContext) {
    fail('executorInvalid', 'Append /<platform> to commandId using a platform published by this managed command.', ['config', 'sync']);
  }
  if (platform && (!result.requiresPlatformContext || !Array.isArray(result.runtimeConfigPlatforms) || !result.runtimeConfigPlatforms.includes(platform))) {
    fail('executorInvalid', 'Match the command selector to its published platform configuration.', ['config', 'sync']);
  }
  const { routes, pluginVersion, sourceContentDigest } = result;
  const launch = subcommand === undefined ? routes.fallback : routes.subcommands.find((route) => route.name === subcommand);
  if (launch === undefined) {
    const available = routes.subcommands.map((route) => route.name).join(', ') || 'none';
    const reason = subcommand === undefined ? 'This plugin command has no fallback. Set subcommand.' : 'The configured subcommand is not installed.';
    fail('executorInvalid', reason + ' Available subcommands: ' + available + '.', ['config', 'sync']);
  }
  const route = subcommand === undefined ? { kind: 'fallback' } : { kind: 'subcommand', name: subcommand };
  return { id: commandId, owner, route, launch: launchDefinition(launch), pluginVersion, sourceContentDigest };
}

export function managedCommandInvocation(host, binding) {
  const tail = binding.route.kind === 'subcommand' ? ['--no-fallback', '--', binding.route.name] : ['--'];
  return { command: host.nodeExecutable, args: [host.cliEntry, 'command', 'run', binding.id, ...tail] };
}

async function inspectCommand(host, selector, environment, workspace, signal) {
  return await new Promise((resolve, reject) => {
    const child = spawn(host.nodeExecutable, [host.cliEntry, 'command', 'show', selector, '--json'], {
      cwd: workspace, env: { ...environment, AW_HOME: host.awHome, AW_COMMAND_HOST: JSON.stringify(host) },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, signal,
    });
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Command inspection timed out.')); }, 10000);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { child.kill(); reject(new Error('Command inspection exceeded its limit.')); }
      else chunks.push(chunk);
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0 || value.schemaVersion !== 2 || value.command !== 'command.show' || value.status !== 'success' ||
          !Array.isArray(value.data?.commands) || value.data.commands.length !== 1) throw new Error();
        const result = value.data.commands[0];
        if (!object(result) || !absolutePath(result.resourceRoot) || !['ready', 'empty'].includes(result.availability)) throw new Error();
        resolve(result);
      } catch { reject(new Error('Command inspection failed.')); }
    });
  }).catch(() => {
    signal?.throwIfAborted();
    unavailable();
  });
}

export async function resolveCommunicationLaunch(selected, host, environment, workspace) {
  const { sourceId, pluginName, pluginId, sourceIdentity, pluginVersion, sourceContentDigest, platform } = selected.installedIdentity;
  if (pluginName !== 'agent-subagent' || !NATIVE_PLATFORMS.includes(platform) ||
    pluginId !== sourceId + '/' + pluginName || !isPluginCommandSelector(pluginId)) unavailable();
  const result = await inspectCommand(host, pluginId, environment, workspace);
  const selector = pluginId + '/' + platform;
  verifyPluginCommand(result, selector);
  const launch = { runner: 'node', entry: 'scripts/message.mjs', args: [], env: {}, envFrom: {}, cwd: 'caller' };
  const message = result.routes.subcommands.find((route) => route.name === 'message');
  if (result.availability !== 'ready' || result.requiresPlatformContext !== true || !Array.isArray(result.runtimeConfigPlatforms)
    || !result.runtimeConfigPlatforms.includes(platform) || result.owner.producer.sourceIdentity !== sourceIdentity ||
    result.pluginVersion !== pluginVersion || result.sourceContentDigest !== sourceContentDigest ||
    result.resourceRoot !== selected.resourceRoot || result.routes.fallback !== undefined ||
    !isDeepStrictEqual(message, { name: 'message', ...launch })) unavailable();
  return { selector, owner: result.owner, pluginVersion, sourceContentDigest, launch };
}

export function communicationEnvironment(host, binding) {
  return { AW_COMMAND_HOST: JSON.stringify(host), AW_HOME: host.awHome,
    AW_SUBAGENT_COMMUNICATION_COMMAND: JSON.stringify({
      command: host.nodeExecutable, args: [host.cliEntry, 'command', 'run', binding.selector, '--', 'message'],
    }) };
}

export function isCommunicationCommandArgs(args) {
  if (!Array.isArray(args) || args.length !== 6 || args[1] !== 'command' || args[2] !== 'run') return false;
  const binding = parsePluginSelector(args[3]);
  return Boolean(binding?.platform) && binding.packageSelector.endsWith('/agent-subagent') && args[4] === '--' && args[5] === 'message';
}

/** Read the bridge invocation that the parent verified for this run. */
export async function communicationCommand(environment) {
  const host = await validateCommandHost(environment);
  let binding;
  try { binding = JSON.parse(environment.AW_SUBAGENT_COMMUNICATION_COMMAND); } catch {}
  if (!object(binding) || Object.keys(binding).length !== 2 || binding.command !== host.nodeExecutable ||
    !isCommunicationCommandArgs(binding.args) || binding.args[0] !== host.cliEntry)
    fail('managedCommandUnavailable', 'The Guide communication command context is missing or invalid. Start through the generated AW command; sync or reinstall if needed.');
  return binding;
}
