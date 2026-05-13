#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const errors = [];
const warnings = [];
const MAX_SKILL_NAME_LEN = 64;
const MAX_SKILL_DESCRIPTION_LEN = 1024;
const MAX_SKILL_SHORT_DESCRIPTION_LEN = 1024;
const MAX_OPENAI_INTERFACE_NAME_LEN = 64;
const MAX_OPENAI_INTERFACE_DESCRIPTION_LEN = 1024;
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
const MANIFEST_POLICY_PRODUCTS = new Set(['CODEX', 'CLAUDE']);
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
const SCRIPT_AUTO_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.sh', '.ps1', '.cmd', '.bat']);
const SCRIPT_RUNNERS = new Set(['node', 'sh', 'bash', 'pwsh', 'powershell', 'cmd', 'auto']);
const SCRIPT_OS_SELECTORS = new Set(['default', 'unix', 'windows', 'linux', 'darwin', 'win32']);
const SCRIPT_LIFECYCLE_EVENTS = new Set(['install', 'upgrade', 'uninstall']);
const SCRIPT_TIMEOUT_MIN_MS = 1000;
const SCRIPT_TIMEOUT_MAX_MS = 300000;
const CONFIG_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'enum', 'file', 'directory']);
const ARTIFACT_TARGETS = new Set([
  'codex.developerInstructionsBlock',
  'codex.agentRole',
  'codex.skill',
]);
const ARTIFACT_STATES = new Set(['present', 'disabled']);
const ARTIFACT_SCOPES = new Set(['user', 'project']);
const ARTIFACT_KINDS = new Set(['instruction', 'codexRole', 'skill']);
const ARTIFACT_PROJECT_MANAGED_KINDS = new Set(['instruction', 'agent', 'skill']);
const ARTIFACT_KIND_BY_TARGET = {
  'codex.developerInstructionsBlock': 'instruction',
  'codex.agentRole': 'codexRole',
  'codex.skill': 'skill',
};
const ARTIFACT_PROJECT_MANAGED_KIND_BY_TARGET = {
  'codex.developerInstructionsBlock': 'instruction',
  'codex.agentRole': 'agent',
  'codex.skill': 'skill',
};
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLUGIN_DEPENDENCY_PLATFORMS = new Set(['codex', 'claude']);
let yamlParser = null;

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

