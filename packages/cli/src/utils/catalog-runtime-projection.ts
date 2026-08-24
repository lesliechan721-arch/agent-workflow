import path from 'node:path';

import fs from 'fs-extra';
import {
  resolveCanonicalRuntimeSourceIdentity as resolveCoreRuntimeSourceIdentity,
  validateRuntimeExportSource,
  type CanonicalRuntimeSourceIdentity,
} from '@lesliechan721/aw-plugin-core/manifest';

import type {
  BuildConfigImportReference,
  PlatformName,
  PluginMeta,
} from '../types.js';
import { calculateFileDigest } from './bundle-integrity.js';
import { CLI_RESERVED_IMPORTS } from './manifest.js';
import { resolveCliPackageRoot } from './paths.js';
import { resolveSupportedPlatforms } from './platform-support.js';

export {
  resolveCanonicalRuntimeSourceIdentity,
} from '@lesliechan721/aw-plugin-core/manifest';
export type { CanonicalRuntimeSourceIdentity } from '@lesliechan721/aw-plugin-core/manifest';

export type CatalogRuntimeImportPurpose = 'build' | 'skill-runtime-file' | 'artifact-runtime';

export interface CatalogRuntimeExportResolution {
  provider: string;
  providerVersion: string;
  name: string;
  source: string;
  sourcePath: string;
  sourceDigest: string;
  canonicalSource: CanonicalRuntimeSourceIdentity;
  supportedPlatforms: ReadonlySet<PlatformName>;
  virtual: boolean;
}

export interface CatalogRuntimeImportResolver {
  resolve(options: {
    consumer: PluginMeta;
    reference: BuildConfigImportReference;
    purpose: CatalogRuntimeImportPurpose;
    platform?: PlatformName;
  }): Promise<CatalogRuntimeExportResolution>;
}

export interface CatalogRuntimeImportResolverOptions {
  /** CLI package root containing src/utils/skill-frontmatter-capabilities.json. */
  cliVirtualExportRoot?: string;
  /** Explicit provider identity; otherwise read from the selected CLI root package.json. */
  cliProviderVersion?: string;
}

export async function resolveRuntimeExportSource(options: {
  plugin: PluginMeta;
  name: string;
  source: string;
}): Promise<CatalogRuntimeExportResolution> {
  const canonicalSource = await validateRuntimeExportSource({
    pluginRoot: options.plugin.rootDir,
    name: options.name,
    source: options.source,
  });
  return {
    provider: options.plugin.manifest.name,
    providerVersion: options.plugin.manifest.version,
    name: options.name,
    source: options.source,
    sourcePath: canonicalSource.sourceRealPath,
    sourceDigest: await calculateFileDigest(canonicalSource.sourceRealPath),
    canonicalSource,
    supportedPlatforms: resolveSupportedPlatforms(options.plugin.manifest),
    virtual: false,
  };
}

async function resolveCliVirtualExport(
  reference: BuildConfigImportReference,
  purpose: CatalogRuntimeImportPurpose,
  options: CatalogRuntimeImportResolverOptions,
): Promise<CatalogRuntimeExportResolution> {
  if (purpose !== 'build') {
    throw new Error('Invalid catalog runtime import: virtual provider "@aw/cli" is only available to buildImports.');
  }
  if (!CLI_RESERVED_IMPORTS['@aw/cli'].includes(
    reference.export as (typeof CLI_RESERVED_IMPORTS)['@aw/cli'][number],
  )) {
    throw new Error(`Invalid catalog runtime import: unknown @aw/cli export "${reference.export}".`);
  }
  const packageRoot = options.cliVirtualExportRoot ?? resolveCliPackageRoot();
  const sourceCandidates = options.cliVirtualExportRoot
    ? [path.join(packageRoot, 'src', 'utils', 'skill-frontmatter-capabilities.json')]
    : [
        path.join(packageRoot, 'src', 'utils', 'skill-frontmatter-capabilities.json'),
        path.join(packageRoot, 'dist', 'src', 'utils', 'skill-frontmatter-capabilities.json'),
      ];
  const sourceCandidate = sourceCandidates.find((candidate) => fs.existsSync(candidate));
  if (!sourceCandidate) {
    throw new Error(
      `Invalid @aw/cli runtime export: canonical skill frontmatter registry is missing from ${packageRoot}.`,
    );
  }
  const canonicalSource = await resolveCoreRuntimeSourceIdentity(
    packageRoot,
    `./${path.relative(packageRoot, sourceCandidate).split(path.sep).join('/')}`,
    '@aw/cli runtime export "skill-frontmatter-capabilities"',
  );
  const packageJson = options.cliProviderVersion === undefined
    ? await fs.readJson(path.join(packageRoot, 'package.json')) as { version?: unknown }
    : undefined;
  const providerVersion = options.cliProviderVersion ?? packageJson?.version;
  if (typeof providerVersion !== 'string' || providerVersion.trim() === '') {
    throw new Error('Invalid @aw/cli runtime export: package version is missing.');
  }
  return {
    provider: '@aw/cli',
    providerVersion,
    name: reference.export,
    source: './src/utils/skill-frontmatter-capabilities.json',
    sourcePath: canonicalSource.sourceRealPath,
    sourceDigest: await calculateFileDigest(canonicalSource.sourceRealPath),
    canonicalSource,
    supportedPlatforms: new Set<PlatformName>(['claude', 'codex']),
    virtual: true,
  };
}

