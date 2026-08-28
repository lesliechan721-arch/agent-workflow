import type {
  CatalogGenerationActivationResult,
  CatalogGenerationRefreshResult,
} from '../types.js';
import {
  activateCatalogSourceCandidate,
  readCatalogGenerationStatus,
  refreshCatalogSourceGeneration,
  type CatalogGenerationServiceRuntime,
  type CatalogGenerationStatusPayload,
} from '../utils/catalog-generation-service.js';
import type { AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';

export async function refreshCatalogSourceGenerationCommand(options: {
  sourceId: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationRefreshResult> {
  return refreshCatalogSourceGeneration(options);
}

export async function activateCatalogSourceCandidateCommand(options: {
  sourceId: string;
  env?: NodeJS.ProcessEnv;
  awHomeMutationToken?: AwHomeMutationToken;
  runtime?: Pick<CatalogGenerationServiceRuntime, 'now'>;
}): Promise<CatalogGenerationActivationResult> {
  return activateCatalogSourceCandidate(options);
}

export async function catalogGenerationStatusCommand(options: {
  sourceId?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<CatalogGenerationStatusPayload> {
  return readCatalogGenerationStatus(options);
}
