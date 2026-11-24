import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { cleanString, code, fail, fields, identifier, object, RuntimeError } from '../runtime/contracts.mjs';
import { resolveAdapterEnvironment } from '../runtime/adapter-environment.mjs';
import { safePath } from '../runtime/safe-path.mjs';
import { managedCommandInvocation, managedLaunch, validateCommandHost, validateCommandHostCoordinates } from '../runtime/managed-host.mjs';
import { runBuiltinIntrospection } from './builtin.mjs';
import { INTROSPECTION_TIMEOUT_MS, resolveProbeExecutable, runProbeProcess } from './process.mjs';
import { boundedText, isIntrospectionResponse, validEfforts } from './protocol.mjs';
import { presentIntrospectionFrame, presentModel, executorPresentation, supportedDefaultEffort } from './presentation.mjs';

const builtinAdapters = new Set(['codex', 'claude-code', 'antigravity']);
const diagnostic = (code, message) => ({ code, message });
const fallback = 'You may omit --model and --reasoning-effort to use backend defaults.';
export const MAXIMUM_INTROSPECTION_TIMEOUT_MS = 30_000;

export function validateConfiguredModels(executor) {
  if (!object(executor) || !builtinAdapters.has(executor.adapter) && !['custom', 'custom-managed'].includes(executor.adapter)) {
    fail('executorInvalid', 'Update the executor to the current adapter configuration and sync.', ['config', 'sync']);
  }
  const { models = [], modelsPolicy = 'merge' } = executor;
  if (!Array.isArray(models) || models.length > 64 || models.some((m) => !fields(m, ['id', 'description', 'efforts', 'default'])
    || !identifier(m.id) || m.description !== undefined && !boundedText(m.description, 512)
    || m.efforts !== undefined && !validEfforts(m.efforts) || m.default !== undefined && typeof m.default !== 'boolean')
    || new Set(models.map((m) => m.id)).size !== models.length || models.filter((m) => m.default).length > 1
    || !['override', 'merge'].includes(modelsPolicy)) {
    fail('executorInvalid', 'Configure unique model IDs and at most one default model.');
  }
}

async function probeExecutor(executor, workspace, environment, hostEnvironment, options) {
  const request = { protocolVersion: 6, type: 'introspect', executor: executor.key, workspace, args: executor.args ?? [] };
  if (executor.adapter === 'codex') request.codex = { cliSource: executor.codexCliSource ?? 'auto',
    bypassHookTrust: executor.codexBypassHookTrust ?? false, ...(executor.codexProfile ? { profile: executor.codexProfile } : {}) };
  if (builtinAdapters.has(executor.adapter)) return runBuiltinIntrospection(executor.adapter, request, environment, options);

  let invocation;
  if (executor.adapter === 'custom-managed') {
    const host = options.commandHost === undefined ? await validateCommandHost(hostEnvironment)
      : await validateCommandHostCoordinates(options.commandHost);
    const binding = await managedLaunch(host, executor.commandId, hostEnvironment, workspace, executor.subcommand, { signal: options.signal });
    invocation = managedCommandInvocation(host, binding);
    environment = { ...environment, AW_HOME: host.awHome };
  } else if (executor.adapter === 'custom' && cleanString(executor.command) && path.isAbsolute(executor.command)
    && (executor.entrypoint === undefined || cleanString(executor.entrypoint) && path.isAbsolute(executor.entrypoint))) {
    const entrypoint = executor.entrypoint === undefined ? undefined : path.normalize(executor.entrypoint);
    if (entrypoint !== undefined) {
      await safePath(entrypoint);
      await access(entrypoint, constants.R_OK).catch(() => fail('pathMissing', 'The configured adapter entrypoint is missing or unreadable.'));
    }
    invocation = await resolveProbeExecutable(executor.command, entrypoint === undefined ? [] : [entrypoint], { cwd: workspace, env: environment });
  } else fail('executorInvalid', 'Select a supported adapter and configure its executable.');
  const result = await runProbeProcess(invocation, { cwd: workspace, env: environment,
    ...options, input: JSON.stringify(request) + '\n' });
  if (result.code !== 0) return undefined;
  return JSON.parse(result.stdout);
}

