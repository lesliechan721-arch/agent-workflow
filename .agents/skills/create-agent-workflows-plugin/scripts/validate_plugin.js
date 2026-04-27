#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
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
const CODEX_POLICY_PRODUCTS = new Set([
  'atlas',
  'ATLAS',
  'chatgpt',
  'CHATGPT',
  'codex',
  'CODEX',
]);
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

async function tryLoadCliValidator() {
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
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    return mod.validateSourcePluginManifest ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lightweight manifest checks (fallback when CLI not built)
// ---------------------------------------------------------------------------

function validateManifestLightweight(manifest) {
  for (const field of ['name', 'version', 'description', 'marketplace']) {
    if (!manifest[field]) {
      error(`Missing required field: ${field}`);
    }
  }

  if (manifest.name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)) {
    error(`manifest name "${manifest.name}" is not lowercase-hyphen-case`);
  }

  if (manifest.marketplace) {
    const mp = manifest.marketplace;
    if (!mp.category) error('marketplace.category is required');
    if (typeof mp.strict !== 'boolean')
      error('marketplace.strict must be a boolean');
    if (!mp.policy || !mp.policy.installation)
      error('marketplace.policy.installation is required');
    if (!mp.policy || !mp.policy.authentication)
      error('marketplace.policy.authentication is required');
  }

  for (const field of ['skills', 'mcpServers', 'apps']) {
    if (manifest[field] && !manifest[field].startsWith('./')) {
      error(`${field} path must start with "./", got "${manifest[field]}"`);
    }
  }

  validateExtensionsLightweight(manifest.extensions);
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
  const products = manifest.marketplace?.policy?.products;
  if (!Array.isArray(products)) return true;
  return products.some((product) => String(product).trim().toUpperCase() === 'CODEX');
}

function isClaudeTargeted(manifest) {
  const products = manifest.marketplace?.policy?.products;
  if (!Array.isArray(products)) return true;
  return products.some((product) => String(product).trim().toUpperCase() === 'CLAUDE');
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
  for (const field of ['skills', 'mcpServers', 'apps']) {
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
      validateCodexMetadataString(
        interfaceBlock,
        'default_prompt',
        `${fieldName}.interface`,
        MAX_OPENAI_DEFAULT_PROMPT_LEN,
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

  const cliValidate = await tryLoadCliValidator();
  if (cliValidate) {
    try {
      await cliValidate(pluginDir, manifest);
    } catch (e) {
      error(e.message);
    }
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
  validateMcpContent(pluginDir, manifest);
  validateAppsContent(pluginDir, manifest);
  validateExtensionNameUniqueness(manifest);
  validateSkills(pluginDir, manifest);
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
