import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execute, assertCommand, repoRoot, sha256 } from './native-platform-runtime.mjs';
import { executePublicAw } from './native-platform-public-process.mjs';
import { assertOpenCodeQueryResult, copyOpenCodeExecutable } from './native-platform-opencode.mjs';

const skillRelativePath = 'skills/aw-qualification/SKILL.md';
const queryChild = path.join(repoRoot, 'scripts/qualification/native-platform-opencode-query.mjs');

function stateFor(ctx) {
  assert(ctx.openCodePublicObservation, 'opencode-public-observer-not-prepared');
  return ctx.openCodePublicObservation;
}

function samePath(actual, expected) {
  return typeof actual === 'string' && path.isAbsolute(actual) && path.relative(expected, actual) === '';
}

function processFacts(result) {
  return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
    cancelled: result.cancelled, maxBufferExceeded: result.maxBufferExceeded,
    stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated, terminationReason: result.terminationReason,
    processManagement: { mode: result.containmentMode, gradingEvidenceAccepted: result.gradingEvidenceAccepted,
      descendantCleanupGuaranteed: result.descendantCleanupGuaranteed } };
}

function receiptFrom(stdout) {
  try { return JSON.parse(stdout); } catch { return { status: 'unavailable' }; }
}

async function isolatedFile(ctx, filename) {
  const actual = await fs.realpath(filename);
  const root = await fs.realpath(ctx.root);
  const relative = path.relative(root, actual);
  assert(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'opencode-public-consumer-path-unverified');
  assert((await fs.lstat(filename)).isFile(), 'opencode-public-consumer-path-unverified');
  return { path: actual, bytes: await fs.readFile(actual) };
}

export async function preparePublicOpenCodeObservation(ctx, { runGit = execute, runQuery = executePublicAw } = {}) {
  assert.equal(ctx.platform, 'opencode');
  assert.equal(ctx.pluginName, 'aw-qualification');
  assert.equal(ctx.skillName, 'aw-qualification');
  assert(!Object.hasOwn(ctx.env, 'OPENCODE_CONFIG_DIR'), 'opencode-config-dir-override-present');
  ctx.env.OPENCODE_DISABLE_MODELS_FETCH = '1';
  ctx.env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  ctx.env.OPENCODE_PRINT_LOGS = '1';
  const { getDeploymentResourceKey } = await import('../../packages/cli/dist/src/platforms/layout.js');
  const nativePluginId = getDeploymentResourceKey({ sourceId: 'qualification', pluginId: `qualification/${ctx.pluginName}` });
  const expectedPackageDirectory = ctx.scope === 'user'
    ? path.join(ctx.env.XDG_CONFIG_HOME, 'opencode', 'plugins', nativePluginId)
    : path.join(ctx.project, '.opencode', 'plugins', nativePluginId);
  const client = await copyOpenCodeExecutable(ctx);
  const git = await runGit({ executable: 'git', prefix: [] }, ['init', '--quiet', '--template=', '--initial-branch=qualification', ctx.neutral],
    { cwd: ctx.root, env: ctx.env, timeoutMs: 10_000 });
  ctx.recordCommand({ native: 'opencode-public-fixture-git', cwd: ctx.neutral, ...processFacts(git) });
  assertCommand(git);
  ctx.openCodePublicObservation = { executable: client.executable, nativePluginId, expectedPackageDirectory,
    runQuery, publication: null, removed: false, records: new Map() };
  return { ...client.evidence, expectedPackageDirectory, nativePluginId,
    writes: 'private-executable-and-neutral-Git-only; package-install-update-and-remove-remain-public-AW-operations',
    OPENCODE_CONFIG_DIR: 'absent', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_PRINT_LOGS: '1',
    nativeQueries: 'same-approved-private-query-helper; fresh-server-per-required-cwd-read; original-16/22/25-second-budgets',
    skillLoading: 'same-required-query-receipt; unknown-nonblocking; explicit-content-or-location-mismatch-fails' };
}

async function currentPackage(ctx, revision, version) {
  const state = stateFor(ctx);
  const publication = state.publication;
  assert(publication && publication.revision === revision && publication.version === version, 'opencode-public-publication-unverified');
  const metadataFile = await isolatedFile(ctx, path.join(publication.packageDirectory, 'package.json'));
  const metadata = JSON.parse(metadataFile.bytes.toString('utf8'));
  assert.equal(metadata.name, ctx.pluginName, 'opencode-public-package-identity-mismatch');
  assert.equal(metadata.version, version, 'native-management-version-mismatch');
  assert(['dependencies', 'optionalDependencies', 'peerDependencies'].every(key => Object.keys(metadata[key] ?? {}).length === 0), 'opencode-public-external-dependency-present');
  const skill = await isolatedFile(ctx, path.join(publication.packageDirectory, skillRelativePath));
  const expected = await fs.readFile(ctx.publicSkillFile);
  assert.deepEqual(skill.bytes, expected, 'dynamic-consumer-content-mismatch');
  assert.deepEqual(expected, publication.expectedSkill, 'opencode-public-fixture-revision-mismatch');
  const entry = await isolatedFile(ctx, path.join(publication.packageDirectory, 'index.mjs'));
  return { metadata, skill, entry, expected };
}

