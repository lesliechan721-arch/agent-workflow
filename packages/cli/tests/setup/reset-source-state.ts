import { vi } from 'vitest';

import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { setTestPathFenceHookForTests } from '../../src/utils/test-path-fence.js';
import { clearAgentVersionProbeCacheForTests } from '../../src/utils/agent-version.js';
import { resetSourceTestNativeGuards } from '../helpers/native-guard.js';

export function resetSourceStateForTests(): void {
  setEmbeddedPluginsRootOverrideForTests(null);
  setTestPathFenceHookForTests(null);
  clearAgentVersionProbeCacheForTests();
  resetSourceTestNativeGuards();
  vi.unstubAllGlobals();
}
