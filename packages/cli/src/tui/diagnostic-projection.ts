import type { PlatformName, Scope } from '../types.js';
import { readSafeOperationError, type SafeOperationErrorMetadata } from '../utils/safe-operation-diagnostic.js';
import { safeDiagnosticCode, sanitizeDiagnosticText } from './diagnostics.js';
import type { OperationEffectFacts, SafeOperationDiagnostic } from './operation-history.js';

type Target = { pluginId?: string; platform: PlatformName; scope: Scope };

const FIXED_STAGE_MESSAGES: Record<string, string> = {
  preApply: 'The installation pre-check did not complete.',
  'preflight.inspect': 'The target inspection did not complete.',
  'stale.cleanup': 'The stale AW content cleanup did not complete.',
  'native.write': 'The platform write did not complete.',
  'artifacts.write': 'The AW file write did not complete.',
  'postcheck.inspect': 'The final target verification did not complete.',
  'recovery.cleanup': 'The recovery cleanup did not complete.',
  'cleanup.owned': 'The AW-owned content cleanup did not complete.',
  schema: 'The config schema is not available.',
  source: 'The plugin source is not available.',
  effectiveConfig: 'The effective config could not be read.',
  targetDiscovery: 'The config apply targets could not be discovered.',
  targetValidation: 'A config apply target is not valid.',
  apply: 'The config could not be applied to a target.',
  statusReload: 'The final TUI status could not be read.',
  execute: 'The operation did not complete.',
};

const SAFE_ERROR_CODES = new Set([
  'EACCES', 'ENOENT', 'EPERM',
  'catalogGitAuthorizationFailed', 'catalogGitExecutableMissing', 'catalogGitTimedOut',
  'managedCodexAuthorizationRequired', 'managedCodexUnavailable',
  'nativeCliExecutableMissing', 'nativeCliFailed', 'nativeCliTimedOut',
  'preApplyExecutableMissing', 'preApplyExited', 'preApplyInputFailed', 'preApplyStartFailed', 'preApplyTimedOut',
  'tuiStateReloadFailed', 'issueVerificationFailed',
]);

function targetFrom(value: unknown): Target | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if ((candidate.platform !== 'codex' && candidate.platform !== 'claude')
    || (candidate.scope !== 'user' && candidate.scope !== 'project')) return undefined;
  return {
    ...(typeof candidate.pluginId === 'string' ? { pluginId: candidate.pluginId } : {}),
    platform: candidate.platform,
    scope: candidate.scope,
  };
}

function diagnosticFromMetadata(
  metadata: SafeOperationErrorMetadata,
  id: string,
  target?: Target,
  sensitiveValues: readonly string[] = [],
): SafeOperationDiagnostic {
  return {
    id,
    code: safeDiagnosticCode(metadata.code, 'operationFailed'),
    ...(metadata.stage ? { stage: safeDiagnosticCode(metadata.stage, 'execute') } : {}),
    safeMessage: sanitizeDiagnosticText(metadata.safeMessage, [], sensitiveValues),
    ...(target ? { target } : {}),
    ...(metadata.exitCode === undefined ? {} : { exitCode: metadata.exitCode }),
    causes: metadata.cause ? [{
      ...(metadata.cause.code
        ? { code: safeDiagnosticCode(metadata.cause.code, 'operationCause') }
        : {}),
      safeMessage: sanitizeDiagnosticText(metadata.cause.safeMessage, [], sensitiveValues),
    }] : [],
    detailLines: [],
  };
}

function errorCode(value: unknown, fallback: string): string {
  const candidate = value && typeof value === 'object' && 'code' in value
    ? (value as { code?: unknown }).code : undefined;
  return typeof candidate === 'string' && SAFE_ERROR_CODES.has(candidate) ? candidate : fallback;
}

export function projectThrownOperationDiagnostic(options: {
  error: unknown;
  id: string;
  stage: string;
  fallbackCode: string;
  target?: Target;
  sensitiveValues?: readonly string[];
}): SafeOperationDiagnostic {
  let metadata = readSafeOperationError(options.error);
  let cause = options.error;
  for (let depth = 0; !metadata && depth < 6 && cause && typeof cause === 'object' && 'cause' in cause; depth += 1) {
    cause = (cause as { cause?: unknown }).cause;
    metadata = readSafeOperationError(cause);
  }
  if (metadata) return diagnosticFromMetadata({
    ...metadata,
    stage: metadata.stage ?? options.stage,
  }, options.id, options.target, options.sensitiveValues);
  const code = errorCode(options.error, options.fallbackCode);
  const causeCode = options.error && typeof options.error === 'object' && 'cause' in options.error
    ? errorCode((options.error as { cause?: unknown }).cause, '') : '';
  return {
    id: options.id,
    code,
    stage: options.stage,
    safeMessage: FIXED_STAGE_MESSAGES[options.stage] ?? 'The operation did not complete.',
    ...(options.target ? { target: options.target } : {}),
    causes: causeCode ? [{ code: causeCode, safeMessage: `The service reported ${causeCode}.` }] : [],
    detailLines: [],
    omitted: { reason: 'unsupportedFormat' },
  };
}

