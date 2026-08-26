import {
  discoverPlugins as discoverCorePlugins,
  discoverPluginsInDirectory as discoverCorePluginsInDirectory,
  readPluginManifest as readCorePluginManifest,
  resolvePlugins as resolveCorePlugins,
  resolvePluginsFromCatalog as resolveCorePluginsFromCatalog,
  validatePluginManifest as validateCorePluginManifest,
  validateSourcePluginManifest as validateCoreSourcePluginManifest,
  type NormalizedPluginManifest,
  type PluginMeta,
  type ReadPluginManifestOptions,
  type ReservedImportRegistry,
  type ValidatePluginManifestOptions,
} from '@lesliechan721/aw-plugin-core/manifest';

export * from '@lesliechan721/aw-plugin-core/manifest';
export type * from '@lesliechan721/aw-plugin-core/manifest';

export const CLI_RESERVED_IMPORTS = {
  '@aw/cli': ['skill-frontmatter-capabilities', 'plugin-authoring-capabilities'],
  '@aw/agent-skill-eval': ['case-corpus-digest'],
} as const satisfies ReservedImportRegistry;

function withCliReservedImports<T extends { reservedImports?: ReservedImportRegistry }>(
  options: T,
): T & { reservedImports: ReservedImportRegistry } {
  return {
    ...options,
    reservedImports: CLI_RESERVED_IMPORTS,
  };
}

export function validatePluginManifest(
  pluginRoot: string,
  rawManifest: unknown,
  options: ValidatePluginManifestOptions = {},
): NormalizedPluginManifest {
  return validateCorePluginManifest(pluginRoot, rawManifest, withCliReservedImports(options));
}

export function validateSourcePluginManifest(
  pluginRoot: string,
  rawManifest: unknown,
): Promise<NormalizedPluginManifest> {
  return validateCoreSourcePluginManifest(pluginRoot, rawManifest, {
    reservedImports: CLI_RESERVED_IMPORTS,
  });
}

export function readPluginManifest(
  pluginRoot: string,
  options: ReadPluginManifestOptions = {},
): Promise<PluginMeta> {
  return readCorePluginManifest(pluginRoot, withCliReservedImports(options));
}

export function discoverPluginsInDirectory(
  pluginsDir: string,
  options: ReadPluginManifestOptions = {},
): Promise<PluginMeta[]> {
  return discoverCorePluginsInDirectory(pluginsDir, withCliReservedImports(options));
}

export function discoverPlugins(
  repoRoot: string,
  options: ReadPluginManifestOptions = {},
): Promise<PluginMeta[]> {
  return discoverCorePlugins(repoRoot, withCliReservedImports(options));
}

export function resolvePlugins(
  repoRoot: string,
  pluginNames?: string[],
  options: ReadPluginManifestOptions = {},
): Promise<PluginMeta[]> {
  return resolveCorePlugins(repoRoot, pluginNames, withCliReservedImports(options));
}

export function resolvePluginsFromCatalog(
  catalogRoot: string,
  pluginNames?: string[],
  options: Omit<ReadPluginManifestOptions, 'mode'> = {},
): Promise<PluginMeta[]> {
  return resolveCorePluginsFromCatalog(
    catalogRoot,
    pluginNames,
    withCliReservedImports(options),
  );
}
