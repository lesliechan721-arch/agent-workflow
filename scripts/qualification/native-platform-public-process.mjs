import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { execute, repoRoot } from './native-platform-runtime.mjs';
import { createProcessNameDiagnostic, createProcessMarkerRowDiagnostic, createLinuxEnvironmentDiagnostic } from './native-platform-process-names.mjs';
import { createMarkerIdentityConfirmationCapture } from './native-platform-marker-confirmations.mjs';
import { createProcessQueryTimingDiagnostic } from './native-platform-process-query-timings.mjs';

const MARKER_ENV = 'AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER';

// The historical installation is a separate package with its own runner
// singleton. Bind its known entry and module, not an arbitrary entry's imports.
export function resolveFrozenPublicAwPackage(root, entry) {
  assert(root && path.isAbsolute(root), 'Provide the installed historical AW package directory.');
  root = realpathSync(root);
  function packageFile(relative) {
    const expected = path.join(root, relative);
    const actual = realpathSync(expected);
    assert(actual === expected && statSync(actual).isFile(), 'Historical AW package file is not contained in its package.');
    return actual;
  }
  const manifest = JSON.parse(readFileSync(packageFile('package.json'), 'utf8'));
  assert.equal(manifest.name, '@lesliechan721/aw');
  assert.equal(manifest.version, '0.1.0-beta.85');
  assert(['dist/index.js', './dist/index.js'].includes(manifest.bin?.aw), 'Unexpected historical AW entry.');
  const cliEntry = packageFile('dist/index.js');
  if (entry !== undefined) assert.equal(realpathSync(entry), cliEntry, 'Historical AW entry does not match its package.');
  return { root, entry: cliEntry, pluginScripts: packageFile('dist/src/utils/plugin-scripts.js'), version: manifest.version };
}

// Only the public AW entry needs to carry the outer lease across its private
// renderer/preApply environment. Ordinary native clients use their own launchers.
export function publicAwNodeLauncher(entry, trace = false, frozenRoot) {
  const frozen = frozenRoot === undefined ? undefined : resolveFrozenPublicAwPackage(frozenRoot, entry);
  const preload = process.platform === 'linux' ? new URL('./native-platform-public-plugin-marker.mjs', import.meta.url)
    : trace ? new URL('./native-platform-managed-trace.mjs', import.meta.url) : undefined;
  if (frozen && process.platform === 'linux') preload.searchParams.set('frozenRoot', frozen.root);
  return { executable: process.execPath, prefix: [...(preload ? ['--import', preload.href] : []), frozen?.entry ?? entry] };
}

