import crypto from 'node:crypto';

import { parsePluginId } from '../utils/multi-source-catalog.js';

export interface PluginIntent {
  schemaVersion: 3;
  kind: 'aw-plugin-intents';
  sources: Record<string, { logicalIdentity: string }>;
  roots: Array<{ pluginId: string }>;
}

export const INTENT_SCHEMA_VERSION = 3;
export const INTENT_KIND = 'aw-plugin-intents';

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).length !== expected.length
    || Object.keys(value).some((key) => !expected.includes(key))) {
    throw new Error(`Invalid ${label} fields.`);
  }
}

export function canonicalPluginId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid plugin ID.');
  const parsed = parsePluginId(value);
  if (!parsed.sourceId) throw new Error('Invalid plugin ID: source required.');
  return `${parsed.sourceId}/${parsed.pluginName}`;
}

function canonicalSources(value: unknown): PluginIntent['sources'] {
  if (!isRecord(value)) throw new Error('Invalid intent sources.');
  const result: PluginIntent['sources'] = {};
  for (const sourceId of Object.keys(value).sort(compareText)) {
    const parsed = parsePluginId(`${sourceId}/placeholder`);
    if (parsed.sourceId !== sourceId) throw new Error('Invalid intent source ID.');
    const binding = value[sourceId];
    if (!isRecord(binding)) throw new Error('Invalid intent source binding.');
    assertKeys(binding, ['logicalIdentity'], 'intent source binding');
    if (typeof binding.logicalIdentity !== 'string'
      || binding.logicalIdentity.trim() === ''
      || binding.logicalIdentity !== binding.logicalIdentity.trim()) {
      throw new Error('Invalid intent source logical identity.');
    }
    result[sourceId] = { logicalIdentity: binding.logicalIdentity };
  }
  return result;
}

export function createEmptyIntent(): PluginIntent {
  return { schemaVersion: INTENT_SCHEMA_VERSION, kind: INTENT_KIND, sources: {}, roots: [] };
}

export function parseIntent(value: unknown): PluginIntent {
  if (!isRecord(value)) throw new Error('Invalid plugin intent.');
  assertKeys(value, ['schemaVersion', 'kind', 'sources', 'roots'], 'plugin intent');
  if (value.schemaVersion !== INTENT_SCHEMA_VERSION || value.kind !== INTENT_KIND) {
    throw new Error('Invalid plugin intent version or kind.');
  }
  const sources = canonicalSources(value.sources);
  if (!Array.isArray(value.roots)) throw new Error('Invalid intent roots.');
  const roots = value.roots.map((root) => {
    if (!isRecord(root)) throw new Error('Invalid intent root.');
    assertKeys(root, ['pluginId'], 'intent root');
    return { pluginId: canonicalPluginId(root.pluginId) };
  });
  const ids = roots.map((root) => root.pluginId);
  if (new Set(ids).size !== ids.length) throw new Error('Invalid intent roots: duplicate plugin ID.');
  for (const root of roots) {
    if (!sources[root.pluginId.split('/')[0]!]) {
      throw new Error('Invalid intent roots: source binding missing.');
    }
  }
  return {
    schemaVersion: INTENT_SCHEMA_VERSION,
    kind: INTENT_KIND,
    sources,
    roots: roots.sort((a, b) => compareText(a.pluginId, b.pluginId)),
  };
}

export function serializeIntent(value: PluginIntent): string {
  return `${JSON.stringify(parseIntent(value), null, 2)}\n`;
}

export function calculateIntentDigest(value: PluginIntent): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(parseIntent(value))).digest('hex')}`;
}

export function addIntentRoot(value: PluginIntent, pluginId: string, logicalIdentity: string): PluginIntent {
  const current = parseIntent(value);
  const canonicalId = canonicalPluginId(pluginId);
  const sourceId = canonicalId.split('/')[0]!;
  if (typeof logicalIdentity !== 'string' || logicalIdentity.trim() !== logicalIdentity
    || logicalIdentity === '') throw new Error('Invalid source logical identity.');
  const existing = current.sources[sourceId];
  if (existing && existing.logicalIdentity !== logicalIdentity) {
    throw new Error('sourceIdentityConflict: source alias has another logical identity.');
  }
  if (current.roots.some((root) => root.pluginId === canonicalId)) return current;
  return parseIntent({
    ...current,
    sources: { ...current.sources, [sourceId]: { logicalIdentity } },
    roots: [...current.roots, { pluginId: canonicalId }],
  });
}

export function removeIntentRoot(value: PluginIntent, pluginId: string): PluginIntent {
  const current = parseIntent(value);
  const canonicalId = canonicalPluginId(pluginId);
  const roots = current.roots.filter((root) => root.pluginId !== canonicalId);
  if (roots.length === current.roots.length) return current;
  const removedSource = canonicalId.split('/')[0]!;
  const sourceStillUsed = roots.some((root) => root.pluginId.split('/')[0] === removedSource);
  return parseIntent({
    ...current,
    sources: Object.fromEntries(Object.entries(current.sources).filter(([id]) =>
      id !== removedSource || sourceStillUsed)),
    roots,
  });
}
