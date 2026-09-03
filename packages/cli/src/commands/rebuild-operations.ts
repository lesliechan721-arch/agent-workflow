import path from 'node:path';

import type {
  GeneratedArtifact,
  CatalogResolution,
  PlatformName,
  PluginMeta,
  RebuildActionEvent,
  RebuildActionName,
  RebuildCommand,
  Scope,
} from '../types.js';
import type { OperationAction } from './operation-plan.js';
import {
  cleanupOwnedComponents,
  inspectOwnedComponents,
  type CleanupResult,
  type NativeOwnershipProbe,
  type NativeOwnershipRemove,
  type OwnedComponent,
  type OwnedComponentExecutor,
  type OwnershipInspection,
  validateOwnerIdentity,
} from '../utils/ownership.js';

export type { RebuildActionName, RebuildCommand } from '../types.js';

export interface RebuildTargetIdentity {
  sourceId?: string;
  sourceIdentity?: string;
  pluginId?: string;
  marketplaceName?: string;
  marketplaceRoot?: string;
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
  writeNativeRequired?: boolean;
  codexNativeObservationExpectation?: 'observed' | 'installed';
  artifacts: readonly GeneratedArtifact[];
  operationActions?: readonly OperationAction[];
  catalog?: CatalogResolution;
  postApplySource: PluginMeta;
  forceExclusiveCleanup?: boolean;
}

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

export interface RebuildPostApplyInvocation {
  target: DesiredTarget;
  plugin: PluginMeta;
  artifacts: readonly GeneratedArtifact[];
  components: Array<{
    kind: string;
    key: string;
    outcome: 'created' | 'updated' | 'removed' | 'unchanged';
  }>;
}

