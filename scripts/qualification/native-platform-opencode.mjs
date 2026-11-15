import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execute, assertCommand, repoRoot, sha256 } from './native-platform-runtime.mjs';
import { executePublicAw } from './native-platform-public-process.mjs';

const skillRelativePath = 'skills/aw-qualification/SKILL.md';
const queryChild = path.join(repoRoot, 'scripts/qualification/native-platform-opencode-query.mjs');
const processFailure = reason => Object.assign(new Error(reason), { opencodeProcessFailure: true });

function processFacts(result) {
  return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
    cancelled: result.cancelled, maxBufferExceeded: result.maxBufferExceeded,
    stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated,
    terminationReason: result.terminationReason,
    processManagement: { mode: result.containmentMode, gradingEvidenceAccepted: result.gradingEvidenceAccepted,
      descendantCleanupGuaranteed: result.descendantCleanupGuaranteed } };
}

// POSIX uses the explicitly authorized ordinary management observer. Windows
// keeps the existing Job-backed runner and its actual grading/cleanup fields.
export function assertOpenCodeQueryResult(result, receipt, host = process) {
  if (result.signal !== null || result.timedOut || result.cancelled || result.maxBufferExceeded
    || result.stdoutTruncated || result.stderrTruncated || result.terminationReason !== 'complete') {
    throw processFailure('opencode-query-process-incomplete');
  }
  const windows = host.platform === 'win32';
  if (result.containmentMode !== (windows ? 'verified-observed' : 'observed')
    || result.gradingEvidenceAccepted !== windows || result.descendantCleanupGuaranteed !== windows) {
    throw processFailure('opencode-query-process-contract-invalid');
  }
  if (receipt?.schemaVersion !== 1 || receipt.kind !== 'opencode-fixed-local-plugin-query') throw processFailure('opencode-query-receipt-invalid');
  const flags = receipt.process;
  if (!flags?.inheritedMarkerPresent || flags.markerEnvironmentVariable !== (windows ? 'AW_AGENT_SKILL_EVAL_PROCESS_MARKER' : 'AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER')
    || flags.helperCreatesIndependentProcessGroup !== false || !flags.readyObserved || !flags.activationRequested
    || flags.activationResponseStatus !== 204 || !flags.activationSettled || !flags.apiRequested || flags.apiResponseStatus !== 200
    || !flags.stdinEofSent || !flags.serverClosed || flags.serverExitCode !== 0 || flags.serverSignal !== null
    || flags.fallbackTermUsed || flags.fallbackKillUsed || (!windows && !flags.groupDrainChecked) || receipt.cleanupReason
    || /^rpc-|^scope-(?:server|marker|input|ready|print|offline|config|activation|skill-api-timeout)/u.test(receipt.reason ?? '')) {
    throw processFailure(receipt.reason ?? 'opencode-native-process-contract-invalid');
  }
  if (receipt.skillObservation?.status === 'failed') throw new Error('scope-native-skill-registry-mismatch');
  if (receipt.status !== 'passed') throw new Error(receipt.reason ?? 'opencode-query-not-passed');
  assertCommand(result);
}

export async function copyOpenCodeExecutable(ctx) {
  if (ctx.launcher.prefix.length !== 0) throw new Error('opencode-native-entry-required');
  const source = await fs.realpath(ctx.launcher.executable);
  if (!(await fs.stat(source)).isFile()) throw new Error('opencode-native-entry-required');
  const directory = path.join(ctx.root, 'client');
  await fs.mkdir(directory);
  const destination = path.join(directory, `opencode${process.platform === 'win32' ? '.exe' : ''}`);
  const sourceSha256 = sha256(await fs.readFile(source));
  await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') await fs.chmod(destination, 0o755);
  const copiedSha256 = sha256(await fs.readFile(destination));
  if (copiedSha256 !== sourceSha256 || await fs.realpath(destination) !== destination) throw new Error('opencode-private-entry-copy-mismatch');
  return { executable: destination, evidence: { sourceSha256, copiedSha256,
    entry: destination, method: 'single-official-native-binary-copy-into-owned-scope; no-postinstall' } };
}

async function snapshot(directory) {
  const files = {};
  async function visit(relative) {
    const file = path.join(directory, relative);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error('opencode-bundle-symlink');
    if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(relative ? `${relative}/${name}` : name);
    else if (stat.isFile()) files[relative] = sha256(await fs.readFile(file));
    else throw new Error('opencode-bundle-special-file');
  }
  await visit('');
  return Object.freeze(files);
}

async function assertSnapshot(directory, frozen) {
  if (JSON.stringify(await snapshot(directory)) !== JSON.stringify(frozen)) throw new Error('opencode-frozen-bundle-changed');
}

