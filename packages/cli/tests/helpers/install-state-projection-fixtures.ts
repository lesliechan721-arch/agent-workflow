import type {
  CurrentCatalogArtifact,
  CurrentCatalogDynamicArtifact,
  CurrentCatalogEvidenceInput,
} from '../../src/install-state/evidence.js';
import type { InstallRecordFile } from '../../src/install-state/types.js';
import crypto from 'node:crypto';
import type { MinimalFixtureTarget, MinimalPluginInstallStatePaths } from './minimal-plugin-install-state-fixtures.js';
import fs from 'fs-extra';

export function createInstallStateFixtureEnv(
  paths: MinimalPluginInstallStatePaths,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AW_HOME: paths.awHome,
    AW_CODEX_HOME: paths.codexHome,
    AW_CLAUDE_HOME: paths.claudeHome,
    HOME: paths.rootDir,
  };
}

export function createCurrentCatalogForTarget(
  target: MinimalFixtureTarget,
  overrides: Partial<CurrentCatalogEvidenceInput> & {
    artifacts?: CurrentCatalogArtifact[];
    dynamicArtifacts?: CurrentCatalogDynamicArtifact[];
  } = {},
): CurrentCatalogEvidenceInput {
  return {
    source: {
      ...target.source,
      ...(overrides.source ?? {}),
    },
    artifacts: overrides.artifacts ?? [{
      kind: 'instruction',
      platform: target.location.platform,
      path: target.location.scope === 'project'
        ? target.repoArtifactRelativePath
        : target.repoArtifactPath,
      artifactKey: `${target.pluginSlug}.skill`,
      id: `${target.pluginSlug}-instruction`,
      target: 'codex.developerInstructionsBlock',
      ownershipMarker: `aw:${target.location.plugin}`,
      state: 'present',
      contentDigest: target.repoArtifactDigest,
    }],
    dynamicArtifacts: overrides.dynamicArtifacts ?? [{
      id: `${target.pluginSlug}-instruction`,
      target: 'codex.developerInstructionsBlock',
      state: 'present',
      artifactKey: `${target.pluginSlug}.skill`,
      configDigest: crypto.createHash('sha256').update(`${target.location.plugin}:config`).digest('hex'),
      contentDigest: target.repoArtifactDigest,
    }],
  };
}

export function sanitizeInstallRecordForP2(
  record: InstallRecordFile,
): InstallRecordFile {
  return {
    ...record,
    record: {
      ...record.record,
      artifacts: record.record.artifacts.map((artifact) => {
        const { state: _state, ...rest } = artifact as typeof artifact & { state?: string };
        return rest;
      }),
    },
  };
}

export async function rewriteSanitizedInstallRecordForP2(
  filePath: string,
): Promise<InstallRecordFile> {
  const record = await fs.readJson(filePath) as InstallRecordFile;
  const sanitized = sanitizeInstallRecordForP2(record);
  await fs.writeJson(filePath, sanitized, { spaces: 2 });
  return sanitized;
}

export async function refreshDependencyIndexDigestsForP2(
  indexPath: string,
): Promise<void> {
  if (!(await fs.pathExists(indexPath))) {
    return;
  }
  const index = await fs.readJson(indexPath) as {
    version: number;
    updatedAt: string;
    records: Array<{
      recordPath: string;
      recordDigest: string;
    } & Record<string, unknown>>;
  };
  for (const entry of index.records) {
    if (await fs.pathExists(entry.recordPath)) {
      entry.recordDigest = crypto.createHash('sha256').update(await fs.readFile(entry.recordPath)).digest('hex');
    }
  }
  await fs.writeJson(indexPath, index, { spaces: 2 });
}
