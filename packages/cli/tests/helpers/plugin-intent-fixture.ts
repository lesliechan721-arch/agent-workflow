import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { createEmptyIntent, type PluginIntent } from '../../src/intent/intent-codec.js';
import { observeIntent, writeIntent, type IntentLocation } from '../../src/intent/intent-store.js';
import {
  createEmptyPreferences,
  observePreferences,
  normalizeAgents,
  writePreferences,
  type AgentId,
  type DeploymentExclusion,
} from '../../src/intent/deployment-preferences.js';

// Root platform lists are fixture shorthand for one machine policy. They never
// create per-scope preferences or dependency placement overrides.
export interface FixtureIntentState {
  schemaVersion?: number;
  kind?: string;
  sources?: PluginIntent['sources'];
  roots: Array<{ pluginId: string; platforms?: readonly string[] }>;
  targets?: readonly AgentId[];
  exclusions?: readonly DeploymentExclusion[];
  agents?: readonly string[];
  dependencyScopeOverrides?: readonly unknown[];
  managed?: unknown;
}

const toAgent = (platform: string): AgentId =>
  normalizeAgents([platform === 'claude-code' ? 'claude' : platform])[0]!;

export async function writeIntentFixture(location: IntentLocation, state: FixtureIntentState) {
  if (state.dependencyScopeOverrides?.length) {
    throw new Error('Fixture dependencyScopeOverrides was removed. Declare user and project roots to test automatic placement.');
  }
  const observed = await observePreferences(location);
  if (observed.state === 'invalid' || observed.state === 'unreadable') {
    throw new Error(`Invalid fixture preferences: ${observed.state}`);
  }
  const current = observed.state === 'valid' ? observed.value : createEmptyPreferences();
  const requested = state.targets ?? state.agents?.map(toAgent);
  const targets = normalizeAgents(requested ?? [...current.targets, ...state.roots.flatMap((root) =>
    (root.platforms ?? []).map(toAgent))]);
  const selectedRoots = new Set(state.roots.filter((root) => root.platforms !== undefined).map((root) => root.pluginId));
  const exclusions = state.exclusions ?? [
    ...current.exclusions.filter((entry) => !selectedRoots.has(entry.plugin)),
    ...state.roots.flatMap((root) => root.platforms === undefined ? [] : targets
      .filter((target) => !root.platforms!.map(toAgent).includes(target))
      .map((target) => ({ plugin: root.pluginId, target }))),
  ];
  const generations = await readCatalogGenerationState(location.env);
  const sources = Object.fromEntries(state.roots.map(({ pluginId }) => {
    const sourceId = pluginId.split('/')[0]!;
    return [sourceId, state.sources?.[sourceId] ?? {
      logicalIdentity: generations.sources[sourceId]?.active?.logicalIdentity ?? `fixture-${sourceId}`,
    }];
  }));
  const intent = {
    ...createEmptyIntent(),
    sources,
    roots: state.roots.map(({ pluginId }) => ({ pluginId })),
  };
  const written = await writeIntent(location, intent);
  await writePreferences(location, {
    ...createEmptyPreferences(),
    targets,
    exclusions: [...exclusions],
  });
  return written.value;
}

export async function readIntentFixture(location: IntentLocation): Promise<FixtureIntentState> {
  const intent = await observeIntent(location);
  if (intent.state === 'invalid' || intent.state === 'unreadable'
    || intent.state === 'unsupported-version') {
    throw new Error(`Invalid fixture intent: ${intent.state}`);
  }
  const preferences = await observePreferences(location);
  if (preferences.state === 'invalid' || preferences.state === 'unreadable') {
    throw new Error(`Invalid fixture preferences: ${preferences.state}`);
  }
  const value = intent.state === 'valid' ? intent.value : createEmptyIntent();
  const policy = preferences.state === 'valid' ? preferences.value : createEmptyPreferences();
  return {
    ...value,
    roots: value.roots.map((root) => ({ ...root,
      platforms: policy.targets.filter((target) => !policy.exclusions.some((entry) =>
        entry.plugin === root.pluginId && entry.target === target)),
    })),
    dependencyScopeOverrides: [],
  };
}
