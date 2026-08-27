import path from 'node:path';

import fs from 'fs-extra';
import YAML from 'yaml';

import {
  validateSkillFrontmatterCapabilities,
  type SkillFrontmatterProfile,
} from '@lesliechan721/aw-plugin-core/manifest';

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_COMPATIBILITY_LENGTH = 500;
const MAX_SKILL_SHORT_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_LINES = 500;
const MAX_OPENAI_INTERFACE_NAME_LENGTH = 64;
const MIN_OPENAI_SHORT_DESCRIPTION_LENGTH = 25;
const MAX_OPENAI_SHORT_DESCRIPTION_LENGTH = 64;
const MAX_OPENAI_DEFAULT_PROMPT_LENGTH = 1024;
const MAX_OPENAI_DEPENDENCY_LENGTH = 1024;
const CODEX_PRODUCTS = new Set(['atlas', 'chatgpt', 'codex']);
const CODEX_TRANSPORTS = new Set(['stdio', 'streamable_http']);

export type CodexMetadataPolicy = 'required' | 'optional' | 'ignore';

export interface SkillValidationDiagnostic {
  code: string;
  path: string;
  message: string;
}

export interface SkillValidationResult {
  schemaVersion: 1;
  command: 'skill:validate';
  ok: boolean;
  skillDirectory: string;
  frontmatterProfile: SkillFrontmatterProfile;
  codexMetadata: CodexMetadataPolicy;
  warnings: SkillValidationDiagnostic[];
  errors: SkillValidationDiagnostic[];
}

export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, unknown> | null;
  errors: SkillValidationDiagnostic[];
}

export interface CodexMetadataValidation {
  errors: SkillValidationDiagnostic[];
  assetPaths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function diagnostic(code: string, diagnosticPath: string, message: string): SkillValidationDiagnostic {
  return { code, path: diagnosticPath, message };
}

function yamlErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseYamlDocument(
  content: string,
  sourcePath: string,
): { value: unknown; errors: SkillValidationDiagnostic[] } {
  const lineCounter = new YAML.LineCounter();
  const document = YAML.parseDocument(content, {
    lineCounter,
    prettyErrors: false,
  });
  if (document.errors.length > 0) {
    const first = document.errors[0];
    const position = first.linePos?.[0];
    const location = position ? `${sourcePath}:${position.line}:${position.col}` : sourcePath;
    return {
      value: null,
      errors: [diagnostic('invalid-yaml', sourcePath, `${location}: ${first.message}`)],
    };
  }
  return { value: document.toJSON(), errors: [] };
}

export function parseSkillFrontmatter(
  content: string,
  sourcePath = 'SKILL.md',
): ParsedSkillFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return {
      frontmatter: null,
      errors: [diagnostic('missing-frontmatter', sourcePath, 'SKILL.md must start with YAML frontmatter.')],
    };
  }
  const closingIndex = normalized.indexOf('\n---\n', 4);
  const closingAtEnd = closingIndex === -1 && normalized.endsWith('\n---');
  if (closingIndex === -1 && !closingAtEnd) {
    return {
      frontmatter: null,
      errors: [diagnostic('unclosed-frontmatter', sourcePath, 'SKILL.md YAML frontmatter is not closed.')],
    };
  }
  const yamlEnd = closingAtEnd ? normalized.length - '\n---'.length : closingIndex;
  const parsed = parseYamlDocument(normalized.slice(4, yamlEnd), sourcePath);
  if (parsed.errors.length > 0) return { frontmatter: null, errors: parsed.errors };
  if (!isRecord(parsed.value)) {
    return {
      frontmatter: null,
      errors: [diagnostic('frontmatter-root', sourcePath, 'SKILL.md frontmatter root must be an object.')],
    };
  }
  return { frontmatter: parsed.value, errors: [] };
}

function validateBoundedString(
  value: unknown,
  fieldPath: string,
  options: { required?: boolean; minLength?: number; maxLength?: number },
): SkillValidationDiagnostic[] {
  if (value === undefined && !options.required) return [];
  if (!nonEmptyString(value)) {
    return [diagnostic('invalid-string', fieldPath, `${fieldPath} must be a non-empty string.`)];
  }
  const length = Array.from(value.trim()).length;
  if (options.minLength !== undefined && length < options.minLength) {
    return [diagnostic('string-too-short', fieldPath, `${fieldPath} must be at least ${options.minLength} characters.`)];
  }
  if (options.maxLength !== undefined && length > options.maxLength) {
    return [diagnostic('string-too-long', fieldPath, `${fieldPath} must be at most ${options.maxLength} characters.`)];
  }
  return [];
}

