import path from 'node:path';
import fs from 'fs-extra';
import { DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS } from '../constants.js';
import { createSafeNeutralCwd } from '../intent/scope-context.js';
import { createCodexConfigReadInput, observeCodexExactProjectTrust, parseCodexConfigReadOutput,
  type CodexProjectTrustObservation } from './codex-config-observation.js';
import { getCodexHome } from './state-paths.js';

import {
  buildCodexPluginListJsonInvocation,
  NativeCliError,
  parseCodexPluginListJson,
  runNativeCli,
  SYSTEM_CODEX_MANAGER,
  type CodexManager,
  type CodexPluginListEntry,
  type NativeCliRunner,
} from './native-cli.js';

export type CodexNativePluginObservation =
  | { state: 'observed'; value: 'installed'; entry: CodexPluginListEntry }
  | { state: 'observed'; value: 'absent' }
  | { state: 'unobserved' }
  | { state: 'failed'; reason: 'unavailable' | 'duplicate' };

export function observeCodexNativePlugin(
  pluginId: string,
  entries: readonly CodexPluginListEntry[],
): CodexNativePluginObservation {
  const matches = entries.filter((entry) => entry.pluginId === pluginId);
  if (matches.length > 1) return { state: 'failed', reason: 'duplicate' };
  const entry = matches[0];
  return entry
    ? { state: 'observed', value: 'installed', entry }
    : { state: 'observed', value: 'absent' };
}

export function combineCodexNativePluginObservations(
  observations: readonly CodexNativePluginObservation[],
): CodexNativePluginObservation {
  const failed = observations.find((observation) => observation.state === 'failed');
  if (failed?.state === 'failed') return failed;
  const installed = observations.find((observation) =>
    observation.state === 'observed' && observation.value === 'installed');
  if (installed?.state === 'observed' && installed.value === 'installed') return installed;
  if (observations.length > 0 && observations.every((observation) =>
    observation.state === 'observed' && observation.value === 'absent')) {
    return { state: 'observed', value: 'absent' };
  }
  return { state: 'unobserved' };
}

type CodexObservationScope = 'exact' | 'neutral';

interface CodexObservationEntries {
  entries?: ReadonlyMap<string, CodexPluginListEntry>;
  failure?: 'unavailable' | 'duplicate';
  unobserved?: true;
}

export interface CodexNativeObservationSnapshot {
  marketplace: string;
  generation: number;
  capturedAt: number;
  exact?: ReadonlyMap<string, CodexPluginListEntry>;
  neutral?: ReadonlyMap<string, CodexPluginListEntry>;
}

export interface CodexNativeObservationSession {
  /** Explicit status observation only. Ordinary plugin inspection never starts app-server. */
  inspectProjectTrust(projectRoot: string): Promise<CodexProjectTrustObservation>;
  inspectPlugin(options: {
    pluginId: string;
    scope?: 'user' | 'project' | 'both';
  }): Promise<{
    observation: CodexNativePluginObservation;
    observations: { user: boolean; project: boolean };
    activations: { user?: boolean; project?: boolean };
  }>;
  snapshot(marketplace: string, scope?: 'user' | 'project' | 'both'):
    Promise<CodexNativeObservationSnapshot>;
  setManager(manager: CodexManager | undefined): void;
  invalidate(marketplace?: string): void;
  dispose(): Promise<void>;
}

function parseNamespacedPluginId(pluginId: string): { marketplace: string } {
  const separator = pluginId.lastIndexOf('@');
  if (separator <= 0 || separator === pluginId.length - 1) {
    throw new Error('codexPluginIdInvalid: expected an exact namespaced plugin ID.');
  }
  return { marketplace: pluginId.slice(separator + 1) };
}

function indexCodexEntries(entries: readonly CodexPluginListEntry[]): CodexObservationEntries {
  const indexed = new Map<string, CodexPluginListEntry>();
  for (const entry of entries) {
    if (indexed.has(entry.pluginId)) return { failure: 'duplicate' };
    indexed.set(entry.pluginId, entry);
  }
  return { entries: indexed };
}

