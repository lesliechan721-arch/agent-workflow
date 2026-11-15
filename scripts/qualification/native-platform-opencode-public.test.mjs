import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareEnvironment, sha256 } from './native-platform-runtime.mjs';
import { preparePublicOpenCodeObservation, capturePublicOpenCodePublication } from './native-platform-opencode-public.mjs';
import { publicFixtureVersion, readPublicNativeState, readPublicRemovedNativeScope, readDynamicConsumerContent } from './native-platform-public-state.mjs';
import { readSkills } from './native-platform-public-aw.mjs';

function processResult() {
  const windows = process.platform === 'win32';
  return { exitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false,
    stdoutTruncated: false, stderrTruncated: false, terminationReason: 'complete',
    containmentMode: windows ? 'verified-observed' : 'observed', gradingEvidenceAccepted: windows, descendantCleanupGuaranteed: windows };
}

async function fixture(t, scope) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-opencode-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const neutral = path.join(root, 'neutral');
  await fs.mkdir(project); await fs.mkdir(neutral);
  const entry = path.join(root, 'acquired-entry');
  await fs.writeFile(entry, 'fixed-native-entry-fixture; never-executed');
  const commands = [];
  const queries = [];
  const behavior = { unavailableSkill: false, staleSkillSha256: null, error: null, receiptReason: null };
  const ctx = { root, project, neutral, scope, platform: 'opencode', pluginName: 'aw-qualification', skillName: 'aw-qualification',
    launcher: { executable: entry, prefix: [] }, env: await prepareEnvironment(root), recordCommand(command) { commands.push(command); } };
  await preparePublicOpenCodeObservation(ctx, {
    async runGit(launcher, args) { assert.equal(launcher.executable, 'git'); assert.equal(args.at(-1), neutral); return processResult(); },
    async runQuery(launcher, args, options) {
      assert.equal(launcher.executable, process.execPath);
      assert.equal(path.basename(launcher.prefix[0]), 'native-platform-opencode-query.mjs');
      assert.deepEqual(args, []);
      assert.equal(options.timeoutMs, 25_000);
      const input = JSON.parse(options.stdin);
      queries.push(input);
      if (behavior.error) throw behavior.error;
      const windows = process.platform === 'win32';
      const expected = Buffer.from(input.skillBase64, 'base64');
      const text = expected.toString('utf8');
      const body = text.slice(/^---\n[\s\S]*?\n---\n/u.exec(text)[0].length);
      const value = { schemaVersion: 1, kind: 'opencode-fixed-local-plugin-query', status: behavior.receiptReason ? 'failed' : 'passed',
        ...(behavior.receiptReason ? { reason: behavior.receiptReason } : {}),
        process: { inheritedMarkerPresent: true,
          markerEnvironmentVariable: windows ? 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER' : 'AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER',
          helperCreatesIndependentProcessGroup: false, readyObserved: true, activationRequested: true, activationResponseStatus: 204,
          activationSettled: true, apiRequested: true, apiResponseStatus: 200, stdinEofSent: true, serverClosed: true,
          serverExitCode: 0, serverSignal: null, fallbackTermUsed: false, fallbackKillUsed: false, groupDrainChecked: !windows },
        observation: { expectedPresent: input.expectedPresent, location: { matchesRequestedCwd: true },
          nativeMatches: input.expectedPresent ? [{ source: { type: 'local', path: input.fixtureDirectory }, state: { status: 'active' } }] : [],
          skillBytes: input.expectedPresent ? { exactMatch: true, sha256: behavior.staleSkillSha256 ?? sha256(expected), entrySha256: input.indexSha256 } : null },
        skillObservation: behavior.unavailableSkill || !input.expectedPresent ? { status: 'unverified', reason: 'optional-Skill-unavailable' }
          : { status: 'observed', nativeMatches: [{ location: path.join(input.fixtureDirectory, input.skillRelativePath) }], contentSha256: sha256(body) } };
      return { ...processResult(), exitCode: behavior.receiptReason ? 1 : 0, stdout: JSON.stringify(value), stderr: '' };
    },
  });
  const directory = ctx.openCodePublicObservation.expectedPackageDirectory;
  const source = path.join(root, 'public-source-SKILL.md');
  ctx.publicSkillFile = source;
  const publication = { command: 'plugin.install', status: 'success', data: { targetResults: [{
    pluginId: 'qualification/aw-qualification', target: 'opencode', scope, execution: 'applied', blockerCodes: [],
    deploymentReceipts: [{ after: { package: 'present', ownership: 'aw', nativeIdentity: {
      route: 'opencode-directory', packageId: 'aw-qualification', sourceLocation: directory } } }],
  }] } };
  const writeRevision = async revision => {
    await fs.mkdir(path.join(directory, 'skills', 'aw-qualification'), { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: ctx.pluginName, version: publicFixtureVersion(revision), type: 'module' }));
    const body = `---\nname: aw-qualification\ndescription: Public fixture ${revision}\n---\nIndependent public fixture body ${revision}.\n`;
    await fs.writeFile(source, body);
    await fs.writeFile(path.join(directory, 'skills', 'aw-qualification', 'SKILL.md'), body);
    await fs.writeFile(path.join(directory, 'index.mjs'), `export default { id: 'aw-qualification-aw-qualification', setup() {} }; // ${revision}\n`);
    publication.command = revision === 1 ? 'plugin.install' : 'plugin.sync';
    return capturePublicOpenCodePublication(ctx, publication, revision, publicFixtureVersion(revision));
  };
  return { ctx, commands, queries, behavior, directory, publication, writeRevision };
}

