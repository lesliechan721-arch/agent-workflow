import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import type { CatalogManifestV7 } from '../../src/types.js';
import {
  catalogSourceImpactRequiresConfirmation,
  inspectCatalogSourceImpact,
} from '../../src/utils/catalog-source-impact.js';
import {
  withCatalogGenerationStateTransaction,
} from '../../src/utils/catalog-generation-state.js';
import type {
  CatalogSourceReferenceInventory,
} from '../../src/utils/catalog-source-references.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function manifest(entries: Array<{
  name: string;
  contentDigest: string;
  dependencies?: string[];
  capabilities?: string[];
  products?: string[];
}>): CatalogManifestV7 {
  return {
    schemaVersion: 7,
    catalogVersion: '1.0.0',
    channel: 'latest',
    requires: { aw: { capabilities: ['aw.catalog-snapshot.v7'] } },
    marketplace: {
      owner: { name: 'Fixture', url: 'https://example.invalid' },
      interface: { displayName: 'Fixture' },
    },
    release: { state: 'development' },
    entries: entries.map((entry) => ({
      name: entry.name,
      version: '1.0.0',
      description: entry.name,
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        ...(entry.products ? { products: entry.products } : {}),
      },
      dependencies: entry.dependencies ?? [],
      requires: { aw: { capabilities: entry.capabilities ?? [] } },
      source: `plugins/${entry.name}`,
      artifactDigest: `sha256:${'1'.repeat(64)}`,
      manifestDigest: `sha256:${'2'.repeat(64)}`,
      contentDigest: entry.contentDigest,
    })),
  };
}

