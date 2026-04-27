#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const errors = [];
const warnings = [];
const MAX_SKILL_NAME_LEN = 64;
const MAX_SKILL_DESCRIPTION_LEN = 1024;
const MAX_SKILL_SHORT_DESCRIPTION_LEN = 1024;
const CLAUDE_FRONTMATTER_SHELLS = new Set(['bash', 'powershell']);
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
}

function isTemplateAsset(manifest, relativePath) {
  const normalized = relativePath.replace(/^\.\//, '').split(path.sep).join('/');
  const include = manifest.buildConfig?.templates?.include;
  if (!Array.isArray(include)) return false;
  return include.some((pattern) => {
    if (pattern === normalized) return true;
    if (pattern.endsWith('/**')) {
      return normalized.startsWith(pattern.slice(0, -3));
    }
    if (pattern.includes('**/*')) {
      const [prefix, suffix] = pattern.split('**/*');
      return normalized.startsWith(prefix) && normalized.endsWith(suffix);
    }
    return false;
  });
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

function expectRecord(value, fieldName) {
  if (!isRecord(value)) {
    error(`${fieldName} must be an object`);
    return null;
  }
  return value;
}

function expectOptionalString(record, key, fieldName) {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    error(`${fieldName}.${key} must be a string`);
  }
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
    } else if (!CLAUDE_FRONTMATTER_SHELLS.has(fm.shell)) {
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

function validateOpenAiYaml(openaiYamlPath, skillName, required) {
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
    config = parseYaml(fs.readFileSync(openaiYamlPath, 'utf8'), fieldName);
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
      for (const key of [
        'display_name',
        'short_description',
        'icon_small',
        'icon_large',
        'brand_color',
        'default_prompt',
      ]) {
        expectOptionalString(interfaceBlock, key, `${fieldName}.interface`);
      }
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
            for (const key of ['type', 'value', 'description', 'transport', 'url', 'command']) {
              expectOptionalString(toolBlock, key, toolField);
            }
            if (
              toolBlock.transport !== undefined &&
              toolBlock.transport !== 'streamable_http' &&
              toolBlock.transport !== 'stdio'
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
  validateAllowedKeys(policyBlock, `${fieldName}.policy`, ['allow_implicit_invocation']);

  if (policyBlock.allow_implicit_invocation === undefined) {
    if (required) {
      error(`${fieldName}.policy.allow_implicit_invocation is required`);
    }
  } else if (typeof policyBlock.allow_implicit_invocation !== 'boolean') {
    error(`${fieldName}.policy.allow_implicit_invocation must be a boolean`);
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

    if (!fs.existsSync(skillMdPath)) {
      error(`skills/${dir.name}/SKILL.md not found`);
      continue;
    }

    const content = fs.readFileSync(skillMdPath, 'utf8');
    let fm;
    let frontmatterParseFailed = false;
    try {
      fm = parseFrontmatter(content, `skills/${dir.name}/SKILL.md`);
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
      validateSkillFrontmatter(fm, dir.name, targetsClaude);
    }

    validateOpenAiYaml(openaiYamlPath, dir.name, requiresCodexMetadata);

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
