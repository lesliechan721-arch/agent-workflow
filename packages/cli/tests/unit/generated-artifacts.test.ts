import { describe, expect, it } from 'vitest';

import { mergeGeneratedArtifacts } from '../../src/utils/generated-artifacts.js';

describe('generated artifacts', () => {
  it('deduplicates hook artifacts by canonical hook identity regardless of order', () => {
    const merged = mergeGeneratedArtifacts(
      [
        {
          path: '/tmp/hooks.json',
          kind: 'hook',
          platform: 'codex',
          hookGroups: [
            { event: 'Stop', command: 'echo stop' },
            { event: 'PreToolUse', command: 'echo pre' },
          ],
        },
      ],
      [
        {
          path: '/tmp/hooks.json',
          kind: 'hook',
          platform: 'codex',
          hookGroups: [
            { event: 'PreToolUse', command: 'echo pre' },
            { event: 'Stop', command: 'echo stop' },
          ],
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      path: '/tmp/hooks.json',
      kind: 'hook',
      platform: 'codex',
    });
  });
});
