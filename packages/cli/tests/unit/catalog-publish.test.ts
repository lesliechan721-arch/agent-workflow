import { describe, expect, it } from 'vitest';

import {
  catalogPublicationPlanDigest,
  parseCatalogPublicationJournal,
  safeRemoteIdentity,
  sanitizedGitEnvironment,
  type CatalogPublicationDescriptor,
} from '../../src/commands/catalog-publish.js';

const descriptor = {
  schemaVersion: 1 as const,
  workspaceIdentity: 'workspace-demo',
  sourceHead: '1'.repeat(40),
  remote: {
    name: 'origin',
    identityDigest: `sha256:${'2'.repeat(64)}`,
  },
  branch: 'catalog/latest',
  parent: null,
  tag: 'catalog-v1.2.3',
  snapshotDigest: `sha256:${'3'.repeat(64)}`,
};
const expectedCommit = '4'.repeat(40);

interface JournalOverrides {
  descriptor?: Partial<CatalogPublicationDescriptor>;
  expectedCommit?: string;
}

function preparedJournal(overrides: JournalOverrides = {}) {
  const journalDescriptor = { ...descriptor, ...overrides.descriptor };
  const journalExpectedCommit = overrides.expectedCommit ?? expectedCommit;
  return {
    schemaVersion: 2 as const,
    state: 'prepared' as const,
    planDigest: catalogPublicationPlanDigest(journalDescriptor, journalExpectedCommit),
    descriptor: journalDescriptor,
    expectedCommit: journalExpectedCommit,
    repository: 'repository',
    display: { catalogVersion: '1.2.3', channel: 'latest' as const, pluginCount: 2 },
    preparedAt: '2026-08-31T00:00:00.000Z',
  };
}

const invalidCommitValues = [
  'a'.repeat(39),
  'a'.repeat(41),
  'a'.repeat(63),
  'a'.repeat(65),
  'A'.repeat(40),
  'g'.repeat(40),
];

