import { beforeEach, vi } from 'vitest';

import { setCatalogPackageSourceForTests } from '../../src/utils/marketplace.js';
import { clearCurrentCatalogResolutionMemoForTests } from '../../src/utils/plugin-catalog.js';

beforeEach(() => {
  setCatalogPackageSourceForTests(null);
  clearCurrentCatalogResolutionMemoForTests();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`Network access is disabled in tests. Stub fetch or setCatalogPackageSourceForTests for ${String(input)}.`);
  }));
});
