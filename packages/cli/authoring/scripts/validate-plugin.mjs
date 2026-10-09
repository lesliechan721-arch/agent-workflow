#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AW_RUNTIME_CONFIG_READER_PATH,
  createRuntimeConfigSnapshot,
  getPluginAuthoringAcceptedValues as getCorePluginAuthoringAcceptedValues,
  getSkillFrontmatterCapabilityRegistry,
  normalizePluginConfigDefinition,
} from '@lesliechan721/aw-plugin-core/manifest';

import { checkPluginVersions } from './lib/plugin-version-check.mjs';
import { scanJavaScriptImportSpecifiers } from './lib/javascript-import-scanner.mjs';
import {
  assertAuthoringPluginPathFence,
  assertCanonicalAuthoringPluginRoot,
} from './lib/plugin-root.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authoringRuntimeRoot = path.resolve(__dirname, '..', '..');
const CLI_PACKAGE_ROOT = path.basename(authoringRuntimeRoot) === 'dist'
  ? path.dirname(authoringRuntimeRoot)
  : authoringRuntimeRoot;

const errors = [];
const warnings = [];
const SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION = 16;
let capabilityDiagnostic = null;
const MAX_SKILL_NAME_LEN = 64;
const MAX_SKILL_DESCRIPTION_LEN = 1024;
const MAX_SKILL_COMPATIBILITY_LEN = 500;
const MAX_SKILL_SHORT_DESCRIPTION_LEN = 1024;
const MAX_SKILL_LINES = 500;
const MAX_OPENAI_INTERFACE_NAME_LEN = 64;
const MIN_OPENAI_INTERFACE_DESCRIPTION_LEN = 25;
const MAX_OPENAI_INTERFACE_DESCRIPTION_LEN = 64;
const MAX_OPENAI_DEFAULT_PROMPT_LEN = 1024;
const MAX_OPENAI_DEPENDENCY_TYPE_LEN = 64;
const MAX_OPENAI_DEPENDENCY_TRANSPORT_LEN = 64;
const MAX_OPENAI_DEPENDENCY_VALUE_LEN = 1024;
const MAX_OPENAI_DEPENDENCY_DESCRIPTION_LEN = 1024;
const MAX_OPENAI_DEPENDENCY_COMMAND_LEN = 1024;
const MAX_OPENAI_DEPENDENCY_URL_LEN = 1024;
const CLAUDE_FRONTMATTER_SHELLS = new Set(['bash', 'powershell']);
const CLAUDE_SLASH_COMMAND_ONLY_FIELDS = new Set([
  'allowed-tools',
  'model',
  'argument-hint',
  'disable-model-invocation',
  'shell',
]);
const CODEX_POLICY_PRODUCTS = new Set([
  'atlas',
  'ATLAS',
  'chatgpt',
  'CHATGPT',
  'codex',
  'CODEX',
]);
const MANIFEST_POLICY_PRODUCTS = new Set(getPluginAuthoringAcceptedValues(
  'manifest',
  'marketplace.policy.products',
));
const MARKETPLACE_AUTHENTICATION_POLICIES = new Set(getPluginAuthoringAcceptedValues(
  'manifest',
  'marketplace.policy.authentication',
));
const MARKETPLACE_INSTALLATION_POLICIES = new Set(getPluginAuthoringAcceptedValues(
  'manifest',
  'marketplace.policy.installation',
));
const PUBLIC_HOOK_EVENTS = new Set(['before_tool', 'after_tool', 'session_start']);
const PUBLIC_SESSION_START_SOURCES = new Set(['startup', 'resume', 'clear']);
const PUBLIC_SESSION_START_DEFAULT_MATCHER = 'startup|resume|clear';
const PUBLIC_HOOK_RENDER_MAP = {
  claude: {
    before_tool: 'PreToolUse',
    after_tool: 'PostToolUse',
    session_start: 'SessionStart',
  },
  codex: {
    before_tool: 'PreToolUse',
    after_tool: 'PostToolUse',
    session_start: 'SessionStart',
  },
};
const NATIVE_HOOK_EVENTS = {
  claude: new Set([
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'Notification',
    'UserPromptSubmit',
    'SessionStart',
    'SessionEnd',
    'Stop',
    'StopFailure',
    'SubagentStart',
    'SubagentStop',
    'PreCompact',
    'PostCompact',
    'PermissionRequest',
    'PermissionDenied',
    'Setup',
    'TeammateIdle',
    'TaskCreated',
    'TaskCompleted',
    'Elicitation',
    'ElicitationResult',
    'ConfigChange',
    'WorktreeCreate',
    'WorktreeRemove',
    'InstructionsLoaded',
    'CwdChanged',
    'FileChanged',
  ]),
  codex: new Set([
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'SessionStart',
    'UserPromptSubmit',
    'Stop',
  ]),
};
const MATCHERLESS_NATIVE_HOOK_EVENTS = {
  claude: new Set([
    'UserPromptSubmit',
    'Stop',
    'TeammateIdle',
    'TaskCreated',
    'TaskCompleted',
    'WorktreeCreate',
    'WorktreeRemove',
    'CwdChanged',
  ]),
  codex: new Set(['UserPromptSubmit', 'Stop']),
};
const TEMPLATE_TEXT_FILE_EXTENSIONS = /\.(md|markdown|txt|json|yaml|yml|toml|rules)$/i;
const SLASH_COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_SLASH_COMMANDS_DIR = 'slash-commands';
const SCRIPT_NODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SCRIPT_TIMEOUT_MIN_MS = 1000;
const SCRIPT_TIMEOUT_MAX_MS = 1800000;
const ARTIFACT_TARGETS = new Set(getPluginAuthoringAcceptedValues(
  'artifacts',
  'artifacts.targets[].target',
));
const ARTIFACT_STATES = new Set(getPluginAuthoringAcceptedValues(
  'artifacts',
  'artifacts.targets[].states',
));
const ARTIFACT_SCOPES = new Set(['user', 'project']);
const ARTIFACT_KINDS = new Set(['instruction', 'codexRole', 'skill']);
const ARTIFACT_PROJECT_MANAGED_KINDS = new Set(['instruction', 'agent', 'skill']);
const ARTIFACT_KIND_BY_TARGET = {
  'codex.developerInstructionsBlock': 'instruction',
  'codex.agentRole': 'codexRole',
  'codex.skill': 'skill',
  'claude.skill': 'skill',
  'agent-skills.skill': 'skill',
};
const ARTIFACT_PROJECT_MANAGED_KIND_BY_TARGET = {
  'codex.developerInstructionsBlock': 'instruction',
  'codex.agentRole': 'agent',
  'codex.skill': 'skill',
};
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
let yamlParser = null;
let pluginVersionCheckResult = null;
let skillEvalManifestTools = null;

function error(msg) {
  errors.push(msg);
}

function warn(msg) {
  warnings.push(msg);
}

function loadYamlParser(sourceName) {
  if (yamlParser) return yamlParser;
  try {
    yamlParser = require('yaml');
    return yamlParser;
  } catch (e) {
    throw new Error(
      `${sourceName}: YAML parser dependency "yaml" is not installed; run pnpm install in the agent-workflows repo`,
    );
  }
}

function stripStandaloneTemplateControlLines(content) {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (/^{{[#/^]/.test(trimmed) || /^{{else\b/.test(trimmed)) {
        return '';
      }
      return line;
    })
    .join('\n');
}

function stripDotSlash(value) {
  return value.startsWith('./') ? value.slice(2) : value;
}

function escapeRegexSegment(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileGlob(pattern) {
  const normalized = pattern.split(path.sep).join('/');
  let source = '^';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      continue;
    }

    if (char === '?') {
      source += '.';
      continue;
    }

    source += escapeRegexSegment(char);
  }

  source += '$';
  return new RegExp(source);
}

function normalizeRelativePath(filePath) {
  return path.posix.normalize(stripDotSlash(filePath).split(path.sep).join('/'));
}

function matchesGlob(filePath, pattern) {
  return compileGlob(pattern).test(normalizeRelativePath(filePath));
}

function isTemplateTextFile(relativePath) {
  return TEMPLATE_TEXT_FILE_EXTENSIONS.test(relativePath);
}

function templateIncludesPath(manifest, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const include = manifest.buildConfig?.templates?.include;
  if (!Array.isArray(include) || !isTemplateTextFile(normalized)) return false;
  return include.some((pattern) => matchesGlob(normalized, pattern));
}

function resolveTemplateValue(vars, platform) {
  const resolved = {};
  for (const [key, entry] of Object.entries(vars)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      resolved[key] = entry[platform];
    }
  }
  return resolved;
}

function replaceConditionalBlocks(input, resolvedVars, tagName) {
  const pattern = new RegExp(
    `{{#${tagName}\\s+([a-zA-Z0-9_]+)}}([\\s\\S]*?){{\\/${tagName}}}`,
    'g',
  );

  return input.replace(pattern, (_match, rawKey, blockContent) => {
    const truthy = resolvedVars[rawKey] === true;
    if (tagName === 'if') {
      return truthy ? blockContent : '';
    }

    return truthy ? '' : blockContent;
  });
}

function renderTemplate(content, vars, platform) {
  const resolvedVars = resolveTemplateValue(vars, platform);
  const withConditionals = replaceConditionalBlocks(
    replaceConditionalBlocks(content, resolvedVars, 'if'),
    resolvedVars,
    'unless',
  );

  return withConditionals.replace(/{{([a-zA-Z0-9_]+)}}/g, (_match, rawKey) => {
    const value = resolvedVars[rawKey];
    if (value === undefined) return '';
    return String(value);
  });
}

function renderTemplateForPlatform(manifest, relativePath, content, platform) {
  if (!templateIncludesPath(manifest, relativePath)) return content;
  const vars = manifest.buildConfig?.templates?.vars ?? {};
  return renderTemplate(content, vars, platform);
}

function renderedContentVariants(manifest, relativePath, content, platforms) {
  if (!templateIncludesPath(manifest, relativePath)) {
    return [{ content, platform: null }];
  }

  const seen = new Set();
  const variants = [];
  for (const platform of platforms) {
    const rendered = renderTemplateForPlatform(manifest, relativePath, content, platform);
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    variants.push({ content: rendered, platform });
  }
  return variants;
}

function formatYamlError(parseError, lineCounter, sourceName) {
  let location = '';
  if (Array.isArray(parseError.pos) && Number.isInteger(parseError.pos[0])) {
    const linePos = lineCounter.linePos(parseError.pos[0]);
    location = `:${linePos.line}:${linePos.col}`;
  }

  let message = parseError.message || String(parseError);
  if (parseError.code === 'BLOCK_AS_IMPLICIT_KEY') {
    message = `${message}; plain scalar values containing ": " must be quoted`;
  }
  return `${sourceName}${location}: ${message}`;
}

function parseYaml(content, sourceName) {
  const yaml = loadYamlParser(sourceName);
  const lineCounter = new yaml.LineCounter();
  const document = yaml.parseDocument(stripStandaloneTemplateControlLines(content), {
    lineCounter,
    prettyErrors: false,
  });

  if (document.errors.length > 0) {
    throw new Error(formatYamlError(document.errors[0], lineCounter, sourceName));
  }

  const value = document.toJSON();
  return value ?? {};
}

function parseFrontmatter(content, sourceName) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  return parseYaml(match[1], sourceName);
}

function getPluginAuthoringAcceptedValues(surface, field) {
  return getCorePluginAuthoringAcceptedValues(surface, field);
}

function loadSkillFrontmatterCapabilityRegistry() {
  return getSkillFrontmatterCapabilityRegistry();
}

async function tryLoadCliManifestTools() {
  const manifestModulePath = path.join(
    CLI_PACKAGE_ROOT,
    'dist',
    'src',
    'utils',
    'manifest.js',
  );
  const runtimeProjectionModulePath = path.join(
    CLI_PACKAGE_ROOT,
    'dist',
    'src',
    'utils',
    'catalog-runtime-projection.js',
  );
  const capabilityModulePath = path.join(
    CLI_PACKAGE_ROOT,
    'dist',
    'src',
    'commands',
    'aw-capabilities.js',
  );
  if (
    !fs.existsSync(manifestModulePath)
    || !fs.existsSync(runtimeProjectionModulePath)
    || !fs.existsSync(capabilityModulePath)
  ) return null;
  try {
    const [manifestModule, runtimeProjectionModule, capabilityModule] = await Promise.all([
      import(pathToFileURL(manifestModulePath).href),
      import(pathToFileURL(runtimeProjectionModulePath).href),
      import(pathToFileURL(capabilityModulePath).href),
    ]);
    if (
      manifestModule.SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION
      !== SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION
    ) {
      return null;
    }
    return {
      assertPluginInputTree: manifestModule.assertPluginInputTree ?? null,
      validateSourcePluginManifest: manifestModule.validateSourcePluginManifest ?? null,
      readPluginManifest: manifestModule.readPluginManifest ?? null,
      discoverPlugins: manifestModule.discoverPlugins ?? null,
      resolvePluginRequirements: manifestModule.resolvePluginRequirements ?? null,
      implementedCapabilities: capabilityModule.IMPLEMENTED_AW_CAPABILITIES ?? null,
      createRuntimeResolver: runtimeProjectionModule.createCatalogRuntimeImportResolver ?? null,
    };
  } catch {
    return null;
  }
}

async function tryLoadCliSkillValidationTools() {
  const modulePath = path.join(
    CLI_PACKAGE_ROOT,
    'dist',
    'src',
    'utils',
    'skill-validation.js',
  );
  if (!fs.existsSync(modulePath)) return null;
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    if (
      typeof mod.parseSkillFrontmatter !== 'function'
      || typeof mod.validateSkillFrontmatter !== 'function'
      || typeof mod.validateCodexMetadata !== 'function'
    ) {
      return null;
    }
    return {
      parseSkillFrontmatter: mod.parseSkillFrontmatter,
      validateSkillFrontmatter: mod.validateSkillFrontmatter,
      validateCodexMetadata: mod.validateCodexMetadata,
    };
  } catch {
    return null;
  }
}

function findRepoRootCandidate(pluginDir) {
  let currentPath = path.dirname(pluginDir);
  while (true) {
    if (fs.lstatSync(path.join(currentPath, '.git'), { throwIfNoEntry: false })) {
      return currentPath;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return null;
    currentPath = parentPath;
  }
}

function discoverCanonicalRepoRoot(repoRootCandidate) {
  if (!repoRootCandidate) return null;
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: repoRootCandidate,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const repoRoot = path.resolve(result.stdout.trim());
  return fs.realpathSync(repoRoot) === fs.realpathSync(repoRootCandidate)
    ? repoRoot
    : null;
}

function resolveCanonicalRepoRoot(pluginDir, pluginName, repoRoot) {
  if (!repoRoot) return null;
  return fs.realpathSync(pluginDir) === path.join(fs.realpathSync(repoRoot), 'plugins', pluginName)
    ? repoRoot
    : null;
}

// ---------------------------------------------------------------------------
// Lightweight manifest checks (fallback when CLI not built)
// ---------------------------------------------------------------------------

const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseStrictSemVer(value) {
  const stringValue = String(value);
  const match = stringValue.match(STRICT_SEMVER_PATTERN);
  if (!match) return null;

  return {
    raw: stringValue,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ? match[5].split('.') : [],
  };
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareStrictSemVer(left, right) {
  const leftVersion = parseStrictSemVer(left);
  const rightVersion = parseStrictSemVer(right);
  if (!leftVersion || !rightVersion) {
    throw new Error('compareStrictSemVer requires strict SemVer inputs.');
  }

  for (const key of ['major', 'minor', 'patch']) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] - rightVersion[key];
    }
  }

  const leftPrerelease = leftVersion.prerelease;
  const rightPrerelease = rightVersion.prerelease;
  if (leftPrerelease.length === 0 && rightPrerelease.length === 0) {
    return 0;
  }
  if (leftPrerelease.length === 0) {
    return 1;
  }
  if (rightPrerelease.length === 0) {
    return -1;
  }

  const maxLength = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = leftPrerelease[index];
    const rightIdentifier = rightPrerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const result = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (result !== 0) {
      return result;
    }
  }

  return 0;
}

function validateStrictSemVerString(value, fieldName) {
  if (value === undefined) {
    error(`Invalid ${fieldName}: expected a strict SemVer 2.0.0 string. Received undefined.`);
    return null;
  }
  if (typeof value !== 'string' || !STRICT_SEMVER_PATTERN.test(value)) {
    error(`Invalid ${fieldName}: expected a strict SemVer 2.0.0 string. Received ${JSON.stringify(value)}.`);
    return null;
  }
  return value;
}

