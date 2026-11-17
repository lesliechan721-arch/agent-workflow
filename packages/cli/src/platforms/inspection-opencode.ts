import path from 'node:path';

import type { DeploymentBinding, DeploymentObservation, ReadContext } from './contracts.js';
import { queryNativeDeployment } from './inspection-query.js';
import { getDeploymentResourceKey, type DeploymentLayout } from './layout.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('opencodeNativeResponseInvalid');
  return value as Record<string, unknown>;
}

function samePath(value: unknown, expected: string): boolean {
  return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === path.normalize(expected);
}

function diagnostic(result: DeploymentObservation, binding: DeploymentBinding, code: string, message: string): void {
  result.diagnostics.push({ code, severity: 'warning', message,
    subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind } });
}

/** V2.0.0 inventory contains active/failed server plugins; it has no disabled state. */
function nativeState(stdout: string, cwd: string, binding: DeploymentBinding,
  layout: DeploymentLayout): 'active' | 'failed' | 'unknown' {
  const response = object(JSON.parse(stdout));
  if (!samePath(object(response.location).directory, cwd)
    || !Array.isArray(response.data) || response.data.length > 4096) throw new Error('opencodeNativeLocationUnconfirmed');
  const id = getDeploymentResourceKey(binding.plugin);
  const sourceMatches = (source: Record<string, unknown>) => source.type === 'local'
    && (samePath(source.path, layout.packageRoot) || samePath(source.path, path.join(layout.packageRoot, 'index.mjs')));
  const matches = response.data.map(object).filter((row) => row.id === id || sourceMatches(object(row.source)));
  // A private service can return before asynchronous activation finishes. Absence does not prove disabled state.
  if (!matches.length) return 'unknown';
  if (matches.length !== 1) throw new Error('opencodeNativeIdentityDuplicate');
  const row = matches[0]!;
  const state = object(row.state);
  if (!sourceMatches(object(row.source)) || (row.id !== undefined && row.id !== id)
    || object(row.features).server !== true) throw new Error('opencodeNativeIdentityUnconfirmed');
  if (state.status === 'active' && row.id === id) return 'active';
  // Load failures can occur before the module exposes its ID. The exact local source still identifies the failure.
  if (state.status === 'failed' && typeof state.error === 'string') return 'failed';
  throw new Error('opencodeNativeStateUnconfirmed');
}

/** Explicit observation starts one scoped, loopback-only private service per supported CLI, without a model session. */
export async function inspectOpenCodeDeployment(ctx: ReadContext, binding: DeploymentBinding,
  layout: DeploymentLayout, result: DeploymentObservation): Promise<void> {
  result.registration = 'not-applicable';
  for (const consumer of result.consumers) {
    consumer.activation = 'unknown';
    consumer.trust = 'unknown';
    consumer.load = 'unknown';
  }
  if (!ctx.observeNative) {
    if (result.package === 'present') diagnostic(result, binding, 'opencodeNativeObservationRequired',
      'OpenCode activation and loading require explicit native observation. This can start a private local service.');
    return;
  }
  const products = binding.consumers.filter((product) => product.product === 'cli' && product.entry?.kind === 'cli'
    && product.availability === 'available' && product.version === '2.0.0');
  if (!products.length) {
    diagnostic(result, binding, 'opencodeNativeVersionUnverified',
      'Native observation requires an available OpenCode 2.0.0 CLI. Other client state remains unknown.');
    return;
  }
  const env = { ...(ctx.env ?? process.env), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    ...(binding.scope.kind === 'user' ? { OPENCODE_CONFIG_PROJECT_DISABLE: '1' } : {}) };
  for (const product of products) {
    try {
      let cwd = '';
      const stdout = await queryNativeDeployment({ ...ctx, env }, { ...binding, consumers: [product] }, (queryCwd) => {
        cwd = queryCwd;
        const query = new URLSearchParams({ 'location[directory]': queryCwd });
        // --standalone bypasses managed service discovery and its version/remote reuse.
        // The CLI owns the child's stdin lease and closes its scoped process on command completion.
        return ['api', 'GET', `/api/plugin?${query}`, '--standalone'];
      });
      const state = nativeState(stdout, cwd, binding, layout);
      const consumer = result.consumers.find((candidate) => candidate.productId === product.id);
      if (consumer && state === 'active') {
        consumer.activation = 'enabled';
        consumer.load = 'observed';
      } else if (state === 'failed') {
        if (consumer) consumer.load = 'not-observed';
        diagnostic(result, binding, 'opencodePluginLoadFailed',
          'OpenCode reported a plugin load failure. Check the client diagnostics before retrying native observation.');
      } else {
        diagnostic(result, binding, 'opencodeNativeActivationPending',
          'The private OpenCode service did not confirm this plugin. Retry native observation after checking client startup and configuration.');
      }
    } catch (error) {
      rethrowFatalError(error);
      ctx.signal?.throwIfAborted();
      diagnostic(result, binding, 'opencodeNativeObservationFailed',
        'OpenCode native state could not be read. Check the exact client and plugin source, then retry native observation.');
    }
  }
}
