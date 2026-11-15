import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fail } from './contracts.mjs';

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

export async function managedLaunch(host, commandId, environment, workspace) {
  const value = await inspectCommands(host, ['show', commandId], environment, workspace);
  if (value.commands.length !== 1) fail('managedCommandUnavailable', 'The managed command binding is unavailable. Sync or reinstall the original producer.');
  const result = value.commands[0];
  const launch = result.launch;
  if (result.id !== commandId || result.availability !== 'ready' || !path.isAbsolute(result.resourceRoot ?? '') ||
    !result.owner || !['user', 'plugin'].includes(result.owner.kind) || !launch ||
    !['node', 'executable'].includes(launch.runner) || typeof launch.entry !== 'string' || !launch.entry ||
    !Array.isArray(launch.args) || launch.args.some((value) => typeof value !== 'string') ||
    !launch.env || typeof launch.env !== 'object' || Array.isArray(launch.env) ||
    !launch.envFrom || typeof launch.envFrom !== 'object' || Array.isArray(launch.envFrom) ||
    !['caller', 'resource'].includes(launch.cwd)) fail('managedCommandUnavailable', 'The original managed command has no complete launch definition.');
  return { id: result.id, owner: result.owner, resourceRoot: result.resourceRoot,
    launch: { runner: launch.runner, entry: launch.entry, args: launch.args, env: launch.env, envFrom: launch.envFrom, cwd: launch.cwd } };
}


async function inspectCommands(host, args, environment, workspace) {
  return await new Promise((resolve, reject) => {
    const child = spawn(host.nodeExecutable, [host.cliEntry, 'command', ...args, '--json'], {
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
        if (value.schemaVersion !== 1 || value.command !== `command.${args[0]}` || !Array.isArray(value.data?.commands) ||
          !(code === 0 && value.status === 'success' ||
            args[0] === 'list' && code === 4 && value.status === 'partial')) throw new Error();
        resolve(value.data);
      } catch { reject(new Error('Command inspection failed.')); }
    });
  }).catch(() => fail('managedCommandUnavailable', 'The managed command binding is unavailable. Sync or reinstall the original producer before sending input.'));
}

// The Guide uses the same installed artifact, never a display-name or cwd lookup.
export async function resolveCommunicationLaunch(selected, host, environment, workspace) {
  const identity = selected.installedIdentity;
  if (identity.pluginName !== 'agent-subagent' || identity.skillKey !== 'spawn-subagent' ||
    identity.artifactId !== 'spawn-subagent-skill' || identity.platform !== 'codex' || identity.scope !== 'user') fail('managedCommandUnavailable', 'The installed Guide communication producer cannot be verified. Sync or reinstall the original Guide.');
  const producer = { sourceId: identity.sourceId, sourceIdentity: identity.sourceIdentity, pluginName: identity.pluginName,
    kind: 'artifact', key: identity.artifactId, platform: identity.platform, scope: identity.scope, projectRoot: null };
  const result = await inspectCommands(host, ['list'], environment, workspace);
  const matches = result.commands.filter((command) => command.name === 'guide-communication/message/default' &&
    command.owner?.kind === 'plugin' && isDeepStrictEqual(command.owner.producer, producer));
  if (matches.length !== 1) fail('managedCommandUnavailable', 'The installed Guide communication command is missing or ambiguous. Sync or reinstall the original Guide.');
  const binding = await managedLaunch(host, matches[0].id, environment, workspace);
  const launch = { runner: 'node', entry: 'scripts/message.mjs', args: [], env: {}, envFrom: {}, cwd: 'caller' };
  if (!/^cmdp_[0-9a-f]{16}$/.test(binding.id) || binding.owner.kind !== 'plugin' ||
    !isDeepStrictEqual(binding.owner.producer, producer) || binding.resourceRoot !== selected.resourceRoot ||
    !isDeepStrictEqual(binding.launch, launch)) fail('managedCommandUnavailable', 'The installed Guide communication launch or ownership changed. Sync or reinstall the original Guide.');
  return binding;
}

export function communicationEnvironment(host, binding) {
  return { AW_COMMAND_HOST: JSON.stringify(host), AW_HOME: host.awHome,
    AW_SUBAGENT_COMMUNICATION_COMMAND: JSON.stringify({ command: host.nodeExecutable, args: [host.cliEntry, 'command', 'run', binding.id, '--'] }) };
}

/** Internal launch context; the public Adapter v5 request remains unchanged. */
export async function communicationCommand(environment) {
  const host = await validateCommandHost(environment);
  let binding;
  try { binding = JSON.parse(environment.AW_SUBAGENT_COMMUNICATION_COMMAND); } catch {}
  if (!binding || Object.keys(binding).length !== 2 || binding.command !== host.nodeExecutable ||
    !Array.isArray(binding.args) || binding.args.length !== 5 || binding.args[0] !== host.cliEntry ||
    binding.args[1] !== 'command' || binding.args[2] !== 'run' || !/^cmdp_[0-9a-f]{16}$/.test(binding.args[3]) || binding.args[4] !== '--')
    fail('managedCommandUnavailable', 'The Guide communication command context is missing or invalid. Start through the generated AW command; sync or reinstall if needed.');
  return binding;
}