function validateManifestLightweight(manifest) {
  const input = expectRecord(manifest, 'plugin manifest');
  if (!input) return;
  if (Object.prototype.hasOwnProperty.call(input, 'commands')) {
    error('top-level "commands" has been removed; use "slashCommands" instead');
  }
  validateAllowedKeys(input, 'plugin manifest', [
    'schemaVersion',
    'name',
    'version',
    'description',
    'dependencies',
    'requires',
    'skills',
    'slashCommands',
    'mcpServers',
    'apps',
    'distributions',
    'marketplace',
    'interface',
    'extensions',
    'buildConfig',
    'scripts',
    'config',
    'artifacts',
  ]);

  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies)) {
      error('dependencies must be an array');
    } else if (manifest.dependencies.length > 64) {
      error('dependencies must contain at most 64 direct plugin dependencies');
    } else {
      const seen = new Set();
      for (const [index, dependency] of manifest.dependencies.entries()) {
        if (typeof dependency !== 'string' || !PLUGIN_NAME_PATTERN.test(dependency)) {
          error(`dependencies[${index}] must be an ASCII lowercase hyphen-case plugin name`);
          continue;
        }
        if (dependency === manifest.name) {
          error(`plugin "${manifest.name}" cannot depend on itself`);
        }
        if (seen.has(dependency)) {
          error(`dependencies contains duplicate plugin "${dependency}"`);
        }
        seen.add(dependency);
      }
    }
  }

  for (const field of ['name', 'version', 'description', 'marketplace']) {
    if (!manifest[field]) {
      error(`Missing required field: ${field}`);
    }
  }

  if (manifest.name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)) {
    error(`manifest name "${manifest.name}" is not lowercase-hyphen-case`);
  }
  if (manifest.version) {
    const pluginVersion = parseStrictSemVer(manifest.version);
    if (!pluginVersion) {
      error(`manifest.version must be a strict SemVer 2.0.0 string, got "${manifest.version}"`);
    } else if (pluginVersion.prerelease.length > 0 || pluginVersion.build.length > 0) {
      error('manifest.version must be a stable SemVer without prerelease or build metadata');
    }
  }

  if (manifest.marketplace) {
    const mp = manifest.marketplace;
    if (!mp.category) error('marketplace.category is required');
    if (typeof mp.strict !== 'boolean')
      error('marketplace.strict must be a boolean');
    if (!mp.policy || !mp.policy.installation)
      error('marketplace.policy.installation is required');
    else if (!MARKETPLACE_INSTALLATION_POLICIES.has(mp.policy.installation))
      error(`marketplace.policy.installation must be one of ${[...MARKETPLACE_INSTALLATION_POLICIES].map((value) => JSON.stringify(value)).join(', ')}`);
    if (!mp.policy || !mp.policy.authentication)
      error('marketplace.policy.authentication is required');
    else if (!MARKETPLACE_AUTHENTICATION_POLICIES.has(mp.policy.authentication))
      error('marketplace.policy.authentication must be "ON_INSTALL" or "ON_USE"');
    validateManifestPolicyProducts(mp.policy?.products);
  }

  for (const field of ['skills', 'slashCommands', 'mcpServers', 'apps']) {
    if (manifest[field] && !manifest[field].startsWith('./')) {
      error(`${field} path must start with "./", got "${manifest[field]}"`);
    }
  }

  const claudeCommands = manifest.buildConfig?.manifestOverrides?.claude?.commands;
  if (claudeCommands !== undefined) {
    error('buildConfig.manifestOverrides.claude.commands has been removed; use "slashCommands" instead');
  }

  for (const platform of ['claude', 'codex']) {
    const rules = manifest.buildConfig?.fileRules?.[platform];
    if (!rules) continue;
    for (const pattern of [...(rules.include ?? []), ...(rules.exclude ?? [])]) {
      const normalized = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
      if (normalized === 'commands' || normalized.startsWith('commands/')) {
        error(`buildConfig.fileRules.${platform} no longer accepts legacy "commands/**" source rules; use "slashCommands" instead`);
      }
    }
  }

  validateExtensionsLightweight(manifest.extensions);
  validatePlatformFieldSupport(manifest);
}

function validatePortableNativeArtifactCapabilityLightweight(manifest) {
  if (manifest.distributions?.agentSkills === undefined) return;
  const hasOtherNativeDeclaration = Boolean(
    manifest.skills
    || manifest.slashCommands
    || manifest.mcpServers
    || manifest.apps
    || (manifest.extensions?.instructions?.length ?? 0) > 0
    || (manifest.extensions?.permissions?.length ?? 0) > 0
    || (manifest.extensions?.hooks?.length ?? 0) > 0
    || (manifest.extensions?.nativeHooks?.claude?.length ?? 0) > 0
    || (manifest.extensions?.nativeHooks?.codex?.length ?? 0) > 0
    || (manifest.extensions?.agents?.length ?? 0) > 0
  );
  const hasPresentNativeArtifact = (manifest.artifacts?.targets ?? []).some((target) =>
    (target?.platform === 'claude' || target?.platform === 'codex')
    && Array.isArray(target.states)
    && target.states.includes('present'));
  if (!hasOtherNativeDeclaration && !hasPresentNativeArtifact) {
    const message = 'Invalid plugin manifest: portable-only plugins are not supported. Declare at least one non-empty native capability.';
    if (!errors.includes(message)) error(message);
  }
}

function normalizeManifestProductToken(value) {
  return String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function resolveSupportedPlatforms(manifest) {
  const products = manifest.marketplace?.policy?.products;
  if (!Array.isArray(products) || products.length === 0) {
    return new Set(['claude', 'codex']);
  }

  const supported = new Set();
  for (const product of products) {
    const normalized = normalizeManifestProductToken(product);
    if (normalized === 'CLAUDE') supported.add('claude');
    if (normalized === 'CODEX') supported.add('codex');
  }

  return supported;
}

function supportsManifestPlatform(manifest, platform) {
  return resolveSupportedPlatforms(manifest).has(platform);
}

function formatManifestProductsForError(manifest) {
  const products = manifest.marketplace?.policy?.products;
  if (!Array.isArray(products) || products.length === 0) {
    return 'marketplace.policy.products=[]';
  }

  const normalized = [...new Set(products.map(normalizeManifestProductToken))];
  return `marketplace.policy.products=[${normalized.join(', ')}]`;
}

function platformProductName(platform) {
  return platform === 'claude' ? 'CLAUDE' : 'CODEX';
}

function pluginNameForError(manifest) {
  return typeof manifest.name === 'string' && manifest.name.trim()
    ? manifest.name.trim()
    : '<unknown>';
}

function assertPlatformFieldSupported(manifest, fieldPath, requiredPlatform) {
  if (supportsManifestPlatform(manifest, requiredPlatform)) return;
  error(
    `Invalid plugin "${pluginNameForError(manifest)}": ${fieldPath} requires ${platformProductName(requiredPlatform)} support, but ${formatManifestProductsForError(manifest)}.`,
  );
}

function hasNonEmptyOverride(value) {
  return isRecord(value) && Object.keys(value).length > 0;
}

function validateManifestPolicyProducts(products) {
  if (products === undefined) return;

  if (!Array.isArray(products)) {
    error('marketplace.policy.products must be an array');
    return;
  }

  for (const [index, product] of products.entries()) {
    const fieldName = `marketplace.policy.products[${index}]`;
    if (typeof product !== 'string' || product.trim() === '') {
      error(`${fieldName} must be a non-empty string`);
      continue;
    }

    const normalized = normalizeManifestProductToken(product);
    if (!MANIFEST_POLICY_PRODUCTS.has(normalized)) {
      error(`${fieldName} must be one of "CODEX" or "CLAUDE"`);
    }
  }
}

function validatePlatformFieldSupport(manifest) {
  if (manifest.buildConfig?.fileRules?.claude !== undefined) {
    assertPlatformFieldSupported(manifest, 'buildConfig.fileRules.claude', 'claude');
  }
  if (manifest.buildConfig?.fileRules?.codex !== undefined) {
    assertPlatformFieldSupported(manifest, 'buildConfig.fileRules.codex', 'codex');
  }
  if (manifest.buildConfig?.manifestOverrides?.claude !== undefined) {
    assertPlatformFieldSupported(manifest, 'buildConfig.manifestOverrides.claude', 'claude');
  }
  if (manifest.buildConfig?.manifestOverrides?.codex !== undefined) {
    assertPlatformFieldSupported(manifest, 'buildConfig.manifestOverrides.codex', 'codex');
  }
  if (manifest.apps) {
    assertPlatformFieldSupported(manifest, 'apps', 'codex');
  }

  if (Array.isArray(manifest.extensions?.nativeHooks?.claude) && manifest.extensions.nativeHooks.claude.length > 0) {
    assertPlatformFieldSupported(manifest, 'extensions.nativeHooks.claude', 'claude');
  }
  if (Array.isArray(manifest.extensions?.nativeHooks?.codex) && manifest.extensions.nativeHooks.codex.length > 0) {
    assertPlatformFieldSupported(manifest, 'extensions.nativeHooks.codex', 'codex');
  }

  for (const [fieldName, entries] of [
    ['extensions.instructions', manifest.extensions?.instructions],
    ['extensions.permissions', manifest.extensions?.permissions],
    ['extensions.hooks', manifest.extensions?.hooks],
    ['extensions.agents', manifest.extensions?.agents],
  ]) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (!isRecord(entry.agentOverrides)) return;
      for (const platform of ['claude', 'codex']) {
        if (hasNonEmptyOverride(entry.agentOverrides[platform])) {
          assertPlatformFieldSupported(
            manifest,
            `${fieldName}[${index}].agentOverrides.${platform}`,
            platform,
          );
        }
      }
    });
  }

  if (!Array.isArray(manifest.artifacts?.targets)) return;
  manifest.artifacts.targets.forEach((target, index) => {
    if (target?.platform === 'claude' || target?.platform === 'codex') {
      assertPlatformFieldSupported(
        manifest,
        `artifacts.targets[${index}].platform`,
        target.platform,
      );
    }
  });
}

function isTemplateAsset(manifest, relativePath) {
  return templateIncludesPath(manifest, relativePath);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateAllowedKeys(record, fieldName, allowedKeys) {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      error(`${fieldName} has unknown field "${key}"`);
    }
  }
}

function validateManifestString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    error(`${fieldName} must be a non-empty string`);
    return null;
  }
  return value;
}

function validatePublicHookEvent(value, fieldName) {
  const event = validateManifestString(value, fieldName);
  if (!event) return null;
  if (event === 'session_stop') {
    error(
      `${fieldName}: public event "session_stop" has been removed; use extensions.nativeHooks.claude[].event = "Stop" or "SessionEnd", or extensions.nativeHooks.codex[].event = "Stop"`,
    );
    return null;
  }
  if (!PUBLIC_HOOK_EVENTS.has(event)) {
    error(`${fieldName}: unsupported public hook event "${event}"`);
    return null;
  }
  return event;
}

function normalizePublicSessionStartMatcher(matcher, fieldName) {
  if (matcher === undefined) return PUBLIC_SESSION_START_DEFAULT_MATCHER;
  if (typeof matcher !== 'string' || matcher.trim() === '') {
    error(`${fieldName} must be a non-empty string`);
    return null;
  }
  const selected = new Set();
  for (const part of matcher.split('|')) {
    if (!PUBLIC_SESSION_START_SOURCES.has(part)) {
      error(`${fieldName}: public session_start only allows startup, resume, clear, or their "|" union`);
      return null;
    }
    selected.add(part);
  }
  return ['startup', 'resume', 'clear'].filter((part) => selected.has(part)).join('|');
}

function validatePublicHookMatcher(event, matcher, fieldName) {
  if (matcher === undefined) return event === 'session_start' ? PUBLIC_SESSION_START_DEFAULT_MATCHER : undefined;
  if (typeof matcher !== 'string' || matcher.trim() === '') {
    error(`${fieldName} must be a non-empty string`);
    return null;
  }
  if (event === 'session_start') {
    return normalizePublicSessionStartMatcher(matcher, fieldName);
  }
  return matcher;
}

function validateNativeHookEvent(value, platform, fieldName) {
  const event = validateManifestString(value, fieldName);
  if (!event) return null;
  if (!NATIVE_HOOK_EVENTS[platform].has(event)) {
    error(`${fieldName}: unsupported ${platform} hook event "${event}"`);
    return null;
  }
  return event;
}

function validateNativeHookMatcher(event, platform, matcher, fieldName) {
  if (matcher === undefined) return undefined;
  if (typeof matcher !== 'string' || matcher.trim() === '') {
    error(`${fieldName} must be a non-empty string`);
    return null;
  }
  if (MATCHERLESS_NATIVE_HOOK_EVENTS[platform].has(event)) {
    error(`${fieldName}: ${platform} event "${event}" does not allow matcher`);
    return null;
  }
  return matcher;
}

function validateHookAgentOverrides(value, baseHook, fieldName, duplicateCollector) {
  if (value === undefined) {
    for (const platform of ['claude', 'codex']) {
      duplicateCollector(platform, baseHook);
    }
    return;
  }

  const overrides = expectRecord(value, fieldName);
  if (!overrides) return;
  validateAllowedKeys(overrides, fieldName, ['claude', 'codex']);

  for (const platform of ['claude', 'codex']) {
    const override = overrides[platform];
    if (override === null) continue;
    if (override === undefined) {
      duplicateCollector(platform, baseHook);
      continue;
    }

    const overrideRecord = expectRecord(override, `${fieldName}.${platform}`);
    if (!overrideRecord) continue;
    validateAllowedKeys(overrideRecord, `${fieldName}.${platform}`, ['event', 'matcher', 'command']);
    const event = overrideRecord.event === undefined
      ? baseHook.event
      : validatePublicHookEvent(overrideRecord.event, `${fieldName}.${platform}.event`);
    const matcherValue = overrideRecord.matcher === undefined
      ? baseHook.matcher
      : overrideRecord.matcher;
    const matcher = event
      ? validatePublicHookMatcher(event, matcherValue, `${fieldName}.${platform}.matcher`)
      : null;
    const command = overrideRecord.command === undefined
      ? baseHook.command
      : validateManifestString(overrideRecord.command, `${fieldName}.${platform}.command`);
    if (event && matcher !== null && command) {
      duplicateCollector(platform, { event, matcher, command });
    }
  }
}

function validateHookEntryLightweight(entry, fieldName, duplicateCollector) {
  const input = expectRecord(entry, fieldName);
  if (!input) return;
  validateAllowedKeys(input, fieldName, ['event', 'matcher', 'command', 'agentOverrides']);

  const event = validatePublicHookEvent(input.event, `${fieldName}.event`);
  const matcher = event
    ? validatePublicHookMatcher(event, input.matcher, `${fieldName}.matcher`)
    : null;
  const command = validateManifestString(input.command, `${fieldName}.command`);
  if (!event || matcher === null || !command) return;

  validateHookAgentOverrides(
    input.agentOverrides,
    { event, matcher, command },
    `${fieldName}.agentOverrides`,
    duplicateCollector,
  );
}

function validateNativeHookEntryLightweight(entry, platform, fieldName, duplicateCollector) {
  const input = expectRecord(entry, fieldName);
  if (!input) return;
  validateAllowedKeys(input, fieldName, ['event', 'matcher', 'command']);

  const event = validateNativeHookEvent(input.event, platform, `${fieldName}.event`);
  const matcher = event
    ? validateNativeHookMatcher(event, platform, input.matcher, `${fieldName}.matcher`)
    : null;
  const command = validateManifestString(input.command, `${fieldName}.command`);
  if (!event || matcher === null || !command) return;
  duplicateCollector(platform, { event, matcher, command, native: true });
}

function validateExtensionsLightweight(extensions) {
  if (extensions === undefined) return;
  const input = expectRecord(extensions, 'extensions');
  if (!input) return;
  validateAllowedKeys(input, 'extensions', ['instructions', 'permissions', 'hooks', 'nativeHooks', 'agents']);

  const seenHooks = {
    claude: new Set(),
    codex: new Set(),
  };
  const collectHook = (platform, hook) => {
    const event = hook.native ? hook.event : PUBLIC_HOOK_RENDER_MAP[platform][hook.event];
    const matcher = hook.matcher === '*' ? undefined : hook.matcher;
    const key = JSON.stringify([event, matcher ?? null, hook.command]);
    if (seenHooks[platform].has(key)) {
      error(`extensions has duplicate ${platform} hook for event "${event}" and command "${hook.command}"`);
    }
    seenHooks[platform].add(key);
  };

  if (input.hooks !== undefined) {
    if (!Array.isArray(input.hooks)) {
      error('extensions.hooks must be an array');
    } else {
      input.hooks.forEach((entry, index) =>
        validateHookEntryLightweight(entry, `extensions.hooks[${index}]`, collectHook),
      );
    }
  }

  if (input.nativeHooks !== undefined) {
    const nativeHooks = expectRecord(input.nativeHooks, 'extensions.nativeHooks');
    if (nativeHooks) {
      validateAllowedKeys(nativeHooks, 'extensions.nativeHooks', ['claude', 'codex']);
      for (const platform of ['claude', 'codex']) {
        if (nativeHooks[platform] === undefined) continue;
        if (!Array.isArray(nativeHooks[platform])) {
          error(`extensions.nativeHooks.${platform} must be an array`);
          continue;
        }
        nativeHooks[platform].forEach((entry, index) =>
          validateNativeHookEntryLightweight(
            entry,
            platform,
            `extensions.nativeHooks.${platform}[${index}]`,
            collectHook,
          ),
        );
      }
    }
  }
}

function expectRecord(value, fieldName) {
  if (!isRecord(value)) {
    error(`${fieldName} must be an object`);
    return null;
  }
  return value;
}

