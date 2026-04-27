import path from 'node:path';

import fs from 'fs-extra';

import type { MarketplaceManifest, PlatformPluginManifest } from '../types.js';
import { validatePluginManifest } from './manifest.js';
import { readJsonFile } from './json.js';
import { validateRenderedHooksContent } from './rendered-contract.js';

function normalizeComparableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparableValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeComparableValue(entry)]),
    );
  }

  return value;
}

function serializeComparableValue(value: unknown): string {
  return JSON.stringify(normalizeComparableValue(value));
}

function assertRelativeBundlePath(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): string {
  if (!relativePath.startsWith(expectedPrefix)) {
    throw new Error(`Invalid ${fieldName}: expected path to start with "${expectedPrefix}".`);
  }

  const resolved = path.resolve(pluginRoot, relativePath);
  const relativeToRoot = path.relative(pluginRoot, resolved);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Invalid ${fieldName}: path escapes plugin root.`);
  }

  return resolved;
}

async function assertBundlePathExists(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): Promise<void> {
  const resolved = assertRelativeBundlePath(pluginRoot, relativePath, fieldName, expectedPrefix);
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Invalid ${fieldName}: "${relativePath}" does not exist in bundle.`);
  }
}

async function assertJsonObjectFile(filePath: string, fieldName: string): Promise<Record<string, unknown>> {
  let content: unknown;
  try {
    content = await fs.readJson(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${fieldName}: expected valid JSON (${message}).`);
  }

  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error(`Invalid ${fieldName}: expected a JSON object.`);
  }

  return content as Record<string, unknown>;
}

async function assertMcpArtifact(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): Promise<void> {
  const resolved = assertRelativeBundlePath(pluginRoot, relativePath, fieldName, expectedPrefix);
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Invalid ${fieldName}: "${relativePath}" does not exist in bundle.`);
  }
  const content = await assertJsonObjectFile(resolved, fieldName);
  if (!content.mcpServers || typeof content.mcpServers !== 'object' || Array.isArray(content.mcpServers)) {
    throw new Error(`Invalid ${fieldName}: expected top-level "mcpServers" object.`);
  }
}

async function assertAppsArtifact(
  pluginRoot: string,
  relativePath: string,
  fieldName: string,
  expectedPrefix: string,
): Promise<void> {
  const resolved = assertRelativeBundlePath(pluginRoot, relativePath, fieldName, expectedPrefix);
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Invalid ${fieldName}: "${relativePath}" does not exist in bundle.`);
  }
  const content = await assertJsonObjectFile(resolved, fieldName);
  if (!content.apps || typeof content.apps !== 'object' || Array.isArray(content.apps)) {
    throw new Error(`Invalid ${fieldName}: expected top-level "apps" object.`);
  }

  for (const [name, app] of Object.entries(content.apps as Record<string, unknown>)) {
    if (!app || typeof app !== 'object' || Array.isArray(app)) {
      throw new Error(`Invalid ${fieldName}.apps.${name}: expected an object.`);
    }
    const id = (app as Record<string, unknown>).id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`Invalid ${fieldName}.apps.${name}.id: expected a non-empty string.`);
    }
  }
}

async function assertClaudeHooksArtifact(
  pluginRoot: string,
  relativePath: string,
): Promise<void> {
  const resolved = assertRelativeBundlePath(pluginRoot, relativePath, 'claude.hooks', './claude/');
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Invalid claude.hooks: "${relativePath}" does not exist in bundle.`);
  }
  const content = await assertJsonObjectFile(resolved, 'claude.hooks');
  validateRenderedHooksContent(content, 'claude.hooks');
}

