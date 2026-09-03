#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseStrictSemVer as parseSemVer,
} from './lib/semver.mjs';
import {
  MAX_CODEX_SHORT_DESCRIPTION_LEN,
  MIN_CODEX_SHORT_DESCRIPTION_LEN,
  SKILL_INVOCATION_MODES,
  renderBehaviorCases,
  renderEvalManifest,
  renderOpenAiYaml,
  renderPluginReadme,
  renderSkillMd,
  renderSkillReadme,
  renderTriggerCases,
  titleCaseSlug,
} from './lib/skill-scaffold.mjs';
import { resolveAuthoringPluginRoot } from './lib/plugin-root.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function requireCharacterRange(value, fieldName, minLength, maxLength) {
  const count = Array.from(String(value).trim()).length;
  if (count < minLength || count > maxLength) {
    fail(`${fieldName} must be ${minLength}-${maxLength} characters, got ${count}.`);
  }
  return value;
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

function parseStrictSemVer(value, fieldName) {
  try {
    return parseSemVer(value, fieldName);
  } catch (error) {
    fail(error.message);
  }
}

function buildPluginManifest(pluginName, version, description, displayName, shortDescription, opts) {
  const manifest = {
    schemaVersion: 3,
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
      authentication: 'ON_INSTALL',
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
      fields: {
        apiKey: {
          type: 'string',
          required: true,
          sensitive: true,
        },
        mode: {
          type: 'string',
          choices: {
            allowCustom: false,
            presets: [
              { id: 'standard', title: 'Standard', value: 'standard', recommended: true },
              { id: 'strict', title: 'Strict', value: 'strict' },
            ],
          },
          default: 'standard',
        },
      },
    };
  }

  if (opts.withConfigApi || opts.withPostApply) {
    manifest.scripts = {
      ...(opts.withPostApply
        ? {
            postApply: { path: './scripts/postApply.mjs' },
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

function renderPostApplyMjs() {
  return `let input = '';
for await (const chunk of process.stdin) input += chunk;
const context = JSON.parse(input);
const pluginName = context.plugin?.name ?? context.pluginName ?? 'plugin';
console.log(\`[\${pluginName}] postApply completed.\`);
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
      sources: { apiKey: 'user', mode: 'project' },
      schema: {
        apiKey: { type: 'string', sensitive: true, required: true },
        mode: {
          type: 'string',
          choices: {
            allowCustom: false,
            presets: [
              { id: 'standard', title: 'Standard', value: 'standard', recommended: true },
              { id: 'strict', title: 'Strict', value: 'strict' }
            ]
          },
          default: 'standard'
        }
      }
    },
    paths: {
      configStores: {
        user: join(tempDir, 'missing-user.json'),
        project: join(tempDir, 'missing-project.json')
      }
    }
  }), 'utf8');

  const helperPath = join(dirname(fileURLToPath(import.meta.url)), 'aw-config.mjs');
  const { stdout } = await execFileAsync(process.execPath, [helperPath, 'get', 'apiKey'], {
    cwd: tempDir,
    env: { ...process.env, AW_PLUGIN_CONTEXT: contextPath, AW_HOME: join(tempDir, 'unused-aw-home') }
  });
  assert.equal(stdout.trim(), '[redacted]');
});
`
    : '';
  const postApplyTest = opts.withPostApply
    ? `
test('postApply script accepts JSON context from stdin', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), '${pluginName}-postApply-'));
  const contextPath = join(tempDir, 'context.json');
  await writeFile(contextPath, JSON.stringify({
    schemaVersion: 1,
    plugin: { pluginId: 'official/${pluginName}', name: '${pluginName}', version: '0.1.0', rootDir: tempDir },
    target: { platform: 'codex', scope: 'project', projectRoot: tempDir },
    config: { values: {} },
    components: []
  }), 'utf8');

  const postApplyPath = join(dirname(fileURLToPath(import.meta.url)), 'postApply.mjs');
  const postApply = spawnSync(process.execPath, [postApplyPath], {
    cwd: tempDir,
    input: await readFile(contextPath, 'utf8'),
    encoding: 'utf8',
  });
  assert.equal(postApply.status, 0, postApply.stderr);
  assert.match(postApply.stdout, /postApply completed/);
});
`
    : '';

  return `import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
${configTest}${postApplyTest}`;
}

function printUsage() {
  console.log(`Usage:
  aw plugin init <plugin-name> --description "..."

Options:
  --description <text>          Plugin description. Required.
  --display-name <text>         Human-facing plugin display name.
  --short-description <text>    Short UI description.
  --skill-name <name>           Initial skill directory name.
  --skill-description <text>    What the initial skill does and when to use it.
  --skill-short-description <text>
                                Initial skill UI summary (25-64 characters). Default: --skill-description.
  --skill-invocation <mode>     model | manual | claude-model-only. Default: model.
  --version <semver>            Plugin version. Default: 0.1.0
  --workspace-root <path>            Workspace root. Default: current directory.
  --no-skills                   Create plugin without skills directory.
  --with-mcp                    Create .mcp.json stub and add mcpServers to manifest.
  --with-apps                   Create minimal .app.json with an example connector id and add apps to manifest.
  --with-config-api             Add AW config schema, standard config helper, and Node script test.
  --with-post-apply              Add Node postApply script sample and Node script test.
  -h, --help                    Show this help message.

Note:
  During development, keep the current stable target when production content changes.
  Next, run aw plugin validate, aw plugin test, aw plugin build, and aw catalog build.
  Publish only as an explicit later step; inspect aw catalog publish plan --help first.
  New skill scaffolds default to model invocation and generate an eval starter.
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
    withPostApply: false,
    noSkills: false,
    skillInvocation: 'model',
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
    if (arg === '--with-post-apply') {
      options.withPostApply = true;
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
      case '--skill-short-description':
        options.skillShortDescription = value;
        break;
      case '--skill-invocation':
        if (!SKILL_INVOCATION_MODES.has(value)) {
          fail('--skill-invocation must be one of "model", "manual", or "claude-model-only".');
        }
        options.skillInvocation = value;
        break;
      case '--version':
        options.version = value;
        break;
      case '--workspace-root':
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
  if (!options.noSkills && !options.skillDescription) {
    fail('--skill-description is required unless --no-skills is used.');
  }

  return options;
}

function main() {
  const args = parseArgs(process.argv);

  const pluginName = requireHyphenName(args.pluginName, 'plugin_name');
  const parsedVersion = parseStrictSemVer(args.version, '--version');
  if (parsedVersion.prerelease.length > 0 || parsedVersion.build.length > 0) {
    fail('--version must be a stable SemVer without prerelease or build metadata.');
  }
  const version = parsedVersion.raw;
  const displayName = args.displayName || titleCaseSlug(pluginName);
  const shortDescription = args.shortDescription || args.description;
  const initialSkillName = args.noSkills
    ? undefined
    : requireHyphenName(args.skillName || pluginName, 'skill_name');
  const initialSkillShortDescription = args.noSkills
    ? undefined
    : requireCharacterRange(
      args.skillShortDescription || args.skillDescription,
      '--skill-short-description',
      MIN_CODEX_SHORT_DESCRIPTION_LEN,
      MAX_CODEX_SHORT_DESCRIPTION_LEN,
    );
  const resolvedRoot = resolveAuthoringPluginRoot({
    repoRoot: args.repoRoot,
    pluginName,
  });
  const { repoRoot, pluginRoot } = resolvedRoot;
  const pluginsRoot = path.join(repoRoot, 'plugins');
  const marketplaceSourcePath = path.join(pluginsRoot, 'marketplace-source.json');

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
    version,
    args.description,
    displayName,
    shortDescription,
    {
      withMcp: args.withMcp,
      withApps: args.withApps,
      withConfigApi: args.withConfigApi,
      withPostApply: args.withPostApply,
      noSkills: args.noSkills,
      initialSkillName,
    },
  );

  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const pluginReadmePath = path.join(pluginRoot, 'README.md');
  const createdPaths = [manifestPath, pluginReadmePath];

  writeJson(manifestPath, pluginManifest);
  writeText(
    pluginReadmePath,
    renderPluginReadme(pluginName, args.description, initialSkillName, {
      withMcp: args.withMcp,
      withApps: args.withApps,
      withConfigApi: args.withConfigApi,
    }),
  );

  if (!args.noSkills) {
    const skillName = initialSkillName;
    const skillDescription = args.skillDescription;
    const skillDisplayName = titleCaseSlug(skillName);
    const skillShortDescription = initialSkillShortDescription;
    const skillMdPath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
    const skillReadmePath = path.join(pluginRoot, 'skills', skillName, 'README.md');
    const openaiYamlPath = path.join(pluginRoot, 'skills', skillName, 'agents', 'openai.yaml');

    const evalManifestPath = path.join(pluginRoot, 'skills', skillName, 'evals', 'manifest.json');
    const triggerCasesPath = path.join(pluginRoot, 'skills', skillName, 'evals', 'trigger-cases.json');
    const behaviorCasesPath = path.join(
      pluginRoot,
      'skills',
      skillName,
      'evals',
      'behavior-cases.json',
    );

    writeText(
      skillMdPath,
      renderSkillMd(skillName, skillDescription, skillShortDescription, args.skillInvocation),
    );
    writeText(skillReadmePath, renderSkillReadme(skillName, skillDescription, {
      invocation: args.skillInvocation,
    }));
    writeText(
      openaiYamlPath,
      renderOpenAiYaml(
        skillDisplayName,
        skillShortDescription,
        skillName,
        args.skillInvocation,
      ),
    );
    writeJson(evalManifestPath, renderEvalManifest(pluginName));
    writeJson(
      triggerCasesPath,
      renderTriggerCases(skillName, skillDescription, args.skillInvocation),
    );
    writeJson(behaviorCasesPath, renderBehaviorCases(skillName, skillDescription));
    createdPaths.push(
      skillMdPath,
      skillReadmePath,
      openaiYamlPath,
      evalManifestPath,
      triggerCasesPath,
      behaviorCasesPath,
    );
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
  if (args.withPostApply) {
    const postApplyPath = path.join(pluginRoot, 'scripts', 'postApply.mjs');
    writeText(postApplyPath, renderPostApplyMjs());
    createdPaths.push(postApplyPath);
  }
  if (args.withConfigApi || args.withPostApply) {
    const testPath = path.join(pluginRoot, 'scripts', 'generated-script.test.mjs');
    writeText(testPath, renderGeneratedScriptTest(pluginName, {
      withConfigApi: args.withConfigApi,
      withPostApply: args.withPostApply,
    }));
    createdPaths.push(testPath);
  }

  console.log('[OK] Created plugin scaffold:');
  for (const createdPath of createdPaths) {
    console.log(`  - ${createdPath}`);
  }
  if (!resolvedRoot.explicit) {
    console.log(`[OK] Left marketplace metadata unchanged: ${marketplaceSourcePath}`);
  }
  if (args.skillInvocation === 'claude-model-only') {
    console.log('[WARN] Codex has no hidden-user-entry equivalent; Codex remains model-invocable and explicitly invocable.');
  }
  const printablePluginRoot = JSON.stringify(pluginRoot);
  const printableRepoRoot = JSON.stringify(repoRoot);
  console.log('[OK] Keep the current stable target during development.');
  console.log(`[NEXT] aw plugin validate ${printablePluginRoot} --workspace-root ${printableRepoRoot}`);
  console.log(`[NEXT] aw plugin test ${printablePluginRoot} --workspace-root ${printableRepoRoot}`);
  console.log(`[NEXT] aw plugin build ${printablePluginRoot} --workspace-root ${printableRepoRoot}`);
  console.log(`[NEXT] aw catalog build --workspace-root ${printableRepoRoot}`);
  console.log(`[LATER] Publish only when explicitly requested: aw catalog publish plan --workspace-root ${printableRepoRoot}`);
}

main();
