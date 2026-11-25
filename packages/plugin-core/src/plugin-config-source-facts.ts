import type { PluginConfigObjectSuggestionsDeclaration, PluginConfigSuggestionsDeclaration } from './types.js'

interface ConfigSourceFacts {
  hasRefOverride: boolean
  hasClearsOnChange: boolean
  definitionSuggestions: Array<PluginConfigSuggestionsDeclaration | PluginConfigObjectSuggestionsDeclaration>
}

// Source-only facts are lost when definitions and references expand. A WeakMap keeps
// them available during manifest revalidation without adding keys to bundle JSON.
const sourceFacts = new WeakMap<object, ConfigSourceFacts>()

export function getConfigSourceFacts(definition: object): ConfigSourceFacts | undefined {
  return sourceFacts.get(definition)
}

export function setConfigSourceFacts(definition: object, facts: ConfigSourceFacts): void {
  sourceFacts.set(definition, facts)
}

export function scanConfigSource(input: Record<string, unknown>): ConfigSourceFacts {
  const previous = sourceFacts.get(input)
  const facts: ConfigSourceFacts = {
    hasRefOverride: previous?.hasRefOverride ?? false,
    hasClearsOnChange: previous?.hasClearsOnChange ?? false,
    definitionSuggestions: [...(previous?.definitionSuggestions ?? [])],
  }
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const entries = (value: unknown): unknown[] => Object.values(record(value))
  const profiles = [input, ...entries(input.platforms).map(record)]
  const pending = profiles.flatMap((profile) => [...entries(profile.definitions), ...entries(profile.fields)])
  const seen = new Set<object>()
  // Visit schema nodes only, never arbitrary data in defaults, choices or presentation.
  while (pending.length > 0) {
    const field = record(pending.pop())
    if (seen.has(field)) continue
    seen.add(field)
    if (Object.hasOwn(field, '$ref') && (Object.hasOwn(field, 'platformOnly') || Object.hasOwn(field, 'suggestions'))) {
      facts.hasRefOverride = true
    }
    if (field.clearsOnChange !== undefined) facts.hasClearsOnChange = true
    pending.push(...entries(field.properties))
    if (field.items !== undefined) pending.push(field.items)
    if (field.additionalProperties && typeof field.additionalProperties === 'object') pending.push(field.additionalProperties)
    const variants = record(field.variants)
    for (const variant of [...entries(variants.cases), variants.otherwise]) {
      pending.push(...entries(record(variant).properties))
    }
  }
  return facts
}
