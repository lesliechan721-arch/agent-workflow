import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-remove-'));
  roots.push(root);
  return root;
}

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
}

async function commitAll(repoRoot: string, message = 'fixture'): Promise<string> {
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', message,
  ]);
  return git(repoRoot, ['rev-parse', 'HEAD']);
}

async function createWorkspace(options: {
  git?: boolean;
  commit?: boolean;
  nested?: boolean;
  pluginName?: string;
  workspaceDirectory?: string;
} = {}): Promise<{ repoRoot: string; workspaceRoot: string; pluginRoot: string }> {
  const repoRoot = await fs.realpath(await createRoot());
  const workspaceRoot = options.workspaceDirectory
    ? path.join(repoRoot, options.workspaceDirectory)
    : options.nested ? path.join(repoRoot, 'catalog', 'workspace') : repoRoot;
  await fs.ensureDir(workspaceRoot);
  if (options.git !== false) await git(repoRoot, ['init']);
  expect(await runCli(['catalog', 'init', '--workspace-root', workspaceRoot], {
    cwd: workspaceRoot,
    io: capture().io,
  })).toBe(0);
  const pluginName = options.pluginName ?? 'remove-me';
  expect(await runCli([
    'plugin', 'init', pluginName,
    '--description', 'Plugin removal integration fixture.',
    '--no-skills', '--workspace-root', workspaceRoot,
  ], { cwd: workspaceRoot, io: capture().io })).toBe(0);
  if (options.git !== false && options.commit !== false) await commitAll(repoRoot);
  return {
    repoRoot,
    workspaceRoot,
    pluginRoot: path.join(workspaceRoot, 'plugins', pluginName),
  };
}

async function treeSnapshot(root: string): Promise<unknown> {
  const rootStat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootStat) return null;
  if (rootStat.isSymbolicLink()) return { type: 'symlink', target: await fs.readlink(root) };
  const entries: Array<{ path: string; type: string; mode: number; content?: string }> = [];
  async function visit(current: string, prefix = ''): Promise<void> {
    for (const name of (await fs.readdir(current)).sort()) {
      const absolutePath = path.join(current, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relativePath, type: 'symlink', mode: stat.mode, content: await fs.readlink(absolutePath) });
      } else if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory', mode: stat.mode });
        await visit(absolutePath, relativePath);
      } else {
        entries.push({
          path: relativePath,
          type: 'file',
          mode: stat.mode,
          content: (await fs.readFile(absolutePath)).toString('base64'),
        });
      }
    }
  }
  await visit(root);
  return entries;
}

async function removeJson(
  workspaceRoot: string,
  pluginName = 'remove-me',
  extraArgs: string[] = ['--yes'],
): Promise<{ exitCode: number; stdout: string; stderr: string; receipt: any }> {
  const output = capture();
  const exitCode = await runCli([
    'plugin', 'remove', pluginName,
    '--workspace-root', workspaceRoot,
    ...extraArgs,
    '--json',
  ], { cwd: workspaceRoot, io: output.io });
  const stdout = output.stdout();
  return {
    exitCode,
    stdout,
    stderr: output.stderr(),
    receipt: JSON.parse(stdout),
  };
}

