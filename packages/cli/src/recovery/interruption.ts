import type { RebuildCommandResult } from '../commands/rebuild-command.js';
import { NativeCliError } from '../utils/native-cli.js';
import { readSafeOperationError, type SafeOperationErrorMetadata } from '../utils/safe-operation-diagnostic.js';
import type { RecoveryReceipt } from './receipt.js';

type InterruptionCode = 'operationInterrupted' | 'processCleanupUnconfirmed';

export function recoveryInterruptionCode(error: unknown, signal?: AbortSignal): InterruptionCode | undefined {
  const diagnostic = readSafeOperationError(error);
  const code = diagnostic?.code ?? (error && typeof error === 'object' && 'code' in error ? error.code : undefined);
  if (code === 'processCleanupUnconfirmed' || code === 'pluginProcessCleanupFailed'
    || error instanceof NativeCliError && error.cleanupError) {
    return 'processCleanupUnconfirmed';
  }
  if (code === 'operationInterrupted' || signal?.aborted || error instanceof Error && error.name === 'AbortError') {
    return 'operationInterrupted';
  }
  return undefined;
}

class InterruptedExecutionError extends Error {
  readonly code: InterruptionCode;
  readonly operationDiagnostic: SafeOperationErrorMetadata;

  constructor(cause: unknown) {
    const code = recoveryInterruptionCode(cause) ?? 'operationInterrupted';
    const previous = readSafeOperationError(cause);
    const message = code === 'processCleanupUnconfirmed'
      ? 'Process cleanup could not be confirmed.'
      : 'The command was interrupted. Completed changes are retained in the result.';
    super(message, { cause: cause instanceof InterruptedExecutionError ? cause.cause : cause });
    this.code = code;
    this.operationDiagnostic = previous?.code === code ? previous : { code, safeMessage: message };
  }
}

export class RecoveryInterruptedError extends InterruptedExecutionError {
  constructor(readonly receipt: RecoveryReceipt, cause: unknown) { super(cause); }
}

export class RebuildInterruptedError extends InterruptedExecutionError {
  constructor(readonly result: RebuildCommandResult, cause: unknown) { super(cause); }
}
