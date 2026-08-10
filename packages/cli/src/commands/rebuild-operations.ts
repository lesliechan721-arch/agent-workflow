import path from 'node:path';

import type {
  GeneratedArtifact,
  PlatformName,
  PluginLifecycleEvent,
  PluginMeta,
  Scope,
} from '../types.js';
import {
  acquireLifecycleOperationLock,
  discardLifecycleActiveSnapshot,
  leaseLifecycleActiveSnapshot,
  prepareLifecycleActiveSnapshot,
  promoteLifecycleActiveSnapshot,
  readLifecycleActiveSnapshot,
  releaseLifecycleActiveSnapshot,
  removeLifecycleActiveSnapshot,
  restoreLifecycleActiveScriptInputs,
  type LifecycleActivePluginLoader,
  type PreparedLifecycleActiveSnapshot,
  type ReadLifecycleActiveSnapshot,
} from '../utils/lifecycle-active-store.js';
import type { ProcessLockLease } from '../utils/process-lock.js';
import {
  cleanupOwnedComponents,
  inspectOwnedComponents,
  type CleanupResult,
  type NativeOwnershipProbe,
  type NativeOwnershipRemove,
  type OwnedComponent,
  type OwnershipInspection,
  validateOwnerIdentity,
} from '../utils/ownership.js';

export type RebuildCommand = 'install' | 'upgrade' | 'cleanup' | 'reinstall' | 'uninstall';

export interface RebuildTargetIdentity {
  pluginName: string;
  pluginVersion: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
}

export interface DesiredTarget {
  plugin: PluginMeta;
  identity: RebuildTargetIdentity;
  ownedComponents: readonly OwnedComponent[];
  desiredOwnedComponents?: readonly OwnedComponent[];
  optionalOwnedComponents?: readonly OwnedComponent[];
  requiresNative: boolean;
  artifacts: readonly GeneratedArtifact[];
  lifecycleSource: PluginMeta;
}

export type RebuildActionName =
  | 'preflight.inspect'
  | 'stale.cleanup'
  | 'native.write'
  | 'artifacts.write'
  | 'active.prepare'
  | 'active.discard'
  | `lifecycle.${PluginLifecycleEvent}`
  | 'active.promote'
  | 'postcheck.inspect'
  | 'recovery.cleanup'
  | 'cleanup.owned'
  | 'active.read'
  | 'active.remove'
  | 'active.release'
  | 'operation.lock'
  | 'operation.release';

export interface RebuildAction {
  name: RebuildActionName;
  status: 'succeeded' | 'failed';
}

export interface RebuildFailure {
  phase: RebuildActionName | 'preflight';
  message: string;
  label?: string;
}

interface RebuildResultBase {
  command: RebuildCommand;
  target: RebuildTargetIdentity;
  actions: RebuildAction[];
  cleanupAttempted: boolean;
  removed: string[];
  absent: string[];
  residual: string[];
  quarantined: string[];
  failures: RebuildFailure[];
}

export interface RebuildSucceededResult extends RebuildResultBase {
  status: 'succeeded';
}

export interface RebuildFailedResult extends RebuildResultBase {
  status: 'failed';
  error: {
    phase: RebuildFailure['phase'];
    message: string;
  };
}

export type RebuildResult = RebuildSucceededResult | RebuildFailedResult;

export interface RebuildLifecycleInvocation {
  event: PluginLifecycleEvent;
  target: DesiredTarget;
  plugin: PluginMeta;
  artifacts: readonly GeneratedArtifact[];
}

export interface RebuildTargetDriver {
  writeNative(target: DesiredTarget): Promise<void>;
  writeArtifacts(target: DesiredTarget): Promise<void | readonly GeneratedArtifact[]>;
  withOwnershipLease?<T>(target: DesiredTarget, action: () => Promise<T>): Promise<T>;
  probeNative?: NativeOwnershipProbe;
  probeNativeHealth?: NativeOwnershipProbe;
  removeNative?: NativeOwnershipRemove;
  runLifecycle(invocation: RebuildLifecycleInvocation): Promise<void>;
}

