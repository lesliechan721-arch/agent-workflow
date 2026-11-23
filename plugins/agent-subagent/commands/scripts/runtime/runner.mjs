import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { LIMITS, fail } from './contracts.mjs';
import { safePath, readText, readInputFile, executablePaths } from './files.mjs';
import { ADAPTERS, validateEnvironmentConfig } from './plan.mjs';
import { validateSelectors } from '../file-selection/contracts.mjs';
import { sameSourceIdentity } from './store.mjs';
import { validateCommandHost, managedLaunch, managedCommandInvocation, resolveCommunicationLaunch, communicationEnvironment } from './managed-host.mjs';

export { validateCommandHost } from './managed-host.mjs';
const needsCommunicationCommand = (selected) => selected.executor.adapter === 'antigravity' && selected.communication;

export function resolveAdapterEnvironment(source = process.env, executor = {}) {
  validateEnvironmentConfig(executor);
  const host = { ...source };
  const managed = executor.adapter === 'custom-managed';
  const environment = Object.fromEntries(Object.entries(host).filter(([key, value]) => typeof value === 'string' &&
    !(managed ? /^AW_(?:PLUGIN|SUBAGENT|COMMAND)_/i.test(key) : key.startsWith('AW_PLUGIN_') || key.startsWith('AW_SUBAGENT_') || /^AW_COMMAND_/i.test(key))));
  const referenced = {};
  const secretValues = [];
  for (const [target, origin] of Object.entries(executor.envFrom ?? {})) {
    const sourceKey = managed && process.platform === 'win32' ? Object.keys(host).find((key) => key.toUpperCase() === origin.toUpperCase()) : origin;
    if (sourceKey === undefined || !Object.hasOwn(host, sourceKey) || typeof host[sourceKey] !== 'string') fail('environmentSourceMissing', 'A configured envFrom host variable is missing. Set the source variable before running.');
    if (host[sourceKey].includes('\0')) fail('environmentInvalid', 'An envFrom host value contains NUL.');
    referenced[target] = host[sourceKey];
    secretValues.push(host[sourceKey]);
  }
  for (const [target, value] of Object.entries({ ...(executor.env ?? {}), ...referenced })) {
    if (managed && process.platform === 'win32') for (const key of Object.keys(environment)) {
      if (key.toUpperCase() === target.toUpperCase()) delete environment[key];
    }
    environment[target] = value;
  }
  return { environment, secretValues };
}
export function adapterEnvironment(source = process.env, executor = {}) {
  return resolveAdapterEnvironment(source, executor).environment;
}


export function executionConfiguration(prepared, request) {
  const { prompt, sessionId, ...configuration } = prepared.request;
  return { schema: 1, selected: prepared.selected, request: configuration,
    ...(prepared.commandHost ? { commandHost: prepared.commandHost } : {}),
    ...(prepared.managedLaunch ? { managedLaunch: prepared.managedLaunch } : {}),
    ...(prepared.communicationLaunch ? { communicationLaunch: prepared.communicationLaunch } : {}),
    ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }) };
}

export async function prepareResume(configuration, text, sessionId, options = {}) {
  if (configuration?.schema !== 1 || !configuration.selected || !configuration.request ||
    !path.isAbsolute(configuration.selected.resourceRoot ?? '') || configuration.request.type !== 'start' ||
    configuration.request.resume !== true) fail('resumeConfigurationUnavailable', 'The saved execution configuration is unavailable.');
  const saved = configuration.selected;
  const installed = options.runtimeSnapshot;
  const identity = installed?.installedIdentity;
  if (!sameSourceIdentity(identity, saved.installedIdentity) ||
    !['pluginVersion', 'sourceContentDigest'].every((key) => typeof identity[key] === 'string' && identity[key] && identity[key] === saved.installedIdentity[key]) ||
    !path.isAbsolute(installed.resourceRoot ?? '')) fail('resumeExecutionChanged', 'The original Guide code or platform snapshot cannot be verified. Start a new run after sync or reinstall.');
  const builtin = ADAPTERS[saved.executor.adapter];
  const selected = { ...saved, resourceRoot: installed.resourceRoot,
    ...(builtin ? { entrypoint: path.join(installed.resourceRoot, 'scripts', 'adapters', builtin.entrypoint) } : {}) };
  await safePath(selected.resourceRoot, 'directory');
  await safePath(path.join(selected.resourceRoot, 'scripts', 'worker.mjs'));
  await safePath(configuration.request.workspace, 'directory');
  const source = { ...(options.environment ?? process.env) };
  let host;
  if (selected.executor.adapter === 'custom-managed' || needsCommunicationCommand(selected)) {
    host = await validateCommandHost({ ...source, AW_HOME: configuration.commandHost?.awHome,
      AW_COMMAND_HOST: JSON.stringify(configuration.commandHost) });
  }
  const resolved = resolveAdapterEnvironment(source, selected.executor);
  if (host) Object.assign(resolved.environment, { AW_COMMAND_HOST: JSON.stringify(host), AW_HOME: host.awHome });
  let frozenLaunch, communicationLaunch;
  try {
    if (selected.executor.adapter === 'custom-managed') {
      frozenLaunch = await managedLaunch(host, selected.executor.commandId, resolved.environment, configuration.request.workspace, selected.executor.subcommand);
    }
    if (needsCommunicationCommand(selected)) {
      communicationLaunch = await resolveCommunicationLaunch(selected, host, resolved.environment, configuration.request.workspace);
    }
  } catch (error) {
    if (!['managedCommandUnavailable', 'executorInvalid'].includes(error.code)) throw error;
    fail('resumeExecutionChanged', 'The original managed command route is unavailable. Start a new run after sync or reinstall.');
  }
  if (!isDeepStrictEqual(frozenLaunch, configuration.managedLaunch) ||
    !isDeepStrictEqual(communicationLaunch, configuration.communicationLaunch)) fail('resumeExecutionChanged', 'The original managed command launch changed. Start a new run with the intended configuration.');
  const executable = frozenLaunch ? managedCommandInvocation(host, frozenLaunch) : await executablePaths(selected.command, selected.entrypoint);
  if (communicationLaunch) Object.assign(resolved.environment, communicationEnvironment(host, communicationLaunch));
  const { fileSelectors, fileResolver, ...wire } = configuration.request;
  return { selected, executable, request: { ...wire, prompt: text, sessionId }, ...resolved,
    ...(host ? { commandHost: host } : {}), ...(frozenLaunch ? { managedLaunch: frozenLaunch } : {}),
    ...(communicationLaunch ? { communicationLaunch } : {}), configuration: { ...configuration, selected } };
}