export async function introspectExecutor(executor, {
  workspace = process.cwd(), env = process.env, probe = probeExecutor, containment, signal, commandHost,
  timeoutMs = INTROSPECTION_TIMEOUT_MS,
} = {}) {
  validateConfiguredModels(executor);
  const configured = executor.models ?? [];
  const locked = executor.modelsPolicy === 'override' && configured.length > 0;
  let frame, failure, environment = 'skipped';
  if (!locked) {
    try {
      const prepared = resolveAdapterEnvironment(env, executor);
      const childEnv = Object.fromEntries(Object.entries(prepared.environment).filter(([key]) => !/^AW_(NATIVE|COMMAND|PLUGIN|SUBAGENT)_/i.test(key)));
      if (timeoutMs <= 0) fail('introspectionTimeout', 'The read-only probe deadline has already been reached.');
      const deadline = AbortSignal.timeout(Math.min(timeoutMs, MAXIMUM_INTROSPECTION_TIMEOUT_MS));
      frame = await probe(executor, workspace, childEnv, env, { containment,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline, commandHost });
      if (!isIntrospectionResponse(frame)) {
        frame = undefined;
        failure = diagnostic('introspectionUnsupported', 'The adapter did not return a supported model directory.');
      } else if (frame.environment.status === 'unavailable') {
        environment = 'unavailable';
        failure = diagnostic(frame.environment.code, 'The backend environment is unavailable.');
      } else if (frame.status === 'unsupported') {
        failure = diagnostic('introspectionUnsupported', 'The adapter does not support model inspection.');
      } else environment = 'available';
    } catch (error) {
      const unsupported = !builtinAdapters.has(executor.adapter) && (error instanceof SyntaxError || error?.code === 'protocolInvalid');
      if (unsupported) {
        failure = diagnostic('introspectionUnsupported', 'The adapter does not support model inspection.');
      } else {
        environment = 'unavailable';
        const timedOut = error?.name === 'TimeoutError' || error?.code === 'introspectionTimeout';
        const failureCode = timedOut ? 'introspectionTimeout'
          : error instanceof RuntimeError && code(error.code) ? error.code : 'introspectionFailed';
        failure = diagnostic(failureCode, 'The backend probe could not finish.');
      }
    }
  }
  const presentation = executorPresentation(executor, env);
  const safeFrame = frame && presentIntrospectionFrame(frame, presentation);
  const dynamic = environment === 'available' ? safeFrame : undefined;
  const models = new Map((dynamic?.models ?? []).map((model) => [model.id, model]));
  let defaultModel = dynamic?.defaultModel;
  let merged = false;
  for (const configuredModel of configured) {
    const model = presentModel(configuredModel, presentation);
    if (!model) continue;
    const { id, description, efforts } = model;
    const existing = models.get(id);
    if (!existing) {
      models.set(id, { ...model, origin: 'configured' });
      merged = true;
    } else {
      const overlaid = { ...existing, ...(description && { description }), ...(efforts?.length && { efforts }) };
      merged ||= !isDeepStrictEqual(existing, overlaid);
      models.set(id, overlaid);
    }
    if (configuredModel.default === true) {
      merged ||= defaultModel !== id;
      defaultModel = id;
    }
  }
  const supportedEfforts = dynamic?.supportedEfforts;
  for (const model of models.values()) {
    if (model.id === defaultModel) model.isDefault = true;
    else delete model.isDefault;
    if (!supportedDefaultEffort(model.defaultEffort, model.efforts?.length ? model.efforts : supportedEfforts)) delete model.defaultEffort;
  }
  let diagnostics = safeFrame?.diagnostics ?? [];
  if (failure) {
    const failureCode = presentation.diagnosticCode(failure.code);
    const causeIndex = frame?.diagnostics?.findIndex(({ code }) => code === failure.code) ?? -1;
    const cause = diagnostics[causeIndex] ?? diagnostic(failureCode, failure.message);
    diagnostics = [cause, ...diagnostics.filter(({ code }) => code !== failureCode)];
  }
  if (!models.size && environment !== 'unavailable') {
    diagnostics.splice(failure ? 1 : 0, 0, diagnostic('introspectionNoModels', fallback));
  }
  const defaultEffort = models.get(defaultModel)?.defaultEffort ?? (defaultModel === undefined ? dynamic?.defaultEffort : undefined);
  return { executor: presentation.display(executor.key), adapter: executor.adapter,
    source: !models.size ? 'unavailable' : !dynamic ? 'configured' : merged ? 'merged' : 'dynamic',
    environment, ...(executor.description ? { description: presentation.display(executor.description) } : {}),
    ...(defaultModel && { defaultModel }), ...(defaultEffort && { defaultEffort }),
    ...(supportedEfforts && { supportedEfforts }), models: [...models.values()], diagnostics };
}
