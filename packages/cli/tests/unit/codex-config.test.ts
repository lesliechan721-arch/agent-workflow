import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  getAwManagedSentinelPrefix,
  parseCodexConfig,
  removeManagedDeveloperInstructions,
  upsertCodexMarketplace,
  upsertCodexPluginEnabled,
  upsertManagedDeveloperInstructions,
} from '../../src/utils/codex-config.js';

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'codex-config',
    ...segments,
  );
}

describe('codex-config', () => {
  it('parses marketplace/plugin state and detects manifest-file sources', async () => {
    const input = await fs.readFile(fixturePath('user-input.toml'), 'utf8');

    const snapshot = parseCodexConfig(input);

    expect(snapshot.marketplaces.aw).toMatchObject({
      source: '/tmp/aw/.agents/plugins/marketplace.json',
      sourcePointsToManifest: true,
    });
    expect(snapshot.plugins['other-plugin@aw']).toMatchObject({
      enabled: true,
    });
    expect(snapshot.projects['/workspace/repo']).toMatchObject({
      trustLevel: 'trusted',
    });
    expect(snapshot.developerInstructions.defined).toBe(true);
    expect(snapshot.developerInstructions.managedBlocks['other-plugin']?.value).toContain(
      'existing managed block',
    );
  });

  it('round-trips marketplace, plugin enabled, and developer_instructions updates', async () => {
    const input = await fs.readFile(fixturePath('user-input.toml'), 'utf8');
    const expected = await fs.readFile(fixturePath('user-updated.toml'), 'utf8');

    const updatedMarketplace = upsertCodexMarketplace(input, 'aw', {
      source: '/Users/test/.aw',
      sourceType: 'local',
      lastUpdated: '2026-04-25T12:00:00.000Z',
    });
    const updatedPlugin = upsertCodexPluginEnabled(updatedMarketplace, 'git-commit@aw', {
      enabled: true,
    });
    const updatedInstructions = upsertManagedDeveloperInstructions(updatedPlugin, {
      pluginName: 'git-commit',
      value: ['## 提交规范', '- 使用 Conventional Commits', '- scope 要准确'].join('\n'),
    });

    expect(updatedInstructions).toBe(expected);
    expect(
      upsertManagedDeveloperInstructions(
        upsertCodexPluginEnabled(
          upsertCodexMarketplace(updatedInstructions, 'aw', {
            source: '/Users/test/.aw',
            sourceType: 'local',
            lastUpdated: '2026-04-25T12:00:00.000Z',
          }),
          'git-commit@aw',
          { enabled: true },
        ),
        {
          pluginName: 'git-commit',
          value: ['## 提交规范', '- 使用 Conventional Commits', '- scope 要准确'].join('\n'),
        },
      ),
    ).toBe(expected);
  });

  it('removes the developer_instructions field after deleting the last managed block', async () => {
    const input = await fs.readFile(
      fixturePath('remove-last-managed.input.toml'),
      'utf8',
    );
    const expected = await fs.readFile(
      fixturePath('remove-last-managed.expected.toml'),
      'utf8',
    );

    const next = removeManagedDeveloperInstructions(input, 'git-commit');

    expect(next).toBe(expected);
    expect(parseCodexConfig(next).developerInstructions.defined).toBe(false);
  });

  it('rejects instruction bodies that contain aw-managed sentinel lines', () => {
    expect(() =>
      upsertManagedDeveloperInstructions('', {
        pluginName: 'git-commit',
        value: `${getAwManagedSentinelPrefix()} bad`,
      }),
    ).toThrow('[[aw-managed:');
  });
});
