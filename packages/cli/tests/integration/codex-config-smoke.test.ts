import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseCodexConfig,
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
      await upsertManagedDeveloperInstructionsFile(filePath, {
        pluginName: 'git-commit',
        value: ['## 提交规范', '- 使用 Conventional Commits', '- scope 要准确'].join('\n'),
      });

      const finalContent = await fs.readFile(filePath, 'utf8');
      const snapshot = parseCodexConfig(finalContent);

      expect(snapshot.marketplaces.aw).toMatchObject({
        source: '/Users/test/.aw',
        sourceType: 'local',
        lastUpdated: '2026-04-25T12:00:00.000Z',
        sourcePointsToManifest: false,
      });
      expect(snapshot.plugins['git-commit@aw']).toMatchObject({
        enabled: true,
      });
      expect(snapshot.developerInstructions.managedBlocks['git-commit']?.value).toContain(
        'Conventional Commits',
      );
      expect(finalContent).toContain('# user config comment');
      expect(finalContent).toContain('[projects."/workspace/repo"]');
    }
  });

  it('removes the whole developer_instructions field after the last managed block disappears', async () => {
    const input = await fs.readFile(
      fixturePath('remove-last-managed.input.toml'),
      'utf8',
    );
    const expected = await fs.readFile(
      fixturePath('remove-last-managed.expected.toml'),
      'utf8',
    );
    const filePath = await makeTempFile('config.toml', input);

    const snapshot = await removeManagedDeveloperInstructionsFile(filePath, 'git-commit');

    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(expected);
    expect(snapshot.developerInstructions.defined).toBe(false);
  });
});
