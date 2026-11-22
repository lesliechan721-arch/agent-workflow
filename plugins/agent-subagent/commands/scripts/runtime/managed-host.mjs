import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { absolutePath, fail, object, text } from './contracts.mjs';

export const isPluginCommandSelector = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
export const isUserCommandId = (value) => typeof value === 'string' && /^cmdu_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export const isCommandSubcommand = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value);

const sha256 = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
const unavailable = () => fail('managedCommandUnavailable', 'The installed managed command could not be verified. Sync or reinstall the original producer.');

export async function validateCommandHost(environment) {
  const raw = environment.AW_COMMAND_HOST;
  if (raw === undefined) fail('managedCommandHostMissing', 'Start this executor through the generated AW command to supply its managed command host.');
  let host;
  try {
    host = JSON.parse(raw);
    if (!host || Array.isArray(host) || Object.keys(host).length !== 4 || host.schemaVersion !== 1 ||
      !['nodeExecutable', 'cliEntry', 'awHome'].every((key) => typeof host[key] === 'string' && host[key].isWellFormed() && !host[key].includes('\0') && path.isAbsolute(host[key])) ||
      host.awHome !== environment.AW_HOME) throw new Error();
    const [cli, home] = await Promise.all([fs.lstat(host.cliEntry), fs.stat(host.awHome)]);
    if (!cli.isFile() || cli.isSymbolicLink() || !home.isDirectory()) throw new Error();
    await fs.access(host.cliEntry, constants.R_OK);
    const node = await fs.stat(host.nodeExecutable);
    if (!node.isFile()) throw new Error();
    await fs.access(host.nodeExecutable, constants.X_OK);
  } catch { fail('managedCommandHostInvalid', 'The managed command host is invalid. Use the generated AW command with its fixed AW_HOME.'); }
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
  const [sourceId, pluginName] = selector.split('/');
  const { owner, pluginVersion, sourceContentDigest, routes } = result;
  const sourceIdentity = owner?.producer?.sourceIdentity;
  if (result.selector !== selector || owner?.kind !== 'plugin' ||
    !sha256(sourceIdentity) || !isDeepStrictEqual(owner.producer, { sourceId, sourceIdentity, pluginName }) ||
    !text(pluginVersion) || !pluginVersion || !sha256(sourceContentDigest) || !Array.isArray(routes?.subcommands)) unavailable();
  const names = routes.subcommands.map((route) => route?.name);
  if (!names.every(isCommandSubcommand) || new Set(names).size !== names.length) unavailable();
}

export async function managedLaunch(host, commandId, environment, workspace, subcommand) {
  const user = isUserCommandId(commandId);
  if ((!user && !isPluginCommandSelector(commandId)) || (subcommand !== undefined && !isCommandSubcommand(subcommand))) {
    fail('executorInvalid', 'Use a source/plugin selector or a user command ID and a valid optional subcommand.');
  }
  const result = await inspectCommand(host, commandId, environment, workspace);
  const { owner, resourceRoot } = result;
  if (user) {
    if (result.id !== commandId || owner?.kind !== 'user' || result.availability !== 'ready') unavailable();
    if (subcommand !== undefined) fail('executorInvalid', 'A user command ID cannot have a subcommand.');
    return { id: commandId, owner, resourceRoot, route: { kind: 'user' }, launch: launchDefinition(result.launch) };
  }

  verifyPluginCommand(result, commandId);
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

async function inspectCommand(host, selector, environment, workspace) {
  return await new Promise((resolve, reject) => {
    const child = spawn(host.nodeExecutable, [host.cliEntry, 'command', 'show', selector, '--json'], {
      cwd: workspace, env: { ...environment, AW_HOME: host.awHome, AW_COMMAND_HOST: JSON.stringify(host) },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
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
  }).catch(unavailable);
}

export async function resolveCommunicationLaunch(selected, host, environment, workspace) {
  const { sourceId, pluginName, pluginId, sourceIdentity, pluginVersion, sourceContentDigest, platform } = selected.installedIdentity;
  if (pluginName !== 'agent-subagent' || !['codex', 'claude'].includes(platform) ||
    pluginId !== sourceId + '/' + pluginName || !isPluginCommandSelector(pluginId)) unavailable();
  const result = await inspectCommand(host, pluginId, environment, workspace);
  verifyPluginCommand(result, pluginId);
  const launch = { runner: 'node', entry: 'scripts/message.mjs', args: [], env: {}, envFrom: {}, cwd: 'caller' };
  const message = result.routes.subcommands.find((route) => route.name === 'message');
  if (result.availability !== 'ready' || result.owner.producer.sourceIdentity !== sourceIdentity ||
    result.pluginVersion !== pluginVersion || result.sourceContentDigest !== sourceContentDigest ||
    result.resourceRoot !== selected.resourceRoot || result.routes.fallback !== undefined ||
    !isDeepStrictEqual(message, { name: 'message', ...launch })) unavailable();
  return { selector: pluginId, owner: result.owner, pluginVersion, sourceContentDigest, launch };
}

export function communicationEnvironment(host, binding) {
  return { AW_COMMAND_HOST: JSON.stringify(host), AW_HOME: host.awHome,
    AW_SUBAGENT_COMMUNICATION_COMMAND: JSON.stringify({
      command: host.nodeExecutable, args: [host.cliEntry, 'command', 'run', binding.selector, '--', 'message'],
    }) };
}

export function isCommunicationCommandArgs(args) {
  return Array.isArray(args) && args.length === 6 && args[1] === 'command' && args[2] === 'run' &&
    isPluginCommandSelector(args[3]) && args[4] === '--' && args[5] === 'message';
}

/** Internal launch context; the public Adapter v5 request remains unchanged. */
export async function communicationCommand(environment) {
  const host = await validateCommandHost(environment);
  let binding;
  try { binding = JSON.parse(environment.AW_SUBAGENT_COMMUNICATION_COMMAND); } catch {}
  if (!object(binding) || Object.keys(binding).length !== 2 || binding.command !== host.nodeExecutable ||
    !isCommunicationCommandArgs(binding.args) || binding.args[0] !== host.cliEntry)
    fail('managedCommandUnavailable', 'The Guide communication command context is missing or invalid. Start through the generated AW command; sync or reinstall if needed.');
  return binding;
}
