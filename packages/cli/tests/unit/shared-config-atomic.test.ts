import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readClaudeSettings,
  writeClaudeSettings,
} from '../../src/adapters/helpers.js';
import {
  applyCodexConfigTransactionFile,
  parseCodexConfig,
} from '../../src/utils/codex-config.js';
import { resolveConfigFileLockPath } from '../../src/utils/plugin-config.js';

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-shared-config-atomic-'));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('shared config atomic updates', () => {
  it('serializes interleaved Codex transactions and preserves comments', async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, 'config.toml');
    await fs.writeFile(configPath, '# foreign comment\ntitle = "foreign"\n', 'utf8');

    await Promise.all([
      applyCodexConfigTransactionFile(configPath, {
        upsertManagedInstructionBlock: { pluginName: 'plugin-a', value: 'A' },
      }),
      applyCodexConfigTransactionFile(configPath, {
        upsertManagedInstructionBlock: { pluginName: 'plugin-b', value: 'B' },
      }),
    ]);

    const content = await fs.readFile(configPath, 'utf8');
    const snapshot = parseCodexConfig(content);
    expect(content).toContain('# foreign comment');
    expect(content).toContain('title = "foreign"');
    expect(Object.keys(snapshot.developerInstructions.managedBlocks).sort())
      .toEqual(['plugin-a', 'plugin-b']);
    expect(await fs.pathExists(resolveConfigFileLockPath(configPath))).toBe(false);
    expect((await fs.readdir(root)).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('merges interleaved Claude updates from the same baseline', async () => {
    const root = await makeTempRoot();
    const settingsPath = path.join(root, 'settings.json');
    await fs.writeJson(settingsPath, { foreign: { enabled: true } }, { spaces: 2 });
    const left = await readClaudeSettings(settingsPath);
    const right = await readClaudeSettings(settingsPath);
    left.awGenerated = {
      permissions: { a: { allow: ['Read'], ask: [], deny: [] } },
    };
    right.awGenerated = {
      permissions: { b: { allow: ['Write'], ask: [], deny: [] } },
    };

    await Promise.all([
      writeClaudeSettings(settingsPath, left),
      writeClaudeSettings(settingsPath, right),
    ]);

    await expect(fs.readJson(settingsPath)).resolves.toEqual({
      foreign: { enabled: true },
      awGenerated: {
        permissions: {
          a: { allow: ['Read'], ask: [], deny: [] },
          b: { allow: ['Write'], ask: [], deny: [] },
        },
      },
    });
    expect(await fs.pathExists(resolveConfigFileLockPath(settingsPath))).toBe(false);
    expect((await fs.readdir(root)).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('preserves a concurrent Claude addition while another writer removes its own plugin', async () => {
    const root = await makeTempRoot();
    const settingsPath = path.join(root, 'settings.json');
    await fs.writeJson(settingsPath, {
      permissions: { allow: ['Read'], ask: [], deny: [] },
      awGenerated: {
        permissions: { a: { allow: ['Read'], ask: [], deny: [] } },
      },
    }, { spaces: 2 });
    const removing = await readClaudeSettings(settingsPath);
    const adding = await readClaudeSettings(settingsPath);
    delete removing.awGenerated;
    removing.permissions = { allow: [], ask: [], deny: [] };
    adding.awGenerated!.permissions!.b = { allow: ['Write'], ask: [], deny: [] };
    adding.permissions = { allow: ['Read', 'Write'], ask: [], deny: [] };

    await Promise.all([
      writeClaudeSettings(settingsPath, removing),
      writeClaudeSettings(settingsPath, adding),
    ]);

    await expect(fs.readJson(settingsPath)).resolves.toEqual({
      permissions: { allow: ['Write'], ask: [], deny: [] },
      awGenerated: {
        permissions: { b: { allow: ['Write'], ask: [], deny: [] } },
      },
    });
  });

  it('rejects shared-config target and parent symlinks without external writes', async () => {
    const root = await makeTempRoot();
    const configDir = path.join(root, 'codex');
    const configPath = path.join(configDir, 'config.toml');
    const externalTarget = path.join(root, 'external.toml');
    await fs.outputFile(externalTarget, 'title = "external"\n');
    await fs.ensureDir(configDir);
    await fs.symlink(externalTarget, configPath);

    await expect(applyCodexConfigTransactionFile(configPath, {
      upsertManagedInstructionBlock: { pluginName: 'blocked', value: 'blocked' },
    })).rejects.toThrow('symbolic link');
    await expect(fs.readFile(externalTarget, 'utf8')).resolves.toBe('title = "external"\n');

    await fs.unlink(configPath);
    await fs.remove(configDir);
    const externalParent = path.join(root, 'external-parent');
    await fs.ensureDir(externalParent);
    await fs.outputFile(path.join(externalParent, 'settings.json'), '{"external":true}\n');
    await fs.symlink(externalParent, configDir);

    await expect(writeClaudeSettings(path.join(configDir, 'settings.json'), {
      permissions: { allow: ['Write'] },
    })).rejects.toThrow('symbolic link');
    await expect(fs.readFile(path.join(externalParent, 'settings.json'), 'utf8'))
      .resolves.toBe('{"external":true}\n');
  });
});
