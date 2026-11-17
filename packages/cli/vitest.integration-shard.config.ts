import { defineConfig } from 'vitest/config';

import IntegrationSequencer from './scripts/integration-sequencer.mjs';
import base from './vitest.config.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    sequence: { ...base.test?.sequence, sequencer: IntegrationSequencer },
  },
});
