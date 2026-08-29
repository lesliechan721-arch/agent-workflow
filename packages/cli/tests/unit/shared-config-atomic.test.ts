import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  writeClaudeSettings,
} from '../../src/adapters/helpers.js';
import {
  applyCodexConfigTransactionFile,
} from '../../src/utils/codex-config.js';

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
