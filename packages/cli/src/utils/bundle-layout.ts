import path from 'node:path';

import fs from 'fs-extra';

import type { MarketplaceManifest, PlatformPluginManifest } from '../types.js';
import { readJsonFile } from './json.js';

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
    await assertBundlePathExists(pluginRoot, manifest.hooks, 'claude.hooks', './claude/');
  }
  if (manifest.mcpServers) {
    await assertBundlePathExists(pluginRoot, manifest.mcpServers, 'claude.mcpServers', './claude/');
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
    await assertBundlePathExists(pluginRoot, manifest.mcpServers, 'codex.mcpServers', './codex/');
  }
  if (manifest.apps) {
    await assertBundlePathExists(pluginRoot, manifest.apps, 'codex.apps', './codex/');
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

    const [claudeManifest, codexManifest] = await Promise.all([
      readJsonFile<PlatformPluginManifest>(path.join(pluginRoot, '.claude-plugin', 'plugin.json')),
      readJsonFile<PlatformPluginManifest>(path.join(pluginRoot, '.codex-plugin', 'plugin.json')),
    ]);

    await validateClaudeManifest(pluginRoot, claudeManifest);
    await validateCodexManifest(pluginRoot, codexManifest);
  }
}
