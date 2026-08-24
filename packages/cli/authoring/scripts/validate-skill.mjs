#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const cliPackageRoot = path.resolve(scriptRoot, '..', '..', '..');
const FRONTMATTER_PROFILES = new Set([
  'portable-agent-skills',
  'claude-2.1.88',
  'claude-current',
]);
const CODEX_METADATA_POLICIES = new Set(['required', 'optional', 'ignore']);

function usage() {
  return `Usage:
  aw skill validate <skill-directory> [options]

Options:
  --frontmatter-profile <profile>
                               portable-agent-skills (default), claude-2.1.88, or claude-current.
  --codex-metadata <policy>    required, optional (default), or ignore.
  --json                       Emit one machine-readable JSON result to stdout.
  -h, --help                   Show this help message.

Exit codes:
  0  Validation passed.
  1  Validation found contract errors.
  2  Invocation or internal error.
`;
}

function parseArgs(argv) {
  const options = {
    skillDirectory: null,
    frontmatterProfile: 'portable-agent-skills',
    codexMetadata: 'optional',
    json: argv.includes('--json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '-h' || value === '--help') return { help: true };
    if (value === '--json') continue;
    if (value === '--frontmatter-profile') {
      options.frontmatterProfile = argv[++index];
      if (!FRONTMATTER_PROFILES.has(options.frontmatterProfile)) {
        throw new Error('--frontmatter-profile must be portable-agent-skills, claude-2.1.88, or claude-current.');
      }
      continue;
    }
    if (value === '--codex-metadata') {
      options.codexMetadata = argv[++index];
      if (!CODEX_METADATA_POLICIES.has(options.codexMetadata)) {
        throw new Error('--codex-metadata must be required, optional, or ignore.');
      }
      continue;
    }
    if (!value.startsWith('-') && options.skillDirectory === null) {
      options.skillDirectory = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (options.skillDirectory === null) throw new Error('skill-directory is required.');
  return options;
}

function renderText(result) {
  const lines = [
    `Skill: ${result.skillDirectory}`,
    `Validation: ${result.ok ? 'pass' : 'fail'}`,
    `Frontmatter profile: ${result.frontmatterProfile}`,
    `Codex metadata: ${result.codexMetadata}`,
  ];
  for (const warning of result.warnings) {
    lines.push(`[warning] ${warning.code}: ${warning.path}: ${warning.message}`);
  }
  for (const error of result.errors) {
    lines.push(`[error] ${error.code}: ${error.path}: ${error.message}`);
  }
  return `${lines.join('\n')}\n`;
}

function invocationFailure(message, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      command: 'skill:validate',
      ok: false,
      skillDirectory: null,
      frontmatterProfile: null,
      codexMetadata: null,
      warnings: [],
      errors: [{ code: 'invocation-error', path: 'argv', message }],
    }, null, 2)}\n`);
  } else {
    process.stderr.write(`[ERROR] ${message}\nRun with --help for usage.\n`);
  }
  process.exitCode = 2;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    invocationFailure(error instanceof Error ? error.message : String(error), process.argv.includes('--json'));
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  try {
    const modulePath = path.join(cliPackageRoot, 'dist', 'src', 'utils', 'skill-validation.js');
    const { validateSkillDirectory } = await import(pathToFileURL(modulePath).href);
    const result = await validateSkillDirectory(options);
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    invocationFailure(error instanceof Error ? error.message : String(error), options.json);
  }
}

main();
