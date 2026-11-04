import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { LIMITS, fail } from './contracts.mjs';
import { safePath, readText, readInputFile, executablePaths } from './files.mjs';
import { validateEnvironmentConfig } from './plan.mjs';
import { validateSelectors } from '../file-selection/contracts.mjs';
import { sameSourceIdentity } from './store.mjs';
import { validateCommandHost, managedLaunch, resolveCommunicationLaunch, communicationEnvironment } from './managed-host.mjs';

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
  const selected = configuration.selected;
  const installed = options.runtimeSnapshot;
  if (!installed || installed.resourceRoot !== selected.resourceRoot ||
    !sameSourceIdentity(installed.installedIdentity, selected.installedIdentity)) fail('resumeExecutionChanged', 'The original installed runtime cannot be verified. Sync or reinstall the original Guide before sending input.');
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
  let frozenLaunch;
  if (selected.executor.adapter === 'custom-managed') {
    frozenLaunch = await managedLaunch(host, selected.executor.commandId, resolved.environment, configuration.request.workspace);
    if (!isDeepStrictEqual(frozenLaunch, configuration.managedLaunch)) fail('resumeExecutionChanged', 'The original managed command launch changed. Start a new run with the intended configuration.');
  }
  const executable = selected.executor.adapter === 'custom-managed' ? { command: host.nodeExecutable, args: [host.cliEntry, 'command', 'run', selected.executor.commandId, '--'] }
    : await executablePaths(selected.command, selected.entrypoint);
  const communicationLaunch = needsCommunicationCommand(selected) ? await resolveCommunicationLaunch(selected, host, resolved.environment, configuration.request.workspace) : undefined;
  if (communicationLaunch) {
    if (!isDeepStrictEqual(communicationLaunch, configuration.communicationLaunch)) fail('resumeExecutionChanged', 'The original communication command changed. Start a new run after sync or reinstall.');
    Object.assign(resolved.environment, communicationEnvironment(host, communicationLaunch));
  }
  const { fileSelectors, fileResolver, ...wire } = configuration.request;
  return { selected, executable, request: { ...wire, prompt: text, sessionId }, ...resolved,
    ...(host ? { commandHost: host } : {}), ...(frozenLaunch ? { managedLaunch: frozenLaunch } : {}),
    ...(communicationLaunch ? { communicationLaunch } : {}), configuration };
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
    const instructions = await readText(path.resolve(callerCwd, request.instructionsFile), LIMITS.instructionBytes, 'instructionsTooLarge');
    prompt = `Instructions:\n${instructions}\n\nTask:\n${task}`;
  }
  const source = { ...(options.environment ?? process.env) };
  const host = selected.executor.adapter === 'custom-managed' || needsCommunicationCommand(selected) ? await validateCommandHost(source) : undefined;
  let executable;
  try {
    executable = selected.executor.adapter === 'custom-managed' ? { command: host.nodeExecutable, args: [host.cliEntry, 'command', 'run', selected.executor.commandId, '--'] } : selected.executor.adapter === 'custom'
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
  const frozenLaunch = selected.executor.adapter === 'custom-managed' ? await managedLaunch(host, selected.executor.commandId, resolved.environment, workspace) : undefined;
  const communicationLaunch = needsCommunicationCommand(selected) ? await resolveCommunicationLaunch(selected, host, resolved.environment, workspace) : undefined;
  if (communicationLaunch) Object.assign(resolved.environment, communicationEnvironment(host, communicationLaunch));
  return { selected, executable, originalWorkspace: workspace, request: wire, ...resolved,
    ...(host ? { commandHost: host } : {}), ...(frozenLaunch ? { managedLaunch: frozenLaunch } : {}),
    ...(communicationLaunch ? { communicationLaunch } : {}) };
}
