import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OwnerIdentity, OwnedComponent } from '../../src/utils/ownership.js';
import {
  cleanupOwnedComponents,
  inspectOwnedComponents,
  parseOwnedTextHeader,
  readSkillOwnerMarker,
  renderOwnedTextFile,
  setAtomicReplaceBeforeRenameHookForTests,
  SKILL_OWNER_MARKER,
  writeOwnedTextFile,
  writeSkillOwnerMarker,
} from '../../src/utils/ownership.js';
import { validateSkillDirectory } from '../../src/utils/dynamic-skill-tree.js';

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-ownership-'));
  tempDirs.push(root);
  return root;
}

function userIdentity(artifactKey = 'review'): OwnerIdentity {
  return {
    owner: 'agent-workflows',
    plugin: 'ownership-test',
    artifactKey,
    platform: 'codex',
    scope: 'user',
  };
}

afterEach(async () => {
  setAtomicReplaceBeforeRenameHookForTests(undefined);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('ownership marker and header', () => {
  it('roundtrips a project marker without machine-local paths', async () => {
    const root = await makeTempRoot();
    const projectRoot = path.join(root, 'repo');
    const skillsRoot = path.join(projectRoot, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'review');
    await fs.ensureDir(skillRoot);
    const identity: OwnerIdentity = {
      ...userIdentity(),
      scope: 'project',
    };

    await writeSkillOwnerMarker({ skillRoot, allowedRoot: skillsRoot, identity });

    await expect(readSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      expectedIdentity: identity,
    })).resolves.toEqual({ schemaVersion: 1, ...identity });
    await expect(fs.readFile(path.join(skillRoot, SKILL_OWNER_MARKER), 'utf8'))
      .resolves.not.toContain(projectRoot);
  });

  it('rejects invalid marker identity and path traversal', async () => {
    const root = await makeTempRoot();
    const skillsRoot = path.join(root, 'skills');
    const skillRoot = path.join(skillsRoot, 'review');
    await fs.ensureDir(skillRoot);

    await expect(writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: { ...userIdentity(), plugin: '../foreign' },
    })).rejects.toThrow('安全的单一路径 segment');
    await expect(writeSkillOwnerMarker({
      skillRoot: path.join(root, 'outside', 'review'),
      allowedRoot: skillsRoot,
      identity: userIdentity(),
    })).rejects.toThrow('路径越界');

    await fs.writeJson(path.join(skillRoot, SKILL_OWNER_MARKER), {
      schemaVersion: 2,
      owner: 'agent-workflows',
      plugin: 'ownership-test',
      artifactKey: 'review',
      platform: 'codex',
      scope: 'user',
    });
    await expect(readSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      expectedIdentity: userIdentity(),
    })).rejects.toThrow('schemaVersion 必须是 1');
  });

  it('rejects a symlink skill directory and symlink marker', async () => {
    const root = await makeTempRoot();
    const skillsRoot = path.join(root, 'skills');
    const realSkill = path.join(root, 'real-review');
    const linkedSkill = path.join(skillsRoot, 'review');
    await fs.ensureDir(skillsRoot);
    await fs.ensureDir(realSkill);
    await fs.symlink(realSkill, linkedSkill);

    await expect(writeSkillOwnerMarker({
      skillRoot: linkedSkill,
      allowedRoot: skillsRoot,
      identity: userIdentity(),
    })).rejects.toThrow('符号链接');

    await fs.remove(linkedSkill);
    await fs.ensureDir(linkedSkill);
    const externalMarker = path.join(root, 'marker.json');
    await fs.writeJson(externalMarker, { schemaVersion: 1 });
    await fs.symlink(externalMarker, path.join(linkedSkill, SKILL_OWNER_MARKER));
    await expect(readSkillOwnerMarker({
      skillRoot: linkedSkill,
      allowedRoot: skillsRoot,
      expectedIdentity: userIdentity(),
    })).rejects.toThrow('符号链接');
  });

  it('places one strict header after YAML frontmatter', () => {
    const original = '---\npaths:\n  - src/**\n---\n\n# Rule\n';
    const rendered = renderOwnedTextFile(original, userIdentity('rule'));
    const parsed = parseOwnedTextHeader(rendered, userIdentity('rule'));

    expect(rendered.startsWith('---\npaths:\n  - src/**\n---\n# agent-workflows-owner: ')).toBe(true);
    expect(parsed?.content).toBe(original);
    expect(() => parseOwnedTextHeader(rendered, userIdentity('foreign'))).toThrow(
      'identity 与目标 identity 不匹配',
    );
  });
});

