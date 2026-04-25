import { describe, expect, it } from 'vitest';

import { applyFileRules } from '../../src/utils/file-rules.js';

describe('file rules', () => {
  it('filters files with include and exclude patterns', () => {
    const selected = applyFileRules(
      [
        'skills/commit/SKILL.md',
        'commands/commit.md',
        'config/apps.json',
      ],
      ['skills/**', 'commands/**', 'config/**'],
      ['commands/**'],
    );

    expect(selected).toEqual(['config/apps.json', 'skills/commit/SKILL.md']);
  });
});
