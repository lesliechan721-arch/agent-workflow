import { describe, expect, it } from 'vitest';

import {
  createPluginConsoleItems,
  createPluginConsoleLocationKey,
  type PluginConsoleAction,
  type PluginConsoleLocationDiagnostics,
  type PluginConsoleReasonCode,
} from '../../src/commands/console-model.js';
import type {
  StatusMatrixCell,
  StatusMatrixInstallState,
  StatusMatrixReport,
} from '../../src/commands/status.js';
import type {
  ManagedArtifactStatus,
  NativePluginStatus,
  PluginStatusReport,
  RepoManagedProjectItemReport,
  RepoManagedSessionStateReport,
  ScopeManagedEvidence,
} from '../../src/types.js';

const FORBIDDEN_PROSE_TERMS = [
  'ledger',
  '账本',
  'degraded',
  'healthSource',
  'repo-managed',
  'tracking',
  'scope',
  'app-server',
  'RPC',
  'pluginEnabled',
  'pluginInstalled',
  'active cache',
  'cacheStatus',
  'artifactRefresh',
  'refreshKeys',
  'configDigest',
  'contentDigest',
  'sessionVisibility',
  'projectTrust',
];

function native(overrides: Partial<NativePluginStatus> = {}): NativePluginStatus {
  return {
    marketplaceRegistered: false,
    pluginAvailable: true,
    pluginInstalled: false,
    pluginEnabled: false,
    cacheStatus: 'missing',
    ...overrides,
  };
}

function scopeManagedEvidence(overrides: Partial<ScopeManagedEvidence> = {}): ScopeManagedEvidence {
  return {
    ledger: false,
    tracking: false,
    sharedNativeRef: false,
    ...overrides,
  };
}

function repoManagedSessionState(
  overrides: Partial<RepoManagedSessionStateReport> = {},
): RepoManagedSessionStateReport {
  return {
    instructions: 'not_applicable',
    rules: 'not_applicable',
    hooks: 'not_applicable',
    agents: 'not_applicable',
    diagnostics: [],
    items: [],
    ...overrides,
  };
}

function managedArtifact(overrides: Partial<ManagedArtifactStatus> = {}): ManagedArtifactStatus {
  return {
    path: '/workspace/.codex/agents/demo.toml',
    exists: true,
    kind: 'agent',
    tracked: true,
    health: 'healthy',
    sessionVisibility: 'visible',
    diagnostics: [],
    target: 'codex.agentRole',
    id: 'demo-role',
    roleKey: 'demo',
    ...overrides,
  };
}

function repoItem(overrides: Partial<RepoManagedProjectItemReport> = {}): RepoManagedProjectItemReport {
  return {
    kind: 'skill',
    path: '/workspace/.agents/skills/demo',
    tracked: true,
    exists: true,
    state: 'visible',
    drift: 'no',
    diagnostics: [],
    artifactKey: 'demo',
    ...overrides,
  };
}

function report(overrides: Partial<PluginStatusReport> & {
  native?: Partial<NativePluginStatus>;
  scopeManagedEvidence?: Partial<ScopeManagedEvidence>;
  repoManagedSessionState?: Partial<RepoManagedSessionStateReport>;
  currentCatalog?: PluginStatusReport['currentCatalog'] | null;
} = {}): PluginStatusReport {
  return {
    pluginName: 'demo-plugin',
    native: native(overrides.native),
    generatedArtifacts: overrides.generatedArtifacts ?? [],
    managedArtifacts: overrides.managedArtifacts ?? [],
    driftWarnings: overrides.driftWarnings ?? [],
    ledgerStateStatus: overrides.ledgerStateStatus ?? 'available',
    ledgerStateReason: overrides.ledgerStateReason ?? null,
    scopeInitialized: overrides.scopeInitialized ?? 'no',
    catalogCompatibility: overrides.catalogCompatibility,
    externalOwnership: overrides.externalOwnership ?? { present: false, checkState: 'known' },
    projectTrust: overrides.projectTrust ?? 'not_applicable',
    platformRuntimeEvidence: overrides.platformRuntimeEvidence,
    platformNativeFallbackEvidence: overrides.platformNativeFallbackEvidence,
    scopeManagedEvidence: scopeManagedEvidence(overrides.scopeManagedEvidence),
    repoManagedSessionState: repoManagedSessionState(overrides.repoManagedSessionState),
    currentCatalog: overrides.currentCatalog === undefined
      ? {
          rootDir: '/catalog/demo-plugin',
          source: 'local',
          available: true,
        }
      : overrides.currentCatalog ?? undefined,
    activeLocalBundle: overrides.activeLocalBundle,
    artifactsInitialized: overrides.artifactsInitialized ?? true,
    installOptions: overrides.installOptions,
    skillTriggerApplicability: overrides.skillTriggerApplicability,
    skillTriggerPreference: overrides.skillTriggerPreference,
    skillTriggerRuntimeMatches: overrides.skillTriggerRuntimeMatches,
    skillTriggerRuntimeState: overrides.skillTriggerRuntimeState,
    skillTriggerDrift: overrides.skillTriggerDrift,
    projectManagedKinds: overrides.projectManagedKinds,
    dependencies: overrides.dependencies,
  };
}