// Test Value Gate: public AW receipts identify a different physical directory
// from the private candidate fixture. Fresh native reads must bind that source,
// versions, same-version content and both scope locations through removal.
test('OpenCode public observers follow official AW locations across install, updates and removal', async t => {
  for (const scope of ['user', 'project']) await t.test(scope, async t => {
    const value = await fixture(t, scope);
    const { ctx, queries } = value;
    assert.equal(path.basename(value.directory), 'aw-qualification-aw-qualification');
    assert.equal(ctx.env.OPENCODE_CONFIG_DIR, undefined);
    assert.equal(ctx.env.OPENCODE_DISABLE_MODELS_FETCH, '1');
    assert.equal(ctx.env.OPENCODE_DISABLE_AUTOUPDATE, '1');
    let previous;
    for (const revision of [1, 2, 3]) {
      const published = await value.writeRevision(revision);
      const target = await readPublicNativeState(ctx, ctx.project, revision, { active: true });
      const neutral = await readPublicNativeState(ctx, ctx.neutral, revision, { active: scope === 'user' });
      assert.equal(target.version, publicFixtureVersion(revision));
      assert.equal(target.packagePath, value.directory);
      assert.equal(neutral.active, scope === 'user');
      const count = queries.length;
      assert.equal((await readSkills(ctx, ctx.project, revision, true)).status, 'observed');
      if (scope === 'user') assert.equal((await readSkills(ctx, ctx.neutral, revision, true)).status, 'observed');
      else await assert.rejects(readSkills(ctx, ctx.neutral, revision, false));
      if (revision === 3) {
        assert.equal(published.version, previous.version);
        assert.notEqual(published.skillSha256, previous.skillSha256);
        const content = await readDynamicConsumerContent(ctx, ctx.project, revision);
        assert.equal(content.sha256, published.skillSha256);
        assert.equal(content.path, path.join(value.directory, 'skills', 'aw-qualification', 'SKILL.md'));
        if (scope === 'user') assert.equal((await readDynamicConsumerContent(ctx, ctx.neutral, revision)).sha256, published.skillSha256);
      }
      assert.equal(queries.length, count, 'Optional loading and dynamic content reuse successful required source queries.');
      previous = published;
    }
    await fs.rm(value.directory, { recursive: true });
    const removed = await readPublicRemovedNativeScope(ctx, 3, { command: 'plugin.remove', status: 'success', data: {
      request: { plugins: ['qualification/aw-qualification'], targets: ['opencode'], scope },
    } }, 'qualification/aw-qualification');
    assert.equal(removed.retainedRegistration, false);
    assert.equal(removed.target.present, false);
    assert.equal(removed.neutral.present, false);
    assert.equal(queries.length, 8);
    assert.deepEqual(queries.map(query => [query.cwd, query.expectedPresent]), [1, 2, 3, 4].flatMap(revision => [
      [ctx.project, revision !== 4], [ctx.neutral, revision !== 4 && scope === 'user'],
    ]));
  });
});