function actionState(actions: unknown[], name: string): 'succeeded' | 'failed' | undefined {
  const action = actions.find((entry) => entry && typeof entry === 'object'
    && (entry as Record<string, unknown>).name === name) as Record<string, unknown> | undefined;
  return action?.status === 'succeeded' || action?.status === 'failed' ? action.status : undefined;
}

function rebuildEffects(result: Record<string, unknown>): OperationEffectFacts {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  const preflight = actionState(actions, 'preflight.inspect');
  const preApply = actionState(actions, 'preApply');
  const writes = ['stale.cleanup', 'native.write', 'artifacts.write', 'cleanup.owned', 'recovery.cleanup']
    .map((name) => actionState(actions, name)).filter(Boolean);
  const observedMutation = ['removed', 'quarantined'].some((field) =>
    Array.isArray(result[field]) && result[field].length > 0);
  const cleanup = actionState(actions, 'cleanup.owned');
  const postcheck = actionState(actions, 'postcheck.inspect');
  return {
    configCommit: 'notApplicable',
    awWrite: writes.length === 0
      ? observedMutation ? result.status === 'failed' ? 'partial' : 'completed'
        : preflight === 'failed' || preApply !== undefined ? 'notStarted'
        : result.status === 'failed' ? 'unknown' : 'notStarted'
      : writes.includes('failed')
        ? observedMutation || writes.includes('succeeded') ? 'partial' : 'failed'
        : 'completed',
    preApplyExternalEffect: preApply ? 'possible' : 'notApplicable',
    finalVerification: postcheck === 'succeeded' ? 'completed'
      : postcheck === 'failed' || cleanup === 'succeeded' && result.status === 'failed'
        ? 'failed' : 'notStarted',
  };
}

function combineState(values: OperationEffectFacts[keyof OperationEffectFacts][]): OperationEffectFacts[keyof OperationEffectFacts] {
  if (values.length === 0) return 'notApplicable';
  if (values.every((value) => value === values[0])) return values[0]!;
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('possible')) return 'possible';
  if (values.includes('failed') || values.includes('partial')) return 'partial';
  if (values.includes('started')) return 'started';
  if (values.includes('completed')) return 'partial';
  if (values.includes('notStarted')) return 'notStarted';
  return 'notApplicable';
}

function combineFacts(values: OperationEffectFacts[]): OperationEffectFacts {
  return {
    configCommit: combineState(values.map((value) => value.configCommit)),
    awWrite: combineState(values.map((value) => value.awWrite)),
    preApplyExternalEffect: combineState(values.map((value) => value.preApplyExternalEffect)),
    finalVerification: combineState(values.map((value) => value.finalVerification)),
  };
}

