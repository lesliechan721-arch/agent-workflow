import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  removeManagedDeveloperInstructionsFile,
  upsertCodexMarketplaceFile,
  upsertCodexPluginEnabledFile,
  upsertManagedDeveloperInstructionsFile,
} from '../../src/utils/codex-config.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'codex-config',
    ...segments,
  );
}

async function makeTempFile(name: string, initialContent: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-config-'));
  tempDirs.push(tempDir);
  const filePath = path.join(tempDir, name);
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, initialContent, 'utf8');
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('codex-config smoke', () => {
  it('supports user and project config round-trips without losing structure', async () => {
    const input = await fs.readFile(fixturePath('user-input.toml'), 'utf8');

    for (const relativeName of ['config.toml', path.join('.codex', 'config.toml')]) {
      const filePath = await makeTempFile(relativeName, input);

      const writeUpdates = async (): Promise<void> => {
        await upsertCodexMarketplaceFile(filePath, 'aw', {
          source: '/Users/test/.aw',
          sourceType: 'local',
          lastUpdated: '2026-04-25T12:00:00.000Z',
        });
        await upsertCodexPluginEnabledFile(filePath, 'git-commit@aw', { enabled: true });
        await upsertManagedDeveloperInstructionsFile(filePath, {
          pluginName: 'git-commit',
          value: ['## 提交规范', '- 使用 Conventional Commits', '- scope 要准确'].join('\n'),
        });
      };

      await writeUpdates();
      const firstWrite = await fs.readFile(filePath, 'utf8');
      await writeUpdates();
      const secondWrite = await fs.readFile(filePath, 'utf8');

      expect(firstWrite).not.toBe(input);
      expect(secondWrite).toBe(firstWrite);
      expect(firstWrite).toContain('source = "/Users/test/.aw"');
      expect(firstWrite).toContain('[plugins."git-commit@aw"]');
      expect(firstWrite).toContain('Conventional Commits');
      expect(firstWrite).toContain('# user config comment');
      expect(firstWrite).toContain('[projects."/workspace/repo"]');
    }
  });

  it('removes the whole developer_instructions field after the last managed block disappears', async () => {
    const input = await fs.readFile(
      fixturePath('remove-last-managed.input.toml'),
      'utf8',
    );
    const filePath = await makeTempFile('config.toml', input);

    await removeManagedDeveloperInstructionsFile(filePath, 'git-commit');
    const firstRemoval = await fs.readFile(filePath, 'utf8');
    await removeManagedDeveloperInstructionsFile(filePath, 'git-commit');
    const secondRemoval = await fs.readFile(filePath, 'utf8');

    expect(firstRemoval).not.toBe(input);
    expect(secondRemoval).toBe(firstRemoval);
    expect(firstRemoval).not.toContain('developer_instructions');
    expect(firstRemoval).toContain('[projects."/workspace/repo"]');
    expect(firstRemoval).toContain('# comment stays');
  });
});