async function withOwnershipLease<T>(
  target: DesiredTarget,
  driver: RebuildTargetDriver,
  operation: () => Promise<T>,
): Promise<T> {
  return driver.withOwnershipLease
    ? driver.withOwnershipLease(target, operation)
    : operation();
}

function artifactIdentity(artifact: GeneratedArtifact): string {
  return [
    artifact.platform,
    artifact.kind,
    path.resolve(artifact.path),
    artifact.artifactKey ?? '',
    artifact.id ?? '',
    artifact.target ?? '',
    artifact.state ?? '',
  ].join('\0');
}

function bindWrittenArtifacts(
  target: DesiredTarget,
  written: void | readonly GeneratedArtifact[],
): void {
  if (written === undefined) return;
  const expected = target.artifacts.map(artifactIdentity).sort();
  const actual = written.map(artifactIdentity).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Artifact writer result does not match the precomputed desired artifact plan.');
  }
  target.artifacts = [...written];
}

export interface RebuildActiveStore {
  prepare(target: DesiredTarget): Promise<PreparedLifecycleActiveSnapshot>;
  discard(prepared: PreparedLifecycleActiveSnapshot): Promise<void>;
  promote(prepared: PreparedLifecycleActiveSnapshot): Promise<ReadLifecycleActiveSnapshot | null>;
  read(target: DesiredTarget): Promise<ReadLifecycleActiveSnapshot | null>;
  readStable?(target: DesiredTarget): Promise<ReadLifecycleActiveSnapshot | null>;
  remove(target: DesiredTarget): Promise<void>;
  acquireOperation?(identity: RebuildTargetIdentity): Promise<ProcessLockLease>;
  releaseRead?(snapshot: ReadLifecycleActiveSnapshot): Promise<void>;
}

export function createRebuildActiveStore(options: {
  env?: NodeJS.ProcessEnv;
  loadPlugin: LifecycleActivePluginLoader;
}): RebuildActiveStore {
  return {
    prepare: (target) => prepareLifecycleActiveSnapshot({
      plugin: target.lifecycleSource,
      platform: target.identity.platform,
      scope: target.identity.scope,
      cwd: target.identity.cwd,
      artifacts: target.artifacts,
      loadPlugin: options.loadPlugin,
      env: options.env,
    }),
    discard: discardLifecycleActiveSnapshot,
    promote: promoteLifecycleActiveSnapshot,
    read: (target) => readLifecycleActiveSnapshot({
      pluginName: target.identity.pluginName,
      platform: target.identity.platform,
      scope: target.identity.scope,
      cwd: target.identity.cwd,
      loadPlugin: options.loadPlugin,
      env: options.env,
    }),
    readStable: (target) => leaseLifecycleActiveSnapshot({
      pluginName: target.identity.pluginName,
      platform: target.identity.platform,
      scope: target.identity.scope,
      cwd: target.identity.cwd,
      loadPlugin: options.loadPlugin,
      env: options.env,
    }),
    remove: (target) => removeLifecycleActiveSnapshot({
      pluginName: target.identity.pluginName,
      platform: target.identity.platform,
      scope: target.identity.scope,
      cwd: target.identity.cwd,
      env: options.env,
    }),
    acquireOperation: (identity) => acquireLifecycleOperationLock({
      pluginName: identity.pluginName,
      platform: identity.platform,
      scope: identity.scope,
      cwd: identity.cwd,
      env: options.env,
    }),
    releaseRead: releaseLifecycleActiveSnapshot,
  };
}

interface ResultAccumulator {
  actions: RebuildAction[];
  cleanupAttempted: boolean;
  removed: string[];
  absent: string[];
  residual: string[];
  quarantined: string[];
  failures: RebuildFailure[];
}

function createAccumulator(): ResultAccumulator {
  return {
    actions: [],
    cleanupAttempted: false,
    removed: [],
    absent: [],
    residual: [],
    quarantined: [],
    failures: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function releaseRebuildOperationLease(lock: ProcessLockLease): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await lock.release();
      return;
    } catch (error) {
      lastError = error;
      if (!new Set(['EACCES', 'EBUSY', 'EINTR', 'EIO', 'ENOTEMPTY', 'EPERM']).has(
        (error as NodeJS.ErrnoException).code ?? '',
      )) {
        throw error;
      }
    }
  }
  throw lastError;
}

function pushUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function mergeCleanup(
  accumulator: ResultAccumulator,
  cleanup: CleanupResult,
  phase: RebuildActionName,
): void {
  pushUnique(accumulator.removed, cleanup.removed);
  pushUnique(accumulator.absent, cleanup.absent);
  pushUnique(accumulator.residual, cleanup.residual);
  pushUnique(accumulator.quarantined, cleanup.quarantined);
  accumulator.failures.push(...cleanup.failures.map((failure) => ({
    phase,
    label: failure.label,
    message: failure.message,
  })));
}

function succeeded(
  command: RebuildCommand,
  target: DesiredTarget,
  accumulator: ResultAccumulator,
): RebuildSucceededResult {
  return { status: 'succeeded', command, target: target.identity, ...accumulator };
}

function failed(
  command: RebuildCommand,
  target: DesiredTarget,
  accumulator: ResultAccumulator,
  phase: RebuildFailure['phase'],
  message: string,
): RebuildFailedResult {
  if (!accumulator.failures.some((failure) => failure.phase === phase && failure.message === message)) {
    accumulator.failures.unshift({ phase, message });
  }
  return {
    status: 'failed',
    command,
    target: target.identity,
    ...accumulator,
    error: { phase, message },
  };
}

async function action<T>(
  accumulator: ResultAccumulator,
  name: RebuildActionName,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const value = await operation();
    accumulator.actions.push({ name, status: 'succeeded' });
    return value;
  } catch (error) {
    accumulator.actions.push({ name, status: 'failed' });
    throw error;
  }
}

function validateDesiredTarget(target: DesiredTarget): void {
  const { pluginName, pluginVersion, platform, scope } = target.identity;
  if (
    target.plugin.manifest.name !== pluginName
    || target.lifecycleSource.manifest.name !== pluginName
    || target.plugin.manifest.version !== pluginVersion
    || target.lifecycleSource.manifest.version !== pluginVersion
  ) {
    throw new Error('Desired target plugin name/version does not match its lifecycle source and identity.');
  }
  if (platform !== 'codex' && platform !== 'claude') {
    throw new Error(`Desired target platform is invalid: ${String(platform)}`);
  }
  if (scope !== 'user' && scope !== 'project') {
    throw new Error(`Desired target scope is invalid: ${String(scope)}`);
  }

  const identityKeys = new Set<string>();
  const componentPaths = new Set<string>();
  let nativeCount = 0;
  for (const component of target.ownedComponents) {
    validateOwnerIdentity(component.identity);
    if (
      component.identity.plugin !== pluginName
      || component.identity.platform !== platform
      || component.identity.scope !== scope
    ) {
      throw new Error('Owned component identity does not match the desired target.');
    }
    const identityKey = [
      component.identity.owner,
      component.identity.plugin,
      component.identity.artifactKey,
      component.identity.platform,
      component.identity.scope,
    ].join('\0');
    if (identityKeys.has(identityKey)) {
      throw new Error(`Desired target has a duplicate owned component identity: ${component.identity.artifactKey}`);
    }
    identityKeys.add(identityKey);

    if ('path' in component) {
      const componentPath = path.resolve(component.path);
      if (componentPaths.has(componentPath)) {
        throw new Error(`Desired target has a duplicate owned component path: ${component.path}`);
      }
      componentPaths.add(componentPath);
    }
    if (component.kind === 'native-plugin') {
      if (component.pluginId !== `${pluginName}@aw`) {
        throw new Error(`Native plugin identity must be ${pluginName}@aw.`);
      }
    }
  }

  const desiredComponents = target.desiredOwnedComponents ?? target.ownedComponents;
  nativeCount = desiredComponents.filter((component) => component.kind === 'native-plugin').length;

  if (target.requiresNative ? nativeCount !== 1 : nativeCount !== 0) {
    throw new Error(
      target.requiresNative
        ? 'A native desired target must have exactly one matching native component.'
        : 'A non-native desired target must not have a native component.',
    );
  }
  if (target.artifacts.some((artifact) => artifact.platform !== platform)) {
    throw new Error('Artifact platform does not match the desired target.');
  }
  const owned = new Set(target.ownedComponents);
  if ((target.desiredOwnedComponents ?? target.ownedComponents).some((component) => !owned.has(component))) {
    throw new Error('Desired owned components must be a subset of all owned components.');
  }
  const desired = new Set(target.desiredOwnedComponents ?? target.ownedComponents);
  if ((target.optionalOwnedComponents ?? []).some((component) => !owned.has(component))) {
    throw new Error('Optional owned components must be a subset of all owned components.');
  }
  if ((target.optionalOwnedComponents ?? []).some((component) => desired.has(component))) {
    throw new Error('Optional owned components must not also be required desired components.');
  }
}

