#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

const GENERATED_VIEWS = {
  'plugin-manifest': 'plugin-manifest-capabilities.generated.md',
  'build-config': 'build-config-capabilities.generated.md',
  extensions: 'extensions-capabilities.generated.md',
  'slash-command': 'slash-command-capabilities.generated.md',
  'mcp-app': 'mcp-app-capabilities.generated.md',
  'config-lifecycle-artifact': 'config-lifecycle-artifact-capabilities.generated.md',
};

function renderAuthoringReference(registry, surfaceKey, digest) {
  const surface = registry.surfaces[surfaceKey];
  if (!surface) throw new Error(`Missing authoring capability surface: ${surfaceKey}`);
  const lines = [
    `# ${surface.title}`,
    '',
    `Generated from \`@aw/cli/plugin-authoring-capabilities\` (${digest}).`,
    `Verified source: \`${registry.verifiedSource}\`.`,
    '',
    '| Field | Type | Required | Product/profile | Accepted values | Requires | Conflicts | Verified source |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of surface.entries) {
    const profile = entry.products ?? entry.profiles ?? 'all supported';
    const accepted = Array.isArray(entry.acceptedValues)
      ? entry.acceptedValues.join(', ')
      : entry.acceptedValues ?? '—';
    lines.push(`| \`${markdownCell(entry.field)}\` | ${markdownCell(entry.type)} | ${markdownCell(entry.required)} | ${markdownCell(profile)} | ${markdownCell(accepted)} | ${markdownCell(entry.requires ?? '—')} | ${markdownCell(entry.conflicts ?? '—')} | ${markdownCell(entry.verifiedSource ?? registry.verifiedSource)} |`);
  }
  return `${lines.join('\n')}\n`;
}

const frontmatterRegistry = JSON.parse(await readFile(
  requiredImport('AW_PLUGIN_IMPORT_SKILL_FRONTMATTER_CAPABILITIES'),
  'utf8',
));
if (frontmatterRegistry.schemaVersion !== 1 || !frontmatterRegistry.profiles || !frontmatterRegistry.fields) {
  throw new Error('Invalid Skill frontmatter capability registry build import.');
}
await writeFile(
  path.join(pluginRoot, 'skills/author-aw-plugin/references/skill-frontmatter-capabilities.md'),
  renderFrontmatterReference(frontmatterRegistry),
  'utf8',
);

const authoringRegistryBytes = await readFile(
  requiredImport('AW_PLUGIN_IMPORT_PLUGIN_AUTHORING_CAPABILITIES'),
);
const authoringRegistry = JSON.parse(authoringRegistryBytes.toString('utf8'));
if (authoringRegistry.schemaVersion !== 1 || !authoringRegistry.surfaces) {
  throw new Error('Invalid plugin authoring capability registry build import.');
}
const authoringRegistryDigest = `sha256:${createHash('sha256').update(authoringRegistryBytes).digest('hex')}`;
for (const [surface, fileName] of Object.entries(GENERATED_VIEWS)) {
  await writeFile(
    path.join(pluginRoot, 'skills/author-aw-plugin/references', fileName),
    renderAuthoringReference(authoringRegistry, surface, authoringRegistryDigest),
    'utf8',
  );
}
