export type CatalogGenerationErrorCode =
  | 'catalogGenerationStateInvalid'
  | 'catalogGenerationMetadataInvalid'
  | 'catalogGenerationUnavailable'
  | 'catalogGenerationCandidateUnavailable'
  | 'catalogGenerationSourceMissing'
  | 'catalogGenerationIdentityMismatch'
  | 'catalogGenerationRefreshFailed'
  | 'catalogGenerationPublishFailed'
  | 'catalogImmutableVersionViolation';

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