function validateNonEmptyString(value, fieldName, maxLength) {
  if (typeof value !== 'string') {
    error(`${fieldName} must be a string`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    error(`${fieldName} must not be empty`);
    return null;
  }
  if (maxLength !== undefined && countCharacters(trimmed) > maxLength) {
    error(`${fieldName} must be <= ${maxLength} characters`);
  }
  return trimmed;
}


async function loadSkillEvalManifestTools() {
  if (skillEvalManifestTools) return skillEvalManifestTools;
  const modulePath = path.join(CLI_PACKAGE_ROOT, 'dist', 'src', 'eval', 'manifest-v1.js');
  try {
    skillEvalManifestTools = await import(pathToFileURL(modulePath).href);
    return skillEvalManifestTools;
  } catch {
    return null;
  }
}

async function validatePluginEvalManifest(pluginDir, pluginManifest) {
  const legacyRoot = path.join(pluginDir, 'evals');
  if (fs.existsSync(legacyRoot)) {
    error(
      'Plugin-root evals/ is legacy; put evals/ inside its owning static or dynamic Skill directory.',
    );
  }
  const skillRoots = [...collectDeclaredSkillNames(pluginDir, pluginManifest).all]
    .sort()
    .map((skill) => ({ skill, root: path.join(pluginDir, 'skills', skill) }));
  const seenSkills = new Set();
  let manifestTools = null;
  for (const owner of skillRoots) {
    const evalDir = path.join(owner.root, 'evals');
    const manifestPath = path.join(evalDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifestField = path.relative(pluginDir, manifestPath).split(path.sep).join('/');
    if (seenSkills.has(owner.skill)) {
      error(`Skill ${JSON.stringify(owner.skill)} has more than one evals/manifest.json owner`);
      continue;
    }
    seenSkills.add(owner.skill);
    manifestTools ??= await loadSkillEvalManifestTools();
    if (typeof manifestTools?.validateAwSkillEvalManifest !== 'function') {
      error('Canonical AwSkillEvalManifest v1 validator is unavailable; run the current built aw CLI.');
      continue;
    }
    const validation = await manifestTools.validateAwSkillEvalManifest({
      plugin: {
        rootDir: pluginDir,
        manifestPath: path.join(pluginDir, '.agents-plugin', 'plugin.json'),
        manifest: pluginManifest,
      },
      skill: owner.skill,
    });
    for (const message of validation.errors) error(`${manifestField}: ${message}`);
  }
}

function countCharacters(value) {
  return Array.from(value).length;
}

function countLines(value) {
  if (value.length === 0) return 0;
  const normalized = value.replace(/\r\n?/g, '\n');
  const withoutFinalNewline = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;
  return withoutFinalNewline.split('\n').length;
}

function sanitizeSingleLine(value) {
  return value.trim().split(/\s+/).filter(Boolean).join(' ');
}

function validateCodexMetadataString(record, key, fieldName, maxLength, required = false) {
  if (record[key] === undefined) {
    if (required) {
      error(`${fieldName}.${key} is required`);
    }
    return null;
  }

  if (typeof record[key] !== 'string') {
    error(`${fieldName}.${key} must be a string`);
    return null;
  }

  const sanitized = sanitizeSingleLine(record[key]);
  if (sanitized.length === 0) {
    error(`${fieldName}.${key} must not be empty`);
    return null;
  }

  if (countCharacters(sanitized) > maxLength) {
    error(`${fieldName}.${key} must be <= ${maxLength} characters`);
  }

  return sanitized;
}

function validateCodexShortDescription(record, fieldName) {
  const sanitized = validateCodexMetadataString(
    record,
    'short_description',
    fieldName,
    MAX_OPENAI_INTERFACE_DESCRIPTION_LEN,
  );
  if (
    sanitized !== null &&
    countCharacters(sanitized) < MIN_OPENAI_INTERFACE_DESCRIPTION_LEN
  ) {
    error(
      `${fieldName}.short_description must be >= ${MIN_OPENAI_INTERFACE_DESCRIPTION_LEN} characters`,
    );
  }
  return sanitized;
}

function validateCodexDefaultPrompt(record, key, fieldName, maxLength, skillReference, required = false) {
  const sanitized = validateCodexMetadataString(record, key, fieldName, maxLength, required);
  if (sanitized === null) return null;

  const mention = `$${skillReference}`;
  if (!sanitized.includes(mention)) {
    error(`${fieldName}.${key} must explicitly mention "${mention}"`);
  }

  return sanitized;
}

function validateCodexBrandColor(record, key, fieldName) {
  if (record[key] === undefined) return;
  if (typeof record[key] !== 'string') {
    error(`${fieldName}.${key} must be a string`);
    return;
  }

  const value = record[key].trim();
  if (value.length === 0) {
    error(`${fieldName}.${key} must not be empty`);
    return;
  }

  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    error(`${fieldName}.${key} must match #RRGGBB`);
  }
}

function validateCodexIconPath(record, key, fieldName) {
  if (record[key] === undefined) return;
  if (typeof record[key] !== 'string') {
    error(`${fieldName}.${key} must be a string`);
    return;
  }

  const value = record[key].trim();
  if (value.length === 0) {
    error(`${fieldName}.${key} must not be empty`);
    return;
  }

  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    error(`${fieldName}.${key} must be a relative path under assets/`);
    return;
  }

  const components = value.split('/');
  if (components.some((component) => component === '..')) {
    error(`${fieldName}.${key} must be a relative path under assets/`);
    return;
  }

  const normalized = path.posix.normalize(stripDotSlash(value));
  if (normalized !== 'assets' && !normalized.startsWith('assets/')) {
    error(`${fieldName}.${key} must be a relative path under assets/`);
  }
}

function validateAllowedTools(value, fieldName, options) {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      error(`${fieldName} must not be an empty string`);
    }
    return;
  }

  if (!options.allowArray) {
    error(
      `${fieldName} must be a space-separated string in the Agent Skills portable core profile`,
    );
    return;
  }

  if (!Array.isArray(value)) {
    error(`${fieldName} must be a string or an array of strings`);
    return;
  }

  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      error(`${fieldName}[${index}] must be a string`);
    } else if (item.trim().length === 0) {
      error(`${fieldName}[${index}] must not be empty`);
    }
  }
}

function isNonEmptyFrontmatterString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFrontmatterStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyFrontmatterString);
}

function frontmatterValueMatchesType(value, type) {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'boolean-or-string':
      return typeof value === 'boolean' || isNonEmptyFrontmatterString(value);
    case 'boolean-or-string-or-binary-number':
      return typeof value === 'boolean'
        || isNonEmptyFrontmatterString(value)
        || value === 0
        || value === 1;
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'string':
      return isNonEmptyFrontmatterString(value);
    case 'string-map':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every((entry) => typeof entry === 'string');
    case 'string-or-integer':
      return isNonEmptyFrontmatterString(value)
        || (typeof value === 'number' && Number.isInteger(value));
    case 'string-or-string-array':
      return isNonEmptyFrontmatterString(value) || isFrontmatterStringArray(value);
    default:
      return false;
  }
}

function skillFrontmatterProfile(options) {
  if (options.strictAgentSkills || !options.targetsClaude) {
    return 'portable-agent-skills';
  }
  return options.claudeSkillProfile === 'current'
    ? 'claude-current'
    : 'claude-2.1.88';
}

function validateSkillFrontmatterCapabilityFields(fm, fieldName, profile) {
  let registry;
  try {
    registry = loadSkillFrontmatterCapabilityRegistry();
  } catch (registryError) {
    error(`${fieldName} capability registry error: ${registryError.message}`);
    return;
  }

  for (const [key, value] of Object.entries(fm)) {
    const capability = registry.fields[key];
    if (!capability) {
      error(`${fieldName} [unknown-field] field ${JSON.stringify(key)} is not registered for any supported profile`);
      continue;
    }
    if (!capability.profiles.includes(profile)) {
      if (profile === 'portable-agent-skills' && capability.owner !== 'agent-skills') {
        error(`${fieldName} [portable-profile-platform-extension] field ${JSON.stringify(key)} is a Claude Code extension`);
      } else {
        const version = capability.introducedVersion
          ? `; documented minimum is Claude Code ${capability.introducedVersion}`
          : '';
        error(`${fieldName} [known-field-not-supported-by-target-version] field ${JSON.stringify(key)} is not supported by profile ${JSON.stringify(profile)}${version}`);
      }
      continue;
    }

    const expectedType = capability.typeByProfile?.[profile] ?? capability.type;
    if (!frontmatterValueMatchesType(value, expectedType)) {
      error(`${fieldName} [known-field-invalid-type-value] field ${JSON.stringify(key)} must have type ${JSON.stringify(expectedType)} in profile ${JSON.stringify(profile)}`);
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
      error(`${fieldName} [known-field-invalid-type-value] field ${JSON.stringify(key)} must be one of ${acceptedValues.map((entry) => JSON.stringify(entry)).join(', ')}`);
    }

    for (const [requiredKey, requiredValue] of Object.entries(capability.requires ?? {})) {
      if (fm[requiredKey] !== requiredValue) {
        error(`${fieldName} [known-field-requires-related-field] field ${JSON.stringify(key)} requires ${JSON.stringify(requiredKey)}=${JSON.stringify(requiredValue)}`);
      }
    }
  }

  for (const [key, capability] of Object.entries(registry.fields)) {
    if (capability.required && capability.profiles.includes(profile) && fm[key] === undefined) {
      error(`${fieldName} [known-field-invalid-type-value] required field ${JSON.stringify(key)} is missing for profile ${JSON.stringify(profile)}`);
    }
  }
}

function validateSkillFrontmatter(fm, skillName, options) {
  const fieldName = `skills/${skillName}/SKILL.md frontmatter`;
  const profile = skillFrontmatterProfile(options);
  validateSkillFrontmatterCapabilityFields(
    fm,
    fieldName,
    profile,
  );

  if (fm.name === undefined) {
    error(`${fieldName} missing "name"`);
  } else {
    const name = validateNonEmptyString(fm.name, `${fieldName}.name`, MAX_SKILL_NAME_LEN);
    if (name) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        error(`${fieldName}.name must use ASCII lowercase hyphen-case`);
      }
      if (name !== skillName) {
        error(`${fieldName}.name "${name}" must match skill directory "${skillName}"`);
      }
    }
  }

  if (fm.description === undefined) {
    error(`${fieldName} missing "description"`);
  } else {
    validateNonEmptyString(
      fm.description,
      `${fieldName}.description`,
      MAX_SKILL_DESCRIPTION_LEN,
    );
  }

  if (fm.license !== undefined) {
    validateNonEmptyString(fm.license, `${fieldName}.license`);
  }

  if (fm.compatibility !== undefined) {
    validateNonEmptyString(
      fm.compatibility,
      `${fieldName}.compatibility`,
      MAX_SKILL_COMPATIBILITY_LEN,
    );
  }

  if (fm.metadata !== undefined) {
    const metadata = expectRecord(fm.metadata, `${fieldName}.metadata`);
    if (metadata) {
      if (profile !== 'claude-current') {
        for (const [key, value] of Object.entries(metadata)) {
          if (typeof value !== 'string') {
            error(`${fieldName}.metadata.${key} must be a string`);
          }
        }
      }
      if (metadata['short-description'] !== undefined) {
        validateNonEmptyString(
          metadata['short-description'],
          `${fieldName}.metadata.short-description`,
          MAX_SKILL_SHORT_DESCRIPTION_LEN,
        );
      }
    }
  }

}

function isCodexTargeted(manifest) {
  return supportsManifestPlatform(manifest, 'codex');
}

function isClaudeTargeted(manifest) {
  return supportsManifestPlatform(manifest, 'claude');
}

function targetedPlatforms(manifest) {
  const platforms = [];
  if (isClaudeTargeted(manifest)) platforms.push('claude');
  if (isCodexTargeted(manifest)) platforms.push('codex');
  return platforms.length > 0 ? platforms : ['claude', 'codex'];
}

// ---------------------------------------------------------------------------
// Supplemental checks (always run — not covered by CLI validator)
// ---------------------------------------------------------------------------

function validateNameMatchesDirectory(pluginDir, manifest) {
  const pluginName = path.basename(pluginDir);
  if (manifest.name && manifest.name !== pluginName) {
    error(
      `manifest name "${manifest.name}" does not match directory name "${pluginName}"`,
    );
  }
}

function validateNoBuildOutputDirs(pluginDir) {
  if (fs.existsSync(path.join(pluginDir, '.claude-plugin'))) {
    error(
      '.claude-plugin/ directory must not exist in plugin source (it is a build output)',
    );
  }
  if (fs.existsSync(path.join(pluginDir, '.codex-plugin'))) {
    error(
      '.codex-plugin/ directory must not exist in plugin source (it is a build output)',
    );
  }
}

function validateDeclaredPathsExist(pluginDir, manifest) {
  for (const field of ['skills', 'slashCommands', 'mcpServers', 'apps']) {
    if (!manifest[field]) continue;
    const resolved = path.join(pluginDir, manifest[field]);
    if (!fs.existsSync(resolved)) {
      error(
        `${field} points to "${manifest[field]}" but path does not exist: ${resolved}`,
      );
    }
  }
}

function validateCanonicalSkillLayout(pluginDir, manifest) {
  if (manifest.skills && normalizeRelativePath(manifest.skills) !== 'skills') {
    error('skills must be "./skills"');
  }
  const pluginReadme = path.join(pluginDir, 'README.md');
  if (!fs.statSync(pluginReadme, { throwIfNoEntry: false })?.isFile()) {
    error('Plugin root README.md is required');
  } else {
    const content = fs.readFileSync(pluginReadme, 'utf8');
    if (content.trim() === '') error('Plugin root README.md must not be empty');
  }
  const declared = collectDeclaredSkillNames(pluginDir, manifest);
  const sourceBackedDynamicSkills = (Array.isArray(manifest.artifacts?.targets)
    ? manifest.artifacts.targets
    : [])
    .filter((target) =>
      target &&
      typeof target === 'object' &&
      (target.target === 'codex.skill' || target.target === 'claude.skill') &&
      typeof target.skillKey === 'string' &&
      Array.isArray(target.sourceDirs) &&
      target.sourceDirs.length > 0)
    .map((target) => target.skillKey.trim());
  for (const skill of new Set([...declared.static, ...sourceBackedDynamicSkills])) {
    const skillRoot = path.join(pluginDir, 'skills', skill);
    if (!fs.statSync(skillRoot, { throwIfNoEntry: false })?.isDirectory()) {
      error(`Skill ${JSON.stringify(skill)} must use source root "./skills/${skill}"`);
      continue;
    }
    const skillReadme = path.join(skillRoot, 'README.md');
    if (!fs.statSync(skillReadme, { throwIfNoEntry: false })?.isFile()) {
      error(`skills/${skill}/README.md is required`);
      continue;
    }
    const content = fs.readFileSync(skillReadme, 'utf8');
    if (content.trim() === '') {
      error(`skills/${skill}/README.md must not be empty`);
    }
  }
  const portableRoot = manifest.distributions?.agentSkills?.skills;
  for (const skill of declared.portable) {
    const skillRoot = path.join(pluginDir, portableRoot, skill);
    const skillReadme = path.join(skillRoot, 'README.md');
    if (!fs.statSync(skillReadme, { throwIfNoEntry: false })?.isFile()) {
      error(`${normalizeRelativePath(path.join(portableRoot, skill, 'README.md'))} is required`);
      continue;
    }
    if (fs.readFileSync(skillReadme, 'utf8').trim() === '') {
      error(`${normalizeRelativePath(path.join(portableRoot, skill, 'README.md'))} must not be empty`);
    }
  }
}

function validateDeclaredNativeAssets(pluginDir, manifest) {
  const defaults = [
    ['skills', 'skills'],
    [DEFAULT_SLASH_COMMANDS_DIR, 'slashCommands'],
    ['.mcp.json', 'mcpServers'],
    ['.app.json', 'apps'],
  ];
  for (const [filename, field] of defaults) {
    const fullPath = path.join(pluginDir, filename);
    if (fs.existsSync(fullPath) && !manifest[field]) {
      if (field === 'skills') {
        const dynamicSkills = new Set(
          (Array.isArray(manifest.artifacts?.targets) ? manifest.artifacts.targets : [])
            .filter((target) => {
              if (
                !target ||
                typeof target !== 'object' ||
                (target.target !== 'codex.skill' && target.target !== 'claude.skill') ||
                typeof target.skillKey !== 'string' ||
                !Array.isArray(target.sourceDirs) ||
                target.sourceDirs.length === 0
              ) return false;
              return target.sourceDirs.every((sourceDir) =>
                typeof sourceDir === 'string' &&
                (
                  normalizeRelativePath(sourceDir) === `skills/${target.skillKey}` ||
                  normalizeRelativePath(sourceDir).startsWith(`skills/${target.skillKey}/`)
                ));
            })
            .map((target) => target.skillKey),
        );
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        if (
          entries.length > 0 &&
          entries.every((entry) => entry.isDirectory() && dynamicSkills.has(entry.name))
        ) {
          continue;
        }
      }
      error(
        `"${filename}" exists but manifest does not declare "${field}" — declare it or remove the file`,
      );
    }
  }
}

