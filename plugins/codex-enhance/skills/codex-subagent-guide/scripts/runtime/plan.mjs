import path from 'node:path';
import { PROFILE_KEYS, cleanString, fail } from './contracts.mjs';

/** Select the caller's exact key. No advisor classification or fallback occurs here. */
export function selectExecution(snapshot, request) {
  if (!snapshot?.installedIdentity || !path.isAbsolute(snapshot.resourceRoot ?? '')) fail('runtimeSnapshotInvalid', 'The installed runtime is incomplete. Sync or reinstall the Guide.', ['sync', 'reinstall']);
  if (!PROFILE_KEYS.includes(request.profile)) fail('profileUnknown', 'Select a supported profile key.');
  const profile = snapshot.effectiveValues?.[request.profile];
  if (profile === undefined) fail('profileUnconfigured', 'The selected profile is not configured. Select the intended configured key.');
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).some((key) => !['executor', 'model', 'reasoningEffort'].includes(key)) || !cleanString(profile.model) || !cleanString(profile.reasoningEffort)) fail('profileInvalid', 'The profile requires model and reasoningEffort, with optional executor.', ['config', 'sync']);
  const executorKey = Object.hasOwn(profile, 'executor') ? profile.executor : 'native';
  if (!cleanString(executorKey)) fail('executorInvalid', 'The executor key must be a nonempty string.');
  const access = request.access ?? 'read-only';
  if (!['read-only', 'workspace-write'].includes(access)) fail('accessInvalid', 'Access must be read-only or workspace-write.');
  for (const key of ['model', 'reasoningEffort']) if (request[key] !== undefined && !cleanString(request[key])) fail('parameterInvalid', 'Explicit model and effort must be nonempty strings.');
  const execution = { profile: request.profile, executor: executorKey, model: request.model ?? profile.model, reasoningEffort: request.reasoningEffort ?? profile.reasoningEffort };
  if (executorKey === 'native') fail('nativeUnsupported', 'Use the native host tools directly for a native profile.');
  const commands = snapshot.effectiveValues.subagentCommands;
  if (!Array.isArray(commands)) fail('registryInvalid', 'The installed command registry is invalid.', ['config', 'sync']);
  const matches = commands.filter((entry) => entry?.key === executorKey);
  if (matches.length !== 1) fail('executorUnknown', 'The selected executor is missing or ambiguous. Correct the registry and sync.', ['config', 'sync']);
  const executor = matches[0];
  if (!cleanString(executor.title) || !['workspace', 'bundle'].includes(executor.mode) || !cleanString(executor.command) || !path.isAbsolute(executor.command) || (executor.entrypoint !== undefined && (!cleanString(executor.entrypoint) || !path.isAbsolute(executor.entrypoint)))) fail('executorInvalid', 'The executor needs a title, supported mode, and absolute command and entrypoint paths.');
  if (executor.supportsSystemInstructions !== true) fail('instructionChannelUnsupported', 'The executor must support an independent system, developer, or equivalent instruction channel. A user prefix is insufficient.');
  if (executor.mode === 'bundle' && access !== 'read-only') fail('accessUnsupported', 'Bundle execution cannot write to the original workspace.');
  if (access === 'read-only' ? executor.supportsReadOnly !== true : executor.supportsWorkspaceWrite !== true) fail('accessUnsupported', 'The executor does not support the requested access mode.');
  return { execution, mode: executor.mode, access, executor: { ...executor } };
}
