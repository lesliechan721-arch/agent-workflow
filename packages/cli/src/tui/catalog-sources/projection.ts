import type { StatusV7Payload } from '../../commands/status-v6.js';
import type { SourceHealthViewModel, SourceTabViewModel } from '../model.js';
import type {
  CatalogSourceFreshnessViewModel,
  CatalogSourceGenerationViewModel,
} from './types.js';

export function projectCatalogSourceState(
  source: StatusV7Payload['catalog']['sources'][number],
  health?: SourceHealthViewModel,
  freshness?: CatalogSourceFreshnessViewModel,
  generation?: CatalogSourceGenerationViewModel,
): SourceTabViewModel['state'] {
  if (health?.state === 'unavailable' || source.error) return 'error';
  if (generation?.state && generation.state !== 'ready') return 'recovery';
  if (freshness?.state === 'checking') return 'checking';
  if (freshness?.state === 'updateAvailable'
    || freshness?.state === 'localChangesAvailable') return 'update';
  if (freshness?.state === 'versionConflict'
    || freshness?.state === 'rollbackDetected'
    || freshness?.state === 'incompatible') return 'recovery';
  return 'ready';
}