export async function capturePublicOpenCodePublication(ctx, result, revision, version) {
  const state = stateFor(ctx);
  assert.equal(result.status, 'success', 'opencode-public-publication-unverified');
  assert(['plugin.install', 'plugin.sync'].includes(result.command), 'opencode-public-publication-unverified');
  const matches = result.data?.targetResults?.filter(item => item.pluginId === `qualification/${ctx.pluginName}`
    && item.target === 'opencode' && item.scope === ctx.scope);
  assert.equal(matches?.length, 1, 'opencode-public-publication-unverified');
  const target = matches[0];
  assert(['applied', 'no-op'].includes(target.execution), 'opencode-public-publication-unverified');
  assert.deepEqual(target.blockerCodes, [], 'opencode-public-publication-unverified');
  assert.equal(target.deploymentReceipts?.length, 1, 'opencode-public-publication-unverified');
  const after = target.deploymentReceipts[0].after;
  assert.equal(after?.ownership, 'aw', 'opencode-public-publication-unverified');
  assert.equal(after?.package, 'present', 'opencode-public-publication-unverified');
  assert.equal(after?.nativeIdentity?.route, 'opencode-directory', 'opencode-public-publication-unverified');
  assert.equal(after.nativeIdentity.packageId, ctx.pluginName, 'opencode-public-publication-unverified');
  assert(samePath(after.nativeIdentity.sourceLocation, state.expectedPackageDirectory), 'opencode-public-source-location-mismatch');
  const packageDirectory = await fs.realpath(after.nativeIdentity.sourceLocation);
  assert.equal(packageDirectory, await fs.realpath(state.expectedPackageDirectory), 'opencode-public-source-location-mismatch');
  const expectedSkill = await fs.readFile(ctx.publicSkillFile);
  // This records the actual public deployment. No candidate projection or
  // hand-installed Native package can satisfy the public publication boundary.
  state.publication = { revision, version, packageDirectory, expectedSkill };
  state.removed = false;
  state.records.clear();
  const current = await currentPackage(ctx, revision, version);
  state.publication.indexSha256 = sha256(current.entry.bytes);
  return { revision, version, packageDirectory, nativePluginId: state.nativePluginId,
    skillSha256: sha256(current.skill.bytes), indexSha256: state.publication.indexSha256,
    indexSha256Basis: 'actual-installed-entry-identity; independent-content-oracle-is-the-current-public-fixture-SKILL.md',
    source: 'successful-public-AW-deployment-receipt; effective-Native-state-still-required' };
}

export function capturePublicOpenCodeRemoval(ctx, result, pluginId) {
  const state = stateFor(ctx);
  assert(state.publication, 'opencode-public-publication-unverified');
  assert.equal(result?.command, 'plugin.remove', 'opencode-public-removal-unverified');
  assert.equal(result?.status, 'success', 'opencode-public-removal-unverified');
  assert.deepEqual(result.data?.request?.plugins, [pluginId], 'opencode-public-removal-unverified');
  assert.deepEqual(result.data?.request?.targets, ['opencode'], 'opencode-public-removal-unverified');
  assert.equal(result.data.request.scope, ctx.scope, 'opencode-public-removal-unverified');
  state.records.clear();
  state.removed = true;
}