function collisionMessage(inspection: OwnershipInspection): string | null {
  if (inspection.errors.length > 0) {
    return inspection.errors.map((error) => `${error.label}: ${error.message}`).join('; ');
  }
  const collision = inspection.components.find((component) => (
    component.state === 'partial' || component.state === 'error'
  ));
  if (collision) {
    return collision.diagnostic ?? 'Owned component preflight failed.';
  }
  return null;
}

function ownedComponentLabel(component: OwnedComponent): string {
  if ('path' in component) return component.path;
  if (component.kind === 'native-plugin') return component.pluginId;
  return component.label;
}

function recordInspectionResiduals(
  accumulator: ResultAccumulator,
  inspection: OwnershipInspection,
): void {
  pushUnique(
    accumulator.residual,
    inspection.components
      .filter((component) => component.state === 'partial' || component.state === 'error')
      .map((component) => ownedComponentLabel(component.component)),
  );
}

function markLastActionFailed(accumulator: ResultAccumulator, name: RebuildActionName): void {
  const entry = accumulator.actions.at(-1);
  if (entry?.name === name) entry.status = 'failed';
}

function postcheckMessage(
  accumulator: ResultAccumulator,
  inspection: OwnershipInspection,
): string | null {
  if (inspection.components.length === 0) return null;
  const invalid = inspection.components.filter((component) => component.state !== 'present');
  if (invalid.length === 0) return null;
  pushUnique(
    accumulator.residual,
    invalid.map((component) => ownedComponentLabel(component.component)),
  );
  if (inspection.errors.length > 0) {
    accumulator.failures.push(...inspection.errors.map((error) => ({
      phase: 'postcheck.inspect' as const,
      label: error.label,
      message: error.message,
    })));
    return inspection.errors.map((error) => `${error.label}: ${error.message}`).join('; ');
  }
  const diagnostics = invalid
    .map((component) => component.diagnostic)
    .filter((diagnostic): diagnostic is string => diagnostic !== undefined);
  if (diagnostics.length > 0) return diagnostics.join('; ');
  return `Post-install ownership inspection failed for ${invalid.length} component(s).`;
}

async function cleanupOwned(
  target: DesiredTarget,
  driver: RebuildTargetDriver,
  components: readonly OwnedComponent[] = target.ownedComponents,
): Promise<CleanupResult> {
  return withOwnershipLease(target, driver, () => cleanupOwnedComponents({
    components,
    nativeProbe: driver.probeNative,
    nativeRemove: driver.removeNative,
  }));
}

async function cleanupTarget(
  target: DesiredTarget,
  driver: RebuildTargetDriver,
  store: RebuildActiveStore,
  accumulator: ResultAccumulator,
  ownedAction: 'cleanup.owned' | 'recovery.cleanup',
): Promise<{ phase: RebuildFailure['phase']; message: string } | null> {
  accumulator.cleanupAttempted = true;
  try {
    const cleanup = await action(accumulator, ownedAction, () => cleanupOwned(target, driver));
    mergeCleanup(accumulator, cleanup, ownedAction);
    if (
      cleanup.failures.length > 0
      || cleanup.residual.length > 0
      || cleanup.quarantined.length > 0
    ) {
      markLastActionFailed(accumulator, ownedAction);
      return {
        phase: ownedAction,
        message: cleanup.failures[0]?.message
          ?? (cleanup.residual.length > 0
            ? `Ownership cleanup left residual components: ${cleanup.residual.join(', ')}`
            : `Ownership cleanup left quarantined components: ${cleanup.quarantined.join(', ')}`),
      };
    }
  } catch (error) {
    const message = errorMessage(error);
    accumulator.failures.push({ phase: ownedAction, message });
    return { phase: ownedAction, message };
  }

  try {
    await action(accumulator, 'active.remove', () => store.remove(target));
  } catch (error) {
    const message = errorMessage(error);
    accumulator.failures.push({ phase: 'active.remove', message });
    return { phase: 'active.remove', message };
  }
  return null;
}

