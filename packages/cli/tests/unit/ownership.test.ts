import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  OwnerIdentity,
  OwnedComponent,
  OwnedComponentExecutor,
} from '../../src/utils/ownership.js';
import {
  cleanupOwnedComponents,
  createSharedOwnerToken,
  inspectOwnedComponents,
  parseOwnedTextHeader,
  parseSharedOwnerToken,
  readSkillOwnerMarker,
  renderOwnedTextFile,
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
    sourceId: 'official',
    pluginId: 'official/ownership-test',
    plugin: 'ownership-test',
    artifactKey,
    platform: 'codex',
    scope: 'user',
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('ownership marker and header', () => {
  it('uses the v3 stable owner token and does not read a v2 token', () => {
    const identity = userIdentity();
    const token = createSharedOwnerToken(identity);
    expect(token.startsWith('aw-owner-v3:')).toBe(true);
    expect(parseSharedOwnerToken(token)).toEqual(identity);
    const legacy = `aw-owner-v2:${Buffer.from(JSON.stringify({
      schemaVersion: 2,
      ...identity,
      sourceIdentity: `sha256:${'a'.repeat(64)}`,
    })).toString('base64url')}`;
    expect(parseSharedOwnerToken(legacy)).toBeNull();
  });

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
    })).resolves.toEqual({ schemaVersion: 3, ...identity });
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
    })).rejects.toThrow('schema 3 stable plugin identity');
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
      components: [{ state: 'present' }, { state: 'absent' }, {
        state: 'foreign',
        collision: {
          reason: 'unownedContent',
          artifactKind: 'owned-text-file',
          artifactKey: 'foreign',
          expectedOwner: 'official/ownership-test',
        },
      }],
    });
  });

  it('classifies owner, unowned-content, and type collisions without exposing paths', async () => {
    const root = await makeTempRoot();
    const allowedRoot = path.join(root, 'rules');
    const ownerMismatchPath = path.join(allowedRoot, 'owner-mismatch.rules');
    const unownedPath = path.join(allowedRoot, 'unowned.rules');
    const typeMismatchPath = path.join(allowedRoot, 'type-mismatch.rules');
    await writeOwnedTextFile({
      path: ownerMismatchPath,
      allowedRoot,
      identity: {
        ...userIdentity('owner-mismatch'),
        plugin: 'other-owner',
        pluginId: 'official/other-owner',
      },
      content: 'allow\n',
    });
    await fs.outputFile(unownedPath, 'foreign\n');
    await fs.ensureDir(typeMismatchPath);
    const result = await inspectOwnedComponents({
      components: [
        { kind: 'owned-text-file', path: ownerMismatchPath, allowedRoot,
          identity: userIdentity('owner-mismatch') },
        { kind: 'owned-text-file', path: unownedPath, allowedRoot,
          identity: userIdentity('unowned') },
        { kind: 'owned-text-file', path: typeMismatchPath, allowedRoot,
          identity: userIdentity('type-mismatch') },
      ],
    });

    expect(result.state).toBe('absent');
    expect(result.components.map((entry) => entry.collision)).toEqual([
      {
        reason: 'ownerMismatch', artifactKind: 'owned-text-file', artifactKey: 'owner-mismatch',
        expectedOwner: 'official/ownership-test', actualOwner: 'official/other-owner',
      },
      {
        reason: 'unownedContent', artifactKind: 'owned-text-file', artifactKey: 'unowned',
        expectedOwner: 'official/ownership-test',
      },
      {
        reason: 'typeMismatch', artifactKind: 'owned-text-file', artifactKey: 'type-mismatch',
        expectedOwner: 'official/ownership-test',
      },
    ]);
    expect(JSON.stringify(result.components.map((entry) => entry.collision))).not.toContain(root);
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
      pristineTree: [{
        relativePath: 'SKILL.md',
        contentDigest: `sha256:${crypto.createHash('sha256').update('# pristine\n').digest('hex')}`,
      }],
    };
    const executor: OwnedComponentExecutor = {
      inspectShared: async () => 'absent',
      removeShared: async () => undefined,
      skillDirectoryMatchesPristineTree: async ({ actualPath, files }) =>
        files.length === 1
        && files[0]?.relativePath === 'SKILL.md'
        && files[0]?.contentDigest === `sha256:${crypto.createHash('sha256')
          .update(await fs.readFile(path.join(actualPath, 'SKILL.md'))).digest('hex')}`,
    };

    await expect(inspectOwnedComponents({ components: [component], executor })).resolves.toMatchObject({
      state: 'absent',
      components: [{ state: 'absent' }],
    });
    await expect(cleanupOwnedComponents({ components: [component], executor })).resolves.toEqual({
      removed: [],
      absent: [skillRoot],
      residual: [],
      quarantined: [],
      failures: [],
    });
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);

    await fs.writeFile(path.join(skillRoot, 'SKILL.md'), '# changed\n');
    await expect(cleanupOwnedComponents({ components: [component], executor })).resolves.toMatchObject({
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
        validateHealth: true,
      };
      const executor: OwnedComponentExecutor = {
        inspectShared: async () => 'absent',
        removeShared: async () => undefined,
        validateSkillDirectory: async () => {
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
        executor,
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
      locator: { kind: 'corrupted', message: 'test' },
    };
    const native: OwnedComponent = {
      kind: 'native-plugin',
      identity: userIdentity('native'),
      pluginId: 'ownership-test@aw',
    };
    const nativeProbe = async () => nativePresent ? 'present' as const : 'absent' as const;
    const executor: OwnedComponentExecutor = {
      inspectShared: async () => managedPresent ? 'present' : 'absent',
      removeShared: async () => { managedPresent = false; },
    };

    await expect(inspectOwnedComponents({
      components: [managed, native],
      executor,
      nativeProbe,
    })).resolves.toMatchObject({ state: 'present' });
    await expect(cleanupOwnedComponents({
      components: [managed, native],
      executor,
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

  it('leaves an unreadable path residual while removing independently verified ownership', async () => {
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
      locator: { kind: 'corrupted', message: 'probe failed' },
    };
    const executor: OwnedComponentExecutor = {
      inspectShared: async () => { throw new Error('probe failed'); },
      removeShared: async () => { throw new Error('must not run'); },
    };

    await expect(inspectOwnedComponents({ components: [owned, unreadable], executor })).resolves.toMatchObject({
      state: 'error',
      components: [{ state: 'present' }, { state: 'error' }],
      errors: [{ label: 'unreadable shared config', message: 'probe failed' }],
    });
    await expect(cleanupOwnedComponents({ components: [owned, unreadable], executor })).resolves.toMatchObject({
      removed: [ownedPath],
      residual: ['unreadable shared config'],
      failures: [{ label: 'unreadable shared config', phase: 'probe' }],
    });
    await expect(fs.pathExists(ownedPath)).resolves.toBe(false);
  });

  it('returns remove and post-probe failures without losing earlier progress', async () => {
    let removedHealthy = false;
    let postProbeCount = 0;
    const healthy: OwnedComponent = {
      kind: 'managed-block',
      identity: userIdentity('healthy'),
      label: 'healthy block',
      locator: { kind: 'corrupted', message: 'healthy' },
    };
    const removeFailure: OwnedComponent = {
      kind: 'managed-block',
      identity: userIdentity('remove-failure'),
      label: 'remove failure',
      locator: { kind: 'corrupted', message: 'remove-failure' },
    };
    const postProbeFailure: OwnedComponent = {
      kind: 'managed-block',
      identity: userIdentity('post-probe-failure'),
      label: 'post-probe failure',
      locator: { kind: 'corrupted', message: 'post-probe-failure' },
    };
    const executor: OwnedComponentExecutor = {
      inspectShared: async (component) => {
        if (component === healthy) return removedHealthy ? 'absent' : 'present';
        if (component === removeFailure) return 'present';
        postProbeCount += 1;
        if (postProbeCount > 1) throw new Error('post-probe failed');
        return 'present';
      },
      removeShared: async (component) => {
        if (component === healthy) {
          removedHealthy = true;
          return;
        }
        if (component === removeFailure) throw new Error('remove failed');
      },
    };

    await expect(cleanupOwnedComponents({
      components: [healthy, removeFailure, postProbeFailure],
      executor,
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
