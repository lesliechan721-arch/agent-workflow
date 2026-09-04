import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import {
  buildCodexPluginListJsonInvocation,
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
  setManager(manager: CodexManager): void;
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
  const neutralCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-observation-'));
  let manager = options.manager ?? SYSTEM_CODEX_MANAGER;
  const snapshots = new Map<string, Promise<CodexObservationEntries>>();
  let generation = 0;
  let disposed = false;

  const read = (marketplace: string, scope: CodexObservationScope): Promise<CodexObservationEntries> => {
    const key = `${generation}\0${marketplace}\0${scope}`;
    let result = snapshots.get(key);
    if (!result) {
      result = (async () => {
        if (!options.runner) return { unobserved: true };
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
          return (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? { unobserved: true }
            : { failure: 'unavailable' };
        }
      })();
      snapshots.set(key, result);
    }
    return result;
  };

  const requestedScopes = (scope: 'user' | 'project' | 'both'):
    CodexObservationScope[] => scope === 'user' ? ['neutral'] : ['exact', 'neutral'];

  return {
    async snapshot(marketplace, scope = 'both') {
      if (disposed) throw new Error('codexObservationSessionDisposed');
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
      if (disposed) throw new Error('codexObservationSessionDisposed');
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
      if (manager.kind === nextManager.kind
        && manager.command === nextManager.command
        && manager.runtimeRoot === nextManager.runtimeRoot
        && manager.argsPrefix.length === nextManager.argsPrefix.length
        && manager.argsPrefix.every((value, index) => value === nextManager.argsPrefix[index])) {
        manager = nextManager;
        return;
      }
      manager = nextManager;
      generation += 1;
      snapshots.clear();
    },
    invalidate(marketplace) {
      generation += 1;
      if (!marketplace) {
        snapshots.clear();
        return;
      }
      for (const key of snapshots.keys()) {
        if (key.split('\0')[1] === marketplace) snapshots.delete(key);
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await fs.remove(neutralCwd);
    },
  };
}