// Test Value Gate: successful command status or matching staging bytes do not
// prove an AW-owned installed package or native dynamic consumer freshness.
test('OpenCode public observations reject foreign sources, stale bytes and missing fresh native evidence', async t => {
  const value = await fixture(t, 'project');
  const { ctx } = value;
  await value.writeRevision(2);
  value.publication.data.targetResults[0].execution = 'no-op';
  await capturePublicOpenCodePublication(ctx, value.publication, 2, '0.1.1');
  value.publication.data.targetResults[0].execution = 'applied';
  const after = value.publication.data.targetResults[0].deploymentReceipts[0].after;
  after.nativeIdentity.sourceLocation = path.join(ctx.root, 'staging');
  await assert.rejects(capturePublicOpenCodePublication(ctx, value.publication, 2, '0.1.1'), /source-location-mismatch/);
  after.nativeIdentity.sourceLocation = value.directory;
  after.ownership = 'foreign';
  await assert.rejects(capturePublicOpenCodePublication(ctx, value.publication, 2, '0.1.1'), /publication-unverified/);
  after.ownership = 'aw';
  await value.writeRevision(2);
  const previousSha = sha256(await fs.readFile(ctx.publicSkillFile));
  await value.writeRevision(3);
  await assert.rejects(readDynamicConsumerContent(ctx, ctx.project, 3), /native-source-unverified/);
  value.behavior.staleSkillSha256 = previousSha;
  await assert.rejects(readPublicNativeState(ctx, ctx.project, 3, { active: true }), /dynamic-consumer-content-mismatch/);
  value.behavior.staleSkillSha256 = null;
  await fs.writeFile(path.join(value.directory, 'skills', 'aw-qualification', 'SKILL.md'), 'old installed bytes');
  await assert.rejects(readPublicNativeState(ctx, ctx.project, 3, { active: true }), /dynamic-consumer-content-mismatch/);
});

// Test Value Gate: loading can remain unknown, while native plugin failures,
// explicit registry mismatches, deadlines and process inspection failures cannot.
test('OpenCode public required reads retain failures and only optional loading stays unverified', async t => {
  const value = await fixture(t, 'user');
  const { ctx, behavior } = value;
  await value.writeRevision(1);
  behavior.unavailableSkill = true;
  await readPublicNativeState(ctx, ctx.project, 1, { active: true });
  await assert.rejects(readSkills(ctx, ctx.project, 1, true), /optional-Skill-unavailable/);
  behavior.unavailableSkill = false;
  for (const reason of ['scope-fixture-plugin-failed', 'scope-native-skill-registry-mismatch', 'scope-skill-api-timeout']) {
    behavior.receiptReason = reason;
    await assert.rejects(readPublicNativeState(ctx, ctx.project, 1, { active: true }), new RegExp(reason));
    await assert.rejects(readSkills(ctx, ctx.project, 1, true), /without-current-required-query/);
  }
  behavior.receiptReason = null;
  behavior.error = Object.assign(new Error('process inspection failed'), { publicAwProcessDiagnostics: [{ reason: 'marker-missing' }] });
  await assert.rejects(readPublicNativeState(ctx, ctx.project, 1, { active: true }), /process inspection failed/);
  assert.equal(value.commands.at(-1).processFailure, 'process inspection failed');
  assert.deepEqual(value.commands.at(-1).processDiagnostics, [{ reason: 'marker-missing' }]);
});