async function materializeTarget(options: {
  command: 'install' | 'upgrade' | 'reinstall';
  lifecycleEvent: 'install' | 'upgrade';
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  store: RebuildActiveStore;
  accumulator: ResultAccumulator;
}): Promise<RebuildResult> {
  const { command, lifecycleEvent, target, driver, store, accumulator } = options;
  let inspection: OwnershipInspection;
  try {
    inspection = await action(
      accumulator,
      'preflight.inspect',
      () => withOwnershipLease(target, driver, () => inspectOwnedComponents({
        components: target.ownedComponents,
        nativeProbe: driver.probeNative,
      })),
    );
  } catch (error) {
    return failed(command, target, accumulator, 'preflight.inspect', errorMessage(error));
  }
  const collision = collisionMessage(inspection);
  if (collision) {
    recordInspectionResiduals(accumulator, inspection);
    return failed(command, target, accumulator, 'preflight', collision);
  }

  const desiredComponents = new Set(target.desiredOwnedComponents ?? target.ownedComponents);
  const optionalComponents = new Set(target.optionalOwnedComponents ?? []);
  const staleComponents = target.ownedComponents.filter((component) =>
    !desiredComponents.has(component) && !optionalComponents.has(component));
  const staleInspection = inspection.components.filter((entry) => staleComponents.includes(entry.component));
  if (staleInspection.some((component) => component.state === 'present')) {
    accumulator.cleanupAttempted = true;
    let stale: CleanupResult;
    try {
      stale = await action(
        accumulator,
        'stale.cleanup',
        () => cleanupOwned(target, driver, staleComponents),
      );
    } catch (error) {
      return failed(command, target, accumulator, 'stale.cleanup', errorMessage(error));
    }
    mergeCleanup(accumulator, stale, 'stale.cleanup');
    if (stale.failures.length > 0 || stale.residual.length > 0) {
      markLastActionFailed(accumulator, 'stale.cleanup');
      const message = stale.failures[0]?.message
        ?? `Stale cleanup left residual components: ${stale.residual.join(', ')}`;
      return failed(command, target, accumulator, 'stale.cleanup', message);
    }
  }

  let failurePhase: RebuildActionName = 'native.write';
  let prepared: PreparedLifecycleActiveSnapshot | undefined;
  try {
    if (target.requiresNative) {
      failurePhase = 'native.write';
      await action(accumulator, failurePhase, () => driver.writeNative(target));
    }
    failurePhase = 'artifacts.write';
    const writtenArtifacts = await action(
      accumulator,
      failurePhase,
      () => driver.writeArtifacts(target),
    );
    bindWrittenArtifacts(target, writtenArtifacts);
    failurePhase = 'active.prepare';
    prepared = await action(accumulator, failurePhase, () => store.prepare(target));
    failurePhase = `lifecycle.${lifecycleEvent}`;
    await action(accumulator, failurePhase, () => driver.runLifecycle({
      event: lifecycleEvent,
      target,
      plugin: target.lifecycleSource,
      artifacts: target.artifacts,
    }));
    failurePhase = 'active.promote';
    await action(accumulator, failurePhase, () => store.promote(prepared!));
    failurePhase = 'postcheck.inspect';
    await action(accumulator, failurePhase, async () => {
      const optional = new Set(target.optionalOwnedComponents ?? []);
      const postcheck = await withOwnershipLease(target, driver, () => inspectOwnedComponents({
        components: (target.desiredOwnedComponents ?? target.ownedComponents)
          .filter((component) => !optional.has(component)),
        nativeProbe: driver.probeNativeHealth ?? driver.probeNative,
        verifyHealth: true,
      }));
      const postcheckFailure = postcheckMessage(accumulator, postcheck);
      if (postcheckFailure) throw new Error(postcheckFailure);
    });
    return succeeded(command, target, accumulator);
  } catch (error) {
    const primary = errorMessage(error);
    if (prepared) {
      try {
        await action(accumulator, 'active.discard', () => store.discard(prepared!));
      } catch (discardError) {
        accumulator.failures.push({
          phase: 'active.discard',
          message: errorMessage(discardError),
        });
      }
    }
    await cleanupTarget(target, driver, store, accumulator, 'recovery.cleanup');
    return failed(command, target, accumulator, failurePhase, primary);
  }
}

