import path from 'node:path';
import { PROFILE_KEYS, cleanString, fail } from './contracts.mjs';
import { checkCodexArguments } from '../adapters/codex-v4.mjs';
import { checkOracleArguments } from '../adapters/oracle-arguments.mjs';

export const ADAPTERS = Object.freeze({
  codex: { mode: 'workspace', entrypoint: 'codex-v4.mjs' },
  'claude-code': { mode: 'workspace', entrypoint: 'claude-code-v4.mjs' },
  oracle: { mode: 'bundle', entrypoint: 'oracle-v4.mjs' },
});
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const protectedVariable = (key) => key.startsWith('AW_PLUGIN_') || key.startsWith('AW_SUBAGENT_') || key === 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER';
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function validateEnvironmentConfig(executor) {
  for (const field of ['env', 'envFrom']) {
    const values = Object.hasOwn(executor, field) ? executor[field] : {};
    if (!plainObject(values) || Object.entries(values).some(([key, value]) => !variableName.test(key) || protectedVariable(key) || typeof value !== 'string' || value.includes('\0') || !value.isWellFormed() || (field === 'envFrom' && (!variableName.test(value) || protectedVariable(value))))) fail('environmentInvalid', 'Use valid ordinary environment names and host references; AW control variables cannot be customized.');
  }
  if (Object.keys(executor.env ?? {}).some((key) => Object.hasOwn(executor.envFrom ?? {}, key))) fail('environmentConflict', 'A target variable cannot occur in both env and envFrom.');
}

/** Select the caller's exact key. No role classification or fallback occurs here. */
export function selectExecution(snapshot, request) {
  if (!snapshot?.installedIdentity || !path.isAbsolute(snapshot.resourceRoot ?? '')) fail('runtimeSnapshotInvalid', 'The installed runtime is incomplete. Sync or reinstall the Guide.', ['sync', 'reinstall']);
  if (!PROFILE_KEYS.includes(request.profile)) fail('profileUnknown', 'Select a supported profile key.');
  const profile = snapshot.effectiveValues?.[request.profile];
  if (profile === undefined) fail('profileUnconfigured', 'The selected profile is not configured. Select the intended configured key.');
  if (!plainObject(profile) || Object.keys(profile).some((key) => !['executor', 'model', 'reasoningEffort'].includes(key)) || ['model', 'reasoningEffort'].some((key) => Object.hasOwn(profile, key) && !cleanString(profile[key]))) fail('profileInvalid', 'The installed profile is invalid. Update the profile and sync.', ['config', 'sync']);
  const executorKey = Object.hasOwn(profile, 'executor') ? profile.executor : 'native';
  if (!cleanString(executorKey)) fail('executorInvalid', 'The executor key must be a nonempty string.');
  for (const key of ['model', 'reasoningEffort']) if (request[key] !== undefined && !cleanString(request[key])) fail('parameterInvalid', 'Explicit model and effort must be nonempty strings.');
  if (executorKey === 'native') {
    if (!cleanString(profile.model) || !cleanString(profile.reasoningEffort)) fail('profileInvalid', 'Native profiles require model and reasoningEffort.', ['config', 'sync']);
    fail('nativeUnsupported', 'Use the native host tools directly for a native profile.');
  }
  const execution = { profile: request.profile, executor: executorKey };
  for (const key of ['model', 'reasoningEffort']) if ((request[key] ?? profile[key]) !== undefined) execution[key] = request[key] ?? profile[key];
  const commands = snapshot.effectiveValues.subagentCommands;
  if (!Array.isArray(commands)) fail('registryInvalid', 'The installed command registry is invalid.', ['config', 'sync']);
  const matches = commands.filter((entry) => entry?.key === executorKey);
  if (matches.length !== 1) fail('executorUnknown', 'The selected executor is missing or ambiguous. Correct the registry and sync.', ['config', 'sync']);
  const executor = matches[0];
  const allowed = ['key', 'title', 'adapter', 'mode', 'command', 'entrypoint', 'args', 'env', 'envFrom', 'oracleEngine', 'codexProfile'];
  if (Object.keys(executor).some((key) => !allowed.includes(key)) || !cleanString(executor.title) || !['codex', 'claude-code', 'oracle', 'custom'].includes(executor.adapter)) fail('executorInvalid', 'Update the executor to the v4 adapter configuration and sync.', ['config', 'sync']);
  if (Object.hasOwn(executor, 'oracleEngine') && (executor.adapter !== 'oracle' || !['api', 'browser'].includes(executor.oracleEngine))) fail('executorInvalid', 'oracleEngine is only available for Oracle and must be api or browser.', ['config', 'sync']);
  const codexProfile = executor.codexProfile;
  if (Object.hasOwn(executor, 'codexProfile') && (executor.adapter !== 'codex' || typeof codexProfile !== 'string' || !codexProfile.trim() || codexProfile.includes('\0') || !codexProfile.isWellFormed() || [...codexProfile].length > 4096)) fail('executorInvalid', 'codexProfile is only available for Codex and must be a nonempty profile name of at most 4096 characters.', ['config', 'sync']);
  const descriptor = ADAPTERS[executor.adapter];
  let mode, command, entrypoint;
  if (descriptor) {
    if (Object.hasOwn(executor, 'command') || Object.hasOwn(executor, 'entrypoint') || (Object.hasOwn(executor, 'mode') && executor.mode !== descriptor.mode)) fail('executorInvalid', 'Built-in adapters use their installed entrypoint and fixed mode.', ['config', 'sync']);
    mode = descriptor.mode; command = process.execPath;
    entrypoint = path.join(snapshot.resourceRoot, 'scripts', 'adapters', descriptor.entrypoint);
  } else {
    if (!['workspace', 'bundle'].includes(executor.mode) || !cleanString(executor.command) || !path.isAbsolute(executor.command) || (Object.hasOwn(executor, 'entrypoint') && (!cleanString(executor.entrypoint) || !path.isAbsolute(executor.entrypoint)))) fail('executorInvalid', 'Custom adapters require a mode and absolute command and optional entrypoint paths.');
    mode = executor.mode; command = executor.command; entrypoint = executor.entrypoint;
  }
  if (executor.args !== undefined && (!Array.isArray(executor.args) || executor.args.some((value) => typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()))) fail('argumentsInvalid', 'Executor args must be a string array without NUL.');
  validateEnvironmentConfig(executor);
  const args = [...(executor.args ?? [])];
  if (executor.oracleEngine !== undefined) {
    checkOracleArguments({ args, execution }, ['--engine', '--mode', '-e', '--browser']);
    args.push('--engine', executor.oracleEngine);
  }
  if (executor.codexProfile !== undefined) {
    checkCodexArguments({ args, execution }, ['--profile', '-p']);
    args.push('--profile', executor.codexProfile);
  }
  return { execution, mode, resourceRoot: snapshot.resourceRoot, executor: { ...executor, args }, command, entrypoint };
}
