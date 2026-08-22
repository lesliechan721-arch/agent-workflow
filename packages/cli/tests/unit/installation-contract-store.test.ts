import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  INSTALLATION_CONTRACT_METADATA_FILE,
  InstallationContractError,
  discardInstallationContract,
  inventoryInstallationContracts,
  promoteInstallationContract,
  readInstallationContract,
  removeInstallationContract,
  resolveInstallationContractTarget,
  setInstallationContractLockFileSystemForTests,
  stageInstallationContract,
} from '../../src/utils/installation-contract-store.js';
import type { ProcessLockFileSystem } from '../../src/utils/process-lock.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const OFFICIAL_IDENTITY = `sha256:${'1'.repeat(64)}`;
const TEAM_IDENTITY = `sha256:${'2'.repeat(64)}`;

function processLockFileSystem(
  overrides: Partial<ProcessLockFileSystem> = {},
): ProcessLockFileSystem {
  return {
    mkdir: (targetPath) => fs.mkdir(targetPath),
    writeFile: (targetPath, contents, options) => fs.writeFile(targetPath, contents, options),
    readFile: (targetPath, encoding) => fs.readFile(targetPath, encoding),
    readdir: (targetPath) => fs.readdir(targetPath),
    stat: (targetPath) => fs.stat(targetPath),
    lstat: (targetPath) => fs.lstat(targetPath),
    rename: (sourcePath, targetPath) => fs.rename(sourcePath, targetPath),
    link: (existingPath, newPath) => fs.link(existingPath, newPath),
    copyFile: (sourcePath, targetPath, flags) => fs.copyFile(sourcePath, targetPath, flags),
    unlink: (targetPath) => fs.unlink(targetPath),
    rmdir: (targetPath) => fs.rmdir(targetPath),
    ...overrides,
  };
}

async function createRepo(name: string): Promise<string> {
  const root = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
  await fs.ensureDir(path.join(root, '.git'));
  return root;
}

function targetOptions(cwd: string, overrides: Partial<{
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
}> = {}) {
  return {
    sourceId: 'official',
    sourceIdentity: OFFICIAL_IDENTITY,
    pluginName: 'app',
    platform: 'codex' as const,
    scope: 'user' as const,
    cwd,
    env: process.env,
    ...overrides,
  };
}

async function install(cwd: string, options: {
  version?: string;
  digest?: string;
  scope?: 'user' | 'project';
  sourceId?: string;
  sourceIdentity?: string;
  pluginName?: string;
  platform?: 'codex' | 'claude';
} = {}) {
  const staged = await stageInstallationContract({
    ...targetOptions(cwd, options),
    pluginVersion: options.version ?? '1.0.0',
    contentDigest: options.digest ?? DIGEST_A,
    dependencies: [{
      pluginId: `${options.sourceId ?? 'official'}/user-dependency`,
      sourceId: options.sourceId ?? 'official',
      sourceIdentity: options.sourceIdentity ?? OFFICIAL_IDENTITY,
      platform: options.platform ?? 'codex',
      scope: 'user',
      projectKey: null,
    }, {
      pluginId: `${options.sourceId ?? 'official'}/project-dependency`,
      sourceId: options.sourceId ?? 'official',
      sourceIdentity: options.sourceIdentity ?? OFFICIAL_IDENTITY,
      platform: options.platform ?? 'codex',
      scope: options.scope ?? 'user',
      projectKey: options.scope === 'project' ? await fs.realpath(cwd) : null,
    }],
  });
  return promoteInstallationContract(staged);
}

async function editMetadata(
  activeRoot: string,
  edit: (metadata: Record<string, unknown>) => void,
): Promise<void> {
  const metadataPath = path.join(activeRoot, INSTALLATION_CONTRACT_METADATA_FILE);
  const metadata = await fs.readJson(metadataPath) as Record<string, unknown>;
  edit(metadata);
  await fs.writeJson(metadataPath, metadata, { spaces: 2 });
}

