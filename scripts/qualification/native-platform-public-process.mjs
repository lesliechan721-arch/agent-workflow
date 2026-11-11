import { execute } from './native-platform-runtime.mjs';

const MARKER_ENV = 'AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER';

// AW manages independent native-command groups. This is a compatibility
// observation, not a cooperative custom provider or OS containment guarantee.
export async function executePublicAw(launcher, args, options, processTree = {}) {
  if (process.platform === 'win32') return execute(launcher, args, options);
  const { runProviderProcess } = await import('../../packages/agent-skill-eval/dist/process.js');
  const { acquireProcessTreeInspectionLease, observeProcessTree, terminateProcessTree } =
    await import('../../packages/agent-skill-eval/dist/process-tree.js');
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('public-aw-cancelled');
  const dependencies = { ...processTree, markerEnvironmentVariable: MARKER_ENV,
    enforceProcessMarker: true, enforceCooperativeProcessGroup: false };
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  let lease;
  let observation;
  let stopFailureListener;
  let failure;
  try {
    lease = await acquireProcessTreeInspectionLease(dependencies);
    const result = await runProviderProcess({
      executable: launcher.executable, args: [...launcher.prefix, ...args], cwd: options.cwd,
      env: { ...options.env, [MARKER_ENV]: lease.marker }, signal: controller.signal,
      timeoutMs: options.timeoutMs ?? 60_000, maxBufferBytes: 2 * 1024 * 1024,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    }, {
      onSpawn({ pid }) {
        observation = observeProcessTree(pid, lease.marker, dependencies, lease);
        stopFailureListener = observation.onFailure((error) => controller.abort(error));
      },
      async terminateProcessTree({ pid }, reason) {
        if (!observation) throw new Error('public-aw-inspection-not-started');
        // The provider runner owns the ChildProcess handle and its fallback.
        // This hook signals only identities revalidated by the observation.
        await terminateProcessTree(pid, () => {}, dependencies, { observation, requireConfirmedCleanup: true,
          requireDescendantsExitedBeforeCompletion: reason === 'complete' });
        return { confirmed: true };
      },
    }, { containment: 'observed', processTree: dependencies });
    if (result.cancelled || result.terminationReason !== 'complete') {
      throw new Error(`public-aw-process-${result.terminationReason}`);
    }
    return { ...result, stdout: result.stdout.replaceAll(lease.marker, '<PUBLIC_AW_PROCESS_MARKER>'),
      stderr: result.stderr.replaceAll(lease.marker, '<PUBLIC_AW_PROCESS_MARKER>') };
  } catch (error) {
    failure = error;
    if (lease && error instanceof Error) error.message = error.message.replaceAll(lease.marker, '<PUBLIC_AW_PROCESS_MARKER>');
    if (error && typeof error === 'object') {
      const diagnostics = observation?.diagnostics ?? [];
      error.publicAwProcessDiagnostics = diagnostics.length > 1 ? [diagnostics[0], diagnostics.at(-1)] : diagnostics;
      if (lease && error.result) {
        error.result.stdout = error.result.stdout.replaceAll(lease.marker, '<PUBLIC_AW_PROCESS_MARKER>');
        error.result.stderr = error.result.stderr.replaceAll(lease.marker, '<PUBLIC_AW_PROCESS_MARKER>');
      }
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    stopFailureListener?.();
    observation?.dispose();
    try { await lease?.release(); }
    catch (error) {
      const releaseFailure = new Error(`${failure?.message ? `${failure.message}; ` : ''}public-aw-inspection-lease-release-failed`,
        { cause: new AggregateError([failure, error].filter(Boolean)) });
      releaseFailure.publicAwProcessDiagnostics = failure?.publicAwProcessDiagnostics ?? [];
      if (failure?.result) releaseFailure.result = failure.result;
      throw releaseFailure;
    }
  }
}
