import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

async function readRepoFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), 'utf8');
}

describe('public docs', () => {
  it('keeps the README codex-explore description aligned with the public contract', async () => {
    const readme = await readRepoFile('README.md');

    expect(readme).toContain('| `codex-explore` | 为 Codex 提供通用只读探索流程 | Codex |');
    expect(readme).toContain('`codex-explore` 是 Codex 通用只读探索 workflow');
    expect(readme).toContain('代码库、文档、网络资料、日志和用户材料');
    expect(readme).not.toContain('为 Codex 提供只读代码库探索流程');
  });
});
