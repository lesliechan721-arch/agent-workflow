import type { CatalogSourceUpdate } from '../../utils/catalog-sources.js';

export function catalogSourceAutoCheckOnlyValue(
  update: CatalogSourceUpdate | undefined,
): boolean | undefined {
  if (!update || Object.keys(update).length !== 1 || typeof update.autoCheck !== 'boolean') {
    return undefined;
  }
  return update.autoCheck;
}

export function projectCatalogSourceMutationWarnings(execution: unknown): string[] {
  if (typeof execution !== 'object' || execution === null
    || !Array.isArray((execution as { errors?: unknown }).errors)) return [];
  return (execution as { errors: Array<{ message?: unknown }> }).errors.flatMap((error) =>
    typeof error?.message === 'string' ? [`警告：${error.message}`] : []);
}