describe('Catalog source impact inspection', () => {
  it('projects removed platform support and consumers only to matching platform references', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const inventory: CatalogSourceReferenceInventory = {
      inventorySchemaVersion: 1,
      references: [
        {
          kind: 'namespacedLifecycle',
          location: 'dependency-claude',
          sourceId: 'team',
          pluginName: 'dependency',
          platform: 'claude',
          scope: 'user',
        },
        {
          kind: 'namespacedLifecycle',
          location: 'dependency-codex',
          sourceId: 'team',
          pluginName: 'dependency',
          platform: 'codex',
          scope: 'user',
        },
        {
          kind: 'namespacedLifecycle',
          location: 'consumer-claude',
          sourceId: 'team',
          pluginName: 'consumer',
          platform: 'claude',
          scope: 'user',
        },
        {
          kind: 'namespacedLifecycle',
          location: 'consumer-codex',
          sourceId: 'team',
          pluginName: 'consumer',
          platform: 'codex',
          scope: 'user',
        },
        {
          kind: 'namespacedLifecycle',
          location: 'candidate-consumer-claude',
          sourceId: 'team',
          pluginName: 'candidate-consumer',
          platform: 'claude',
          scope: 'user',
        },
        {
          kind: 'namespacedLifecycle',
          location: 'candidate-consumer-codex',
          sourceId: 'team',
          pluginName: 'candidate-consumer',
          platform: 'codex',
          scope: 'user',
        },
        {
          kind: 'namespacedConfig',
          location: 'platform-unknown',
          sourceId: 'team',
          pluginName: 'dependency',
          scope: 'user',
        },
      ],
      errors: [],
    };

    const impact = await inspectCatalogSourceImpact({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      mode: 'generation',
      currentManifest: manifest([
        {
          name: 'dependency',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          products: ['CODEX', 'CLAUDE'],
        },
        {
          name: 'consumer',
          contentDigest: `sha256:${'b'.repeat(64)}`,
          dependencies: ['dependency'],
          products: ['CODEX', 'CLAUDE'],
        },
      ]),
      candidateManifest: manifest([
        {
          name: 'dependency',
          contentDigest: `sha256:${'c'.repeat(64)}`,
          products: ['CODEX'],
        },
        {
          name: 'consumer',
          contentDigest: `sha256:${'b'.repeat(64)}`,
          dependencies: ['dependency'],
          products: ['CODEX', 'CLAUDE'],
        },
        {
          name: 'candidate-consumer',
          contentDigest: `sha256:${'d'.repeat(64)}`,
          dependencies: ['dependency'],
          products: ['CODEX', 'CLAUDE'],
        },
      ]),
      inventory,
    });

    expect(impact.impactSchemaVersion).toBe(2);
    expect(impact.changes.platformSupportChanged).toEqual([{
      pluginId: 'team/dependency',
      removedPlatforms: ['claude'],
      addedPlatforms: [],
    }]);
    expect(impact.affectedReferences).toEqual([
      expect.objectContaining({ pluginId: 'team/candidate-consumer', platform: 'claude' }),
      expect.objectContaining({ pluginId: 'team/consumer', platform: 'claude' }),
      expect.objectContaining({ pluginId: 'team/dependency', platform: 'claude' }),
    ]);
  });

  it('reports added platform support without requiring confirmation and sorts changes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const impact = await inspectCatalogSourceImpact({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      mode: 'generation',
      currentManifest: manifest([
        { name: 'zeta', contentDigest: 'z-current', products: ['CODEX'] },
        { name: 'alpha', contentDigest: 'a-current', products: ['CLAUDE'] },
      ]),
      candidateManifest: manifest([
        { name: 'zeta', contentDigest: 'z-candidate', products: ['CODEX', 'CLAUDE'] },
        { name: 'alpha', contentDigest: 'a-candidate', products: ['CODEX', 'CLAUDE'] },
      ]),
      inventory: { inventorySchemaVersion: 1, references: [], errors: [] },
    });

    expect(impact.changes.platformSupportChanged).toEqual([
      {
        pluginId: 'team/alpha',
        removedPlatforms: [],
        addedPlatforms: ['codex'],
      },
      {
        pluginId: 'team/zeta',
        removedPlatforms: [],
        addedPlatforms: ['claude'],
      },
    ]);
    expect(impact.affectedReferences).toEqual([]);
    expect(catalogSourceImpactRequiresConfirmation(impact)).toBe(false);
  });

  it('projects dependency effects without exposing internal paths', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const projectKey = await fs.realpath(isolation.layout.fixtureCwd);
    const inventory: CatalogSourceReferenceInventory = {
      inventorySchemaVersion: 1,
      references: [
        {
          kind: 'namespacedLifecycle',
          location: `${isolation.layout.fixtureCwd}/.agent-workflows/plugin-intents.json`,
          sourceId: 'team',
          pluginName: 'consumer',
          scope: 'project',
          projectKey,
        },
        {
          kind: 'namespacedConfig',
          location: `${isolation.layout.awHomeDir}/plugin-config/team/dependency/config.json`,
          sourceId: 'team',
          pluginName: 'dependency',
        },
      ],
      errors: [],
    };

    const impact = await inspectCatalogSourceImpact({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      mode: 'generation',
      currentManifest: manifest([
        { name: 'dependency', contentDigest: `sha256:${'a'.repeat(64)}` },
        { name: 'consumer', contentDigest: `sha256:${'b'.repeat(64)}`, dependencies: ['dependency'] },
      ]),
      candidateManifest: manifest([
        { name: 'consumer', contentDigest: `sha256:${'c'.repeat(64)}`, dependencies: [] },
      ]),
      inventory,
    });

    expect(impact.changes).toMatchObject({
      removed: ['team/dependency'],
      dependencyChanged: ['team/consumer'],
      changed: ['team/consumer'],
    });
    expect(impact.affectedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'config', pluginId: 'team/dependency' }),
      expect.objectContaining({
        category: 'lifecycle',
        pluginId: 'team/consumer',
        projectRecord: 'current',
      }),
    ]));
    expect(JSON.stringify(impact)).not.toContain(isolation.layout.fixtureCwd);
    expect(JSON.stringify(impact)).not.toContain(isolation.layout.awHomeDir);
  });

  it('treats inventory errors as unknown impact for source removal', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const impact = await inspectCatalogSourceImpact({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      mode: 'remove',
      inventory: {
        inventorySchemaVersion: 1,
        references: [{
          kind: 'namespacedMarketplace',
          location: `${isolation.layout.awHomeDir}/marketplaces/team/config.json`,
          sourceId: 'team',
          marketplaceName: 'aw-team',
        }],
        errors: [{
          code: 'stateInventoryFailed',
          kind: 'nativeStateRead',
          location: `${isolation.layout.fixtureCwd}/secret/config.toml`,
          message: 'unreadable',
          relevance: {
            global: false,
            scope: 'project',
            projectLocationKey: `${isolation.layout.fixtureCwd}/secret`,
          },
        }],
      },
    });

    expect(impact).toMatchObject({
      inventoryComplete: false,
      affectedReferences: [{ category: 'marketplace', sourceId: 'team' }],
      errors: [{ code: 'stateInventoryFailed', kind: 'nativeStateRead' }],
    });
    expect(JSON.stringify(impact)).not.toContain('secret');
    expect(JSON.stringify(impact)).not.toContain(isolation.layout.fixtureCwd);
  });

  it('keeps user and current-project config references as separate projections', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const envelope = {
      schemaVersion: 3,
      sourceId: 'team',
      sourceIdentity: `sha256:${'1'.repeat(64)}`,
      pluginName: 'demo',
      values: {},
    };
    await Promise.all([
      fs.outputJson(
        `${isolation.layout.awHomeDir}/plugin-config/team/demo/config.json`,
        envelope,
      ),
      fs.outputJson(
        `${isolation.layout.fixtureCwd}/.agent-workflows/plugin-config/team/demo/config.json`,
        envelope,
      ),
    ]);

    const impact = await inspectCatalogSourceImpact({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      mode: 'remove',
    });

    expect(impact.affectedReferences.filter((reference) =>
      reference.category === 'config' && reference.pluginId === 'team/demo')).toEqual([
      expect.objectContaining({ scope: 'project', projectRecord: 'current' }),
      expect.objectContaining({ scope: 'user' }),
    ]);
  });

  it('treats an unavailable Active manifest as unknown without known references', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await withCatalogGenerationStateTransaction({
      env: isolation.env,
      action: async () => ({
        state: {
          schemaVersion: 1,
          sources: {
            team: {
              active: {
                sourceConfigFingerprint: `sha256:${'1'.repeat(64)}`,
                sourceIdentity: `sha256:${'2'.repeat(64)}`,
                requestedRef: 'refs/heads/main',
                resolvedCommit: '3'.repeat(40),
                logicalIdentity: 'missing-workspace',
                manifestDigest: `sha256:${'4'.repeat(64)}`,
                snapshotDigest: `sha256:${'5'.repeat(64)}`,
                activatedAt: '2026-01-01T00:00:00.000Z',
              },
              lastSync: {
                syncedAt: '2026-01-01T00:00:00.000Z',
                mode: 'sync',
                state: 'succeeded',
                resolvedCommit: '3'.repeat(40),
              },
            },
          },
        },
        result: undefined,
      }),
    });

    const impact = await inspectCatalogSourceImpact({
      sourceId: 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      mode: 'generation',
      candidateManifest: manifest([]),
      inventory: { inventorySchemaVersion: 1, references: [], errors: [] },
    });

    expect(impact).toMatchObject({
      inventoryComplete: false,
      references: [],
      affectedReferences: [],
      errors: [{ code: 'catalogManifestUnavailable', kind: 'currentManifestRead' }],
    });
  });
});