function collectDeclaredSkillNames(pluginDir, manifest) {
  const skillsRoot =
    typeof manifest.skills === 'string'
      ? path.join(pluginDir, manifest.skills)
      : null;
  const staticSkillNames = skillsRoot && fs.existsSync(skillsRoot)
    ? fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    : [];
  const staticSkillNameSet = new Set(staticSkillNames);

  const artifactTargets = Array.isArray(manifest.artifacts?.targets)
    ? manifest.artifacts.targets
    : [];
  const dynamicSkillNames = artifactTargets
    .filter((target) =>
      target
      && typeof target === 'object'
      && (target.target === 'codex.skill' || target.target === 'claude.skill')
      && typeof target.skillKey === 'string'
      && target.skillKey.trim() !== '',
    )
    .map((target) => target.skillKey.trim())
    .sort();
  const dynamicSkillNameSet = new Set(dynamicSkillNames);
  const portableRoot = typeof manifest.distributions?.agentSkills?.skills === 'string'
    ? path.join(pluginDir, manifest.distributions.agentSkills.skills)
    : null;
  const portableRootStats = portableRoot
    ? fs.lstatSync(portableRoot, { throwIfNoEntry: false })
    : null;
  const portableSkillNameSet = new Set(
    portableRootStats?.isDirectory() && !portableRootStats.isSymbolicLink()
      ? fs.readdirSync(portableRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      : [],
  );

  return {
    static: staticSkillNameSet,
    dynamic: dynamicSkillNameSet,
    portable: portableSkillNameSet,
    all: new Set([...staticSkillNames, ...dynamicSkillNames]),
  };
}

function isNodeRunnablePath(relativePath) {
  return SCRIPT_NODE_EXTENSIONS.has(path.posix.extname(normalizeRelativePath(relativePath)));
}

function normalizePluginScriptPath(pluginDir, value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    error(`${fieldName} must be a non-empty string`);
    return null;
  }
  if (/\s|[;&|<>`]/.test(value) || value.includes('$(')) {
    error(`${fieldName} must be a file path, not an inline command`);
    return null;
  }
  if (!value.startsWith('./')) {
    error(`${fieldName} must start with "./"`);
    return null;
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    error(`${fieldName} must be relative to the plugin root`);
    return null;
  }

  const relativePath = normalizeRelativePath(value);
  if (relativePath === '.' || relativePath === '..' || relativePath.startsWith('../')) {
    error(`${fieldName} must stay inside the plugin root`);
    return null;
  }

  const absolutePath = path.resolve(pluginDir, relativePath);
  const relativeFromRoot = path.relative(pluginDir, absolutePath);
  if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
    error(`${fieldName} must stay inside the plugin root`);
    return null;
  }
  return relativePath;
}

function validateDeclaredScriptFile(pluginDir, relativePath, fieldName) {
  if (!relativePath) return;
  const absolutePath = path.join(pluginDir, relativePath);
  const stats = fs.statSync(absolutePath, { throwIfNoEntry: false });
  if (!stats?.isFile()) {
    error(`${fieldName} points to "${relativePath}" but the file does not exist`);
  }
}

function validateScriptEntry(pluginDir, value, fieldName, options = {}) {
  const entry = expectRecord(value, fieldName);
  if (!entry) return null;
  if ('command' in entry) {
    error(`${fieldName}.command is not supported; declare runner/path instead`);
  }
  validateAllowedKeys(entry, fieldName, ['runner', 'path', 'args']);

  const runner = validateManifestString(entry.runner, `${fieldName}.runner`);
  if (runner !== 'node') {
    error(`${fieldName}.runner must be "node"`);
  }

  const relativePath = normalizePluginScriptPath(pluginDir, entry.path, `${fieldName}.path`);
  validateDeclaredScriptFile(pluginDir, relativePath, `${fieldName}.path`);
  if (options.requireNodePath && relativePath && !isNodeRunnablePath(relativePath)) {
    error(`${fieldName}.path must use a Node runnable extension (.js, .mjs, or .cjs)`);
  }

  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args)) {
      error(`${fieldName}.args must be an array of strings`);
    } else {
      entry.args.forEach((arg, index) => {
        if (typeof arg !== 'string') {
          error(`${fieldName}.args[${index}] must be a string`);
        }
      });
    }
  }

  return runner && relativePath ? { runner, path: relativePath } : null;
}

function isNonRegistryDependencySpecifier(specifier) {
  const trimmed = String(specifier).trim();
  return (
    /^(?:workspace|file|link|portal):/i.test(trimmed) ||
    /^(?:git\+|git:|ssh:)/i.test(trimmed) ||
    /^https?:\/\//i.test(trimmed) ||
    /(?:\.tgz|\.tar\.gz)(?:[#?].*)?$/i.test(trimmed) ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('~') ||
    /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(trimmed)
  );
}

function readPackageDependencyNames(packageJson, fieldName, dependencyField) {
  const rawDependencies = packageJson[dependencyField];
  if (rawDependencies === undefined) return [];
  const dependencies = expectRecord(rawDependencies, `${fieldName}.${dependencyField}`);
  if (!dependencies) return [];
  const names = [];
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (typeof specifier !== 'string') {
      error(`${fieldName}.${dependencyField}.${name} must be a string specifier`);
      continue;
    }
    if (isNonRegistryDependencySpecifier(specifier)) {
      error(
        `${fieldName}.${dependencyField}.${name} uses non registry-backed specifier "${specifier}"`,
      );
    }
    names.push(name);
  }
  return names;
}

function validatePackageRoot(pluginDir, packageRootValue, fieldName) {
  const packageRoot = normalizePluginScriptPath(pluginDir, packageRootValue, fieldName);
  if (!packageRoot) return null;
  const absolutePackageRoot = path.join(pluginDir, packageRoot);
  const stats = fs.statSync(absolutePackageRoot, { throwIfNoEntry: false });
  if (!stats?.isDirectory()) {
    error(`${fieldName} must point to a package directory`);
    return { packageRoot, dependencies: [], devDependencies: [] };
  }

  for (const lockfile of ['package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    if (fs.existsSync(path.join(absolutePackageRoot, lockfile))) {
      error(`${fieldName} only supports pnpm-lock.yaml, found ${lockfile}`);
    }
  }
  const packageJsonPath = path.join(absolutePackageRoot, 'package.json');
  const lockfilePath = path.join(absolutePackageRoot, 'pnpm-lock.yaml');
  if (!fs.existsSync(packageJsonPath)) {
    error(`${fieldName} is missing package.json`);
  }
  if (!fs.existsSync(lockfilePath)) {
    error(`${fieldName} is missing pnpm-lock.yaml`);
  }

  let packageJson = {};
  if (fs.existsSync(packageJsonPath)) {
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch (e) {
      error(`${fieldName}/package.json is not valid JSON: ${e.message}`);
      packageJson = {};
    }
  }
  if (packageJson.optionalDependencies !== undefined) {
    error(`${fieldName}/package.json optionalDependencies are not supported`);
  }
  if (packageJson.bundledDependencies !== undefined || packageJson.bundleDependencies !== undefined) {
    error(`${fieldName}/package.json bundledDependencies are not supported`);
  }

  return {
    packageRoot,
    dependencies: readPackageDependencyNames(packageJson, fieldName, 'dependencies'),
    devDependencies: readPackageDependencyNames(packageJson, fieldName, 'devDependencies'),
  };
}

function isRelativeSpecifier(specifier) {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return `${scope}/${name ?? ''}`;
  }
  return specifier.split('/')[0];
}

function resolveRelativeJavaScriptImport(importer, specifier, pluginDir) {
  const importerDir = path.posix.dirname(importer);
  const normalized = path.posix.normalize(path.posix.join(importerDir, specifier));
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return { escaped: true, path: normalized };
  }
  const candidates = [
    normalized,
    `${normalized}.js`,
    `${normalized}.mjs`,
    `${normalized}.cjs`,
    path.posix.join(normalized, 'index.js'),
    path.posix.join(normalized, 'index.mjs'),
    path.posix.join(normalized, 'index.cjs'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(path.join(pluginDir, candidate)));
  return found ? { escaped: false, path: found } : { escaped: false, path: null };
}

function pathIsUnderPackageRoot(relativePath, packageRoot) {
  if (!packageRoot) return false;
  return relativePath === packageRoot || relativePath.startsWith(`${packageRoot}/`);
}

function scanNodeImportContract(pluginDir, entryPaths, options) {
  const queue = [...new Set(entryPaths.filter(Boolean).map(normalizeRelativePath))];
  const visited = new Set();
  const dependencies = new Set(options.packageMeta?.dependencies ?? []);
  const devDependencies = new Set(options.packageMeta?.devDependencies ?? []);
  const packageRoot = options.packageMeta?.packageRoot;

  while (queue.length > 0) {
    const relativePath = queue.shift();
    if (!relativePath || visited.has(relativePath)) continue;
    visited.add(relativePath);

    const absolutePath = path.join(pluginDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      error(`${options.label}: missing Node import file "${relativePath}"`);
      continue;
    }

    const source = fs.readFileSync(absolutePath, 'utf8');
    for (const { specifier } of scanJavaScriptImportSpecifiers(source)) {
      if (specifier.startsWith('node:')) continue;

      if (isRelativeSpecifier(specifier)) {
        const resolved = resolveRelativeJavaScriptImport(relativePath, specifier, pluginDir);
        if (resolved.escaped) {
          error(`${options.label}: relative import "${specifier}" from "${relativePath}" escapes the plugin root`);
          continue;
        }
        if (!resolved.path) {
          const requested = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier));
          if ((options.runtimeConfigSkillRoots ?? []).some((root) => (
            relativePath.startsWith(`${root}/`)
            && requested === path.posix.join(root, AW_RUNTIME_CONFIG_READER_PATH)
          ))) continue;
          error(`${options.label}: unable to resolve relative import "${specifier}" from "${relativePath}"`);
          continue;
        }
        queue.push(resolved.path);
        continue;
      }

      if (specifier.startsWith('/') || specifier.includes(':')) {
        error(`${options.label}: unsupported import specifier "${specifier}" from "${relativePath}"`);
        continue;
      }

      const packageName = packageNameFromSpecifier(specifier);
      if (!packageRoot) {
        error(`${options.label}: bare import "${specifier}" from "${relativePath}" requires scripts.node.packageRoot`);
        continue;
      }
      if (!pathIsUnderPackageRoot(relativePath, packageRoot)) {
        error(`${options.label}: bare import "${specifier}" from "${relativePath}" is outside scripts.node.packageRoot`);
        continue;
      }
      if (dependencies.has(packageName)) continue;
      if (devDependencies.has(packageName)) {
        if (!options.allowDevDependencies) {
          error(`${options.label}: runtime import "${specifier}" from "${relativePath}" uses dev dependency "${packageName}"`);
        }
        continue;
      }
      error(`${options.label}: import "${specifier}" from "${relativePath}" is not declared in dependencies`);
    }
  }
}

function listFilesRecursive(rootDir) {
  const output = [];
  if (!fs.existsSync(rootDir)) return output;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile()) {
        output.push(normalizeRelativePath(path.relative(rootDir, absolutePath)));
      }
    }
  };
  walk(rootDir);
  return output;
}

function validateConfigSchemaLightweight(config) {
  if (config === undefined) return;
  try {
    normalizePluginConfigDefinition(config);
  } catch (validationError) {
    error(validationError instanceof Error ? validationError.message : String(validationError));
  }
}

function configSchemaKeys(manifest) {
  const schema = manifest.config?.fields;
  return isRecord(schema) ? new Set(Object.keys(schema)) : new Set();
}

function defaultConfigValues(manifest) {
  const schema = manifest.config?.fields;
  const values = {};
  if (!isRecord(schema)) return values;
  for (const [key, field] of Object.entries(schema)) {
    if (isRecord(field) && field.default !== undefined) {
      values[key] = field.default;
    }
  }
  return values;
}

function configFieldContainsSensitiveValue(field) {
  if (!isRecord(field)) return false;
  if (field.sensitive === true) return true;
  if (field.type !== 'object') return false;
  return (
    (isRecord(field.properties)
      && Object.values(field.properties).some((child) =>
        isRecord(child) && child.sensitive === true))
    || (isRecord(field.additionalProperties)
      && field.additionalProperties.sensitive === true)
  );
}

function codexStaticNativeComponentKeys(manifest) {
  if (!isCodexTargeted(manifest)) return [];
  const keys = [];
  if (manifest.skills) keys.push('skills');
  if (manifest.mcpServers) keys.push('mcpServers');
  if (
    (
      Array.isArray(manifest.extensions?.hooks)
      && manifest.extensions.hooks.some((hook) => hook?.agentOverrides?.codex !== null)
    )
    || (
      Array.isArray(manifest.extensions?.nativeHooks?.codex)
      && manifest.extensions.nativeHooks.codex.length > 0
    )
  ) keys.push('hooks');
  if (manifest.apps) keys.push('apps');
  return keys;
}

function validateArtifactId(value, fieldName) {
  const id = validateManifestString(value, fieldName);
  if (!id) return null;
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(id)) {
    error(`${fieldName}: expected a stable id using letters, numbers, ".", "_" or "-"`);
  }
  return id;
}

function validateCodexRoleKey(value, fieldName) {
  const roleKey = validateManifestString(value, fieldName);
  if (!roleKey) return null;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(roleKey)) {
    error(`${fieldName}: expected a valid Codex role key`);
  }
  return roleKey;
}

function validateCodexSkillKey(value, fieldName) {
  const skillKey = validateManifestString(value, fieldName);
  if (!skillKey) return null;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(skillKey)) {
    error(`${fieldName}: expected a valid Codex skill key`);
  }
  return skillKey;
}

function validatePortableSkillKey(value, fieldName) {
  const skillKey = validateManifestString(value, fieldName);
  if (!skillKey) return null;
  if (skillKey.length > MAX_SKILL_NAME_LEN || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillKey)) {
    error(`${fieldName}: expected at most 64 ASCII lowercase hyphen-case characters`);
  }
  return skillKey;
}

function validateStringArray(value, fieldName, options = {}) {
  if (!Array.isArray(value)) {
    error(`${fieldName} must be an array`);
    return [];
  }

  const output = [];
  for (const [index, entry] of value.entries()) {
    const itemFieldName = `${fieldName}[${index}]`;
    if (typeof entry !== 'string' || entry.trim() === '') {
      error(`${itemFieldName} must be a non-empty string`);
      continue;
    }
    if (options.allowed && !options.allowed.has(entry)) {
      error(`${itemFieldName}: unsupported ${options.label ?? 'value'} "${entry}"`);
      continue;
    }
    if (!output.includes(entry)) output.push(entry);
  }

  if (options.requireNonEmpty && output.length === 0) {
    error(`${fieldName} must contain at least one value`);
  }

  return output;
}

function validateArtifactTargetEntry(entry, index, manifest, pluginDir) {
  const fieldName = `artifacts.targets[${index}]`;
  const target = expectRecord(entry, fieldName);
  if (!target) return null;

  validateAllowedKeys(target, fieldName, [
    'id',
    'platform',
    'distribution',
    'scopes',
    'target',
    'kind',
    'projectManagedKind',
    'states',
    'refreshKeys',
    'delivery',
    'requiresCodexProjectConfig',
    'roleKey',
    'skillKey',
    'sourceDirs',
    'runtimeImports',
    'runtimeConfig',
  ]);

  const id = validateArtifactId(target.id, `${fieldName}.id`);
  const artifactTarget = validateManifestString(target.target, `${fieldName}.target`);
  if (artifactTarget && !ARTIFACT_TARGETS.has(artifactTarget)) {
    error(`${fieldName}.target: unsupported artifact target "${artifactTarget}"`);
  }
  const portable = artifactTarget === 'agent-skills.skill';
  let delivery;
  if (artifactTarget === 'codex.skill') {
    delivery = expectRecord(target.delivery, `${fieldName}.delivery`);
    if (delivery) {
      if (delivery.mode === 'aw-extension') {
        validateAllowedKeys(delivery, `${fieldName}.delivery`, ['mode']);
      } else if (delivery.mode === 'codex-native') {
        validateAllowedKeys(delivery, `${fieldName}.delivery`, ['mode', 'identity', 'renderProfile']);
        if (delivery.identity !== 'shared') {
          error(`${fieldName}.delivery.identity: expected "shared"`);
        }
        if (delivery.renderProfile !== 'user') {
          error(`${fieldName}.delivery.renderProfile: expected "user"`);
        }
      } else {
        error(`${fieldName}.delivery.mode: expected "codex-native" or "aw-extension"`);
      }
    }
  } else if (target.delivery !== undefined) {
    error(`${fieldName}.delivery: delivery is only supported for codex.skill targets`);
  }
  const platform = portable || target.platform === undefined
    ? undefined
    : validateManifestString(target.platform, `${fieldName}.platform`);
  const distribution = portable || target.distribution !== undefined
    ? validateManifestString(target.distribution, `${fieldName}.distribution`)
    : undefined;
  if (portable) {
    if (distribution !== 'agent-skills') {
      error(`${fieldName}.distribution: expected "agent-skills"`);
    }
    if (target.platform !== undefined) {
      error(`${fieldName}.platform: distribution targets do not support platform`);
    }
  } else {
    const expectedPlatform = artifactTarget === 'claude.skill' ? 'claude' : 'codex';
    if (platform && artifactTarget && platform !== expectedPlatform) {
      error(`${fieldName}.platform: target "${artifactTarget}" must use "${expectedPlatform}"`);
    }
    if (target.distribution !== undefined) {
      error(`${fieldName}.distribution: platform targets do not support distribution`);
    }
  }

  const expectedKind = ARTIFACT_KIND_BY_TARGET[artifactTarget];
  const kind = target.kind === undefined
    ? expectedKind
    : validateManifestString(target.kind, `${fieldName}.kind`);
  if (kind && !ARTIFACT_KINDS.has(kind)) {
    error(`${fieldName}.kind: unsupported artifact kind "${kind}"`);
  }
  if (expectedKind && kind && kind !== expectedKind) {
    error(`${fieldName}.kind: target "${artifactTarget}" requires kind "${expectedKind}"`);
  }

  const expectedProjectManagedKind = ARTIFACT_PROJECT_MANAGED_KIND_BY_TARGET[artifactTarget];
  const projectManagedKind = target.projectManagedKind === undefined
    ? expectedProjectManagedKind
    : validateManifestString(target.projectManagedKind, `${fieldName}.projectManagedKind`);
  if (projectManagedKind && !ARTIFACT_PROJECT_MANAGED_KINDS.has(projectManagedKind)) {
    error(`${fieldName}.projectManagedKind: unsupported Codex project managed kind "${projectManagedKind}"`);
  }
  if (
    expectedProjectManagedKind &&
    projectManagedKind &&
    projectManagedKind !== expectedProjectManagedKind
  ) {
    error(
      `${fieldName}.projectManagedKind: target "${artifactTarget}" must map to "${expectedProjectManagedKind}"`,
    );
  }
  if (!expectedProjectManagedKind && projectManagedKind) {
    error(`${fieldName}.projectManagedKind: target "${artifactTarget}" does not support projectManagedKind`);
  }

  const scopes = validateStringArray(target.scopes, `${fieldName}.scopes`, {
    allowed: ARTIFACT_SCOPES,
    label: 'artifact scope',
    requireNonEmpty: true,
  });
  const states = validateStringArray(target.states, `${fieldName}.states`, {
    allowed: ARTIFACT_STATES,
    label: 'artifact state',
    requireNonEmpty: true,
  });
  const refreshKeys = validateStringArray(target.refreshKeys, `${fieldName}.refreshKeys`);
  const schemaKeys = configSchemaKeys(manifest);
  for (const [refreshIndex, refreshKey] of refreshKeys.entries()) {
    if (!schemaKeys.has(refreshKey)) {
      error(`${fieldName}.refreshKeys[${refreshIndex}]: unknown config key "${refreshKey}"`);
      continue;
    }
    const sensitiveRefreshKey = configFieldContainsSensitiveValue(
      manifest.config?.fields?.[refreshKey],
    );
    const skillTarget = artifactTarget === 'codex.skill'
      || artifactTarget === 'claude.skill'
      || artifactTarget === 'agent-skills.skill';
    if (skillTarget && sensitiveRefreshKey) {
      const native = delivery?.mode === 'codex-native';
      error(
        `${native ? 'codexNativeRenderSensitiveRefreshKey' : 'skillRenderSensitiveRefreshKey'}: ` +
          `${fieldName}.refreshKeys[${refreshIndex}]: ` +
          `${native ? 'codex-native renderers' : 'Skill renderers'} cannot read sensitive config field "${refreshKey}"`,
      );
    }
  }

  if (
    target.requiresCodexProjectConfig !== undefined &&
    typeof target.requiresCodexProjectConfig !== 'boolean'
  ) {
    error(`${fieldName}.requiresCodexProjectConfig must be a boolean`);
  }
  if (artifactTarget === 'codex.skill' && target.requiresCodexProjectConfig === true) {
    error(`${fieldName}.requiresCodexProjectConfig: codex.skill writes the skill runtime and must not require Codex project config preflight`);
  }
  if ((platform === 'claude' || portable) && target.requiresCodexProjectConfig !== undefined) {
    error(`${fieldName}.requiresCodexProjectConfig: this target does not support the field`);
  }

  let roleKey;
  let skillKey;
  if (artifactTarget === 'codex.agentRole') {
    roleKey = validateCodexRoleKey(target.roleKey, `${fieldName}.roleKey`);
    if (!roleKey) {
      error(`${fieldName}.roleKey: codex.agentRole targets must declare a static roleKey`);
    }
  } else if (target.roleKey !== undefined) {
    error(`${fieldName}.roleKey: roleKey is only supported for codex.agentRole targets`);
  }
  if (artifactTarget === 'codex.skill' || artifactTarget === 'claude.skill' || portable) {
    skillKey = portable
      ? validatePortableSkillKey(target.skillKey, `${fieldName}.skillKey`)
      : validateCodexSkillKey(target.skillKey, `${fieldName}.skillKey`);
    if (!skillKey) {
      error(`${fieldName}.skillKey: ${artifactTarget} targets must declare a static skillKey`);
    }
  } else if (target.skillKey !== undefined) {
    error(`${fieldName}.skillKey: skillKey is only supported for skill targets`);
  }

  const normalizedSourceDirs = Array.isArray(target.sourceDirs)
    ? target.sourceDirs
      .filter((sourceDir) => typeof sourceDir === 'string' && sourceDir.trim() !== '')
      .map((sourceDir) => path.posix.normalize(sourceDir))
    : [];
  if (new Set(normalizedSourceDirs).size !== normalizedSourceDirs.length) {
    error(`${fieldName}.sourceDirs must not contain duplicate directories`);
  }
  const sourceDirs = target.sourceDirs === undefined
    ? []
    : validateStringArray(target.sourceDirs, `${fieldName}.sourceDirs`);
  if (sourceDirs.length > 0 && artifactTarget !== 'codex.skill' && artifactTarget !== 'claude.skill' && !portable) {
    error(`${fieldName}.sourceDirs: sourceDirs are only supported for skill targets`);
  }
  for (const [sourceIndex, sourceDir] of sourceDirs.entries()) {
    const sourceField = `${fieldName}.sourceDirs[${sourceIndex}]`;
    if (!sourceDir.startsWith('./') || path.posix.isAbsolute(sourceDir)) {
      error(`${sourceField} must start with "./" and stay inside the plugin root`);
      continue;
    }
    const normalized = path.posix.normalize(sourceDir);
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      error(`${sourceField} must stay inside the plugin root`);
      continue;
    }
    const stats = fs.lstatSync(path.join(pluginDir, normalized), { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      error(`${sourceField} must point to an existing directory`);
    }
    if (
      skillKey && !portable &&
      normalized !== `skills/${skillKey}` &&
      !normalized.startsWith(`skills/${skillKey}/`)
    ) {
      error(`${sourceField} must stay inside "./skills/${skillKey}"`);
    }
    if (
      skillKey && !portable &&
      isSkillAuthorOnlyPath(path.posix.relative(`skills/${skillKey}`, normalized))
    ) {
      error(`${sourceField} must not point inside an author-only Skill directory`);
    }
  }
  if (
    skillKey && !portable &&
    sourceDirs.length > 0 &&
    !normalizedSourceDirs.includes(`skills/${skillKey}`)
  ) {
    error(`${fieldName}.sourceDirs must include "./skills/${skillKey}" so README.md is published`);
  }

  return {
    id,
    platform,
    distribution,
    scopes,
    target: artifactTarget,
    kind,
    projectManagedKind,
    states,
    refreshKeys,
    delivery,
    roleKey,
    skillKey,
    sourceDirs,
    runtimeConfig: target.runtimeConfig,
    runtimeImports: Array.isArray(target.runtimeImports) ? target.runtimeImports : [],
  };
}

function validateArtifactsConfigLightweight(pluginDir, manifest) {
  if (manifest.artifacts === undefined) return [];
  const artifacts = expectRecord(manifest.artifacts, 'artifacts');
  if (!artifacts) return [];
  validateAllowedKeys(artifacts, 'artifacts', ['targets']);
  if (artifacts.targets === undefined) return [];
  if (!Array.isArray(artifacts.targets)) {
    error('artifacts.targets must be an array');
    return [];
  }

  const declarations = artifacts.targets
    .map((entry, index) => validateArtifactTargetEntry(entry, index, manifest, pluginDir))
    .filter(Boolean);
  const idsBySurfaceScope = new Map();
  const nativeIds = new Map();
  const nativeSkillKeys = new Map();
  for (const [declarationIndex, declaration] of declarations.entries()) {
    for (const scope of declaration.scopes) {
      const surface = declaration.platform ?? declaration.distribution;
      const key = `${surface}:${scope}:${declaration.id}`;
      const existing = idsBySurfaceScope.get(key);
      if (existing !== undefined) {
        error(
          `artifacts.targets has duplicate artifact id "${declaration.id}" for surface/scope "${surface}:${scope}" in targets[${existing}] and targets[${declarationIndex}]`,
        );
      } else {
        idsBySurfaceScope.set(key, declarationIndex);
      }
    }
    if (declaration.delivery?.mode === 'codex-native') {
      const existingId = nativeIds.get(declaration.id);
      if (existingId !== undefined) {
        error(
          `artifacts.targets has duplicate codex-native artifact id "${declaration.id}" in the shared projection at targets[${existingId}] and targets[${declarationIndex}]`,
        );
      } else {
        nativeIds.set(declaration.id, declarationIndex);
      }
      const existingSkillKey = nativeSkillKeys.get(declaration.skillKey);
      if (existingSkillKey !== undefined) {
        error(
          `artifacts.targets has duplicate codex-native skillKey "${declaration.skillKey}" in the shared projection at targets[${existingSkillKey}] and targets[${declarationIndex}]`,
        );
      } else {
        nativeSkillKeys.set(declaration.skillKey, declarationIndex);
      }
    }
  }
  const nativeComponents = codexStaticNativeComponentKeys(manifest).map((key) => ({
    key,
    scopes: ['project', 'user'],
  }));
  declarations.forEach((declaration, index) => {
    if (declaration.delivery?.mode === 'codex-native') {
      nativeComponents.push({ key: `artifacts.targets[${index}]`, scopes: declaration.scopes });
    }
  });
  const expectedNativeComponent = nativeComponents[0];
  if (expectedNativeComponent) {
    const canonicalScopes = (component) => [...component.scopes].sort().join(',');
    const expectedScopes = canonicalScopes(expectedNativeComponent);
    const mismatch = nativeComponents.find((component) =>
      canonicalScopes(component) !== expectedScopes);
    if (mismatch) {
      error(
        `codexSharedNativeScopeMismatch: Codex native component scope sets must match exactly; ` +
          `${expectedNativeComponent.key} has {${expectedScopes}} but ${mismatch.key} has ` +
          `{${canonicalScopes(mismatch)}}`,
      );
    }
  }
  const staticSkillNames = new Set(collectDeclaredSkillNames(pluginDir, manifest).static);
  for (const [index, declaration] of declarations.entries()) {
    if (
      declaration.target === 'codex.skill'
      && declaration.delivery?.mode === 'codex-native'
      && staticSkillNames.has(declaration.skillKey)
    ) {
      error(
        `artifacts.targets[${index}].skillKey: native dynamic Skill "${declaration.skillKey}" conflicts with a static Skill of the same name`,
      );
    }
  }
  const owners = new Map();
  for (const declaration of declarations) {
    if (
      (declaration.target !== 'codex.skill' && declaration.target !== 'claude.skill' && declaration.target !== 'agent-skills.skill') ||
      !declaration.skillKey
    ) {
      continue;
    }
    for (const scope of declaration.scopes) {
      const ownerKey = `${declaration.platform ?? declaration.distribution}:${scope}:${declaration.skillKey}`;
      const existing = owners.get(ownerKey);
      if (existing) {
        error(
          `artifacts.targets has duplicate skill ownership "${ownerKey}" in artifacts "${existing}" and "${declaration.id}"`,
        );
      } else {
        owners.set(ownerKey, declaration.id);
      }
    }
  }
  return declarations;
}

function validateArtifactPlanRefreshKeys(refreshKeys, declaration, fieldName) {
  const keys = validateStringArray(refreshKeys, `${fieldName}.refreshKeys`);
  for (const [index, key] of keys.entries()) {
    if (!declaration.refreshKeys.includes(key)) {
      error(`${fieldName}.refreshKeys[${index}]: "${key}" is not declared for artifact "${declaration.id}"`);
    }
  }
  for (const declaredKey of declaration.refreshKeys) {
    if (!keys.includes(declaredKey)) {
      error(`${fieldName}: artifact "${declaration.id}" must preserve declared refresh key "${declaredKey}"`);
    }
  }
}

function isValidArtifactFilePath(relativePath) {
  return (
    relativePath.trim() !== '' &&
    !relativePath.includes('\\') &&
    !relativePath.startsWith('/') &&
    path.posix.normalize(relativePath) === relativePath &&
    !relativePath.split('/').some((segment) =>
      segment === '' || segment === '.' || segment === '..')
  );
}

function isSkillAuthorOnlyPath(relativePath) {
  const [topLevel] = relativePath.split('/').filter(Boolean);
  return topLevel === 'evals' || topLevel === 'reports';
}

function collectArtifactSourceFiles(rootDir, fieldName, files) {
  const rootStats = fs.lstatSync(rootDir, { throwIfNoEntry: false });
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return;

  const visit = (currentDir, parentPath) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      if (isSkillAuthorOnlyPath(relativePath)) continue;
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        error(`${fieldName} contains unsupported symbolic link "${relativePath}"`);
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        error(`${fieldName} contains unsupported non-regular file "${relativePath}"`);
        continue;
      }
      files.set(relativePath, fs.readFileSync(absolutePath));
    }
  };

  visit(rootDir, '');
}

function findArtifactFilePrefixConflict(files) {
  const paths = [...files.keys()].sort();
  for (const [index, relativePath] of paths.entries()) {
    const prefix = paths.slice(0, index).find((candidate) =>
      relativePath.startsWith(`${candidate}/`));
    if (prefix) return [prefix, relativePath];
  }
  return null;
}

function authorRuntimeImportKey(artifactId, importIndex) {
  return `${artifactId}\0${importIndex}`;
}

async function resolveAuthorRuntimeImports(options) {
  const artifactImports = (options.manifest.artifacts?.targets ?? []).flatMap((target) =>
    (target.runtimeImports ?? []).map((reference, importIndex) => ({
      key: authorRuntimeImportKey(target.id, importIndex),
      label: `artifacts target ${JSON.stringify(target.id)} runtime import ${JSON.stringify(reference.name)}`,
      purpose: 'artifact-runtime',
      reference,
    })));
  const skillRuntimeImports = (options.manifest.buildConfig?.skillRuntimeFiles ?? []).flatMap(
    (entry, importIndex) => {
      if (!isRecord(entry.import)) return [];
      const platforms = [
        ...(entry.platforms !== undefined || entry.distributions === undefined
          ? (entry.platforms ?? [...resolveSupportedPlatforms(options.manifest)])
          : []),
        ...(entry.distributions?.includes('agent-skills') ? [undefined] : []),
      ];
      return platforms.length > 0 ? [{
        key: importIndex,
        label: `buildConfig.skillRuntimeFiles[${importIndex}].import`,
        purpose: 'skill-runtime-file',
        reference: entry.import,
        platforms,
      }] : [];
    },
  );
  const requested = [...artifactImports, ...skillRuntimeImports];
  if (requested.length === 0) {
    return { artifactImports: new Map(), skillRuntimeImports: new Map() };
  }
  if (
    !options.repoRoot
    || typeof options.cliManifestTools?.readPluginManifest !== 'function'
    || typeof options.cliManifestTools?.discoverPlugins !== 'function'
    || typeof options.cliManifestTools?.createRuntimeResolver !== 'function'
  ) {
    error('Portable runtime imports require a complete built CLI and canonical same-source Git workspace.');
    return null;
  }

  let consumer;
  let resolver;
  try {
    const sourceSet = await options.cliManifestTools.discoverPlugins(options.repoRoot);
    consumer = await options.cliManifestTools.readPluginManifest(options.pluginDir);
    if (!sourceSet.some((candidate) => candidate.manifest.name === consumer.manifest.name)) {
      sourceSet.push(consumer);
    }
    resolver = options.cliManifestTools.createRuntimeResolver(sourceSet);
  } catch {
    error('Portable runtime imports could not load the canonical same-source plugin set.');
    return null;
  }

  const resolvedArtifacts = new Map();
  const resolvedSkillRuntimeFiles = new Map();
  for (const request of requested) {
    let value;
    try {
      for (const platform of request.platforms ?? [undefined]) {
        const resolution = await resolver.resolve({
          consumer,
          reference: request.reference,
          purpose: request.purpose,
          platform,
        });
        const bytes = fs.readFileSync(resolution.sourcePath);
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (digest !== resolution.sourceDigest) throw new Error('runtime export changed during resolution');
        const current = {
          bytes,
          digest: resolution.sourceDigest,
          providerPluginId: resolution.provider,
          providerVersion: resolution.providerVersion,
          exportName: resolution.name,
          source: resolution.source,
        };
        if (value && (
          value.digest !== current.digest
          || value.providerPluginId !== current.providerPluginId
          || value.providerVersion !== current.providerVersion
          || value.exportName !== current.exportName
          || value.source !== current.source
        )) {
          throw new Error('runtime export changed between projection surfaces');
        }
        value = current;
      }
    } catch {
      const provider = typeof request.reference.plugin === 'string'
        ? JSON.stringify(request.reference.plugin)
        : '<invalid-provider>';
      const exportName = typeof request.reference.export === 'string'
        ? JSON.stringify(request.reference.export)
        : '<invalid-export>';
      error(`Cannot resolve ${request.label} from provider ${provider} export ${exportName}.`);
      continue;
    }
    if (request.purpose === 'artifact-runtime') resolvedArtifacts.set(request.key, value);
    else resolvedSkillRuntimeFiles.set(request.key, value);
  }
  return {
    artifactImports: resolvedArtifacts,
    skillRuntimeImports: resolvedSkillRuntimeFiles,
  };
}

function overlayPortableRuntimeFiles(files, manifest, pluginDir, skillKey, runtimeImports) {
  for (const [runtimeIndex, runtimeFile] of (manifest.buildConfig?.skillRuntimeFiles ?? []).entries()) {
    if (
      runtimeFile.skill !== skillKey
      || !runtimeFile.distributions?.includes('agent-skills')
    ) continue;
    if (typeof runtimeFile.source === 'string') {
      const sourcePath = path.join(pluginDir, normalizeRelativePath(runtimeFile.source));
      const stats = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
      if (!stats?.isFile() || stats.isSymbolicLink()) {
        error(`buildConfig.skillRuntimeFiles[${runtimeIndex}].source must point to a regular file`);
        continue;
      }
      files.set(runtimeFile.target, fs.readFileSync(sourcePath));
      continue;
    }
    if (isRecord(runtimeFile.import)) {
      const resolved = runtimeImports?.skillRuntimeImports.get(runtimeIndex);
      if (!resolved) {
        error(`buildConfig.skillRuntimeFiles[${runtimeIndex}].import could not be resolved`);
        continue;
      }
      files.set(runtimeFile.target, resolved.bytes);
    }
  }
}

function validateRenderedSkillTree(options) {
  const {
    entry,
    declaration,
    fieldName,
    pluginDir,
    manifest,
    materializedRoot,
    skillValidationTools,
  } = options;
  if (entry.state !== 'present' || !isRecord(entry.content) || !isRecord(entry.content.files)) {
    return;
  }

  const files = new Map();
  declaration.sourceDirs.forEach((sourceDir, index) => {
    collectArtifactSourceFiles(
      path.join(pluginDir, normalizeRelativePath(sourceDir)),
      `artifacts.targets sourceDirs[${index}] for artifact "${declaration.id}"`,
      files,
    );
  });
  if (declaration.target === 'agent-skills.skill') {
    overlayPortableRuntimeFiles(
      files,
      manifest,
      pluginDir,
      declaration.skillKey,
      options.runtimeImports,
    );
  }
  for (const [relativePath, content] of Object.entries(entry.content.files)) {
    if (isSkillAuthorOnlyPath(relativePath)) {
      error(`${fieldName}.content.files path "${relativePath}" uses an author-only Skill directory`);
      continue;
    }
    if (isValidArtifactFilePath(relativePath) && typeof content === 'string') {
      files.set(relativePath, Buffer.from(content, 'utf8'));
    }
  }

  const conflict = findArtifactFilePrefixConflict(files);
  if (conflict) {
    error(`${fieldName} final file tree path "${conflict[0]}" conflicts with "${conflict[1]}"`);
    return;
  }

  const skillFile = files.get('SKILL.md');
  if (!skillFile || skillFile.toString('utf8').trim() === '') {
    error(`${fieldName} final file tree must contain a non-empty SKILL.md`);
  } else if (!skillValidationTools) {
    error(`${fieldName} final SKILL.md cannot be validated because the shared CLI Skill validator is unavailable`);
  } else {
    const sourcePath = `${fieldName} final SKILL.md`;
    const parsed = skillValidationTools.parseSkillFrontmatter(
      skillFile.toString('utf8'),
      sourcePath,
    );
    for (const diagnostic of parsed.errors) {
      error(`${diagnostic.path} [${diagnostic.code}] ${diagnostic.message}`);
    }
    if (parsed.frontmatter) {
      const diagnostics = skillValidationTools.validateSkillFrontmatter(parsed.frontmatter, {
        profile: declaration.platform === 'claude' ? 'claude-2.1.88' : 'portable-agent-skills',
        expectedName: declaration.skillKey,
        sourcePath,
      });
      for (const diagnostic of diagnostics) {
        error(`${diagnostic.path} [${diagnostic.code}] ${diagnostic.message}`);
      }
    }
  }
  const readme = files.get('README.md');
  if (!readme || readme.toString('utf8').trim() === '') {
    error(`${fieldName} final file tree must contain a non-empty README.md`);
  }

  for (const [relativePath, content] of files) {
    const text = content.toString('utf8');
    if (/\{\{[^{}]+\}\}/u.test(text)) {
      error(`${fieldName} final file tree contains an unresolved template in "${relativePath}"`);
    }
  }

  if (declaration.target === 'codex.skill') {
    const openAiYaml = files.get('agents/openai.yaml');
    if (!openAiYaml || openAiYaml.toString('utf8').trim() === '') {
      error(`${fieldName} final file tree must contain a non-empty agents/openai.yaml`);
    }
  }

  fs.rmSync(materializedRoot, { recursive: true, force: true });
  for (const [relativePath, content] of files) {
    const targetPath = path.join(materializedRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }
  if (declaration.target === 'codex.skill' && files.has('agents/openai.yaml')) {
    validateOpenAiYaml(
      path.join(materializedRoot, 'agents', 'openai.yaml'),
      declaration.skillKey,
      true,
      manifest,
      materializedRoot,
      skillValidationTools,
    );
  }
}

function validateStaticPortableFinalTrees(
  pluginDir,
  manifest,
  runtimeImports,
  skillValidationTools,
) {
  const portableRoot = manifest.distributions?.agentSkills?.skills;
  if (typeof portableRoot !== 'string') return;
  const rootDir = path.join(pluginDir, normalizeRelativePath(portableRoot));
  const rootStats = fs.lstatSync(rootDir, { throwIfNoEntry: false });
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return;
  const dynamicKeys = new Set(
    (manifest.artifacts?.targets ?? [])
      .filter((target) => target.target === 'agent-skills.skill' && typeof target.skillKey === 'string')
      .map((target) => target.skillKey),
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-static-portable-final-'));
  try {
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || dynamicKeys.has(entry.name)) continue;
      validateRenderedSkillTree({
        entry: { state: 'present', content: { files: {} } },
        declaration: {
          id: `static:${entry.name}`,
          distribution: 'agent-skills',
          target: 'agent-skills.skill',
          skillKey: entry.name,
          sourceDirs: [`${portableRoot}/${entry.name}`],
        },
        fieldName: `static portable Skill "${entry.name}"`,
        pluginDir,
        manifest,
        runtimeImports,
        materializedRoot: path.join(tempRoot, entry.name),
        skillValidationTools,
      });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validateRenderedArtifactPlan(plan, declarations, scopeLabel, options) {
  const planField = `scripts.artifacts.render fixture (${scopeLabel})`;
  const root = expectRecord(plan, planField);
  if (!root) return;
  validateAllowedKeys(root, planField, ['version', 'artifacts']);
  if (root.version !== 2) {
    error(`${planField}.version must be 2`);
  }
  if (!Array.isArray(root.artifacts)) {
    error(`${planField}.artifacts must be an array`);
    return;
  }

  const byKey = new Map(declarations.map((target) => [`${target.id}:${target.target}`, target]));
  const returned = new Set();

  root.artifacts.forEach((artifact, index) => {
    const fieldName = `${planField}.artifacts[${index}]`;
    const entry = expectRecord(artifact, fieldName);
    if (!entry) return;
    validateAllowedKeys(entry, fieldName, [
      'id',
      'platform',
      'distribution',
      'target',
      'kind',
      'state',
      'refreshKeys',
      'disabledReason',
      'roleKey',
      'skillKey',
      'content',
    ]);
    const id = validateArtifactId(entry.id, `${fieldName}.id`);
    const target = validateManifestString(entry.target, `${fieldName}.target`);
    const key = id && target ? `${id}:${target}` : null;
    const declaration = key ? byKey.get(key) : null;
    if (!declaration) {
      error(`${fieldName}: artifact "${key ?? '<unknown>'}" is not declared for ${scopeLabel}`);
      return;
    }
    if (returned.has(key)) {
      error(`${fieldName}: duplicate artifact id + target "${key}"`);
    }
    returned.add(key);

    if (declaration.distribution) {
      if (entry.distribution !== declaration.distribution) {
        error(`${fieldName}.distribution: expected "${declaration.distribution}"`);
      }
      if (entry.platform !== undefined) {
        error(`${fieldName}.platform: distribution artifacts do not support platform`);
      }
    } else if (entry.platform !== declaration.platform) {
      error(`${fieldName}.platform: expected "${declaration.platform}"`);
    }
    if (entry.kind !== declaration.kind) {
      error(`${fieldName}.kind: expected "${declaration.kind}"`);
    }
    if (!declaration.states.includes(entry.state)) {
      error(`${fieldName}.state: "${entry.state}" is not declared for artifact "${declaration.id}"`);
    }
    validateArtifactPlanRefreshKeys(entry.refreshKeys, declaration, fieldName);
    if (entry.state === 'present' && entry.content === undefined) {
      error(`${fieldName}.content is required when state is "present"`);
    }
    if (
      entry.disabledReason !== undefined &&
      (typeof entry.disabledReason !== 'string' || entry.disabledReason.trim() === '')
    ) {
      error(`${fieldName}.disabledReason must be a non-empty string`);
    }
    if (declaration.target === 'codex.agentRole') {
      if (entry.roleKey !== declaration.roleKey) {
        error(`${fieldName}.roleKey: expected "${declaration.roleKey}" from static metadata`);
      }
      if (isRecord(entry.content)) {
        const registration = entry.content.registration;
        if (isRecord(registration) && registration.config_file !== undefined) {
          error(`${fieldName}.content.registration.config_file must be generated by AW, not renderer`);
        }
        const roleFile = entry.content.roleFile;
        if (isRecord(roleFile) && roleFile.name !== declaration.roleKey) {
          error(`${fieldName}.content.roleFile.name: expected "${declaration.roleKey}"`);
        }
      }
    } else if (entry.roleKey !== undefined) {
      error(`${fieldName}.roleKey is only supported for codex.agentRole artifacts`);
    }
    if (declaration.target === 'codex.skill' || declaration.target === 'claude.skill' || declaration.target === 'agent-skills.skill') {
      if (entry.skillKey !== declaration.skillKey) {
        error(`${fieldName}.skillKey: expected "${declaration.skillKey}" from static metadata`);
      }
      if (entry.state === 'present') {
        if (!isRecord(entry.content)) {
          error(`${fieldName}.content must be an object for dynamic skill artifacts`);
        } else {
          validateAllowedKeys(entry.content, `${fieldName}.content`, ['files']);
          const files = expectRecord(entry.content.files, `${fieldName}.content.files`);
          if (files) {
            const filePaths = Object.keys(files).sort();
            for (const [relativePath, content] of Object.entries(files)) {
              if (!isValidArtifactFilePath(relativePath)) {
                error(`${fieldName}.content.files path "${relativePath}" must be a normalized POSIX relative path`);
              }
              if (typeof content !== 'string') {
                error(`${fieldName}.content.files.${relativePath} must be a string`);
              }
            }
            for (const [pathIndex, relativePath] of filePaths.entries()) {
              const conflict = filePaths.slice(0, pathIndex).find((candidate) =>
                relativePath.startsWith(`${candidate}/`));
              if (conflict) {
                error(`${fieldName}.content.files path "${conflict}" conflicts with "${relativePath}"`);
              }
            }
          }
        }
        validateRenderedSkillTree({
          entry,
          declaration,
          fieldName,
          pluginDir: options.pluginDir,
          manifest: options.manifest,
          runtimeImports: options.runtimeImports,
          materializedRoot: path.join(options.tempRoot, `${declaration.platform ?? declaration.distribution}-${scopeLabel.split('/')[1]}-${index}`),
          skillValidationTools: options.skillValidationTools,
        });
      }
    } else if (entry.skillKey !== undefined) {
      error(`${fieldName}.skillKey is only supported for dynamic skill artifacts`);
    }
  });

  for (const declaration of declarations) {
    const key = `${declaration.id}:${declaration.target}`;
    if (!returned.has(key)) {
      error(`${planField}: renderer must return artifact "${declaration.id}" target "${declaration.target}"`);
    }
  }
}

function resolveArtifactRendererFixtureRequests(declarations, manifest) {
  const awOwned = new Map();
  const codexNative = new Map();
  for (const declaration of declarations) {
    if (declaration.delivery?.mode === 'codex-native') {
      const scope = declaration.scopes.includes('user') ? 'user' : 'project';
      const request = codexNative.get(scope) ?? {
        kind: 'codex-native',
        surface: 'codex',
        scope,
        configScope: 'user',
        declarations: [],
      };
      request.declarations.push(declaration);
      codexNative.set(scope, request);
      continue;
    }

    const surface = declaration.platform ?? declaration.distribution;
    if (!surface) continue;
    for (const scope of declaration.scopes) {
      const key = `${surface}:${scope}`;
      const request = awOwned.get(key) ?? {
        kind: 'aw-owned',
        surface,
        scope,
        configScope: scope,
        declarations: [],
      };
      request.declarations.push(declaration);
      awOwned.set(key, request);
    }
  }
  const partitionedAwOwned = [...awOwned.values()].flatMap((request) => {
    const hasSkill = request.declarations.some((declaration) =>
      declaration.target === 'codex.skill'
      || declaration.target === 'claude.skill'
      || declaration.target === 'agent-skills.skill');
    const hasSensitiveNonSkill = request.declarations.some((declaration) =>
      declaration.target !== 'codex.skill'
      && declaration.target !== 'claude.skill'
      && declaration.target !== 'agent-skills.skill'
      && declaration.refreshKeys.some((key) =>
        configFieldContainsSensitiveValue(manifest.config?.fields?.[key])));
    if (!hasSkill || !hasSensitiveNonSkill) return [request];
    const skillDeclarations = request.declarations.filter((declaration) =>
      declaration.target === 'codex.skill'
      || declaration.target === 'claude.skill'
      || declaration.target === 'agent-skills.skill');
    const nonSkillDeclarations = request.declarations.filter((declaration) =>
      !skillDeclarations.includes(declaration));
    return [
      { ...request, declarations: skillDeclarations },
      { ...request, declarations: nonSkillDeclarations },
    ];
  });
  return [...partitionedAwOwned, ...codexNative.values()];
}

function runArtifactRendererFixture(
  pluginDir,
  manifest,
  renderEntry,
  declarations,
  resolvedRuntimeImports,
  skillValidationTools,
) {
  if (!renderEntry || declarations.length === 0) return;

  const requests = resolveArtifactRendererFixtureRequests(declarations, manifest);
  const values = defaultConfigValues(manifest);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-artifact-render-'));
  try {
    for (const [requestIndex, request] of requests.entries()) {
      const {
        kind,
        surface,
        scope,
        configScope,
        declarations: scopedDeclarations,
      } = request;
      const distribution = surface === 'agent-skills' ? surface : undefined;
      const platform = distribution ? undefined : surface;
      const event = distribution ? 'materialize' : 'install';
      const requestRoot = path.join(tempRoot, `${requestIndex}-${kind}-${surface}-${scope}`);
      const rendererAwHome = path.join(requestRoot, 'aw-home');
      const rendererCodexHome = path.join(requestRoot, 'codex-home');
      const rendererClaudeHome = path.join(requestRoot, 'claude-home');
      fs.mkdirSync(requestRoot, { recursive: true });
      const contextPath = path.join(requestRoot, 'context.json');
      const runtimeImports = scopedDeclarations.flatMap((target) =>
        target.runtimeImports.map((runtimeImport, importIndex) => {
          const resolved = resolvedRuntimeImports?.artifactImports.get(
            authorRuntimeImportKey(target.id, importIndex),
          );
          if (!resolved) return null;
          const importPath = path.join(requestRoot, `runtime-${target.id}-${importIndex}`);
          fs.writeFileSync(importPath, resolved.bytes);
          return {
            artifactId: target.id,
            name: runtimeImport.name,
            providerPluginId: resolved.providerPluginId,
            exportName: resolved.exportName,
            path: importPath,
            digest: resolved.digest,
          };
        }).filter(Boolean));
      const refreshKeys = [...new Set(scopedDeclarations.flatMap((target) =>
        target.refreshKeys))];
      const scopedSchema = Object.fromEntries(refreshKeys.flatMap((key) =>
        manifest.config?.fields?.[key] === undefined
          ? []
          : [[key, manifest.config.fields[key]]]));
      const scopedValues = Object.fromEntries(refreshKeys.flatMap((key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? [[key, values[key]]] : []));
      try {
        for (const target of scopedDeclarations.filter((declaration) => declaration.runtimeConfig)) {
          const definition = normalizePluginConfigDefinition(manifest.config);
          createRuntimeConfigSnapshot({
            installedIdentity: {
              sourceId: 'authoring',
              sourceIdentity: 'authoring',
              pluginId: `authoring/${manifest.name}`,
              pluginName: manifest.name,
              pluginVersion: manifest.version,
              platform: target.platform,
              scope: target.delivery?.mode === 'codex-native' ? 'user' : scope,
              configScope,
              artifactId: target.id,
              skillKey: target.skillKey,
            },
            declaration: target.runtimeConfig,
            definition,
            values,
          });
        }
      } catch (runtimeConfigError) {
        error(`scripts.artifacts.render fixture (${surface}/${scope}) runtime config failed: ${runtimeConfigError.message}`);
        continue;
      }
      fs.writeFileSync(
        contextPath,
        JSON.stringify({
          event,
          surface: distribution
            ? { kind: 'distribution', name: distribution }
            : { kind: 'platform', name: platform },
          ...(platform ? { platform } : {}),
          ...(distribution ? { distribution } : {}),
          scope,
          plugin: {
            name: manifest.name,
            version: manifest.version,
            rootDir: pluginDir,
          },
          config: {
            mode: 'artifact-render',
            targetScope: configScope,
            ...(manifest.config?.fields === undefined ? {} : { schema: scopedSchema }),
            values: scopedValues,
            sources: Object.fromEntries(Object.keys(scopedValues).map((key) => [key, 'default'])),
            issues: [],
          },
          changedConfigKeys: [],
          requestedArtifactIds: scopedDeclarations.map((target) => target.id),
          previousArtifacts: [],
          artifactSources: declarations.filter((target) =>
            (target.target === 'codex.skill' || target.target === 'claude.skill' || target.target === 'agent-skills.skill')
            && (distribution ? target.distribution === distribution : target.platform === platform)
            && target.scopes.includes(scope)).map((target) => ({
            id: target.id,
            target: target.target,
            sourceDirs: target.sourceDirs.map((sourceDir) =>
              path.join(pluginDir, normalizeRelativePath(sourceDir))),
          })),
          runtimeImports,
          paths: {
            awHome: rendererAwHome,
            codexHome: rendererCodexHome,
            claudeHome: rendererClaudeHome,
            manifestPath: path.join(pluginDir, '.agents-plugin', 'plugin.json'),
          },
          renderer: {
            runner: renderEntry.runner,
            path: renderEntry.path,
            args: renderEntry.args ?? [],
            manifestDigest: 'author-validator-fixture',
            rendererDigest: 'author-validator-fixture',
          },
        }),
        'utf8',
      );
      const rendererHome = path.join(requestRoot, 'home');
      const rendererTemp = path.join(requestRoot, 'tmp');
      for (const rendererStateHome of [rendererAwHome, rendererCodexHome, rendererClaudeHome]) {
        fs.mkdirSync(rendererStateHome, { recursive: true });
      }
      fs.mkdirSync(rendererHome, { recursive: true });
      fs.mkdirSync(rendererTemp, { recursive: true });
      const rendererEnv = {
        AW_HOME: rendererAwHome,
        CODEX_HOME: rendererCodexHome,
        CLAUDE_CONFIG_DIR: rendererClaudeHome,
        HOME: rendererHome,
        USERPROFILE: rendererHome,
        XDG_CONFIG_HOME: path.join(requestRoot, 'xdg-config'),
        XDG_CACHE_HOME: path.join(requestRoot, 'xdg-cache'),
        XDG_STATE_HOME: path.join(requestRoot, 'xdg-state'),
        XDG_DATA_HOME: path.join(requestRoot, 'xdg-data'),
        XDG_RUNTIME_DIR: path.join(requestRoot, 'xdg-runtime'),
        PATH: process.env.PATH ?? process.env.Path ?? '',
        AW_PLUGIN_CONTEXT: contextPath,
        AW_PLUGIN_ROOT: pluginDir,
        AW_PLUGIN_NAME: typeof manifest.name === 'string' ? manifest.name : '',
        AW_PLUGIN_VERSION: typeof manifest.version === 'string' ? manifest.version : '',
        AW_PLUGIN_EVENT: event,
        ...(platform ? { AW_PLUGIN_PLATFORM: platform } : {}),
        ...(distribution ? { AW_PLUGIN_DISTRIBUTION: distribution } : {}),
        AW_PLUGIN_SCOPE: scope,
      };
      if (process.platform === 'win32') {
        rendererEnv.TEMP = rendererTemp;
        rendererEnv.TMP = rendererTemp;
        if (process.env.SystemRoot) rendererEnv.SystemRoot = process.env.SystemRoot;
        if (process.env.ComSpec) rendererEnv.ComSpec = process.env.ComSpec;
      } else {
        rendererEnv.TMPDIR = rendererTemp;
      }
      const result = spawnSync(
        process.execPath,
        [path.join(pluginDir, renderEntry.path), ...(renderEntry.args ?? [])],
        {
          cwd: pluginDir,
          env: rendererEnv,
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        },
      );
      const fieldName = `scripts.artifacts.render fixture (${surface}/${scope})`;
      if (result.error) {
        error(`${fieldName} failed: ${result.error.message}`);
        continue;
      }
      if (result.status !== 0) {
        const stderr = String(result.stderr ?? '').trim().split('\n')[0] ?? '';
        error(`${fieldName} exited with code ${result.status}${stderr ? `: ${stderr}` : ''}`);
        continue;
      }
      let plan;
      try {
        plan = JSON.parse(result.stdout);
      } catch (e) {
        error(`${fieldName} stdout must be JSON ArtifactPlan: ${e.message}`);
        continue;
      }
      validateRenderedArtifactPlan(plan, scopedDeclarations, `${surface}/${scope}`, {
        pluginDir,
        manifest,
        runtimeImports: resolvedRuntimeImports,
        tempRoot,
        skillValidationTools,
      });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validateDynamicArtifactsLightweight(
  pluginDir,
  manifest,
  renderEntry,
  runtimeImports,
  skillValidationTools,
) {
  const declarations = validateArtifactsConfigLightweight(pluginDir, manifest);
  const hasTargets = declarations.length > 0;
  const hasRenderer = Boolean(manifest.scripts?.artifacts?.render);

  if (hasTargets && !hasRenderer) {
    error('artifacts.targets requires scripts.artifacts.render');
  }
  if (hasRenderer && !hasTargets) {
    error('scripts.artifacts.render requires artifacts.targets');
  }

  runArtifactRendererFixture(
    pluginDir,
    manifest,
    renderEntry,
    declarations,
    runtimeImports,
    skillValidationTools,
  );
}

function validateScriptsLightweight(pluginDir, manifest) {
  validateConfigSchemaLightweight(manifest.config);
  if (manifest.scripts === undefined) return null;

  const scripts = expectRecord(manifest.scripts, 'scripts');
  if (!scripts) return null;
  validateAllowedKeys(scripts, 'scripts', ['preApply', 'helpers', 'node', 'artifacts', 'tests']);

  const runtimeNodeEntries = [];
  let artifactRenderEntry = null;
  let packageMeta = null;
  const runtimeConfigSkillRoots = (manifest.artifacts?.targets ?? [])
    .filter((target) => target.runtimeConfig !== undefined)
    .flatMap((target) => target.sourceDirs ?? [])
    .map(normalizeRelativePath);

  if (scripts.helpers !== undefined) {
    const helpers = expectRecord(scripts.helpers, 'scripts.helpers');
    if (helpers) {
      validateAllowedKeys(helpers, 'scripts.helpers', ['config']);
      const helperPath = normalizePluginScriptPath(pluginDir, helpers.config, 'scripts.helpers.config');
      validateDeclaredScriptFile(pluginDir, helperPath, 'scripts.helpers.config');
      if (helperPath && !isNodeRunnablePath(helperPath)) {
        error('scripts.helpers.config must use a Node runnable extension (.js, .mjs, or .cjs)');
      }
      if (helperPath) runtimeNodeEntries.push({ path: helperPath, fieldName: 'scripts.helpers.config' });
    }
  }

  if (scripts.preApply !== undefined) {
    const preApply = expectRecord(scripts.preApply, 'scripts.preApply');
    if (preApply) {
      validateAllowedKeys(preApply, 'scripts.preApply', ['path', 'timeoutMs']);
      const preApplyPath = normalizePluginScriptPath(pluginDir, preApply.path, 'scripts.preApply.path');
      validateDeclaredScriptFile(pluginDir, preApplyPath, 'scripts.preApply.path');
      if (preApplyPath && !isNodeRunnablePath(preApplyPath)) {
        error('scripts.preApply.path must use a Node runnable extension (.js, .mjs, or .cjs)');
      }
      if (preApply.timeoutMs !== undefined && (!Number.isInteger(preApply.timeoutMs)
        || preApply.timeoutMs < SCRIPT_TIMEOUT_MIN_MS || preApply.timeoutMs > SCRIPT_TIMEOUT_MAX_MS)) {
        error(`scripts.preApply.timeoutMs must be an integer between ${SCRIPT_TIMEOUT_MIN_MS} and ${SCRIPT_TIMEOUT_MAX_MS}`);
      }
      if (preApplyPath) runtimeNodeEntries.push({ path: preApplyPath, fieldName: 'scripts.preApply.path' });
    }
  }

  if (scripts.node !== undefined) {
    const node = expectRecord(scripts.node, 'scripts.node');
    if (node) {
      validateAllowedKeys(node, 'scripts.node', ['packageRoot', 'build']);
      if (node.packageRoot !== undefined) {
        packageMeta = validatePackageRoot(pluginDir, node.packageRoot, 'scripts.node.packageRoot');
      }
      if (node.build !== undefined) {
        const buildEntry = validateScriptEntry(pluginDir, node.build, 'scripts.node.build', {
          requireNodeRunner: true,
          requireNodePath: true,
        });
        if (buildEntry) {
          scanNodeImportContract(pluginDir, [buildEntry.path], {
            label: 'scripts.node.build import contract',
            packageMeta,
            allowDevDependencies: true,
            runtimeConfigSkillRoots,
          });
        }
      }
    }
  }

  if (scripts.artifacts !== undefined) {
    const artifacts = expectRecord(scripts.artifacts, 'scripts.artifacts');
    if (artifacts) {
      validateAllowedKeys(artifacts, 'scripts.artifacts', ['render']);
      if (artifacts.render !== undefined) {
        artifactRenderEntry = validateScriptEntry(pluginDir, artifacts.render, 'scripts.artifacts.render', {
          requireNodeRunner: true,
          requireNodePath: true,
        });
        if (artifactRenderEntry) {
          runtimeNodeEntries.push({
            path: artifactRenderEntry.path,
            fieldName: 'scripts.artifacts.render.path',
          });
        }
      }
    }
  }

  if (scripts.tests !== undefined) {
    const tests = expectRecord(scripts.tests, 'scripts.tests');
    if (tests) {
      validateAllowedKeys(tests, 'scripts.tests', ['node']);
      if (tests.node !== undefined) {
        if (!Array.isArray(tests.node)) {
          error('scripts.tests.node must be an array of glob strings');
        } else {
          const allFiles = listFilesRecursive(pluginDir);
          const testEntries = [];
          tests.node.forEach((pattern, index) => {
            if (typeof pattern !== 'string' || pattern.trim() === '') {
              error(`scripts.tests.node[${index}] must be a non-empty string`);
              return;
            }
            for (const filePath of allFiles) {
              if (matchesGlob(filePath, pattern)) {
                testEntries.push(filePath);
              }
            }
          });
          scanNodeImportContract(pluginDir, testEntries, {
            label: 'scripts.tests.node import contract',
            packageMeta,
            allowDevDependencies: true,
            runtimeConfigSkillRoots,
          });
        }
      }
    }
  }

  scanNodeImportContract(
    pluginDir,
    runtimeNodeEntries.map((entry) => entry.path),
    {
      label: 'runtime Node import contract',
      packageMeta,
      allowDevDependencies: false,
      runtimeConfigSkillRoots,
    },
  );

  return artifactRenderEntry;
}

function validateMcpContent(pluginDir, manifest) {
  if (!manifest.mcpServers) return;
  if (isTemplateAsset(manifest, manifest.mcpServers)) return;
  const mcpPath = path.join(pluginDir, manifest.mcpServers);
  if (!fs.existsSync(mcpPath)) return;
  try {
    const content = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    if (!content.mcpServers || typeof content.mcpServers !== 'object') {
      error(`${manifest.mcpServers} must have a "mcpServers" top-level key`);
    }
  } catch (e) {
    error(`${manifest.mcpServers} is not valid JSON: ${e.message}`);
  }
}

function validateAppsContent(pluginDir, manifest) {
  if (!manifest.apps) return;
  if (isTemplateAsset(manifest, manifest.apps)) return;
  const appsPath = path.join(pluginDir, manifest.apps);
  if (!fs.existsSync(appsPath)) return;
  try {
    const content = JSON.parse(fs.readFileSync(appsPath, 'utf8'));
    if (!content.apps || typeof content.apps !== 'object') {
      error(`${manifest.apps} must have an "apps" top-level key`);
    }
  } catch (e) {
    error(`${manifest.apps} is not valid JSON: ${e.message}`);
  }
}

function hasCodexRepoManagedSurface(manifest) {
  if (manifest.skills || manifest.slashCommands || manifest.mcpServers) {
    return true;
  }
  if ((manifest.artifacts?.targets ?? []).some((target) =>
    target?.platform === 'codex' &&
    Array.isArray(target.scopes) &&
    target.scopes.includes('project') &&
    typeof target.projectManagedKind === 'string')) {
    return true;
  }
  const extensions = manifest.extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) {
    return false;
  }
  return ['instructions', 'permissions', 'hooks', 'agents'].some((key) =>
    Array.isArray(extensions[key]) && extensions[key].length > 0,
  ) || (
    extensions.nativeHooks &&
    typeof extensions.nativeHooks === 'object' &&
    !Array.isArray(extensions.nativeHooks) &&
    Array.isArray(extensions.nativeHooks.codex) &&
    extensions.nativeHooks.codex.length > 0
  );
}

function warnCodexProjectScopeLimitations(manifest) {
  if (!isCodexTargeted(manifest)) {
    return;
  }

  if (manifest.apps) {
    warn(
      'Codex project scope does not support apps; users must install this app surface with `aw install <plugin> -p codex -s user` or split the plugin.',
    );
  }

  if (!hasCodexRepoManagedSurface(manifest)) {
    warn(
      'This Codex-targeted plugin has no repo-managed project surface; Codex project scope will fail fast and only Codex user native install is applicable.',
    );
  }
}

function validateExtensionNameUniqueness(manifest) {
  if (!manifest.extensions) return;
  for (const extType of ['instructions', 'permissions', 'hooks', 'agents']) {
    const items = manifest.extensions[extType];
    if (!Array.isArray(items)) continue;
    const names = new Set();
    for (const item of items) {
      if (item.name) {
        if (names.has(item.name)) {
          error(
            `extensions.${extType} has duplicate name: "${item.name}"`,
          );
        }
        names.add(item.name);
      }
    }
  }
}

function validateOpenAiYaml(
  openaiYamlPath,
  skillName,
  required,
  manifest,
  pluginDir,
  skillValidationTools,
) {
  const fieldName = `skills/${skillName}/agents/openai.yaml`;

  if (!fs.existsSync(openaiYamlPath)) {
    if (required) {
      error(`${fieldName} not found; Codex-targeted skills must declare Codex trigger policy`);
    } else {
      warn(`${fieldName} not found; this is acceptable only for non-Codex skills`);
    }
    return;
  }

  if (!skillValidationTools) {
    error(`${fieldName} cannot be validated because the shared CLI Skill validator is unavailable`);
    return;
  }

  try {
    const relativePath = path.relative(pluginDir, openaiYamlPath);
    const rawContent = fs.readFileSync(openaiYamlPath, 'utf8');
    const validation = skillValidationTools.validateCodexMetadata(
      renderTemplateForPlatform(manifest, relativePath, rawContent, 'codex'),
      skillName,
      fieldName,
    );
    for (const entry of validation.errors) {
      error(`${entry.path} [${entry.code}] ${entry.message}`);
    }
    const skillRoot = path.dirname(path.dirname(openaiYamlPath));
    for (const assetPath of validation.assetPaths) {
      const absoluteAssetPath = path.join(skillRoot, ...assetPath.split('/'));
      const stats = fs.lstatSync(absoluteAssetPath, { throwIfNoEntry: false });
      if (!stats?.isFile() || stats.isSymbolicLink()) {
        error(`${fieldName} references missing regular file "${assetPath}"`);
      }
    }
  } catch (e) {
    error(`${fieldName} shared validation failed: ${e.message}`);
  }
}

function validateSkills(pluginDir, manifest, options, skillValidationTools) {
  if (!manifest.skills) return;
  const skillsDir = path.join(pluginDir, manifest.skills);
  if (!fs.existsSync(skillsDir)) return;
  const requiresCodexMetadata = isCodexTargeted(manifest);
  const targetsClaude = isClaudeTargeted(manifest);

  const skillDirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  if (skillDirs.length === 0) {
    error('skills directory exists but contains no skill subdirectories');
  }

  for (const dir of skillDirs) {
    const skillPath = path.join(skillsDir, dir.name);
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    const openaiYamlPath = path.join(skillPath, 'agents', 'openai.yaml');
    const skillMdRelativePath = path.relative(pluginDir, skillMdPath);

    if (!fs.existsSync(skillMdPath)) {
      error(`skills/${dir.name}/SKILL.md not found`);
      continue;
    }

    const content = fs.readFileSync(skillMdPath, 'utf8');
    const lineCount = countLines(content);
    if (lineCount >= MAX_SKILL_LINES) {
      warn(
        `skills/${dir.name}/SKILL.md has ${lineCount} lines; Agent Skills recommends keeping SKILL.md under ${MAX_SKILL_LINES} lines`,
      );
    }
    const variants = renderedContentVariants(
      manifest,
      skillMdRelativePath,
      content,
      targetedPlatforms(manifest),
    );
    for (const variant of variants) {
      const sourceName = variant.platform
        ? `skills/${dir.name}/SKILL.md (${variant.platform} render)`
        : `skills/${dir.name}/SKILL.md`;
      if (!skillValidationTools) {
        error(`${sourceName} cannot be validated because the shared CLI Skill validator is unavailable`);
      } else {
        const parsed = skillValidationTools.parseSkillFrontmatter(variant.content, sourceName);
        for (const entry of parsed.errors) {
          error(`${entry.path} [${entry.code}] ${entry.message}`);
        }
        if (parsed.frontmatter) {
          const profile = options.strictAgentSkills || !targetsClaude
            ? 'portable-agent-skills'
            : options.claudeSkillProfile === 'current'
              ? 'claude-current'
              : 'claude-2.1.88';
          const diagnostics = skillValidationTools.validateSkillFrontmatter(parsed.frontmatter, {
            profile,
            expectedName: dir.name,
            sourcePath: sourceName,
          });
          for (const entry of diagnostics) {
            error(`${entry.path} [${entry.code}] ${entry.message}`);
          }
        }
      }
    }

    validateOpenAiYaml(
      openaiYamlPath,
      dir.name,
      requiresCodexMetadata,
      manifest,
      pluginDir,
      skillValidationTools,
    );

    if (/\[TODO[:\]]/i.test(content)) {
      error(
        `skills/${dir.name}/SKILL.md still contains TODO placeholders`,
      );
    }
  }
}

function detectCodexSlashCommandForbiddenSyntax(content) {
  const checks = [
    [/\$ARGUMENTS\b/, '$ARGUMENTS'],
    [/\$\d+\b/, '$1'],
    [/```!/, '```!'],
    [/!`[^`\r\n]+`/, '!`command`'],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(content)) {
      return label;
    }
  }
  return null;
}

function validateSlashCommandAssetReference(commandRoot, commandRelativePath, value, fieldName) {
  if (value === undefined) return;
  validateCodexIconPath({ [fieldName]: value }, fieldName, `${commandRelativePath}.codex.interface`);
  if (typeof value !== 'string' || value.trim().length === 0) return;

  const normalized = normalizeRelativePath(stripDotSlash(value));
  const absolutePath = path.join(commandRoot, normalized);
  const stats = fs.statSync(absolutePath, { throwIfNoEntry: false });
  if (!stats) {
    error(`${commandRelativePath}.codex.interface.${fieldName} references missing asset "${value}"`);
    return;
  }
  if (!stats.isFile()) {
    error(`${commandRelativePath}.codex.interface.${fieldName} must reference a file, got "${value}"`);
  }
}

function validateSlashCommandFrontmatter(commandRoot, commandRelativePath, frontmatter, platform) {
  const fieldName = `${commandRelativePath} frontmatter`;
  const fm = expectRecord(frontmatter, fieldName);
  if (!fm) return;

  for (const key of Object.keys(fm)) {
    if (CLAUDE_SLASH_COMMAND_ONLY_FIELDS.has(key)) {
      error(`${fieldName}: "${key}" must be nested under "claude"`);
    }
  }

  validateAllowedKeys(fm, fieldName, ['description', 'claude', 'codex']);
  validateNonEmptyString(fm.description, `${fieldName}.description`, MAX_SKILL_DESCRIPTION_LEN);

  if (platform === 'claude' && fm.claude !== undefined) {
    const claudeBlock = expectRecord(fm.claude, `${fieldName}.claude`);
    if (claudeBlock) {
      validateAllowedKeys(claudeBlock, `${fieldName}.claude`, [
        'description',
        'allowed-tools',
        'model',
        'argument-hint',
        'shell',
      ]);
      if (claudeBlock.description !== undefined) {
        validateNonEmptyString(
          claudeBlock.description,
          `${fieldName}.claude.description`,
          MAX_SKILL_DESCRIPTION_LEN,
        );
      }
      if (claudeBlock['allowed-tools'] !== undefined) {
        validateAllowedTools(
          claudeBlock['allowed-tools'],
          `${fieldName}.claude.allowed-tools`,
          { allowArray: true },
        );
      }
      if (claudeBlock.model !== undefined) {
        validateNonEmptyString(
          claudeBlock.model,
          `${fieldName}.claude.model`,
        );
      }
      if (claudeBlock['argument-hint'] !== undefined) {
        validateNonEmptyString(
          claudeBlock['argument-hint'],
          `${fieldName}.claude.argument-hint`,
        );
      }
      if (claudeBlock.shell !== undefined) {
        if (typeof claudeBlock.shell !== 'string') {
          error(`${fieldName}.claude.shell must be a string`);
        } else if (!CLAUDE_FRONTMATTER_SHELLS.has(claudeBlock.shell.trim().toLowerCase())) {
          error(`${fieldName}.claude.shell must be "bash" or "powershell"`);
        }
      }
    }
  }

  if (platform === 'codex' && fm.codex !== undefined) {
    const codexBlock = expectRecord(fm.codex, `${fieldName}.codex`);
    if (codexBlock) {
      if (codexBlock.policy !== undefined) {
        error(`${fieldName}.codex.policy is not supported; generated slashCommands skills are always manual-only`);
      }
      validateAllowedKeys(codexBlock, `${fieldName}.codex`, ['description', 'interface']);
      if (codexBlock.description !== undefined) {
        validateNonEmptyString(
          codexBlock.description,
          `${fieldName}.codex.description`,
          MAX_SKILL_DESCRIPTION_LEN,
        );
      }
      if (codexBlock.interface !== undefined) {
        const interfaceBlock = expectRecord(codexBlock.interface, `${fieldName}.codex.interface`);
        if (interfaceBlock) {
          validateAllowedKeys(interfaceBlock, `${fieldName}.codex.interface`, [
            'display_name',
            'short_description',
            'icon_small',
            'icon_large',
            'brand_color',
            'default_prompt',
          ]);
          validateCodexMetadataString(
            interfaceBlock,
            'display_name',
            `${fieldName}.codex.interface`,
            MAX_OPENAI_INTERFACE_NAME_LEN,
          );
          validateCodexShortDescription(interfaceBlock, `${fieldName}.codex.interface`);
          validateCodexDefaultPrompt(
            interfaceBlock,
            'default_prompt',
            `${fieldName}.codex.interface`,
            MAX_OPENAI_DEFAULT_PROMPT_LEN,
            path.basename(commandRelativePath, path.extname(commandRelativePath)),
          );
          validateCodexBrandColor(interfaceBlock, 'brand_color', `${fieldName}.codex.interface`);
          validateSlashCommandAssetReference(
            commandRoot,
            commandRelativePath,
            interfaceBlock.icon_small,
            'icon_small',
          );
          validateSlashCommandAssetReference(
            commandRoot,
            commandRelativePath,
            interfaceBlock.icon_large,
            'icon_large',
          );
        }
      }
    }
  }
}

function validateSlashCommands(pluginDir, manifest) {
  const defaultSlashCommandsDir = path.join(pluginDir, DEFAULT_SLASH_COMMANDS_DIR);
  if (fs.existsSync(defaultSlashCommandsDir) && !manifest.slashCommands) {
    error(`"${DEFAULT_SLASH_COMMANDS_DIR}" exists but manifest does not declare "slashCommands"`);
  }

  if (!manifest.slashCommands) return;
  const targetPlatforms = resolveSupportedPlatforms(manifest);

  const slashCommandsRoot = path.join(pluginDir, manifest.slashCommands);
  const stats = fs.statSync(slashCommandsRoot, { throwIfNoEntry: false });
  if (!stats) {
    error(`slashCommands points to "${manifest.slashCommands}" but path does not exist`);
    return;
  }
  if (!stats.isDirectory()) {
    error(`slashCommands must point to a directory, got "${manifest.slashCommands}"`);
    return;
  }

  const skillNames = new Set();
  if (manifest.skills) {
    const skillsRoot = path.join(pluginDir, manifest.skills);
    if (fs.existsSync(skillsRoot)) {
      for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          skillNames.add(entry.name);
        }
      }
    }
  }

  const seenCommands = new Set();
  const commandFiles = [];
  for (const entry of fs.readdirSync(slashCommandsRoot, { withFileTypes: true })) {
    const relativePath = normalizeRelativePath(path.join(stripDotSlash(manifest.slashCommands), entry.name));
    if (entry.isDirectory()) {
      if (entry.name !== 'assets') {
        error(`slashCommands does not support nested directory "${relativePath}"; only root *.md files and assets/ are allowed`);
      }
      continue;
    }
    if (!entry.isFile()) {
      error(`slashCommands has unsupported entry "${relativePath}"`);
      continue;
    }
    if (path.posix.extname(entry.name) !== '.md') {
      error(`slashCommands only accepts root *.md files; found "${relativePath}"`);
      continue;
    }
    commandFiles.push(entry.name);
  }

  if (commandFiles.length === 0) {
    error(`slashCommands "${manifest.slashCommands}" must contain at least one root *.md command file`);
    return;
  }

  for (const fileName of commandFiles.sort()) {
    const commandName = path.posix.basename(fileName, '.md');
    const commandRelativePath = normalizeRelativePath(
      path.join(stripDotSlash(manifest.slashCommands), fileName),
    );
    if (
      commandName.length === 0 ||
      commandName.length > 64 ||
      !SLASH_COMMAND_NAME_PATTERN.test(commandName)
    ) {
      error(`${commandRelativePath} command name must use lowercase hyphen-case and be <= 64 characters`);
      continue;
    }
    if (seenCommands.has(commandName)) {
      error(`slashCommands has duplicate command name "${commandName}"`);
      continue;
    }
    if (skillNames.has(commandName)) {
      error(`slashCommands command "${commandName}" conflicts with source skill "${commandName}"`);
      continue;
    }
    seenCommands.add(commandName);

    const absolutePath = path.join(slashCommandsRoot, fileName);
    const rawContent = fs.readFileSync(absolutePath, 'utf8');
    for (const platform of ['claude', 'codex']) {
      if (!targetPlatforms.has(platform)) continue;
      const rendered = renderTemplateForPlatform(
        manifest,
        commandRelativePath,
        rawContent,
        platform,
      );
      if (platform === 'codex') {
        const codexForbiddenSyntax = detectCodexSlashCommandForbiddenSyntax(rendered);
        if (codexForbiddenSyntax) {
          error(`${commandRelativePath} Codex render still contains Claude-only syntax "${codexForbiddenSyntax}"`);
        }
      }

      let frontmatter;
      try {
        frontmatter = parseFrontmatter(rendered, `${commandRelativePath} (${platform} render)`);
      } catch (parseError) {
        error(`${commandRelativePath} (${platform} render) has invalid YAML frontmatter: ${parseError.message}`);
        continue;
      }
      if (!frontmatter) {
        error(`${commandRelativePath} (${platform} render) is missing YAML frontmatter`);
        continue;
      }
      validateSlashCommandFrontmatter(slashCommandsRoot, commandRelativePath, frontmatter, platform);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`Usage:
  aw plugin validate <plugin-directory> [options]

Options:
  --strict-agent-skills        Allow only Agent Skills portable core frontmatter.
  --claude-skill-profile <minimum|current>
                               Validate Claude fields at AW minimum 2.1.88 (default) or current docs.
  --version-base <git-ref>     Compare the production bundle against this Git base. Default: HEAD.
  --workspace-root <path>      Workspace root. Default: current directory.
  --json                       Emit one machine-readable JSON result to stdout.
  -h, --help                   Show this help message.
`);
}

function exitCliError(message, json) {
  if (json) {
    console.log(JSON.stringify({
      ok: false,
      profile: 'unknown',
      warnings: [],
      errors: [message],
    }, null, 2));
  } else {
    console.error(message);
  }
  process.exit(1);
}

async function validatePluginDir(pluginDir, options) {
  const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');

  const cliManifestTools = await tryLoadCliManifestTools();
  if (
    !cliManifestTools
    || typeof cliManifestTools.assertPluginInputTree !== 'function'
    || typeof cliManifestTools.validateSourcePluginManifest !== 'function'
  ) {
    error(
      `Plugin manifest contract v${SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION} is unavailable; install a complete current aw CLI and retry.`,
    );
    return;
  }
  try {
    await cliManifestTools.assertPluginInputTree(pluginDir);
  } catch (e) {
    error(e.message);
    return;
  }

  if (!fs.existsSync(manifestPath)) {
    error('.agents-plugin/plugin.json not found');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    error(`.agents-plugin/plugin.json is not valid JSON: ${e.message}`);
    return;
  }
  if (
    options.enforceCanonicalRoot
    && typeof manifest?.name === 'string'
    && manifest.name !== ''
  ) {
    try {
      assertCanonicalAuthoringPluginRoot({
        workspaceRoot: options.repoRoot,
        pluginRoot: pluginDir,
        pluginName: manifest.name,
        requireManifest: true,
      });
    } catch (cause) {
      error(cause.message);
      return;
    }
  }

  const skillValidationTools = await tryLoadCliSkillValidationTools();
  try {
    const normalizedManifest = await cliManifestTools.validateSourcePluginManifest(pluginDir, manifest);
    // Renderer fixtures consume the same compiled config as installed runtime consumers.
    if (normalizedManifest.config) manifest.config = normalizedManifest.config;
    const requirements = await cliManifestTools.resolvePluginRequirements({
      pluginRoot: pluginDir,
      manifest: normalizedManifest,
      implementedCapabilities: cliManifestTools.implementedCapabilities,
    });
    if (requirements.unsupportedByCurrentAw.length > 0) {
      capabilityDiagnostic = {
        errorCode: 'awCapabilityUnsupported',
        missingCapabilities: requirements.unsupportedByCurrentAw,
        availableCapabilities: [...cliManifestTools.implementedCapabilities].sort(),
      };
      error(`[awCapabilityUnsupported] missingCapabilities=${JSON.stringify(requirements.unsupportedByCurrentAw)}`);
    }
    const satisfiedCapabilities = new Set([...requirements.declared, ...requirements.derived]);
    const advisoryObservations = requirements.observations.filter((observation) => (
      observation.code !== 'aw-command-detected'
      || observation.capability === undefined
      || !satisfiedCapabilities.has(observation.capability)
    ));
    for (const observation of advisoryObservations) {
      warn(`[awCapabilityObservation] ${observation.path}: ${observation.message}`);
    }
  } catch (e) {
    error(e.message);
  }
  validatePlatformFieldSupport(manifest);
  validatePortableNativeArtifactCapabilityLightweight(manifest);

  validateNameMatchesDirectory(pluginDir, manifest);
  validateNoBuildOutputDirs(pluginDir);
  validateDeclaredNativeAssets(pluginDir, manifest);
  validateCanonicalSkillLayout(pluginDir, manifest);
  await validatePluginEvalManifest(pluginDir, manifest);
  const artifactRenderEntry = validateScriptsLightweight(pluginDir, manifest);
  const runtimeImports = await resolveAuthorRuntimeImports({
    pluginDir,
    manifest,
    repoRoot: options.repoRoot,
    cliManifestTools,
  });
  validateStaticPortableFinalTrees(pluginDir, manifest, runtimeImports, skillValidationTools);
  validateDynamicArtifactsLightweight(
    pluginDir,
    manifest,
    artifactRenderEntry,
    runtimeImports,
    skillValidationTools,
  );
  validateMcpContent(pluginDir, manifest);
  validateAppsContent(pluginDir, manifest);
  warnCodexProjectScopeLimitations(manifest);
  validateExtensionNameUniqueness(manifest);
  validateSkills(pluginDir, manifest, options, skillValidationTools);
  validateSlashCommands(pluginDir, manifest);

  if (errors.length === 0) {
    const repoRoot = resolveCanonicalRepoRoot(
      pluginDir,
      manifest.name ?? '',
      options.gitRoot,
    );
    if (repoRoot) {
      try {
        pluginVersionCheckResult = await checkPluginVersions({
          repoRoot,
          cliPackageRoot: CLI_PACKAGE_ROOT,
          base: options.versionBase,
          pluginNames: [manifest.name],
        });
        const check = pluginVersionCheckResult.checks[0];
        for (const message of check?.warnings ?? []) {
          warn(`plugin version check: ${message}`);
        }
        for (const message of check?.errors ?? []) {
          error(`plugin version check: ${message}`);
        }
      } catch (versionError) {
        if (
          versionError?.code === 'bundlerUnavailable'
          || versionError?.code === 'gitUnavailable'
        ) {
          warn(`plugin version check skipped: ${versionError.message}`);
        } else {
          error(`plugin version check failed: ${versionError.message}`);
        }
      }
    }
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    pluginDir: null,
    strictAgentSkills: false,
    claudeSkillProfile: 'minimum',
    versionBase: 'HEAD',
    workspaceRoot: null,
    json: args.includes('--json'),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--json') {
      continue;
    }
    if (arg === '--strict-agent-skills') {
      options.strictAgentSkills = true;
      continue;
    }
    if (arg === '--claude-skill-profile') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        exitCliError('--claude-skill-profile requires a value.', options.json);
      }
      index += 1;
      if (value !== 'minimum' && value !== 'current') {
        exitCliError(
          `Invalid --claude-skill-profile: expected "minimum" or "current". Received ${JSON.stringify(value)}.`,
          options.json,
        );
      }
      options.claudeSkillProfile = value;
      continue;
    }
    if (arg === '--version-base') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        exitCliError('--version-base requires a value.', options.json);
      }
      index += 1;
      options.versionBase = value;
      continue;
    }
    if (arg === '--workspace-root') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        exitCliError('--workspace-root requires a value.', options.json);
      }
      index += 1;
      options.workspaceRoot = value;
      continue;
    }
    if (!arg.startsWith('--')) {
      if (!options.pluginDir) {
        options.pluginDir = arg;
        continue;
      }
      exitCliError(`Unknown argument: ${arg}`, options.json);
    }

    exitCliError(`Unknown option: ${arg}`, options.json);
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.pluginDir) {
    exitCliError('plugin-directory is required; run with --help for usage.', args.json);
  }

  const requestedWorkspaceRoot = args.workspaceRoot === null
    ? null
    : path.resolve(args.workspaceRoot);
  const resolved = path.resolve(requestedWorkspaceRoot ?? '.', args.pluginDir);
  if (!fs.existsSync(resolved)) {
    exitCliError(`[ERROR] Directory not found: ${resolved}`, args.json);
  }
  const repoRootCandidate = requestedWorkspaceRoot ?? findRepoRootCandidate(resolved);
  try {
    assertAuthoringPluginPathFence({
      repoRoot: repoRootCandidate ?? undefined,
      pluginRoot: resolved,
      requirePluginRoot: true,
      requireManifest: true,
    });
  } catch (pathError) {
    exitCliError(`[ERROR] ${pathError.message}`, args.json);
  }
  const repoRoot = requestedWorkspaceRoot ?? discoverCanonicalRepoRoot(repoRootCandidate);
  const gitRoot = discoverCanonicalRepoRoot(findRepoRootCandidate(resolved));

  await validatePluginDir(resolved, {
    strictAgentSkills: args.strictAgentSkills,
    claudeSkillProfile: args.claudeSkillProfile,
    versionBase: args.versionBase,
    repoRoot,
    gitRoot,
    enforceCanonicalRoot: requestedWorkspaceRoot !== null,
  });

  if (args.json) {
    console.log(JSON.stringify({
      ok: errors.length === 0,
      profile: args.strictAgentSkills ? 'agent-skills-portable-core' : 'aw-source',
      claudeSkillProfile: args.claudeSkillProfile,
      pluginDirectory: resolved,
      workspaceRoot: process.env.AW_AUTHORING_WORKSPACE_ROOT ?? repoRoot,
      workspaceRootResolvedFrom: process.env.AW_AUTHORING_WORKSPACE_ROOT_RESOLVED_FROM ?? 'explicit',
      versionCheck: pluginVersionCheckResult,
      warnings,
      errors,
      ...(capabilityDiagnostic ?? {}),
    }, null, 2));
    if (errors.length > 0) {
      process.exit(1);
    }
    return;
  }

  if (warnings.length > 0) {
    console.log(`\n[WARN] ${warnings.length} warning(s):`);
    for (const w of warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\n[FAIL] ${errors.length} error(s):`);
    for (const e of errors) {
      console.log(`  - ${e}`);
    }
    process.exit(1);
  }

  console.log('[PASS] All checks passed.');
}

main();
