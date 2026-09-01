import { describe, expect, it } from 'vitest';

import {
  catalogPublicationPlanDigest,
  parseCatalogPublicationJournal,
  safeRemoteIdentity,
  sanitizedGitEnvironment,
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

  it('limits the authorized plan identity to source, remote, refs, and snapshot', () => {
    expect(Object.keys(descriptor).sort()).toEqual([
      'branch', 'parent', 'remote', 'schemaVersion', 'snapshotDigest', 'sourceHead', 'tag',
      'workspaceIdentity',
    ]);
    expect(catalogPublicationPlanDigest(descriptor)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(catalogPublicationPlanDigest({ ...descriptor, branch: 'catalog/beta' }))
      .not.toBe(catalogPublicationPlanDigest(descriptor));
  });

  it.each(['prepared', 'uncertain', 'published'] as const)(
    'validates the version-scoped %s recovery journal',
    (state) => {
      const base = {
        schemaVersion: 1 as const,
        state,
        planDigest: catalogPublicationPlanDigest(descriptor),
        descriptor,
        expectedCommit: '4'.repeat(40),
        repository: state === 'published' ? null : '1.2.3.repo',
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
      schemaVersion: 1,
      state: 'prepared',
      planDigest: catalogPublicationPlanDigest(descriptor),
      descriptor: expandedDescriptor,
      expectedCommit: '4'.repeat(40),
      repository: '../unbound.repo',
      display: { catalogVersion: '1.2.3', channel: 'latest', pluginCount: 2 },
      preparedAt: '2026-08-31T00:00:00.000Z',
    };
    expect(() => parseCatalogPublicationJournal(journal, '1.2.3'))
      .toThrow('publication journal is damaged');
  });
});
