import type { CatalogGenerationCandidateEvidence } from '../../types.js';
import type {
  CatalogGenerationFreshnessState,
} from '../../utils/catalog-generation-service.js';

export interface CatalogGenerationViewModel {
  catalogVersion: string;
  channel: 'latest' | 'beta';
  requestedRef: string;
  resolvedCommit: string;
  storeKey: string;
  digestShort: string;
}

export interface CatalogSourceGenerationViewModel {
  sourceId: string;
  sourceType: 'git' | 'path';
  active?: CatalogGenerationViewModel;
  errorCode?: string;
  recoveryEntryPath?: string;
  configMismatch?: boolean;
  state?: 'ready' | 'activationRequired' | 'repairRequired' | 'configMismatch'
    | 'stateInvalid' | 'unavailable';
  technicalCommand?: string;
}

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

export interface CatalogSourceSessionDescriptor {
  sourceId: string;
  primary: boolean;
  autoCheck: boolean;
  fingerprint: string;
  fixedCommit: boolean;
}
