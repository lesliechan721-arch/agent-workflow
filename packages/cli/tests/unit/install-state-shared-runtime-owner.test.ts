import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { readSharedSkillTriggerRuntimeOwner } from '../../src/install-state/facade.js';
import { createRecordId } from '../../src/install-state/ids.js';
import { getSharedSkillTriggerRuntimeOwnerPath } from '../../src/install-state/paths.js';
import {
  createSharedSkillTriggerRuntimeRemovalStages,
  createSharedSkillTriggerRuntimeUpsertStages,
  planSharedSkillTriggerRuntimeOwnerRemoval,
  preflightSharedSkillTriggerRuntimeOwnerUpsert,
  replaySharedSkillTriggerRuntimeFromOwner,
} from '../../src/install-state/shared-runtime-owner.js';
import {
  createInstallRecordDeleteStage,
  createInstallRecordWriteStage,
  createSharedRuntimeOwnerWriteStage,
  InstallStateTransactionError,
  runInstallStateTransaction,
} from '../../src/install-state/transactions.js';
import type { InstallRecordFile, PluginLocation } from '../../src/install-state/types.js';
import {
  buildSkillTriggerMaterializationSignature,
  commitMaterializedSkillTriggerPreference,
  materializeSkillTriggerPreference,
  readCurrentSkillTriggerRuntimeSignature,
  type SkillTriggerMaterializationTarget,
} from '../../src/utils/skill-trigger-preferences.js';

const tempDirs: string[] = [];

const CLAUDE_SKILL = `---
name: commit
description: Commit skill
user-invocable: true
disable-model-invocation: false
---

# Commit
`;

const CODEX_SKILL = `policy:
  allow_implicit_invocation: true
`;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function writeBundlePlugin(options: {
  rootDir: string;
  pluginName?: string;
  artifacts?: {
    targets: Array<Record<string, unknown>>;
  };
}): Promise<void> {
  const pluginName = options.pluginName ?? 'git-commit';
  const pluginRoot = path.join(options.rootDir, 'plugins', pluginName);

  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    {
      name: pluginName,
      version: '0.1.0',
      description: `${pluginName} plugin`,
      skills: './skills',
      skillTriggers: {
        commit: {
          allowInstallOverride: true,
        },
      },
      artifacts: options.artifacts,
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
      },
    },
    { spaces: 2 },
  );

  const claudePath = path.join(pluginRoot, 'claude', 'skills', 'commit', 'SKILL.md');
  const codexPath = path.join(pluginRoot, 'codex', 'skills', 'commit', 'agents', 'openai.yaml');
  await fs.ensureDir(path.dirname(claudePath));
  await fs.ensureDir(path.dirname(codexPath));
  await fs.writeFile(claudePath, CLAUDE_SKILL, 'utf8');
  await fs.writeFile(codexPath, CODEX_SKILL, 'utf8');
}

function makeLocation(options: {
  plugin?: string;
  platform: 'claude' | 'codex';
  scope: 'user' | 'project';
  projectKey?: string;
}): PluginLocation {
  return {
    plugin: options.plugin ?? 'git-commit',
    platform: options.platform,
    scope: options.scope,
    ...(options.scope === 'project'
      ? { projectKey: options.projectKey ?? 'repo:fixture' }
      : {}),
  };
}

function makeRecord(
  location: PluginLocation,
  preference: 'default' | 'manual' | 'auto',
): InstallRecordFile {
  return {
    version: 2,
    recordId: createRecordId(location),
    record: {
      pluginName: location.plugin,
      platform: location.platform,
      scope: location.scope,
      ...(location.scope === 'project' ? { projectKey: location.projectKey } : {}),
      installedAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:01.000Z',
      source: {
        pluginVersion: '0.1.0',
        manifestDigest: 'sha256:manifest',
        bundleFingerprint: 'sha256:bundle',
      },
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
      },
      options: {
        skillTriggerPreference: preference,
      },
      artifacts: [],
      dependencyEdges: [],
    },
  };
}