function cell(overrides: Partial<StatusMatrixCell> = {}): StatusMatrixCell {
  return {
    pluginName: 'demo-plugin',
    platform: 'codex',
    scope: 'user',
    executionCwd: '/workspace',
    health: 'ready',
    evidenceSources: [],
    healthSource: 'currentCatalog',
    config: 'configured',
    scripts: 'declared',
    report: report(),
    ...overrides,
  };
}

function installState(overrides: Partial<StatusMatrixInstallState> = {}): StatusMatrixInstallState {
  return {
    kind: 'installed',
    summary: '当前安装状态正常。',
    nextSteps: [],
    findings: [],
    issueCodes: [],
    autoInstalled: false,
    unusedDependencyHint: false,
    dependents: [],
    repairAvailable: true,
    cleanupAvailable: false,
    adoptExistingAvailable: false,
    currentCatalogAvailable: true,
    catalogDrift: false,
    upgradeAvailable: false,
    dynamicDiagnosticUnavailable: false,
    nativeTransactionKind: 'none',
    sharedRuntimeOwnerPresent: false,
    sharedRuntimeNeedsTakeover: false,
    sharedRuntimeParticipatesInOwner: false,
    sharedRuntimeSemanticDelta: 'noChange',
    sharedRuntimeOwnerConflict: false,
    ...overrides,
  };
}

function matrix(cells: StatusMatrixCell[]): StatusMatrixReport {
  return {
    detection: {
      codex: { available: true, scopes: ['user', 'project'] },
      claude: { available: true, scopes: ['user', 'project'] },
    },
    filters: {},
    health: 'ready',
    summaries: [],
    cells,
    reports: [],
  };
}

function singleItem(
  inputCell: StatusMatrixCell,
  locationDiagnosticsByKey?: Record<string, PluginConsoleLocationDiagnostics>,
) {
  const items = createPluginConsoleItems(matrix([inputCell]), {
    locationDiagnosticsByKey,
  });
  expect(items).toHaveLength(1);
  return items[0];
}

function sanitizeAndAssertProse(item: ReturnType<typeof singleItem>): void {
  const prose = [
    item.issueSummary ?? '',
    ...(item.detailHints ?? []),
    ...item.nextSteps,
    ...item.locations.flatMap((location) => [
      location.issueSummary ?? '',
      ...(location.detailHints ?? []),
      ...location.nextSteps,
    ]),
  ].join('\n');

  for (const term of FORBIDDEN_PROSE_TERMS) {
    expect(prose).not.toContain(term);
  }
}

function writeActions(actions: PluginConsoleAction[]): PluginConsoleAction[] {
  return actions.filter((action) =>
    action.kind === 'runInstall' ||
    action.kind === 'runUpgrade' ||
    action.kind === 'runUninstall' ||
    action.kind === 'repairInstall' ||
    action.kind === 'cleanupRecovery' ||
    action.kind === 'reapplyConfigRefresh',
  );
}

function actionKinds(actions: PluginConsoleAction[]): string[] {
  return actions.map((action) => action.kind);
}