export async function readOpenCodeFixture(ctx, rendered) {
  const version = rendered.revision === 1 ? '0.1.0' : '0.1.1';
  const metadata = JSON.parse(await fs.readFile(path.join(ctx.bundle, 'package.json'), 'utf8'));
  if (metadata.name !== ctx.pluginName || metadata.version !== version || rendered.version !== version
    || rendered.nativePluginId !== 'aw-qualification-aw-qualification') throw new Error('opencode-projected-package-mismatch');
  if (['dependencies', 'optionalDependencies', 'peerDependencies'].some(key => Object.keys(metadata[key] ?? {}).length)) throw new Error('opencode-projected-external-dependency-present');
  const files = await snapshot(ctx.bundle);
  const skillBytes = await fs.readFile(path.join(ctx.bundle, skillRelativePath));
  const text = skillBytes.toString('utf8');
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!frontmatter || !files['index.mjs']) throw new Error('opencode-projected-skill-invalid');
  const bodySha256 = sha256(text.slice(frontmatter[0].length));
  return { revision: rendered.revision, version, nativePluginId: rendered.nativePluginId, files, skillBytes, bodySha256,
    evidence: { revision: rendered.revision, version, contentDigest: rendered.contentDigest,
      projectionInput: rendered.projectionInput, nativePluginId: rendered.nativePluginId, files,
      bodySha256, skillSha256: sha256(skillBytes), externalPackageDependencies: 'absent',
      installer: 'none; Native-active-inventory-still-required', freezing: 'current-run-bundle-with-before-and-after-hash-checks' } };
}

async function query(ctx, fixture, executable, fixtureDirectory, cwd, expectedPresent) {
  const command = { native: 'opencode', query: ['POST /api/plugin/await-activation', 'GET /api/plugin', ...(expectedPresent ? ['GET /api/skill (optional)'] : [])],
    cwd, revision: fixture.revision, version: fixture.version, expectedPresent };
  let result;
  try {
    result = await executePublicAw({ executable: process.execPath, prefix: [queryChild] }, [], {
      cwd, env: ctx.env, timeoutMs: 25_000, captureProcessNames: true,
      stdin: JSON.stringify({ root: ctx.root, cwd, fixtureDirectory, executable,
        nativePluginId: fixture.nativePluginId, expectedPresent, skillRelativePath,
        skillBase64: fixture.skillBytes.toString('base64'), skillSha256: sha256(fixture.skillBytes), indexSha256: fixture.files['index.mjs'] }),
    });
  } catch (error) {
    ctx.recordCommand({ ...command, processFailure: error?.message ?? 'opencode-query-process-failed',
      processDiagnostics: error?.publicAwProcessDiagnostics ?? error?.processTreeDiagnostics ?? [],
      ...(error?.publicAwProcessNames || error?.qualificationProcessNames ? { processNames: error.publicAwProcessNames ?? error.qualificationProcessNames } : {}),
      ...(error?.publicAwMarkerRows || error?.qualificationMarkerRows ? { markerRows: error.publicAwMarkerRows ?? error.qualificationMarkerRows } : {}),
      ...(error?.qualificationMarkerIdentityConfirmations ? { markerIdentityConfirmations: error.qualificationMarkerIdentityConfirmations } : {}),
      ...(error?.result ? { ...processFacts(error.result), receipt: parseReceipt(error.result.stdout), stderr: error.result.stderr } : {}) });
    throw error;
  }
  const receipt = parseReceipt(result.stdout);
  ctx.recordCommand({ ...command, ...processFacts(result), receipt,
    ...(result.markerIdentityConfirmations ? { markerIdentityConfirmations: result.markerIdentityConfirmations } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}) });
  assertOpenCodeQueryResult(result, receipt);
  if (receipt.observation?.expectedPresent !== expectedPresent || receipt.observation?.location?.matchesRequestedCwd !== true) throw new Error('opencode-query-location-evidence-invalid');
  if (expectedPresent && (receipt.observation.skillBytes?.exactMatch !== true
    || receipt.observation.skillBytes.sha256 !== sha256(fixture.skillBytes)
    || receipt.observation.skillBytes.bodySha256 !== fixture.bodySha256
    || receipt.observation.skillBytes.entrySha256 !== fixture.files['index.mjs'])) throw new Error('opencode-native-byte-evidence-invalid');
  await assertSnapshot(ctx.bundle, fixture.files);
  if (expectedPresent || await fs.lstat(fixtureDirectory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    await assertSnapshot(fixtureDirectory, fixture.files);
  }
  return receipt;
}

function parseReceipt(stdout) {
  try { return JSON.parse(stdout); } catch { return { status: 'unavailable' }; }
}

