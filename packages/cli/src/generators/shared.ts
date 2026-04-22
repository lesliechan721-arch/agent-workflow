import { GENERATED_FILE_PREFIX } from '../constants.js';

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildGeneratedName(pluginName: string, itemName: string): string {
  return `${GENERATED_FILE_PREFIX}${slugify(pluginName)}-${slugify(itemName)}`;
}

export function dedupe(values: string[] = []): string[] {
  return [...new Set(values.filter(Boolean))];
}
