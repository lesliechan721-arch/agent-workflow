import type { DeploymentBinding, ReadContext } from '../../src/platforms/contracts.js';
import type { NativeExecutionInput } from '../../src/commands/rebuild-command.js';
import { observePreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import type { PlatformName, Scope } from '../../src/types.js';
import path from 'node:path';
import fs from 'fs-extra';
import { onTestFinished, vi } from 'vitest';
import { getPlatformHookHandlerRegistry, getPlatformFeatureRegistry, NATIVE_PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core/manifest';
import * as capabilities from '../../src/platforms/capabilities.js';
import * as registry from '../../src/platforms/registry.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';

/** Uses production namespace and activation rules; pass real source evidence for ownership assertions. */
export async function getNativeTestLayout(options: {
  platform: PlatformName; sourceId?: string; pluginId: string; sourceIdentity?: string;
  cwd: string; env: NodeJS.ProcessEnv; scope?: Scope; version?: string;
}) {
  const ctx = { cwd: options.cwd, env: options.env };
  const resolution = await resolveDeployments(ctx, {
    plugin: { sourceId: options.sourceId ?? options.pluginId.split('/')[0]!, pluginId: options.pluginId,
      sourceIdentity: options.sourceIdentity ?? `sha256:${'0'.repeat(64)}`, version: options.version ?? '1.0.0' },
    scope: options.scope === 'user' ? { kind: 'user' } : { kind: 'project', projectRoot: options.cwd },
    operation: 'ensure', recoveryCandidates: [], discovery: { platform: options.platform, availability: 'available',
      diagnostics: [], installations: [{ id: `controlled:${options.platform}`, product: 'cli', version: null,
        availability: 'available', reasonCodes: [], entry: { kind: 'cli', executable: options.platform,
          configRoot: resolvePlatformConfigRoot(options.platform, ctx) } }] },
  });
  const binding = resolution.bindings[0];
  if (!binding) throw new Error('Native test layout could not be resolved.');
  return { ...await getDeploymentLayout(ctx, binding), binding };
}

const realProfile = capabilities.getQualifiedPlatformProfile;
const realAdapters = new Map(registry.getAgentPluginAdapters().map((adapter) => [adapter.platform, adapter]));

/** Explicit orchestration facts, never evidence of qualification for a real client. */
export function installNativeTestQualification(options: {
  platforms?: readonly PlatformName[];
  discovery?: boolean;
  trust?: boolean;
} = {}): { restore(): void } {
  const platforms = new Set(options.platforms ?? NATIVE_PLATFORM_TARGETS);
  const profile = vi.spyOn(capabilities, 'getQualifiedPlatformProfile').mockImplementation((platform, host) => {
    const result = structuredClone(realProfile(platform, host));
    if (!platforms.has(platform as PlatformName)) return result;
    delete result.qualifiedConsumers;
    delete result.qualificationEvidence;
    result.id = `test-qualified:${result.id}`;
    const handlers = getPlatformHookHandlerRegistry()[platform];
    for (const kind of Object.values(result.kinds)) { kind.status = 'supported'; kind.reasonCodes = []; }
    for (const [id, feature] of Object.entries(getPlatformFeatureRegistry())) {
      if (feature.derivedFromKind) continue;
      const hookFeature = id.startsWith('hook.');
      const event = id.slice(id.indexOf('.', 5) + 1);
      const hook = id.startsWith('hook.native.') ? handlers.native[event] : handlers.common[event as keyof typeof handlers.common];
      const unsupported = hookFeature && !hook?.protocol;
      result.features[id] = { status: unsupported ? 'unsupported' : 'supported', reasonCodes: unsupported ? ['interface-unsupported'] : [],
        ...(feature.values ? { values: hookFeature ? feature.values.filter((value) => hook?.protocol && Object.hasOwn(hook.protocol.responses, value)) : [...feature.values] } : {}) };
    }
    return result;
  });
  const adapters = options.discovery || options.trust ? vi.spyOn(registry, 'getAgentPluginAdapter').mockImplementation((platform) => {
    const adapter = realAdapters.get(platform)!;
    if (!platforms.has(platform as PlatformName)) return adapter;
    return { ...adapter,
      ...(options.discovery ? { async discover(ctx: ReadContext) {
        const versions: Record<PlatformName, string> = { codex: '0.167.0', claude: '2.1.292', cursor: '2026.11.05-86047df',
          antigravity: '1.3.4', opencode: '2.2.6', pi: '1.5.0', gemini: '0.63.0', copilot: '1.0.95', grok: '1.0.77' };
        return { platform, availability: 'available' as const, diagnostics: [], installations: [{
          id: `controlled:${platform}`, product: 'cli' as const, version: versions[platform as PlatformName],
          availability: 'available' as const, reasonCodes: [], entry: { kind: 'cli' as const,
            executable: platform, configRoot: resolvePlatformConfigRoot(platform, ctx) },
        }] };
      } } : {}),
      ...(options.trust ? { async inspect(ctx: ReadContext, binding: DeploymentBinding) {
        const observation = await adapter.inspect(ctx, binding);
        for (const consumer of observation.consumers) { consumer.trust = 'trusted'; consumer.load = 'not-observed'; }
        return observation;
      } } : {}),
    };
  }) : undefined;
  const restore = () => { adapters?.mockRestore(); profile.mockRestore(); };
  onTestFinished(restore);
  return { restore };
}

export async function createNativeTestExecution(options: {
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  selectedTargets: readonly { pluginId: string; platform: PlatformName }[];
  includeSelectedInDemand?: boolean;
}): Promise<{ executionInput: NativeExecutionInput; dispose(): Promise<void> }> {
  if (options.scope === 'project' && !await fs.pathExists(path.join(options.cwd, '.git'))
    && !await fs.pathExists(path.join(options.cwd, 'pnpm-workspace.yaml'))) {
    await fs.ensureDir(path.join(options.cwd, '.git'));
  }
  const location = { scope: options.scope, cwd: options.cwd, env: options.env };
  const [intent, preferences] = await Promise.all([
    observeIntent(location), observePreferences(location),
  ]);
  if (intent.state !== 'absent' && intent.state !== 'valid') {
    throw new Error(`Invalid test Intent: ${intent.state}`);
  }
  if (preferences.state !== 'absent' && preferences.state !== 'valid') {
    throw new Error(`Invalid test preferences: ${preferences.state}`);
  }
  const context = await createScopeContext(location);
  const roots = intent.state === 'valid'
    ? intent.value.roots.map((root) => ({ pluginId: root.pluginId,
      platforms: preferences.state === 'valid'
        ? preferences.value.targets.filter((target): target is PlatformName => target !== 'generic')
        : [...new Set(options.selectedTargets.map((target) => target.platform))] })) : [];
  if (options.includeSelectedInDemand) {
    for (const selected of options.selectedTargets) {
      if (!roots.some((root) => root.pluginId === selected.pluginId)) {
        roots.push({ pluginId: selected.pluginId, platforms: [selected.platform] });
      }
    }
  }
  return {
    executionInput: {
      context,
      requirements: {
        roots,
        dependencyScopeOverrides: [],
      },
      selectedTargets: options.selectedTargets.map((target) => ({ ...target, scope: options.scope })),
      preserveOtherObservedTargets: true,
    },
    dispose: context.dispose,
  };
}
