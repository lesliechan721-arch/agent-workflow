import type { ReadContext } from '../../src/platforms/contracts.js';
import type { NativeExecutionInput } from '../../src/commands/rebuild-command.js';
import { observePreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import type { PlatformName, Scope } from '../../src/types.js';
import path from 'node:path';
import fs from 'fs-extra';
import { onTestFinished, vi } from 'vitest';
import { NATIVE_PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core/manifest';
import * as registry from '../../src/platforms/registry.js';
import * as codexExecutableDiscovery from '../../src/utils/codex-executable-discovery.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';

/** Keep real executable discovery while observing App queries outside the native mutation runner. */
export function isolateCodexAppDiscoveryQueries() {
  const discover = codexExecutableDiscovery.discoverCodexExecutables;
  const queryRunner = vi.fn(async (_invocation: NativeCliInvocation) => ({
    exitCode: 0, stdout: '[]', stderr: '',
  }));
  const discovery = vi.spyOn(codexExecutableDiscovery, 'discoverCodexExecutables').mockImplementation((options) =>
    discover({ ...options, queryRunner }));
  onTestFinished(() => discovery.mockRestore());
  return queryRunner;
}

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

const realAdapters = new Map(registry.getAgentPluginAdapters().map((adapter) => [adapter.platform, adapter]));

/** Provide controlled client installations while using the production platform capabilities. */
export function installNativeTestDiscovery(options: {
  platforms?: readonly PlatformName[];
  executable?: string;
} = {}): { restore(): void } {
  const platforms = new Set(options.platforms ?? NATIVE_PLATFORM_TARGETS);
  const adapters = vi.spyOn(registry, 'getAgentPluginAdapter').mockImplementation((platform) => {
    const adapter = realAdapters.get(platform)!;
    if (!platforms.has(platform as PlatformName)) return adapter;
    return { ...adapter,
      async discover(ctx: ReadContext) {
        const versions: Record<PlatformName, string> = { codex: '0.167.0', claude: '2.1.292', cursor: '2026.11.05-86047df',
          antigravity: '1.3.4', opencode: '2.2.6', pi: '1.5.0', copilot: '1.0.95', grok: '1.0.77' };
        return { platform, availability: 'available' as const, diagnostics: [], installations: [{
          id: `controlled:${platform}`, product: 'cli' as const, version: versions[platform as PlatformName],
          availability: 'available' as const, reasonCodes: [], entry: { kind: 'cli' as const,
            executable: options.executable ?? platform, configRoot: resolvePlatformConfigRoot(platform, ctx) },
        }] };
      },
    };
  });
  const restore = () => adapters.mockRestore();
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
