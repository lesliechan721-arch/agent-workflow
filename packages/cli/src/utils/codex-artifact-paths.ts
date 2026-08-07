import path from 'node:path';

import { buildGeneratedName } from '../generators/shared.js';
import type { GeneratedArtifact, Scope } from '../types.js';
import { getLocalMarketplaceCodexSkillRoot } from './local-marketplace.js';
import { resolveAwHome, resolveCodexPaths, resolveRepoRoot } from './paths.js';

const CODEX_ARTIFACT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

function requireCodexArtifactKey(value: string | undefined, kind: 'skill' | 'role'): string {
  const artifactKey = value?.trim();
  if (!artifactKey || !CODEX_ARTIFACT_KEY_PATTERN.test(artifactKey)) {
    throw new Error(`tracking manifest 中的 Codex ${kind} 缺少有效 artifactKey。`);
  }
  return artifactKey;
}

async function resolveCanonicalMainPath(options: {
  cwd: string;
  scope: Scope;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  artifact: GeneratedArtifact;
}): Promise<string | null> {
  const { artifact } = options;
  if (artifact.kind === 'skill') {
    if (artifact.state === 'disabled') {
      return null;
    }
    const skillKey = requireCodexArtifactKey(artifact.artifactKey, 'skill');
    if (options.scope === 'user') {
      return getLocalMarketplaceCodexSkillRoot(
        resolveAwHome(options.env),
        options.pluginName,
        skillKey,
      );
    }
    return path.join(await resolveRepoRoot(options.cwd), '.agents', 'skills', skillKey);
  }

  if (
    artifact.kind === 'agent' &&
    (artifact.target === 'codex.agentRole' || artifact.roleKey !== undefined)
  ) {
    const roleKey = requireCodexArtifactKey(
      artifact.roleKey?.trim() || artifact.artifactKey,
      'role',
    );
    return path.join(
      resolveCodexPaths(options.cwd, options.scope, options.env).configDir,
      'agents',
      `${buildGeneratedName(options.pluginName, roleKey)}.toml`,
    );
  }

  return null;
}

export async function assertCanonicalTrackedCodexArtifactMainPaths(options: {
  cwd: string;
  scope: Scope;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  artifacts: GeneratedArtifact[];
}): Promise<void> {
  for (const artifact of options.artifacts) {
    const canonicalPath = await resolveCanonicalMainPath({
      ...options,
      artifact,
    });
    if (
      canonicalPath !== null &&
      path.normalize(artifact.path) !== path.normalize(canonicalPath)
    ) {
      throw new Error(
        `tracking manifest 中的 ${artifact.kind} main path 不是当前 scope 的 canonical 路径：${artifact.path}`,
      );
    }
  }
}