describe('ownership inspection and cleanup', () => {
  it('reports present, absent, and partial from live ownership', async () => {
    const root = await makeTempRoot();
    const allowedRoot = path.join(root, 'rules');
    const ownedPath = path.join(allowedRoot, 'aw-owned.rules');
    const absentPath = path.join(allowedRoot, 'aw-absent.rules');
    const foreignPath = path.join(allowedRoot, 'aw-foreign.rules');
    await writeOwnedTextFile({
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
      content: 'allow\n',
    });
    await fs.outputFile(foreignPath, 'foreign\n');

    const owned: OwnedComponent = {
      kind: 'owned-text-file',
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
    };
    const absent: OwnedComponent = {
      kind: 'owned-text-file',
      path: absentPath,
      allowedRoot,
      identity: userIdentity('absent'),
    };
    const foreign: OwnedComponent = {
      kind: 'owned-text-file',
      path: foreignPath,
      allowedRoot,
      identity: userIdentity('foreign'),
    };

    await expect(inspectOwnedComponents({ components: [owned] })).resolves.toMatchObject({
      state: 'present',
    });
    await expect(inspectOwnedComponents({ components: [absent] })).resolves.toMatchObject({
      state: 'absent',
    });
    await expect(inspectOwnedComponents({ components: [owned, absent, foreign] })).resolves.toMatchObject({
      state: 'partial',
      components: [{ state: 'present' }, { state: 'absent' }, { state: 'partial' }],
    });
  });

  it('is idempotent and preserves a foreign aw-* collision without a matching header', async () => {
    const root = await makeTempRoot();
    const allowedRoot = path.join(root, 'rules');
    const ownedPath = path.join(allowedRoot, 'aw-owned.rules');
    const foreignPath = path.join(allowedRoot, 'aw-foreign.rules');
    await writeOwnedTextFile({
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
      content: 'allow\n',
    });
    await fs.outputFile(foreignPath, 'foreign\n');
    const components: OwnedComponent[] = [
      {
        kind: 'owned-text-file',
        path: ownedPath,
        allowedRoot,
        identity: userIdentity('owned'),
      },
      {
        kind: 'owned-text-file',
        path: foreignPath,
        allowedRoot,
        identity: userIdentity('foreign'),
      },
    ];

    await expect(cleanupOwnedComponents({ components })).resolves.toEqual({
      removed: [ownedPath],
      absent: [],
      residual: [foreignPath],
      quarantined: [],
      failures: [],
    });
    await expect(cleanupOwnedComponents({ components })).resolves.toEqual({
      removed: [],
      absent: [ownedPath],
      residual: [foreignPath],
      quarantined: [],
      failures: [],
    });
    await expect(fs.readFile(foreignPath, 'utf8')).resolves.toBe('foreign\n');
    await expect(cleanupOwnedComponents({
      components: [{
        kind: 'owned-text-file',
        path: path.join(root, 'outside.rules'),
        allowedRoot,
        identity: userIdentity('outside'),
      }],
    })).resolves.toMatchObject({
      removed: [],
      residual: [path.join(root, 'outside.rules')],
      failures: [{ phase: 'probe', message: expect.stringContaining('路径越界') }],
    });
  });

  it('deletes only a skill directory with a matching marker', async () => {
    const root = await makeTempRoot();
    const skillsRoot = path.join(root, 'skills');
    const ownedRoot = path.join(skillsRoot, 'owned');
    const foreignRoot = path.join(skillsRoot, 'foreign');
    await fs.outputFile(path.join(ownedRoot, 'SKILL.md'), '# owned\n');
    await fs.outputFile(path.join(foreignRoot, 'SKILL.md'), '# foreign\n');
    await writeSkillOwnerMarker({
      skillRoot: ownedRoot,
      allowedRoot: skillsRoot,
      identity: userIdentity('owned'),
    });
    const components: OwnedComponent[] = [
      {
        kind: 'skill-directory',
        path: ownedRoot,
        allowedRoot: skillsRoot,
        identity: userIdentity('owned'),
      },
      {
        kind: 'skill-directory',
        path: foreignRoot,
        allowedRoot: skillsRoot,
        identity: userIdentity('foreign'),
      },
    ];

    await expect(cleanupOwnedComponents({ components })).resolves.toEqual({
      removed: [ownedRoot],
      absent: [],
      residual: [foreignRoot],
      quarantined: [],
      failures: [],
    });
    await expect(fs.pathExists(ownedRoot)).resolves.toBe(false);
    await expect(fs.readFile(path.join(foreignRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# foreign\n');
  });

  it('treats a verified pristine unowned Skill as absent and preserves drift as foreign', async () => {
    const root = await makeTempRoot();
    const skillsRoot = path.join(root, 'skills');
    const skillRoot = path.join(skillsRoot, 'review');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# pristine\n');
    const component: OwnedComponent = {
      kind: 'skill-directory',
      path: skillRoot,
      allowedRoot: skillsRoot,
      identity: userIdentity(),
      unownedIsPristine: async (actualPath) =>
        await fs.readFile(path.join(actualPath, 'SKILL.md'), 'utf8') === '# pristine\n',
    };

    await expect(inspectOwnedComponents({ components: [component] })).resolves.toMatchObject({
      state: 'absent',
      components: [{ state: 'absent' }],
    });
    await expect(cleanupOwnedComponents({ components: [component] })).resolves.toEqual({
      removed: [],
      absent: [skillRoot],
      residual: [],
      quarantined: [],
      failures: [],
    });
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);

    await fs.writeFile(path.join(skillRoot, 'SKILL.md'), '# changed\n');
    await expect(cleanupOwnedComponents({ components: [component] })).resolves.toMatchObject({
      removed: [],
      residual: [skillRoot],
    });
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# changed\n');
  });

  it.each(['codex', 'claude'] as const)(
    'reports owned %s Skill health separately from deletion authorization',
    async (platform) => {
      const root = await makeTempRoot();
      const skillsRoot = path.join(root, 'skills');
      const skillRoot = path.join(skillsRoot, 'review');
      const identity = { ...userIdentity(), platform };
      if (platform === 'codex') {
        await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# Review\n');
      } else {
        await fs.ensureDir(skillRoot);
      }
      await writeSkillOwnerMarker({
        skillRoot,
        allowedRoot: skillsRoot,
        identity,
      });
      const component: OwnedComponent = {
        kind: 'skill-directory',
        path: skillRoot,
        allowedRoot: skillsRoot,
        identity,
        validateHealth: async () => {
          await validateSkillDirectory(
            skillRoot,
            platform === 'codex' ? 'codex.skill' : 'claude.skill',
            { ownerMarkerPolicy: 'ignore' },
          );
        },
      };

      await expect(inspectOwnedComponents({ components: [component] })).resolves.toMatchObject({
        state: 'present',
      });
      await expect(inspectOwnedComponents({
        components: [component],
        verifyHealth: true,
      })).resolves.toMatchObject({
        state: 'partial',
        components: [{
          state: 'partial',
          diagnostic: expect.stringContaining(
            platform === 'codex' ? 'agents/openai.yaml' : 'SKILL.md',
          ),
        }],
      });
      await expect(cleanupOwnedComponents({ components: [component] })).resolves.toMatchObject({
        removed: [skillRoot],
        residual: [],
      });
    },
  );

  it('uses injected managed-block and native plugin probes', async () => {
    let managedPresent = true;
    let nativePresent = true;
    const managed: OwnedComponent = {
      kind: 'managed-block',
      identity: userIdentity('instructions'),
      label: 'managed instructions',
      inspect: async () => managedPresent ? 'present' : 'absent',
      remove: async () => { managedPresent = false; },
    };
    const native: OwnedComponent = {
      kind: 'native-plugin',
      identity: userIdentity('native'),
      pluginId: 'ownership-test@aw',
    };
    const nativeProbe = async () => nativePresent ? 'present' as const : 'absent' as const;

    await expect(inspectOwnedComponents({
      components: [managed, native],
      nativeProbe,
    })).resolves.toMatchObject({ state: 'present' });
    await expect(cleanupOwnedComponents({
      components: [managed, native],
      nativeProbe,
      nativeRemove: async () => { nativePresent = false; },
    })).resolves.toEqual({
      removed: ['managed instructions', 'ownership-test@aw'],
      absent: [],
      residual: [],
      quarantined: [],
      failures: [],
    });
  });

  it('atomically replaces hardlinked text and marker files without changing the external inode', async () => {
    // Threat model: pre-existing links and cooperative API concurrency are defended. Node does not
    // provide a portable dirfd/openat/renameat2 sequence for a hostile same-permission process.
    const root = await makeTempRoot();
    const rulesRoot = path.join(root, 'rules');
    const externalText = path.join(root, 'external.txt');
    const ownedPath = path.join(rulesRoot, 'aw-owned.rules');
    await fs.outputFile(externalText, 'external text\n');
    await fs.ensureDir(rulesRoot);
    await fs.link(externalText, ownedPath);

    await writeOwnedTextFile({
      path: ownedPath,
      allowedRoot: rulesRoot,
      identity: userIdentity('owned'),
      content: 'owned text\n',
    });
    await expect(fs.readFile(externalText, 'utf8')).resolves.toBe('external text\n');
    await expect(fs.readFile(ownedPath, 'utf8')).resolves.toContain('owned text\n');

    const skillsRoot = path.join(root, 'skills');
    const skillRoot = path.join(skillsRoot, 'review');
    const externalMarker = path.join(root, 'external-marker.json');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# review\n');
    await fs.outputFile(externalMarker, 'external marker\n');
    await fs.link(externalMarker, path.join(skillRoot, SKILL_OWNER_MARKER));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: userIdentity(),
    });
    await expect(fs.readFile(externalMarker, 'utf8')).resolves.toBe('external marker\n');
    await expect(readSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      expectedIdentity: userIdentity(),
    })).resolves.toMatchObject({ owner: 'agent-workflows' });
  });

  it('rejects atomic replace when the stable parent identity changes before rename', async () => {
    const root = await makeTempRoot();
    const allowedRoot = path.join(root, 'rules');
    const ownedPath = path.join(allowedRoot, 'aw-owned.rules');
    await fs.outputFile(ownedPath, 'old content\n');
    const originalLstat = fs.lstat.bind(fs);
    let reportChangedParent = false;
    vi.spyOn(fs, 'lstat').mockImplementation(async (candidate) => {
      const stats = await originalLstat(candidate);
      if (reportChangedParent && path.resolve(String(candidate)) === path.resolve(allowedRoot)) {
        const changed = Object.create(stats) as typeof stats;
        Object.defineProperty(changed, 'ino', { value: stats.ino + 1 });
        return changed;
      }
      return stats;
    });
    setAtomicReplaceBeforeRenameHookForTests(async () => {
      reportChangedParent = true;
    });

    await expect(writeOwnedTextFile({
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
      content: 'new content\n',
    })).rejects.toThrow('identity 在 atomic rename 前发生变化');
    await expect(fs.readFile(ownedPath, 'utf8')).resolves.toBe('old content\n');
    expect((await fs.readdir(allowedRoot)).filter((entry) => entry.includes('.owner-'))).toEqual([]);
  });

  it('retains the exact quarantine path for a concurrent foreign replacement', async () => {
    const root = await makeTempRoot();
    const allowedRoot = path.join(root, 'rules');
    const ownedPath = path.join(allowedRoot, 'aw-owned.rules');
    await writeOwnedTextFile({
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
      content: 'owned\n',
    });
    const component: OwnedComponent = {
      kind: 'owned-text-file',
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
    };

    const result = await cleanupOwnedComponents({
      components: [component],
      beforeMutation: async () => {
        await fs.remove(ownedPath);
        await fs.outputFile(ownedPath, 'foreign replacement\n');
      },
    });

    expect(result).toMatchObject({
      removed: [],
      residual: [ownedPath],
      quarantined: [expect.stringContaining('.agent-workflows-quarantine-')],
      failures: [{ phase: 'verify' }],
    });
    await expect(fs.pathExists(ownedPath)).resolves.toBe(false);
    await expect(fs.readFile(result.quarantined[0]!, 'utf8')).resolves.toBe('foreign replacement\n');
  });

  it('does not overwrite a concurrently occupied canonical path after quarantine verification fails', async () => {
    const root = await makeTempRoot();
    const allowedRoot = path.join(root, 'rules');
    const ownedPath = path.join(allowedRoot, 'aw-owned.rules');
    await writeOwnedTextFile({
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
      content: 'owned\n',
    });
    const component: OwnedComponent = {
      kind: 'owned-text-file',
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
    };

    const result = await cleanupOwnedComponents({
      components: [component],
      afterQuarantine: async (_entry, quarantinePath) => {
        await fs.outputFile(ownedPath, 'foreign canonical\n');
        await fs.writeFile(quarantinePath, 'foreign quarantine\n');
      },
    });

    expect(result.quarantined).toHaveLength(1);
    await expect(fs.readFile(ownedPath, 'utf8')).resolves.toBe('foreign canonical\n');
    await expect(fs.readFile(result.quarantined[0]!, 'utf8')).resolves.toBe('foreign quarantine\n');
  });

  it('does not overwrite a canonical path after its parent directory changes', async () => {
    const root = await makeTempRoot();
    const allowedRoot = path.join(root, 'rules');
    const parentRoot = path.join(allowedRoot, 'nested');
    const movedParentRoot = path.join(allowedRoot, 'nested-old');
    const ownedPath = path.join(parentRoot, 'aw-owned.rules');
    await writeOwnedTextFile({
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
      content: 'owned\n',
    });
    const component: OwnedComponent = {
      kind: 'owned-text-file',
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
    };

    const result = await cleanupOwnedComponents({
      components: [component],
      afterQuarantine: async (_entry, quarantinePath) => {
        await fs.move(parentRoot, movedParentRoot);
        await fs.outputFile(ownedPath, 'foreign new parent\n');
        await fs.writeFile(quarantinePath, 'foreign quarantine\n');
      },
    });

    expect(result.quarantined).toHaveLength(1);
    await expect(fs.readFile(ownedPath, 'utf8')).resolves.toBe('foreign new parent\n');
    await expect(fs.readFile(result.quarantined[0]!, 'utf8')).resolves.toBe('foreign quarantine\n');
  });

  it('reports probe errors and performs no mutation when any initial probe fails', async () => {
    const root = await makeTempRoot();
    const allowedRoot = path.join(root, 'rules');
    const ownedPath = path.join(allowedRoot, 'aw-owned.rules');
    await writeOwnedTextFile({
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
      content: 'owned\n',
    });
    const owned: OwnedComponent = {
      kind: 'owned-text-file',
      path: ownedPath,
      allowedRoot,
      identity: userIdentity('owned'),
    };
    const unreadable: OwnedComponent = {
      kind: 'shared-config',
      identity: userIdentity('shared'),
      label: 'unreadable shared config',
      inspect: async () => { throw new Error('probe failed'); },
      remove: async () => { throw new Error('must not run'); },
    };

    await expect(inspectOwnedComponents({ components: [owned, unreadable] })).resolves.toMatchObject({
      state: 'error',
      components: [{ state: 'present' }, { state: 'error' }],
      errors: [{ label: 'unreadable shared config', message: 'probe failed' }],
    });
    await expect(cleanupOwnedComponents({ components: [owned, unreadable] })).resolves.toMatchObject({
      removed: [],
      residual: [ownedPath, 'unreadable shared config'],
      failures: [{ label: 'unreadable shared config', phase: 'probe' }],
    });
    await expect(fs.pathExists(ownedPath)).resolves.toBe(true);
  });

  it('returns remove and post-probe failures without losing earlier progress', async () => {
    let removedHealthy = false;
    let postProbeCount = 0;
    const healthy: OwnedComponent = {
      kind: 'managed-block',
      identity: userIdentity('healthy'),
      label: 'healthy block',
      inspect: async () => removedHealthy ? 'absent' : 'present',
      remove: async () => { removedHealthy = true; },
    };
    const removeFailure: OwnedComponent = {
      kind: 'managed-block',
      identity: userIdentity('remove-failure'),
      label: 'remove failure',
      inspect: async () => 'present',
      remove: async () => { throw new Error('remove failed'); },
    };
    const postProbeFailure: OwnedComponent = {
      kind: 'managed-block',
      identity: userIdentity('post-probe-failure'),
      label: 'post-probe failure',
      inspect: async () => {
        postProbeCount += 1;
        if (postProbeCount > 1) throw new Error('post-probe failed');
        return 'present';
      },
      remove: async () => undefined,
    };

    await expect(cleanupOwnedComponents({
      components: [healthy, removeFailure, postProbeFailure],
    })).resolves.toMatchObject({
      removed: ['healthy block'],
      residual: ['remove failure', 'post-probe failure'],
      failures: [
        { label: 'remove failure', phase: 'remove', message: 'remove failed' },
        { label: 'post-probe failure', phase: 'post-probe', message: 'post-probe failed' },
      ],
    });
  });
});
