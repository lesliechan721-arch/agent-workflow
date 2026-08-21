#!/usr/bin/env node

import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requiredImport(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required build import: ${name}`);
  return value;
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
    lines.push(`| \`${markdownCell(name)}\` | ${markdownCell(profile.platform)} | ${markdownCell(profile.targetVersion ?? 'n/a')} | ${markdownCell(profile.description)} |`);
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
      ? `${field.type}; ${Object.entries(field.typeByProfile).map(([profile, type]) => `${profile}=${type}`).join(', ')}`
      : field.type;
    const acceptedValues = field.acceptedValuesByProfile
      ? Object.entries(field.acceptedValuesByProfile).map(([profile, values]) => `${profile}=${values.join('/')}`).join('; ')
      : field.acceptedValues?.join('/') ?? 'any';
    const valueMatching = field.acceptedValuesByProfile
      ? Object.keys(field.acceptedValuesByProfile).map((profile) => {
          const insensitive = field.acceptedValuesCaseInsensitiveByProfile?.[profile]
            ?? field.acceptedValuesCaseInsensitive
            ?? false;
          return `${profile}=${insensitive ? 'case-insensitive' : 'exact'}`;
        }).join(', ')
      : field.acceptedValues
        ? field.acceptedValuesCaseInsensitive === true ? 'case-insensitive' : 'exact'
        : 'n/a';
    const version = field.introducedVersion
      ? `introduced ${field.introducedVersion}`
      : field.verifiedAtVersion ? `verified ${field.verifiedAtVersion}` : 'n/a';
    const requires = field.requires
      ? Object.entries(field.requires).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')
      : 'none';
    lines.push(`| \`${markdownCell(name)}\` | ${markdownCell(field.owner)} | ${field.required === true ? 'yes' : 'no'} | ${markdownCell(types)} | ${markdownCell(field.profiles.join(', '))} | ${markdownCell(acceptedValues)} | ${markdownCell(valueMatching)} | ${markdownCell(version)} | ${markdownCell(requires)} |`);
  }
  lines.push('', '## Sources', '', `- Agent Skills: ${registry.sources.agentSkills}`, `- Claude current: ${registry.sources.claudeCurrent}`, `- Claude minimum: ${registry.sources.claudeMinimum}`);
  return lines.join('\n') + '\n';
}

const frontmatterRegistry = JSON.parse(await readFile(
  requiredImport('AW_PLUGIN_IMPORT_SKILL_FRONTMATTER_CAPABILITIES'),
  'utf8',
));
if (frontmatterRegistry.schemaVersion !== 1 || !frontmatterRegistry.profiles || !frontmatterRegistry.fields) {
  throw new Error('Invalid Skill frontmatter capability registry build import.');
}
await writeFile(
  path.join(pluginRoot, 'skills/author-aw-plugin/references/skill-frontmatter-capabilities.generated.md'),
  renderFrontmatterReference(frontmatterRegistry),
  'utf8',
);

// Transitional source-only tools are retained for old publication commands, but never enter the Agent-visible Skill bundle.
for (const relative of [
  'skills/review-aw-plugin/assets/aw-review-summary.json',
  'skills/review-aw-plugin/assets/review-input-bundle.json',
  'skills/review-aw-plugin/scripts/inspect-aw-target.mjs',
  'skills/review-aw-plugin/scripts/prepare-aw-review-bundle.mjs',
  'skills/review-aw-plugin/scripts/prepare-aw-review-target-plan.mjs',
  'skills/review-aw-plugin/scripts/prepare-aw-review-targets.mjs',
  'skills/review-aw-plugin/scripts/review-artifact-policy.mjs',
]) {
  await rm(path.join(pluginRoot, relative), { force: true });
}
