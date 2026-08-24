import registryDocument from './plugin-authoring-capabilities.json' with { type: 'json' };

export interface PluginAuthoringCapabilityEntry {
  field: string;
  type: string;
  required: boolean | string;
  products?: string;
  profiles?: string;
  acceptedValues?: string | string[];
  requires?: string;
  conflicts?: string;
}

export interface PluginAuthoringCapabilitySurface {
  title: string;
  entries: PluginAuthoringCapabilityEntry[];
}

export interface PluginAuthoringCapabilityRegistry {
  schemaVersion: 1;
  verifiedSource: string;
  surfaces: Record<string, PluginAuthoringCapabilitySurface>;
}

export const PLUGIN_AUTHORING_CAPABILITIES = registryDocument as PluginAuthoringCapabilityRegistry;

export function getPluginAuthoringAcceptedValues(
  surface: string,
  field: string,
): readonly string[] {
  const entry = PLUGIN_AUTHORING_CAPABILITIES.surfaces[surface]?.entries
    .find((candidate) => candidate.field === field);
  if (!entry || !Array.isArray(entry.acceptedValues)) {
    throw new Error(`Plugin authoring capability ${surface}.${field} has no accepted values.`);
  }
  return entry.acceptedValues;
}
