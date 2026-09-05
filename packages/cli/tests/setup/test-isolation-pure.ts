import { afterEach, beforeEach } from 'vitest';

import {
  createPureTestIsolationContext,
  installNoNetworkFetchGuard,
  restoreFetch,
  type PureTestIsolationContext,
} from '../../../../scripts/test/pure-test-isolation.js';
import { installSourceTestNativeGuards } from '../helpers/native-guard.js';
import { resetSourceStateForTests } from './reset-source-state.js';

let activeContext: PureTestIsolationContext | null = null;
let previousFetch: typeof globalThis.fetch | undefined;

async function teardownActiveContext(): Promise<void> {
  const context = activeContext;
  activeContext = null;
  if (!context) {
    return;
  }
  resetSourceStateForTests();
  restoreFetch(previousFetch);
  await context.teardown();
}

beforeEach(async () => {
  await teardownActiveContext();
  activeContext = await createPureTestIsolationContext();
  previousFetch = installNoNetworkFetchGuard();
  installSourceTestNativeGuards();
});

afterEach(async () => {
  await teardownActiveContext();
});