async function writeOwnerFile(options: {
  env: NodeJS.ProcessEnv;
  location: PluginLocation;
  recordFile: InstallRecordFile;
  recordPath: string;
}): Promise<void> {
  const ownerPath = getSharedSkillTriggerRuntimeOwnerPath({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    env: options.env,
  });
  await fs.outputJson(ownerPath, {
    version: 1,
    pluginName: options.location.plugin,
    platform: options.location.platform,
    owner: options.location,
    ownerRecordPath: options.recordPath,
    ownerRecordDigest: sha256(await fs.readFile(options.recordPath)),
    preference: options.recordFile.record.options?.skillTriggerPreference ?? 'default',
    updatedAt: options.recordFile.record.updatedAt,
  }, { spaces: 2 });
}

async function setRuntimePreference(options: {
  embeddedRoot: string;
  target: SkillTriggerMaterializationTarget;
  pluginName?: string;
  platform: 'claude' | 'codex';
  preference: 'default' | 'manual' | 'auto';
}): Promise<void> {
  const materialization = await materializeSkillTriggerPreference({
    pluginName: options.pluginName ?? 'git-commit',
    platform: options.platform,
    resolvedOptions: {
      skillTriggerPreference: options.preference,
    },
    embeddedRoot: options.embeddedRoot,
    target: options.target,
    mode: 'strictExplicit',
  });
  await commitMaterializedSkillTriggerPreference(materialization.rollbackHandle);
}