export function createCatalogRuntimeImportResolver(
  plugins: readonly PluginMeta[],
  options: CatalogRuntimeImportResolverOptions = {},
): CatalogRuntimeImportResolver {
  if (options.cliVirtualExportRoot && !path.isAbsolute(options.cliVirtualExportRoot)) {
    throw new Error('Invalid cliVirtualExportRoot: expected an absolute CLI package root.');
  }
  const resolverOptions: CatalogRuntimeImportResolverOptions = {
    ...options,
    cliVirtualExportRoot: options.cliVirtualExportRoot
      ? path.normalize(options.cliVirtualExportRoot)
      : undefined,
  };
  const pluginsByName = new Map<string, PluginMeta[]>();
  for (const plugin of plugins) {
    const matches = pluginsByName.get(plugin.manifest.name) ?? [];
    matches.push(plugin);
    pluginsByName.set(plugin.manifest.name, matches);
  }

  return {
    async resolve({ consumer, reference, purpose, platform }) {
      if (reference.plugin.startsWith('@aw/')) {
        if (!Object.hasOwn(CLI_RESERVED_IMPORTS, reference.plugin)) {
          throw new Error(`Invalid catalog runtime import: unknown reserved provider "${reference.plugin}".`);
        }
        return resolveCliVirtualExport(reference, purpose, resolverOptions);
      }
      if (reference.plugin === consumer.manifest.name) {
        throw new Error(`Invalid catalog runtime import: plugin "${consumer.manifest.name}" cannot import itself.`);
      }
      const providers = pluginsByName.get(reference.plugin) ?? [];
      if (providers.length === 0) {
        throw new Error(`Invalid catalog runtime import: provider plugin "${reference.plugin}" is unavailable.`);
      }
      if (providers.length !== 1) {
        throw new Error(`Invalid catalog runtime import: provider plugin "${reference.plugin}" is ambiguous.`);
      }
      const provider = providers[0]!;
      const exports = (provider.manifest.buildConfig?.runtimeExports ?? [])
        .filter((entry) => entry.name === reference.export);
      if (exports.length === 0) {
        throw new Error(
          `Invalid catalog runtime import: provider "${reference.plugin}" does not export "${reference.export}".`,
        );
      }
      if (exports.length !== 1) {
        throw new Error(
          `Invalid catalog runtime import: provider "${reference.plugin}" export "${reference.export}" is ambiguous.`,
        );
      }
      const resolution = await resolveRuntimeExportSource({
        plugin: provider,
        name: exports[0]!.name,
        source: exports[0]!.source,
      });
      if (platform && !resolution.supportedPlatforms.has(platform)) {
        throw new Error(
          `Invalid catalog runtime import: provider "${reference.plugin}" is unavailable for platform "${platform}".`,
        );
      }
      if (purpose === 'build') {
        const unsupportedPlatform = [...resolveSupportedPlatforms(consumer.manifest)]
          .find((consumerPlatform) => !resolution.supportedPlatforms.has(consumerPlatform));
        if (unsupportedPlatform) {
          throw new Error(
            `Invalid catalog runtime import: provider "${reference.plugin}" is unavailable for consumer platform "${unsupportedPlatform}".`,
          );
        }
      }
      return resolution;
    },
  };
}
