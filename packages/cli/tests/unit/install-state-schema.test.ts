import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHistoricalLifecycleRuntimePaths,
  createProjectArtifactSharedLocator,
  createRecordId,
  createSharedIdentityId,
  getSharedRuntimeOwnerFileName,
  validateDynamicArtifactDiagnosticCache,
  validateInstallRecordArtifact,
  validateInstallRecordFile,
  validateProjectArtifactIdentityArtifact,
  validateProjectArtifactIdentityFile,
  validateProjectArtifactSharedLocator,
  validateSharedSkillTriggerRuntimeOwner,
} from '../../src/install-state/index.js';
import type {
  DynamicArtifactDiagnosticCache,
  InstallRecordFile,
  NativeTransactionMarker,
  PluginLocation,
  ProjectArtifactIdentityFile,
  SharedSkillTriggerRuntimeOwner,
} from '../../src/install-state/index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

function makeLocation(overrides: Partial<PluginLocation> = {}): PluginLocation {
  return {
    plugin: 'git-commit',
    platform: 'codex',
    scope: 'project',
    projectKey: '/Users/example/work/repo',
    ...overrides,
  };
}

function makeInstallRecordFile(overrides: Partial<InstallRecordFile['record']> = {}): InstallRecordFile {
  const location = makeLocation({
    plugin: overrides.pluginName ?? 'git-commit',
    platform: overrides.platform ?? 'codex',
    scope: overrides.scope ?? 'project',
    projectKey: overrides.scope === 'user' ? undefined : (overrides.projectKey ?? '/Users/example/work/repo'),
  });
  return {
    version: 2,
    recordId: createRecordId(location),
    record: {
      pluginName: location.plugin,
      platform: location.platform,
      scope: location.scope,
      ...(location.scope === 'project' ? { projectKey: location.projectKey ?? undefined } : {}),
      installedAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:01.000Z',
      source: {
        pluginVersion: '1.2.3',
        manifestDigest: 'sha256:manifest',
        bundleFingerprint: 'sha256:bundle',
      },
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
      },
      options: {
        skillTriggerPreference: 'manual',
      },
      artifacts: [{
        kind: 'instruction',
        platform: location.platform,
        path: path.join(location.projectKey ?? '/tmp', '.codex', 'AGENTS.md'),
        id: 'instruction-a',
        target: 'codex.developerInstructionsBlock',
      }],
      dependencyEdges: [],
      ...overrides,
    },
  };
}

