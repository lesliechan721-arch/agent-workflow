export interface SafeOperationErrorMetadata {
  code: string;
  safeMessage: string;
  stage?: string;
  exitCode?: number;
  cause?: {
    code?: string;
    safeMessage: string;
  };
}

export interface SafeOperationErrorCarrier {
  operationDiagnostic: SafeOperationErrorMetadata;
}

export function attachSafeOperationError<T extends Error>(
  error: T,
  diagnostic: SafeOperationErrorMetadata,
): T & SafeOperationErrorCarrier {
  return Object.assign(error, { operationDiagnostic: structuredClone(diagnostic) });
}

export function readSafeOperationError(error: unknown): SafeOperationErrorMetadata | undefined {
  if (!error || typeof error !== 'object' || !('operationDiagnostic' in error)) return undefined;
  const value = (error as { operationDiagnostic?: unknown }).operationDiagnostic;
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<SafeOperationErrorMetadata>;
  if (typeof candidate.code !== 'string' || typeof candidate.safeMessage !== 'string') return undefined;
  const output: SafeOperationErrorMetadata = {
    code: candidate.code,
    safeMessage: candidate.safeMessage,
  };
  if (typeof candidate.stage === 'string') output.stage = candidate.stage;
  if (typeof candidate.exitCode === 'number' && Number.isSafeInteger(candidate.exitCode)) {
    output.exitCode = candidate.exitCode;
  }
  if (candidate.cause && typeof candidate.cause === 'object') {
    const cause = candidate.cause as { code?: unknown; safeMessage?: unknown };
    if (typeof cause.safeMessage === 'string') {
      output.cause = {
        ...(typeof cause.code === 'string' ? { code: cause.code } : {}),
        safeMessage: cause.safeMessage,
      };
    }
  }
  return output;
}
