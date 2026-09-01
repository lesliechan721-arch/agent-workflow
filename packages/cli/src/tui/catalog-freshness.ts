import type { CatalogGenerationCandidateEvidence } from '../types.js';
import type {
  CatalogGenerationFreshnessState,
} from '../utils/catalog-generation-service.js';

export type CatalogSourceFreshnessState = 'notChecked' | 'checking' | 'checkFailed'
  | CatalogGenerationFreshnessState;

export interface CatalogSourceFreshnessViewModel {
  sourceId: string;
  state: CatalogSourceFreshnessState;
  activeVersion?: string;
  activeResolvedCommit?: string;
  candidate?: CatalogGenerationCandidateEvidence;
  errorCode?: string;
}