async function expectFailureWithoutMutation(options: {
  workspaceRoot: string;
  pluginRoot: string;
  code: string;
  pluginName?: string;
  extraArgs?: string[];
}): Promise<void> {
  const before = await treeSnapshot(options.pluginRoot);
  const result = await removeJson(
    options.workspaceRoot,
    options.pluginName,
    options.extraArgs,
  );
  expect(result.exitCode).toBe(1);
  expect(result.receipt).toMatchObject({
    schemaVersion: 1,
    command: 'plugin:remove',
    ok: false,
    removed: false,
    errors: [{ code: options.code }],
  });
  expect(result.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
  expect(result.stderr).toContain('[ERROR]');
  expect(await treeSnapshot(options.pluginRoot)).toEqual(before);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('aw plugin remove', () => {
  it('removes only a clean committed plugin from a nested Workspace and preserves unrelated changes', async () => {
    const fixture = await createWorkspace({ nested: true });
    const baseCommit = await git(fixture.repoRoot, ['rev-parse', 'HEAD']);
    const canonicalWorkspaceRoot = await fs.realpath(fixture.workspaceRoot);
    const canonicalPluginRoot = await fs.realpath(fixture.pluginRoot);
    const metadataPath = path.join(fixture.workspaceRoot, 'plugins', 'marketplace-source.json');
    const metadata = await fs.readJson(metadataPath);
    metadata.interface.displayName = 'Unrelated dirty metadata';
    await fs.writeJson(metadataPath, metadata, { spaces: 2 });

    const result = await removeJson(fixture.workspaceRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
    expect(result.receipt).toEqual({
      schemaVersion: 1,
      command: 'plugin:remove',
      ok: true,
      workspaceRoot: canonicalWorkspaceRoot,
      workspaceRootResolvedFrom: 'explicit',
      baseCommit,
      plugin: {
        name: 'remove-me',
        version: '0.1.0',
        root: canonicalPluginRoot,
      },
      removed: true,
      errors: [],
    });
    await expect(fs.pathExists(fixture.pluginRoot)).resolves.toBe(false);
    expect((await git(fixture.repoRoot, ['status', '--short'])).split('\n')).toEqual(expect.arrayContaining([
      expect.stringContaining('plugins/marketplace-source.json'),
      expect.stringContaining('plugins/remove-me/'),
    ]));
  });

  it('treats a pathspec-magic Workspace directory as a literal Git target path', async () => {
    const fixture = await createWorkspace({ workspaceDirectory: ':(exclude)catalog' });

    const result = await removeJson(fixture.workspaceRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.receipt).toMatchObject({
      ok: true,
      workspaceRoot: fixture.workspaceRoot,
      plugin: { name: 'remove-me', root: fixture.pluginRoot },
      removed: true,
      errors: [],
    });
    await expect(fs.pathExists(fixture.pluginRoot)).resolves.toBe(false);
  });

  it('rejects a Workspace input path with a symlink ancestor without modifying the real target', async () => {
    const fixture = await createWorkspace({ nested: true });
    const aliasRoot = path.join(fixture.repoRoot, 'workspace-alias');
    await fs.symlink(fixture.workspaceRoot, aliasRoot);

    await expectFailureWithoutMutation({
      workspaceRoot: aliasRoot,
      pluginRoot: fixture.pluginRoot,
      code: 'unsafePluginPath',
    });
    expect((await fs.lstat(aliasRoot)).isSymbolicLink()).toBe(true);
  });

  it('requires --yes and keeps the complete target tree unchanged', async () => {
    const fixture = await createWorkspace();
    await expectFailureWithoutMutation({
      workspaceRoot: fixture.workspaceRoot,
      pluginRoot: fixture.pluginRoot,
      code: 'confirmationRequired',
      extraArgs: [],
    });
  });

  it('rejects a valid Workspace outside Git', async () => {
    const fixture = await createWorkspace({ git: false });
    await expectFailureWithoutMutation({
      workspaceRoot: fixture.workspaceRoot,
      pluginRoot: fixture.pluginRoot,
      code: 'gitWorkspaceInvalid',
    });
  });

  it('rejects an unborn Git repository', async () => {
    const fixture = await createWorkspace({ commit: false });
    await expectFailureWithoutMutation({
      workspaceRoot: fixture.workspaceRoot,
      pluginRoot: fixture.pluginRoot,
      code: 'sourceHeadMissing',
    });
  });

  it('rejects a target plugin that is not present in HEAD', async () => {
    const fixture = await createWorkspace({ commit: false });
    await git(fixture.repoRoot, [
      'add', '.aw-workspace.json', '.gitignore', 'plugins/marketplace-source.json',
    ]);
    await git(fixture.repoRoot, [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'workspace without target',
    ]);
    const statusBefore = await git(fixture.repoRoot, ['status', '--porcelain=v1']);
    await expectFailureWithoutMutation({
      workspaceRoot: fixture.workspaceRoot,
      pluginRoot: fixture.pluginRoot,
      code: 'pluginNotCommitted',
    });
    expect(await git(fixture.repoRoot, ['status', '--porcelain=v1'])).toBe(statusBefore);
  });

  it.each([
    ['tracked modified', async (fixture: Awaited<ReturnType<typeof createWorkspace>>) => {
      await fs.appendFile(path.join(fixture.pluginRoot, 'README.md'), 'modified\n');
    }],
    ['staged modification', async (fixture: Awaited<ReturnType<typeof createWorkspace>>) => {
      await fs.appendFile(path.join(fixture.pluginRoot, 'README.md'), 'staged\n');
      await git(fixture.repoRoot, ['add', '--', path.relative(fixture.repoRoot, fixture.pluginRoot)]);
    }],
    ['tracked deletion', async (fixture: Awaited<ReturnType<typeof createWorkspace>>) => {
      await fs.remove(path.join(fixture.pluginRoot, 'README.md'));
    }],
    ['executable mode change', async (fixture: Awaited<ReturnType<typeof createWorkspace>>) => {
      await fs.chmod(path.join(fixture.pluginRoot, 'README.md'), 0o755);
    }],
    ['untracked node', async (fixture: Awaited<ReturnType<typeof createWorkspace>>) => {
      await fs.writeFile(path.join(fixture.pluginRoot, 'untracked.txt'), 'untracked\n');
    }],
    ['ignored node', async (fixture: Awaited<ReturnType<typeof createWorkspace>>) => {
      await fs.appendFile(path.join(fixture.repoRoot, '.gitignore'), 'plugins/remove-me/ignored.txt\n');
      await commitAll(fixture.repoRoot, 'ignore removal fixture');
      await fs.writeFile(path.join(fixture.pluginRoot, 'ignored.txt'), 'ignored\n');
    }],
  ])('rejects a %s without changing the dirty tree', async (_label, mutate) => {
    const fixture = await createWorkspace();
    await mutate(fixture);
    await expectFailureWithoutMutation({
      workspaceRoot: fixture.workspaceRoot,
      pluginRoot: fixture.pluginRoot,
      code: 'pluginTreeDirty',
    });
  });

  it('rejects an extra empty directory that Git status cannot inventory', async () => {
    const fixture = await createWorkspace();
    await fs.ensureDir(path.join(fixture.pluginRoot, 'empty-extra'));
    await expectFailureWithoutMutation({
      workspaceRoot: fixture.workspaceRoot,
      pluginRoot: fixture.pluginRoot,
      code: 'pluginTreeMismatch',
    });
  });

  it('rejects a symbolic-link manifest path identity without following it', async () => {
    const fixture = await createWorkspace();
    const manifestPath = path.join(fixture.pluginRoot, '.agents-plugin', 'plugin.json');
    const outsideManifest = path.join(fixture.workspaceRoot, 'outside-manifest.json');
    await fs.copy(manifestPath, outsideManifest);
    await fs.remove(manifestPath);
    await fs.symlink(outsideManifest, manifestPath);
    await expectFailureWithoutMutation({
      workspaceRoot: fixture.workspaceRoot,
      pluginRoot: fixture.pluginRoot,
      code: 'unsafePluginPath',
    });
    await expect(fs.readFile(outsideManifest, 'utf8')).resolves.toContain('remove-me');
  });

  it('rejects a manifest name mismatch without modifying the target', async () => {
    const fixture = await createWorkspace();
    const manifestPath = path.join(fixture.pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.name = 'different-name';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expectFailureWithoutMutation({
      workspaceRoot: fixture.workspaceRoot,
      pluginRoot: fixture.pluginRoot,
      code: 'manifestNameMismatch',
    });
  });

  it('lists reverse dependents and keeps both plugins unchanged', async () => {
    const fixture = await createWorkspace();
    expect(await runCli([
      'plugin', 'init', 'dependent', '--description', 'Reverse dependency fixture.',
      '--no-skills', '--workspace-root', fixture.workspaceRoot,
    ], { cwd: fixture.workspaceRoot, io: capture().io })).toBe(0);
    const dependentRoot = path.join(fixture.workspaceRoot, 'plugins', 'dependent');
    const manifestPath = path.join(dependentRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.dependencies = ['remove-me'];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await commitAll(fixture.repoRoot, 'dependent fixture');
    const dependentBefore = await treeSnapshot(dependentRoot);

    const result = await removeJson(fixture.workspaceRoot);

    expect(result.exitCode).toBe(1);
    expect(result.receipt).toMatchObject({
      ok: false,
      removed: false,
      errors: [{ code: 'reverseDependencies', message: expect.stringContaining('dependent') }],
    });
    expect(await treeSnapshot(dependentRoot)).toEqual(dependentBefore);
    await expect(fs.pathExists(fixture.pluginRoot)).resolves.toBe(true);
  });

  it('reports an absent canonical target without creating it', async () => {
    const fixture = await createWorkspace();
    await fs.remove(fixture.pluginRoot);
    await commitAll(fixture.repoRoot, 'remove target from HEAD');
    await expectFailureWithoutMutation({
      workspaceRoot: fixture.workspaceRoot,
      pluginRoot: fixture.pluginRoot,
      code: 'pluginNotFound',
    });
    await expect(fs.pathExists(fixture.pluginRoot)).resolves.toBe(false);
  });
});
