import { describe, expect, it } from 'vitest';
import { projectReceipt } from '../../src/output/receipt-projection.js';
import { publicExitCode } from '../../src/output/public-result.js';
import type { CatalogPublicationFailureOutcome } from '../../src/commands/catalog-publish.js';

describe('public domain result projection', () => {
  it('retains self-check observations and requirement derivation facts', () => {
    const observations = [{ code: 'aw-command-detected', blocking: false, path: 'SKILL.md', provenance: 'shell-fence', command: 'aw dev review inspect', capability: 'aw.review-inspection.v3', message: 'Detected an AW command.', backend: { secret: 'hidden' } }];
    const result = projectReceipt('self.check', { ok: false, awVersion: '1', coreVersion: '1', source: { kind: 'manifest', path: '/workspace/plugin.json' }, plugin: { name: 'demo', version: '1.0.0' }, requiredCapabilities: ['future'], missingCapabilities: ['future'], capabilitySetDigest: 'digest', observations });
    expect(result.data).toMatchObject({ missingCapabilities: ['future'], observations: [{ path: 'SKILL.md', capability: 'aw.review-inspection.v3' }] });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'awCapabilityUnsupported' }));
    expect(JSON.stringify(result)).not.toContain('backend');
    const requirements = projectReceipt('dev.plugin.requirements', { pluginDirectory: '/workspace/demo', mutation: { action: 'add', capability: 'future', changed: true }, declared: ['future'], derived: ['aw.plugin-manifest.v3'], detected: [], effective: ['future'], unsupportedByCurrentAw: ['future'], observations: [] });
    expect(requirements.data).toMatchObject({ derived: ['aw.plugin-manifest.v3'], detected: [], unsupportedByCurrentAw: ['future'], mutation: { changed: true }, pluginDirectory: '/workspace/demo' });
  });

  it('distinguishes complete unhealthy source observations from failed queries', () => {
    const sources = [{ sourceId: 'empty', activeReady: false, compatibility: null }, { sourceId: 'broken', activeReady: false, errorCode: 'catalogGenerationUnavailable', compatibility: null }];
    const result = projectReceipt('source.status', { sources });
    expect(result.status).toBe('partial');
    expect(publicExitCode(result)).toBe(4);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'catalogGenerationUnavailable', subject: { sourceId: 'broken' } }));
    expect(projectReceipt('source.status', { sources: [sources[0]] }).status).toBe('success');
    expect(projectReceipt('source.status', { sources: [sources[1]] }).status).toBe('blocked');
  });

  it('retains source resolution and confirmation after confirmed activation', () => {
    const result = projectReceipt('source.sync', { sourceId: 'team', mode: 'sync', outcome: 'activated', activeChanged: true, resolution: { sourceIdentity: 'identity', logicalIdentity: 'logical', catalogVersion: '1.0.0', channel: 'latest', requestedRef: 'main', resolvedCommit: 'commit', manifestDigest: 'manifest', snapshotDigest: 'snapshot', rootDir: '/private/store' }, lastSync: { syncedAt: 'now', mode: 'sync', state: 'succeeded' }, impact: { impactSchemaVersion: 3, sourceId: 'team', primaryChange: null, inventoryComplete: true, references: [], affectedReferences: [{ category: 'config', sourceId: 'team', scope: 'user' }], changes: {}, errors: [] } }, { yes: true });
    expect(result.data).toMatchObject({ mode: 'sync', activeChanged: true, resolution: { resolvedCommit: 'commit' }, lastSync: { state: 'succeeded' }, confirmation: { required: true, provided: true } });
    expect(JSON.stringify(result)).not.toContain('/private/store');
  });

  it('keeps unknown cache sizes, actual deletions and confirmed effects', () => {
    const result = projectReceipt('cache.prune', { ok: false, overallState: 'partial', dryRun: false, entries: [{ storeKey: 'unknown', status: 'error', ageMs: null, reclaimableBytes: null, absolutePath: '/private/cache' }], deleted: [{ storeKey: 'old', bytes: 20 }], retained: [{ storeKey: 'unknown', reason: 'inspectionFailed' }], deletedBytes: 20, reclaimableBytes: null, errors: [{ code: 'catalogStoreInspectionFailed', message: 'Inspection failed.' }] }, { yes: true });
    expect(result.status).toBe('partial');
    expect(result.data).toMatchObject({ reclaimableBytes: null, deletedBytes: 20, preview: false, confirmation: { required: true, provided: true } });
    expect(JSON.stringify(result)).not.toContain('/private/cache');
  });

  it('retains review source paths and unavailable final facts without failing a completed inspection', () => {
    const result = projectReceipt('dev.review.inspect', { ok: true, view: 'review', target: { kind: 'plugin', path: '/workspace/demo' }, sources: ['/workspace/demo/SKILL.md'], skills: [{ skill: 'demo', sourcePath: '/workspace/demo/SKILL.md', profile: { platform: 'codex', scope: 'user', inputDigest: null }, finalPath: null, digest: null, state: 'missing', evidencePath: null }], issues: [{ code: 'materializationMissing', path: '/workspace/demo/SKILL.md', message: 'The final Skill is missing.' }] });
    expect(result.status).toBe('success');
    expect(result.data).toMatchObject({ sources: ['/workspace/demo/SKILL.md'], skills: [{ finalPath: null, digest: null }], issues: [{ path: '/workspace/demo/SKILL.md' }] });
  });

  it('keeps saved config and failed package refresh separate and derives a safe retry', () => {
    const result = projectReceipt('plugin.config.set', { ok: false, overallState: 'partial', pluginId: 'team/demo', configWrite: 'succeeded', updatedKeys: ['enabled'], apply: { state: 'partial', targetResults: [], commandResults: [{ producer: { sourceId: 'team', sourceIdentity: 'identity', pluginName: 'consumer', kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null }, state: 'failed', commandIds: [], removedCommandIds: [], errors: [{ code: 'nativeToolSyncRequired', message: 'Refresh native tools first.' }], recoveryActions: ['run unsafe --yes'] }] } }, { yes: true });
    expect(result.status).toBe('partial');
    expect(result.data).toMatchObject({ configWrite: 'succeeded', apply: { commandResults: [{ errors: [{ code: 'nativeToolSyncRequired' }] }] } });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'nativeToolSyncRequired', subject: { pluginId: 'team/consumer', scope: 'user' } }));
    expect(result.nextActions).toContainEqual(expect.objectContaining({ argv: ['aw', 'command', 'package', 'sync', 'team/consumer', 'tools', '--scope', 'user'], requiresConfirmation: true }));
    expect(JSON.stringify(result.nextActions)).not.toContain('--yes');
    expect(JSON.stringify(result)).not.toContain('run unsafe');
  });

  it('omits nested backend objects while retaining unknown target results and policy schema', () => {
    const result = projectReceipt('target.set', { ok: false, scope: 'user', preferencesChanged: true, outputsMayHaveChanged: true, policy: { schemaVersion: 2, targets: ['codex'], exclusions: [] }, targetResults: [{ pluginId: 'team/demo', agent: 'codex', scope: 'user', delivery: { kind: 'native', platform: 'codex' }, execution: 'failed', observation: 'unknown', requiredBy: ['team/demo'], blockers: [{ code: 'writeFailed', message: 'Write failed.' }], backend: { error: new Error('secret'), context: { awHome: '/private/home' } } }], remainingTargets: [{ pluginId: 'team/demo', agent: 'codex', scope: 'user' }] });
    expect(result.status).toBe('partial');
    expect(result.data).toMatchObject({ policy: { schemaVersion: 2 }, targetResults: [{ target: 'codex', observation: 'unknown', content: 'unknown' }] });
    expect(JSON.stringify(result)).not.toContain('backend');
    expect(JSON.stringify(result)).not.toContain('/private/home');
  });

  it('preserves business schemas but excludes private publication recovery paths', () => {
    const config = projectReceipt('plugin.config.get', { ok: true, configSchemaVersion: 5, fields: [{ key: 'token', valueState: 'redacted', value: '[redacted]' }] });
    expect(config.data).toMatchObject({ configSchemaVersion: 5, fields: [{ key: 'token', value: '[redacted]' }] });
    const plan = projectReceipt('dev.catalog.publish.plan', { ok: true, state: 'prepared', planDigest: 'plan', descriptor: { schemaVersion: 1, workspaceIdentity: 'workspace', remote: { name: 'origin', identityDigest: 'remote' } }, journalPath: '/private/aw/journal', repositoryPath: '/private/aw/repository' });
    expect(plan.data).toMatchObject({ prepared: true, state: 'prepared', descriptor: { schemaVersion: 1 } });
    expect(JSON.stringify(plan)).not.toContain('/private/aw');
    expect(plan.data).not.toHaveProperty('published');
  });

  it('preserves the full independent version-check report', () => {
    const result = projectReceipt('dev.plugin.validate', { ok: true, versionCheck: { schemaVersion: 3, policy: 'development', ok: true, base: { requested: 'HEAD', commit: 'abc' }, checkedPlugins: 1, checks: [{ plugin: 'demo', ok: true, status: 'unchanged', productionChanged: false, baseDigest: 'old', currentDigest: 'new', changedPaths: [], warnings: [], errors: [], backend: { privatePath: '/private/context' } }] } });
    expect(result.data).toMatchObject({ versionCheck: { schemaVersion: 3, policy: 'development', ok: true, checks: [{ plugin: 'demo', productionChanged: false, currentDigest: 'new' }] } });
    expect(JSON.stringify(result)).not.toContain('backend');
  });

  it('combines reset and apply effects without clearing the requirement after confirmation', () => {
    const result = projectReceipt('plugin.config.reset', { ok: true, configWrite: 'succeeded', confirmation: { required: true, provided: true, effects: [{ code: 'runPreApply', message: 'Run the selected preApply script.', impact: 'selected-scope', subject: { pluginId: 'team/demo', scope: 'user' } }] } }, { yes: true, confirmation: { required: true, provided: true, effects: [{ code: 'deletePluginConfig', message: 'Delete the selected configuration.', impact: 'user-wide', subject: { pluginId: 'team/demo', scope: 'user' } }] } });
    expect(result.data).toMatchObject({ confirmation: { required: true, provided: true, effects: [expect.objectContaining({ code: 'deletePluginConfig' }), expect.objectContaining({ code: 'runPreApply' })] } });
  });

  it('keeps an explicit author correction path but hides unrelated execution paths', () => {
    const result = projectReceipt('dev.plugin.validate', { ok: false, workspaceRoot: '/workspace', errors: ['Plugin root must use the canonical workspace path: /workspace/plugins/demo', 'Could not read /private/aw/execution/context.'] });
    expect(result.diagnostics[0]?.message).toContain('/workspace/plugins/demo');
    expect(result.diagnostics[1]?.message).toContain('Could not read');
    expect(JSON.stringify(result)).not.toContain('/private/aw');
  });

  it('retains uncertain remote writes and retries only the same publication identity', () => {
    const outcome = { state: 'uncertain', journalState: 'uncertain', remoteWriteAttempted: true, remoteVerified: false,
      branch: 'catalog', planDigest: `sha256:${'a'.repeat(64)}`, expectedCommit: 'commit', catalogVersion: '1.0.0', tag: 'catalog-v1.0.0',
    } satisfies CatalogPublicationFailureOutcome;
    // The real CLI failure receipt spreads outcome; it has no resolved workspace or remote.
    const receipt = { ok: false, code: 'catalogPublicationFailed', message: 'Remote reconciliation is required.', overallState: 'partial', ...outcome };
    const result = projectReceipt('dev.catalog.publish.apply', receipt, { yes: true });
    expect(result.status).toBe('partial');
    expect(publicExitCode(result)).toBe(4);
    expect(result.data).toMatchObject({ state: 'uncertain', journalState: 'uncertain', remoteWriteAttempted: true, remoteVerified: false, expectedCommit: 'commit' });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'catalogPublicationFailed' }));
    expect(result.nextActions).toEqual([{ kind: 'manual', message: expect.stringContaining(outcome.planDigest) }]);
    // Only known resolved selection permits an executable same-plan suggestion.
    const resolved = projectReceipt('dev.catalog.publish.apply', { ...receipt, workspaceRoot: '/workspace', remote: 'publish' }, { yes: true });
    expect(resolved.nextActions).toEqual([expect.objectContaining({ argv: ['aw', 'dev', 'catalog', 'publish', 'apply', '--workspace-root', '/workspace', '--remote', 'publish', '--branch', 'catalog', '--expected-plan-digest', outcome.planDigest], requiresConfirmation: true })]);
  });
});