export interface RebuildTargetDriver {
  ownership: OwnedComponentExecutor;
  preflightMutation?(target: DesiredTarget): Promise<void>;
  preflightMaterialize?(target: DesiredTarget): Promise<void>;
  commitMaterialize?(target: DesiredTarget): Promise<void>;
  rollbackMaterialize?(target: DesiredTarget): Promise<void>;
  finalizeCleanup?(target: DesiredTarget): Promise<void>;
  writeNative(target: DesiredTarget): Promise<void>;
  writeArtifacts(target: DesiredTarget): Promise<void | readonly GeneratedArtifact[]>;
  probeNative?: NativeOwnershipProbe;
  probeNativeHealth?: NativeOwnershipProbe;
  removeNative?: NativeOwnershipRemove;
  runPostApply(invocation: RebuildPostApplyInvocation): Promise<void>;
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

interface ResultAccumulator {
  actions: RebuildAction[];
  cleanupAttempted: boolean;
  removed: string[];
  absent: string[];
  residual: string[];
  quarantined: string[];
  failures: RebuildFailure[];
}

interface RebuildActionEvents {
  command: RebuildCommand;
  target: RebuildTargetIdentity;
  emit: ((event: RebuildActionEvent) => void | Promise<void>) | undefined;
  now: () => number;
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

const REBUILD_ACTION_FAILURE_MESSAGES: Record<RebuildActionName, string> = {
  'preflight.inspect': '检查当前组件失败。',
  'stale.cleanup': '清理过期组件失败。',
  'native.write': '写入平台插件失败。',
  'artifacts.write': '写入插件文件失败。',
  postApply: '运行 postApply 失败。',
  'postcheck.inspect': '检查写入结果失败。',
  'marketplace.commit': '提交 marketplace generation 失败。',
  'marketplace.rollback': '回滚 marketplace generation 失败。',
  'recovery.cleanup': '清理失败写入失败。',
  'cleanup.owned': '清理 AW 组件失败。',
};

function rebuildActionFailureMessage(name: RebuildActionName): string {
  return REBUILD_ACTION_FAILURE_MESSAGES[name];
}

async function emitRebuildAction(
  events: RebuildActionEvents,
  event: RebuildActionEvent,
): Promise<void> {
  try {
    await events.emit?.(event);
  } catch {
    // Progress diagnostics must not change the rebuild result.
  }
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
  events: RebuildActionEvents,
  failureMessage?: (value: T) => string | null | undefined,
): Promise<T> {
  const startedAt = events.now();
  await emitRebuildAction(events, {
    type: 'rebuild:action',
    source: {
      plugin: events.target.pluginName,
      platform: events.target.platform,
      scope: events.target.scope,
      action: events.command,
    },
    data: { name, phase: 'start' },
  });
  let value: T;
  let message: string | null | undefined;
  try {
    value = await operation();
    message = failureMessage?.(value);
    accumulator.actions.push({ name, status: message ? 'failed' : 'succeeded' });
  } catch (error) {
    accumulator.actions.push({ name, status: 'failed' });
    await emitRebuildAction(events, {
      type: 'rebuild:action',
      source: {
        plugin: events.target.pluginName,
        platform: events.target.platform,
        scope: events.target.scope,
        action: events.command,
      },
      data: {
        name,
        phase: 'failure',
        durationMs: Math.max(0, events.now() - startedAt),
        message: rebuildActionFailureMessage(name),
      },
    });
    throw error;
  }
  await emitRebuildAction(events, {
    type: 'rebuild:action',
    source: {
      plugin: events.target.pluginName,
      platform: events.target.platform,
      scope: events.target.scope,
      action: events.command,
    },
    data: message
      ? {
          name,
          phase: 'failure',
          durationMs: Math.max(0, events.now() - startedAt),
          message: rebuildActionFailureMessage(name),
        }
      : {
          name,
          phase: 'success',
          durationMs: Math.max(0, events.now() - startedAt),
        },
  });
  return value;
}

function validateDesiredTarget(target: DesiredTarget): void {
  const { sourceId, sourceIdentity, pluginId, pluginName, pluginVersion, platform, scope } = target.identity;
  if (sourceId !== undefined && (
    !sourceIdentity
    || pluginId !== `${sourceId}/${pluginName}`
  )) {
    throw new Error('Desired target has an invalid namespaced source identity.');
  }
  if (
    target.plugin.manifest.name !== pluginName
    || target.postApplySource.manifest.name !== pluginName
    || target.plugin.manifest.version !== pluginVersion
    || target.postApplySource.manifest.version !== pluginVersion
  ) {
    throw new Error('Desired target plugin name/version does not match its postApply source and identity.');
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
      || component.identity.sourceId !== sourceId
      || component.identity.pluginId !== pluginId
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
      const expectedNativePluginId = `${pluginName}@${target.identity.marketplaceName ?? 'aw'}`;
      if (component.pluginId !== expectedNativePluginId) {
        throw new Error(`Native plugin identity must be ${expectedNativePluginId}.`);
      }
    }
  }

