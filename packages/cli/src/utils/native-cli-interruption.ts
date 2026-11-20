import { AsyncLocalStorage } from 'node:async_hooks';
import { writeSync } from 'node:fs';

interface NativeCliInterruption {
  signal: AbortSignal;
  track(): (cleanupFailed: boolean) => Promise<never> | undefined;
}

const scope = new AsyncLocalStorage<NativeCliInterruption>();

export function currentNativeCliInterruption(): NativeCliInterruption | undefined {
  return scope.getStore();
}

/** Give the executable's detached native groups time to clean up before default signal termination. */
export function withNativeCliInterruption<T>(run: () => T): T {
  if (process.platform === 'win32') return run();

  const controller = new AbortController();
  // An interrupted result must not drive another operation while its peers clean up.
  const waitForExit = new Promise<never>(() => {});
  let active = 0;
  let interruptedBy: 'SIGINT' | 'SIGTERM' | undefined;
  let cleanupFailed = false;

  const interrupt = (signal: 'SIGINT' | 'SIGTERM'): void => {
    // Existing command and host handlers own their signals.
    if (interruptedBy || process.listenerCount(signal) !== 1) return;
    interruptedBy = signal;
    controller.abort();
  };
  const sigint = (): void => interrupt('SIGINT');
  const sigterm = (): void => interrupt('SIGTERM');

  return scope.run({
    signal: controller.signal,
    track() {
      if (active++ === 0) {
        if (process.listenerCount('SIGINT') === 0) process.on('SIGINT', sigint);
        if (process.listenerCount('SIGTERM') === 0) process.on('SIGTERM', sigterm);
      }

      return (failed) => {
        if (interruptedBy) cleanupFailed ||= failed;
        if (--active !== 0) return interruptedBy ? waitForExit : undefined;
        process.off('SIGINT', sigint);
        process.off('SIGTERM', sigterm);
        if (!interruptedBy) return;

        if (cleanupFailed) {
          try {
            writeSync(process.stderr.fd, 'processCleanupUnconfirmed: Process cleanup could not be confirmed.\n');
          } finally {
            process.exit(1);
          }
        }

        // A Linux PID namespace's init ignores the signal's default disposition.
        if (process.pid !== 1 && process.listenerCount(interruptedBy) === 0) {
          try {
            process.kill(process.pid, interruptedBy);
            return waitForExit;
          } catch { /* Fall back to the shell's equivalent exit code. */ }
        }
        process.exit(interruptedBy === 'SIGINT' ? 130 : 143);
      };
    },
  }, run);
}