describe('installation contract store', () => {
  it('stages, promotes, reads, and atomically replaces strict schema 1 metadata', async () => {
    const repo = await createRepo('basic');
    const first = await install(repo);

    expect(first.metadata).toMatchObject({
      schemaVersion: 1,
      sourceId: 'official',
      sourceIdentity: OFFICIAL_IDENTITY,
      pluginId: 'official/app',
      pluginName: 'app',
      pluginVersion: '1.0.0',
      contentDigest: DIGEST_A,
      platform: 'codex',
      scope: 'user',
      projectKey: null,
      metadataIntegrityDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(first.metadata.dependencies.map((dependency) => dependency.pluginId)).toEqual([
      'official/project-dependency',
      'official/user-dependency',
    ]);
    expect(first.metadata.dependencies[0]).toEqual({
      pluginId: 'official/project-dependency',
      sourceId: 'official',
      sourceIdentity: OFFICIAL_IDENTITY,
      platform: 'codex',
      scope: 'user',
      projectKey: null,
    });

    const second = await install(repo, { version: '2.0.0', digest: DIGEST_B });
    expect(second.metadata.pluginVersion).toBe('2.0.0');
    expect(second.metadata.contentDigest).toBe(DIGEST_B);
    expect((await fs.readdir(second.target.targetRoot)).sort()).toEqual(['active']);
    await expect(readInstallationContract(targetOptions(repo))).resolves.toEqual(second);
  });

  it('uses lifecycle-compatible canonical project keys and isolates source, platform, and scope', async () => {
    const repoA = await createRepo('isolation-a');
    const nestedA = path.join(repoA, 'packages', 'app');
    const repoB = await createRepo('isolation-b');
    await fs.ensureDir(nestedA);

    const userA = await resolveInstallationContractTarget(targetOptions(repoA));
    const userB = await resolveInstallationContractTarget(targetOptions(repoB));
    const projectA = await resolveInstallationContractTarget(targetOptions(repoA, { scope: 'project' }));
    const nestedProjectA = await resolveInstallationContractTarget(
      targetOptions(nestedA, { scope: 'project' }),
    );
    const projectB = await resolveInstallationContractTarget(targetOptions(repoB, { scope: 'project' }));
    const otherSource = await resolveInstallationContractTarget(targetOptions(repoA, {
      sourceId: 'team',
      sourceIdentity: TEAM_IDENTITY,
    }));
    const otherPlatform = await resolveInstallationContractTarget(targetOptions(repoA, {
      platform: 'claude',
    }));

    expect(userA.locationKey).toBe('user');
    expect(userB.targetRoot).toBe(userA.targetRoot);
    expect(projectA.projectKey).toBe(await fs.realpath(repoA));
    expect(nestedProjectA.targetRoot).toBe(projectA.targetRoot);
    expect(projectB.targetRoot).not.toBe(projectA.targetRoot);
    expect(otherSource.targetRoot).not.toBe(userA.targetRoot);
    expect(otherPlatform.targetRoot).not.toBe(userA.targetRoot);
    expect(path.relative(projectA.storeRoot, projectA.targetRoot)).toMatch(
      /^official\/codex\/project\/project-[^/]+\/app$/,
    );
  });

  it('rejects dependency placements from another source identity', async () => {
    const repo = await createRepo('cross-source-dependency');
    await expect(stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '1.0.0',
      contentDigest: DIGEST_A,
      dependencies: [{
        pluginId: 'team/dependency',
        sourceId: 'team',
        sourceIdentity: TEAM_IDENTITY,
        platform: 'codex',
        scope: 'user',
        projectKey: null,
      }],
    })).rejects.toThrow('must use the installation target source identity');
  });

  it('rejects foreign target nodes before stage and promote mutate active state', async () => {
    const repo = await createRepo('foreign-write-boundary');
    const target = await resolveInstallationContractTarget(targetOptions(repo));
    await fs.ensureDir(target.targetRoot);
    const foreignPath = path.join(target.targetRoot, 'foreign.txt');
    await fs.writeFile(foreignPath, 'foreign\n');
    await expect(stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '1.0.0',
      contentDigest: DIGEST_A,
    })).rejects.toThrow('foreign node');
    expect(await fs.pathExists(target.stagingRoot)).toBe(false);

    await fs.remove(foreignPath);
    const active = await install(repo);
    const staged = await stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '2.0.0',
      contentDigest: DIGEST_B,
    });
    await fs.writeFile(foreignPath, 'foreign\n');
    await expect(promoteInstallationContract(staged)).rejects.toThrow('foreign node');
    await fs.remove(foreignPath);
    expect((await readInstallationContract(targetOptions(repo)))?.metadata.pluginVersion)
      .toBe(active.metadata.pluginVersion);
    await discardInstallationContract(staged);
  });

  it.each([
    ['unknown field', (metadata: Record<string, unknown>) => { metadata.extra = true; }],
    ['identity', (metadata: Record<string, unknown>) => { metadata.sourceIdentity = 'changed'; }],
    ['content digest', (metadata: Record<string, unknown>) => { metadata.contentDigest = DIGEST_B; }],
    ['dependency version field', (metadata: Record<string, unknown>) => {
      const dependencies = metadata.dependencies as Array<Record<string, unknown>>;
      dependencies[0]!.pluginVersion = '9.9.9';
    }],
  ])('rejects corrupt %s metadata through the public read API', async (_label, corrupt) => {
    const repo = await createRepo(`corrupt-${_label.replace(/ /g, '-')}`);
    const active = await install(repo);
    await editMetadata(active.activeRoot, corrupt);

    await expect(readInstallationContract(targetOptions(repo))).rejects.toBeInstanceOf(
      InstallationContractError,
    );
  });

  it('restores the previous generation when atomic replacement fails', async () => {
    const repo = await createRepo('atomic-rollback');
    const first = await install(repo);
    const staged = await stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '2.0.0',
      contentDigest: DIGEST_B,
    });
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (path.resolve(String(source)) === path.resolve(staged.stageRoot)
        && path.resolve(String(destination)) === path.resolve(staged.target.activeRoot)) {
        throw new Error('injected replacement failure');
      }
      return originalRename(source, destination);
    });
    try {
      await expect(promoteInstallationContract(staged)).rejects.toThrow('injected replacement failure');
    } finally {
      rename.mockRestore();
    }
    const restored = await readInstallationContract(targetOptions(repo));
    expect(restored?.metadata.metadataIntegrityDigest).toBe(first.metadata.metadataIntegrityDigest);
    expect(restored?.metadata.pluginVersion).toBe('1.0.0');
  });

  it('reads and inventories the unique backup during the active replacement window', async () => {
    const repo = await createRepo('replacement-read-window');
    await install(repo);
    const staged = await stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '2.0.0',
      contentDigest: DIGEST_B,
    });
    const originalRename = fs.rename.bind(fs);
    let observedWindow = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      const result = await originalRename(source, destination);
      if (path.resolve(String(source)) === path.resolve(staged.target.activeRoot)
        && path.basename(String(destination)).startsWith('backup-')) {
        observedWindow = true;
        const read = await readInstallationContract(targetOptions(repo));
        expect(read?.metadata.pluginVersion).toBe('1.0.0');
        expect(read?.activeRoot).toBe(String(destination));
        const inventory = await inventoryInstallationContracts({ env: process.env });
        expect(inventory.errors).toEqual([]);
        expect(inventory.contracts).toEqual([
          expect.objectContaining({
            activeRoot: String(destination),
            metadata: expect.objectContaining({ pluginVersion: '1.0.0' }),
          }),
        ]);
      }
      return result;
    });
    try {
      await expect(promoteInstallationContract(staged)).resolves.toMatchObject({
        metadata: { pluginVersion: '2.0.0' },
      });
    } finally {
      rename.mockRestore();
    }
    expect(observedWindow).toBe(true);
  });

  it('rejects multiple backup generations as corruption', async () => {
    const repo = await createRepo('multiple-backups');
    const active = await install(repo);
    await fs.copy(active.activeRoot, path.join(active.target.targetRoot, `backup-${'1'.repeat(24)}`));
    await fs.copy(active.activeRoot, path.join(active.target.targetRoot, `backup-${'2'.repeat(24)}`));

    await expect(readInstallationContract(targetOptions(repo))).rejects.toThrow(
      'multiple backup generations',
    );
    const inventory = await inventoryInstallationContracts({ env: process.env });
    expect(inventory.contracts).toEqual([]);
    expect(inventory.errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('multiple backup generations') }),
    ]);
  });

  it('recovers one interrupted backup and removes validated abandoned staging on the next stage', async () => {
    const repo = await createRepo('interrupted-write-recovery');
    const active = await install(repo);
    const abandoned = await stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '2.0.0',
      contentDigest: DIGEST_B,
    });
    const backupRoot = path.join(active.target.targetRoot, `backup-${'3'.repeat(24)}`);
    await fs.rename(active.activeRoot, backupRoot);

    const replacement = await stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '3.0.0',
      contentDigest: DIGEST_A,
    });
    expect((await readInstallationContract(targetOptions(repo)))?.metadata.pluginVersion).toBe('1.0.0');
    expect(await fs.pathExists(backupRoot)).toBe(false);
    expect(await fs.pathExists(abandoned.stageRoot)).toBe(false);
    expect((await fs.readdir(replacement.target.stagingRoot))).toEqual([replacement.stageId]);
    await discardInstallationContract(replacement);
  });

  it('fails closed instead of recovering multiple or corrupt interrupted backups', async () => {
    const repo = await createRepo('unsafe-interrupted-recovery');
    const active = await install(repo);
    const backupA = path.join(active.target.targetRoot, `backup-${'4'.repeat(24)}`);
    const backupB = path.join(active.target.targetRoot, `backup-${'5'.repeat(24)}`);
    await fs.rename(active.activeRoot, backupA);
    await fs.copy(backupA, backupB);
    await expect(stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '2.0.0',
      contentDigest: DIGEST_B,
    })).rejects.toThrow('multiple backup generations');

    await fs.remove(backupB);
    await editMetadata(backupA, (metadata) => { metadata.contentDigest = DIGEST_B; });
    await expect(stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '2.0.0',
      contentDigest: DIGEST_B,
    })).rejects.toThrow('integrity digest');
  });

  it('restarts full read and inventory scans when active is renamed after namespace listing', async () => {
    const repo = await createRepo('rename-during-scan');
    const active = await install(repo);
    const backupRoot = path.join(active.target.targetRoot, `backup-${'6'.repeat(24)}`);
    const originalReaddir = fs.readdir.bind(fs);
    let renamedForRead = false;
    const readdir = vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      const result = await originalReaddir(...args as Parameters<typeof fs.readdir>);
      if (!renamedForRead && path.resolve(String(args[0])) === path.resolve(active.target.targetRoot)) {
        renamedForRead = true;
        await fs.rename(active.activeRoot, backupRoot);
      }
      return result;
    });
    try {
      await expect(readInstallationContract(targetOptions(repo))).resolves.toMatchObject({
        activeRoot: backupRoot,
        metadata: { pluginVersion: '1.0.0' },
      });
    } finally {
      readdir.mockRestore();
    }
    expect(renamedForRead).toBe(true);

    await fs.rename(backupRoot, active.activeRoot);
    let renamedForInventory = false;
    const inventoryReaddir = vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      const result = await originalReaddir(...args as Parameters<typeof fs.readdir>);
      if (!renamedForInventory
        && path.resolve(String(args[0])) === path.resolve(active.target.targetRoot)) {
        renamedForInventory = true;
        await fs.rename(active.activeRoot, backupRoot);
      }
      return result;
    });
    try {
      const inventory = await inventoryInstallationContracts({ env: process.env });
      expect(inventory.errors).toEqual([]);
      expect(inventory.contracts).toEqual([
        expect.objectContaining({ activeRoot: backupRoot }),
      ]);
    } finally {
      inventoryReaddir.mockRestore();
    }
    expect(renamedForInventory).toBe(true);
  });

  it('keeps a committed active generation when backup cleanup fails', async () => {
    const repo = await createRepo('post-commit-cleanup');
    await install(repo);
    const staged = await stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '2.0.0',
      contentDigest: DIGEST_B,
    });
    const originalRemove = fs.remove.bind(fs);
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const remove = vi.spyOn(fs, 'remove').mockImplementation(async (candidate) => {
      if (path.basename(String(candidate)).startsWith('backup-')) {
        throw new Error('injected backup cleanup failure');
      }
      return originalRemove(candidate);
    });
    try {
      await expect(promoteInstallationContract(staged)).resolves.toMatchObject({
        metadata: { pluginVersion: '2.0.0' },
      });
      expect(warning).toHaveBeenCalled();
    } finally {
      remove.mockRestore();
      warning.mockRestore();
    }
    expect((await readInstallationContract(targetOptions(repo)))?.metadata.pluginVersion).toBe('2.0.0');
    expect((await fs.readdir(staged.target.targetRoot)).some((entry) =>
      entry.startsWith('backup-'))).toBe(true);

    const retry = await stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '3.0.0',
      contentDigest: DIGEST_A,
    });
    expect((await fs.readdir(staged.target.targetRoot)).some((entry) =>
      entry.startsWith('backup-'))).toBe(false);
    await discardInstallationContract(retry);
  });

  it('keeps a committed active generation when lock release fails', async () => {
    const repo = await createRepo('post-commit-lock-release');
    const staged = await stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '1.0.0',
      contentDigest: DIGEST_A,
    });
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const originalRename = fs.rename.bind(fs);
    setInstallationContractLockFileSystemForTests(processLockFileSystem({
      rename: async (source, destination) => {
        if (path.basename(source) === 'owner.json') {
          throw Object.assign(new Error('injected lock release failure'), { code: 'EPERM' });
        }
        return originalRename(source, destination);
      },
    }));
    try {
      await expect(promoteInstallationContract(staged)).resolves.toMatchObject({
        metadata: { pluginVersion: '1.0.0' },
      });
      expect(warning).toHaveBeenCalled();
    } finally {
      setInstallationContractLockFileSystemForTests(undefined);
      warning.mockRestore();
    }
    expect((await readInstallationContract(targetOptions(repo)))?.metadata.pluginVersion).toBe('1.0.0');
  });

  it('retries a transient lock release failure and leaves the next write unblocked', async () => {
    const repo = await createRepo('transient-lock-release');
    const staged = await stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '1.0.0',
      contentDigest: DIGEST_A,
    });
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const originalRename = fs.rename.bind(fs);
    let failures = 0;
    setInstallationContractLockFileSystemForTests(processLockFileSystem({
      rename: async (source, destination) => {
        if (path.basename(source) === 'owner.json' && failures === 0) {
          failures += 1;
          throw Object.assign(new Error('injected transient release failure'), { code: 'EBUSY' });
        }
        return originalRename(source, destination);
      },
    }));
    try {
      await expect(promoteInstallationContract(staged)).resolves.toMatchObject({
        metadata: { pluginVersion: '1.0.0' },
      });
      expect(warning).not.toHaveBeenCalled();
    } finally {
      setInstallationContractLockFileSystemForTests(undefined);
      warning.mockRestore();
    }
    expect(failures).toBe(1);

    const next = await stageInstallationContract({
      ...targetOptions(repo),
      pluginVersion: '2.0.0',
      contentDigest: DIGEST_B,
    });
    await discardInstallationContract(next);
  });

  it('rejects symlink and foreign nodes without following or deleting outside data', async () => {
    const repo = await createRepo('unsafe-nodes');
    const active = await install(repo);
    const outside = path.join(repo, 'outside.json');
    await fs.writeJson(outside, { secret: true });
    const metadataPath = path.join(active.activeRoot, INSTALLATION_CONTRACT_METADATA_FILE);
    await fs.remove(metadataPath);
    await fs.symlink(outside, metadataPath);

    await expect(readInstallationContract(targetOptions(repo))).rejects.toThrow('symbolic link');
    await expect(removeInstallationContract(targetOptions(repo))).rejects.toThrow('symbolic link');
    await expect(fs.readJson(outside)).resolves.toEqual({ secret: true });

    await fs.remove(metadataPath);
    await fs.writeJson(metadataPath, active.metadata, { spaces: 2 });
    await fs.writeFile(path.join(active.target.targetRoot, 'foreign.txt'), 'foreign\n');
    await expect(removeInstallationContract(targetOptions(repo))).rejects.toThrow('foreign node');
    await expect(fs.readFile(path.join(active.target.targetRoot, 'foreign.txt'), 'utf8'))
      .resolves.toBe('foreign\n');
  });

  it('inventories valid contracts and reports unsafe namespaces without following them', async () => {
    const repo = await createRepo('inventory');
    const user = await install(repo);
    const project = await install(repo, {
      scope: 'project',
      pluginName: 'project-app',
      platform: 'claude',
    });
    await stageInstallationContract({
      ...targetOptions(repo, { pluginName: 'staged-only' }),
      pluginVersion: '1.0.0',
      contentDigest: DIGEST_A,
    });
    const outside = path.join(repo, 'outside-namespace');
    await fs.ensureDir(outside);
    const unsafeSource = path.join(user.target.storeRoot, 'unsafe-source');
    await fs.symlink(outside, unsafeSource);

    const inventory = await inventoryInstallationContracts({ env: process.env });
    expect(inventory.contracts.map((entry) => entry.metadata.pluginId).sort()).toEqual([
      'official/app',
      'official/project-app',
    ]);
    expect(inventory.contracts.map((entry) => entry.activeRoot)).toContain(project.activeRoot);
    expect(inventory.errors).toEqual([
      expect.objectContaining({
        code: 'invalidInstallationContract',
        path: unsafeSource,
        message: expect.stringContaining('symbolic link'),
      }),
    ]);
  });

  it('binds removal to the observed generation and is idempotent', async () => {
    const repo = await createRepo('remove');
    const active = await install(repo);

    await expect(removeInstallationContract({
      ...targetOptions(repo),
      expectedMetadataIntegrityDigest: `sha256:${'0'.repeat(64)}`,
    })).rejects.toThrow('changed before removal');
    await expect(readInstallationContract(targetOptions(repo))).resolves.not.toBeNull();

    const originalRename = fs.rename.bind(fs);
    let observedCommittedRemoval = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      const result = await originalRename(source, destination);
      if (path.resolve(String(source)) === path.resolve(active.target.targetRoot)
        && path.basename(String(destination)).startsWith('removed-')) {
        observedCommittedRemoval = true;
        await expect(readInstallationContract(targetOptions(repo))).resolves.toBeNull();
        await expect(inventoryInstallationContracts({ env: process.env })).resolves.toMatchObject({
          contracts: [],
          errors: [],
        });
      }
      return result;
    });
    try {
      await removeInstallationContract({
        ...targetOptions(repo),
        expectedMetadataIntegrityDigest: active.metadata.metadataIntegrityDigest,
      });
    } finally {
      rename.mockRestore();
    }
    expect(observedCommittedRemoval).toBe(true);
    await expect(readInstallationContract(targetOptions(repo))).resolves.toBeNull();
    await expect(removeInstallationContract(targetOptions(repo))).resolves.toBeUndefined();
  });
});