describe('public Catalog Git publication safety', () => {
  it('removes repository and config namespace injection while preserving Git authentication inputs', () => {
    expect(sanitizedGitEnvironment({
      HOME: '/isolated-home',
      GIT_DIR: '/foreign/repository',
      GIT_WORK_TREE: '/foreign/worktree',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'malicious',
      GIT_OBJECT_DIRECTORY: '/foreign/objects',
      GIT_SSH_COMMAND: 'ssh -F /auth/config',
      SSH_AUTH_SOCK: '/auth/socket',
    })).toEqual({
      HOME: '/isolated-home',
      GIT_SSH_COMMAND: 'ssh -F /auth/config',
      SSH_AUTH_SOCK: '/auth/socket',
    });
  });

  it('never presents embedded credentials, query values, or fragments', () => {
    expect(safeRemoteIdentity('https://author:secret@example.invalid/catalog.git?token=query-secret#fragment-secret'))
      .toBe('https://example.invalid/catalog.git');
    expect(safeRemoteIdentity('author@example.invalid:catalog.git'))
      .toBe('example.invalid:catalog.git');
    expect(safeRemoteIdentity('author:secret@example.invalid:catalog.git?token=query-secret#fragment-secret'))
      .toBe('example.invalid:catalog.git');
  });

  it('binds the authorized plan identity to the descriptor and expected commit', () => {
    expect(Object.keys(descriptor).sort()).toEqual([
      'branch', 'parent', 'remote', 'schemaVersion', 'snapshotDigest', 'sourceHead', 'tag',
      'workspaceIdentity',
    ]);
    expect(catalogPublicationPlanDigest(descriptor, expectedCommit)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(catalogPublicationPlanDigest({ ...descriptor, branch: 'catalog/beta' }, expectedCommit))
      .not.toBe(catalogPublicationPlanDigest(descriptor, expectedCommit));
    expect(catalogPublicationPlanDigest(descriptor, '5'.repeat(40)))
      .not.toBe(catalogPublicationPlanDigest(descriptor, expectedCommit));
  });

  it.each(['prepared', 'uncertain', 'published'] as const)(
    'validates the version-scoped %s recovery journal',
    (state) => {
      const base = {
        schemaVersion: 2 as const,
        state,
        planDigest: catalogPublicationPlanDigest(descriptor, expectedCommit),
        descriptor,
        expectedCommit,
        repository: state === 'published' ? null : 'repository',
        display: { catalogVersion: '1.2.3', channel: 'latest' as const, pluginCount: 2 },
        preparedAt: '2026-08-31T00:00:00.000Z',
      };
      const journal = state === 'uncertain'
        ? { ...base, uncertainAt: '2026-08-31T00:01:00.000Z' }
        : state === 'published'
          ? { ...base, publishedAt: '2026-08-31T00:02:00.000Z' }
          : base;
      expect(parseCatalogPublicationJournal(journal, '1.2.3')).toEqual(journal);
    },
  );

  it('rejects authorization expansion and damaged repository binding', () => {
    const expandedDescriptor = { ...descriptor, catalogVersion: '1.2.3' };
    const journal = {
      schemaVersion: 2,
      state: 'prepared',
      planDigest: catalogPublicationPlanDigest(descriptor, expectedCommit),
      descriptor: expandedDescriptor,
      expectedCommit,
      repository: '../unbound.repo',
      display: { catalogVersion: '1.2.3', channel: 'latest', pluginCount: 2 },
      preparedAt: '2026-08-31T00:00:00.000Z',
    };
    expect(() => parseCatalogPublicationJournal(journal, '1.2.3'))
      .toThrow('publication journal is damaged');
  });

  it('rejects a changed expected commit under the original authorization digest', () => {
    const journal = {
      schemaVersion: 2,
      state: 'prepared',
      planDigest: catalogPublicationPlanDigest(descriptor, expectedCommit),
      descriptor,
      expectedCommit: '5'.repeat(40),
      repository: 'repository',
      display: { catalogVersion: '1.2.3', channel: 'latest', pluginCount: 2 },
      preparedAt: '2026-08-31T00:00:00.000Z',
    };
    expect(() => parseCatalogPublicationJournal(journal, '1.2.3'))
      .toThrow('publication journal is damaged');
  });

  it.each([40, 64])('accepts a %s-character sourceHead', (length) => {
    const journal = preparedJournal({ descriptor: { sourceHead: 'a'.repeat(length) } });
    expect(parseCatalogPublicationJournal(journal, '1.2.3')).toEqual(journal);
  });

  it.each([40, 64])('accepts a %s-character parent', (length) => {
    const journal = preparedJournal({ descriptor: { parent: 'b'.repeat(length) } });
    expect(parseCatalogPublicationJournal(journal, '1.2.3')).toEqual(journal);
  });

  it.each([40, 64])('accepts a %s-character expectedCommit', (length) => {
    const journal = preparedJournal({ expectedCommit: 'c'.repeat(length) });
    expect(parseCatalogPublicationJournal(journal, '1.2.3')).toEqual(journal);
  });

  it.each(invalidCommitValues)('rejects invalid sourceHead %s', (value) => {
    const journal = preparedJournal({ descriptor: { sourceHead: value } });
    expect(() => parseCatalogPublicationJournal(journal, '1.2.3'))
      .toThrow('publication journal is damaged');
  });

  it.each(invalidCommitValues)('rejects invalid parent %s', (value) => {
    const journal = preparedJournal({ descriptor: { parent: value } });
    expect(() => parseCatalogPublicationJournal(journal, '1.2.3'))
      .toThrow('publication journal is damaged');
  });

  it.each(invalidCommitValues)('rejects invalid expectedCommit %s', (value) => {
    const journal = preparedJournal({ expectedCommit: value });
    expect(() => parseCatalogPublicationJournal(journal, '1.2.3'))
      .toThrow('publication journal is damaged');
  });
});
