import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { grokBootstrapSource, qualifyPublicAw } from './native-platform-public-aw.mjs';

// Public DTO shape: commands/public-lifecycle-result.ts. The trust bootstrap
// outcome also matches the fixed r33 staged Grok report; no client is started.
async function bootstrapFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-grok-bootstrap-boundary-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginName = 'aw-qualification';
  const pluginId = `qualification/${pluginName}`;
  const skillName = 'aw-qualification';
  const awHome = path.join(root, 'aw');
  const source = path.join(awHome, 'platforms', 'grok', 'b'.repeat(64), 'packages', 'qualification', pluginName);
  const publicSkillFile = path.join(root, 'authoring', 'SKILL.md');
  const sourceSkillFile = path.join(source, 'skills', skillName, 'SKILL.md');
  const skillText = `---\nname: ${skillName}\ndescription: AW public acceptance revision 1\n---\nFixture body revision 1.\n`;
  await fs.mkdir(path.join(source, '.grok-plugin'), { recursive: true });
  await fs.mkdir(path.dirname(sourceSkillFile), { recursive: true });
  await fs.mkdir(path.dirname(publicSkillFile));
  await fs.writeFile(path.join(source, '.grok-plugin/plugin.json'), JSON.stringify({ name: pluginName, version: '0.1.0' }) + '\n');
  await fs.writeFile(publicSkillFile, skillText);
  await fs.writeFile(sourceSkillFile, skillText);

  const ctx = { pluginName, skillName, publicSkillFile, env: { AW_HOME: awHome } };
  const bindingId = `sha256:${'a'.repeat(64)}`;
  const physicalKey = `sha256:${'c'.repeat(64)}`;
  const activationKey = `sha256:${'d'.repeat(64)}`;
  const configRoot = path.join(root, 'grok');
  const executable = path.join(root, 'client', 'grok');
  const productId = JSON.stringify(['grok', 'cli', executable, configRoot]);
  const products = [{ id: productId, product: 'cli', version: '1.0.77', availability: 'available', reasonCodes: [],
    entry: { kind: 'cli', executable, configRoot } }];
  const componentId = `skill:${skillName}`;
  const effects = ['publish-package', 'register', 'activate'].map((kind) => {
    const destination = kind === 'activate' ? configRoot : source;
    return { id: `${bindingId}:${kind}:${destination}`, kind, physicalKey, activationKey,
      componentIds: [componentId], destination, destructive: false };
  });
  const subject = { pluginId, target: 'grok', scope: 'user' };
  const trustDiagnostic = { code: 'nativeTrustRequired', severity: 'error', message: 'Complete host trust and retry.', subject };
  const blocked = { id: effects[1].id, status: 'blocked', mutation: 'none', diagnostics: [trustDiagnostic,
    { code: 'grokNativeInstallRecovery', severity: 'error', message: 'The AW source is kept for explicit host recovery.', subject }] };
  const receipt = { bindingId, products, after: { physicalKey, package: 'present', registration: 'absent', ownership: 'aw',
    consumers: [{ productId, activationKey, activation: 'unknown', trust: 'required', load: 'not-observed' }],
    components: [{ id: componentId, presence: 'unknown', reasonCodes: ['nativeTrustRequired'] }],
    nativeIdentity: { route: 'grok-cli', packageId: pluginName, sourceLocation: source } },
  effects: [{ id: effects[0].id, status: 'applied', mutation: 'confirmed', diagnostics: [] }, blocked,
    { id: effects[2].id, status: 'skipped', mutation: 'none', diagnostics: [
      { code: 'deploymentDependencyFailed', severity: 'error', message: 'A required deployment action failed.', subject }] }],
  unmet: [], reload: 'none', diagnostics: [] };
  const target = { pluginId, target: 'grok', scope: 'user', delivery: { kind: 'native', platform: 'grok' },
    execution: 'partial', observation: 'unknown', content: 'unknown', requiredBy: [pluginId],
    blockerCodes: ['nativeTrustRequired'], providerScope: 'user', deploymentPlans: [{ bindingId, physicalKey, products,
      expected: { components: [{ id: componentId, kind: 'skill', name: skillName }], omitted: [], unmet: [] },
      effects, sharedReferences: 'none' }], deploymentReceipts: [receipt] };
  const result = { schemaVersion: 1, command: 'plugin.install', status: 'partial', data: {
    request: { plugins: [pluginId], scope: 'user', context: 'project', targets: ['grok'], targetOrigin: 'argument', mode: 'apply' },
    confirmation: { required: false, provided: true, effects: [] },
    changes: { requirements: 'changed', preferences: 'none', config: 'none', sources: 'changed', outputs: 'unknown' },
    requirements: { state: 'valid', roots: [pluginId], digest: `sha256:${'e'.repeat(64)}` },
    targetResults: [target], remainingTargets: [{ pluginId, target: 'grok', scope: 'user' }],
    coverage: { scopes: ['user', 'project'], currentProject: true, otherProjects: 'unobserved' },
  }, diagnostics: [trustDiagnostic], nextActions: [] };
  return { root, ctx, result, pluginId, source, sourceSkillFile, skillText, receipt, blocked, target };
}

