#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const errors = [];
const warnings = [];

function error(msg) {
  errors.push(msg);
}

function warn(msg) {
  warnings.push(msg);
}

function stripYamlComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseYamlScalar(rawValue, sourceName, lineNo) {
  const value = stripYamlComment(rawValue).trim();
  if (value.length === 0) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (value === '[]') return [];
  if (value === '{}') return {};

  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length === 1) {
      throw new Error(`${sourceName}:${lineNo}: unterminated double-quoted string`);
    }
    return JSON.parse(value);
  }

  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length === 1) {
      throw new Error(`${sourceName}:${lineNo}: unterminated single-quoted string`);
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }

  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value);
    } catch (e) {
      throw new Error(`${sourceName}:${lineNo}: invalid inline JSON-style YAML value: ${e.message}`);
    }
  }

  return value;
}

function parseYamlKeyValue(text, sourceName, lineNo) {
  const colonIndex = text.indexOf(':');
  if (colonIndex <= 0) {
    throw new Error(`${sourceName}:${lineNo}: expected "key: value"`);
  }

  const key = text.slice(0, colonIndex).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    throw new Error(`${sourceName}:${lineNo}: invalid key "${key}"`);
  }

  return {
    key,
    valueText: text.slice(colonIndex + 1),
  };
}

function preprocessYamlLines(content, sourceName) {
  const lines = [];
  const rawLines = content.replace(/\r\n/g, '\n').split('\n');
  for (const [lineIndex, rawLine] of rawLines.entries()) {
    if (/^\t+/.test(rawLine)) {
      throw new Error(`${sourceName}:${lineIndex + 1}: tabs are not supported for indentation`);
    }

    const trimmed = rawLine.trim();
    if (
      trimmed.length === 0 ||
      trimmed.startsWith('#') ||
      /^{{[#/^]|^{{else\b/.test(trimmed)
    ) {
      continue;
    }

    const indent = rawLine.match(/^ */)[0].length;
    const text = stripYamlComment(rawLine.slice(indent));
    if (text.trim().length === 0) continue;

    lines.push({
      indent,
      text,
      lineNo: lineIndex + 1,
    });
  }

  return lines;
}

function parseYamlBlock(lines, index, indent, sourceName) {
  if (index >= lines.length) {
    return { value: {}, index };
  }

  if (lines[index].indent < indent) {
    return { value: {}, index };
  }

  if (lines[index].text.startsWith('- ')) {
    return parseYamlSequence(lines, index, indent, sourceName);
  }

  return parseYamlMap(lines, index, indent, sourceName);
}

function parseYamlMap(lines, index, indent, sourceName) {
  const result = {};
  let cursor = index;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new Error(`${sourceName}:${line.lineNo}: unexpected indentation`);
    }
    if (line.text.startsWith('- ')) break;

    const { key, valueText } = parseYamlKeyValue(line.text, sourceName, line.lineNo);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`${sourceName}:${line.lineNo}: duplicate key "${key}"`);
    }

    cursor += 1;
    if (valueText.trim().length === 0) {
      if (cursor < lines.length && lines[cursor].indent > indent) {
        const parsed = parseYamlBlock(lines, cursor, lines[cursor].indent, sourceName);
        result[key] = parsed.value;
        cursor = parsed.index;
      } else {
        result[key] = {};
      }
    } else {
      result[key] = parseYamlScalar(valueText, sourceName, line.lineNo);
    }
  }

  return { value: result, index: cursor };
}

function parseYamlSequence(lines, index, indent, sourceName) {
  const result = [];
  let cursor = index;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new Error(`${sourceName}:${line.lineNo}: unexpected indentation`);
    }
    if (!line.text.startsWith('- ')) break;

    const itemText = line.text.slice(2).trim();
    cursor += 1;

    if (itemText.length === 0) {
      if (cursor < lines.length && lines[cursor].indent > indent) {
        const parsed = parseYamlBlock(lines, cursor, lines[cursor].indent, sourceName);
        result.push(parsed.value);
        cursor = parsed.index;
      } else {
        result.push(null);
      }
      continue;
    }

    if (/^[A-Za-z0-9_.-]+\s*:/.test(itemText)) {
      const { key, valueText } = parseYamlKeyValue(itemText, sourceName, line.lineNo);
      const item = {};
      if (valueText.trim().length === 0) {
        if (cursor < lines.length && lines[cursor].indent > indent) {
          const parsed = parseYamlBlock(lines, cursor, lines[cursor].indent, sourceName);
          item[key] = parsed.value;
          cursor = parsed.index;
        } else {
          item[key] = {};
        }
      } else {
        item[key] = parseYamlScalar(valueText, sourceName, line.lineNo);
      }

      if (cursor < lines.length && lines[cursor].indent > indent) {
        const parsed = parseYamlBlock(lines, cursor, lines[cursor].indent, sourceName);
        if (!isRecord(parsed.value)) {
          throw new Error(`${sourceName}:${lines[cursor].lineNo}: expected mapping fields for list item`);
        }
        Object.assign(item, parsed.value);
        cursor = parsed.index;
      }

      result.push(item);
      continue;
    }

    result.push(parseYamlScalar(itemText, sourceName, line.lineNo));
  }

  return { value: result, index: cursor };
}

function parseYaml(content, sourceName) {
  const lines = preprocessYamlLines(content, sourceName);
  if (lines.length === 0) return {};
  const parsed = parseYamlBlock(lines, 0, lines[0].indent, sourceName);
  if (parsed.index < lines.length) {
    const line = lines[parsed.index];
    throw new Error(`${sourceName}:${line.lineNo}: could not parse line`);
  }
  return parsed.value;
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

function isCodexTargeted(manifest) {
  const products = manifest.marketplace?.policy?.products;
  if (!Array.isArray(products)) return true;
  return products.some((product) => String(product).trim().toUpperCase() === 'CODEX');
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
            ]);
            for (const key of ['type', 'value', 'description', 'transport', 'url']) {
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
      if (!fm.name)
        error(`skills/${dir.name}/SKILL.md frontmatter missing "name"`);
      else if (typeof fm.name !== 'string')
        error(`skills/${dir.name}/SKILL.md frontmatter "name" must be a string`);
      if (!fm.description)
        error(
          `skills/${dir.name}/SKILL.md frontmatter missing "description"`,
        );
      else if (typeof fm.description !== 'string')
        error(`skills/${dir.name}/SKILL.md frontmatter "description" must be a string`);
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
