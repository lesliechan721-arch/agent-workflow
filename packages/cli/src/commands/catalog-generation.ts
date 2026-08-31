import {
  readCatalogGenerationStatus,
  syncCatalogSourceGeneration,
  type CatalogGenerationServiceRuntime,
} from '../utils/catalog-generation-service.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';

export async function syncCatalogSourceCommand(options: {
  sourceId: string;
  cliVersion: string;
  check?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<Awaited<ReturnType<typeof syncCatalogSourceGeneration>>> {
  const env = options.env ?? process.env;
  return withAwHomeMutationLock({
    env,
    action: () => syncCatalogSourceGeneration({ ...options, env }),
  });
}

export async function catalogSourceStatusCommand(options: {
  sourceId?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<Awaited<ReturnType<typeof readCatalogGenerationStatus>>> {
  return readCatalogGenerationStatus(options);
}