function reasonFixture(reason: PluginConsoleReasonCode): StatusMatrixCell {
  switch (reason) {
    case 'nativeIncomplete':
      return cell({
        report: report({
          native: {
            requiresNativePlugin: true,
            recovery: {
              present: true,
              state: 'pending_after_native_write',
              reason: 'pending',
              evidenceMatches: true,
              suggestion: null,
            },
          },
        }),
      });
    case 'nativeResidue':
      return cell({
        report: report({
          native: {
            requiresNativePlugin: true,
            pluginInstalled: true,
            pluginEnabled: false,
          },
        }),
      });
    case 'missingRecord':
      return cell({
        report: report({
          native: {
            requiresNativePlugin: true,
            pluginInstalled: true,
            pluginEnabled: true,
          },
          scopeManagedEvidence: { ledger: false },
        }),
      });
    case 'upgradeEvidenceUnknown':
      return cell({
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
        }),
      });
    case 'artifactRefreshFailed':
      return cell({
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true, tracking: true },
          managedArtifacts: [
            managedArtifact({
              health: 'recentRefreshFailed',
              diagnostics: ['recent refresh failed'],
            }),
          ],
        }),
      });
    case 'artifactDrift':
      return cell({
        scope: 'project',
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true, tracking: true },
          managedArtifacts: [
            managedArtifact({
              health: 'contentDrift',
              diagnostics: ['content drift'],
            }),
          ],
        }),
      });
    case 'projectVisibilityBlocked':
      return cell({
        scope: 'project',
        projectKey: '/workspace',
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true, tracking: true },
          projectTrust: 'untrusted',
          repoManagedSessionState: {
            items: [repoItem({ state: 'blockedByProjectTrust' })],
          },
        }),
      });
    case 'sessionVisibilityLimited':
      return cell({
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
          managedArtifacts: [
            managedArtifact({
              sessionVisibility: 'shadowedByProjectDeveloperInstructions',
            }),
          ],
        }),
      });
    case 'externalOwnership':
      return cell({
        report: report({
          currentCatalog: {
            rootDir: '/catalog/demo-plugin',
            source: 'local',
            available: true,
          },
          externalOwnership: {
            present: true,
            checkState: 'known',
          },
        }),
      });
    case 'requiredConfigMissing':
      return cell({
        config: 'missing-required',
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
        }),
      });
    case 'invalidConfig':
      return cell({
        config: 'invalid-config',
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
        }),
      });
    case 'unreadableConfig':
      return cell({
        error: 'Invalid plugin config store "/tmp/plugin-config/demo/config.json": expected a JSON object.',
      });
    case 'trackingIdentityBroken':
      return cell({
        scope: 'project',
        projectKey: '/workspace',
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { tracking: true },
          repoManagedSessionState: {
            items: [repoItem({ state: 'unknown', diagnostics: ['tracking manifest 缺少 artifactKey'] })],
          },
        }),
      });
    case 'roleOrMcpConflict':
      return cell({
        scope: 'project',
        projectKey: '/workspace',
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true, tracking: true },
          managedArtifacts: [
            managedArtifact({
              health: 'registrationDrift',
              diagnostics: ['Codex role "demo" 已存在非 AW managed registration。'],
            }),
          ],
        }),
      });
    case 'unmanagedArtifactConflict':
      return cell({
        scope: 'project',
        projectKey: '/workspace',
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { tracking: true },
          repoManagedSessionState: {
            items: [repoItem({ state: 'orphan', diagnostics: ['当前插件没有 tracking 证明归属'] })],
          },
        }),
      });
    case 'catalogCapabilityChanged':
      return cell({
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
          catalogCompatibility: 'capabilityChanged',
        }),
      });
    case 'catalogUnavailable':
      return cell({
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
          currentCatalog: {
            rootDir: '/catalog/demo-plugin',
            source: 'embedded',
            available: false,
            reason: 'plugin missing from current catalog',
          },
          catalogCompatibility: 'missing',
        }),
      });
  }
}

