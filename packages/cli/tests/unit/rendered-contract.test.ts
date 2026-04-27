import { describe, expect, it } from 'vitest';

import { validateRenderedHooksContent } from '../../src/utils/rendered-contract.js';

describe('rendered contract validators', () => {
  it('rejects unsupported rendered hook events inferred from platform field names', () => {
    expect(() =>
      validateRenderedHooksContent({
        hooks: {
          sessionStop: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'echo done' }],
            },
          ],
        },
      }, 'claude.hooks'),
    ).toThrow('claude.hooks.sessionStop');

    expect(() =>
      validateRenderedHooksContent({
        hooks: {
          SessionEnd: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'echo done' }],
            },
          ],
        },
      }, 'codex.hooks'),
    ).toThrow('codex.hooks.SessionEnd');
  });
});