async function tryLoadCliManifestTools() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const modulePath = path.join(
    repoRoot,
    'packages',
    'cli',
    'dist',
    'src',
    'utils',
    'manifest.js',
  );
  if (!fs.existsSync(modulePath)) return null;
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  if (!moduleSource.includes('skillTriggers')) return null;
  if (!moduleSource.includes('validatePluginDependencyReferences')) return null;
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    return {
      validateSourcePluginManifest: mod.validateSourcePluginManifest ?? null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lightweight manifest checks (fallback when CLI not built)
// ---------------------------------------------------------------------------

function validateManifestLightweight(manifest) {
  const input = expectRecord(manifest, 'plugin manifest');
  if (!input) return;
  if (Object.prototype.hasOwnProperty.call(input, 'commands')) {
    error('top-level "commands" has been removed; use "slashCommands" instead');
  }
  validateAllowedKeys(input, 'plugin manifest', [
    'name',
    'version',
    'description',
    'skills',
    'slashCommands',
    'skillTriggers',
    'mcpServers',
    'apps',
    'marketplace',
    'interface',
    'dependencies',
    'extensions',
    'buildConfig',
    'scripts',
    'config',
    'artifacts',
  ]);

  for (const field of ['name', 'version', 'description', 'marketplace']) {
    if (!manifest[field]) {
      error(`Missing required field: ${field}`);
    }
  }

  if (manifest.name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)) {
    error(`manifest name "${manifest.name}" is not lowercase-hyphen-case`);
  }

  validateManifestDependenciesLightweight(manifest.name, manifest.dependencies);

  if (manifest.marketplace) {
    const mp = manifest.marketplace;
    if (!mp.category) error('marketplace.category is required');
    if (typeof mp.strict !== 'boolean')
      error('marketplace.strict must be a boolean');
    if (!mp.policy || !mp.policy.installation)
      error('marketplace.policy.installation is required');
    if (!mp.policy || !mp.policy.authentication)
      error('marketplace.policy.authentication is required');
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

function normalizeDependencyPlatforms(entry) {
  if (!entry.when || !Array.isArray(entry.when.platforms)) {
    return ['codex', 'claude'];
  }
  return entry.when.platforms;
}

function validateManifestDependenciesLightweight(pluginName, dependencies) {
  if (dependencies === undefined) return;

  const record = expectRecord(dependencies, 'dependencies');
  if (!record) return;
  validateAllowedKeys(record, 'dependencies', ['plugins']);

  if (!Array.isArray(record.plugins)) {
    error('dependencies.plugins must be an array');
    return;
  }

  if (record.plugins.length === 0) {
    warn('dependencies.plugins 为空；可以删除整个 dependencies block。');
  }

  const seen = new Map();
  record.plugins.forEach((rawEntry, index) => {
    const fieldName = `dependencies.plugins[${index}]`;
    const entry = expectRecord(rawEntry, fieldName);
    if (!entry) return;
    validateAllowedKeys(entry, fieldName, ['name', 'target', 'inheritInstallOptions', 'when']);
    let platformsForOverlap = ['codex', 'claude'];

    const name = validateManifestString(entry.name, `${fieldName}.name`);
    if (name && !PLUGIN_NAME_PATTERN.test(name)) {
      error(`${fieldName}.name must use lowercase-hyphen-case`);
    }
    if (name && pluginName && name === pluginName) {
      error(`${fieldName}.name: plugin "${pluginName}" cannot depend on itself.`);
    }

    if (entry.target !== undefined) {
      const target = expectRecord(entry.target, `${fieldName}.target`);
      if (target) {
        validateAllowedKeys(target, `${fieldName}.target`, ['scope']);
        if (typeof target.scope !== 'string' || (target.scope !== 'user' && target.scope !== 'project')) {
          error(`${fieldName}.target.scope must be "user" or "project"`);
        }
      }
    }

    if (entry.inheritInstallOptions !== undefined && typeof entry.inheritInstallOptions !== 'boolean') {
      error(`${fieldName}.inheritInstallOptions must be a boolean`);
    }

    if (entry.when !== undefined) {
      const when = expectRecord(entry.when, `${fieldName}.when`);
      if (when) {
        validateAllowedKeys(when, `${fieldName}.when`, ['platforms']);
        if (!Array.isArray(when.platforms)) {
          error(`${fieldName}.when.platforms must be an array`);
          platformsForOverlap = [];
        } else if (when.platforms.length === 0) {
          error(`${fieldName}.when.platforms must contain at least one platform`);
          platformsForOverlap = [];
        } else {
          const platforms = [];
          let invalidPlatforms = false;
          when.platforms.forEach((platform, platformIndex) => {
            const platformField = `${fieldName}.when.platforms[${platformIndex}]`;
            if (typeof platform !== 'string' || !PLUGIN_DEPENDENCY_PLATFORMS.has(platform)) {
              error(`${platformField} must be "codex" or "claude"`);
              invalidPlatforms = true;
              return;
            }
            if (platforms.includes(platform)) {
              error(`${platformField} duplicate platform "${platform}"`);
              invalidPlatforms = true;
              return;
            }
            platforms.push(platform);
          });
          platformsForOverlap = invalidPlatforms ? [] : platforms;
        }
      }
    }

    if (!name) return;
    for (const platform of platformsForOverlap) {
      const platformKey = `${name}::${platform}`;
      if (seen.has(platformKey)) {
        error(`${fieldName}.when.platforms overlaps with dependencies.plugins[${seen.get(platformKey)}] for plugin "${name}" on platform "${platform}"`);
        continue;
      }
      seen.set(platformKey, index);
    }
  });
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
  if (maxLength !== undefined && trimmed.length > maxLength) {
    error(`${fieldName} must be <= ${maxLength} characters`);
  }
  return trimmed;
}

function countCharacters(value) {
  return Array.from(value).length;
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

function validateOptionalBoolean(record, key, fieldName) {
  if (record[key] !== undefined && typeof record[key] !== 'boolean') {
    error(`${fieldName}.${key} must be a boolean`);
  }
}

function validateAllowedTools(value, fieldName) {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      error(`${fieldName} must not be an empty string`);
    }
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

function validateSkillFrontmatter(fm, skillName, targetsClaude) {
  const fieldName = `skills/${skillName}/SKILL.md frontmatter`;

  if (fm.name === undefined) {
    error(`${fieldName} missing "name"`);
  } else {
    const name = validateNonEmptyString(fm.name, `${fieldName}.name`, MAX_SKILL_NAME_LEN);
    if (name) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        error(`${fieldName}.name must use lowercase hyphen-case`);
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

  if (fm.when_to_use !== undefined) {
    validateNonEmptyString(fm.when_to_use, `${fieldName}.when_to_use`);
  } else if (targetsClaude && fm['disable-model-invocation'] !== true) {
    warn(
      `${fieldName}.when_to_use is recommended when Claude model invocation is enabled`,
    );
  }

  validateOptionalBoolean(fm, 'user-invocable', fieldName);
  validateOptionalBoolean(fm, 'disable-model-invocation', fieldName);

  if (fm.metadata !== undefined) {
    const metadata = expectRecord(fm.metadata, `${fieldName}.metadata`);
    if (metadata && metadata['short-description'] !== undefined) {
      validateNonEmptyString(
        metadata['short-description'],
        `${fieldName}.metadata.short-description`,
        MAX_SKILL_SHORT_DESCRIPTION_LEN,
      );
    }
  }

  if (fm['allowed-tools'] !== undefined) {
    validateAllowedTools(fm['allowed-tools'], `${fieldName}.allowed-tools`);
  }

  if (fm.shell !== undefined) {
    if (typeof fm.shell !== 'string') {
      error(`${fieldName}.shell must be a string`);
    } else if (!CLAUDE_FRONTMATTER_SHELLS.has(fm.shell.trim().toLowerCase())) {
      error(`${fieldName}.shell must be "bash" or "powershell"`);
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
      error(
        `"${filename}" exists but manifest does not declare "${field}" — declare it or remove the file`,
      );
    }
  }
}

function findCurrentCatalogPluginsDir(pluginDir) {
  const parentDir = path.dirname(pluginDir);
  return path.basename(parentDir) === 'plugins' ? parentDir : null;
}

function collectCurrentCatalogPluginNames(pluginsDir) {
  const pluginNames = new Set();
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(pluginsDir, entry.name, '.agents-plugin', 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest && typeof manifest.name === 'string' && manifest.name.trim() !== '') {
        pluginNames.add(manifest.name);
      }
    } catch {
      continue;
    }
  }
  return pluginNames;
}

function validateCatalogDependencyReferences(pluginDir, manifest) {
  const dependencies = manifest.dependencies?.plugins;
  if (!Array.isArray(dependencies) || dependencies.length === 0) {
    return;
  }

  const pluginsDir = findCurrentCatalogPluginsDir(pluginDir);
  if (!pluginsDir) {
    warn('当前插件目录不在 "<catalog>/plugins/<name>" 结构下，跳过 dependencies.plugins 的 catalog 存在性校验。');
    return;
  }

  const pluginNames = collectCurrentCatalogPluginNames(pluginsDir);
  dependencies.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
      return;
    }
    if (!pluginNames.has(entry.name)) {
      error(`Invalid dependencies.plugins[${index}].name for plugin "${manifest.name}": current catalog is missing plugin "${entry.name}".`);
    }
  });
}

