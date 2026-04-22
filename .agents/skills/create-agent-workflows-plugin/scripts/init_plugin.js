#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

function requireHyphenName(value, fieldName) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    fail(
      `${fieldName} must use lowercase hyphen-case. Example: "git-commit", got "${value}".`,
    );
  }
  return value;
}

function titleCaseSlug(value) {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeText(filePath, content) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, content) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

function buildSourceManifest(pluginName, version, description, displayName, shortDescription) {
  return {
    name: pluginName,
    version,
    description,
    skills: './skills',
    interface: {
      displayName,
      shortDescription,
      capabilities: ['Skills'],
    },
    extensions: {
      instructions: [],
      permissions: [],
      hooks: [],
      agents: [],
    },
  };
}

function buildPlatformManifest(sourceManifest) {
  return {
    name: sourceManifest.name,
    version: sourceManifest.version,
    description: sourceManifest.description,
    skills: sourceManifest.skills,
    interface: sourceManifest.interface,
  };
}

function renderSkillMd(skillName, skillDescription) {
  const skillTitle = titleCaseSlug(skillName);
  return `---
name: ${skillName}
description: ${skillDescription}
---

# ${skillTitle}

用这个 skill 执行 [TODO: 说明这个插件真正要完成的工作流]。

建议按下面顺序执行：

1. [TODO: 第一步]
2. [TODO: 第二步]
3. [TODO: 第三步]

边界要求：

- [TODO: 不要扩大修改范围]
- [TODO: 遇到高风险操作时先停下来说明]
`;
}

function renderOpenAiYaml() {
  return `policy:
  allow_implicit_invocation: false
`;
}

function marketplaceEntry(pluginName, description) {
  return {
    name: pluginName,
    source: `./plugins/${pluginName}`,
    description,
    category: 'workflow',
    strict: true,
    policy: {
      installation: 'AVAILABLE',
      authentication: 'NONE',
      products: ['CODEX'],
    },
  };
}

function updateMarketplace(marketplacePath, entry) {
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  if (!Array.isArray(marketplace.plugins)) {
    fail(`${marketplacePath} is missing a valid plugins array.`);
  }

  const existingIndex = marketplace.plugins.findIndex(
    (item) => item && typeof item === 'object' && item.name === entry.name,
  );

  if (existingIndex >= 0) {
    marketplace.plugins[existingIndex] = entry;
  } else {
    marketplace.plugins.push(entry);
  }

  marketplace.plugins.sort((left, right) => left.name.localeCompare(right.name));
  writeJson(marketplacePath, marketplace);
}

function printUsage() {
  console.log(`Usage:
  node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js <plugin_name> --description "..."

Options:
  --description <text>          Plugin description. Required.
  --display-name <text>         Human-facing plugin display name.
  --short-description <text>    Short UI description.
  --skill-name <name>           Initial skill directory name.
  --skill-description <text>    Initial skill frontmatter description.
  --version <semver>            Plugin version. Default: 0.1.0
  --repo-root <path>            Repository root. Default: current directory.
  --skip-marketplace            Do not edit marketplace manifests.
  -h, --help                    Show this help message.
`);
}

function readOptionValue(args, index, flag) {
  const current = args[index];
  const eqIndex = current.indexOf('=');
  if (eqIndex >= 0) {
    return { value: current.slice(eqIndex + 1), nextIndex: index };
  }

  const nextValue = args[index + 1];
  if (!nextValue || nextValue.startsWith('--')) {
    fail(`${flag} requires a value.`);
  }

  return { value: nextValue, nextIndex: index + 1 };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    version: '0.1.0',
    repoRoot: '.',
    skipMarketplace: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }

    if (!arg.startsWith('--')) {
      if (!options.pluginName) {
        options.pluginName = arg;
        continue;
      }
      fail(`Unexpected positional argument: ${arg}`);
    }

    if (arg === '--skip-marketplace') {
      options.skipMarketplace = true;
      continue;
    }

    const normalizedFlag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const { value, nextIndex } = readOptionValue(args, index, normalizedFlag);
    index = nextIndex;

    switch (normalizedFlag) {
      case '--description':
        options.description = value;
        break;
      case '--display-name':
        options.displayName = value;
        break;
      case '--short-description':
        options.shortDescription = value;
        break;
      case '--skill-name':
        options.skillName = value;
        break;
      case '--skill-description':
        options.skillDescription = value;
        break;
      case '--version':
        options.version = value;
        break;
      case '--repo-root':
        options.repoRoot = value;
        break;
      default:
        fail(`Unknown option: ${normalizedFlag}`);
    }
  }

  if (!options.pluginName) {
    fail('plugin_name is required.');
  }
  if (!options.description) {
    fail('--description is required.');
  }

  return options;
}

function main() {
  const args = parseArgs(process.argv);

  const pluginName = requireHyphenName(args.pluginName, 'plugin_name');
  const skillName = requireHyphenName(args.skillName || pluginName, 'skill_name');
  const displayName = args.displayName || titleCaseSlug(pluginName);
  const shortDescription = args.shortDescription || args.description;
  const skillDescription = args.skillDescription || args.description;
  const repoRoot = path.resolve(args.repoRoot);

  const claudeMarketplace = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
  const codexMarketplace = path.join(repoRoot, '.agents', 'plugins', 'marketplace.json');
  const pluginsRoot = path.join(repoRoot, 'plugins');
  const pluginRoot = path.join(pluginsRoot, pluginName);

  if (!fs.existsSync(pluginsRoot)) {
    fail(`plugins directory not found: ${pluginsRoot}`);
  }
  if (fs.existsSync(pluginRoot)) {
    fail(`plugin already exists: ${pluginRoot}`);
  }
  if (!args.skipMarketplace) {
    if (!fs.existsSync(claudeMarketplace)) {
      fail(`missing marketplace manifest: ${claudeMarketplace}`);
    }
    if (!fs.existsSync(codexMarketplace)) {
      fail(`missing marketplace manifest: ${codexMarketplace}`);
    }
  }

  const sourceManifest = buildSourceManifest(
    pluginName,
    args.version,
    args.description,
    displayName,
    shortDescription,
  );
  const platformManifest = buildPlatformManifest(sourceManifest);

  const createdPaths = [
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    path.join(pluginRoot, 'skills', skillName, 'SKILL.md'),
    path.join(pluginRoot, 'skills', skillName, 'agents', 'openai.yaml'),
  ];

  writeJson(createdPaths[0], sourceManifest);
  writeJson(createdPaths[1], platformManifest);
  writeJson(createdPaths[2], platformManifest);
  writeText(createdPaths[3], renderSkillMd(skillName, skillDescription));
  writeText(createdPaths[4], renderOpenAiYaml());

  if (!args.skipMarketplace) {
    const entry = marketplaceEntry(pluginName, args.description);
    updateMarketplace(claudeMarketplace, entry);
    updateMarketplace(codexMarketplace, entry);
  }

  console.log('[OK] Created plugin scaffold:');
  for (const createdPath of createdPaths) {
    console.log(`  - ${createdPath}`);
  }

  if (args.skipMarketplace) {
    console.log('[OK] Marketplace manifests were left unchanged.');
  } else {
    console.log('[OK] Updated marketplace manifests:');
    console.log(`  - ${claudeMarketplace}`);
    console.log(`  - ${codexMarketplace}`);
  }
}

main();