async function executeCleanup(options: {
  command: 'cleanup' | 'reinstall';
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  store: RebuildActiveStore;
  accumulator: ResultAccumulator;
}): Promise<RebuildResult> {
  const cleanupError = await cleanupTarget(
    options.target,
    options.driver,
    options.store,
    options.accumulator,
    'cleanup.owned',
  );
  if (cleanupError) {
    return failed(
      options.command,
      options.target,
      options.accumulator,
      cleanupError.phase,
      cleanupError.message,
    );
  }
  return succeeded(options.command, options.target, options.accumulator);
}

async function executeUninstall(options: {
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  store: RebuildActiveStore;
  accumulator: ResultAccumulator;
}): Promise<RebuildResult> {
  const { target, driver, store, accumulator } = options;
  let inspection: OwnershipInspection;
  try {
    inspection = await action(
      accumulator,
      'preflight.inspect',
      () => withOwnershipLease(target, driver, () => inspectOwnedComponents({
        components: target.ownedComponents,
        nativeProbe: driver.probeNative,
      })),
    );
  } catch (error) {
    return failed('uninstall', target, accumulator, 'preflight.inspect', errorMessage(error));
  }
  let snapshot: ReadLifecycleActiveSnapshot | null;
  const stableRead = store.readStable !== undefined;
  try {
    snapshot = await action(
      accumulator,
      'active.read',
      () => (store.readStable ?? store.read)(target),
    );
  } catch (error) {
    const message = `Active lifecycle snapshot is corrupt. Run cleanup to remove live outputs without lifecycle: ${errorMessage(error)}`;
    return failed('uninstall', target, accumulator, 'active.read', message);
  }
  if (!snapshot) {
    const live = inspection.components.filter((component) => component.state !== 'absent');
    if (live.length === 0) return succeeded('uninstall', target, accumulator);
    if (!target.plugin.manifest.scripts?.lifecycle?.uninstall) {
      const cleanupError = await cleanupTarget(target, driver, store, accumulator, 'cleanup.owned');
      if (cleanupError) {
        return failed('uninstall', target, accumulator, cleanupError.phase, cleanupError.message);
      }
      return succeeded('uninstall', target, accumulator);
    }
    const collision = collisionMessage(inspection);
    if (collision) {
      recordInspectionResiduals(accumulator, inspection);
      return failed('uninstall', target, accumulator, 'preflight', collision);
    }
    pushUnique(
      accumulator.residual,
      live.map((component) => ownedComponentLabel(component.component)),
    );
    return failed(
      'uninstall',
      target,
      accumulator,
      'active.read',
      'Active lifecycle snapshot is missing while live owned components exist. Run cleanup to remove them without lifecycle.',
    );
  }

  const collision = collisionMessage(inspection);
  if (collision) {
    recordInspectionResiduals(accumulator, inspection);
    if (stableRead && store.releaseRead) {
      try {
        await action(accumulator, 'active.release', () => store.releaseRead!(snapshot!));
      } catch (error) {
        accumulator.failures.push({ phase: 'active.release', message: errorMessage(error) });
      }
    }
    return failed('uninstall', target, accumulator, 'preflight', collision);
  }

  const historical = restoreLifecycleActiveScriptInputs(snapshot);
  let lifecycleError: unknown;
  try {
    await action(accumulator, 'lifecycle.uninstall', () => driver.runLifecycle({
      event: 'uninstall',
      target,
      plugin: historical.currentPlugin,
      artifacts: historical.artifacts,
    }));
  } catch (error) {
    lifecycleError = error;
  }
  if (stableRead && store.releaseRead) {
    try {
      await action(accumulator, 'active.release', () => store.releaseRead!(snapshot!));
    } catch (error) {
      const message = errorMessage(error);
      accumulator.failures.push({ phase: 'active.release', message });
      if (lifecycleError === undefined) {
        return failed('uninstall', target, accumulator, 'active.release', message);
      }
    }
  }
  if (lifecycleError !== undefined) {
    return failed(
      'uninstall',
      target,
      accumulator,
      'lifecycle.uninstall',
      errorMessage(lifecycleError),
    );
  }

  const cleanupError = await cleanupTarget(target, driver, store, accumulator, 'cleanup.owned');
  if (cleanupError) {
    return failed('uninstall', target, accumulator, cleanupError.phase, cleanupError.message);
  }
  return succeeded('uninstall', target, accumulator);
}

