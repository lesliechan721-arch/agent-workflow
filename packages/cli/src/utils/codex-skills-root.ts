import path from 'node:path';

import fs from 'fs-extra';

import type { PluginMeta } from '../types.js';

export async function resolveCodexSkillsRelativeRoot(
  plugin: Pick<PluginMeta, 'rootDir'> & { manifest: Pick<PluginMeta['manifest'], 'skills'> },
  marketplaceFallbackRoot?: string,
): Promise<string> {
  const manifestPaths = [
    path.join(plugin.rootDir, '.codex-plugin', 'plugin.json'),
    ...(marketplaceFallbackRoot
      ? [path.join(marketplaceFallbackRoot, '.codex-plugin', 'plugin.json')]
      : []),
  ];
  let manifest: Record<string, unknown> | null = null;
  for (const manifestPath of manifestPaths) {
    manifest = await fs.readJson(manifestPath).catch(() => null) as Record<string, unknown> | null;
    if (manifest) break;
  }
  const raw = typeof manifest?.skills === 'string' && manifest.skills.trim() !== ''
    ? manifest.skills
    : plugin.manifest.skills ?? './codex/skills';
  const normalized = path.posix.normalize(raw.replace(/^\.\//u, ''));
  if (normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    throw new Error(`Codex plugin skills root 越界：${raw}`);
  }
  return normalized;
}
