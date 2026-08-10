/**
 * Transitional type used by the legacy write wizard until phase 3C removes it.
 * The live console does not use this projection.
 */
export type PluginConsoleActionKind = 'openInstallWizard' | 'runUpgrade';

export function createPluginConsoleLocationKey(cell: {
  pluginName: string;
  platform: string;
  scope: string;
  projectKey?: string;
}): string {
  return [cell.pluginName, cell.platform, cell.scope, cell.projectKey ?? ''].join('\0');
}
