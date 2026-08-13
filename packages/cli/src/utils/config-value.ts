export const INVALID_CONFIG_JSON_VALUE_MESSAGE =
  'Invalid JSON value for --value-json: expected a valid JSON literal.';

export function parseConfigValue(value: unknown, valueJson: boolean): unknown {
  if (!valueJson) return value;

  try {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (raw === undefined) throw new Error('undefined JSON value');
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(INVALID_CONFIG_JSON_VALUE_MESSAGE);
  }
}

export function formatConfigCommandValue(value: unknown, valueJson: boolean): string {
  if (!valueJson) return String(value);
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}