function validateSkillTriggers(pluginDir, manifest) {
  if (manifest.skillTriggers === undefined) return;

  const skillTriggers = expectRecord(manifest.skillTriggers, 'skillTriggers');
  if (!skillTriggers) return;

  if (manifest.skills === undefined) {
    error('skillTriggers requires a declared "skills" directory');
  }

  const skillsRoot =
    typeof manifest.skills === 'string'
      ? path.join(pluginDir, manifest.skills)
      : null;

  for (const [skillName, rawPolicy] of Object.entries(skillTriggers)) {
    const fieldName = `skillTriggers.${skillName}`;
    const policy = expectRecord(rawPolicy, fieldName);
    if (!policy) continue;
    validateAllowedKeys(policy, fieldName, ['allowInstallOverride']);

    if (typeof policy.allowInstallOverride !== 'boolean') {
      error(`${fieldName}.allowInstallOverride must be a boolean`);
    }

    if (!skillsRoot) continue;
    const skillDir = path.join(skillsRoot, skillName);
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      error(`${fieldName} must match an existing source skill directory`);
    }
  }
}

function isNodeRunnablePath(relativePath) {
  return SCRIPT_NODE_EXTENSIONS.has(path.posix.extname(normalizeRelativePath(relativePath)));
}

function isAutoRunnablePath(relativePath) {
  return SCRIPT_AUTO_EXTENSIONS.has(path.posix.extname(normalizeRelativePath(relativePath)).toLowerCase());
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
  if (runner && !SCRIPT_RUNNERS.has(runner)) {
    error(`${fieldName}.runner has unsupported runner "${runner}"`);
  }
  if (options.requireNodeRunner && runner !== 'node') {
    error(`${fieldName}.runner must be "node"`);
  }

  const relativePath = normalizePluginScriptPath(pluginDir, entry.path, `${fieldName}.path`);
  validateDeclaredScriptFile(pluginDir, relativePath, `${fieldName}.path`);
  if (runner === 'auto' && relativePath && !isAutoRunnablePath(relativePath)) {
    error(`${fieldName}.path uses runner "auto" but has no supported extension (${[...SCRIPT_AUTO_EXTENSIONS].join(', ')})`);
  }
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

function validateLifecycleDefinition(pluginDir, value, fieldName, runtimeEntries) {
  if (typeof value === 'string') {
    const relativePath = normalizePluginScriptPath(pluginDir, value, fieldName);
    validateDeclaredScriptFile(pluginDir, relativePath, fieldName);
    if (relativePath && !isAutoRunnablePath(relativePath)) {
      error(`${fieldName} uses runner "auto" but has no supported extension (${[...SCRIPT_AUTO_EXTENSIONS].join(', ')})`);
    }
    if (relativePath && isNodeRunnablePath(relativePath)) {
      runtimeEntries.push({ path: relativePath, fieldName });
    }
    return { default: relativePath ? { runner: 'auto', path: relativePath } : null };
  }

  const selector = expectRecord(value, fieldName);
  if (!selector) return {};
  if ('runner' in selector || 'path' in selector || 'command' in selector) {
    error(`${fieldName} must declare lifecycle scripts under OS selectors`);
  }
  for (const selectorName of Object.keys(selector)) {
    if (!SCRIPT_OS_SELECTORS.has(selectorName)) {
      error(`${fieldName} has unknown OS selector "${selectorName}"`);
    }
  }

  const normalized = {};
  for (const [selectorName, entryValue] of Object.entries(selector)) {
    const entry = validateScriptEntry(
      pluginDir,
      entryValue,
      `${fieldName}.${selectorName}`,
    );
    if (entry) {
      normalized[selectorName] = entry;
      if (entry.runner === 'node' || (entry.runner === 'auto' && isNodeRunnablePath(entry.path))) {
        runtimeEntries.push({ path: entry.path, fieldName: `${fieldName}.${selectorName}.path` });
      }
    }
  }

  const orders = {
    linux: ['linux', 'unix', 'default'],
    darwin: ['darwin', 'unix', 'default'],
    win32: ['win32', 'windows', 'default'],
  };
  for (const [osName, order] of Object.entries(orders)) {
    if (!order.some((selectorName) => normalized[selectorName])) {
      error(`${fieldName} must include an entry that resolves on ${osName}`);
    }
  }
  return normalized;
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

function scanImportSpecifiers(source) {
  const references = [];
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/gs,
    /\bexport\s+(?:[^'"]*?\s+from\s*)['"]([^'"]+)['"]/gs,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gs,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gs,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      references.push(match[1]);
    }
  }
  return references;
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
    for (const specifier of scanImportSpecifiers(source)) {
      if (specifier.startsWith('node:')) continue;

      if (isRelativeSpecifier(specifier)) {
        const resolved = resolveRelativeJavaScriptImport(relativePath, specifier, pluginDir);
        if (resolved.escaped) {
          error(`${options.label}: relative import "${specifier}" from "${relativePath}" escapes the plugin root`);
          continue;
        }
        if (!resolved.path) {
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
  const configRoot = expectRecord(config, 'config');
  if (!configRoot) return;
  validateAllowedKeys(configRoot, 'config', ['schema']);
  const schema = expectRecord(configRoot.schema, 'config.schema');
  if (!schema) return;
  for (const [key, rawField] of Object.entries(schema)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      error(`config.schema has invalid key "${key}"`);
    }
    const fieldName = `config.schema.${key}`;
    const field = expectRecord(rawField, fieldName);
    if (!field) continue;
    validateAllowedKeys(field, fieldName, [
      'type',
      'title',
      'description',
      'default',
      'required',
      'sensitive',
      'values',
      'min',
      'max',
    ]);
    if (typeof field.type !== 'string' || !CONFIG_FIELD_TYPES.has(field.type)) {
      error(`${fieldName}.type must be string, number, boolean, enum, file, or directory`);
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') {
      error(`${fieldName}.required must be a boolean`);
    }
    if (field.sensitive !== undefined && typeof field.sensitive !== 'boolean') {
      error(`${fieldName}.sensitive must be a boolean`);
    }
    if (field.values !== undefined) {
      if (field.type !== 'enum' || !Array.isArray(field.values) || field.values.length === 0) {
        error(`${fieldName}.values is only supported for enum config and must be non-empty`);
      }
    } else if (field.type === 'enum') {
      error(`${fieldName}.values is required for enum config`);
    }
    if (field.type !== 'number' && (field.min !== undefined || field.max !== undefined)) {
      error(`${fieldName}.min/max are only supported for number config`);
    }
    if (field.min !== undefined && typeof field.min !== 'number') {
      error(`${fieldName}.min must be a number`);
    }
    if (field.max !== undefined && typeof field.max !== 'number') {
      error(`${fieldName}.max must be a number`);
    }
    if (typeof field.min === 'number' && typeof field.max === 'number' && field.min > field.max) {
      error(`${fieldName}.min must be less than or equal to max`);
    }
  }
}

function configSchemaKeys(manifest) {
  const schema = manifest.config?.schema;
  return isRecord(schema) ? new Set(Object.keys(schema)) : new Set();
}

function configSchemaField(manifest, key) {
  const field = manifest.config?.schema?.[key];
  return isRecord(field) ? field : null;
}

function defaultConfigValues(manifest) {
  const schema = manifest.config?.schema;
  const values = {};
  if (!isRecord(schema)) return values;
  for (const [key, field] of Object.entries(schema)) {
    if (isRecord(field) && Object.prototype.hasOwnProperty.call(field, 'default')) {
      values[key] = field.default;
    }
  }
  return values;
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

function validateArtifactTargetEntry(entry, index, manifest, seen) {
  const fieldName = `artifacts.targets[${index}]`;
  const target = expectRecord(entry, fieldName);
  if (!target) return null;

  validateAllowedKeys(target, fieldName, [
    'id',
    'platform',
    'scopes',
    'target',
    'kind',
    'projectManagedKind',
    'states',
    'refreshKeys',
    'requiresCodexProjectConfig',
    'roleKey',
    'skillKey',
  ]);

  const id = validateArtifactId(target.id, `${fieldName}.id`);
  const platform = validateManifestString(target.platform, `${fieldName}.platform`);
  const artifactTarget = validateManifestString(target.target, `${fieldName}.target`);
  if (platform && platform !== 'codex') {
    error(`${fieldName}.platform: dynamic Codex artifacts must use "codex"`);
  }
  if (artifactTarget && !ARTIFACT_TARGETS.has(artifactTarget)) {
    error(`${fieldName}.target: unsupported artifact target "${artifactTarget}"`);
  }

  const key = id && artifactTarget ? `${id}:${artifactTarget}` : null;
  if (key) {
    if (seen.has(key)) {
      error(`${fieldName}: duplicate artifact id + target "${key}"`);
    }
    seen.add(key);
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
    const field = configSchemaField(manifest, refreshKey);
    if (
      scopes.includes('project') &&
      (field?.type === 'file' || field?.type === 'directory')
    ) {
      error(`${fieldName}.refreshKeys[${refreshIndex}]: project-scope repo-visible artifacts cannot depend on "${field.type}" config key "${refreshKey}"; use a portable string key or keep the path in user/project local config for lifecycle/helper code.`);
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
  if (artifactTarget === 'codex.skill') {
    skillKey = validateCodexSkillKey(target.skillKey, `${fieldName}.skillKey`);
    if (!skillKey) {
      error(`${fieldName}.skillKey: codex.skill targets must declare a static skillKey`);
    }
  } else if (target.skillKey !== undefined) {
    error(`${fieldName}.skillKey: skillKey is only supported for codex.skill targets`);
  }

  return {
    id,
    platform,
    scopes,
    target: artifactTarget,
    kind,
    projectManagedKind,
    states,
    refreshKeys,
    roleKey,
    skillKey,
  };
}

function validateArtifactsConfigLightweight(manifest) {
  if (manifest.artifacts === undefined) return [];
  const artifacts = expectRecord(manifest.artifacts, 'artifacts');
  if (!artifacts) return [];
  validateAllowedKeys(artifacts, 'artifacts', ['targets']);
  if (artifacts.targets === undefined) return [];
  if (!Array.isArray(artifacts.targets)) {
    error('artifacts.targets must be an array');
    return [];
  }

  const seen = new Set();
  return artifacts.targets
    .map((entry, index) => validateArtifactTargetEntry(entry, index, manifest, seen))
    .filter(Boolean);
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

function validateRenderedArtifactPlan(plan, declarations, scopeLabel) {
  const planField = `scripts.artifacts.render fixture (${scopeLabel})`;
  const root = expectRecord(plan, planField);
  if (!root) return;
  validateAllowedKeys(root, planField, ['version', 'artifacts']);
  if (root.version !== 1) {
    error(`${planField}.version must be 1`);
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

    if (entry.platform !== declaration.platform) {
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
    if (declaration.target === 'codex.skill') {
      if (entry.skillKey !== declaration.skillKey) {
        error(`${fieldName}.skillKey: expected "${declaration.skillKey}" from static metadata`);
      }
      if (entry.state === 'present') {
        if (!isRecord(entry.content)) {
          error(`${fieldName}.content must be an object for codex.skill artifacts`);
        } else {
          validateAllowedKeys(entry.content, `${fieldName}.content`, ['skillFile', 'openaiYaml']);
          if (typeof entry.content.skillFile !== 'string' || entry.content.skillFile.trim() === '') {
            error(`${fieldName}.content.skillFile must be a non-empty string`);
          }
          if (typeof entry.content.openaiYaml !== 'string' || entry.content.openaiYaml.trim() === '') {
            error(`${fieldName}.content.openaiYaml must be a non-empty string`);
          }
        }
      }
    } else if (entry.skillKey !== undefined) {
      error(`${fieldName}.skillKey is only supported for codex.skill artifacts`);
    }
  });

  for (const declaration of declarations) {
    const key = `${declaration.id}:${declaration.target}`;
    if (!returned.has(key)) {
      error(`${planField}: renderer must return artifact "${declaration.id}" target "${declaration.target}"`);
    }
  }
}

function runArtifactRendererFixture(pluginDir, manifest, renderEntry, declarations) {
  if (!renderEntry || declarations.length === 0) return;

  const scopes = [...new Set(declarations.flatMap((target) => target.scopes))];
  const values = defaultConfigValues(manifest);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-artifact-render-'));
  try {
    for (const scope of scopes) {
      const scopedDeclarations = declarations.filter((target) => target.scopes.includes(scope));
      const contextPath = path.join(tempRoot, `context-${scope}.json`);
      fs.writeFileSync(
        contextPath,
        JSON.stringify({
          event: 'install',
          platform: 'codex',
          scope,
          plugin: {
            name: manifest.name,
            version: manifest.version,
            rootDir: pluginDir,
          },
          rootDir: pluginDir,
          manifestPath: path.join(pluginDir, '.agents-plugin', 'plugin.json'),
          config: { schema: manifest.config?.schema ?? {}, values },
          renderConfig: { values },
          artifactRenderConfig: { values },
          changedConfigKeys: [],
          previousArtifacts: [],
          awHome: path.join(tempRoot, 'aw-home'),
          codexHome: path.join(tempRoot, 'codex-home'),
          claudeHome: path.join(tempRoot, 'claude-home'),
        }),
        'utf8',
      );
      const result = spawnSync(
        process.execPath,
        [path.join(pluginDir, renderEntry.path), ...(renderEntry.args ?? [])],
        {
          cwd: pluginDir,
          env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath },
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        },
      );
      const fieldName = `scripts.artifacts.render fixture (${scope})`;
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
      validateRenderedArtifactPlan(plan, scopedDeclarations, scope);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validateDynamicArtifactsLightweight(pluginDir, manifest, renderEntry) {
  const declarations = validateArtifactsConfigLightweight(manifest);
  const hasTargets = declarations.length > 0;
  const hasRenderer = Boolean(manifest.scripts?.artifacts?.render);

  if (hasTargets && !hasRenderer) {
    error('artifacts.targets requires scripts.artifacts.render');
  }
  if (hasRenderer && !hasTargets) {
    error('scripts.artifacts.render requires artifacts.targets');
  }

  runArtifactRendererFixture(pluginDir, manifest, renderEntry, declarations);
}

function validateScriptsLightweight(pluginDir, manifest) {
  validateConfigSchemaLightweight(manifest.config);
  if (manifest.scripts === undefined) return null;

  const scripts = expectRecord(manifest.scripts, 'scripts');
  if (!scripts) return null;
  validateAllowedKeys(scripts, 'scripts', ['timeoutMs', 'lifecycle', 'helpers', 'node', 'artifacts', 'tests']);
  if (
    scripts.timeoutMs !== undefined &&
    (!Number.isInteger(scripts.timeoutMs) ||
      scripts.timeoutMs < SCRIPT_TIMEOUT_MIN_MS ||
      scripts.timeoutMs > SCRIPT_TIMEOUT_MAX_MS)
  ) {
    error(`scripts.timeoutMs must be an integer between ${SCRIPT_TIMEOUT_MIN_MS} and ${SCRIPT_TIMEOUT_MAX_MS}`);
  }

  const runtimeNodeEntries = [];
  let artifactRenderEntry = null;
  let packageMeta = null;

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

  if (scripts.lifecycle !== undefined) {
    const lifecycle = expectRecord(scripts.lifecycle, 'scripts.lifecycle');
    if (lifecycle) {
      validateAllowedKeys(lifecycle, 'scripts.lifecycle', [...SCRIPT_LIFECYCLE_EVENTS]);
      for (const [eventName, definition] of Object.entries(lifecycle)) {
        if (!SCRIPT_LIFECYCLE_EVENTS.has(eventName)) {
          error(`scripts.lifecycle has unsupported event "${eventName}"`);
          continue;
        }
        validateLifecycleDefinition(
          pluginDir,
          definition,
          `scripts.lifecycle.${eventName}`,
          runtimeNodeEntries,
        );
      }
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

function validateOpenAiYaml(openaiYamlPath, skillName, required, manifest, pluginDir) {
  const fieldName = `skills/${skillName}/agents/openai.yaml`;

  if (!fs.existsSync(openaiYamlPath)) {
    if (required) {
      error(`${fieldName} not found; Codex-targeted skills must declare Codex trigger policy`);
    } else {
      warn(`${fieldName} not found; this is acceptable only for non-Codex skills`);
    }
    return;
  }

  let config;
  try {
    const relativePath = path.relative(pluginDir, openaiYamlPath);
    const rawContent = fs.readFileSync(openaiYamlPath, 'utf8');
    config = parseYaml(
      renderTemplateForPlatform(manifest, relativePath, rawContent, 'codex'),
      fieldName,
    );
  } catch (e) {
    error(`${fieldName} is not valid YAML: ${e.message}`);
    return;
  }

  const root = expectRecord(config, fieldName);
  if (!root) return;
  validateAllowedKeys(root, fieldName, ['interface', 'dependencies', 'policy']);

  if (root.interface !== undefined) {
    const interfaceBlock = expectRecord(root.interface, `${fieldName}.interface`);
    if (interfaceBlock) {
      validateAllowedKeys(interfaceBlock, `${fieldName}.interface`, [
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
        `${fieldName}.interface`,
        MAX_OPENAI_INTERFACE_NAME_LEN,
      );
      validateCodexMetadataString(
        interfaceBlock,
        'short_description',
        `${fieldName}.interface`,
        MAX_OPENAI_INTERFACE_DESCRIPTION_LEN,
      );
      validateCodexDefaultPrompt(
        interfaceBlock,
        'default_prompt',
        `${fieldName}.interface`,
        MAX_OPENAI_DEFAULT_PROMPT_LEN,
        skillName,
      );
      validateCodexIconPath(interfaceBlock, 'icon_small', `${fieldName}.interface`);
      validateCodexIconPath(interfaceBlock, 'icon_large', `${fieldName}.interface`);
      validateCodexBrandColor(interfaceBlock, 'brand_color', `${fieldName}.interface`);
    }
  }

  if (root.dependencies !== undefined) {
    const dependenciesBlock = expectRecord(root.dependencies, `${fieldName}.dependencies`);
    if (dependenciesBlock) {
      validateAllowedKeys(dependenciesBlock, `${fieldName}.dependencies`, ['tools']);
      if (dependenciesBlock.tools !== undefined) {
        if (!Array.isArray(dependenciesBlock.tools)) {
          error(`${fieldName}.dependencies.tools must be an array`);
        } else {
          for (const [index, tool] of dependenciesBlock.tools.entries()) {
            const toolField = `${fieldName}.dependencies.tools[${index}]`;
            const toolBlock = expectRecord(tool, toolField);
            if (!toolBlock) continue;
            validateAllowedKeys(toolBlock, toolField, [
              'type',
              'value',
              'description',
              'transport',
              'url',
              'command',
            ]);
            validateCodexMetadataString(
              toolBlock,
              'type',
              toolField,
              MAX_OPENAI_DEPENDENCY_TYPE_LEN,
              true,
            );
            validateCodexMetadataString(
              toolBlock,
              'value',
              toolField,
              MAX_OPENAI_DEPENDENCY_VALUE_LEN,
              true,
            );
            validateCodexMetadataString(
              toolBlock,
              'description',
              toolField,
              MAX_OPENAI_DEPENDENCY_DESCRIPTION_LEN,
            );
            const transport = validateCodexMetadataString(
              toolBlock,
              'transport',
              toolField,
              MAX_OPENAI_DEPENDENCY_TRANSPORT_LEN,
            );
            validateCodexMetadataString(
              toolBlock,
              'url',
              toolField,
              MAX_OPENAI_DEPENDENCY_URL_LEN,
            );
            validateCodexMetadataString(
              toolBlock,
              'command',
              toolField,
              MAX_OPENAI_DEPENDENCY_COMMAND_LEN,
            );
            if (
              transport !== null &&
              transport !== 'streamable_http' &&
              transport !== 'stdio'
            ) {
              error(`${toolField}.transport must be "streamable_http" or "stdio"`);
            }
          }
        }
      }
    }
  }

  if (root.policy === undefined) {
    if (required) {
      error(`${fieldName}.policy is required for Codex-targeted skills`);
    }
    return;
  }

  const policyBlock = expectRecord(root.policy, `${fieldName}.policy`);
  if (!policyBlock) return;
  validateAllowedKeys(policyBlock, `${fieldName}.policy`, [
    'allow_implicit_invocation',
    'products',
  ]);

  if (policyBlock.allow_implicit_invocation === undefined) {
    if (required) {
      error(`${fieldName}.policy.allow_implicit_invocation is required`);
    }
  } else if (typeof policyBlock.allow_implicit_invocation !== 'boolean') {
    error(`${fieldName}.policy.allow_implicit_invocation must be a boolean`);
  }

  if (policyBlock.products !== undefined) {
    if (!Array.isArray(policyBlock.products)) {
      error(`${fieldName}.policy.products must be an array`);
    } else {
      for (const [index, product] of policyBlock.products.entries()) {
        const productField = `${fieldName}.policy.products[${index}]`;
        if (typeof product !== 'string' || product.trim() === '') {
          error(`${productField} must be a non-empty string`);
        } else if (!CODEX_POLICY_PRODUCTS.has(product)) {
          error(
            `${productField} must be one of "codex", "chatgpt", "atlas" or uppercase aliases`,
          );
        }
      }
    }
  }
}

function validateSkills(pluginDir, manifest) {
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
      let fm;
      let frontmatterParseFailed = false;
      try {
        fm = parseFrontmatter(variant.content, sourceName);
      } catch (e) {
        error(`skills/${dir.name}/SKILL.md has invalid YAML frontmatter: ${e.message}`);
        frontmatterParseFailed = true;
        fm = null;
      }
      if (!fm) {
        if (!frontmatterParseFailed) {
          error(`skills/${dir.name}/SKILL.md has no YAML frontmatter`);
        }
      } else {
        const shouldApplyClaudeWarnings =
          variant.platform === null ? targetsClaude : variant.platform === 'claude';
        validateSkillFrontmatter(fm, dir.name, shouldApplyClaudeWarnings);
      }
    }

    validateOpenAiYaml(
      openaiYamlPath,
      dir.name,
      requiresCodexMetadata,
      manifest,
      pluginDir,
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
          validateCodexMetadataString(
            interfaceBlock,
            'short_description',
            `${fieldName}.codex.interface`,
            MAX_OPENAI_INTERFACE_DESCRIPTION_LEN,
          );
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

async function validatePluginDir(pluginDir) {
  const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');

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

  const cliManifestTools = await tryLoadCliManifestTools();
  if (cliManifestTools?.validateSourcePluginManifest) {
    try {
      await cliManifestTools.validateSourcePluginManifest(pluginDir, manifest);
    } catch (e) {
      error(e.message);
    }
    validatePlatformFieldSupport(manifest);
  } else {
    warn(
      'CLI 未构建（packages/cli/dist/ 不存在），仅执行轻量预检；预检通过不代表完整 contract 通过，运行 pnpm build 后可获得权威源码校验',
    );
    validateManifestLightweight(manifest);
    validateDeclaredPathsExist(pluginDir, manifest);
  }

  validateNameMatchesDirectory(pluginDir, manifest);
  validateNoBuildOutputDirs(pluginDir);
  validateDeclaredNativeAssets(pluginDir, manifest);
  validateCatalogDependencyReferences(pluginDir, manifest);
  validateSkillTriggers(pluginDir, manifest);
  const artifactRenderEntry = validateScriptsLightweight(pluginDir, manifest);
  validateDynamicArtifactsLightweight(pluginDir, manifest, artifactRenderEntry);
  validateMcpContent(pluginDir, manifest);
  validateAppsContent(pluginDir, manifest);
  warnCodexProjectScopeLimitations(manifest);
  validateExtensionNameUniqueness(manifest);
  validateSkills(pluginDir, manifest);
  validateSlashCommands(pluginDir, manifest);
}

async function main() {
  const pluginDir = process.argv[2];
  if (!pluginDir) {
    console.error('Usage: node validate_plugin.js <plugin-directory>');
    process.exit(1);
  }

  const resolved = path.resolve(pluginDir);
  if (!fs.existsSync(resolved)) {
    console.error(`[ERROR] Directory not found: ${resolved}`);
    process.exit(1);
  }

  await validatePluginDir(resolved);

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
