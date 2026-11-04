import { expect, it, vi } from 'vitest'

import { normalizePluginConfigDefinition } from '../../src/plugin-config.js'

vi.mock('re2-wasm/build/wasm/re2.js', () => ({
  default: {
    WrappedRE2: class {
      constructor() {
        throw new Error('abort(Cannot enlarge memory arrays to size 16781312 bytes (OOM).)')
      }
    },
  },
}))

// Test Value Gate: a native allocation failure must reach consumers as a
// memory diagnostic instead of being rewritten as an invalid author pattern.
it('preserves the memory failure code when normalizing a pattern definition', () => {
  expect(() => normalizePluginConfigDefinition({
    fields: { value: { type: 'string', validation: { pattern: '^value$', maxLength: 40 } } },
  })).toThrowError(expect.objectContaining({ code: 'configValidationMemoryExhausted' }))
})