async function expectRuntimePreference(options: {
  embeddedRoot: string;
  target: SkillTriggerMaterializationTarget;
  pluginName?: string;
  platform: 'claude' | 'codex';
  preference: 'default' | 'manual' | 'auto';
}): Promise<void> {
  const [runtime, expected] = await Promise.all([
    readCurrentSkillTriggerRuntimeSignature({
      pluginName: options.pluginName ?? 'git-commit',
      platform: options.platform,
      embeddedRoot: options.embeddedRoot,
      target: options.target,
    }),
    buildSkillTriggerMaterializationSignature({
      pluginName: options.pluginName ?? 'git-commit',
      platform: options.platform,
      preference: options.preference,
      embeddedRoot: options.embeddedRoot,
    }),
  ]);

  expect(runtime.status).toBe('known');
  expect(expected.status).toBe('known');
  if (runtime.status === 'known' && expected.status === 'known') {
    expect(runtime.signature).toBe(expected.signature);
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('install-state shared runtime owner', () => {
  it('writes different owner files for plugins that share the same slug', async () => {
    const root = await makeTempDir('aw-shared-owner-collision-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const recordRoot = path.join(root, 'records');
    const locationA = makeLocation({ plugin: 'Git Commit', platform: 'codex', scope: 'user' });
    const locationB = makeLocation({ plugin: 'git-commit', platform: 'codex', scope: 'user' });
    const recordA = makeRecord(locationA, 'manual');
    const recordB = makeRecord(locationB, 'auto');
    const recordPathA = path.join(recordRoot, `${recordA.recordId}.json`);
    const recordPathB = path.join(recordRoot, `${recordB.recordId}.json`);

    await runInstallStateTransaction({
      stages: [
        await createInstallRecordWriteStage({ filePath: recordPathA, value: recordA }),
        await createSharedRuntimeOwnerWriteStage({ recordFile: recordA, recordPath: recordPathA, env }),
      ],
    });
    await runInstallStateTransaction({
      stages: [
        await createInstallRecordWriteStage({ filePath: recordPathB, value: recordB }),
        await createSharedRuntimeOwnerWriteStage({ recordFile: recordB, recordPath: recordPathB, env }),
      ],
    });

    const [ownerA, ownerB] = await Promise.all([
      readSharedSkillTriggerRuntimeOwner({ pluginName: locationA.plugin, platform: 'codex', env }),
      readSharedSkillTriggerRuntimeOwner({ pluginName: locationB.plugin, platform: 'codex', env }),
    ]);

    expect(ownerA.status).toBe('ok');
    expect(ownerB.status).toBe('ok');
    if (ownerA.status === 'ok' && ownerB.status === 'ok') {
      expect(ownerA.path).not.toBe(ownerB.path);
      expect(path.basename(ownerA.path)).not.toBe(path.basename(ownerB.path));
    }
  });

  it('requires takeover for non-owner shared runtime changes and rejects upgrade --all takeover', async () => {
    const embeddedRoot = await makeTempDir('aw-shared-owner-embedded-');
    const marketplaceRoot = await makeTempDir('aw-shared-owner-marketplace-');
    const root = await makeTempDir('aw-shared-owner-root-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const runtimeTarget: SkillTriggerMaterializationTarget = {
      platform: 'claude',
      scope: 'user',
      kind: 'localMarketplaceRuntime',
      root: marketplaceRoot,
    };
    const ownerLocation = makeLocation({ platform: 'claude', scope: 'user' });
    const contenderLocation = makeLocation({ platform: 'claude', scope: 'project', projectKey: 'repo:demo' });
    const ownerRecord = makeRecord(ownerLocation, 'manual');
    const ownerRecordPath = path.join(root, 'records', `${ownerRecord.recordId}.json`);

    await writeBundlePlugin({ rootDir: embeddedRoot });
    await fs.outputJson(ownerRecordPath, ownerRecord, { spaces: 2 });
    await writeOwnerFile({ env, location: ownerLocation, recordFile: ownerRecord, recordPath: ownerRecordPath });
    await setRuntimePreference({
      embeddedRoot,
      target: runtimeTarget,
      platform: 'claude',
      preference: 'manual',
    });

    const required = await preflightSharedSkillTriggerRuntimeOwnerUpsert({
      location: contenderLocation,
      embeddedRoot,
      target: runtimeTarget,
      preference: 'auto',
      command: 'upgrade',
      env,
    });
    expect(required.status).toBe('takeoverRequired');
    if (required.status === 'takeoverRequired') {
      expect(required.takeoverRequired.suggestedFlag).toBe('--takeover-shared-runtime');
      expect(required.takeoverRequired.currentOwner).toEqual(ownerLocation);
    }

    const blocked = await preflightSharedSkillTriggerRuntimeOwnerUpsert({
      location: contenderLocation,
      embeddedRoot,
      target: runtimeTarget,
      preference: 'auto',
      command: 'upgrade',
      takeoverSharedRuntime: true,
      targetCount: 2,
      env,
    });
    expect(blocked.status).toBe('takeoverNotAllowed');

    const allowed = await preflightSharedSkillTriggerRuntimeOwnerUpsert({
      location: contenderLocation,
      embeddedRoot,
      target: runtimeTarget,
      preference: 'auto',
      command: 'upgrade',
      takeoverSharedRuntime: true,
      targetCount: 1,
      env,
    });
    expect(allowed.status).toBe('ok');
    if (allowed.status === 'ok') {
      expect(allowed.ownerAction).toBe('takeover');
      expect(allowed.shouldMaterializeRuntime).toBe(true);
    }
  });

  it('restores the previous owner and runtime when takeover fails after commit', async () => {
    const embeddedRoot = await makeTempDir('aw-shared-owner-failure-embedded-');
    const marketplaceRoot = await makeTempDir('aw-shared-owner-failure-marketplace-');
    const root = await makeTempDir('aw-shared-owner-failure-root-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const runtimeTarget: SkillTriggerMaterializationTarget = {
      platform: 'claude',
      scope: 'user',
      kind: 'localMarketplaceRuntime',
      root: marketplaceRoot,
    };
    const ownerLocation = makeLocation({ platform: 'claude', scope: 'user' });
    const contenderLocation = makeLocation({ platform: 'claude', scope: 'project', projectKey: 'repo:demo' });
    const ownerRecord = makeRecord(ownerLocation, 'manual');
    const contenderRecord = makeRecord(contenderLocation, 'auto');
    const ownerRecordPath = path.join(root, 'records', `${ownerRecord.recordId}.json`);
    const contenderRecordPath = path.join(root, 'records', `${contenderRecord.recordId}.json`);

    await writeBundlePlugin({ rootDir: embeddedRoot });
    await fs.outputJson(ownerRecordPath, ownerRecord, { spaces: 2 });
    await writeOwnerFile({ env, location: ownerLocation, recordFile: ownerRecord, recordPath: ownerRecordPath });
    await setRuntimePreference({
      embeddedRoot,
      target: runtimeTarget,
      platform: 'claude',
      preference: 'manual',
    });

    const preflight = await preflightSharedSkillTriggerRuntimeOwnerUpsert({
      location: contenderLocation,
      embeddedRoot,
      target: runtimeTarget,
      preference: 'auto',
      command: 'upgrade',
      takeoverSharedRuntime: true,
      env,
    });
    expect(preflight.status).toBe('ok');
    if (preflight.status !== 'ok') {
      throw new Error('expected ok preflight');
    }

    const bundle = await createSharedSkillTriggerRuntimeUpsertStages({
      plan: preflight,
      recordFile: contenderRecord,
      recordPath: contenderRecordPath,
      embeddedRoot,
      target: runtimeTarget,
      env,
    });

    const result = await runInstallStateTransaction({
      stages: [
        await createInstallRecordWriteStage({ filePath: contenderRecordPath, value: contenderRecord }),
        ...bundle.stages,
        {
          label: 'synthetic failure',
          async commit() {
            throw new Error('stop after takeover');
          },
          async rollback() {
            return undefined;
          },
          async finalize() {
            return undefined;
          },
        },
      ],
    }).catch((error) => error);

    expect(result).toBeInstanceOf(InstallStateTransactionError);
    await expectRuntimePreference({
      embeddedRoot,
      target: runtimeTarget,
      platform: 'claude',
      preference: 'manual',
    });
    const owner = await readSharedSkillTriggerRuntimeOwner({
      pluginName: ownerLocation.plugin,
      platform: ownerLocation.platform,
      env,
    });
    expect(owner.status).toBe('ok');
    if (owner.status === 'ok') {
      expect(owner.value.owner).toEqual(ownerLocation);
      expect(owner.value.preference).toBe('manual');
    }
    await expect(fs.pathExists(contenderRecordPath)).resolves.toBe(false);
  });

  it('replays the new owner preference after takeover and keeps the old record untouched', async () => {
    const embeddedRoot = await makeTempDir('aw-shared-owner-success-embedded-');
    const marketplaceRoot = await makeTempDir('aw-shared-owner-success-marketplace-');
    const root = await makeTempDir('aw-shared-owner-success-root-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const runtimeTarget: SkillTriggerMaterializationTarget = {
      platform: 'claude',
      scope: 'user',
      kind: 'localMarketplaceRuntime',
      root: marketplaceRoot,
    };
    const ownerLocation = makeLocation({ platform: 'claude', scope: 'user' });
    const contenderLocation = makeLocation({ platform: 'claude', scope: 'project', projectKey: 'repo:demo' });
    const ownerRecord = makeRecord(ownerLocation, 'manual');
    const contenderRecord = makeRecord(contenderLocation, 'auto');
    const ownerRecordPath = path.join(root, 'records', `${ownerRecord.recordId}.json`);
    const contenderRecordPath = path.join(root, 'records', `${contenderRecord.recordId}.json`);

    await writeBundlePlugin({ rootDir: embeddedRoot });
    await fs.outputJson(ownerRecordPath, ownerRecord, { spaces: 2 });
    await writeOwnerFile({ env, location: ownerLocation, recordFile: ownerRecord, recordPath: ownerRecordPath });
    await setRuntimePreference({
      embeddedRoot,
      target: runtimeTarget,
      platform: 'claude',
      preference: 'manual',
    });

    const preflight = await preflightSharedSkillTriggerRuntimeOwnerUpsert({
      location: contenderLocation,
      embeddedRoot,
      target: runtimeTarget,
      preference: 'auto',
      command: 'upgrade',
      takeoverSharedRuntime: true,
      env,
    });
    if (preflight.status !== 'ok') {
      throw new Error('expected ok preflight');
    }

    const bundle = await createSharedSkillTriggerRuntimeUpsertStages({
      plan: preflight,
      recordFile: contenderRecord,
      recordPath: contenderRecordPath,
      embeddedRoot,
      target: runtimeTarget,
      env,
    });

    await runInstallStateTransaction({
      stages: [
        await createInstallRecordWriteStage({ filePath: contenderRecordPath, value: contenderRecord }),
        ...bundle.stages,
      ],
    });

    await expectRuntimePreference({
      embeddedRoot,
      target: runtimeTarget,
      platform: 'claude',
      preference: 'auto',
    });
    const owner = await readSharedSkillTriggerRuntimeOwner({
      pluginName: ownerLocation.plugin,
      platform: ownerLocation.platform,
      env,
    });
    expect(owner.status).toBe('ok');
    if (owner.status === 'ok') {
      expect(owner.value.owner).toEqual(contenderLocation);
      expect(owner.value.preference).toBe('auto');
    }
    const oldOwnerRecord = await fs.readJson(ownerRecordPath);
    expect(oldOwnerRecord.record.options.skillTriggerPreference).toBe('manual');
  });

  it('removes owner state and restores embedded default without auto-promoting another record', async () => {
    const embeddedRoot = await makeTempDir('aw-shared-owner-removal-embedded-');
    const marketplaceRoot = await makeTempDir('aw-shared-owner-removal-marketplace-');
    const root = await makeTempDir('aw-shared-owner-removal-root-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const runtimeTarget: SkillTriggerMaterializationTarget = {
      platform: 'claude',
      scope: 'user',
      kind: 'localMarketplaceRuntime',
      root: marketplaceRoot,
    };
    const ownerLocation = makeLocation({ platform: 'claude', scope: 'project', projectKey: 'repo:demo' });
    const siblingLocation = makeLocation({ platform: 'claude', scope: 'user' });
    const ownerRecord = makeRecord(ownerLocation, 'auto');
    const siblingRecord = makeRecord(siblingLocation, 'manual');
    const ownerRecordPath = path.join(root, 'records', `${ownerRecord.recordId}.json`);
    const siblingRecordPath = path.join(root, 'records', `${siblingRecord.recordId}.json`);

    await writeBundlePlugin({ rootDir: embeddedRoot });
    await fs.outputJson(ownerRecordPath, ownerRecord, { spaces: 2 });
    await fs.outputJson(siblingRecordPath, siblingRecord, { spaces: 2 });
    await writeOwnerFile({ env, location: ownerLocation, recordFile: ownerRecord, recordPath: ownerRecordPath });
    await setRuntimePreference({
      embeddedRoot,
      target: runtimeTarget,
      platform: 'claude',
      preference: 'auto',
    });

    const plan = await planSharedSkillTriggerRuntimeOwnerRemoval({
      location: ownerLocation,
      embeddedRoot,
      target: runtimeTarget,
      env,
    });
    expect(plan.ownerAction).toBe('release');

    const bundle = await createSharedSkillTriggerRuntimeRemovalStages({
      plan,
      pluginName: ownerLocation.plugin,
      platform: ownerLocation.platform,
      embeddedRoot,
      target: runtimeTarget,
      env,
    });

    await runInstallStateTransaction({
      stages: [
        createInstallRecordDeleteStage({ filePath: ownerRecordPath }),
        ...bundle.stages,
      ],
    });

    const owner = await readSharedSkillTriggerRuntimeOwner({
      pluginName: ownerLocation.plugin,
      platform: ownerLocation.platform,
      env,
    });
    expect(owner.status).toBe('missing');
    await expectRuntimePreference({
      embeddedRoot,
      target: runtimeTarget,
      platform: 'claude',
      preference: 'default',
    });
    await expect(fs.pathExists(siblingRecordPath)).resolves.toBe(true);
  });

  it('falls back to embedded default during replay when the owner record digest is invalid', async () => {
    const embeddedRoot = await makeTempDir('aw-shared-owner-replay-embedded-');
    const marketplaceRoot = await makeTempDir('aw-shared-owner-replay-marketplace-');
    const root = await makeTempDir('aw-shared-owner-replay-root-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const runtimeTarget: SkillTriggerMaterializationTarget = {
      platform: 'claude',
      scope: 'user',
      kind: 'localMarketplaceRuntime',
      root: marketplaceRoot,
    };
    const ownerLocation = makeLocation({ platform: 'claude', scope: 'user' });
    const ownerRecord = makeRecord(ownerLocation, 'manual');
    const ownerRecordPath = path.join(root, 'records', `${ownerRecord.recordId}.json`);

    await writeBundlePlugin({ rootDir: embeddedRoot });
    await fs.outputJson(ownerRecordPath, ownerRecord, { spaces: 2 });
    await writeOwnerFile({ env, location: ownerLocation, recordFile: ownerRecord, recordPath: ownerRecordPath });
    await setRuntimePreference({
      embeddedRoot,
      target: runtimeTarget,
      platform: 'claude',
      preference: 'manual',
    });

    await fs.writeJson(ownerRecordPath, {
      ...ownerRecord,
      record: {
        ...ownerRecord.record,
        options: {
          skillTriggerPreference: 'auto',
        },
      },
    }, { spaces: 2 });

    const replay = await replaySharedSkillTriggerRuntimeFromOwner({
      pluginName: ownerLocation.plugin,
      platform: ownerLocation.platform,
      embeddedRoot,
      target: runtimeTarget,
      env,
    });

    expect(replay.source).toBe('embeddedDefault');
    expect(replay.warnings[0]).toContain('已回退到 embedded 默认策略');
    await expectRuntimePreference({
      embeddedRoot,
      target: runtimeTarget,
      platform: 'claude',
      preference: 'default',
    });
  });

  it('does not replay manifest-declared codex.skill entries through shared runtime owner fallback', async () => {
    const embeddedRoot = await makeTempDir('aw-shared-owner-dynamic-embedded-');
    const marketplaceRoot = await makeTempDir('aw-shared-owner-dynamic-marketplace-');
    const root = await makeTempDir('aw-shared-owner-dynamic-root-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const runtimeTarget: SkillTriggerMaterializationTarget = {
      platform: 'codex',
      scope: 'user',
      kind: 'localMarketplaceRuntime',
      root: marketplaceRoot,
    };
    const ownerLocation = makeLocation({ platform: 'codex', scope: 'user' });
    const ownerRecord = makeRecord(ownerLocation, 'manual');
    const ownerRecordPath = path.join(root, 'records', `${ownerRecord.recordId}.json`);

    await writeBundlePlugin({
      rootDir: embeddedRoot,
      artifacts: {
        targets: [{
          id: 'commit-skill',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.skill',
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'commit',
        }],
      },
    });
    await fs.copy(embeddedRoot, marketplaceRoot);
    await fs.outputJson(ownerRecordPath, ownerRecord, { spaces: 2 });
    await writeOwnerFile({ env, location: ownerLocation, recordFile: ownerRecord, recordPath: ownerRecordPath });

    const replay = await replaySharedSkillTriggerRuntimeFromOwner({
      pluginName: ownerLocation.plugin,
      platform: ownerLocation.platform,
      embeddedRoot,
      target: runtimeTarget,
      env,
    });

    expect(replay.source).toBe('owner');
    expect(replay.preference).toBe('manual');
    expect(replay.materialization.generatedArtifacts).toEqual([]);
    await expectRuntimePreference({
      embeddedRoot,
      target: runtimeTarget,
      platform: 'codex',
      preference: 'default',
    });
  });

  it('skips shared owner preflight for Codex project repo-local skill triggers', async () => {
    const embeddedRoot = await makeTempDir('aw-shared-owner-codex-project-embedded-');
    const repoSkillsRoot = await makeTempDir('aw-shared-owner-codex-project-repo-skills-');
    const root = await makeTempDir('aw-shared-owner-codex-project-root-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const ownerLocation = makeLocation({ platform: 'codex', scope: 'user' });
    const projectLocation = makeLocation({ platform: 'codex', scope: 'project', projectKey: 'repo:demo' });
    const ownerRecord = makeRecord(ownerLocation, 'manual');
    const ownerRecordPath = path.join(root, 'records', `${ownerRecord.recordId}.json`);

    await writeBundlePlugin({ rootDir: embeddedRoot });
    await fs.outputJson(ownerRecordPath, ownerRecord, { spaces: 2 });
    await writeOwnerFile({ env, location: ownerLocation, recordFile: ownerRecord, recordPath: ownerRecordPath });

    const preflight = await preflightSharedSkillTriggerRuntimeOwnerUpsert({
      location: projectLocation,
      embeddedRoot,
      target: {
        platform: 'codex',
        scope: 'project',
        kind: 'repoSkill',
        root: repoSkillsRoot,
      },
      preference: 'auto',
      command: 'repair',
      env,
    });

    expect(preflight.status).toBe('ok');
    if (preflight.status === 'ok') {
      expect(preflight.assessment.targetKind).toBe('repoLocalCodexProject');
      expect(preflight.ownerAction).toBe('none');
      expect(preflight.shouldWriteOwner).toBe(false);
      expect(preflight.shouldMaterializeRuntime).toBe(false);
    }
  });
});
