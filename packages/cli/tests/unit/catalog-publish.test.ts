import { describe, expect, it } from 'vitest';

import {
  safeRemoteIdentity,
  sanitizedGitEnvironment,
} from '../../src/commands/catalog-publish.js';

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
});
