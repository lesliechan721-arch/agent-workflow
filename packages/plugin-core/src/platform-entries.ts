import type { PlatformName } from './types.js';

export function applyPlatformOverride<
  T extends { agentOverrides?: { claude?: Partial<T> | null; codex?: Partial<T> | null } },
>(entry: T, platform: PlatformName): T | null {
  const override = entry.agentOverrides?.[platform];
  if (override === null) {
    return null;
  }

  if (!override) {
    return { ...entry, agentOverrides: undefined };
  }

  return {
    ...entry,
    ...override,
    agentOverrides: undefined,
  };
}

export function resolvePlatformEntries<
  T extends { agentOverrides?: { claude?: Partial<T> | null; codex?: Partial<T> | null } },
>(entries: T[] | undefined, platform: PlatformName): T[] {
  return (entries ?? [])
    .map((entry) => applyPlatformOverride(entry, platform))
    .filter((entry): entry is T => entry !== null);
}
