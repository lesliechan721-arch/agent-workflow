import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { createSafeNeutralCwd } from '../intent/scope-context.js';
import { runNativeCliChecked, type NativeCliResult } from '../utils/native-cli.js';
import { installationInvocation, npmCliEntryIdentity } from './discovery.js';
import type { DeploymentBinding, ReadContext } from './contracts.js';

/** User queries exclude caller project configuration; project queries use the exact binding. */
export async function queryNativeDeploymentResult(ctx: ReadContext, binding: DeploymentBinding,
  args: string[] | ((cwd: string) => string[])): Promise<NativeCliResult> {
  const product = binding.consumers.find((item) => item.entry?.kind === 'cli' && item.availability === 'available');
  if (!product) throw new Error('nativeEntryUnavailable');
  const neutral = binding.scope.kind === 'user' ? await createSafeNeutralCwd(ctx.env ?? process.env) : undefined;
  try {
    const cwd = binding.scope.kind === 'project' ? binding.scope.projectRoot : neutral!.executionCwd;
    const queryArgs = typeof args === 'function' ? args(cwd) : args;
    const invocation = await installationInvocation(product, { ...ctx, cwd }, queryArgs);
    // Fixed Gemini 0.67.0 otherwise loads this read-only command twice. Keep
    // the bootstrap override local to its verified entry and exact inventory.
    const directGeminiList = binding.platform === 'gemini' && product.version === '0.67.0'
      && queryArgs.length === 4 && queryArgs[0] === 'extensions' && queryArgs[1] === 'list'
      && queryArgs[2] === '--output-format' && queryArgs[3] === 'json'
      && await npmCliEntryIdentity(ctx, invocation, 'gemini', '0.67.0', 'bundle/gemini.js');
    const queryInvocation = directGeminiList
      ? { ...invocation, env: { ...(invocation.env ?? process.env), GEMINI_CLI_NO_RELAUNCH: 'true' } } : invocation;
    const output = await runNativeCliChecked({ ...queryInvocation, signal: ctx.signal,
      timeoutMs: DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS }, ctx.runner);
    if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > 1024 * 1024) throw new Error('nativeObservationOutputLimit');
    return output;
  } finally {
    await neutral?.dispose();
  }
}

export async function queryNativeDeployment(ctx: ReadContext, binding: DeploymentBinding,
  args: string[] | ((cwd: string) => string[])): Promise<string> {
  return (await queryNativeDeploymentResult(ctx, binding, args)).stdout;
}