export async function prepareRun(selected, request, options = {}) {
  const fileSelectors = request.files ?? [];
  if (selected.mode === 'workspace' && fileSelectors.length) fail('filesNotAllowedInWorkspace', 'Workspace execution does not accept --file. Describe the focus paths in the prompt.');
  const hasText = request.prompt !== undefined, hasFile = request.promptFile !== undefined;
  if (hasText === hasFile || request.prompt === '-' || request.promptFile === '-') fail('argumentsInvalid', 'Supply exactly one of --prompt TEXT or --prompt-file PATH.');
  const callerCwd = options.callerCwd ?? process.cwd();
  if (selected.mode === 'bundle') validateSelectors(fileSelectors);
  const workspace = await fs.realpath(path.resolve(callerCwd, request.workspace ?? callerCwd)).catch(() => fail('workspaceMissing', 'The workspace is missing.'));
  await safePath(workspace, 'directory');
  let task;
  if (hasFile) task = await readInputFile(request.promptFile, LIMITS.taskBytes, 'taskTooLarge', callerCwd);
  else {
    if (typeof request.prompt !== 'string' || !request.prompt.isWellFormed() || request.prompt.includes('\0')) fail('promptInvalid', 'The prompt must be valid UTF-8 text without NUL.');
    if (Buffer.byteLength(request.prompt) > LIMITS.taskBytes) fail('taskTooLarge', 'The prompt exceeds the 256 KiB limit. Use a smaller task.');
    task = request.prompt;
  }
  if (!task.trim()) fail('inputEmpty', 'The prompt is empty. Supply a task.');
  let prompt = task;
  if (request.instructionsFile !== undefined) {
    if (typeof request.instructionsFile !== 'string' || !request.instructionsFile || request.instructionsFile === '-') fail('instructionsInvalid', 'Use a readable instruction file path.');
    const instructionsFile = path.resolve(callerCwd, request.instructionsFile);
    const instructions = await readText(instructionsFile, LIMITS.instructionBytes, 'instructionsTooLarge');
    selected = { ...selected, instructionsFile };
    prompt = `Instructions:\n${instructions}\n\nTask:\n${task}`;
  }
  const source = { ...(options.environment ?? process.env) };
  const host = selected.executor.adapter === 'custom-managed' || needsCommunicationCommand(selected) ? await validateCommandHost(source) : undefined;
  let executable;
  try {
    if (selected.executor.adapter !== 'custom-managed') executable = selected.executor.adapter === 'custom'
      ? { command: selected.command, ...(selected.entrypoint ? { entrypoint: selected.entrypoint } : {}) }
      : await executablePaths(selected.command, selected.entrypoint);
  }
  catch (error) {
    if (!['custom', 'custom-managed'].includes(selected.executor.adapter)) fail('installedRuntimeMissing', 'The installed adapter resource is missing or unreadable. Sync or reinstall the Guide.', ['sync', 'reinstall']);
    throw error;
  }
  const wire = {
    protocolVersion: 5, type: 'start', execution: { ...selected.execution }, mode: selected.mode,
    workspace, prompt, args: [...selected.executor.args], communication: selected.communication, resume: selected.resume,
    ...(selected.permissionMode === undefined ? {} : { permissionMode: selected.permissionMode }),
    ...(selected.codex ? { codex: { ...selected.codex } } : {}),
    ...(selected.mode === 'bundle' ? {
      fileSelectors: [...fileSelectors],
      fileResolver: { command: process.execPath, args: [path.join(selected.resourceRoot, 'scripts', 'resolve-files.mjs')] },
    } : {}),
  };
  const resolved = resolveAdapterEnvironment(source, selected.executor);
  if (host) Object.assign(resolved.environment, { AW_COMMAND_HOST: JSON.stringify(host), AW_HOME: host.awHome });
  const frozenLaunch = selected.executor.adapter === 'custom-managed' ? await managedLaunch(host, selected.executor.commandId, resolved.environment, workspace, selected.executor.subcommand) : undefined;
  if (frozenLaunch) executable = managedCommandInvocation(host, frozenLaunch);
  const communicationLaunch = needsCommunicationCommand(selected) ? await resolveCommunicationLaunch(selected, host, resolved.environment, workspace) : undefined;
  if (communicationLaunch) Object.assign(resolved.environment, communicationEnvironment(host, communicationLaunch));
  return { selected, executable, originalWorkspace: workspace, request: wire, ...resolved,
    ...(host ? { commandHost: host } : {}), ...(frozenLaunch ? { managedLaunch: frozenLaunch } : {}),
    ...(communicationLaunch ? { communicationLaunch } : {}) };
}
