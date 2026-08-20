#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requiredImport(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required build import: ${name}`);
  return value;
}

async function readJsonImport(name) {
  return JSON.parse(await readFile(requiredImport(name), 'utf8'));
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderFrontmatterReference(registry) {
  const lines = [
    '# Skill Frontmatter Capability Reference',
    '',
    '<!-- Generated from the AW CLI Skill frontmatter capability registry. Do not edit by hand. -->',
    '',
    `Registry schema: ${registry.schemaVersion}. Verified: ${registry.verifiedOn}.`,
    '',
    `Required semantics: ${registry.requiredSemantics}.`,
    '',
    '## Profiles',
    '',
    '| Profile | Platform | Target version | Description |',
    '| --- | --- | --- | --- |',
  ];
  for (const [name, profile] of Object.entries(registry.profiles)) {
    lines.push(
      `| \`${markdownCell(name)}\` | ${markdownCell(profile.platform)} | ${markdownCell(profile.targetVersion ?? 'n/a')} | ${markdownCell(profile.description)} |`,
    );
  }
  lines.push(
    '',
    '## Fields',
    '',
    '| Field | Owner | Required | Type | Profiles | Accepted values | Value matching | Version evidence | Requires |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const [name, field] of Object.entries(registry.fields)) {
    const types = field.typeByProfile
      ? `${field.type}; ${Object.entries(field.typeByProfile)
          .map(([profile, type]) => `${profile}=${type}`)
          .join(', ')}`
      : field.type;
    const acceptedValues = field.acceptedValuesByProfile
      ? Object.entries(field.acceptedValuesByProfile)
          .map(([profile, values]) => `${profile}=${values.join('/')}`)
          .join('; ')
      : field.acceptedValues?.join('/') ?? 'any';
    const valueMatching = field.acceptedValuesByProfile
      ? Object.keys(field.acceptedValuesByProfile)
          .map((profile) => {
            const caseInsensitive =
              field.acceptedValuesCaseInsensitiveByProfile?.[profile] ??
              field.acceptedValuesCaseInsensitive ??
              false;
            return `${profile}=${caseInsensitive ? 'case-insensitive' : 'exact'}`;
          })
          .join(', ')
      : field.acceptedValues
        ? field.acceptedValuesCaseInsensitive === true
          ? 'case-insensitive'
          : 'exact'
        : 'n/a';
    const version = field.introducedVersion
      ? `introduced ${field.introducedVersion}`
      : field.verifiedAtVersion
        ? `verified ${field.verifiedAtVersion}`
        : 'n/a';
    const requires = field.requires
      ? Object.entries(field.requires)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(', ')
      : 'none';
    lines.push(
      `| \`${markdownCell(name)}\` | ${markdownCell(field.owner)} | ${field.required === true ? 'yes' : 'no'} | ${markdownCell(types)} | ${markdownCell(field.profiles.join(', '))} | ${markdownCell(acceptedValues)} | ${markdownCell(valueMatching)} | ${markdownCell(version)} | ${markdownCell(requires)} |`,
    );
  }
  lines.push(
    '',
    '## Sources',
    '',
    `- Agent Skills: ${registry.sources.agentSkills}`,
    `- Claude current: ${registry.sources.claudeCurrent}`,
    `- Claude minimum: ${registry.sources.claudeMinimum}`,
  );
  return `${lines.join('\n')}\n`;
}

const [frontmatterRegistry, skillRules, reviewDimensions] = await Promise.all([
  readJsonImport('AW_PLUGIN_IMPORT_SKILL_FRONTMATTER_CAPABILITIES'),
  readJsonImport('AW_PLUGIN_IMPORT_SKILL_RULES'),
  readJsonImport('AW_PLUGIN_IMPORT_REVIEW_DIMENSIONS'),
]);

if (frontmatterRegistry.schemaVersion !== 1 || !frontmatterRegistry.profiles || !frontmatterRegistry.fields) {
  throw new Error('Invalid Skill frontmatter capability registry build import.');
}
if (!Array.isArray(reviewDimensions.dimensions) || !skillRules.reviewResultPolicy) {
  throw new Error('Invalid Agent Skill review rule build imports.');
}

await Promise.all([
  writeFile(
    path.join(
      pluginRoot,
      'skills/author-aw-plugin/references/skill-frontmatter-capabilities.generated.md',
    ),
    renderFrontmatterReference(frontmatterRegistry),
    'utf8',
  ),
  writeFile(
    path.join(pluginRoot, 'skills/review-aw-plugin/assets/review-result-rules.generated.json'),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        dimensions: reviewDimensions.dimensions,
        reviewResultPolicy: skillRules.reviewResultPolicy,
      },
      null,
      2,
    )}\n`,
    'utf8',
  ),
]);
