import {
  readCatalogGenerationStatus,
  syncCatalogSourceGeneration,
  type CatalogGenerationServiceRuntime,
} from '../utils/catalog-generation-service.js';
import type {
  CatalogGenerationActiveV1,
  CatalogGenerationCandidateEvidence,
} from '../types.js';

export async function syncCatalogSourceCommand(options: {
  sourceId: string;
  cliVersion: string;
  cwd?: string;
  check?: boolean;
  impactConfirmed?: boolean;
  replaceDamaged?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
  expectedCandidate?: CatalogGenerationCandidateEvidence;
  expectedActive?: CatalogGenerationActiveV1 | null;
  expectedConfigDigest?: string;
  expectedImpactDigest?: string;
}): Promise<Awaited<ReturnType<typeof syncCatalogSourceGeneration>>> {
  const env = options.env ?? process.env;
  return syncCatalogSourceGeneration({ ...options, env });
}

export async function catalogSourceStatusCommand(options: {
  sourceId?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<Awaited<ReturnType<typeof readCatalogGenerationStatus>>> {
  return readCatalogGenerationStatus(options);
}
