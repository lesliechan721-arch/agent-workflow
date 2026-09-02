export type CatalogGenerationErrorCode =
  | 'catalogSourcesConfigInvalid'
  | 'catalogSourcesConfigRecoveryStale'
  | 'catalogSourcesConfigRecoveryFailed'
  | 'catalogGenerationStateInvalid'
  | 'catalogGenerationMetadataInvalid'
  | 'catalogGenerationUnavailable'
  | 'catalogGenerationSourceMissing'
  | 'catalogGenerationIdentityMismatch'
  | 'catalogGenerationReviewStale'
  | 'catalogGenerationRepairTargetChanged'
  | 'catalogGenerationActiveComparisonUnavailable'
  | 'catalogLogicalIdentityChanged'
  | 'catalogGenerationRefreshFailed'
  | 'catalogGenerationPublishFailed';

export class CatalogGenerationError extends Error {
  readonly code: CatalogGenerationErrorCode;
  readonly sourceId?: string;

  constructor(options: {
    code: CatalogGenerationErrorCode;
    message: string;
    sourceId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CatalogGenerationError';
    this.code = options.code;
    this.sourceId = options.sourceId;
  }
}

export function catalogGenerationErrorCode(error: unknown): string {
  return error instanceof CatalogGenerationError
    ? error.code
    : 'catalogGenerationFailed';
}

const OFFLINE_CLEANUP_ERROR_CODES: ReadonlySet<CatalogGenerationErrorCode> = new Set([
  'catalogSourcesConfigInvalid',
  'catalogGenerationStateInvalid',
  'catalogGenerationMetadataInvalid',
  'catalogGenerationUnavailable',
  'catalogGenerationSourceMissing',
  'catalogGenerationIdentityMismatch',
]);

export function isOfflineCleanupCatalogGenerationError(error: unknown): boolean {
  return error instanceof CatalogGenerationError
    && OFFLINE_CLEANUP_ERROR_CODES.has(error.code);
}
