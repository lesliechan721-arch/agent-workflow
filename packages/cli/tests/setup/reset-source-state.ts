import { vi } from 'vitest';

import { setCatalogPackageSourceForTests } from '../../src/utils/marketplace.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { setTestPathFenceHookForTests } from '../../src/utils/test-path-fence.js';
import { clearAgentVersionProbeCacheForTests } from '../../src/utils/agent-version.js';
import { clearCurrentCatalogResolutionMemoForTests } from '../../src/utils/plugin-catalog.js';
import { resetSourceTestNativeGuards } from '../helpers/native-guard.js';

export function resetSourceStateForTests(): void {
  setEmbeddedPluginsRootOverrideForTests(null);
  setCatalogPackageSourceForTests(null);
  setTestPathFenceHookForTests(null);
  clearAgentVersionProbeCacheForTests();
  clearCurrentCatalogResolutionMemoForTests();
  resetSourceTestNativeGuards();
  vi.unstubAllGlobals();
}
