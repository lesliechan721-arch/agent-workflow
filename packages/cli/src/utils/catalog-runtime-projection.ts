import path from 'node:path';

import fs from 'fs-extra';
import {
  computeAwCapabilitySetDigest,
  normalizeAwCapabilities,
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
  requiredCapabilities: string[];
  capabilitySetDigest: string;
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

export async function resolveRuntimeExportSource(options: {
  plugin: PluginMeta;
  name: string;
  source: string;
  requiredCapabilities: readonly unknown[];
}): Promise<CatalogRuntimeExportResolution> {
  const canonicalSource = await validateRuntimeExportSource({
    pluginRoot: options.plugin.rootDir,
    name: options.name,
    source: options.source,
  });
  const requiredCapabilities = normalizeAwCapabilities(
    options.requiredCapabilities,
    `buildConfig.runtimeExports export "${options.name}" requires.aw.capabilities`,
  );
  return {
    provider: options.plugin.manifest.name,
    providerVersion: options.plugin.manifest.version,
    name: options.name,
    source: options.source,
    sourcePath: canonicalSource.sourceRealPath,
    sourceDigest: await calculateFileDigest(canonicalSource.sourceRealPath),
    requiredCapabilities,
    capabilitySetDigest: computeAwCapabilitySetDigest(requiredCapabilities),
    canonicalSource,
    supportedPlatforms: resolveSupportedPlatforms(options.plugin.manifest),
    virtual: false,
  };
}

async function resolveEvalVirtualExport(
  reference: BuildConfigImportReference,
  purpose: CatalogRuntimeImportPurpose,
): Promise<CatalogRuntimeExportResolution> {
  if (purpose !== 'build' && purpose !== 'skill-runtime-file') {
    throw new Error('Invalid catalog runtime import: virtual provider "@aw/agent-skill-eval" is only available to buildImports and skillRuntimeFiles.');
  }
  const sources = {
    'case-corpus-digest': './dist/corpus-digest.js',
    'eval-audit-result-schema': './dist/schemas/eval-audit-result.schema.json',
    'eval-run-bundle-schema': './dist/schemas/eval-run-bundle.schema.json',
    'eval-run-bundle-validator': './dist/bundle-validation-runtime.js',
  } as const;
  const source = sources[reference.export as keyof typeof sources];
  if (!source) {
    throw new Error(`Invalid catalog runtime import: unknown @aw/agent-skill-eval export "${reference.export}".`);
  }
  const cliPackageRoot = resolveCliPackageRoot();
  const packageRootCandidates = [
    path.resolve(cliPackageRoot, '..', 'agent-skill-eval'),
    path.join(cliPackageRoot, 'node_modules', '@lesliechan721', 'agent-skill-eval'),
  ];
  const packageRoot = packageRootCandidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'package.json')));
  if (!packageRoot) {
    throw new Error('Invalid @aw/agent-skill-eval runtime export: package root is unavailable.');
  }
  const packageJson = await fs.readJson(path.join(packageRoot, 'package.json')) as { version?: unknown };
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error('Invalid @aw/agent-skill-eval runtime export: package version is missing.');
  }
  const canonicalSource = await resolveCoreRuntimeSourceIdentity(
    packageRoot,
    source,
    `@aw/agent-skill-eval runtime export "${reference.export}"`,
  );
  const requiredCapabilities: string[] = [];
  return {
    provider: '@aw/agent-skill-eval',
    providerVersion: packageJson.version,
    name: reference.export,
    source,
    sourcePath: canonicalSource.sourceRealPath,
    sourceDigest: await calculateFileDigest(canonicalSource.sourceRealPath),
    requiredCapabilities,
    capabilitySetDigest: computeAwCapabilitySetDigest(requiredCapabilities),
    canonicalSource,
    supportedPlatforms: new Set<PlatformName>(['claude', 'codex']),
    virtual: true,
  };
}

export function createCatalogRuntimeImportResolver(
  plugins: readonly PluginMeta[],
): CatalogRuntimeImportResolver {
  const pluginsByName = new Map<string, PluginMeta[]>();
  for (const plugin of plugins) {
    const matches = pluginsByName.get(plugin.manifest.name) ?? [];
    matches.push(plugin);
    pluginsByName.set(plugin.manifest.name, matches);
  }

  return {
    async resolve({ consumer, reference, purpose, platform }) {
      if (reference.plugin.startsWith('@aw/')) {
        if (reference.plugin === '@aw/agent-skill-eval') {
          return resolveEvalVirtualExport(reference, purpose);
        }
        throw new Error(`Invalid catalog runtime import: unknown reserved provider "${reference.plugin}".`);
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
        requiredCapabilities: exports[0]!.requires.aw.capabilities,
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
