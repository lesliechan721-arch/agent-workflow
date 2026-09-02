import type { CodexPluginListEntry } from './native-cli.js';

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