export function projectExecutionDiagnostics(
  execution: unknown,
  idPrefix: string,
  sensitiveValues: readonly string[] = [],
): {
  diagnostics: SafeOperationDiagnostic[];
  effects: OperationEffectFacts;
  targetEffects: Map<string, OperationEffectFacts>;
} {
  const raw = execution && typeof execution === 'object' ? execution as Record<string, unknown> : {};
  const diagnostics: SafeOperationDiagnostic[] = [];
  const targetEffects = new Map<string, OperationEffectFacts>();
  const rebuildResults = [
    ...(Array.isArray(raw.rebuildResults) ? raw.rebuildResults : []),
    ...(Array.isArray(raw.operationRebuildResults) ? raw.operationRebuildResults : []),
  ];
  const receiptTargets = rebuildResults.length === 0 && Array.isArray(raw.targetResults) ? raw.targetResults : [];
  for (const [index, candidate] of receiptTargets.entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    const entry = candidate as Record<string, unknown>;
    const target = targetFrom(entry.target);
    if (!target) continue;
    const effects: OperationEffectFacts = {
      configCommit: 'notApplicable',
      awWrite: entry.state === 'completed' || entry.state === 'kept' ? 'completed'
        : entry.state === 'failed' ? 'unknown' : 'notStarted',
      preApplyExternalEffect: 'notApplicable',
      finalVerification: entry.state === 'completed' || entry.state === 'kept'
        ? 'completed' : entry.state === 'failed' ? 'unknown' : 'notStarted',
    };
    targetEffects.set(`${target.pluginId ?? ''}\0${target.platform}\0${target.scope}`, effects);
    if (entry.state !== 'failed' && entry.state !== 'skipped') continue;
    diagnostics.push({
      id: `${idPrefix}:receipt-target:${index}`,
      code: typeof entry.errorCode === 'string'
        ? safeDiagnosticCode(entry.errorCode, 'operationFailed') : 'operationFailed',
      stage: 'execute',
      safeMessage: entry.state === 'skipped'
        ? 'The target operation was skipped.' : 'The target operation did not complete.',
      target,
      causes: [], detailLines: [],
    });
  }
  for (const [index, candidate] of rebuildResults.entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    const result = candidate as Record<string, unknown>;
    const target = targetFrom(result.target);
    const effects = rebuildEffects(result);
    if (target) targetEffects.set(`${target.pluginId ?? ''}\0${target.platform}\0${target.scope}`, effects);
    if (result.status !== 'failed' || !result.error || typeof result.error !== 'object') continue;
    const failure = result.error as Record<string, unknown>;
    const stage = typeof failure.phase === 'string' ? failure.phase : 'execute';
    const metadata = readSafeOperationError(failure)
      ?? (failure.operationDiagnostic && typeof failure.operationDiagnostic === 'object'
        ? failure.operationDiagnostic as SafeOperationErrorMetadata : undefined);
    diagnostics.push(metadata
      ? diagnosticFromMetadata(
          { ...metadata, stage: metadata.stage ?? stage },
          `${idPrefix}:target:${index}`,
          target,
          sensitiveValues,
        )
      : {
          id: `${idPrefix}:target:${index}`,
          code: stage === 'preApply' ? 'preApplyFailed' : 'writeFailed',
          stage,
          safeMessage: FIXED_STAGE_MESSAGES[stage] ?? 'The target operation did not complete.',
          ...(target ? { target } : {}),
          causes: [],
          detailLines: [],
          omitted: { reason: 'unsupportedFormat' },
        });
  }

  const apply = raw.apply && typeof raw.apply === 'object' ? raw.apply as Record<string, unknown> : undefined;
  if (apply) {
    const errors = [
      ...(apply.error && typeof apply.error === 'object' ? [apply.error] : []),
      ...(Array.isArray(apply.errors) ? apply.errors : []),
    ];
    for (const [index, candidate] of errors.entries()) {
      if (!candidate || typeof candidate !== 'object') continue;
      const error = candidate as Record<string, unknown>;
      const stage = typeof error.stage === 'string' ? error.stage : 'apply';
      diagnostics.push({
        id: `${idPrefix}:config:${index}`,
        code: typeof error.code === 'string' ? safeDiagnosticCode(error.code, 'configApplyFailed') : 'configApplyFailed',
        stage,
        safeMessage: FIXED_STAGE_MESSAGES[stage] ?? 'The config apply did not complete.',
        causes: [], detailLines: [],
      });
    }
    const targets = Array.isArray(apply.targetResults) ? apply.targetResults : [];
    for (const [index, candidate] of targets.entries()) {
      if (!candidate || typeof candidate !== 'object') continue;
      const entry = candidate as Record<string, unknown>;
      if (entry.state !== 'failed' && entry.state !== 'skipped') continue;
      const target = targetFrom(entry.target);
      diagnostics.push({
        id: `${idPrefix}:config-target:${index}`,
        code: typeof entry.errorCode === 'string'
          ? safeDiagnosticCode(entry.errorCode, 'configApplyFailed') : 'configApplyFailed',
        stage: 'apply',
        safeMessage: 'The config was not applied to this target.',
        ...(target ? { target } : {}),
        causes: [], detailLines: [],
      });
    }
    const rebuildFacts = rebuildResults
      .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
      .map(rebuildEffects);
    const configEffects: OperationEffectFacts = {
      configCommit: raw.configWrite === 'succeeded' ? 'completed'
        : raw.configWrite === 'failed' ? 'failed' : 'notStarted',
      awWrite: rebuildFacts.length > 0 ? combineFacts(rebuildFacts).awWrite
        : apply.state === 'succeeded' ? 'completed'
        : apply.state === 'partial' ? 'partial'
          : apply.state === 'unavailable' || apply.state === 'skipped' ? 'notStarted' : 'unknown',
      preApplyExternalEffect: rebuildFacts.length > 0
        ? combineFacts(rebuildFacts).preApplyExternalEffect : 'notApplicable',
      finalVerification: apply.state === 'succeeded' ? 'completed'
        : apply.state === 'partial' || apply.state === 'unavailable' ? 'failed' : 'notStarted',
    };
    return { diagnostics, effects: configEffects, targetEffects };
  }

  const facts = rebuildResults.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))
    .map(rebuildEffects);
  const receiptFacts = [...targetEffects.values()];
  return {
    diagnostics,
    effects: facts.length > 0 ? combineFacts(facts)
      : receiptFacts.length > 0 ? combineFacts(receiptFacts) : {
      configCommit: 'notApplicable', awWrite: 'notStarted',
      preApplyExternalEffect: 'notApplicable', finalVerification: 'notStarted',
    },
    targetEffects,
  };
}
