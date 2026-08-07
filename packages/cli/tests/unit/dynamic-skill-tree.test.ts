import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeSkillArtifact, CodexSkillArtifact } from '../../src/types.js';
import {
  createDynamicSkillExpectedTree,
  createDynamicSkillTreeContentDigest,
  readDynamicSkillTree,
  writeDynamicSkillTree,
} from '../../src/utils/dynamic-skill-tree.js';

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dynamic-skill-tree-'));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('dynamic skill tree', () => {
  it('merges ordered static directories, preserves binary files, and applies dynamic overrides last', async () => {
    const root = await makeTempRoot();
    const common = path.join(root, 'common');
    const codex = path.join(root, 'codex');
    await fs.outputFile(path.join(common, 'SKILL.md'), '# common\n');
    await fs.outputFile(
      path.join(common, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: false\n',
    );
    await fs.outputFile(path.join(common, 'references', 'shared.md'), 'common\n');
    await fs.outputFile(path.join(common, 'assets', 'icon.bin'), Buffer.from([0, 255, 1]));
    await fs.outputFile(path.join(codex, 'references', 'shared.md'), 'codex\n');

    const artifact: Pick<CodexSkillArtifact, 'target' | 'skillKey' | 'state' | 'content'> = {
      target: 'codex.skill',
      skillKey: 'example',
      state: 'present',
      content: {
        files: {
          'SKILL.md': '# rendered\n',
          'references/dynamic.md': 'dynamic\n',
        },
      },
    };
    const tree = await createDynamicSkillExpectedTree({
      artifact,
      sourceDirs: [common, codex],
      preference: 'manual',
    });

    expect(tree.files['SKILL.md']?.toString()).toBe('# rendered\n');
    expect(tree.files['references/shared.md']?.toString()).toBe('codex\n');
    expect(tree.files['references/dynamic.md']?.toString()).toBe('dynamic\n');
    expect(tree.files['assets/icon.bin']).toEqual(Buffer.from([0, 255, 1]));
    expect(tree.files['agents/openai.yaml']?.toString()).toContain(
      'allow_implicit_invocation: false',
    );
  });

  it('patches Claude frontmatter and writes and reads the complete tree atomically', async () => {
    const root = await makeTempRoot();
    const source = path.join(root, 'source');
    const target = path.join(root, 'runtime', 'example');
    await fs.outputFile(
      path.join(source, 'SKILL.md'),
      '---\nname: example\ndescription: Example skill\n---\nBody\n',
    );
    await fs.outputFile(path.join(source, 'scripts', 'helper.sh'), '#!/bin/sh\n');

    const artifact: Pick<ClaudeSkillArtifact, 'target' | 'skillKey' | 'state' | 'content'> = {
      target: 'claude.skill',
      skillKey: 'example',
      state: 'present',
      content: { files: {} },
    };
    const tree = await createDynamicSkillExpectedTree({
      artifact,
      sourceDirs: [source],
      preference: 'manual',
    });
    expect(tree.files['SKILL.md']?.toString()).toContain('disable-model-invocation: true');
    expect(tree.files['SKILL.md']?.toString()).toContain('user-invocable: true');

    const written = await writeDynamicSkillTree(target, tree);
    expect(written).toContain(path.join(target, 'scripts', 'helper.sh'));
    const actual = await readDynamicSkillTree(target, 'claude.skill');
    expect(actual).not.toBeNull();
    expect(createDynamicSkillTreeContentDigest(actual!)).toBe(
      createDynamicSkillTreeContentDigest(tree),
    );
  });

  it('rejects final file and directory path conflicts', async () => {
    const root = await makeTempRoot();
    const source = path.join(root, 'source');
    await fs.outputFile(path.join(source, 'SKILL.md'), '# skill\n');
    await fs.outputFile(path.join(source, 'agents', 'openai.yaml'), 'policy: {}\n');
    await fs.outputFile(path.join(source, 'references'), 'file\n');

    await expect(createDynamicSkillExpectedTree({
      artifact: {
        target: 'codex.skill',
        skillKey: 'example',
        state: 'present',
        content: { files: { 'references/item.md': 'item\n' } },
      },
      sourceDirs: [source],
      preference: 'default',
    })).rejects.toThrow('文件路径冲突');
  });

  it('uses length-prefixed digest inputs so file boundaries cannot collide', () => {
    const singleFile = createDynamicSkillTreeContentDigest({
      skillKey: 'example',
      files: { a: Buffer.from('b\0c\0') },
    });
    const twoFiles = createDynamicSkillTreeContentDigest({
      skillKey: 'example',
      files: {
        a: Buffer.from('b'),
        c: Buffer.alloc(0),
      },
    });

    expect(singleFile).not.toBe(twoFiles);
  });

  it('rejects a runtime root that is a symbolic link', async () => {
    const root = await makeTempRoot();
    const source = path.join(root, 'source');
    const linkedRoot = path.join(root, 'linked-skill');
    await fs.outputFile(path.join(source, 'SKILL.md'), '# linked\n');
    await fs.symlink(source, linkedRoot);

    await expect(readDynamicSkillTree(linkedRoot, 'claude.skill'))
      .rejects.toThrow('根路径必须是真实目录');
  });

  it('rejects non-file runtime entries such as Unix sockets', async () => {
    const root = await fs.mkdtemp('/tmp/aw-dst-');
    tempDirs.push(root);
    const skillRoot = path.join(root, 'skill');
    const socketPath = path.join(skillRoot, 'runtime.sock');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# skill\n');
    await fs.outputFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'policy: {}\n');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(readDynamicSkillTree(skillRoot, 'codex.skill'))
        .rejects.toThrow('只支持普通文件和目录');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('retains the backup when both commit and restore moves fail', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'runtime', 'example');
    await fs.outputFile(path.join(target, 'old.txt'), 'old\n');
    const originalMove = fs.move.bind(fs);
    let moveCount = 0;
    vi.spyOn(fs, 'move').mockImplementation(async (...args) => {
      moveCount += 1;
      if (moveCount === 1) return originalMove(...args);
      if (moveCount === 2) throw new Error('commit move failed');
      if (moveCount === 3) throw new Error('restore move failed');
      return originalMove(...args);
    });

    await expect(writeDynamicSkillTree(target, {
      skillKey: 'example',
      files: { 'new.txt': Buffer.from('new\n') },
    })).rejects.toThrow(/备份保留在 .*example-staging-.*-backup/);

    const runtimeEntries = await fs.readdir(path.dirname(target));
    const backupName = runtimeEntries.find((entry) =>
      entry.startsWith('.example-staging-') && entry.endsWith('-backup'));
    expect(backupName).toBeDefined();
    await expect(fs.readFile(path.join(path.dirname(target), backupName!, 'old.txt'), 'utf8'))
      .resolves.toBe('old\n');
  });
});
