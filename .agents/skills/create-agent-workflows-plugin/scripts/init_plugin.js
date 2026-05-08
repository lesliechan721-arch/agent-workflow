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

function yamlString(value) {
  return JSON.stringify(String(value));
}

function buildPluginManifest(pluginName, version, description, displayName, shortDescription, opts) {
  const manifest = {
    name: pluginName,
    version,
    description,
  };

  if (!opts.noSkills) {
    manifest.skills = './skills';
  }

  if (opts.withMcp) {
    manifest.mcpServers = './.mcp.json';
  }
  if (opts.withApps) {
    manifest.apps = './.app.json';
  }

  manifest.marketplace = {
    category: 'workflow',
    strict: true,
    policy: {
      installation: 'AVAILABLE',
      authentication: 'NONE',
    },
  };

  const capabilities = [];
  if (!opts.noSkills) capabilities.push('Skills');
  if (opts.withMcp) capabilities.push('MCP Servers');
  if (opts.withApps) capabilities.push('Apps');

  manifest.interface = {
    displayName,
    shortDescription,
    ...(capabilities.length > 0 ? { capabilities } : {}),
  };

  manifest.extensions = {
    instructions: [],
    permissions: [],
    hooks: [],
    agents: [],
  };

  if (opts.withConfigApi) {
    manifest.config = {
      schema: {
        apiKey: {
          type: 'string',
          required: true,
          sensitive: true,
        },
        mode: {
          type: 'enum',
          values: ['standard', 'strict'],
          default: 'standard',
        },
      },
    };
  }

  if (opts.withConfigApi || opts.withLifecycle) {
    manifest.scripts = {
      ...(opts.withLifecycle
        ? {
            lifecycle: {
              install: './scripts/lifecycle.mjs',
              upgrade: './scripts/lifecycle.mjs',
              uninstall: './scripts/lifecycle.mjs',
            },
          }
        : {}),
      ...(opts.withConfigApi
        ? {
            helpers: {
              config: './scripts/aw-config.mjs',
            },
          }
        : {}),
      tests: {
        node: ['./scripts/**/*.test.mjs'],
      },
    };
  }

  return manifest;
}

function renderSkillMd(skillName, skillDescription, shortDescription) {
  const skillTitle = titleCaseSlug(skillName);
  return `---
name: ${skillName}
description: ${yamlString(skillDescription)}
user-invocable: true
disable-model-invocation: true
metadata:
  short-description: ${yamlString(shortDescription)}
---

# ${skillTitle}

这个 skill 用于 [TODO: 写清楚这个插件实际要完成的工作流]。

建议按这个顺序处理：

1. [TODO: 第一步]
2. [TODO: 第二步]
3. [TODO: 第三步]

边界：

- [TODO: 不要扩大修改范围]
- [TODO: 遇到高风险操作时先停下来说明]
`;
}

function renderOpenAiYaml(displayName, shortDescription, skillName) {
  const defaultPrompt = `Use $${skillName} to ${shortDescription.toLowerCase().replace(/[。.]$/, '')}.`;
  return `interface:
  display_name: ${yamlString(displayName)}
  short_description: ${yamlString(shortDescription)}
  default_prompt: ${yamlString(defaultPrompt)}
policy:
  allow_implicit_invocation: false
`;
}

function renderMcpJson() {
  return `{
  "mcpServers": {}
}
`;
}

function renderAppJson() {
  return `{
  "apps": {
    "example": {
      "id": "replace-with-real-connector-id"
    }
  }
}
`;
}

function renderLifecycleMjs() {
  return `import { readFile } from 'node:fs/promises';

async function readAwContext() {
  const contextPath = process.env.AW_PLUGIN_CONTEXT;
  if (!contextPath) {
    throw new Error('AW_PLUGIN_CONTEXT is required for lifecycle scripts.');
  }
  return JSON.parse(await readFile(contextPath, 'utf8'));
}

const context = await readAwContext();
const event = context.event ?? 'unknown';
const pluginName = context.plugin?.name ?? context.pluginName ?? 'plugin';

console.log(\`[\${pluginName}] lifecycle \${event} completed.\`);
`;
}

