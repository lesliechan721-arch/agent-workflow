import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';

import {
  publishStagedCatalog,
  readCatalogPublicationHistory,
} from '../../../../scripts/release/git-catalog-publisher.mjs';
import { stageCatalogRelease } from '../../../../scripts/release/stage-catalog.mjs';
import * as pluginStaging from '../../scripts/plugin-staging.js';
import * as catalogSnapshot from '../../src/utils/catalog-snapshot.js';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
let temporaryRoot: string | null = null;

afterEach(async () => {
  if (temporaryRoot) await fs.remove(temporaryRoot);
  temporaryRoot = null;
});

it('stages, publishes, fetches, and validates a release catalog through the Git provider', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-publish-smoke-'));
  const remoteUrl = path.join(temporaryRoot, 'catalog.git');
  await execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]);
  const publicationRoot = path.join(temporaryRoot, 'publication');
  await fs.ensureDir(publicationRoot);
  const outputRoot = path.join(publicationRoot, '.release', 'catalog-staging', 'catalog');
  const catalogModules = { pluginStaging, catalogSnapshot };
  const history = await readCatalogPublicationHistory({
    mode: 'beta',
    catalogVersion: '91.0.0-beta.1',
    remoteUrl,
    catalogModules,
  });
  const staged = await stageCatalogRelease(
    ['--catalog-version', '91.0.0-beta.1'],
    {
      internalOutputRoot: outputRoot,
      previousReleaseLedger: history.mergedLedger,
    },
  );
  const published = await publishStagedCatalog(history, staged.outputRoot);

  const resolved = await catalogGitProviderInternal.resolve({
    id: 'smoke',
    type: 'git',
    primary: true,
    url: remoteUrl,
    refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/beta' },
  }, {
    cliVersion: '99.0.0',
    freshnessPolicy: 'forceRemote',
    env: getCurrentSourceTestIsolation().env,
  });

  expect(resolved.resolvedCommit).toBe(published.commit);
  expect(resolved.manifest.catalogVersion).toBe('91.0.0-beta.1');
  expect(resolved.manifest.channel).toBe('beta');
  await expect(catalogSnapshot.validateCatalogSnapshot(resolved.rootDir))
    .resolves.toMatchObject({ manifest: { catalogVersion: '91.0.0-beta.1' } });
});
