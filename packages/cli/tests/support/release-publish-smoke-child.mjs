import fs from 'node:fs/promises';
import path from 'node:path';

import { publishPreparedRelease } from '../../../../scripts/release/prepared-release.mjs';

const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const descriptor = JSON.parse(await fs.readFile(path.join(config.preparedRoot, 'descriptor.json'), 'utf8'));
const events = [];

const catalogModules = {
  catalogSnapshot: {
    async validateCatalogSnapshot(root) {
      const manifest = JSON.parse(await fs.readFile(path.join(root, 'catalog-manifest.json'), 'utf8'));
      return { manifest, snapshotDigest: 'catalog-snapshot' };
    },
  },
  pluginStaging: { validatePluginReleaseLedgerAgainstManifest() {} },
};

try {
  await publishPreparedRelease({
    preparedRoot: config.preparedRoot,
    attemptPath: config.attemptPath,
    remoteUrl: config.remoteUrl,
    catalogModules,
    assertClean: async () => undefined,
    resolveHead: async () => descriptor.source.head,
    readTargets: async () => config.targets,
    assertPackageVersions: async () => ({ targetVersion: config.targets.cli }),
    withSnapshot: async (callback) => callback(descriptor.build),
    resolveCandidates: async () => descriptor.candidates,
    readPackageVersions: async () => [],
    readPublishedCliVersion: async () => config.publishedCliVersion,
    computeTarballTreeDigest: async (file) => file.includes('eval') ? 'eval-tree' : 'cli-tree',
    runNpmCommand: async (_command, args) => {
      const event = args[1].includes('eval') ? 'eval' : 'cli';
      events.push(event);
      if (config.fail === event) throw new Error('fake npm failure');
    },
    beforeRemoteWrite: async (target) => {
      if (target === undefined) events.push('catalog');
    },
  });
  process.stdout.write(JSON.stringify({ ok: true, events }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, events, error: String(error?.message) }));
}