// AW manages independent native-command groups. This is a compatibility
// observation, not a cooperative custom provider or OS containment guarantee.
export async function executePublicAw(launcher, args, options, processTree = {}) {
  if (process.platform === 'win32') return execute(launcher, args, options);
  const { runProviderProcess } = await import('../../packages/agent-skill-eval/dist/process.js');
  const { acquireProcessTreeInspectionLease, observeProcessTree, terminateProcessTree } =
    await import('../../packages/agent-skill-eval/dist/process-tree.js');
  if (options.signal?.aborted) {
    const error = options.signal.reason ?? new Error('public-aw-cancelled');
    if (error && typeof error === 'object') {
      try {
        error.publicAwProcessFailure = { stage: 'before-launch', reason: 'cancelled',
          processCleanup: 'not-needed', leaseCleanup: 'not-needed' };
      } catch { /* A caller's immutable cancellation reason still wins. */ }
    }
    throw error;
  }
  const hostedDiagnostics = process.env.GITHUB_ACTIONS === 'true' && process.env.AW_NATIVE_QUALIFICATION_PROCESS_NAMES === '1';
  const procfs = process.platform === 'linux' && processTree.execFile === undefined && launcher.executable === process.execPath
    && launcher.prefix.at(-1) === path.join(repoRoot, 'packages/cli/dist/index.js');
  const queryTimings = hostedDiagnostics && process.platform === 'darwin'
    ? createProcessQueryTimingDiagnostic(processTree.execFile) : undefined;
  const names = hostedDiagnostics && !procfs && ['linux', 'darwin'].includes(process.platform)
    ? createProcessNameDiagnostic(queryTimings?.execFile ?? processTree.execFile) : undefined;
  const markerRows = names && process.platform === 'linux'
    ? createProcessMarkerRowDiagnostic(names.execFile, {
      environmentProbe: createLinuxEnvironmentDiagnostic({ deadlineAt: Date.now() + (options.timeoutMs ?? 60_000) }),
    }) : undefined;
  const confirmations = hostedDiagnostics && process.platform === 'linux' ? createMarkerIdentityConfirmationCapture() : undefined;
  const dependencies = { ...processTree, markerEnvironmentVariable: MARKER_ENV,
    enforceProcessMarker: true, enforceCooperativeProcessGroup: false,
    ...(procfs ? { linuxProcessInspection: 'procfs' } : {}),
    ...(names ? { execFile: markerRows?.execFile ?? names.execFile } : {}),
    ...(confirmations ? { onLinuxMarkerIdentityConfirmation: confirmations.capture } : {}) };
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  let lease;
  let observation;
  let stopFailureListener;
  let failure;
  let returned;
  let stage = 'inspection-lease-acquire';
  let cleanupConfirmed = false;
  let observationFailed = false;
  let leaseCleanup = 'unconfirmed';
  try {
    lease = await acquireProcessTreeInspectionLease(dependencies);
    markerRows?.setMarker(MARKER_ENV, lease.marker);
    stage = 'process-execution';
    const result = await runProviderProcess({
      executable: launcher.executable, args: [...launcher.prefix, ...args], cwd: options.cwd,
      env: { ...options.env, [MARKER_ENV]: lease.marker }, signal: controller.signal,
      timeoutMs: options.timeoutMs ?? 60_000, maxBufferBytes: 2 * 1024 * 1024,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    }, {
      onSpawn({ pid }) {
        names?.onSpawn({ pid });
        markerRows?.onSpawn({ pid });
        observation = observeProcessTree(pid, lease.marker, dependencies, lease);
        stopFailureListener = observation.onFailure((error) => {
          observationFailed = true;
          controller.abort(error);
        });
      },
      async terminateProcessTree({ pid }, reason) {
        if (!observation) throw new Error('public-aw-inspection-not-started');
        // The provider runner owns the ChildProcess handle and its fallback.
        // This hook signals only identities revalidated by the observation.
        await terminateProcessTree(pid, () => {}, dependencies, { observation, requireConfirmedCleanup: true,
          requireDescendantsExitedBeforeCompletion: reason === 'complete' });
        cleanupConfirmed = true;
        return { confirmed: true };
      },
    }, { containment: 'observed', processTree: dependencies });
    stage = 'process-result';
    if (result.cancelled || result.terminationReason !== 'complete') {
      throw Object.assign(new Error(`public-aw-process-${result.terminationReason}`), { result });
    }
    const markerIdentityConfirmations = confirmations?.snapshot();
    returned = { ...result, ...(markerIdentityConfirmations ? { markerIdentityConfirmations } : {}),
      stdout: result.stdout.replaceAll(lease.marker, '<PUBLIC_AW_PROCESS_MARKER>'),
      stderr: result.stderr.replaceAll(lease.marker, '<PUBLIC_AW_PROCESS_MARKER>') };
    return returned;
  } catch (error) {
    failure = error;
    if (lease && error instanceof Error) error.message = error.message.replaceAll(lease.marker, '<PUBLIC_AW_PROCESS_MARKER>');
    if (error && typeof error === 'object') {
      // Acquisition may fail before the AW process exists, including during
      // sentinel preflight. Neither an exit code nor sentinel cleanup can be
      // inferred from that failure. Record only phases we actually reached.
      const cleanupFailed = error.name === 'ProviderProcessCleanupError';
      error.publicAwProcessFailure = { stage, reason: stage === 'inspection-lease-acquire'
        ? 'inspection-lease-acquisition-failed' : cleanupFailed ? 'process-cleanup-unconfirmed'
          : observationFailed ? 'process-observation-failed' : stage === 'process-result'
            ? 'process-result-rejected' : 'provider-process-threw',
        processCleanup: stage === 'inspection-lease-acquire' ? 'not-needed'
          : cleanupConfirmed && !cleanupFailed ? 'confirmed' : 'unconfirmed' };
      const diagnostics = observation?.diagnostics ?? [];
      error.publicAwProcessDiagnostics = diagnostics.length > 1 ? [diagnostics[0], diagnostics.at(-1)] : diagnostics;
      try {
        const hints = names?.snapshot(error.publicAwProcessDiagnostics);
        if (hints?.length) error.publicAwProcessNames = hints;
        const rows = markerRows?.snapshot(error.publicAwProcessDiagnostics);
        if (rows?.length) error.publicAwMarkerRows = rows;
        const evidence = confirmations?.snapshot();
        if (evidence) error.qualificationMarkerIdentityConfirmations = evidence;
      } catch { /* Name hints cannot replace the original process failure. */ }
      if (lease && error.result) {
        error.result.stdout = error.result.stdout.replaceAll(lease.marker, '<PUBLIC_AW_PROCESS_MARKER>');
        error.result.stderr = error.result.stderr.replaceAll(lease.marker, '<PUBLIC_AW_PROCESS_MARKER>');
      }
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    names?.stop();
    markerRows?.stop();
    confirmations?.stop();
    stopFailureListener?.();
    observation?.dispose();
    try {
      if (lease) {
        await lease.release();
        leaseCleanup = 'confirmed';
      }
    } catch (error) {
      const releaseFailure = new Error(`${failure?.message ? `${failure.message}; ` : ''}public-aw-inspection-lease-release-failed`,
        { cause: new AggregateError([failure, error].filter(Boolean)) });
      releaseFailure.publicAwProcessDiagnostics = failure?.publicAwProcessDiagnostics ?? [];
      if (failure?.publicAwProcessNames) releaseFailure.publicAwProcessNames = failure.publicAwProcessNames;
      if (failure?.publicAwMarkerRows) releaseFailure.publicAwMarkerRows = failure.publicAwMarkerRows;
      if (failure?.qualificationMarkerIdentityConfirmations) releaseFailure.qualificationMarkerIdentityConfirmations = failure.qualificationMarkerIdentityConfirmations;
      if (failure?.result ?? returned) releaseFailure.result = failure?.result ?? returned;
      releaseFailure.publicAwProcessFailure = { stage: 'inspection-lease-release', reason: 'inspection-lease-release-failed',
        processCleanup: failure?.publicAwProcessFailure?.processCleanup ?? (cleanupConfirmed ? 'confirmed' : 'unconfirmed') };
      failure = releaseFailure;
      throw releaseFailure;
    } finally {
      if (failure?.publicAwProcessFailure) failure.publicAwProcessFailure.leaseCleanup = leaseCleanup;
      try {
        const timings = queryTimings?.snapshot();
        if (timings) {
          if (returned) returned.processQueryTimings = timings;
          if (failure && typeof failure === 'object') failure.publicAwProcessQueryTimings = timings;
        }
      } catch { /* Query timing hints cannot change success, failure, or lease release. */ }
      queryTimings?.stop();
    }
  }
}