export async function createCodexNativeObservationSession(options: {
  exactCwd: string;
  env: NodeJS.ProcessEnv;
  runner?: NativeCliRunner;
  manager?: CodexManager;
}): Promise<CodexNativeObservationSession> {
  const neutral = await createSafeNeutralCwd(options.env);
  const neutralCwd = neutral.executionCwd;
  let manager: CodexManager | undefined = options.manager ?? SYSTEM_CODEX_MANAGER;
  const snapshots = new Map<string, Promise<CodexObservationEntries>>();
  const pendingReads = new Set<Promise<unknown>>();
  let projectTrust: Promise<CodexProjectTrustObservation> | undefined;
  let cleanupFailure: NativeCliError | undefined;
  let generation = 0;
  let disposal: Promise<void> | undefined;

  const read = (marketplace: string, scope: CodexObservationScope): Promise<CodexObservationEntries> => {
    const key = `${marketplace}\0${scope}`;
    let result = snapshots.get(key);
    if (!result) {
      result = (async () => {
        if (!options.runner || !manager) return { unobserved: true };
        try {
          const invocation = buildCodexPluginListJsonInvocation(
            manager,
            marketplace,
            scope === 'exact' ? options.exactCwd : neutralCwd,
            options.env,
          );
          const nativeResult = await runNativeCli(invocation, options.runner);
          if (nativeResult.exitCode !== 0) return { failure: 'unavailable' };
          return indexCodexEntries(parseCodexPluginListJson(nativeResult.stdout));
        } catch (error) {
          if (error instanceof NativeCliError && error.cleanupError) {
            cleanupFailure ??= error;
            throw error;
          }
          if (error instanceof Error && error.name === 'AbortError') throw error;
          return (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? { unobserved: true }
            : { failure: 'unavailable' };
        }
      })();
      snapshots.set(key, result);
      pendingReads.add(result);
      void result.then(() => pendingReads.delete(result!), () => pendingReads.delete(result!));
    }
    return result;
  };

  const requestedScopes = (scope: 'user' | 'project' | 'both'):
    CodexObservationScope[] => scope === 'user' ? ['neutral'] : ['exact', 'neutral'];

  return {
    async inspectProjectTrust(projectRoot) {
      if (disposal) throw new Error('codexObservationSessionDisposed');
      if (projectRoot !== options.exactCwd) return { state: 'unknown' };
      if (!projectTrust) {
        const selectedManager = manager;
        projectTrust = (async (): Promise<CodexProjectTrustObservation> => {
          if (!options.runner || selectedManager?.kind !== 'system' || selectedManager.version !== '0.167.0') {
            return { state: 'unknown' };
          }
          try {
            // Alternate spellings need Codex's full path loader. This reader
            // only accepts the already canonical exact project path.
            if (!path.isAbsolute(projectRoot) || await fs.realpath(projectRoot) !== projectRoot) return { state: 'unknown' };
            // This trust-only read must not start background plugin updates.
            // The overridden features are not evidence of the user's settings.
            const result = await runNativeCli({ command: selectedManager.command,
              args: [...selectedManager.argsPrefix, 'app-server', '--stdio', '-c', 'features.plugins=false'], agentKind: 'codex',
              cwd: projectRoot, env: options.env, timeoutMs: DEFAULT_AGENT_VERSION_PROBE_TIMEOUT_MS,
              input: createCodexConfigReadInput(projectRoot) }, options.runner);
            if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 1024 * 1024) {
              return { state: 'failed' };
            }
            return observeCodexExactProjectTrust(parseCodexConfigReadOutput(result.stdout), projectRoot, getCodexHome(options.env));
          } catch (error) {
            if (error instanceof NativeCliError && error.cleanupError) {
              cleanupFailure ??= error;
              throw error;
            }
            if (error instanceof Error && error.name === 'AbortError') throw error;
            return { state: 'failed' };
          }
        })();
        const pending = projectTrust;
        pendingReads.add(pending);
        void pending.then(() => pendingReads.delete(pending), () => pendingReads.delete(pending));
      }
      return projectTrust;
    },
    async snapshot(marketplace, scope = 'both') {
      if (disposal) throw new Error('codexObservationSessionDisposed');
      const capturedGeneration = generation;
      const scopes = requestedScopes(scope);
      const values = await Promise.all(scopes.map((entry) => read(marketplace, entry)));
      const byScope = new Map(scopes.map((entry, index) => [entry, values[index]!]));
      return {
        marketplace,
        generation: capturedGeneration,
        capturedAt: Date.now(),
        ...(byScope.get('exact')?.entries ? { exact: byScope.get('exact')!.entries } : {}),
        ...(byScope.get('neutral')?.entries ? { neutral: byScope.get('neutral')!.entries } : {}),
      };
    },
    async inspectPlugin({ pluginId, scope = 'both' }) {
      if (disposal) throw new Error('codexObservationSessionDisposed');
      const { marketplace } = parseNamespacedPluginId(pluginId);
      const scopes = requestedScopes(scope);
      const values = await Promise.all(scopes.map((entry) => read(marketplace, entry)));
      const byScope = new Map(scopes.map((entry, index) => [entry, values[index]!]));
      const observations = values.map((value): CodexNativePluginObservation => {
        if (value.failure) return { state: 'failed', reason: value.failure };
        if (value.unobserved || !value.entries) return { state: 'unobserved' };
        const entry = value.entries.get(pluginId);
        return entry
          ? { state: 'observed', value: 'installed', entry }
          : { state: 'observed', value: 'absent' };
      });
      return {
        observation: combineCodexNativePluginObservations(observations),
        observations: {
          user: byScope.get('neutral')?.entries !== undefined,
          project: byScope.get('exact')?.entries !== undefined,
        },
        activations: {
          ...(byScope.get('neutral')?.entries?.get(pluginId)
            ? { user: byScope.get('neutral')!.entries!.get(pluginId)!.enabled }
            : {}),
          ...(byScope.get('exact')?.entries?.get(pluginId)
            ? { project: byScope.get('exact')!.entries!.get(pluginId)!.enabled }
            : {}),
        },
      };
    },
    setManager(nextManager) {
      if (manager?.version !== nextManager?.version) projectTrust = undefined;
      if (manager?.kind === nextManager?.kind
        && manager?.command === nextManager?.command
        && manager?.argsPrefix.length === nextManager?.argsPrefix.length
        && manager?.argsPrefix.every((value, index) => value === nextManager?.argsPrefix[index])) {
        manager = nextManager;
        return;
      }
      manager = nextManager;
      generation += 1;
      snapshots.clear();
      projectTrust = undefined;
    },
    invalidate(marketplace) {
      generation += 1;
      projectTrust = undefined;
      if (!marketplace) {
        snapshots.clear();
        return;
      }
      for (const key of snapshots.keys()) {
        if (key.startsWith(`${marketplace}\0`)) snapshots.delete(key);
      }
    },
    dispose() {
      disposal ??= (async () => {
        await Promise.allSettled([...pendingReads]);
        try {
          await neutral.dispose();
        } finally {
          if (cleanupFailure) throw cleanupFailure;
        }
      })();
      return disposal;
    },
  };
}