async function recordSkillObservation(ctx, id, receipt) {
  await ctx.observe(id, async () => {
    const observation = receipt.skillObservation;
    if (observation?.status !== 'observed') throw new Error(observation?.reason ?? 'opencode-skill-observation-unverified');
    return { level: 'native-skill-registry', ...observation };
  });
}

export async function qualifyOpenCode(ctx) {
  if (Object.hasOwn(ctx.env, 'OPENCODE_CONFIG_DIR')) throw new Error('opencode-config-dir-override-present');
  ctx.env.OPENCODE_DISABLE_MODELS_FETCH = '1';
  ctx.env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  ctx.env.OPENCODE_PRINT_LOGS = '1';
  const fixtureDirectory = ctx.scope === 'user' ? path.join(ctx.env.XDG_CONFIG_HOME, 'opencode/plugins', ctx.pluginName)
    : path.join(ctx.project, '.opencode/plugins', ctx.pluginName);
  let privateClient;
  await ctx.check('opencode-isolated-environment', async () => {
    privateClient = await copyOpenCodeExecutable(ctx);
    const result = await execute({ executable: 'git', prefix: [] }, ['init', '--quiet', '--template=', '--initial-branch=qualification', ctx.neutral],
      { cwd: ctx.root, env: ctx.env, timeoutMs: 10_000 });
    ctx.recordCommand({ native: 'fixture-git-project', cwd: ctx.neutral, ...processFacts(result) });
    assertCommand(result);
    return { ...privateClient.evidence, HOME: ctx.env.HOME, AW_HOME: ctx.env.AW_HOME, XDG_CONFIG_HOME: ctx.env.XDG_CONFIG_HOME,
      target: ctx.project, neutral: ctx.neutral, fixtureDirectory, OPENCODE_CONFIG_DIR: 'absent',
      credentials: 'not-provided', requests: 'local-plugin-activation-inventory-and-optional-Skill-only; no-model-session-or-tools',
      runtimeNetwork: 'blocked-proxy; disable-models-fetch-and-autoupdate; loopback-random-control-nonce-redacted',
      processContract: process.platform === 'win32' ? 'existing-Windows-Job; actual-result-fields'
        : 'explicitly-authorized-ordinary-observed; marker-PID-start-deadline-owned-descendant-exit-cleanup; not-Provider-or-OS-containment' };
  });
  let owned = false;
  const removeOwned = async () => {
    if (!owned || await fs.realpath(fixtureDirectory) !== fixtureDirectory || !(await fs.lstat(fixtureDirectory)).isDirectory()) throw new Error('opencode-fixture-delete-not-owned');
    await fs.rm(fixtureDirectory, { recursive: true });
    owned = false;
  };
  let fixture;
  for (const revision of [1, 2, 3]) {
    const rendered = revision === 1 ? ctx.initialProjection : await ctx.render(revision);
    await ctx.check(`opencode-revision-${revision}-frozen-bundle`, async () => {
      fixture = await readOpenCodeFixture(ctx, rendered);
      return fixture.evidence;
    });
    await ctx.check(`opencode-revision-${revision}-${revision === 1 ? 'install' : 'refresh'}`, async () => {
      await assertSnapshot(ctx.bundle, fixture.files);
      if (owned) await removeOwned();
      else if (await fs.lstat(fixtureDirectory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('opencode-fixture-already-exists');
      await fs.mkdir(path.dirname(fixtureDirectory), { recursive: true });
      await fs.cp(ctx.bundle, fixtureDirectory, { recursive: true, force: false, errorOnExist: true });
      owned = true;
      await assertSnapshot(fixtureDirectory, fixture.files);
      return { version: fixture.version, revision, path: fixtureDirectory, files: fixture.files, strategy: 'replace-only-current-run-owned-directory' };
    });
    for (const [label, cwd, present] of [['target', ctx.project, true], ['neutral', ctx.neutral, ctx.scope === 'user']]) {
      let receipt;
      await ctx.check(`opencode-revision-${revision}-${label}`, async () => {
        receipt = await query(ctx, fixture, privateClient.executable, fixtureDirectory, cwd, present);
        return receipt.observation;
      });
      if (present) await recordSkillObservation(ctx, `opencode-revision-${revision}-${label}-skill`, receipt);
    }
  }
  await ctx.check('opencode-remove-owned-fixture', async () => { await removeOwned(); return { removed: 'only-current-run-owned-Native-plugin-directory' }; });
  for (const [label, cwd] of [['target', ctx.project], ['neutral', ctx.neutral]]) {
    await ctx.check(`opencode-removed-${label}`, async () => (await query(ctx, fixture, privateClient.executable, fixtureDirectory, cwd, false)).observation);
  }
}
