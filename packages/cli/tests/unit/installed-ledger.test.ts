import { describe, expect, it } from 'vitest';

import {
  hasInstalledLedgerDependencyMetadata,
  normalizeSharedNativeRefs,
  resolveCodexProjectScopeInitialized,
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

  it('accepts Codex project managed scope snapshots without shared native refs', () => {
    const ledger = validateInstalledLedger({
      version: 1,
      ledgerState: {
        status: 'available',
        degradedAt: null,
        reason: null,
      },
      plugins: {
        'slash-review': {
          lastResolvedVersion: '0.1.0',
          platforms: {
            codex: {
              projectScopes: {
                '/repo': {
                  managed: true,
                  updatedAt: '2026-04-25T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  projectKey: '/repo',
                  capabilitySnapshot: {
                    requiresNativePlugin: false,
                    hasRepoManagedArtifacts: true,
                    projectManagedKinds: ['skill'],
                  },
                  installOptions: {
                    skillTriggerPreference: 'manual',
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ledger?.plugins['slash-review']?.platforms.codex?.sharedNativeRefs).toBeUndefined();
    expect(ledger?.plugins['slash-review']?.platforms.codex?.projectScopes?.['/repo']).toMatchObject({
      managed: true,
      projectKey: '/repo',
      capabilitySnapshot: {
        requiresNativePlugin: false,
        projectManagedKinds: ['skill'],
      },
    });
  });

  it('accepts lifecycle config snapshot metadata on scope records', () => {
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
                lifecycleConfigSnapshot: {
                  snapshotRoot: '/aw/plugin-install-snapshots/codex/user/scope/git-commit/digest',
                  bundleRoot: '/aw/plugin-install-snapshots/codex/user/scope/git-commit/digest/bundle',
                  manifestPath: '/aw/plugin-install-snapshots/codex/user/scope/git-commit/digest/bundle/.agents-plugin/plugin.json',
                  pluginName: 'git-commit',
                  pluginVersion: '0.1.0',
                  sourceManifestDigest: 'sha256:manifest',
                  bundleFingerprint: 'sha256:bundle',
                  createdAt: '2026-04-25T00:00:00.000Z',
                  createdFrom: {
                    source: 'currentCatalog',
                    catalogRoot: '/aw',
                    catalogSource: 'local',
                    pluginRoot: '/aw/plugins/git-commit',
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(ledger?.plugins['git-commit']?.platforms.codex?.userScope?.lifecycleConfigSnapshot).toMatchObject({
      pluginName: 'git-commit',
      sourceManifestDigest: 'sha256:manifest',
    });
  });

  it('accepts dependency metadata in strict mode', () => {
    const ledger = validateInstalledLedger({
      version: 1,
      ledgerState: {
        status: 'available',
        degradedAt: null,
        reason: null,
      },
      plugins: {
        'workflow-pack': {
          lastResolvedVersion: '0.1.0',
          platforms: {
            codex: {
              userScope: {
                managed: true,
                updatedAt: '2026-05-06T00:00:00.000Z',
                resolvedVersion: '0.1.0',
                capabilitySnapshot: {
                  requiresNativePlugin: true,
                },
                installSource: {
                  kind: 'explicit',
                  explicitlyRequested: true,
                  allowsUnusedCleanup: false,
                },
                dependencyEdges: [
                  {
                    dependency: {
                      plugin: 'git-commit',
                      platform: 'codex',
                      scope: 'user',
                      projectKey: null,
                    },
                    declaration: {
                      name: 'git-commit',
                      target: {
                        scope: 'user',
                      },
                      inheritInstallOptions: true,
                      when: {
                        platforms: ['codex'],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    }, {
      requireDependencyMetadata: true,
    });

    expect(ledger?.plugins['workflow-pack']?.platforms.codex?.userScope?.dependencyEdges).toHaveLength(1);
  });

  it('rejects malformed lifecycle config snapshot metadata', () => {
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
                  lifecycleConfigSnapshot: {
                    snapshotRoot: '/aw/snapshot',
                    bundleRoot: '/aw/snapshot/bundle',
                    manifestPath: '/aw/snapshot/bundle/.agents-plugin/plugin.json',
                    pluginName: 'git-commit',
                    pluginVersion: '0.1.0',
                    sourceManifestDigest: 'sha256:manifest',
                    bundleFingerprint: 'sha256:bundle',
                    createdAt: '2026-04-25T00:00:00.000Z',
                    createdFrom: {
                      source: 'remote',
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toBeNull();
  });

  it('fails closed in strict mode when dependency metadata is missing', () => {
    const legacyLedger = validateInstalledLedger({
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

    expect(legacyLedger).not.toBeNull();
    expect(validateInstalledLedger(legacyLedger, { requireDependencyMetadata: true })).toBeNull();
    expect(hasInstalledLedgerDependencyMetadata(legacyLedger)).toBe(false);
  });

  it('rejects persisted dependents-style fields and malformed dependency locations', () => {
    expect(
      validateInstalledLedger({
        version: 1,
        ledgerState: {
          status: 'available',
          degradedAt: null,
          reason: null,
        },
        plugins: {
          'workflow-pack': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-05-06T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: true,
                  },
                  installSource: {
                    kind: 'explicit',
                    explicitlyRequested: true,
                    allowsUnusedCleanup: false,
                  },
                  dependencyEdges: [],
                  autoRemovable: true,
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
          'workflow-pack': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-05-06T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: true,
                  },
                  installSource: {
                    kind: 'explicit',
                    explicitlyRequested: true,
                    allowsUnusedCleanup: false,
                  },
                  dependencyEdges: [
                    {
                      dependency: {
                        plugin: 'git-commit',
                        platform: 'codex',
                        scope: 'user',
                        projectKey: '/should-not-exist',
                      },
                      declaration: {
                        name: 'git-commit',
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      }),
    ).toBeNull();
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

  it('derives Codex project scopeInitialized from managed ledger records only', () => {
    const availableLedger: InstalledLedger = {
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
              projectScopes: {
                '/repo/managed': {
                  managed: true,
                  updatedAt: '2026-04-25T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  projectKey: '/repo/managed',
                  capabilitySnapshot: {
                    requiresNativePlugin: false,
                    hasRepoManagedArtifacts: true,
                    projectManagedKinds: ['skill'],
                  },
                },
                '/repo/unmanaged': {
                  managed: false,
                  updatedAt: '2026-04-25T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  projectKey: '/repo/unmanaged',
                  capabilitySnapshot: {
                    requiresNativePlugin: false,
                    hasRepoManagedArtifacts: true,
                    projectManagedKinds: ['skill'],
                  },
                },
              },
              sharedNativeRefs: {
                user: false,
                projects: ['/repo/legacy-native-ref'],
              },
            },
          },
        },
      },
    };
    const degradedLedger: InstalledLedger = {
      version: 1,
      ledgerState: {
        status: 'degraded',
        degradedAt: '2026-04-25T00:00:00.000Z',
        reason: 'rebuilt_from_missing_or_invalid',
      },
      plugins: {
        'git-commit': {
          lastResolvedVersion: '0.1.0',
          platforms: {
            codex: {
              sharedNativeRefs: {
                user: false,
                projects: ['/repo/legacy-native-ref'],
              },
            },
          },
        },
      },
    };

    expect(resolveScopeInitialized(availableLedger, 'git-commit', 'codex', 'project', '/repo/managed')).toBe('yes');
    expect(resolveScopeInitialized(availableLedger, 'git-commit', 'codex', 'project', '/repo/unmanaged')).toBe('no');
    expect(resolveScopeInitialized(availableLedger, 'git-commit', 'codex', 'project', '/repo/legacy-native-ref')).toBe('no');
    expect(resolveScopeInitialized(degradedLedger, 'git-commit', 'codex', 'project', '/repo/legacy-native-ref')).toBe('unknown');
  });

  it('derives Codex project scopeInitialized from ledger, tracking, and external-only evidence', () => {
    const availableLedger: InstalledLedger = {
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
              projectScopes: {
                '/repo/managed': {
                  managed: true,
                  updatedAt: '2026-04-25T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  projectKey: '/repo/managed',
                  capabilitySnapshot: {
                    requiresNativePlugin: false,
                    hasRepoManagedArtifacts: true,
                    projectManagedKinds: ['skill'],
                  },
                },
              },
            },
          },
        },
      },
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

    expect(resolveCodexProjectScopeInitialized({
      ledger: availableLedger,
      pluginName: 'git-commit',
      projectKey: '/repo/managed',
      trackingIdentityComplete: false,
    })).toBe('yes');
    expect(resolveCodexProjectScopeInitialized({
      ledger: availableLedger,
      pluginName: 'git-commit',
      projectKey: '/repo/tracking-only',
      trackingArtifacts: [{
        path: '/repo/.agents/skills/commit',
        kind: 'skill',
        platform: 'codex',
        artifactKey: 'commit',
      }],
      trackingIdentityComplete: true,
    })).toBe('yes');
    expect(resolveCodexProjectScopeInitialized({
      ledger: availableLedger,
      pluginName: 'git-commit',
      projectKey: '/repo/external-only',
      trackingIdentityComplete: false,
      externalOwnershipPresent: true,
    })).toBe('no');
    expect(resolveCodexProjectScopeInitialized({
      ledger: availableLedger,
      pluginName: 'git-commit',
      projectKey: '/repo/unmanaged',
      trackingIdentityComplete: false,
    })).toBe('no');
    expect(resolveCodexProjectScopeInitialized({
      ledger: degradedLedger,
      pluginName: 'git-commit',
      projectKey: '/repo/degraded',
      trackingIdentityComplete: false,
    })).toBe('unknown');
    expect(resolveCodexProjectScopeInitialized({
      ledger: availableLedger,
      pluginName: 'git-commit',
      projectKey: '/repo/broken-tracking',
      trackingArtifacts: [{
        path: '/repo/.agents/skills/commit',
        kind: 'skill',
        platform: 'codex',
      }],
      trackingIdentityComplete: false,
    })).toBe('unknown');
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
