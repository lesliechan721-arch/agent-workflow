import { describe, expect, it } from 'vitest';

import {
  calculateCanonicalDigest,
  calculateCatalogContentDigest,
  calculateCliTrainContentDigest,
  canonicalJson,
} from '../../../../scripts/release/release-model.mjs';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

describe('release digests and metadata', () => {
  it('canonicalizes JSON object keys and rejects values with no JSON identity', () => {
    expect(canonicalJson({ z: 1, a: { d: true, c: null } }))
      .toBe('{"a":{"c":null,"d":true},"z":1}');
    expect(calculateCanonicalDigest({ z: 1, a: 2 }))
      .toBe(calculateCanonicalDigest({ a: 2, z: 1 }));
    expect(() => canonicalJson({ value: undefined })).toThrow('expected a JSON value');
    expect(() => canonicalJson({ value: Number.NaN })).toThrow('must be finite');
  });

  it('normalizes the two-package CLI train independently of package order', () => {
    const packages = [
      { name: '@lesliechan721/aw', contentDigest: digest('a') },
      { name: '@lesliechan721/agent-skill-eval', contentDigest: digest('b') },
    ];
    expect(calculateCliTrainContentDigest(packages))
      .toBe(calculateCliTrainContentDigest(packages.toReversed()));
    expect(() => calculateCliTrainContentDigest(packages.slice(0, 1)))
      .toThrow('expected @lesliechan721/agent-skill-eval and @lesliechan721/aw');
  });

  it.each([0, 1])('binds CLI train content to package %s', (packageIndex) => {
    const packages = [
      { name: '@lesliechan721/aw', contentDigest: digest('a') },
      { name: '@lesliechan721/agent-skill-eval', contentDigest: digest('b') },
    ];
    const changed = packages.map((packageEntry, index) => index === packageIndex
      ? { ...packageEntry, contentDigest: digest('c') }
      : packageEntry);
    expect(calculateCliTrainContentDigest(changed))
      .not.toBe(calculateCliTrainContentDigest(packages));
  });

  it('makes catalog content independent of order and release-only fields', () => {
    const catalog = {
      schemaIdentity: { name: 'catalog-manifest', schemaVersion: 3 },
      marketplaceMetadata: { owner: { name: 'Owner' }, displayName: 'Catalog' },
      compatibility: { aw: { minVersion: '1.0.0' } },
      catalogVersion: '5.0.0-beta.2',
      channel: 'beta',
      planId: digest('4'),
      sourceHead: 'a'.repeat(40),
      generatedAt: '2026-01-01T00:00:00Z',
      ref: 'refs/heads/catalog/beta',
      plugins: [
        {
          name: 'zeta',
          targetVersion: '2.0.0',
          candidateVersion: '2.0.0-beta.3',
          contentDigest: digest('a'),
          publishedAt: '2026-01-01T00:00:00Z',
        },
        {
          name: 'alpha',
          targetVersion: '1.1.0',
          candidateVersion: '1.1.0-beta.1',
          contentDigest: digest('b'),
        },
      ],
    };
    const changedExcludedFields = {
      ...catalog,
      catalogVersion: '5.0.0-beta.9',
      channel: 'latest',
      planId: digest('5'),
      sourceHead: 'b'.repeat(40),
      generatedAt: '2027-02-02T00:00:00Z',
      ref: 'refs/heads/catalog/latest',
      plugins: catalog.plugins.toReversed().map((plugin) => ({
        ...plugin,
        candidateVersion: `${plugin.targetVersion}-beta.99`,
        publishedAt: '2028-03-03T00:00:00Z',
      })),
    };
    expect(calculateCatalogContentDigest(catalog))
      .toBe(calculateCatalogContentDigest(changedExcludedFields));
  });

  it('uses code-unit plugin ordering independently of input order', () => {
    const catalog = {
      schemaIdentity: { schemaVersion: 3 },
      marketplaceMetadata: { owner: 'Owner' },
      compatibility: { aw: { minVersion: '1.0.0' } },
      plugins: [
        { name: 'a-a', targetVersion: '1.0.0', contentDigest: digest('a') },
        { name: 'aa', targetVersion: '1.0.0', contentDigest: digest('b') },
      ],
    };
    expect(calculateCatalogContentDigest(catalog))
      .toBe(calculateCatalogContentDigest({
        ...catalog,
        plugins: catalog.plugins.toReversed(),
      }));
  });

  it.each([
    ['schema identity', (catalog: CatalogDigestFixture) => ({
      ...catalog,
      schemaIdentity: { schemaVersion: 4 },
    })],
    ['marketplace metadata', (catalog: CatalogDigestFixture) => ({
      ...catalog,
      marketplaceMetadata: { owner: 'Different owner' },
    })],
    ['compatibility', (catalog: CatalogDigestFixture) => ({
      ...catalog,
      compatibility: { aw: { minVersion: '2.0.0' } },
    })],
    ['plugin name', (catalog: CatalogDigestFixture) => ({
      ...catalog,
      plugins: [{ ...catalog.plugins[0], name: 'renamed-plugin' }],
    })],
    ['plugin content', (catalog: CatalogDigestFixture) => ({
      ...catalog,
      plugins: [{ ...catalog.plugins[0], contentDigest: digest('b') }],
    })],
  ] as const)('binds catalog content to %s', (_fieldName, mutate) => {
    const catalog: CatalogDigestFixture = {
      schemaIdentity: { schemaVersion: 3 },
      marketplaceMetadata: { owner: 'Owner' },
      compatibility: { aw: { minVersion: '1.0.0' } },
      plugins: [{ name: 'plugin', targetVersion: '1.0.0', contentDigest: digest('a') }],
    };
    expect(calculateCatalogContentDigest(mutate(catalog)))
      .not.toBe(calculateCatalogContentDigest(catalog));
  });

  it('changes catalog content when a plugin stable target core changes', () => {
    const catalog = {
      schemaIdentity: { schemaVersion: 3 },
      marketplaceMetadata: { owner: 'Owner' },
      compatibility: { aw: { minVersion: '1.0.0' } },
      plugins: [{ name: 'plugin', targetVersion: '1.0.0', contentDigest: digest('a') }],
    };
    expect(calculateCatalogContentDigest(catalog)).not.toBe(calculateCatalogContentDigest({
      ...catalog,
      plugins: [{ ...catalog.plugins[0], targetVersion: '1.1.0' }],
    }));
  });
});

interface CatalogDigestFixture {
  schemaIdentity: { schemaVersion: number };
  marketplaceMetadata: { owner: string };
  compatibility: { aw: { minVersion: string } };
  plugins: Array<{
    name: string;
    targetVersion: string;
    contentDigest: string;
  }>;
}
