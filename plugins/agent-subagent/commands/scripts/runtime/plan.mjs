import path from 'node:path';
import { validateConfiguredModels } from '../introspection/models.mjs';
import { cleanString, fail } from './contracts.mjs';
import { isPluginCommandSelector, isUserCommandId, isCommandSubcommand } from './managed-host.mjs';
import { checkCodexArguments } from '../adapters/codex-v6.mjs';

export const ADAPTERS = Object.freeze({
  codex: { entrypoint: 'codex-v6.mjs' },
  'claude-code': { entrypoint: 'claude-code-v6.mjs' },
  antigravity: { entrypoint: 'antigravity-v6.mjs' },
});
import { validateEnvironmentConfig } from './adapter-environment.mjs';
export { validateEnvironmentConfig } from './adapter-environment.mjs';
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

/** Select the caller's exact key. No role classification or fallback occurs here. */
export function selectExecution(snapshot, request) {
  if (!snapshot?.installedIdentity || !path.isAbsolute(snapshot.resourceRoot ?? '')) fail('runtimeSnapshotInvalid', 'The installed runtime is incomplete. Sync or reinstall the Guide.', ['sync', 'reinstall']);
  const executorKey = request.executor;
  if (!cleanString(executorKey)) fail('executorInvalid', 'The executor key must be a nonempty string.');
  if (executorKey === 'native') fail('nativeUnsupported', 'Use the native host tools directly for native execution.');
  const execution = { executor: executorKey };
  for (const key of ['model', 'reasoningEffort']) {
    if (request[key] === undefined) continue;
    if (!cleanString(request[key])) fail('parameterInvalid', 'Explicit model and effort must be nonempty strings.');
    execution[key] = request[key];
  }
  const commands = snapshot.values?.subagentCommands;
  if (!Array.isArray(commands) || commands.some((entry) => !plainObject(entry) || !cleanString(entry.key) || entry.key === 'native') || new Set(commands.map((entry) => entry.key)).size !== commands.length) fail('registryInvalid', 'The installed command registry has invalid or duplicate keys. Correct the registry and sync.', ['config', 'sync']);
  const executor = commands.find((entry) => entry.key === executorKey);
  if (!executor) fail('executorUnknown', 'The selected executor is missing. Correct the registry and sync.', ['config', 'sync']);
  validateConfiguredModels(executor);
  const allowed = ['key', 'adapter', 'description', 'models', 'modelsPolicy', 'command', 'entrypoint', 'commandId', 'subcommand', 'args', 'env', 'envFrom', 'communication', 'resume', 'codexProfile', 'codexCliSource', 'codexBypassHookTrust', 'permissionMode'];
  if (Object.keys(executor).some((key) => !allowed.includes(key))) fail('executorInvalid', 'Update the executor to the current adapter configuration and sync.', ['config', 'sync']);
  for (const field of ['communication', 'resume']) {
    if (Object.hasOwn(executor, field) && typeof executor[field] !== 'boolean') fail('executorInvalid', `${field} must be a boolean.`, ['config', 'sync']);
  }
  if (Object.hasOwn(executor, 'codexCliSource') && (executor.adapter !== 'codex' || !['auto', 'cli', 'app'].includes(executor.codexCliSource))) fail('executorInvalid', 'codexCliSource is only available for Codex and must be auto, cli or app.', ['config', 'sync']);
  if (Object.hasOwn(executor, 'codexBypassHookTrust') && (executor.adapter !== 'codex' || typeof executor.codexBypassHookTrust !== 'boolean')) fail('executorInvalid', 'codexBypassHookTrust is only available for Codex and must be a boolean.', ['config', 'sync']);
  const supportsPermissionMode = ['codex', 'claude-code', 'antigravity'].includes(executor.adapter);
  if (Object.hasOwn(executor, 'permissionMode') && (!supportsPermissionMode || !['default', 'auto', 'full-access'].includes(executor.permissionMode))) fail('executorInvalid', 'permissionMode is only available for Codex, Claude Code and Antigravity and must be default, auto or full-access.', ['config', 'sync']);
  const codexProfile = executor.codexProfile;
  if (Object.hasOwn(executor, 'codexProfile') && (executor.adapter !== 'codex' || typeof codexProfile !== 'string' || !codexProfile.trim() || codexProfile.includes('\0') || !codexProfile.isWellFormed() || [...codexProfile].length > 4096)) fail('executorInvalid', 'codexProfile is only available for Codex and must be a nonempty profile name of at most 4096 characters.', ['config', 'sync']);
  if (executor.adapter !== 'custom-managed' && (Object.hasOwn(executor, 'commandId') || Object.hasOwn(executor, 'subcommand'))) fail('executorInvalid', 'commandId and subcommand are only available for custom-managed adapters.');
  const descriptor = ADAPTERS[executor.adapter];
  let command, entrypoint;
  if (descriptor) {
    if (Object.hasOwn(executor, 'command') || Object.hasOwn(executor, 'entrypoint')) fail('executorInvalid', 'Built-in adapters use their installed entrypoint.', ['config', 'sync']);
    command = process.execPath;
    entrypoint = path.join(snapshot.resourceRoot, 'scripts', 'adapters', descriptor.entrypoint);
  } else if (executor.adapter === 'custom-managed') {
    const fields = ['key', 'adapter', 'description', 'models', 'modelsPolicy', 'commandId', 'subcommand', 'args', 'env', 'envFrom', 'communication', 'resume'];
    if (Object.keys(executor).some((key) => !fields.includes(key)) ||
      !(isUserCommandId(executor.commandId) || isPluginCommandSelector(executor.commandId)) || executor.commandId.length > 256 ||
      (Object.hasOwn(executor, 'subcommand') && !isCommandSubcommand(executor.subcommand))) fail('executorInvalid', 'Managed custom adapters require a command selector or user ID and a valid optional subcommand.');
  } else {
    if (!cleanString(executor.command) || !path.isAbsolute(executor.command) || (Object.hasOwn(executor, 'entrypoint') && (!cleanString(executor.entrypoint) || !path.isAbsolute(executor.entrypoint)))) fail('executorInvalid', 'Custom adapters require an absolute command and optional entrypoint paths.');
    command = executor.command; entrypoint = executor.entrypoint;
  }
  if (executor.args !== undefined && (!Array.isArray(executor.args) || executor.args.some((value) => typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()))) fail('argumentsInvalid', 'Executor args must be a string array without NUL.');
  validateEnvironmentConfig(executor);
  const args = [...(executor.args ?? [])];
  if (executor.codexProfile !== undefined) {
    checkCodexArguments({ args, execution }, ['--profile', '-p']);
  }
  const codex = executor.adapter === 'codex' ? {
    cliSource: executor.codexCliSource ?? 'auto',
    bypassHookTrust: executor.codexBypassHookTrust ?? false,
    ...(codexProfile === undefined ? {} : { profile: codexProfile }),
  } : undefined;
  return { execution, communication: executor.communication ?? true, resume: executor.resume ?? true,
    ...(supportsPermissionMode ? { permissionMode: executor.permissionMode ?? 'default' } : {}),
    ...(codex ? { codex } : {}), resourceRoot: snapshot.resourceRoot, installedIdentity: snapshot.installedIdentity,
    executor: { ...executor, args }, command, entrypoint };
}