function renderGeneratedScriptTest(pluginName, opts) {
  const configTest = opts.withConfigApi
    ? `
test('aw config helper reads AW_PLUGIN_CONTEXT without fallback discovery', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), '${pluginName}-config-'));
  const contextPath = join(tempDir, 'context.json');
  await writeFile(contextPath, JSON.stringify({
    plugin: { name: '${pluginName}' },
    config: {
      values: { apiKey: 'test-key', mode: 'strict' },
      sources: { apiKey: 'user', mode: 'projectShared' },
      schema: {
        apiKey: { type: 'string', sensitive: true, required: true },
        mode: { type: 'enum', values: ['standard', 'strict'], default: 'standard' }
      }
    },
    paths: {
      configStores: {
        user: join(tempDir, 'missing-user.json'),
        project: join(tempDir, 'missing-project.json'),
        projectLocal: join(tempDir, 'missing-project-local.json')
      }
    }
  }), 'utf8');

  const helperPath = join(dirname(fileURLToPath(import.meta.url)), 'aw-config.mjs');
  const { stdout } = await execFileAsync(process.execPath, [helperPath, 'get', 'apiKey'], {
    cwd: tempDir,
    env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath, AW_HOME: join(tempDir, 'unused-aw-home') }
  });
  assert.equal(stdout.trim(), 'test-key');
});
`
    : '';
  const lifecycleTest = opts.withLifecycle
    ? `
test('lifecycle script accepts AW_PLUGIN_CONTEXT', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), '${pluginName}-lifecycle-'));
  const contextPath = join(tempDir, 'context.json');
  await writeFile(contextPath, JSON.stringify({
    event: 'install',
    plugin: { name: '${pluginName}' },
    config: { values: {}, sources: {}, schema: {} },
    paths: { configStores: {} }
  }), 'utf8');

  const lifecyclePath = join(dirname(fileURLToPath(import.meta.url)), 'lifecycle.mjs');
  const { stdout } = await execFileAsync(process.execPath, [lifecyclePath], {
    cwd: tempDir,
    env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath }
  });
  assert.match(stdout, /lifecycle install completed/);
});
`
    : '';

  return `import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
${configTest}${lifecycleTest}`;
}

