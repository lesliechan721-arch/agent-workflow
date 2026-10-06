import path from 'node:path';
import { fail } from './contracts.mjs';

const accessModes = new Set(['read-only', 'workspace-write']);
const cleanString = (value) => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Resolve opaque plugin bindings. This function does not read a store or start a process. */
export function resolvePlan(snapshot, binding, request) {
  if (binding?.schemaVersion !== 1 || binding?.protocolVersion !== 2) fail('bindingVersionUnsupported', 'The worker binding version is not supported.', ['sync', 'reinstall']);
  if (!cleanString(snapshot?.revision) || !snapshot.installedIdentity || !cleanString(snapshot.resourceRoot)) fail('runtimeSnapshotInvalid', 'The installed runtime snapshot is incomplete.', ['sync', 'reinstall']);
  if (request.expectedRevision !== undefined && request.expectedRevision !== snapshot.revision) fail('revisionMismatch', 'The loaded Skill revision does not match the installed runtime.', ['sync', 'reinstall']);
  const profileBinding = binding.profiles?.[request.profile];
  const profile = snapshot.effectiveValues?.[request.profile];
  if (!profileBinding || !profile || typeof profile !== 'object' || Array.isArray(profile)) fail('profileUnknown', 'The requested profile has no installed worker binding.');
  const workers = Array.isArray(binding.workers) ? binding.workers : Object.values(binding.workers ?? {});
  if (workers.some((item, index) => !cleanString(item?.key) || workers.findIndex((candidate) => candidate?.key === item.key) !== index)) fail('bindingInvalid', 'Worker keys must be nonempty and unique.', ['sync', 'reinstall']);
  const workerKey = request.worker ?? profileBinding.workerKey ?? binding.defaultWorker;
  const worker = workers.find((item) => item.key === workerKey);
  const allowed = profileBinding.allowedWorkerKeys ?? [profileBinding.workerKey];
  if (!worker || !Array.isArray(allowed) || !allowed.includes(workerKey)) fail('workerNotAllowed', 'The selected worker is not allowed for this profile.');
  if (!accessModes.has(worker.maximumAccess) || !cleanString(worker.nativeRole) || !cleanString(worker.instructionsFile) || !/^[a-f0-9]{64}$/.test(worker.instructionRevision ?? '')) fail('bindingInvalid', 'The worker binding is incomplete.', ['sync', 'reinstall']);
  const access = request.access ?? 'read-only';
  if (!accessModes.has(access)) fail('accessInvalid', 'Access must be read-only or workspace-write.');
  if (access === 'workspace-write' && worker.maximumAccess !== 'workspace-write') fail('accessNotAllowed', 'The worker access limit does not permit workspace writes.');
  const executorKey = Object.hasOwn(profile, 'executor') ? profile.executor : 'native';
  if (!cleanString(executorKey)) fail('executorInvalid', 'The executor key must be a nonempty string.');
  for (const key of ['model', 'reasoningEffort']) {
    if (profile[key] !== undefined && !cleanString(profile[key])) fail('profileInvalid', 'Model and effort values must be nonempty strings when provided.');
    if (request[key] !== undefined && !cleanString(request[key])) fail('parameterInvalid', 'Explicit model and effort values must be nonempty strings when provided.');
  }
  const model = request.model ?? profile.model;
  const reasoningEffort = request.reasoningEffort ?? profile.reasoningEffort;
  const sourceFor = (key) => request[key] !== undefined ? 'request' : profile[key] !== undefined ? 'profile' : 'backend-default';
  const base = {
    protocolVersion: 2,
    profile: request.profile,
    workerKey,
    worker: { ...worker },
    configRevision: snapshot.revision,
    resourceVersion: snapshot.resourceVersion,
    installedIdentity: { ...snapshot.installedIdentity },
    resourceRoot: snapshot.resourceRoot,
    access,
    delegation: false,
    parameterSources: { model: sourceFor('model'), reasoningEffort: sourceFor('reasoningEffort') },
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
  if (executorKey === 'native') {
    if (request.requireIsolation) fail('isolationUnsupported', 'The runner cannot verify native host isolation.');
    return { ...base, mode: 'native', executorKey, nativeRole: worker.nativeRole, hostLoadedRoleVerification: 'required', runnableByRunner: false };
  }
  const commands = snapshot.effectiveValues.subagentCommands;
  if (!Array.isArray(commands)) fail('registryInvalid', 'The installed executor registry is not an array.', ['sync', 'reinstall']);
  const executor = commands.find((entry) => entry?.key === executorKey);
  if (!executor || commands.filter((entry) => entry?.key === executorKey).length !== 1) fail('executorUnknown', 'The executor reference is missing or ambiguous.', ['sync', 'reinstall']);
  if (!['workspace', 'bundle'].includes(executor.mode) || !cleanString(executor.command) || !path.isAbsolute(executor.command) || (executor.entrypoint !== undefined && (!cleanString(executor.entrypoint) || !path.isAbsolute(executor.entrypoint)))) fail('executorInvalid', 'An external executor needs a supported mode and absolute executable paths.');
  if (executor.supportsSystemInstructions !== true) fail('instructionChannelUnsupported', 'The executor has not declared an independent instruction channel.');
  if (executor.mode === 'bundle' && access !== 'read-only') fail('accessNotAllowed', 'Bundle runs cannot write to the original workspace.');
  if (access === 'read-only' && executor.supportsReadOnly !== true) fail('accessUnsupported', 'The executor has not declared read-only support.');
  if (access === 'workspace-write' && executor.supportsWorkspaceWrite !== true) fail('accessUnsupported', 'The executor has not declared workspace-write support.');
  if (request.requireIsolation) fail('isolationUnsupported', 'This adapter protocol has no verified strong scope isolation evidence.');
  return { ...base, mode: executor.mode, executorKey, executor: { ...executor }, qualification: 'not-established-by-configuration', runnableByRunner: true };
}
