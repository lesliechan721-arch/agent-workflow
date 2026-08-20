import type {
  MarketplaceAuthenticationPolicy,
  MarketplaceManifest,
} from '../types.js';
import { readJsonFile } from './json.js';

const MARKETPLACE_AUTHENTICATION_POLICIES = new Set<MarketplaceAuthenticationPolicy>([
  'ON_INSTALL',
  'ON_USE',
]);

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
  if (!Array.isArray(value)) throw new Error(`Invalid ${fieldName}: expected an array.`);
  return value.map((entry, index) => assertString(entry, `${fieldName}[${index}]`));
}

function validateMarketplaceManifestEntry(value: unknown, fieldName: string): void {
  const entry = assertObject(value, fieldName);
  assertString(entry.name, `${fieldName}.name`);
  assertString(entry.source, `${fieldName}.source`);
  assertString(entry.description, `${fieldName}.description`);
  assertString(entry.category, `${fieldName}.category`);
  if (entry.tags !== undefined) assertStringArray(entry.tags, `${fieldName}.tags`);
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
  const authentication = assertString(policy.authentication, `${fieldName}.policy.authentication`);
  if (!MARKETPLACE_AUTHENTICATION_POLICIES.has(authentication as MarketplaceAuthenticationPolicy)) {
    throw new Error(
      `Invalid ${fieldName}.policy.authentication: expected "ON_INSTALL" or "ON_USE".`,
    );
  }
  if (policy.products !== undefined) assertStringArray(policy.products, `${fieldName}.policy.products`);
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
  if (!Array.isArray(manifest.plugins)) {
    throw new Error(`Invalid ${fieldName}.plugins: expected an array.`);
  }
  manifest.plugins.forEach((entry, index) => {
    validateMarketplaceManifestEntry(entry, `${fieldName}.plugins[${index}]`);
  });
  return manifest as unknown as MarketplaceManifest;
}

export async function readMarketplaceManifestAtPath(
  manifestPath: string,
  fieldName = 'marketplace manifest',
): Promise<MarketplaceManifest> {
  return validateMarketplaceManifest(await readJsonFile<unknown>(manifestPath), fieldName);
}
