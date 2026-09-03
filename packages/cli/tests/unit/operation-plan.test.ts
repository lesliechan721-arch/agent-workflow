import { describe, expect, it } from 'vitest';

import {
  assertOperationPlanFingerprint,
  createOperationPlan,
  createOperationPlanConfigDigest,
  type OperationPlanInput,
} from '../../src/commands/operation-plan.js';

function input(): OperationPlanInput {
  return {
    intentChanges: [{
      scope: 'project',
      beforeDigest: 'sha256:before',
      afterDigest: 'sha256:after',
    }],
    actions: [{
      kind: 'setActivation',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'project',
      enabled: true,
    }],
    changes: ['enable official/demo'],
    warnings: [],
    evidence: {
      catalogDigests: [{ sourceId: 'official', digest: 'sha256:catalog' }],
      intentDigests: [{ scope: 'project', digest: 'sha256:intent' }],
      configDigests: [{
        pluginId: 'official/demo',
        scope: 'project',
        digest: 'sha256:config',
      }],
      targetOwnerFingerprints: [{
        pluginId: 'official/demo',
        platform: 'codex',
        scope: 'project',
        fingerprint: 'sha256:owner',
      }],
    },
  };
}

describe('operation plan', () => {
  it('uses one canonical fingerprint for the serializable review contract', () => {
    const plan = createOperationPlan(input());
    const reordered = createOperationPlan({
      ...input(),
      changes: [...input().changes].reverse(),
      evidence: {
        ...input().evidence,
        catalogDigests: [...input().evidence.catalogDigests].reverse(),
      },
    });

    expect(plan).toEqual(JSON.parse(JSON.stringify(plan)));
    expect(reordered.planFingerprint).toBe(plan.planFingerprint);
    expect(plan.planFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('rejects execution when the locked replan has a different fingerprint', () => {
    const reviewed = createOperationPlan(input());
    const current = createOperationPlan({
      ...input(),
      evidence: {
        ...input().evidence,
        targetOwnerFingerprints: [{
          ...input().evidence.targetOwnerFingerprints[0]!,
          fingerprint: 'sha256:changed-owner',
        }],
      },
    });

    expect(() => assertOperationPlanFingerprint(reviewed.planFingerprint, current))
      .toThrow('operationPlanStale');
  });

  it('binds canonical effective config values without exposing them', () => {
    const reviewedConfig = createOperationPlanConfigDigest({
      pluginId: 'official/demo',
      scope: 'project',
      effectiveValues: { token: 'private-a', mode: 'strict', labels: { region: 'west', tier: 2 } },
    });
    const reorderedConfig = createOperationPlanConfigDigest({
      pluginId: 'official/demo',
      scope: 'project',
      effectiveValues: { labels: { tier: 2, region: 'west' }, mode: 'strict', token: 'private-a' },
    });
    const changedConfig = createOperationPlanConfigDigest({
      pluginId: 'official/demo',
      scope: 'project',
      effectiveValues: { mode: 'strict', token: 'private-b', labels: { region: 'west', tier: 2 } },
    });
    const reviewed = createOperationPlan({
      ...input(),
      evidence: { ...input().evidence, configDigests: [reviewedConfig] },
    });
    const changed = createOperationPlan({
      ...input(),
      evidence: { ...input().evidence, configDigests: [changedConfig] },
    });

    expect(reorderedConfig.digest).toBe(reviewedConfig.digest);
    expect(changed.planFingerprint).not.toBe(reviewed.planFingerprint);
    expect(JSON.stringify(reviewed)).not.toContain('private-a');
  });

  it('binds final owned artifact bytes and owner data into the fingerprint', () => {
    const artifact = {
      kind: 'writeOwnedArtifact' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
      path: '/repo/.agents/skills/demo',
      allowedRoot: '/repo/.agents/skills',
      artifactKind: 'skill-directory' as const,
      contentDigest: 'sha256:bytes-a',
      files: [{ relativePath: 'SKILL.md', contentBase64: 'YQ==', contentDigest: 'sha256:file-a' }],
      owner: {
        owner: 'agent-workflows' as const,
        sourceId: 'official',
        pluginId: 'official/demo',
        plugin: 'demo',
        artifactKey: 'demo',
        platform: 'codex' as const,
        scope: 'project' as const,
      },
    };
    const baseline = createOperationPlan({ ...input(), actions: [artifact] });
    const bytesChanged = createOperationPlan({
      ...input(),
      actions: [{ ...artifact, contentDigest: 'sha256:bytes-b' }],
    });
    const ownerChanged = createOperationPlan({
      ...input(),
      actions: [{ ...artifact, owner: { ...artifact.owner, sourceId: 'team', pluginId: 'team/demo' } }],
    });

    expect(bytesChanged.planFingerprint).not.toBe(baseline.planFingerprint);
    expect(ownerChanged.planFingerprint).not.toBe(baseline.planFingerprint);
  });
});