export function validateSkillFrontmatter(
  frontmatter: Record<string, unknown>,
  options: { profile: SkillFrontmatterProfile; expectedName: string; sourcePath?: string },
): SkillValidationDiagnostic[] {
  const sourcePath = options.sourcePath ?? 'SKILL.md';
  const errors = validateSkillFrontmatterCapabilities(frontmatter, options.profile)
    .map((entry) => diagnostic(entry.code, `${sourcePath}#${entry.field}`, entry.message));

  if (nonEmptyString(frontmatter.name)) {
    errors.push(...validateBoundedString(frontmatter.name, `${sourcePath}#name`, {
      maxLength: MAX_SKILL_NAME_LENGTH,
    }));
    if (!SKILL_NAME_PATTERN.test(frontmatter.name)) {
      errors.push(diagnostic(
        'invalid-skill-name',
        `${sourcePath}#name`,
        'frontmatter.name must use ASCII lowercase hyphen-case.',
      ));
    } else if (frontmatter.name !== options.expectedName) {
      errors.push(diagnostic(
        'name-directory-mismatch',
        `${sourcePath}#name`,
        `frontmatter.name ${JSON.stringify(frontmatter.name)} must match directory ${JSON.stringify(options.expectedName)}.`,
      ));
    }
  }
  if (nonEmptyString(frontmatter.description)) {
    errors.push(...validateBoundedString(frontmatter.description, `${sourcePath}#description`, {
      maxLength: MAX_SKILL_DESCRIPTION_LENGTH,
    }));
  }
  if (nonEmptyString(frontmatter.license)) {
    errors.push(...validateBoundedString(frontmatter.license, `${sourcePath}#license`, {}));
  }
  if (nonEmptyString(frontmatter.compatibility)) {
    errors.push(...validateBoundedString(frontmatter.compatibility, `${sourcePath}#compatibility`, {
      maxLength: MAX_SKILL_COMPATIBILITY_LENGTH,
    }));
  }
  if (isRecord(frontmatter.metadata)) {
    if (options.profile !== 'claude-current') {
      for (const [key, value] of Object.entries(frontmatter.metadata)) {
        if (key !== 'short-description' && typeof value !== 'string') {
          errors.push(diagnostic(
            'known-field-invalid-type-value',
            `${sourcePath}#metadata.${key}`,
            `metadata field ${JSON.stringify(key)} must be a string in profile ${JSON.stringify(options.profile)}.`,
          ));
        }
      }
    }
    const shortDescription = frontmatter.metadata['short-description'];
    if (shortDescription !== undefined) {
      if (!nonEmptyString(shortDescription)) {
        errors.push(diagnostic(
          'known-field-invalid-type-value',
          `${sourcePath}#metadata.short-description`,
          'metadata.short-description must be a non-empty string.',
        ));
      } else {
        errors.push(...validateBoundedString(
          shortDescription,
          `${sourcePath}#metadata.short-description`,
          { maxLength: MAX_SKILL_SHORT_DESCRIPTION_LENGTH },
        ));
      }
    }
  }
  return errors;
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  fieldPath: string,
): SkillValidationDiagnostic[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !allowedSet.has(key))
    .map((key) => diagnostic('unknown-field', `${fieldPath}.${key}`, `${fieldPath} has unknown field ${JSON.stringify(key)}.`));
}

