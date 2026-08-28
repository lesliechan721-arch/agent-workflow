import { CATALOG_BETA_REF, CATALOG_LATEST_REF } from '../constants.js';
import type { CatalogGitRefPolicy } from '../types.js';

export type CatalogRefPreset = 'followCli' | 'release' | 'beta' | 'custom';

export function catalogRefPolicyForPreset(
  preset: CatalogRefPreset,
): CatalogGitRefPolicy | undefined {
  if (preset === 'followCli') return { type: 'cliChannel' };
  if (preset === 'release') return { type: 'explicit', ref: CATALOG_LATEST_REF };
  if (preset === 'beta') return { type: 'explicit', ref: CATALOG_BETA_REF };
  return undefined;
}
