/** One CLI invocation's cancellation state. It never persists across commands. */
export interface PublicCommandInterruption {
  signal: AbortSignal;
  exitCode?: 130 | 143;
  cleanupFailed: boolean;
}

export function createPublicCommandInterruption(): PublicCommandInterruption & { listen(): () => void } {
  const controller = new AbortController();
  const state: PublicCommandInterruption = { signal: controller.signal, cleanupFailed: false };
  const interrupt = (code: 130 | 143): void => {
    if (controller.signal.aborted) return;
    state.exitCode = code;
    controller.abort(Object.assign(new Error('The command was interrupted.'), { name: 'AbortError', code: 'operationInterrupted' }));
  };
  return Object.assign(state, {
    listen() {
      const sigint = (): void => interrupt(130);
      const sigterm = (): void => interrupt(143);
      process.on('SIGINT', sigint);
      process.on('SIGTERM', sigterm);
      return () => {
        process.removeListener('SIGINT', sigint);
        process.removeListener('SIGTERM', sigterm);
      };
    },
  });
}
