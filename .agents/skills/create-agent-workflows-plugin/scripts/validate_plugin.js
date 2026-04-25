#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const errors = [];
const warnings = [];

function error(msg) {
  errors.push(msg);
}

function warn(msg) {
  warnings.push(msg);
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

function validatePluginDir(pluginDir) {
  const pluginName = path.basename(pluginDir);
  const manifestPath = path.join(pluginDir, '.agents-plugin', 'plugin.json');

  // 1. .agents-plugin/plugin.json exists and is valid JSON
  if (!fs.existsSync(manifestPath)) {
    error(`.agents-plugin/plugin.json not found`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    error(`.agents-plugin/plugin.json is not valid JSON: ${e.message}`);
    return;
  }

  // 2. Required fields
  for (const field of ['name', 'version', 'description', 'marketplace']) {
    if (!manifest[field]) {
      error(`Missing required field: ${field}`);
    }
  }

  // 3. Name matches directory and is lowercase-hyphen
  if (manifest.name && manifest.name !== pluginName) {
    error(`manifest name "${manifest.name}" does not match directory name "${pluginName}"`);
  }
  if (manifest.name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)) {
    error(`manifest name "${manifest.name}" is not lowercase-hyphen-case`);
  }

  // 4. Marketplace required fields
  if (manifest.marketplace) {
    const mp = manifest.marketplace;
    if (!mp.category) error('marketplace.category is required');
    if (typeof mp.strict !== 'boolean') error('marketplace.strict must be a boolean');
    if (!mp.policy || !mp.policy.installation) error('marketplace.policy.installation is required');
    if (!mp.policy || !mp.policy.authentication) error('marketplace.policy.authentication is required');
  }

  // 5-7. Declared asset paths exist
  const pathFields = ['skills', 'mcpServers', 'apps'];
  for (const field of pathFields) {
    if (!manifest[field]) continue;

    // 9. Path fields start with ./
    if (!manifest[field].startsWith('./')) {
      error(`${field} path must start with "./", got "${manifest[field]}"`);
    }

    const resolved = path.join(pluginDir, manifest[field]);
    if (!fs.existsSync(resolved)) {
      error(`${field} points to "${manifest[field]}" but path does not exist: ${resolved}`);
    }
  }

  // 8. No .claude-plugin/ or .codex-plugin/ directories
  if (fs.existsSync(path.join(pluginDir, '.claude-plugin'))) {
    error('.claude-plugin/ directory must not exist in plugin source (it is a build output)');
  }
  if (fs.existsSync(path.join(pluginDir, '.codex-plugin'))) {
    error('.codex-plugin/ directory must not exist in plugin source (it is a build output)');
  }

  // 9. Validate mcpServers file content if declared
  if (manifest.mcpServers) {
    const mcpPath = path.join(pluginDir, manifest.mcpServers);
    if (fs.existsSync(mcpPath)) {
      try {
        const mcpContent = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        if (!mcpContent.mcpServers || typeof mcpContent.mcpServers !== 'object') {
          error(`${manifest.mcpServers} must have a "mcpServers" top-level key`);
        }
      } catch (e) {
        error(`${manifest.mcpServers} is not valid JSON: ${e.message}`);
      }
    }
  }

  // 10. Validate apps file content if declared
  if (manifest.apps) {
    const appsPath = path.join(pluginDir, manifest.apps);
    if (fs.existsSync(appsPath)) {
      try {
        const appsContent = JSON.parse(fs.readFileSync(appsPath, 'utf8'));
        if (!appsContent.apps || typeof appsContent.apps !== 'object') {
          error(`${manifest.apps} must have an "apps" top-level key`);
        }
      } catch (e) {
        error(`${manifest.apps} is not valid JSON: ${e.message}`);
      }
    }
  }

  // 11. Validate extensions name uniqueness if declared
  if (manifest.extensions) {
    for (const extType of ['instructions', 'permissions', 'hooks', 'agents']) {
      const items = manifest.extensions[extType];
      if (!Array.isArray(items)) continue;
      const names = new Set();
      for (const item of items) {
        if (item.name) {
          if (names.has(item.name)) {
            error(`extensions.${extType} has duplicate name: "${item.name}"`);
          }
          names.add(item.name);
        }
      }
    }
  }

  // 12-14. Validate skills if declared
  if (manifest.skills) {
    const skillsDir = path.join(pluginDir, manifest.skills);
    if (fs.existsSync(skillsDir)) {
      const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      if (skillDirs.length === 0) {
        error('skills directory exists but contains no skill subdirectories');
      }

      for (const skillDir of skillDirs) {
        const skillPath = path.join(skillsDir, skillDir.name);
        const skillMdPath = path.join(skillPath, 'SKILL.md');
        const openaiYamlPath = path.join(skillPath, 'agents', 'openai.yaml');

        // 10. SKILL.md has valid frontmatter
        if (!fs.existsSync(skillMdPath)) {
          error(`skills/${skillDir.name}/SKILL.md not found`);
          continue;
        }

        const skillContent = fs.readFileSync(skillMdPath, 'utf8');
        const fm = parseFrontmatter(skillContent);
        if (!fm) {
          error(`skills/${skillDir.name}/SKILL.md has no YAML frontmatter`);
        } else {
          if (!fm.name) error(`skills/${skillDir.name}/SKILL.md frontmatter missing "name"`);
          if (!fm.description) error(`skills/${skillDir.name}/SKILL.md frontmatter missing "description"`);
        }

        // 11. agents/openai.yaml exists alongside SKILL.md
        if (!fs.existsSync(openaiYamlPath)) {
          warn(`skills/${skillDir.name}/agents/openai.yaml not found`);
        }

        // 12. No TODO placeholders in SKILL.md
        if (/\[TODO[:\]]/i.test(skillContent)) {
          error(`skills/${skillDir.name}/SKILL.md still contains TODO placeholders`);
        }
      }
    }
  }
}

function main() {
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

  validatePluginDir(resolved);

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
