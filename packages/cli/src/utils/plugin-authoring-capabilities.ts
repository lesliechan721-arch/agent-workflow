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
  verifiedSource?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePluginAuthoringCapabilityRegistry(
  document: unknown,
): PluginAuthoringCapabilityRegistry {
  if (!isRecord(document) || document.schemaVersion !== 1) {
    throw new Error('Invalid plugin authoring capability registry: expected schemaVersion 1.');
  }
  if (typeof document.verifiedSource !== 'string' || !isRecord(document.surfaces)) {
    throw new Error('Invalid plugin authoring capability registry: missing verifiedSource or surfaces.');
  }
  for (const [surfaceKey, surfaceValue] of Object.entries(document.surfaces)) {
    if (!isRecord(surfaceValue) || typeof surfaceValue.title !== 'string' || !Array.isArray(surfaceValue.entries)) {
      throw new Error(`Invalid plugin authoring capability registry surface ${JSON.stringify(surfaceKey)}.`);
    }
    for (const [index, entryValue] of surfaceValue.entries.entries()) {
      if (
        !isRecord(entryValue)
        || typeof entryValue.field !== 'string'
        || typeof entryValue.type !== 'string'
        || (typeof entryValue.required !== 'boolean' && typeof entryValue.required !== 'string')
        || (entryValue.verifiedSource !== undefined && typeof entryValue.verifiedSource !== 'string')
      ) {
        throw new Error(
          `Invalid plugin authoring capability registry entry ${JSON.stringify(surfaceKey)}[${index}].`,
        );
      }
    }
  }
  return document as unknown as PluginAuthoringCapabilityRegistry;
}

export const PLUGIN_AUTHORING_CAPABILITIES = parsePluginAuthoringCapabilityRegistry(registryDocument);

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