export async function readPublicOpenCodeState(ctx, cwd, revision, { active, absent = false, version }) {
  const state = stateFor(ctx);
  state.records.delete(cwd);
  const publication = state.publication;
  assert(publication && publication.revision === revision && publication.version === version, 'opencode-public-publication-unverified');
  assert.equal(typeof active, 'boolean');
  assert.equal(state.removed, absent, 'opencode-public-removal-boundary-unverified');
  const current = absent ? null : await currentPackage(ctx, revision, version);
  const expected = current?.expected ?? publication.expectedSkill;
  const indexSha256 = current ? sha256(current.entry.bytes) : publication.indexSha256;
  const command = { native: 'opencode-public-observation', cwd, revision, version, expectedPresent: active,
    query: ['POST /api/plugin/await-activation', 'GET /api/plugin', ...(active ? ['GET /api/skill (optional)'] : [])] };
  let result;
  try {
    result = await state.runQuery({ executable: process.execPath, prefix: [queryChild] }, [], {
      cwd, env: ctx.env, timeoutMs: 25_000, captureProcessNames: true,
      stdin: JSON.stringify({ root: ctx.root, cwd, fixtureDirectory: publication.packageDirectory, executable: state.executable,
        nativePluginId: state.nativePluginId, expectedPresent: active, skillRelativePath,
        skillBase64: expected.toString('base64'), skillSha256: sha256(expected), indexSha256 }),
    });
  } catch (error) {
    ctx.recordCommand({ ...command, processFailure: error?.message ?? 'opencode-public-query-failed',
      processDiagnostics: error?.publicAwProcessDiagnostics ?? error?.processTreeDiagnostics ?? [],
      ...(error?.publicAwProcessNames || error?.qualificationProcessNames ? { processNames: error.publicAwProcessNames ?? error.qualificationProcessNames } : {}),
      ...(error?.publicAwMarkerRows || error?.qualificationMarkerRows ? { markerRows: error.publicAwMarkerRows ?? error.qualificationMarkerRows } : {}),
      ...(error?.qualificationMarkerIdentityConfirmations ? { markerIdentityConfirmations: error.qualificationMarkerIdentityConfirmations } : {}),
      ...(error?.result ? { ...processFacts(error.result), receipt: receiptFrom(error.result.stdout), stderr: error.result.stderr } : {}) });
    throw error;
  }
  const receipt = receiptFrom(result.stdout);
  ctx.recordCommand({ ...command, ...processFacts(result), receipt,
    ...(result.markerIdentityConfirmations ? { markerIdentityConfirmations: result.markerIdentityConfirmations } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}) });
  assertOpenCodeQueryResult(result, receipt);
  assert.equal(receipt.observation?.expectedPresent, active, 'native-management-scope-mismatch');
  assert.equal(receipt.observation?.location?.matchesRequestedCwd, true, 'native-management-scope-mismatch');
  if (active) {
    assert.equal(receipt.observation.skillBytes?.sha256, sha256(expected), 'dynamic-consumer-content-mismatch');
    assert.equal(receipt.observation.skillBytes?.exactMatch, true, 'dynamic-consumer-content-mismatch');
    assert.equal(receipt.observation.skillBytes?.entrySha256, indexSha256, 'opencode-public-consumer-entry-changed');
  }
  if (!absent) {
    const after = await currentPackage(ctx, revision, version);
    assert.equal(sha256(after.entry.bytes), indexSha256, 'opencode-public-consumer-entry-changed');
  }
  state.records.set(cwd, { revision, version, active, absent, receipt, indexSha256 });
  return { level: 'native-management-state', active, present: active,
    ...(active ? { version, packagePath: publication.packageDirectory, source: 'fresh-Native-plugin-inventory',
      content: receipt.observation.skillBytes } : {}), scope: ctx.scope };
}

export function readPublicOpenCodeSkills(ctx, cwd, revision, present) {
  const state = stateFor(ctx);
  const record = state.records.get(cwd);
  // Observations reuse only successful required reads from this revision. They
  // cannot convert a fresh management/content/process error into "unverified".
  if (!record || record.revision !== revision || record.active !== present) throw new Error('opencode-skill-discovery-unverified-without-current-required-query');
  const observation = record.receipt.skillObservation;
  if (observation?.status !== 'observed') throw new Error(observation?.reason ?? 'opencode-skill-discovery-unverified');
  return { level: 'fresh-process-skill-discovery', present, ...observation, reusedRequiredNativeQuery: true };
}

export async function readPublicOpenCodeDynamicContent(ctx, cwd, revision, version) {
  const state = stateFor(ctx);
  const record = state.records.get(cwd);
  assert(record && record.revision === revision && record.version === version && record.active && !record.absent, 'dynamic-consumer-native-source-unverified');
  const current = await currentPackage(ctx, revision, version);
  assert.equal(sha256(current.entry.bytes), record.indexSha256, 'opencode-public-consumer-entry-changed');
  assert.equal(sha256(current.skill.bytes), record.receipt.observation.skillBytes.sha256, 'dynamic-consumer-content-mismatch');
  return { level: 'dynamic-consumer-content', revision, version, path: current.skill.path,
    sha256: sha256(current.skill.bytes), bytes: current.skill.bytes.length,
    indexSha256: record.indexSha256, source: 'actual-public-package-bound-by-same-revision-fresh-Native-plugin-inventory' };
}
