import { createRequire } from 'node:module';

import type registryDocumentShape from './skill-frontmatter-capabilities.json';

const require = createRequire(import.meta.url);
const registryDocument = require(
  './skill-frontmatter-capabilities.json',
) as typeof registryDocumentShape;

export type SkillFrontmatterProfile =
  | 'portable-agent-skills'
  | 'claude-2.1.88'
  | 'claude-current';

export type SkillFrontmatterDiagnosticCode =
  | 'unknown-field'
  | 'known-field-not-supported-by-target-version'
  | 'known-field-requires-related-field'
  | 'known-field-invalid-type-value'
  | 'portable-profile-platform-extension';

type SkillFrontmatterFieldType =
  | 'boolean'
  | 'boolean-or-string'
  | 'boolean-or-string-or-binary-number'
  | 'object'
  | 'string'
  | 'string-map'
  | 'string-or-integer'
  | 'string-or-string-array';

interface SkillFrontmatterFieldCapability {
  owner: 'agent-skills' | 'claude';
  type: SkillFrontmatterFieldType;
  typeByProfile?: Partial<Record<SkillFrontmatterProfile, SkillFrontmatterFieldType>>;
  required?: boolean;
  profiles: SkillFrontmatterProfile[];
  acceptedValues?: string[];
  acceptedValuesByProfile?: Partial<Record<SkillFrontmatterProfile, string[]>>;
  acceptedValuesCaseInsensitive?: boolean;
  acceptedValuesCaseInsensitiveByProfile?: Partial<Record<SkillFrontmatterProfile, boolean>>;
  requires?: Record<string, unknown>;
  introducedVersion?: string | null;
  verifiedAtVersion?: string;
}

interface SkillFrontmatterCapabilityRegistry {
  schemaVersion: 1;
  verifiedOn: string;
  requiredSemantics: string;
  profiles: Record<SkillFrontmatterProfile, {
    platform: 'claude' | 'portable';
    targetVersion: string | null;
    description: string;
  }>;
  fields: Record<string, SkillFrontmatterFieldCapability>;
}

export interface SkillFrontmatterCapabilityDiagnostic {
  code: SkillFrontmatterDiagnosticCode;
  field: string;
  message: string;
}

const REGISTRY = registryDocument as SkillFrontmatterCapabilityRegistry;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function matchesType(value: unknown, type: SkillFrontmatterFieldType): boolean {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'boolean-or-string':
      return typeof value === 'boolean' || nonEmptyString(value);
    case 'boolean-or-string-or-binary-number':
      return typeof value === 'boolean'
        || nonEmptyString(value)
        || value === 0
        || value === 1;
    case 'object':
      return isRecord(value);
    case 'string':
      return nonEmptyString(value);
    case 'string-map':
      return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
    case 'string-or-integer':
      return nonEmptyString(value) || (typeof value === 'number' && Number.isInteger(value));
    case 'string-or-string-array':
      return nonEmptyString(value) || isStringArray(value);
  }
}

function unsupportedFieldDiagnostic(
  field: string,
  capability: SkillFrontmatterFieldCapability,
  profile: SkillFrontmatterProfile,
): SkillFrontmatterCapabilityDiagnostic {
  if (profile === 'portable-agent-skills' && capability.owner !== 'agent-skills') {
    return {
      code: 'portable-profile-platform-extension',
      field,
      message: `field ${JSON.stringify(field)} is a Claude Code extension and is not portable Agent Skills frontmatter`,
    };
  }

  const introduced = capability.introducedVersion
    ? `; documented minimum is Claude Code ${capability.introducedVersion}`
    : '';
  return {
    code: 'known-field-not-supported-by-target-version',
    field,
    message: `field ${JSON.stringify(field)} is known but is not supported by profile ${JSON.stringify(profile)}${introduced}`,
  };
}

export function getSkillFrontmatterCapabilityRegistry(): SkillFrontmatterCapabilityRegistry {
  return REGISTRY;
}

export function validateSkillFrontmatterCapabilities(
  frontmatter: Record<string, unknown>,
  profile: SkillFrontmatterProfile,
): SkillFrontmatterCapabilityDiagnostic[] {
  const diagnostics: SkillFrontmatterCapabilityDiagnostic[] = [];

  for (const field of Object.keys(frontmatter)) {
    const capability = REGISTRY.fields[field];
    if (!capability) {
      diagnostics.push({
        code: 'unknown-field',
        field,
        message: `field ${JSON.stringify(field)} is not registered for any supported Skill frontmatter profile`,
      });
      continue;
    }
    if (!capability.profiles.includes(profile)) {
      diagnostics.push(unsupportedFieldDiagnostic(field, capability, profile));
      continue;
    }

    const expectedType = capability.typeByProfile?.[profile] ?? capability.type;
    const value = frontmatter[field];
    if (!matchesType(value, expectedType)) {
      diagnostics.push({
        code: 'known-field-invalid-type-value',
        field,
        message: `field ${JSON.stringify(field)} must have type ${JSON.stringify(expectedType)} in profile ${JSON.stringify(profile)}`,
      });
      continue;
    }

    const acceptedValues = capability.acceptedValuesByProfile?.[profile]
      ?? capability.acceptedValues;
    const acceptedValuesCaseInsensitive =
      capability.acceptedValuesCaseInsensitiveByProfile?.[profile]
      ?? capability.acceptedValuesCaseInsensitive
      ?? false;
    if (
      typeof value === 'string' &&
      acceptedValues &&
      !acceptedValues.includes(
        acceptedValuesCaseInsensitive ? value.trim().toLowerCase() : value.trim(),
      )
    ) {
      diagnostics.push({
        code: 'known-field-invalid-type-value',
        field,
        message: `field ${JSON.stringify(field)} must be one of ${acceptedValues.map((entry) => JSON.stringify(entry)).join(', ')}`,
      });
    }

    for (const [requiredField, requiredValue] of Object.entries(capability.requires ?? {})) {
      if (frontmatter[requiredField] !== requiredValue) {
        diagnostics.push({
          code: 'known-field-requires-related-field',
          field,
          message: `field ${JSON.stringify(field)} requires ${JSON.stringify(requiredField)}=${JSON.stringify(requiredValue)}`,
        });
      }
    }
  }

  for (const [field, capability] of Object.entries(REGISTRY.fields)) {
    if (
      capability.required &&
      capability.profiles.includes(profile) &&
      frontmatter[field] === undefined
    ) {
      diagnostics.push({
        code: 'known-field-invalid-type-value',
        field,
        message: `required field ${JSON.stringify(field)} is missing for profile ${JSON.stringify(profile)}`,
      });
    }
  }

  return diagnostics;
}
