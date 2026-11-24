import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ADAPTER_PROTOCOL_VERSION, LIMITS, fail } from './contracts.mjs';
import { safePath, readInputFile, executablePaths } from './files.mjs';
import { ADAPTERS } from './plan.mjs';
import { resolveAdapterEnvironment } from './adapter-environment.mjs';
export { resolveAdapterEnvironment, adapterEnvironment } from './adapter-environment.mjs';
import { sameSourceIdentity } from './store.mjs';
import { validateCommandHost, managedLaunch, managedCommandInvocation, resolveCommunicationLaunch, communicationEnvironment } from './managed-host.mjs';

export { validateCommandHost } from './managed-host.mjs';
const needsCommunicationCommand = (selected) => selected.executor.adapter === 'antigravity' && selected.communication;
const EXECUTION_CONFIGURATION_SCHEMA = 2;

export function executionConfiguration(prepared, request) {
  const { prompt, sessionId, ...configuration } = prepared.request;
  return { schema: EXECUTION_CONFIGURATION_SCHEMA, selected: prepared.selected, request: configuration,
    ...(prepared.commandHost ? { commandHost: prepared.commandHost } : {}),
    ...(prepared.managedLaunch ? { managedLaunch: prepared.managedLaunch } : {}),
    ...(prepared.communicationLaunch ? { communicationLaunch: prepared.communicationLaunch } : {}),
    ...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }) };
}

export async function prepareResume(configuration, text, sessionId, options = {}) {
  if (configuration?.schema !== EXECUTION_CONFIGURATION_SCHEMA || !configuration.selected || !configuration.request ||
    !path.isAbsolute(configuration.selected.resourceRoot ?? '') || configuration.request.type !== 'start' ||
    configuration.request.protocolVersion !== ADAPTER_PROTOCOL_VERSION || configuration.request.resume !== true) fail('resumeConfigurationUnavailable', 'The saved execution configuration is unavailable.');
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
  return { selected, executable, request: { ...configuration.request, prompt: text, sessionId }, ...resolved,
    ...(host ? { commandHost: host } : {}), ...(frozenLaunch ? { managedLaunch: frozenLaunch } : {}),
    ...(communicationLaunch ? { communicationLaunch } : {}), configuration: { ...configuration, selected } };
}

async function composePrompt(selected, instructionsFile, task, callerCwd) {
  if (instructionsFile === '') return task;
  const useDefault = instructionsFile === undefined;
  const file = useDefault ? path.join(selected.resourceRoot, 'assets', 'task-instructions.md') : instructionsFile;
  let instructions;
  try { instructions = await readInputFile(file, LIMITS.instructionBytes, 'instructionsTooLarge', callerCwd); }
  catch (error) {
    if (useDefault) fail('installedRuntimeMissing', 'The installed default task instructions are unavailable. Sync or reinstall the Guide.', ['sync', 'reinstall']);
    if (error.code === 'instructionsTooLarge') throw error;
    fail('instructionsInvalid', 'Use a readable nonblank UTF-8 instructions file without NUL or a symbolic link.');
  }
  return `Instructions:\n${instructions}\n\nTask:\n${task}`;
}

export async function prepareRun(selected, request, options = {}) {
  const hasText = request.prompt !== undefined, hasFile = request.promptFile !== undefined;
  if (hasText === hasFile || request.prompt === '-' || request.promptFile === '-') fail('argumentsInvalid', 'Supply exactly one of --prompt TEXT or --prompt-file PATH.');
  const callerCwd = options.callerCwd ?? process.cwd();
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
  const prompt = await composePrompt(selected, request.instructionsFile, task, callerCwd);
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
    protocolVersion: ADAPTER_PROTOCOL_VERSION, type: 'start', execution: { ...selected.execution },
    workspace, prompt, args: [...selected.executor.args], communication: selected.communication, resume: selected.resume,
    ...(selected.permissionMode === undefined ? {} : { permissionMode: selected.permissionMode }),
    ...(selected.codex ? { codex: { ...selected.codex } } : {}),
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
