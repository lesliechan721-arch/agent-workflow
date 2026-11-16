import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { createSafeNeutralCwd } from '../intent/scope-context.js';
import { runNativeCliChecked } from '../utils/native-cli.js';
import { installationInvocation } from './discovery.js';
import type { DeploymentBinding, ReadContext } from './contracts.js';

/** User queries exclude caller project configuration; project queries use the exact binding. */
export async function queryNativeDeployment(ctx: ReadContext, binding: DeploymentBinding,
  args: string[] | ((cwd: string) => string[])): Promise<string> {
  const product = binding.consumers.find((item) => item.entry?.kind === 'cli' && item.availability === 'available');
  if (!product) throw new Error('nativeEntryUnavailable');
  const neutral = binding.scope.kind === 'user' ? await createSafeNeutralCwd(ctx.env ?? process.env) : undefined;
  try {
    const cwd = binding.scope.kind === 'project' ? binding.scope.projectRoot : neutral!.executionCwd;
    const invocation = await installationInvocation(product, { ...ctx, cwd }, typeof args === 'function' ? args(cwd) : args);
    const output = await runNativeCliChecked({ ...invocation, signal: ctx.signal,
      timeoutMs: DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS }, ctx.runner);
    if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > 1024 * 1024) throw new Error('nativeObservationOutputLimit');
    return output.stdout;
  } finally {
    await neutral?.dispose();
  }
}