describe('install-state schema', () => {
  it('accepts a valid install record and option preference', async () => {
    const filePath = path.join(await makeTempDir('aw-install-state-schema-'), `${createRecordId(makeLocation())}.json`);
    const record = makeInstallRecordFile();
    await fs.writeJson(filePath, record, { spaces: 2 });

    const validated = validateInstallRecordFile(record, { expectedPath: filePath });
    expect(validated.ok).toBe(true);
  });

  it('rejects invalid options, missing installSource, missing dependencyEdges, and file name mismatches', async () => {
    const invalidPreference = makeInstallRecordFile({
      options: {
        // @ts-expect-error test invalid input
        skillTriggerPreference: 'later',
      },
    });
    const invalidPreferenceResult = validateInstallRecordFile(invalidPreference);
    expect(invalidPreferenceResult.ok).toBe(false);
    if (!invalidPreferenceResult.ok) {
      expect(invalidPreferenceResult.code).toBe('invalidSkillTriggerPreference');
    }

    const missingInstallSource = makeInstallRecordFile();
    delete (missingInstallSource.record as Record<string, unknown>).installSource;
    const missingInstallSourceResult = validateInstallRecordFile(missingInstallSource);
    expect(missingInstallSourceResult.ok).toBe(false);
    if (!missingInstallSourceResult.ok) {
      expect(missingInstallSourceResult.code).toBe('invalidInstallSource');
    }

    const missingDependencyEdges = makeInstallRecordFile();
    delete (missingDependencyEdges.record as Record<string, unknown>).dependencyEdges;
    const missingDependencyEdgesResult = validateInstallRecordFile(missingDependencyEdges);
    expect(missingDependencyEdgesResult.ok).toBe(false);
    if (!missingDependencyEdgesResult.ok) {
      expect(missingDependencyEdgesResult.code).toBe('missingDependencyEdges');
    }

    const mismatchedPath = validateInstallRecordFile(
      makeInstallRecordFile(),
      { expectedPath: '/tmp/openai-docs.111111111111.json' },
    );
    expect(mismatchedPath.ok).toBe(false);
    if (!mismatchedPath.ok) {
      expect(mismatchedPath.code).toBe('recordIdMismatch');
    }
  });

  it('rejects banned legacy, snapshot, digest, refresh, and health fields in install records', () => {
    const legacyCases: Array<{
      name: string;
      mutate: (record: InstallRecordFile) => void;
    }> = [
      { name: 'ledgerState', mutate: (record) => { (record.record as Record<string, unknown>).ledgerState = {}; } },
      { name: 'degradedAt', mutate: (record) => { (record.record as Record<string, unknown>).degradedAt = '2026-05-07T00:00:00.000Z'; } },
      { name: 'degradedReason', mutate: (record) => { (record.record as Record<string, unknown>).degradedReason = 'legacy'; } },
      { name: 'scopeInitialized', mutate: (record) => { (record.record as Record<string, unknown>).scopeInitialized = 'yes'; } },
      { name: 'capabilitySnapshot', mutate: (record) => { (record.record as Record<string, unknown>).capabilitySnapshot = {}; } },
      { name: 'lastRequestedScope', mutate: (record) => { (record.record as Record<string, unknown>).lastRequestedScope = 'project'; } },
      { name: 'lastRequestedAt', mutate: (record) => { (record.record as Record<string, unknown>).lastRequestedAt = '2026-05-07T00:00:00.000Z'; } },
      { name: 'sharedNativeRefs', mutate: (record) => { (record.record as Record<string, unknown>).sharedNativeRefs = {}; } },
      { name: 'skillTriggerWriteOrder', mutate: (record) => { (record.record as Record<string, unknown>).skillTriggerWriteOrder = 1; } },
      { name: 'dependents', mutate: (record) => { (record.record as Record<string, unknown>).dependents = []; } },
      { name: 'refCount', mutate: (record) => { (record.record as Record<string, unknown>).refCount = 0; } },
      { name: 'autoRemovable', mutate: (record) => { (record.record as Record<string, unknown>).autoRemovable = true; } },
      { name: 'unusedDependencyHint', mutate: (record) => { (record.record as Record<string, unknown>).unusedDependencyHint = true; } },
      { name: 'dependencies.satisfied', mutate: (record) => { (record.record as Record<string, unknown>).dependencies = { satisfied: [] }; } },
      { name: 'dependencies.missing', mutate: (record) => { (record.record as Record<string, unknown>).dependencies = { missing: [] }; } },
      { name: 'dependencies.catalogDrift', mutate: (record) => { (record.record as Record<string, unknown>).dependencies = { catalogDrift: [] }; } },
      { name: 'lastRefresh', mutate: (record) => { (record.record as Record<string, unknown>).lastRefresh = {}; } },
      { name: 'refreshReach', mutate: (record) => { (record.record as Record<string, unknown>).refreshReach = {}; } },
      { name: 'configDigest', mutate: (record) => { (record.record as Record<string, unknown>).configDigest = 'sha256:config'; } },
      { name: 'contentDigest', mutate: (record) => { (record.record as Record<string, unknown>).contentDigest = 'sha256:content'; } },
      { name: 'installSnapshot', mutate: (record) => { (record.record as Record<string, unknown>).installSnapshot = {}; } },
      { name: 'configSnapshot', mutate: (record) => { (record.record as Record<string, unknown>).configSnapshot = {}; } },
      { name: 'artifactHealthSnapshot', mutate: (record) => { (record.record as Record<string, unknown>).artifactHealthSnapshot = {}; } },
      { name: 'lifecycleConfigSnapshot', mutate: (record) => { (record.record as Record<string, unknown>).lifecycleConfigSnapshot = {}; } },
    ];

    for (const legacyCase of legacyCases) {
      const record = makeInstallRecordFile();
      legacyCase.mutate(record);
      const result = validateInstallRecordFile(record);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('unsupportedLegacyField');
      }
    }
  });

  it('validates artifact identity minimum fields for record and shared identity artifacts', () => {
    expect(validateInstallRecordArtifact({
      kind: 'skill',
      platform: 'codex',
      path: '/tmp/skill.md',
      artifactKey: 'git-commit.skill',
    }).ok).toBe(true);
    expect(validateInstallRecordArtifact({
      kind: 'hook',
      platform: 'codex',
      path: '/tmp/hooks.json',
      hookGroups: [{ event: 'before_tool', command: 'echo hi' }],
    }).ok).toBe(true);
    expect(validateInstallRecordArtifact({
      kind: 'agent',
      platform: 'codex',
      path: '/tmp/role.toml',
      id: 'role-a',
      target: 'codex.agentRole',
      roleKey: 'codex-explorer',
    }).ok).toBe(true);
    expect(validateInstallRecordArtifact({
      kind: 'mcpServer',
      platform: 'codex',
      path: '/tmp/mcp.json',
    }).ok).toBe(false);
    expect(validateInstallRecordArtifact({
      kind: 'hook',
      platform: 'codex',
      path: '/tmp/hooks.json',
    }).ok).toBe(false);
    expect(validateInstallRecordArtifact({
      kind: 'agent',
      platform: 'codex',
      path: '/tmp/role.toml',
      id: 'role-a',
      target: 'codex.agentRole',
    }).ok).toBe(false);

    expect(validateProjectArtifactIdentityArtifact({
      kind: 'instruction',
      platform: 'codex',
      path: '.agents/skills/git-commit/SKILL.md',
      id: 'instruction-a',
      target: 'codex.developerInstructionsBlock',
      ownershipMarker: 'aw:git-commit',
      state: 'present',
    }).ok).toBe(true);
    expect(validateProjectArtifactIdentityArtifact({
      kind: 'instruction',
      platform: 'codex',
      path: '../outside.md',
      id: 'instruction-a',
      target: 'codex.developerInstructionsBlock',
      state: 'present',
    }).ok).toBe(false);
  });

  it('keeps recordId, sharedIdentityId, and shared owner filenames stable across slug collisions and path-like plugin names', () => {
    const cases = [
      '@OpenAI/Docs',
      '@openai docs',
      '@openai/docs',
      'OPENAI DOCS',
    ];

    const recordIds = new Set(cases.map((plugin) => createRecordId(makeLocation({ plugin }))));
    const ownerFiles = new Set(cases.map((plugin) => getSharedRuntimeOwnerFileName(plugin)));
    const identityIds = new Set(cases.map((plugin) => createSharedIdentityId({
      plugin,
      platform: 'codex',
      scope: 'project',
      repoRelativeProjectRoot: '.',
    })));

    expect(recordIds.size).toBe(cases.length);
    expect(ownerFiles.size).toBe(cases.length);
    expect(identityIds.size).toBe(cases.length);
    expect(getSharedRuntimeOwnerFileName('@OpenAI/Docs')).toBe(getSharedRuntimeOwnerFileName('@OpenAI/Docs'));
  });

  it('builds lifecycle runtime paths without leaking absolute project keys and keeps runtime ids unique per nonce', async () => {
    const cwd = await makeTempDir('aw-install-state-runtime-');
    const location = makeLocation({ plugin: '@OpenAI/Docs', projectKey: '/Users/example/home/repo/subdir' });
    const first = createHistoricalLifecycleRuntimePaths({
      cwd,
      location,
      manifestDigest: 'sha256:manifest',
      bundleFingerprint: 'sha256:bundle',
      nonce: 'nonce-a',
    });
    const second = createHistoricalLifecycleRuntimePaths({
      cwd,
      location,
      manifestDigest: 'sha256:manifest',
      bundleFingerprint: 'sha256:bundle',
      nonce: 'nonce-b',
    });

    expect(first.scopeKey).not.toContain('/Users/example/home/repo/subdir');
    expect(first.scopeKey).not.toContain('/Users/example');
    expect(first.runtimeId).not.toBe(second.runtimeId);
    expect(first.runtimeRoot).not.toBe(second.runtimeRoot);
    expect(first.bundleRoot.startsWith(first.runtimeRoot)).toBe(true);
    expect(first.manifestPath.startsWith(first.bundleRoot)).toBe(true);
  });

  it('rejects unsafe project shared locators and keeps repo-stable ids across clone paths', async () => {
    const repoA = await makeTempDir('aw-install-state-repo-a-');
    const repoB = await makeTempDir('aw-install-state-repo-b-');
    const projectDirA = path.join(repoA, 'packages', 'plugin');
    const projectDirB = path.join(repoB, 'packages', 'plugin');
    await fs.ensureDir(projectDirA);
    await fs.ensureDir(projectDirB);

    const locatorA = createProjectArtifactSharedLocator({
      plugin: 'git-commit',
      platform: 'codex',
      repoRoot: repoA,
      projectRoot: projectDirA,
    });
    const locatorB = createProjectArtifactSharedLocator({
      plugin: 'git-commit',
      platform: 'codex',
      repoRoot: repoB,
      projectRoot: projectDirB,
    });

    expect(locatorA.repoRelativeProjectRoot).toBe('packages/plugin');
    expect(locatorB.repoRelativeProjectRoot).toBe('packages/plugin');
    expect(createSharedIdentityId(locatorA)).toBe(createSharedIdentityId(locatorB));

    const invalidRoots = ['', '/tmp/repo', '../repo', '/Users/example/home/repo', '/cwd/repo'];
    for (const root of invalidRoots) {
      const result = validateProjectArtifactSharedLocator({
        plugin: 'git-commit',
        platform: 'codex',
        scope: 'project',
        repoRelativeProjectRoot: root,
      }, {
        projectKey: '/Users/example/home/repo',
        cwd: '/cwd/repo',
        homeDir: '/Users/example/home',
      });
      expect(result.ok).toBe(false);
    }
  });

  it('aligns dynamic diagnostic cache with the current record artifact identity and treats mismatches as unavailable', () => {
    const record = makeInstallRecordFile();
    const cache: DynamicArtifactDiagnosticCache = {
      version: 1,
      recordId: record.recordId,
      location: {
        plugin: record.record.pluginName,
        platform: record.record.platform,
        scope: record.record.scope,
        projectKey: record.record.projectKey,
      },
      updatedAt: '2026-05-07T00:00:01.000Z',
      artifacts: [{
        id: 'instruction-a',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        artifactKey: 'git-commit.skill',
        configDigest: 'sha256:cfg',
        contentDigest: 'sha256:content',
      }],
    };

    record.record.artifacts[0] = {
      kind: 'instruction',
      platform: 'codex',
      path: '/tmp/instruction.md',
      id: 'instruction-a',
      target: 'codex.developerInstructionsBlock',
      artifactKey: 'git-commit.skill',
    };
    const okResult = validateDynamicArtifactDiagnosticCache(cache, {
      expectedRecordId: record.recordId,
      expectedLocation: cache.location,
      currentRecord: record,
    });
    expect(okResult.ok).toBe(true);

    cache.artifacts[0] = {
      ...cache.artifacts[0],
      artifactKey: 'wrong',
    };
    const mismatchResult = validateDynamicArtifactDiagnosticCache(cache, {
      expectedRecordId: record.recordId,
      expectedLocation: cache.location,
      currentRecord: record,
    });
    expect(mismatchResult.ok).toBe(false);
    if (!mismatchResult.ok) {
      expect(mismatchResult.code).toBe('artifactMismatch');
    }
  });

  it('validates shared owner payloads and filename rules', () => {
    const owner: SharedSkillTriggerRuntimeOwner = {
      version: 1,
      pluginName: 'git-commit',
      platform: 'codex',
      owner: {
        plugin: 'git-commit',
        platform: 'codex',
        scope: 'user',
      },
      ownerRecordPath: '/tmp/git-commit.json',
      ownerRecordDigest: 'sha256:digest',
      preference: 'manual',
      updatedAt: '2026-05-07T00:00:01.000Z',
    };

    expect(validateSharedSkillTriggerRuntimeOwner(owner, {
      expectedPath: `/tmp/${getSharedRuntimeOwnerFileName('git-commit')}`,
    }).ok).toBe(true);

    const invalidOwner = validateSharedSkillTriggerRuntimeOwner(owner, {
      expectedPath: '/tmp/wrong.json',
    });
    expect(invalidOwner.ok).toBe(false);
  });

  it('validates project identity file against its derived shared identity id', () => {
    const locator = {
      plugin: 'git-commit',
      platform: 'codex' as const,
      scope: 'project' as const,
      repoRelativeProjectRoot: '.',
    };
    const file: ProjectArtifactIdentityFile = {
      version: 1,
      sharedIdentityId: createSharedIdentityId(locator),
      locator,
      source: {
        pluginVersion: '1.2.3',
        manifestDigest: 'sha256:manifest',
        bundleFingerprint: 'sha256:bundle',
      },
      generatedAt: '2026-05-07T00:00:01.000Z',
      artifacts: [{
        kind: 'instruction',
        platform: 'codex',
        path: '.agents/skills/git-commit/SKILL.md',
        id: 'instruction-a',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
      }],
    };
    expect(validateProjectArtifactIdentityFile(file, {
      expectedPath: `/tmp/${file.sharedIdentityId}.json`,
    }).ok).toBe(true);

    file.sharedIdentityId = 'git-commit.ffffffffffff';
    const result = validateProjectArtifactIdentityFile(file);
    expect(result.ok).toBe(false);
  });
});
