import type { MarketplaceManifest, PlatformName } from '../types.js';
import { readJsonFile } from './json.js';
import { resolveCurrentCatalog } from './plugin-catalog.js';
import { getMarketplaceManifestPath } from './paths.js';

function assertObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  return value as Record<string, unknown>;
}

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }

  return value;
}

function assertStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an array.`);
  }

  return value.map((entry, index) => assertString(entry, `${fieldName}[${index}]`));
}

function validateMarketplaceManifestEntry(
  value: unknown,
  fieldName: string,
): void {
  const entry = assertObject(value, fieldName);
  assertString(entry.name, `${fieldName}.name`);
  assertString(entry.source, `${fieldName}.source`);
  assertString(entry.description, `${fieldName}.description`);
  assertString(entry.category, `${fieldName}.category`);

  if (entry.tags !== undefined) {
    assertStringArray(entry.tags, `${fieldName}.tags`);
  }
  if (typeof entry.strict !== 'boolean') {
    throw new Error(`Invalid ${fieldName}.strict: expected a boolean.`);
  }
  if (entry.interface !== undefined) {
    const interfaceMeta = assertObject(entry.interface, `${fieldName}.interface`);
    if (interfaceMeta.displayName !== undefined) {
      assertString(interfaceMeta.displayName, `${fieldName}.interface.displayName`);
    }
    if (interfaceMeta.shortDescription !== undefined) {
      assertString(interfaceMeta.shortDescription, `${fieldName}.interface.shortDescription`);
    }
    if (interfaceMeta.capabilities !== undefined) {
      assertStringArray(interfaceMeta.capabilities, `${fieldName}.interface.capabilities`);
    }
  }

  const policy = assertObject(entry.policy, `${fieldName}.policy`);
  assertString(policy.installation, `${fieldName}.policy.installation`);
  assertString(policy.authentication, `${fieldName}.policy.authentication`);
  if (policy.products !== undefined) {
    assertStringArray(policy.products, `${fieldName}.policy.products`);
  }
}

export function validateMarketplaceManifest(
  value: unknown,
  fieldName = 'marketplace manifest',
): MarketplaceManifest {
  const manifest = assertObject(value, fieldName);
  if (assertString(manifest.name, `${fieldName}.name`) !== 'aw') {
    throw new Error(`Invalid ${fieldName}.name: expected "aw".`);
  }

  const owner = assertObject(manifest.owner, `${fieldName}.owner`);
  assertString(owner.name, `${fieldName}.owner.name`);
  assertString(owner.url, `${fieldName}.owner.url`);

  const interfaceMeta = assertObject(manifest.interface, `${fieldName}.interface`);
  assertString(interfaceMeta.displayName, `${fieldName}.interface.displayName`);

  const plugins = manifest.plugins;
  if (!Array.isArray(plugins)) {
    throw new Error(`Invalid ${fieldName}.plugins: expected an array.`);
  }
  plugins.forEach((entry, index) => {
    validateMarketplaceManifestEntry(entry, `${fieldName}.plugins[${index}]`);
  });

  return manifest as unknown as MarketplaceManifest;
}

export async function readMarketplaceManifest(
  _cwd: string,
  platform: PlatformName,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  path: string;
  manifest: MarketplaceManifest;
}> {
  const catalog = await resolveCurrentCatalog(env);
  const targetPath = getMarketplaceManifestPath(catalog.rootDir, platform);
  const targetManifest = validateMarketplaceManifest(
    await readJsonFile<unknown>(targetPath),
    `${platform} marketplace manifest`,
  );

  return {
    path: targetPath,
    manifest: targetManifest,
  };
}