async function validateClaudeManifest(
  pluginRoot: string,
  manifest: PlatformPluginManifest,
): Promise<void> {
  if (manifest.skills) {
    await assertBundlePathExists(pluginRoot, manifest.skills, 'claude.skills', './claude/');
  }
  if (manifest.commands) {
    await assertBundlePathExists(pluginRoot, manifest.commands, 'claude.commands', './claude/');
  }
  if (manifest.hooks) {
    if (typeof manifest.hooks !== 'string') {
      throw new Error('Invalid claude.hooks: expected a bundle-local path string.');
    }
    await assertClaudeHooksArtifact(pluginRoot, manifest.hooks);
  }
  if (manifest.mcpServers) {
    await assertMcpArtifact(pluginRoot, manifest.mcpServers, 'claude.mcpServers', './claude/');
  }
  if (manifest.outputStyles) {
    await assertBundlePathExists(
      pluginRoot,
      manifest.outputStyles,
      'claude.outputStyles',
      './claude/',
    );
  }
  if (manifest.agents) {
    for (const [index, agentPath] of manifest.agents.entries()) {
      await assertBundlePathExists(
        pluginRoot,
        agentPath,
        `claude.agents[${index}]`,
        './claude/',
      );
    }
  }
  if (manifest.lspServers) {
    if (typeof manifest.lspServers === 'string') {
      await assertBundlePathExists(
        pluginRoot,
        manifest.lspServers,
        'claude.lspServers',
        './claude/',
      );
    } else if (Array.isArray(manifest.lspServers)) {
      for (const [index, entry] of manifest.lspServers.entries()) {
        if (typeof entry === 'string') {
          await assertBundlePathExists(
            pluginRoot,
            entry,
            `claude.lspServers[${index}]`,
            './claude/',
          );
        }
      }
    }
  }
}

async function validateCodexManifest(
  pluginRoot: string,
  manifest: PlatformPluginManifest,
): Promise<void> {
  if (manifest.skills) {
    await assertBundlePathExists(pluginRoot, manifest.skills, 'codex.skills', './codex/');
  }
  if (manifest.mcpServers) {
    await assertMcpArtifact(pluginRoot, manifest.mcpServers, 'codex.mcpServers', './codex/');
  }
  if (manifest.apps) {
    await assertAppsArtifact(pluginRoot, manifest.apps, 'codex.apps', './codex/');
  }
}

export async function validateBundleLayout(rootDir: string): Promise<void> {
  const claudeMarketplacePath = path.join(rootDir, '.claude-plugin', 'marketplace.json');
  const codexMarketplacePath = path.join(rootDir, '.agents', 'plugins', 'marketplace.json');
  const [claudeMarketplace, codexMarketplace] = await Promise.all([
    readJsonFile<MarketplaceManifest>(claudeMarketplacePath),
    readJsonFile<MarketplaceManifest>(codexMarketplacePath),
  ]);

  if (serializeComparableValue(claudeMarketplace) !== serializeComparableValue(codexMarketplace)) {
    throw new Error('Marketplace mirrors are inconsistent.');
  }

  if (claudeMarketplace.name !== 'aw') {
    throw new Error('Invalid marketplace name: expected "aw".');
  }

  for (const pluginEntry of claudeMarketplace.plugins) {
    if (pluginEntry.source !== `./plugins/${pluginEntry.name}`) {
      throw new Error(
        `Invalid marketplace source for "${pluginEntry.name}": expected "./plugins/${pluginEntry.name}".`,
      );
    }

    const pluginRoot = path.join(rootDir, 'plugins', pluginEntry.name);
    const requiredFiles = [
      path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    ];

    for (const requiredFile of requiredFiles) {
      if (!(await fs.pathExists(requiredFile))) {
        throw new Error(`Invalid bundle layout: missing "${requiredFile}".`);
      }
    }

    const [sourceManifest, claudeManifest, codexManifest] = await Promise.all([
      readJsonFile<unknown>(path.join(pluginRoot, '.agents-plugin', 'plugin.json')),
      readJsonFile<PlatformPluginManifest>(path.join(pluginRoot, '.claude-plugin', 'plugin.json')),
      readJsonFile<PlatformPluginManifest>(path.join(pluginRoot, '.codex-plugin', 'plugin.json')),
    ]);

    validatePluginManifest(pluginRoot, sourceManifest);
    await validateClaudeManifest(pluginRoot, claudeManifest);
    await validateCodexManifest(pluginRoot, codexManifest);
  }
}
