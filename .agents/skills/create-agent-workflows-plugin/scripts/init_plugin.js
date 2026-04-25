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
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
        products: ['CODEX'],
      },
    },
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

  const pluginsRoot = path.join(repoRoot, 'plugins');
  const marketplaceSourcePath = path.join(pluginsRoot, 'marketplace-source.json');
  const pluginRoot = path.join(pluginsRoot, pluginName);

  if (!fs.existsSync(pluginsRoot)) {
    fail(`plugins directory not found: ${pluginsRoot}`);
  }
  if (!fs.existsSync(marketplaceSourcePath)) {
    fail(`marketplace source metadata not found: ${marketplaceSourcePath}`);
  }
  if (fs.existsSync(pluginRoot)) {
    fail(`plugin already exists: ${pluginRoot}`);
  }

  const sourceManifest = buildSourceManifest(
    pluginName,
    args.version,
    args.description,
    displayName,
    shortDescription,
  );

  const createdPaths = [
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    path.join(pluginRoot, 'skills', skillName, 'SKILL.md'),
    path.join(pluginRoot, 'skills', skillName, 'agents', 'openai.yaml'),
  ];

  writeJson(createdPaths[0], sourceManifest);
  writeText(createdPaths[1], renderSkillMd(skillName, skillDescription));
  writeText(createdPaths[2], renderOpenAiYaml());

  console.log('[OK] Created source-only plugin scaffold:');
  for (const createdPath of createdPaths) {
    console.log(`  - ${createdPath}`);
  }
  console.log(`[OK] Left marketplace source metadata unchanged: ${marketplaceSourcePath}`);
  console.log('[OK] Runtime marketplace and platform manifests will be generated by `pnpm build`.');
}

main();
