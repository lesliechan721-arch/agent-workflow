import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import { checkAwCapabilitySupport } from './manifest.js';

export type CatalogCapabilityCompatibility =
  | { state: 'supported' }
  | {
      state: 'unsupported';
      requiredCapabilities: string[];
      missingCapabilities: string[];
    };

export function projectCatalogCapabilityCompatibility(
  requiredAwCapabilities: readonly string[],
): CatalogCapabilityCompatibility {
  const requiredCapabilities = [...requiredAwCapabilities];
  const support = checkAwCapabilitySupport(
    requiredCapabilities,
    IMPLEMENTED_AW_CAPABILITIES,
  );
  return support.supported
    ? { state: 'supported' }
    : {
        state: 'unsupported',
        requiredCapabilities,
        missingCapabilities: support.missing,
      };
}
