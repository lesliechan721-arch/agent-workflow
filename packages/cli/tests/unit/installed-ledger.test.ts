import { describe, expect, it } from 'vitest';

import {
  normalizeSharedNativeRefs,
  resolveScopeInitialized,
  validateInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import type { InstalledLedger } from '../../src/types.js';

describe('installed ledger', () => {
  it('accepts a valid ledger structure', () => {
    const ledger = validateInstalledLedger({
      version: 1,
      ledgerState: {
        status: 'available',
        degradedAt: null,
        reason: null,
      },
      plugins: {
        'git-commit': {
          lastResolvedVersion: '0.1.0',
          platforms: {
            codex: {
              userScope: {
                managed: true,
                updatedAt: '2026-04-25T00:00:00.000Z',
                resolvedVersion: '0.1.0',
                capabilitySnapshot: {
                  requiresNativePlugin: true,
                },
              },
            },
          },
        },
      },
    });

    expect(ledger).not.toBeNull();
  });

  it('accepts legacy scope records without installOptions and write order', () => {
    const ledger = validateInstalledLedger({
      version: 1,
      ledgerState: {
        status: 'available',
        degradedAt: null,
        reason: null,
      },
      plugins: {
        'git-commit': {
          lastResolvedVersion: '0.1.0',
          platforms: {
            claude: {
              projectScopes: {
                '/repo': {
                  managed: true,
                  updatedAt: '2026-04-25T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    managedExtensions: ['instructions'],
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ledger).not.toBeNull();
  });

  it('accepts skill trigger install options and write order on scope records', () => {
    const ledger = validateInstalledLedger({
      version: 1,
      ledgerState: {
        status: 'available',
        degradedAt: null,
        reason: null,
      },
      plugins: {
        'git-commit': {
          lastResolvedVersion: '0.1.0',
          platforms: {
            codex: {
              userScope: {
                managed: true,
                updatedAt: '2026-04-25T00:00:00.000Z',
                resolvedVersion: '0.1.0',
                capabilitySnapshot: {
                  requiresNativePlugin: true,
                },
                installOptions: {
                  skillTriggerPreference: 'manual',
                },
                skillTriggerWriteOrder: 3,
              },
            },
          },
        },
      },
    });

    expect(ledger?.plugins['git-commit']?.platforms.codex?.userScope).toMatchObject({
      installOptions: {
        skillTriggerPreference: 'manual',
      },
      skillTriggerWriteOrder: 3,
    });
  });

  it('rejects invalid skill trigger installOptions and write order values', () => {
    expect(
      validateInstalledLedger({
        version: 1,
        ledgerState: {
          status: 'available',
          degradedAt: null,
          reason: null,
        },
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-04-25T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: true,
                  },
                  installOptions: {
                    skillTriggerPreference: 'sometimes',
                  },
                },
              },
            },
          },
        },
      }),
    ).toBeNull();

    expect(
      validateInstalledLedger({
        version: 1,
        ledgerState: {
          status: 'available',
          degradedAt: null,
          reason: null,
        },
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-04-25T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: true,
                  },
                  installOptions: {
                    skillTriggerPreference: 'manual',
                    unexpected: true,
                  },
                },
              },
            },
          },
        },
      }),
    ).toBeNull();

    expect(
      validateInstalledLedger({
        version: 1,
        ledgerState: {
          status: 'available',
          degradedAt: null,
          reason: null,
        },
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-04-25T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: true,
                  },
                  skillTriggerWriteOrder: -1,
                },
              },
            },
          },
        },
      }),
    ).toBeNull();
  });

  it('derives scopeInitialized with available/degraded semantics', () => {
    const availableLedger: InstalledLedger = {
      version: 1,
      ledgerState: {
        status: 'available',
        degradedAt: null,
        reason: null,
      },
      plugins: {},
    };
    const degradedLedger: InstalledLedger = {
      version: 1,
      ledgerState: {
        status: 'degraded',
        degradedAt: '2026-04-25T00:00:00.000Z',
        reason: 'rebuilt_from_missing_or_invalid',
      },
      plugins: {},
    };

    expect(resolveScopeInitialized(availableLedger, 'git-commit', 'codex', 'user')).toBe('no');
    expect(resolveScopeInitialized(degradedLedger, 'git-commit', 'codex', 'user')).toBe('unknown');
  });

  it('normalizes sharedNativeRefs to a stable structure', () => {
    expect(
      normalizeSharedNativeRefs({
        user: true,
        projects: ['/b', '/a', '/a'],
      }),
    ).toEqual({
      user: true,
      projects: ['/a', '/b'],
    });
  });
});