  const desiredComponents = target.desiredOwnedComponents ?? target.ownedComponents;
  if (target.forceExclusiveCleanup && target.ownedComponents.some((component) =>
    component.kind !== 'skill-directory' && component.kind !== 'owned-text-file')) {
    throw new Error('Force cleanup only supports exclusive skill directories and owned text files.');
  }
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
    component.state === 'partial' || component.state === 'foreign' || component.state === 'error'
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

function isUninstallLiveOwnershipComponent(component: OwnedComponent): boolean {
  return component.kind !== 'shared-config'
    || !component.identity.artifactKey.startsWith('marketplace-');
}

function recordInspectionResiduals(
  accumulator: ResultAccumulator,
  inspection: OwnershipInspection,
): void {
  pushUnique(
    accumulator.residual,
    inspection.components
      .filter((component) => (
        component.state === 'partial' || component.state === 'foreign' || component.state === 'error'
      ))
      .map((component) => ownedComponentLabel(component.component)),
  );
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
  if (invalid.some((component) =>
    component.state === 'partial'
    && component.component.kind === 'native-plugin'
    && component.component.identity.platform === 'codex')) {
    return 'codexActivationPostcheckFailed: Codex scope activation was not observed as enabled.';
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
  return cleanupOwnedComponents({
    components,
    executor: driver.ownership,
    nativeProbe: driver.probeNative,
    nativeRemove: driver.removeNative,
    forceExclusive: target.forceExclusiveCleanup,
  });
}

async function cleanupTarget(
  target: DesiredTarget,
  driver: RebuildTargetDriver,
  accumulator: ResultAccumulator,
  ownedAction: 'cleanup.owned' | 'recovery.cleanup',
  events: RebuildActionEvents,
  components: readonly OwnedComponent[] = target.ownedComponents,
): Promise<{ phase: RebuildFailure['phase']; message: string } | null> {
  accumulator.cleanupAttempted = true;
  try {
    const cleanup = await action(
      accumulator,
      ownedAction,
      () => cleanupOwned(target, driver, components),
      events,
      (value) => value.failures[0]?.message
        ?? (value.residual.length > 0
          ? `Ownership cleanup left residual components: ${value.residual.join(', ')}`
          : value.quarantined.length > 0
            ? `Ownership cleanup left quarantined components: ${value.quarantined.join(', ')}`
            : undefined),
    );
    mergeCleanup(accumulator, cleanup, ownedAction);
    if (
      cleanup.failures.length > 0
      || cleanup.residual.length > 0
      || cleanup.quarantined.length > 0
    ) {
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

  return null;
}

async function materializeTarget(options: {
  command: 'install' | 'reinstall';
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  accumulator: ResultAccumulator;
  events: RebuildActionEvents;
}): Promise<RebuildResult> {
  const { command, target, driver, accumulator, events } = options;
  let inspection: OwnershipInspection;
  try {
    inspection = await action(
      accumulator,
      'preflight.inspect',
      async () => {
        await driver.preflightMaterialize?.(target);
        return inspectOwnedComponents({
          components: target.ownedComponents,
          executor: driver.ownership,
          nativeProbe: driver.probeNative,
        });
      },
      events,
      collisionMessage,
    );
  } catch (error) {
    return failed(command, target, accumulator, 'preflight.inspect', errorMessage(error));
  }
  const collision = collisionMessage(inspection);
  if (collision) {
    recordInspectionResiduals(accumulator, inspection);
    return failed(command, target, accumulator, 'preflight.inspect', collision);
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
        events,
        (value) => value.failures[0]?.message
          ?? (value.residual.length > 0
            ? `Stale cleanup left residual components: ${value.residual.join(', ')}`
            : undefined),
      );
    } catch (error) {
      return failed(command, target, accumulator, 'stale.cleanup', errorMessage(error));
    }
    mergeCleanup(accumulator, stale, 'stale.cleanup');
    if (stale.failures.length > 0 || stale.residual.length > 0) {
      const message = stale.failures[0]?.message
        ?? `Stale cleanup left residual components: ${stale.residual.join(', ')}`;
      return failed(command, target, accumulator, 'stale.cleanup', message);
    }
  }

  let failurePhase: RebuildActionName = 'native.write';
  try {
    if (target.writeNativeRequired ?? target.requiresNative) {
      failurePhase = 'native.write';
      await action(accumulator, failurePhase, () => driver.writeNative(target), events);
    }
    failurePhase = 'artifacts.write';
    await action(
      accumulator,
      failurePhase,
      async () => {
        const writtenArtifacts = await driver.writeArtifacts(target);
        bindWrittenArtifacts(target, writtenArtifacts);
      },
      events,
    );
    failurePhase = 'postcheck.inspect';
    await action(accumulator, failurePhase, async () => {
      const optional = new Set(target.optionalOwnedComponents ?? []);
      const postcheck = await inspectOwnedComponents({
        components: (target.desiredOwnedComponents ?? target.ownedComponents)
          .filter((component) => !optional.has(component)),
        nativeProbe: driver.probeNativeHealth ?? driver.probeNative,
        executor: driver.ownership,
        verifyHealth: true,
      });
      const postcheckFailure = postcheckMessage(accumulator, postcheck);
      if (postcheckFailure) throw new Error(postcheckFailure);
    }, events);
    if (driver.commitMaterialize) {
      failurePhase = 'marketplace.commit';
      await action(accumulator, failurePhase, () => driver.commitMaterialize!(target), events);
    }
    try {
      const postApplyComponents = inspection.components.map((entry) => ({
        kind: entry.component.kind,
        key: entry.component.identity.artifactKey,
        outcome: (optionalComponents.has(entry.component)
          ? 'unchanged'
          : !desiredComponents.has(entry.component)
          ? (entry.state === 'present' ? 'removed' : 'unchanged')
          : entry.state === 'absent'
            ? 'created'
            : entry.state === 'present'
              ? 'unchanged'
              : 'updated') as 'created' | 'updated' | 'removed' | 'unchanged',
      }));
      await action(accumulator, 'postApply', () => driver.runPostApply({
        target,
        plugin: target.postApplySource,
        artifacts: target.artifacts,
        components: postApplyComponents,
      }), events);
    } catch (error) {
      void error;
    }
    return succeeded(command, target, accumulator);
  } catch (error) {
    const primary = errorMessage(error);
    if ((error as { durableMaterializeCommit?: unknown }).durableMaterializeCommit === true) {
      return failed(command, target, accumulator, failurePhase, primary);
    }
    if (target.identity.platform === 'codex') {
      await cleanupTarget(
        target,
        driver,
        accumulator,
        'recovery.cleanup',
        events,
        target.ownedComponents.filter((component) =>
          component.kind === 'skill-directory' || component.kind === 'owned-text-file'),
      );
      if (driver.commitMaterialize) {
        try {
          await action(
            accumulator,
            'marketplace.commit',
            () => driver.commitMaterialize!(target),
            events,
          );
        } catch (commitError) {
          accumulator.failures.push({
            phase: 'marketplace.commit',
            message: errorMessage(commitError),
          });
        }
      }
    } else {
      await cleanupTarget(target, driver, accumulator, 'recovery.cleanup', events);
      if (driver.rollbackMaterialize) {
        try {
          await action(
            accumulator,
            'marketplace.rollback',
            () => driver.rollbackMaterialize!(target),
            events,
          );
        } catch (rollbackError) {
          accumulator.failures.push({
            phase: 'marketplace.rollback',
            message: errorMessage(rollbackError),
          });
        }
      }
    }
    return failed(command, target, accumulator, failurePhase, primary);
  }
}

async function executeCleanup(options: {
  command: 'cleanup' | 'reinstall';
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  accumulator: ResultAccumulator;
  events: RebuildActionEvents;
}): Promise<RebuildResult> {
  const cleanupError = await cleanupTarget(
    options.target,
    options.driver,
    options.accumulator,
    'cleanup.owned',
    options.events,
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
  if (options.command === 'cleanup' && options.driver.finalizeCleanup) {
    try {
      await options.driver.finalizeCleanup(options.target);
    } catch (error) {
      return failed(
        options.command,
        options.target,
        options.accumulator,
        'cleanup.owned',
        errorMessage(error),
      );
    }
  }
  return succeeded(options.command, options.target, options.accumulator);
}

async function executeUninstall(options: {
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  accumulator: ResultAccumulator;
  events: RebuildActionEvents;
}): Promise<RebuildResult> {
  const { target, driver, accumulator, events } = options;
  let inspection: OwnershipInspection;
  try {
    inspection = await action(
      accumulator,
      'preflight.inspect',
      () => inspectOwnedComponents({
        components: target.ownedComponents,
        executor: driver.ownership,
        nativeProbe: driver.probeNative,
      }),
      events,
      collisionMessage,
    );
  } catch (error) {
    return failed('uninstall', target, accumulator, 'preflight.inspect', errorMessage(error));
  }
  const preflightCollision = collisionMessage(inspection);
  if (preflightCollision) {
    recordInspectionResiduals(accumulator, inspection);
    return failed('uninstall', target, accumulator, 'preflight.inspect', preflightCollision);
  }
  const live = inspection.components.filter((component) =>
    component.state !== 'absent'
    && isUninstallLiveOwnershipComponent(component.component));
  if (live.length === 0) return succeeded('uninstall', target, accumulator);
  const cleanupError = await cleanupTarget(target, driver, accumulator, 'cleanup.owned', events);
  if (cleanupError) {
    return failed('uninstall', target, accumulator, cleanupError.phase, cleanupError.message);
  }
  if (driver.finalizeCleanup) {
    try {
      await driver.finalizeCleanup(target);
    } catch (error) {
      return failed('uninstall', target, accumulator, 'cleanup.owned', errorMessage(error));
    }
  }
  return succeeded('uninstall', target, accumulator);
}

export async function executeRebuildOperation(options: {
  command: RebuildCommand;
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  onActionEvent?: (event: RebuildActionEvent) => void | Promise<void>;
  now?: () => number;
}): Promise<RebuildResult> {
  const accumulator = createAccumulator();
  const events: RebuildActionEvents = {
    command: options.command,
    target: options.target.identity,
    emit: options.onActionEvent,
    now: options.now ?? Date.now,
  };
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

  try {
    await options.driver.preflightMutation?.(options.target);
  } catch (error) {
    return failed(
      options.command,
      options.target,
      accumulator,
      'preflight',
      errorMessage(error),
    );
  }

  try {
    return await executeRebuildOperationCore(options, accumulator, events);
  } catch (error) {
    return failed(options.command, options.target, accumulator, 'preflight', errorMessage(error));
  }
}

async function executeRebuildOperationCore(
  options: {
    command: RebuildCommand;
    target: DesiredTarget;
    driver: RebuildTargetDriver;
    onActionEvent?: (event: RebuildActionEvent) => void | Promise<void>;
    now?: () => number;
  },
  accumulator: ResultAccumulator,
  events: RebuildActionEvents,
): Promise<RebuildResult> {

  if (options.command === 'install') {
    return materializeTarget({
      command: options.command,
      target: options.target,
      driver: options.driver,
      accumulator,
      events,
    });
  }
  if (options.command === 'cleanup') {
    return executeCleanup({
      command: 'cleanup',
      target: options.target,
      driver: options.driver,
      accumulator,
      events,
    });
  }
  if (options.command === 'uninstall') {
    return executeUninstall({
      target: options.target,
      driver: options.driver,
      accumulator,
      events,
    });
  }

  let inspection: OwnershipInspection;
  try {
    inspection = await action(
      accumulator,
      'preflight.inspect',
      async () => {
        await options.driver.preflightMaterialize?.(options.target);
        return inspectOwnedComponents({
          components: options.target.ownedComponents,
          executor: options.driver.ownership,
          nativeProbe: options.driver.probeNative,
        });
      },
      events,
      collisionMessage,
    );
  } catch (error) {
    return failed(
      'reinstall',
      options.target,
      accumulator,
      'preflight.inspect',
      errorMessage(error),
    );
  }
  const collision = collisionMessage(inspection);
  if (collision) {
    recordInspectionResiduals(accumulator, inspection);
    return failed('reinstall', options.target, accumulator, 'preflight.inspect', collision);
  }

  const cleanupResult = await executeCleanup({
    command: 'reinstall',
    target: options.target,
    driver: options.driver,
    accumulator,
    events,
  });
  if (cleanupResult.status === 'failed') return cleanupResult;
  return materializeTarget({
    command: 'reinstall',
    target: options.target,
    driver: options.driver,
    accumulator,
    events,
  });
}

export async function executeRebuildTargets(options: {
  command: RebuildCommand;
  targets: readonly DesiredTarget[];
  driver: RebuildTargetDriver;
  onActionEvent?: (event: RebuildActionEvent) => void | Promise<void>;
  now?: () => number;
}): Promise<RebuildResult[]> {
  const results: RebuildResult[] = [];
  for (const target of options.targets) {
    results.push(await executeRebuildOperation({
      command: options.command,
      target,
      driver: options.driver,
      ...(options.onActionEvent ? { onActionEvent: options.onActionEvent } : {}),
      ...(options.now ? { now: options.now } : {}),
    }));
  }
  return results;
}