function validateCodexIcon(value: unknown, fieldPath: string): SkillValidationDiagnostic[] {
  if (value === undefined) return [];
  if (!nonEmptyString(value)) {
    return [diagnostic('invalid-string', fieldPath, `${fieldPath} must be a non-empty string.`)];
  }
  const normalized = path.posix.normalize(value.replace(/^\.\//, ''));
  if (value.includes('\\') || path.posix.isAbsolute(value) || normalized === 'assets' || !normalized.startsWith('assets/')) {
    return [diagnostic('invalid-asset-path', fieldPath, `${fieldPath} must be a relative path under assets/.`)];
  }
  return [];
}

export function validateCodexMetadata(
  content: string,
  expectedSkillName: string,
  sourcePath = 'agents/openai.yaml',
): CodexMetadataValidation {
  const parsed = parseYamlDocument(content, sourcePath);
  if (parsed.errors.length > 0) return { errors: parsed.errors, assetPaths: [] };
  if (!isRecord(parsed.value)) {
    return {
      errors: [diagnostic('metadata-root', sourcePath, 'agents/openai.yaml root must be an object.')],
      assetPaths: [],
    };
  }
  const root = parsed.value;
  const errors = unknownKeys(root, ['interface', 'dependencies', 'policy'], sourcePath);
  const assetPaths: string[] = [];

  if (root.interface !== undefined) {
    if (!isRecord(root.interface)) {
      errors.push(diagnostic('invalid-object', `${sourcePath}.interface`, 'agents/openai.yaml interface must be an object.'));
    } else {
      const fieldPath = `${sourcePath}.interface`;
      errors.push(...unknownKeys(root.interface, [
        'display_name',
        'short_description',
        'icon_small',
        'icon_large',
        'brand_color',
        'default_prompt',
      ], fieldPath));
      errors.push(...validateBoundedString(root.interface.display_name, `${fieldPath}.display_name`, {
        maxLength: MAX_OPENAI_INTERFACE_NAME_LENGTH,
      }));
      errors.push(...validateBoundedString(root.interface.short_description, `${fieldPath}.short_description`, {
        minLength: MIN_OPENAI_SHORT_DESCRIPTION_LENGTH,
        maxLength: MAX_OPENAI_SHORT_DESCRIPTION_LENGTH,
      }));
      errors.push(...validateBoundedString(root.interface.default_prompt, `${fieldPath}.default_prompt`, {
        maxLength: MAX_OPENAI_DEFAULT_PROMPT_LENGTH,
      }));
      if (
        nonEmptyString(root.interface.default_prompt)
        && !root.interface.default_prompt.includes(`$${expectedSkillName}`)
      ) {
        errors.push(diagnostic(
          'default-prompt-skill-reference',
          `${fieldPath}.default_prompt`,
          `default_prompt must reference $${expectedSkillName}.`,
        ));
      }
      for (const key of ['icon_small', 'icon_large'] as const) {
        errors.push(...validateCodexIcon(root.interface[key], `${fieldPath}.${key}`));
        if (nonEmptyString(root.interface[key])) {
          const normalized = path.posix.normalize(root.interface[key].replace(/^\.\//, ''));
          if (normalized.startsWith('assets/')) assetPaths.push(normalized);
        }
      }
      if (
        root.interface.brand_color !== undefined
        && (!nonEmptyString(root.interface.brand_color) || !/^#[0-9a-f]{6}$/iu.test(root.interface.brand_color))
      ) {
        errors.push(diagnostic(
          'invalid-brand-color',
          `${fieldPath}.brand_color`,
          'brand_color must use #RRGGBB.',
        ));
      }
    }
  }

  if (root.dependencies !== undefined) {
    if (!isRecord(root.dependencies)) {
      errors.push(diagnostic('invalid-object', `${sourcePath}.dependencies`, 'agents/openai.yaml dependencies must be an object.'));
    } else {
      errors.push(...unknownKeys(root.dependencies, ['tools'], `${sourcePath}.dependencies`));
      if (root.dependencies.tools !== undefined && !Array.isArray(root.dependencies.tools)) {
        errors.push(diagnostic('invalid-array', `${sourcePath}.dependencies.tools`, 'dependencies.tools must be an array.'));
      } else if (Array.isArray(root.dependencies.tools)) {
        for (const [index, tool] of root.dependencies.tools.entries()) {
          const fieldPath = `${sourcePath}.dependencies.tools[${index}]`;
          if (!isRecord(tool)) {
            errors.push(diagnostic('invalid-object', fieldPath, `${fieldPath} must be an object.`));
            continue;
          }
          errors.push(...unknownKeys(tool, ['type', 'value', 'description', 'transport', 'url', 'command'], fieldPath));
          errors.push(...validateBoundedString(tool.type, `${fieldPath}.type`, { required: true, maxLength: 64 }));
          errors.push(...validateBoundedString(tool.value, `${fieldPath}.value`, { required: true, maxLength: MAX_OPENAI_DEPENDENCY_LENGTH }));
          for (const key of ['description', 'url', 'command'] as const) {
            errors.push(...validateBoundedString(tool[key], `${fieldPath}.${key}`, {
              maxLength: MAX_OPENAI_DEPENDENCY_LENGTH,
            }));
          }
          errors.push(...validateBoundedString(tool.transport, `${fieldPath}.transport`, { maxLength: 64 }));
          if (nonEmptyString(tool.transport) && !CODEX_TRANSPORTS.has(tool.transport)) {
            errors.push(diagnostic(
              'invalid-transport',
              `${fieldPath}.transport`,
              'transport must be "streamable_http" or "stdio".',
            ));
          }
        }
      }
    }
  }

  if (!isRecord(root.policy)) {
    errors.push(diagnostic('missing-policy', `${sourcePath}.policy`, 'agents/openai.yaml policy must be an object.'));
  } else {
    const fieldPath = `${sourcePath}.policy`;
    errors.push(...unknownKeys(root.policy, ['allow_implicit_invocation', 'products'], fieldPath));
    if (typeof root.policy.allow_implicit_invocation !== 'boolean') {
      errors.push(diagnostic(
        'invalid-invocation-policy',
        `${fieldPath}.allow_implicit_invocation`,
        'policy.allow_implicit_invocation must be a boolean.',
      ));
    }
    if (root.policy.products !== undefined) {
      if (!Array.isArray(root.policy.products)) {
        errors.push(diagnostic('invalid-array', `${fieldPath}.products`, 'policy.products must be an array.'));
      } else {
        for (const [index, product] of root.policy.products.entries()) {
          if (!nonEmptyString(product) || !CODEX_PRODUCTS.has(product.toLowerCase())) {
            errors.push(diagnostic(
              'invalid-product',
              `${fieldPath}.products[${index}]`,
              'policy.products entries must be codex, chatgpt, atlas, or uppercase aliases.',
            ));
          }
        }
      }
    }
  }
  return { errors, assetPaths };
}

export async function validateSkillDirectory(options: {
  skillDirectory: string;
  frontmatterProfile: SkillFrontmatterProfile;
  codexMetadata: CodexMetadataPolicy;
}): Promise<SkillValidationResult> {
  const skillDirectory = path.resolve(options.skillDirectory);
  const errors: SkillValidationDiagnostic[] = [];
  const warnings: SkillValidationDiagnostic[] = [];
  const rootStats = await fs.lstat(skillDirectory).catch(() => null);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    errors.push(diagnostic('invalid-skill-directory', skillDirectory, 'Skill directory must be a real directory.'));
  } else {
    const skillPath = path.join(skillDirectory, 'SKILL.md');
    const skillContent = await fs.readFile(skillPath, 'utf8').catch((error: unknown) => {
      errors.push(diagnostic('missing-skill-file', 'SKILL.md', `Cannot read SKILL.md: ${yamlErrorMessage(error)}`));
      return null;
    });
    if (skillContent !== null) {
      const lineCount = skillContent.replace(/\r\n/g, '\n').split('\n').length;
      if (lineCount >= MAX_SKILL_LINES) {
        warnings.push(diagnostic(
          'skill-file-length',
          'SKILL.md',
          `SKILL.md has ${lineCount} lines; Agent Skills recommends fewer than ${MAX_SKILL_LINES}.`,
        ));
      }
      const parsed = parseSkillFrontmatter(skillContent);
      errors.push(...parsed.errors);
      if (parsed.frontmatter) {
        errors.push(...validateSkillFrontmatter(parsed.frontmatter, {
          profile: options.frontmatterProfile,
          expectedName: path.basename(skillDirectory),
        }));
      }
    }

    if (options.codexMetadata !== 'ignore') {
      const openAiPath = path.join(skillDirectory, 'agents', 'openai.yaml');
      const openAiContent = await fs.readFile(openAiPath, 'utf8').catch(() => null);
      if (openAiContent === null) {
        if (options.codexMetadata === 'required') {
          errors.push(diagnostic(
            'missing-codex-metadata',
            'agents/openai.yaml',
            'Codex metadata is required but agents/openai.yaml is missing.',
          ));
        }
      } else {
        const validation = validateCodexMetadata(
          openAiContent,
          path.basename(skillDirectory),
        );
        errors.push(...validation.errors);
        for (const assetPath of validation.assetPaths) {
          const assetStats = await fs.lstat(path.join(skillDirectory, ...assetPath.split('/'))).catch(() => null);
          if (!assetStats?.isFile() || assetStats.isSymbolicLink()) {
            errors.push(diagnostic(
              'missing-codex-asset',
              `agents/openai.yaml#${assetPath}`,
              `Codex metadata references missing regular file ${JSON.stringify(assetPath)}.`,
            ));
          }
        }
      }
    }
  }

  return {
    schemaVersion: 1,
    command: 'skill:validate',
    ok: errors.length === 0,
    skillDirectory,
    frontmatterProfile: options.frontmatterProfile,
    codexMetadata: options.codexMetadata,
    warnings,
    errors,
  };
}
