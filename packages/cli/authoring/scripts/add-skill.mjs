#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';

import { parseStrictSemVer } from './lib/semver.mjs';
import {
  MAX_CODEX_SHORT_DESCRIPTION_LEN,
  MIN_CODEX_SHORT_DESCRIPTION_LEN,
  SKILL_INVOCATION_MODES,
  renderBehaviorCases,
  renderEvalManifest,
  renderOpenAiYaml,
  renderSkillMd,
  renderSkillReadme,
  renderTriggerCases,
  titleCaseSlug,
} from './lib/skill-scaffold.mjs';
import { resolveAuthoringPluginRoot } from './lib/plugin-root.mjs';

const HYPHEN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message) {
  throw new Error(message);
}

function requireHyphenName(value, fieldName) {
  if (!HYPHEN_NAME_PATTERN.test(String(value))) {
    fail(`${fieldName} must use lowercase hyphen-case, got ${JSON.stringify(value)}.`);
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

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, content) {
  writeText(filePath, `${JSON.stringify(content, null, 2)}\n`);
}

function readOptionValue(args, index, flag) {
  const current = args[index];
  const eqIndex = current.indexOf('=');
  if (eqIndex >= 0) {
    return { value: current.slice(eqIndex + 1), nextIndex: index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value.`);
  return { value, nextIndex: index + 1 };
}

function printUsage() {
  console.log(`Usage:
  aw plugin add-skill <plugin-name> \\
    --skill-name <name> --skill-description <text> [options]

Options:
  --skill-name <name>           New static Skill name. Required.
  --skill-description <text>    Skill goal and discovery description. Required.
  --skill-short-description <text>
                                Skill UI summary (25-64 characters). Default: description.
  --skill-invocation <mode>     model | manual | claude-model-only. Default: model.
  --workspace-root <path>            Workspace root. Default: current directory.
  --plugin-root <path>          Plugin root, relative to --workspace-root by default.
  -h, --help                    Show this help message.

The command only adds one static Skill. It does not edit the plugin README.
During development, keep the current stable target when production content changes.
In this repository, run pnpm release -- beta|release --catalog|--all --plugin <name>=patch.
The bump can also be major or minor. Other workspaces use their release workflow to set the target.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    repoRoot: '.',
    skillInvocation: 'model',
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

    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const { value, nextIndex } = readOptionValue(args, index, flag);
    index = nextIndex;
    switch (flag) {
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
      case '--workspace-root':
        options.repoRoot = value;
        break;
      case '--plugin-root':
        options.pluginRoot = value;
        break;
      default:
        fail(`Unknown option: ${flag}`);
    }
  }

  if (!options.pluginName) fail('plugin-name is required.');
  if (!options.skillName) fail('--skill-name is required.');
  if (!options.skillDescription) fail('--skill-description is required.');
  return options;
}

function resolveSupportedPlatforms(manifest) {
  const products = manifest.marketplace?.policy?.products;
  if (products === undefined || (Array.isArray(products) && products.length === 0)) {
    return { codex: true, claude: true };
  }
  if (!Array.isArray(products)) {
    fail('marketplace.policy.products must be an array when present.');
  }
  const normalized = new Set(products.map((value) => String(value).trim().toUpperCase()));
  for (const product of normalized) {
    if (product !== 'CODEX' && product !== 'CLAUDE') {
      fail(`Unsupported marketplace.policy.products entry: ${JSON.stringify(product)}.`);
    }
  }
  return { codex: normalized.has('CODEX'), claude: normalized.has('CLAUDE') };
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function requireDirectory(filePath, label) {
  const stat = lstatOrNull(filePath);
  if (!stat) fail(`${label} not found: ${filePath}`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be a non-symbolic-link directory: ${filePath}`);
  }
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function requireRegularFile(filePath, label) {
  const stat = lstatOrNull(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular non-symbolic-link file: ${filePath}`);
  }
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function requireSameIdentity(filePath, expected, label, type) {
  const actual = type === 'file'
    ? requireRegularFile(filePath, label)
    : requireDirectory(filePath, label);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    fail(`${label} changed during add-skill: ${filePath}`);
  }
}

function requireAbsent(filePath, label) {
  if (lstatOrNull(filePath)) fail(`${label} already exists: ${filePath}`);
}

function atomicReplaceRegularFile(filePath, content, expectedIdentity) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.plugin.json.aw-tmp-${process.pid}-${crypto.randomBytes(12).toString('hex')}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'wx', expectedIdentity.mode & 0o777);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fchmodSync(descriptor, expectedIdentity.mode & 0o777);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    requireSameIdentity(filePath, expectedIdentity, 'Plugin manifest', 'file');
    fs.renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (lstatOrNull(tempPath)) fs.unlinkSync(tempPath);
  }
}