export async function executeRebuildOperation(options: {
  command: RebuildCommand;
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  activeStore: RebuildActiveStore;
}): Promise<RebuildResult> {
  const accumulator = createAccumulator();
  const store = options.activeStore;
  try {
    validateDesiredTarget(options.target);
  } catch (error) {
    return failed(
      options.command,
      options.target,
      accumulator,
      'preflight',
      errorMessage(error),
    );
  }

  let operationLock: ProcessLockLease | undefined;
  if (store.acquireOperation) {
    try {
      operationLock = await action(
        accumulator,
        'operation.lock',
        () => store.acquireOperation!(options.target.identity),
      );
    } catch (error) {
      return failed(
        options.command,
        options.target,
        accumulator,
        'operation.lock',
        errorMessage(error),
      );
    }
  }

  let result: RebuildResult;
  try {
    result = await executeRebuildOperationLocked(options, accumulator, store);
  } catch (error) {
    result = failed(options.command, options.target, accumulator, 'preflight', errorMessage(error));
  }
  if (operationLock) {
    try {
      await action(
        accumulator,
        'operation.release',
        () => releaseRebuildOperationLease(operationLock!),
      );
    } catch (error) {
      const message = errorMessage(error);
      accumulator.failures.push({ phase: 'operation.release', message });
      if (result.status === 'succeeded') {
        return failed(options.command, options.target, accumulator, 'operation.release', message);
      }
    }
  }
  return result;
}

async function executeRebuildOperationLocked(
  options: {
    command: RebuildCommand;
    target: DesiredTarget;
    driver: RebuildTargetDriver;
    activeStore: RebuildActiveStore;
  },
  accumulator: ResultAccumulator,
  store: RebuildActiveStore,
): Promise<RebuildResult> {

  if (options.command === 'install' || options.command === 'upgrade') {
    return materializeTarget({
      command: options.command,
      lifecycleEvent: options.command,
      target: options.target,
      driver: options.driver,
      store,
      accumulator,
    });
  }
  if (options.command === 'cleanup') {
    return executeCleanup({
      command: 'cleanup',
      target: options.target,
      driver: options.driver,
      store,
      accumulator,
    });
  }
  if (options.command === 'uninstall') {
    return executeUninstall({
      target: options.target,
      driver: options.driver,
      store,
      accumulator,
    });
  }

  const cleanupResult = await executeCleanup({
    command: 'reinstall',
    target: options.target,
    driver: options.driver,
    store,
    accumulator,
  });
  if (cleanupResult.status === 'failed') return cleanupResult;
  return materializeTarget({
    command: 'reinstall',
    lifecycleEvent: 'install',
    target: options.target,
    driver: options.driver,
    store,
    accumulator,
  });
}

export async function executeRebuildTargets(options: {
  command: RebuildCommand;
  targets: readonly DesiredTarget[];
  driver: RebuildTargetDriver;
  activeStore: RebuildActiveStore;
}): Promise<RebuildResult[]> {
  const results: RebuildResult[] = [];
  for (const target of options.targets) {
    results.push(await executeRebuildOperation({
      command: options.command,
      target,
      driver: options.driver,
      activeStore: options.activeStore,
    }));
  }
  return results;
}
