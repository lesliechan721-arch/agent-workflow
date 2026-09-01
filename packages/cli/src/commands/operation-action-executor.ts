import type { OperationAction } from './operation-plan.js';

export type OperationActionPhase = 'inspect' | 'apply' | 'verify';

export interface OperationActionExecutorDriver {
  inspect(action: OperationAction): Promise<void>;
  ensureNativeRegistration(action: Extract<OperationAction, {
    kind: 'ensureNativeRegistration';
  }>): Promise<void>;
  removeNativeRegistration(action: Extract<OperationAction, {
    kind: 'removeNativeRegistration';
  }>): Promise<void>;
  setActivation(action: Extract<OperationAction, { kind: 'setActivation' }>): Promise<void>;
  writeOwnedArtifact(action: Extract<OperationAction, {
    kind: 'writeOwnedArtifact';
  }>): Promise<void>;
  updateSharedConfig(action: Extract<OperationAction, {
    kind: 'updateSharedConfig';
  }>): Promise<void>;
  removeOwnedArtifact(action: Extract<OperationAction, {
    kind: 'removeOwnedArtifact';
  }>): Promise<void>;
  runPostApply(action: Extract<OperationAction, { kind: 'runPostApply' }>): Promise<void>;
  verify(action: OperationAction): Promise<void>;
}

async function executeApply(
  action: OperationAction,
  driver: OperationActionExecutorDriver,
): Promise<void> {
  switch (action.kind) {
    case 'ensureNativeRegistration':
      return driver.ensureNativeRegistration(action);
    case 'removeNativeRegistration':
      return driver.removeNativeRegistration(action);
    case 'setActivation':
      return driver.setActivation(action);
    case 'writeOwnedArtifact':
      return driver.writeOwnedArtifact(action);
    case 'updateSharedConfig':
      return driver.updateSharedConfig(action);
    case 'removeOwnedArtifact':
      return driver.removeOwnedArtifact(action);
    case 'runPostApply':
      return driver.runPostApply(action);
  }
}

export async function executeOperationAction(options: {
  action: OperationAction;
  driver: OperationActionExecutorDriver;
}): Promise<void> {
  await options.driver.inspect(options.action);
  await executeApply(options.action, options.driver);
  await options.driver.verify(options.action);
}

export async function executeOperationActions(options: {
  actions: readonly OperationAction[];
  driver: OperationActionExecutorDriver;
}): Promise<void> {
  for (const action of options.actions) {
    await executeOperationAction({ action, driver: options.driver });
  }
}