// Test Value Gate: only the exact self-created, published User source may leave
// the boundary as a path that the public driver can pass to native --trust.
test('returns the exact retained AW source for the known first-install trust boundary', async (t) => {
  const fixture = await bootstrapFixture(t);
  assert.equal(await grokBootstrapSource(fixture.ctx, fixture.result, fixture.pluginId), fixture.source);
});

test('does not return a trust source for unsafe or unrelated partial results', async (t) => {
  const cases = [
    ['source outside this AW_HOME', async (fixture) => {
      fixture.ctx.env.AW_HOME = path.join(fixture.root, 'other-aw');
      await fs.mkdir(fixture.ctx.env.AW_HOME);
    }],
    ['foreign package ownership', async (fixture) => { fixture.receipt.after.ownership = 'foreign'; }],
    ['old Skill body bytes', async (fixture) => {
      await fs.writeFile(fixture.sourceSkillFile, fixture.skillText.replace('Fixture body revision 1.', 'Fixture body revision 0.'));
    }],
    ['another public failure while the native receipt still reports only trust', async (fixture) => {
      const failure = { code: 'nativeCommandFailed', severity: 'error', message: 'The native command failed.',
        subject: { pluginId: fixture.pluginId, target: 'grok', scope: 'user' } };
      fixture.target.blockerCodes.push(failure.code);
      fixture.result.diagnostics.push(failure);
    }],
  ];
  for (const [name, change] of cases) await t.test(name, async (subtest) => {
    const fixture = await bootstrapFixture(subtest);
    await change(fixture);
    let approvedSource;
    await assert.rejects(async () => {
      approvedSource = await grokBootstrapSource(fixture.ctx, fixture.result, fixture.pluginId);
    }, { code: 'ERR_ASSERTION' });
    assert.equal(approvedSource, undefined, 'A rejected partial must not yield a source for native --trust.');
  });
});

// Test Value Gate: a User-only qualification must not mutate preferences,
// publish sources or launch a native client for an unqualified Project scope.
test('defers Grok Project before any AW or native command', async () => {
  const commands = [];
  const deferred = new Error('fixture-deferred');
  const ctx = { platform: 'grok', scope: 'project',
    async aw() { commands.push('aw'); throw new Error('unexpected-aw-command'); },
    async command() { commands.push('native'); throw new Error('unexpected-native-command'); },
    async rpc() { commands.push('rpc'); throw new Error('unexpected-rpc-command'); },
    async defer(reason) { assert.equal(reason, 'public-aw-grok-project-skill-unverified'); throw deferred; },
  };
  await assert.rejects(qualifyPublicAw(ctx), (error) => error === deferred);
  assert.deepEqual(commands, []);
});
