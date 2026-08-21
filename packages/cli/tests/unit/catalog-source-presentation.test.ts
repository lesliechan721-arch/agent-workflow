import { describe, expect, it } from 'vitest';

import { projectCatalogSourceLocation } from '../../src/utils/catalog-source-presentation.js';

describe('catalog source safe location presentation', () => {
  it('keeps safe remote identity while removing credentials, tokens, fragments, and local paths', () => {
    const projected = [
      projectCatalogSourceLocation('https://user:secret@example.test/team.git?token=private#fragment'),
      projectCatalogSourceLocation('ssh://git:secret@example.test/team.git?key=private#fragment'),
      projectCatalogSourceLocation('git@example.test:team/catalog.git'),
      projectCatalogSourceLocation('file:///Users/private/catalog'),
      projectCatalogSourceLocation('/Users/private/catalog'),
      projectCatalogSourceLocation('https://user:secret@'),
    ];

    expect(projected).toEqual([
      'https://example.test/team.git',
      'ssh://example.test/team.git',
      'ssh://example.test/team/catalog.git',
      '已选择本地位置（catalog）',
      '已选择本地位置（catalog）',
      '已输入远程来源',
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/secret|private|token=|key=|#fragment|\/Users\//u);
  });
});