function printUsage() {
  console.log(`Usage:
  node .agents/skills/create-agent-workflows-plugin/scripts/init_plugin.js <plugin_name> --description "..."

Options:
  --description <text>          Plugin description. Required.
  --display-name <text>         Human-facing plugin display name.
  --short-description <text>    Short UI description.
  --skill-name <name>           Initial skill directory name.
  --skill-description <text>    Initial skill description and UI summary.
  --version <semver>            Plugin version. Default: 0.1.0
  --repo-root <path>            Repository root. Default: current directory.
  --no-skills                   Create plugin without skills directory.
  --with-mcp                    Create .mcp.json stub and add mcpServers to manifest.
  --with-apps                   Create minimal .app.json with an example connector id and add apps to manifest.
  --with-config-api             Add AW config schema, standard config helper, and Node script test.
  --with-lifecycle              Add Node lifecycle script sample and Node script test.
  -h, --help                    Show this help message.

Note:
  New skill scaffolds do not generate skillTriggers by default. This keeps install-time
  trigger overrides disabled until the plugin author explicitly opts in from plugin.json.
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
    withMcp: false,
    withApps: false,
    withConfigApi: false,
    withLifecycle: false,
    noSkills: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--with-mcp') {
      options.withMcp = true;
      continue;
    }
    if (arg === '--with-apps') {
      options.withApps = true;
      continue;
    }
    if (arg === '--with-config-api') {
      options.withConfigApi = true;
      continue;
    }
    if (arg === '--with-lifecycle') {
      options.withLifecycle = true;
      continue;
    }
    if (arg === '--no-skills') {
      options.noSkills = true;
      continue;
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
  const displayName = args.displayName || titleCaseSlug(pluginName);
  const shortDescription = args.shortDescription || args.description;
  const repoRoot = path.resolve(args.repoRoot);

  const pluginsRoot = path.join(repoRoot, 'plugins');
  const marketplaceSourcePath = path.join(pluginsRoot, 'marketplace-source.json');
  const pluginRoot = path.join(pluginsRoot, pluginName);

  if (!fs.existsSync(pluginsRoot)) {
    fail(`plugins directory not found: ${pluginsRoot}`);
  }
  if (!fs.existsSync(marketplaceSourcePath)) {
    fail(`marketplace metadata file not found: ${marketplaceSourcePath}`);
  }
  if (fs.existsSync(pluginRoot)) {
    fail(`plugin already exists: ${pluginRoot}`);
  }

  const pluginManifest = buildPluginManifest(
    pluginName,
    args.version,
    args.description,
    displayName,
    shortDescription,
    {
      withMcp: args.withMcp,
      withApps: args.withApps,
      withConfigApi: args.withConfigApi,
      withLifecycle: args.withLifecycle,
      noSkills: args.noSkills,
    },
  );

  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const createdPaths = [manifestPath];

  writeJson(manifestPath, pluginManifest);

  if (!args.noSkills) {
    const skillName = requireHyphenName(args.skillName || pluginName, 'skill_name');
    const skillDescription = args.skillDescription || args.description;
    const skillDisplayName = titleCaseSlug(skillName);
    const skillShortDescription = args.skillDescription || shortDescription;
    const skillMdPath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
    const openaiYamlPath = path.join(pluginRoot, 'skills', skillName, 'agents', 'openai.yaml');

    writeText(skillMdPath, renderSkillMd(skillName, skillDescription, skillShortDescription));
    writeText(openaiYamlPath, renderOpenAiYaml(skillDisplayName, skillShortDescription, skillName));
    createdPaths.push(skillMdPath, openaiYamlPath);
  }

  if (args.withMcp) {
    const mcpPath = path.join(pluginRoot, '.mcp.json');
    writeText(mcpPath, renderMcpJson());
    createdPaths.push(mcpPath);
  }
  if (args.withApps) {
    const appPath = path.join(pluginRoot, '.app.json');
    writeText(appPath, renderAppJson());
    createdPaths.push(appPath);
  }
  if (args.withConfigApi) {
    const helperTemplatePath = path.join(__dirname, '..', 'assets', 'aw-config.mjs');
    const helperPath = path.join(pluginRoot, 'scripts', 'aw-config.mjs');
    writeText(helperPath, fs.readFileSync(helperTemplatePath, 'utf8'));
    createdPaths.push(helperPath);
  }
  if (args.withLifecycle) {
    const lifecyclePath = path.join(pluginRoot, 'scripts', 'lifecycle.mjs');
    writeText(lifecyclePath, renderLifecycleMjs());
    createdPaths.push(lifecyclePath);
  }
  if (args.withConfigApi || args.withLifecycle) {
    const testPath = path.join(pluginRoot, 'scripts', 'generated-script.test.mjs');
    writeText(testPath, renderGeneratedScriptTest(pluginName, {
      withConfigApi: args.withConfigApi,
      withLifecycle: args.withLifecycle,
    }));
    createdPaths.push(testPath);
  }

  console.log('[OK] Created plugin scaffold:');
  for (const createdPath of createdPaths) {
    console.log(`  - ${createdPath}`);
  }
  console.log(`[OK] Left marketplace metadata unchanged: ${marketplaceSourcePath}`);
  console.log('[OK] Runtime marketplace and platform manifests will be generated by `pnpm build`.');
}

main();
