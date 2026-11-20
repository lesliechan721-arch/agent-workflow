import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { createSafeNeutralCwd } from '../intent/scope-context.js';
import { bindNativeCliRunnerSignal, getDefaultNativeCliRunner, runNativeCliChecked, type NativeCliRunner } from '../utils/native-cli.js';
import { installationInvocation, selectNativeProduct } from './discovery.js';
import type { DeploymentBinding, ReadContext } from './contracts.js';

export interface NativeQuerySession {
  userCwd(env: NodeJS.ProcessEnv): Promise<string>;
  read(key: string, ctx: ReadContext, action: () => Promise<string>): Promise<string>;
  dispose(): Promise<void>;
}

export interface NativeObservationBatch {
  /** The complete joint placement, including its peers, has no executable author scripts. */
  scriptFreePlacement?: true;
  discoveryCache: NonNullable<ReadContext['discoveryCache']>;
  nativeQuerySession: NativeQuerySession;
  runner: NativeCliRunner;
  signal?: AbortSignal;
}

/** The phase owner lends the same discovery and inventory caches to ordinary observations. */
export async function withNativeObservationBatch<T>(options: { runner?: NativeCliRunner; signal?: AbortSignal },
  action: (batch: NativeObservationBatch) => Promise<T>): Promise<T> {
  const discoveryCache: NativeObservationBatch['discoveryCache'] = new Map();
  const nativeQuerySession = createNativeQuerySession();
  const runner = bindNativeCliRunnerSignal(options.runner ?? getDefaultNativeCliRunner(), options.signal);
  try {
    return await action({ discoveryCache, nativeQuerySession, runner, signal: options.signal });
  } finally {
    await Promise.allSettled([...discoveryCache.values()].flatMap((entries) => entries.map((entry) => entry.result)));
    discoveryCache.clear();
    await nativeQuerySession.dispose();
  }
}

/** One read-only snapshot owns its neutral contexts and completed or failed inventories. */
export function createNativeQuerySession(): NativeQuerySession {
  const neutral = new Map<string, Promise<Awaited<ReturnType<typeof createSafeNeutralCwd>>>>();
  const reads = new Map<string, Array<{ runner: ReadContext['runner']; signal: ReadContext['signal']; result: Promise<string> }>>();
  let disposal: Promise<void> | undefined;
  const assertOpen = (): void => { if (disposal) throw new Error('nativeQuerySessionDisposed'); };
  return {
    async userCwd(env) {
      assertOpen();
      const key = JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
      let cwd = neutral.get(key);
      if (!cwd) { cwd = createSafeNeutralCwd(env); neutral.set(key, cwd); }
      return (await cwd).executionCwd;
    },
    async read(key, ctx, action) {
      assertOpen();
      ctx.signal?.throwIfAborted();
      let entries = reads.get(key);
      if (!entries) { entries = []; reads.set(key, entries); }
      let entry = entries.find((candidate) => candidate.runner === ctx.runner && candidate.signal === ctx.signal);
      if (!entry) { entry = { runner: ctx.runner, signal: ctx.signal, result: action() }; entries.push(entry); }
      const output = await entry.result;
      ctx.signal?.throwIfAborted();
      return output;
    },
    dispose() {
      disposal ??= (async () => {
        try {
          await Promise.allSettled([...reads.values()].flatMap((entries) => entries.map((entry) => entry.result)));
          const contexts = await Promise.allSettled(neutral.values());
          await Promise.all(contexts.map((context) => context.status === 'fulfilled' ? context.value.dispose() : undefined));
        } finally {
          reads.clear(); neutral.clear();
        }
      })();
      return disposal;
    },
  };
}

/** User queries exclude caller project configuration; project queries use the exact binding. */
export async function queryNativeDeployment(ctx: ReadContext, binding: DeploymentBinding,
  args: string[] | ((cwd: string) => string[])): Promise<string> {
  const product = selectNativeProduct(binding.consumers);
  if (!product) throw new Error('nativeEntryUnavailable');
  ctx.signal?.throwIfAborted();
  const session = ctx.nativeQuerySession;
  const neutral = binding.scope.kind === 'user' && !session ? await createSafeNeutralCwd(ctx.env ?? process.env) : undefined;
  try {
    const cwd = binding.scope.kind === 'project' ? binding.scope.projectRoot
      : session ? await session.userCwd(ctx.env ?? process.env) : neutral!.executionCwd;
    const queryArgs = typeof args === 'function' ? args(cwd) : args;
    const invocation = await installationInvocation(product, { ...ctx, cwd }, queryArgs);
    const read = async (): Promise<string> => {
      const output = await runNativeCliChecked({ ...invocation, signal: ctx.signal,
        timeoutMs: DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS }, ctx.runner);
      if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > 1024 * 1024) throw new Error('nativeObservationOutputLimit');
      return output.stdout;
    };
    if (!session) return await read();
    const key = JSON.stringify({ platform: binding.platform, route: binding.route, product: product.product,
      version: product.version, entry: product.entry, scope: binding.scope, cwd,
      command: invocation.command, args: invocation.args,
      env: Object.entries(invocation.env ?? process.env).sort(([a], [b]) => a.localeCompare(b)),
      host: ctx.platform ?? process.platform, arch: ctx.arch ?? process.arch, observeNative: ctx.observeNative === true });
    return await session.read(key, ctx, read);
  } finally {
    await neutral?.dispose();
  }
}