function assertSkillNameAvailable(pluginRoot, manifest, skillName) {
  const skillRoot = path.join(pluginRoot, 'skills', skillName);
  requireAbsent(skillRoot, 'Skill');

  const dynamicConflict = manifest.artifacts?.targets?.find(
    (target) => target && typeof target === 'object' && target.skillKey === skillName,
  );
  if (dynamicConflict) {
    fail(`Skill name ${JSON.stringify(skillName)} conflicts with dynamic artifact ${JSON.stringify(dynamicConflict.id)}.`);
  }

  if (typeof manifest.slashCommands === 'string') {
    const commandPath = path.join(
      pluginRoot,
      manifest.slashCommands.replace(/^\.\//, ''),
      `${skillName}.md`,
    );
    if (lstatOrNull(commandPath)) {
      fail(`Skill name ${JSON.stringify(skillName)} conflicts with slash command ${commandPath}.`);
    }
  }
}

function addSkillsCapability(manifest) {
  if (manifest.skills !== undefined && manifest.skills !== './skills') {
    fail(`Existing manifest.skills must be "./skills" before add-skill, got ${JSON.stringify(manifest.skills)}.`);
  }
  manifest.skills = './skills';
  const capabilities = manifest.interface?.capabilities;
  if (capabilities === undefined) return;
  if (!Array.isArray(capabilities)) fail('interface.capabilities must be an array when present.');
  if (!capabilities.includes('Skills')) capabilities.push('Skills');
}

function createSkillFiles(stageSkillRoot, options) {
  const {
    pluginName,
    skillName,
    skillDescription,
    skillShortDescription,
    skillInvocation,
    supportsCodex,
    supportsClaude,
  } = options;
  const created = [];
  const addText = (relativePath, content) => {
    writeText(path.join(stageSkillRoot, relativePath), content);
    created.push(relativePath);
  };
  const addJson = (relativePath, content) => {
    writeJson(path.join(stageSkillRoot, relativePath), content);
    created.push(relativePath);
  };

  addText('SKILL.md', renderSkillMd(
    skillName,
    skillDescription,
    skillShortDescription,
    skillInvocation,
    { supportsClaude },
  ));
  addText('README.md', renderSkillReadme(
    skillName,
    skillDescription,
    { invocation: skillInvocation },
  ));

  if (supportsCodex) {
    addText(
      path.join('agents', 'openai.yaml'),
      renderOpenAiYaml(
        titleCaseSlug(skillName),
        skillShortDescription,
        skillName,
        skillInvocation,
      ),
    );
    addJson(path.join('evals', 'manifest.json'), renderEvalManifest(pluginName, skillName));
    addJson(
      path.join('evals', 'trigger-cases.json'),
      renderTriggerCases(skillName, skillDescription, skillInvocation),
    );
    addJson(path.join('evals', 'evals.json'), renderBehaviorCases(skillName, skillDescription));
  }
  return created;
}

function main() {
  const args = parseArgs(process.argv);
  const pluginName = requireHyphenName(args.pluginName, 'plugin-name');
  const skillName = requireHyphenName(args.skillName, '--skill-name');
  const skillShortDescription = requireCharacterRange(
    args.skillShortDescription ?? args.skillDescription,
    '--skill-short-description',
    MIN_CODEX_SHORT_DESCRIPTION_LEN,
    MAX_CODEX_SHORT_DESCRIPTION_LEN,
  );
  const { pluginRoot } = resolveAuthoringPluginRoot({
    repoRoot: args.repoRoot,
    pluginRoot: args.pluginRoot,
    pluginName,
  });
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const pluginRootIdentity = requireDirectory(pluginRoot, 'Plugin root');
  const manifestDirectory = path.dirname(manifestPath);
  const manifestDirectoryIdentity = requireDirectory(manifestDirectory, 'Plugin manifest directory');
  const manifestIdentity = requireRegularFile(manifestPath, 'Plugin manifest');

  const originalManifestText = fs.readFileSync(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(originalManifestText);
  } catch (error) {
    fail(`Invalid plugin manifest JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('Plugin manifest must be a JSON object.');
  }
  if (manifest.name !== pluginName) {
    fail(`Plugin manifest name ${JSON.stringify(manifest.name)} does not match directory ${JSON.stringify(pluginName)}.`);
  }
  const parsedVersion = parseStrictSemVer(manifest.version, 'plugin version');
  if (parsedVersion.prerelease.length > 0 || parsedVersion.build.length > 0) {
    fail('plugin version must be a stable SemVer without prerelease or build metadata.');
  }
  const platforms = resolveSupportedPlatforms(manifest);
  if (!platforms.codex && !platforms.claude) {
    fail('Plugin must support at least one of CODEX or CLAUDE.');
  }
  if (args.skillInvocation === 'claude-model-only' && !platforms.claude) {
    fail('claude-model-only invocation requires a plugin that supports CLAUDE.');
  }
  assertSkillNameAvailable(pluginRoot, manifest, skillName);

  const nextManifest = structuredClone(manifest);
  addSkillsCapability(nextManifest);

  const skillsRoot = path.join(pluginRoot, 'skills');
  const finalSkillRoot = path.join(skillsRoot, skillName);
  const existingSkillsStat = lstatOrNull(skillsRoot);
  const existingSkillsIdentity = existingSkillsStat
    ? requireDirectory(skillsRoot, 'Skills root')
    : null;
  requireAbsent(finalSkillRoot, 'Skill');
  const stageRoot = fs.mkdtempSync(path.join(pluginRoot, '.aw-add-skill-'));
  const stageSkillRoot = path.join(stageRoot, skillName);
  const skillsRootExisted = existingSkillsIdentity !== null;
  let installedSkill = false;
  try {
    const created = createSkillFiles(stageSkillRoot, {
      pluginName,
      skillName,
      skillDescription: args.skillDescription,
      skillShortDescription,
      skillInvocation: args.skillInvocation,
      supportsCodex: platforms.codex,
      supportsClaude: platforms.claude,
    });
    if (!skillsRootExisted) fs.mkdirSync(skillsRoot);
    const skillsRootIdentity = skillsRootExisted
      ? existingSkillsIdentity
      : requireDirectory(skillsRoot, 'Skills root');
    requireSameIdentity(pluginRoot, pluginRootIdentity, 'Plugin root', 'directory');
    requireSameIdentity(
      manifestDirectory,
      manifestDirectoryIdentity,
      'Plugin manifest directory',
      'directory',
    );
    requireSameIdentity(manifestPath, manifestIdentity, 'Plugin manifest', 'file');
    requireSameIdentity(skillsRoot, skillsRootIdentity, 'Skills root', 'directory');
    requireAbsent(finalSkillRoot, 'Skill');
    fs.renameSync(stageSkillRoot, finalSkillRoot);
    installedSkill = true;
    atomicReplaceRegularFile(
      manifestPath,
      `${JSON.stringify(nextManifest, null, 2)}\n`,
      manifestIdentity,
    );

    console.log(`[OK] Added static Skill ${JSON.stringify(skillName)} to plugin ${JSON.stringify(pluginName)}.`);
    for (const relativePath of created) {
      console.log(`  - ${path.join(finalSkillRoot, relativePath)}`);
    }
    if (!platforms.codex) {
      console.log('[WARN] Claude-only plugin: Codex metadata and v2 model eval starter were not generated.');
    }
    if (args.skillInvocation === 'claude-model-only' && platforms.codex) {
      console.log('[WARN] Codex has no hidden-user-entry equivalent; Codex remains model-invocable and explicitly invocable.');
    }
    console.log('[OK] Keep the current stable target during development.');
    console.log(`[OK] In this repository, run \`pnpm release -- beta|release --catalog|--all --plugin ${pluginName}=patch\`; the bump can also be major or minor.`);
    console.log(`[WARN] Plugin README was not changed: ${path.join(pluginRoot, 'README.md')}`);
  } catch (error) {
    if (installedSkill && lstatOrNull(finalSkillRoot)) {
      fs.rmSync(finalSkillRoot, { recursive: true, force: true });
    }
    if (!skillsRootExisted && lstatOrNull(skillsRoot) && fs.readdirSync(skillsRoot).length === 0) {
      fs.rmdirSync(skillsRoot);
    }
    throw error;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
}
