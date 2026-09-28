import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import {
  canonicalizePluginIntentState,
  createEmptyPluginIntentState,
  readPluginIntentState,
  writePluginIntentState,
  type PluginIntentState,
  type PluginIntentStateLocation,
} from '../../src/utils/plugin-intent-state.js';
import { observeProjectIntent, writeProjectIntent } from '../../src/project/project-state.js';
import { observeProjectPreferences, writeProjectPreferences } from '../../src/project/project-preferences.js';

/** Build current declarations and local preferences for shared Native test scenarios. */
export async function writeIntentFixture(location: PluginIntentStateLocation, state: PluginIntentState) {
  if (location.scope === 'user') return writePluginIntentState(location, state);
  const generations = await readCatalogGenerationState(location.env);
  const sources = Object.fromEntries(state.roots.map(({ pluginId }) => {
    const sourceId = pluginId.split('/')[0]!;
    return [sourceId, { logicalIdentity: generations.sources[sourceId]?.active?.logicalIdentity ?? `fixture-${sourceId}` }];
  }));
  await writeProjectIntent(location, {
    schemaVersion: 3, kind: 'aw-plugin-intents', sources,
    roots: state.roots.map(({ pluginId }) => ({ pluginId })),
  });
  await writeProjectPreferences(location, {
    schemaVersion: 1, kind: 'aw-project-preferences',
    agents: state.roots.flatMap((root) => root.platforms.map((platform) =>
      platform === 'claude' ? 'claude-code' as const : 'codex' as const)),
    dependencyScopeOverrides: state.dependencyScopeOverrides,
  });
  return canonicalizePluginIntentState(state);
}

export async function readIntentFixture(location: PluginIntentStateLocation): Promise<PluginIntentState> {
  if (location.scope === 'user') return readPluginIntentState(location);
  const intent = await observeProjectIntent(location);
  if (intent.state === 'absent') return createEmptyPluginIntentState();
  if (intent.state !== 'valid') throw new Error(`Invalid project fixture: ${intent.state}`);
  const preferences = await observeProjectPreferences(location);
  const agents = preferences.state === 'valid' ? preferences.value.agents : [];
  return canonicalizePluginIntentState({
    ...createEmptyPluginIntentState(),
    roots: intent.value.roots.map((root) => ({ ...root,
      platforms: agents.flatMap((agent) => agent === 'codex' ? ['codex' as const]
        : agent === 'claude-code' ? ['claude' as const] : []),
    })),
    dependencyScopeOverrides: preferences.state === 'valid' ? preferences.value.dependencyScopeOverrides : [],
  });
}
