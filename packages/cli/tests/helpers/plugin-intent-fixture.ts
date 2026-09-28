import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { createEmptyIntent, type PluginIntent } from '../../src/intent/intent-codec.js';
import { observeIntent, writeIntent, type IntentLocation } from '../../src/intent/intent-store.js';
import {
  createEmptyPreferences,
  observePreferences,
  writePreferences,
  type AgentId,
} from '../../src/intent/deployment-preferences.js';
import type { DependencyScopeOverride } from '../../src/types.js';

// Tests can specify target Agents beside roots, but the files always use the v3 contract.
export interface FixtureIntentState {
  schemaVersion?: number;
  kind?: string;
  sources?: PluginIntent['sources'];
  roots: Array<{ pluginId: string; platforms?: readonly string[] }>;
  agents?: readonly AgentId[];
  dependencyScopeOverrides?: DependencyScopeOverride[];
  managed?: unknown;
}

const toAgent = (platform: string): AgentId =>
  platform === 'claude' ? 'claude-code' : platform as AgentId;

export async function writeIntentFixture(location: IntentLocation, state: FixtureIntentState) {
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
  const agents = [...new Set(state.agents ?? state.roots.flatMap((root) =>
    (root.platforms ?? []).map(toAgent)))];
  const written = await writeIntent(location, intent);
  await writePreferences(location, {
    ...createEmptyPreferences(),
    agents,
    dependencyScopeOverrides: state.dependencyScopeOverrides ?? [],
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
  const agents = preferences.state === 'valid' ? preferences.value.agents : [];
  return {
    ...value,
    roots: value.roots.map((root) => ({ ...root,
      platforms: agents.map((agent) => agent === 'claude-code' ? 'claude' : agent),
    })),
    dependencyScopeOverrides: preferences.state === 'valid'
      ? preferences.value.dependencyScopeOverrides : [],
  };
}
