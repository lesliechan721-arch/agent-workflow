import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { readInstallStateProjection } from '../../src/commands/install-state-removal.js';
import { createInstallStateFixtureEnv, rewriteSanitizedInstallRecordForP2 } from '../helpers/install-state-projection-fixtures.js';
import { createMinimalPluginInstallStateFixtureBuilder } from '../helpers/minimal-plugin-install-state-fixtures.js';
import type { InstallRecordFile } from '../../src/install-state/types.js';

const tempDirs: string[] = [];

async function makeBuilder(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return createMinimalPluginInstallStateFixtureBuilder(root);
}

async function sha256File(filePath: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('install-state removal protection', () => {
  it('blocks removal when a verified dependent exists only in another repo dependency index entry', async () => {
    const builder = await makeBuilder('aw-p9-removal-protection-');
    const foreignBuilder = await makeBuilder('aw-p9-removal-protection-foreign-');

    const target = builder.createTarget({ pluginName: 'cleanup-child', platform: 'codex', scope: 'user' });
    await builder.writeRepoArtifact(target);
    const targetRecord = await builder.writeInstallRecord(target);
    const targetRecordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(targetRecordPath);

    const foreignDependent = foreignBuilder.createTarget({
      pluginName: 'foreign-project-parent',
      platform: 'codex',
      scope: 'project',
      projectKey: foreignBuilder.paths.repoRoot,
    });
    const foreignRecord = await foreignBuilder.writeInstallRecord(foreignDependent);
    const foreignRecordPath = path.join(
      foreignBuilder.paths.repoRoot,
      '.codex',
      '.agent-workflows',
      'records',
      `${foreignDependent.recordId}.json`,
    );
    const patchedForeignRecord: InstallRecordFile = {
      ...foreignRecord,
      record: {
        ...foreignRecord.record,
        dependencyEdges: [{
          dependency: target.location,
          declaration: {
            name: target.location.plugin,
          },
        }],
      },
    };
    await fs.writeJson(foreignRecordPath, patchedForeignRecord, { spaces: 2 });
    await rewriteSanitizedInstallRecordForP2(foreignRecordPath);

    await fs.outputJson(
      path.join(builder.paths.awHome, 'dependency-index', 'index.json'),
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        records: [
          {
            location: target.location,
            recordPath: targetRecordPath,
            recordDigest: await sha256File(targetRecordPath),
            installSource: targetRecord.record.installSource,
            dependencyEdges: targetRecord.record.dependencyEdges,
            lastSeenAt: target.timestamps.updatedAt,
          },
          {
            location: foreignDependent.location,
            recordPath: foreignRecordPath,
            recordDigest: await sha256File(foreignRecordPath),
            installSource: patchedForeignRecord.record.installSource,
            dependencyEdges: patchedForeignRecord.record.dependencyEdges,
            lastSeenAt: foreignDependent.timestamps.updatedAt,
          },
        ],
      },
      { spaces: 2 },
    );

    const projection = await readInstallStateProjection({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env: createInstallStateFixtureEnv(builder.paths),
    });

    expect(projection.removalProtection.allowed).toBe(false);
    expect(projection.removalProtection.blockedDependents).toEqual([foreignDependent.location]);
  });
});