describe('console-model', () => {
  it('covers the six friendly top-level statuses', () => {
    const notInstalled = singleItem(cell({
      report: report({
        currentCatalog: {
          rootDir: '/catalog/demo-plugin',
          source: 'local',
          available: true,
        },
      }),
    }));
    const installed = singleItem(cell({
      platform: 'claude',
      report: report({
        native: native(),
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true },
        currentCatalog: {
          rootDir: '/catalog/demo-plugin',
          source: 'local',
          available: true,
        },
      }),
    }));
    const upgradeCell = cell({
      platform: 'claude',
      report: report({
        native: native(),
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true },
      }),
    });
    const upgradeAvailable = singleItem(upgradeCell, {
      [createPluginConsoleLocationKey(upgradeCell)]: { upgradeState: 'available' },
    });
    const needsAction = singleItem(reasonFixture('requiredConfigMissing'));
    const partial = singleItem(reasonFixture('sessionVisibilityLimited'));
    const external = singleItem(reasonFixture('externalOwnership'));

    expect(notInstalled.status).toBe('notInstalled');
    expect(installed.status).toBe('installed');
    expect(upgradeAvailable.status).toBe('upgradeAvailable');
    expect(needsAction.status).toBe('needsAction');
    expect(partial.status).toBe('partial');
    expect(external.status).toBe('external');

    expect(notInstalled.statusLabel).toBe('未安装');
    expect(installed.statusLabel).toBe('已安装');
    expect(upgradeAvailable.statusLabel).toBe('可升级');
    expect(needsAction.statusLabel).toBe('需要处理');
    expect(partial.statusLabel).toBe('部分可用');
    expect(external.statusLabel).toBe('由其它来源管理');
  });

  it('keeps not-installed and external location actions narrow', () => {
    const notInstalled = singleItem(cell({
      report: report({
        currentCatalog: {
          rootDir: '/catalog/demo-plugin',
          source: 'local',
          available: true,
        },
      }),
    }));
    const external = singleItem(reasonFixture('externalOwnership'));

    expect(actionKinds(notInstalled.locations[0].actions)).toEqual(['openInstallWizard']);
    expect(actionKinds(external.locations[0].actions)).toEqual([]);
  });

  it('maps every required reason code and keeps friendly prose clean', () => {
    const upgradeCell = reasonFixture('upgradeEvidenceUnknown');
    const diagnostics: Record<string, PluginConsoleLocationDiagnostics> = {
      [createPluginConsoleLocationKey(upgradeCell)]: { upgradeState: 'unknown' },
    };

    const cases: PluginConsoleReasonCode[] = [
      'nativeIncomplete',
      'nativeResidue',
      'missingRecord',
      'upgradeEvidenceUnknown',
      'artifactRefreshFailed',
      'artifactDrift',
      'projectVisibilityBlocked',
      'sessionVisibilityLimited',
      'externalOwnership',
      'requiredConfigMissing',
      'invalidConfig',
      'unreadableConfig',
      'trackingIdentityBroken',
      'roleOrMcpConflict',
      'unmanagedArtifactConflict',
      'catalogCapabilityChanged',
      'catalogUnavailable',
    ];

    for (const reason of cases) {
      const fixture = reason === 'upgradeEvidenceUnknown' ? upgradeCell : reasonFixture(reason);
      const item = singleItem(
        fixture,
        reason === 'upgradeEvidenceUnknown' ? diagnostics : undefined,
      );
      expect(item.locations[0].reasonCodes).toContain(reason);
      sanitizeAndAssertProse(item);
    }
  });

  it('applies cross-location summary and status priority', () => {
    const items = createPluginConsoleItems(matrix([
      cell({
        platform: 'codex',
        scope: 'user',
        report: report({
          native: {
            requiresNativePlugin: true,
            pluginInstalled: true,
            pluginEnabled: true,
          },
          scopeManagedEvidence: { ledger: false },
        }),
      }),
      cell({
        platform: 'claude',
        scope: 'project',
        projectKey: '/workspace',
        report: report({
          native: native(),
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true, tracking: true },
        }),
      }),
    ]));

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('needsAction');
    expect(items[0].locationSummary).toBe('多个位置');
    expect(items[0].actions).toEqual([]);
    expect(items[0].locations.map((location) => location.locationLabel)).toEqual([
      'Codex（个人）',
      'Claude Code（当前项目）',
    ]);
  });

  it('keeps upgrade checks conservative', () => {
    const healthyCell = cell({
      platform: 'claude',
      report: report({
        native: native(),
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true },
      }),
    });
    const driftedCell = cell({
      platform: 'claude',
      report: report({
        native: native(),
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true, tracking: true },
        managedArtifacts: [managedArtifact({ health: 'contentDrift', diagnostics: ['content drift'] })],
      }),
    });
    const unavailableCell = cell({
      platform: 'claude',
      report: report({
        native: native(),
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true },
        currentCatalog: {
          rootDir: '/catalog/demo-plugin',
          source: 'embedded',
          available: false,
          reason: 'missing',
        },
      }),
    });

    const healthyItem = singleItem(healthyCell, {
      [createPluginConsoleLocationKey(healthyCell)]: { upgradeState: 'available' },
    });
    const driftedItem = singleItem(driftedCell, {
      [createPluginConsoleLocationKey(driftedCell)]: { upgradeState: 'available' },
    });
    const unavailableItem = singleItem(unavailableCell, {
      [createPluginConsoleLocationKey(unavailableCell)]: { upgradeState: 'available' },
    });

    expect(healthyItem.status).toBe('upgradeAvailable');
    expect(driftedItem.status).toBe('needsAction');
    expect(unavailableItem.status).toBe('installed');
    expect(unavailableItem.locations[0].reasonCodes).toContain('catalogUnavailable');
  });

  it('handles Codex native enabled-only, cache-only, breadcrumb-only, missing record and unowned residue', () => {
    const enabledOnly = singleItem(cell({
      report: report({
        native: {
          requiresNativePlugin: true,
          pluginInstalled: false,
          pluginEnabled: true,
        },
      }),
    }));
    const cacheOnly = singleItem(cell({
      report: report({
        native: {
          requiresNativePlugin: true,
          pluginInstalled: true,
          pluginEnabled: false,
        },
      }),
    }));
    const breadcrumbOnly = singleItem(cell({
      report: report({
        native: {
          requiresNativePlugin: true,
          recovery: {
            present: true,
            state: 'cleanup_failed',
            reason: 'cleanup failed',
            evidenceMatches: true,
            suggestion: null,
          },
        },
      }),
    }));
    const missingRecord = singleItem(reasonFixture('missingRecord'));
    const nativeResidue = singleItem(reasonFixture('nativeResidue'));

    expect(enabledOnly.status).toBe('needsAction');
    expect(enabledOnly.locations[0].reasonCodes).toContain('nativeResidue');
    expect(cacheOnly.status).toBe('needsAction');
    expect(cacheOnly.locations[0].reasonCodes).toContain('nativeResidue');
    expect(breadcrumbOnly.locations[0].reasonCodes).toContain('nativeIncomplete');
    expect(breadcrumbOnly.locations[0].actions.map((action) => action.kind)).toContain('cleanupRecovery');
    expect(missingRecord.locations[0].reasonCodes).toContain('missingRecord');
    expect(nativeResidue.locations[0].actions.map((action) => action.kind)).not.toContain('cleanupRecovery');
  });

  it('maps dynamic artifact refresh failure, drift, missing and ignores disabled-by-config', () => {
    const refreshFailed = singleItem(reasonFixture('artifactRefreshFailed'));
    const drifted = singleItem(reasonFixture('artifactDrift'));
    const missing = singleItem(cell({
      scope: 'project',
      report: report({
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true, tracking: true },
        generatedArtifacts: [
          {
            path: '/workspace/.agents/skills/demo',
            exists: false,
            kind: 'skill',
          },
        ],
      }),
    }));
    const disabledByConfig = singleItem(cell({
      scope: 'project',
      report: report({
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true, tracking: true },
        managedArtifacts: [
          managedArtifact({
            health: 'disabledByConfig',
            sessionVisibility: 'absent',
            disabledReason: 'config',
          }),
        ],
      }),
    }));

    expect(refreshFailed.locations[0].reasonCodes).toContain('artifactRefreshFailed');
    expect(refreshFailed.locations[0].actions.map((action) => action.kind)).toContain('reapplyConfigRefresh');
    expect(drifted.locations[0].reasonCodes).toContain('artifactDrift');
    expect(drifted.locations[0].actions.find((action) => action.kind === 'repairInstall')?.label).toBe('重新安装/升级');
    expect(missing.locations[0].reasonCodes).toContain('artifactDrift');
    expect(disabledByConfig.status).toBe('installed');
    expect(disabledByConfig.locations[0].reasonCodes).not.toContain('artifactDrift');
  });

  it('maps project trust and session visibility to partial', () => {
    const trustUnknown = singleItem(cell({
      scope: 'project',
      projectKey: '/workspace',
      report: report({
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true, tracking: true },
        projectTrust: 'unknown',
        repoManagedSessionState: {
          items: [repoItem({ state: 'projectTrustUnknown' })],
        },
      }),
    }));
    const externalLayer = singleItem(cell({
      report: report({
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true },
        managedArtifacts: [
          managedArtifact({
            sessionVisibility: 'unknownByExternalLayer',
          }),
        ],
      }),
    }));

    expect(trustUnknown.status).toBe('partial');
    expect(trustUnknown.locations[0].reasonCodes).toContain('projectVisibilityBlocked');
    expect(externalLayer.status).toBe('partial');
    expect(externalLayer.locations[0].reasonCodes).toContain('sessionVisibilityLimited');
  });

  it('treats pure external ownership differently from external conflict', () => {
    const pureExternal = singleItem(reasonFixture('externalOwnership'));
    const conflict = singleItem(cell({
      report: report({
        externalOwnership: { present: true, checkState: 'known' },
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true },
      }),
    }));

    expect(pureExternal.status).toBe('external');
    expect(conflict.status).toBe('needsAction');
    expect(conflict.locations[0].reasonCodes).toContain('externalOwnership');
  });

  it('covers the three catalogUnavailable scenarios and hides config/upgrade actions', () => {
    const cases = [
      cell({
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
          currentCatalog: null,
        }),
      }),
      cell({
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
          currentCatalog: {
            rootDir: '/catalog/demo-plugin',
            source: 'embedded',
            available: false,
            reason: 'parse failed',
          },
        }),
      }),
      cell({
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
          currentCatalog: {
            rootDir: '/catalog/demo-plugin',
            source: 'local',
            available: false,
            reason: 'plugin removed',
          },
          catalogCompatibility: 'missing',
        }),
      }),
    ];

    for (const fixture of cases) {
      const item = singleItem(fixture);
      expect(item.locations[0].reasonCodes).toContain('catalogUnavailable');
      expect(item.locations[0].actions.map((action) => action.kind)).not.toContain('runUpgrade');
      expect(item.locations[0].actions.map((action) => action.kind)).not.toContain('openConfigWizard');
      expect(item.locations[0].actions.map((action) => action.kind)).toContain('runUninstall');
      expect(item.locations[0].actions.map((action) => action.kind)).toContain('diagnoseCommand');
    }
  });

  it('surfaces dependency reasons without turning catalog drift into a hard failure', () => {
    const dependencyMissing = singleItem(cell({
      report: report({
        native: native({
          pluginInstalled: true,
          pluginEnabled: true,
        }),
        generatedArtifacts: [{ path: '/workspace/.agents/skills/demo', exists: true, kind: 'skill', platform: 'codex' }],
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true, tracking: true },
        dependencies: {
          healthSource: 'currentCatalog',
          declared: [{ name: 'helper-plugin' }],
          resolved: [{ declaration: { name: 'helper-plugin' }, source: 'currentCatalog' }],
          satisfied: [],
          missing: [{ declaration: { name: 'helper-plugin' }, reason: 'missing helper' }],
          dependents: [],
          autoInstalled: false,
          autoRemovable: false,
          catalogDrift: {
            kind: 'snapshotMissing',
            snapshotDependencies: [],
            currentDependencies: ['helper-plugin'],
          },
        },
      }),
    }));
    const autoRemovable = singleItem(cell({
      report: report({
        native: native({
          pluginInstalled: true,
          pluginEnabled: true,
        }),
        generatedArtifacts: [{ path: '/workspace/.agents/skills/demo', exists: true, kind: 'skill', platform: 'codex' }],
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true, tracking: true },
        dependencies: {
          healthSource: 'installSnapshot',
          declared: [],
          resolved: [],
          satisfied: [],
          missing: [],
          dependents: [],
          autoInstalled: true,
          autoRemovable: true,
          catalogDrift: {
            kind: 'none',
            snapshotDependencies: [],
            currentDependencies: [],
          },
        },
      }),
    }));
    const protectedDependency = singleItem(cell({
      report: report({
        native: native({
          pluginInstalled: true,
          pluginEnabled: true,
        }),
        generatedArtifacts: [{ path: '/workspace/.agents/skills/demo', exists: true, kind: 'skill', platform: 'codex' }],
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true, tracking: true },
        dependencies: {
          healthSource: 'installSnapshot',
          declared: [],
          resolved: [],
          satisfied: [],
          missing: [],
          dependents: [{ plugin: 'parent-plugin', platform: 'codex', scope: 'user', projectKey: null }],
          autoInstalled: true,
          autoRemovable: false,
          catalogDrift: {
            kind: 'none',
            snapshotDependencies: [],
            currentDependencies: [],
          },
        },
      }),
    }));

    expect(dependencyMissing.status).toBe('needsAction');
    expect(dependencyMissing.locations[0].reasonCodes).toContain('dependencyMissing');
    expect(dependencyMissing.locations[0].actions.find((action) => action.kind === 'repairInstall')?.label).toBe('补齐依赖');

    expect(autoRemovable.status).toBe('installed');
    expect(autoRemovable.locations[0].reasonCodes).toContain('autoDependencyRemovable');
    expect(autoRemovable.locations[0].actions.find((action) => action.kind === 'runUninstall')?.label).toBe('清理自动依赖');

    const protectedAction = protectedDependency.locations[0].actions.find((action) => action.kind === 'runUninstall');
    expect(protectedDependency.status).toBe('installed');
    expect(protectedDependency.locations[0].reasonCodes).toContain('dependencyProtected');
    expect(protectedAction?.disabledReason).toContain('暂时不能直接卸载');

    sanitizeAndAssertProse(dependencyMissing);
    sanitizeAndAssertProse(autoRemovable);
    sanitizeAndAssertProse(protectedDependency);
  });

  it('maps adopt-existing and owner conflict actions from install-state projection', () => {
    const adoptable = singleItem(cell({
      scope: 'project',
      projectKey: '/workspace',
      installState: installState({
        kind: 'adoptable',
        summary: '发现了一份可认领的已有项目安装。',
        nextSteps: ['aw repair demo-plugin --platform codex --scope project --adopt-existing'],
        adoptExistingAvailable: true,
      }),
      report: undefined,
    }));
    const ownerConflict = singleItem(cell({
      installState: installState({
        kind: 'needsRepair',
        summary: '共享触发策略当前由另一个安装位置控制。',
        nextSteps: ['aw repair demo-plugin --platform codex --scope user --takeover-shared-runtime'],
        issueCodes: ['artifactMissing'],
        sharedRuntimeOwnerPresent: true,
        sharedRuntimeNeedsTakeover: true,
        sharedRuntimeParticipatesInOwner: true,
        sharedRuntimeSemanticDelta: 'change',
        sharedRuntimeOwnerConflict: true,
      }),
      report: undefined,
    }));

    expect(adoptable.status).toBe('needsAction');
    expect(adoptable.locations[0].reasonCodes).toContain('adoptExisting');
    expect(adoptable.locations[0].actions.find((entry) => entry.label === '认领现有安装')?.command).toEqual([
      'aw',
      'repair',
      'demo-plugin',
      '--platform',
      'codex',
      '--scope',
      'project',
      '--adopt-existing',
    ]);

    expect(ownerConflict.locations[0].reasonCodes).toContain('ownerConflict');
    expect(ownerConflict.locations[0].actions.find((entry) => entry.label === '接管共享触发策略')?.command).toEqual([
      'aw',
      'repair',
      'demo-plugin',
      '--platform',
      'codex',
      '--scope',
      'user',
      '--takeover-shared-runtime',
    ]);
    expect(ownerConflict.locations[0].actions.map((entry) => entry.kind)).not.toContain('repairInstall');
  });

  it('suppresses owner conflict for Codex project repo-local trigger locations', () => {
    const item = singleItem(cell({
      scope: 'project',
      projectKey: '/workspace',
      installState: installState({
        kind: 'adoptable',
        summary: '发现了一份可认领的已有项目安装。',
        nextSteps: ['aw repair demo-plugin --platform codex --scope project --adopt-existing'],
        adoptExistingAvailable: true,
        sharedRuntimeOwnerPresent: true,
        sharedRuntimeNeedsTakeover: true,
        sharedRuntimeParticipatesInOwner: false,
        sharedRuntimeSemanticDelta: 'noChange',
        sharedRuntimeOwnerConflict: false,
      }),
      report: undefined,
    }));

    expect(item.locations[0].reasonCodes).toContain('adoptExisting');
    expect(item.locations[0].reasonCodes).not.toContain('ownerConflict');
    expect(item.locations[0].actions.find((entry) => entry.label === '认领现有安装')?.command).toEqual([
      'aw',
      'repair',
      'demo-plugin',
      '--platform',
      'codex',
      '--scope',
      'project',
      '--adopt-existing',
    ]);
  });

  it('distinguishes retained auto dependencies from unused cleanup suggestions in install-state projection', () => {
    const removable = singleItem(cell({
      installState: installState({
        summary: '这个自动依赖目前已经闲置。',
        findings: ['这个目标是自动装上的依赖，现在看起来已经没人再依赖它了。'],
        autoInstalled: true,
        unusedDependencyHint: true,
      }),
      report: undefined,
    }));
    const retained = singleItem(cell({
      installState: installState({
        summary: '当前安装状态正常。',
        autoInstalled: true,
        unusedDependencyHint: false,
      }),
      report: undefined,
    }));

    expect(removable.locations[0].reasonCodes).toContain('autoDependencyRemovable');
    expect(removable.locations[0].actions.find((entry) => entry.kind === 'runUninstall')?.label).toBe('清理自动依赖');
    expect(retained.locations[0].reasonCodes).not.toContain('autoDependencyRemovable');
    expect(retained.locations[0].actions.find((entry) => entry.kind === 'runUninstall')?.label).toBe('卸载');
    expect(retained.locations[0].detailHints).toEqual(
      expect.arrayContaining(['这个位置最初由依赖自动安装，但当前仍被显式保留或还有可信引用。']),
    );
  });

  it('keeps dependency-protected uninstall disabled in install-state projection', () => {
    const item = singleItem(cell({
      installState: installState({
        dependents: [{
          plugin: 'parent-plugin',
          platform: 'codex',
          scope: 'user',
        }],
      }),
      report: undefined,
    }));

    expect(item.locations[0].reasonCodes).toContain('dependencyProtected');
    expect(item.locations[0].actions.find((entry) => entry.kind === 'runUninstall')?.disabledReason).toContain(
      'parent-plugin (codex/user)',
    );
  });

  it('does not offer residual cleanup when dependency protection already blocks removal', () => {
    const item = singleItem(cell({
      installState: installState({
        kind: 'residual',
        summary: '发现残留文件或本机状态，但当前还有其它安装在依赖它，不能直接清理。',
        dependents: [{
          plugin: 'parent-plugin',
          platform: 'codex',
          scope: 'project',
          projectKey: '/workspace',
        }],
        cleanupAvailable: false,
      }),
      report: undefined,
    }));

    expect(item.locations[0].reasonCodes).toEqual(expect.arrayContaining(['nativeResidue', 'dependencyProtected']));
    expect(item.locations[0].actions.map((action) => action.label)).not.toContain('清理残留');
  });

  it('enforces the action contract', () => {
    const disabledInstallCell = cell({
      disabledReason: '当前项目暂时不能安装这个插件。',
      report: report({
        currentCatalog: {
          rootDir: '/catalog/demo-plugin',
          source: 'local',
          available: true,
        },
      }),
    });
    const multiLocationItems = createPluginConsoleItems(matrix([
      disabledInstallCell,
      cell({
        platform: 'claude',
        scope: 'project',
        projectKey: '/workspace',
        report: report({
          native: native(),
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
        }),
      }),
    ]));
    const singleLocation = singleItem(reasonFixture('nativeIncomplete'));
    const disabledInstall = singleItem(disabledInstallCell);

    for (const item of multiLocationItems) {
      expect(writeActions(item.actions)).toEqual([]);
      for (const location of item.locations) {
        for (const entry of writeActions(location.actions)) {
          expect(entry.target).toBeDefined();
        }
      }
    }

    const destructiveActions = singleLocation.locations[0].actions.filter((action) => action.destructive);
    expect(destructiveActions.length).toBeGreaterThan(0);
    for (const entry of destructiveActions) {
      expect(entry.confirmText).toBeTruthy();
    }

    const disabledAction = disabledInstall.locations[0].actions.find((action) => action.disabledReason);
    expect(disabledAction?.disabledReason).toBe('当前项目暂时不能安装这个插件。');
  });

  it('allows technical identifiers in commands while keeping prose clean', () => {
    const item = singleItem(reasonFixture('catalogUnavailable'));
    const diagnoseAction = item.locations[0].actions.find((action) => action.kind === 'diagnoseCommand');

    expect(diagnoseAction?.command).toEqual([
      'aw',
      'status',
      'demo-plugin',
      '--platform',
      'codex',
      '--scope',
      'user',
      '--verbose',
    ]);
    sanitizeAndAssertProse(item);
  });
});
