import type { PlatformTarget } from './types.js';

export function applyPlatformOverride<
  T extends { agentOverrides?: Partial<Record<PlatformTarget, Partial<T> | null>> },
>(entry: T, platform: PlatformTarget): T | null {
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
  T extends { agentOverrides?: Partial<Record<PlatformTarget, Partial<T> | null>> },
>(entries: T[] | undefined, platform: PlatformTarget): T[] {
  return (entries ?? [])
    .map((entry) => applyPlatformOverride(entry, platform))
    .filter((entry): entry is T => entry !== null);
}
