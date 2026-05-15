import { describe, expect, it } from 'vitest';

import {
  createConsolePluginDetailPageModel,
  createConsoleControllerItems,
  createPluginConsoleExecutableActions,
  createPluginConsoleItems,
  createPluginConsoleLocationKey,
  resolvePluginConsoleMeta,
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
  PluginMeta,
  PluginStatusReport,
  RepoManagedProjectItemReport,
  RepoManagedSessionStateReport,
  ScopeManagedEvidence,
} from '../../src/types.js';

const FORBIDDEN_PUBLIC_KEYS = [
  'statusIcon',
  'statusTone',
  'platformBadges',
  'primaryActionLabel',
  'actions',
  'target',
  'command',
  'confirmText',
  'availableTargets',
  'targetOptions',
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

function singleSummary(
  inputCell: StatusMatrixCell,
  locationDiagnosticsByKey?: Record<string, PluginConsoleLocationDiagnostics>,
) {
  const items = createPluginConsoleItems(matrix([inputCell]), {
    locationDiagnosticsByKey,
  });
  expect(items).toHaveLength(1);
  return items[0]!;
}

function singleController(
  inputCell: StatusMatrixCell,
  locationDiagnosticsByKey?: Record<string, PluginConsoleLocationDiagnostics>,
) {
  const items = createConsoleControllerItems(matrix([inputCell]), {
    locationDiagnosticsByKey,
  });
  expect(items).toHaveLength(1);
  return items[0]!;
}

type ReasonFixtureName =
  | 'nativeIncomplete'
  | 'nativeResidue'
  | 'missingRecord'
  | 'upgradeEvidenceUnknown'
  | 'artifactRefreshFailed'
  | 'artifactDrift'
  | 'projectVisibilityBlocked'
  | 'sessionVisibilityLimited'
  | 'externalOwnership'
  | 'requiredConfigMissing'
  | 'invalidConfig'
  | 'unreadableConfig'
  | 'trackingIdentityBroken'
  | 'roleOrMcpConflict'
  | 'unmanagedArtifactConflict'
  | 'catalogCapabilityChanged'
  | 'catalogUnavailable';

function reasonFixture(reason: ReasonFixtureName): StatusMatrixCell {
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
  it('exports V2 summary statuses and keeps public shape clean', () => {
    const notInstalled = singleSummary(cell({
      report: report({
        currentCatalog: {
          rootDir: '/catalog/demo-plugin',
          source: 'local',
          available: true,
        },
      }),
    }));
    const installed = singleSummary(cell({
      platform: 'claude',
      report: report({
        native: native(),
        scopeInitialized: 'yes',
        scopeManagedEvidence: { ledger: true },
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
    const upgradeAvailable = singleSummary(upgradeCell, {
      [createPluginConsoleLocationKey(upgradeCell)]: { upgradeState: 'available' },
    });
    const abnormal = singleSummary(reasonFixture('requiredConfigMissing'));

    expect(notInstalled.status).toBe('notInstalled');
    expect(installed.status).toBe('installed');
    expect(upgradeAvailable.status).toBe('upgradeAvailable');
    expect(abnormal.status).toBe('abnormal');

    expect(notInstalled.features.map((feature) => feature.kind)).toContain('install');
    expect(installed.features.map((feature) => feature.kind)).toContain('uninstall');
    expect(upgradeAvailable.features.map((feature) => feature.kind)).toContain('upgrade');
    expect(abnormal.features.map((feature) => feature.kind)).toContain('configure');

    const serialized = JSON.parse(JSON.stringify(abnormal)) as Record<string, unknown>;
    for (const key of FORBIDDEN_PUBLIC_KEYS) {
      expect(serialized).not.toHaveProperty(key);
    }
    expect(serialized).toHaveProperty('installedLocations');
    expect(serialized).toHaveProperty('features');
  });

  it('maps V2 reason codes and never leaks old ids in summaries', () => {
    const upgradeCell = reasonFixture('upgradeEvidenceUnknown');
    const diagnostics: Record<string, PluginConsoleLocationDiagnostics> = {
      [createPluginConsoleLocationKey(upgradeCell)]: { upgradeState: 'unknown' },
    };
    const cases: Array<{ fixture: ReasonFixtureName; expected: PluginConsoleReasonCode | null }> = [
      { fixture: 'nativeIncomplete', expected: 'nativeIncomplete' },
      { fixture: 'nativeResidue', expected: 'residueDetected' },
      { fixture: 'missingRecord', expected: 'recordCorrupted' },
      { fixture: 'upgradeEvidenceUnknown', expected: null },
      { fixture: 'artifactRefreshFailed', expected: 'artifactRefreshFailed' },
      { fixture: 'artifactDrift', expected: 'artifactRefreshFailed' },
      { fixture: 'projectVisibilityBlocked', expected: 'foreignOwnershipConflict' },
      { fixture: 'sessionVisibilityLimited', expected: 'foreignOwnershipConflict' },
      { fixture: 'externalOwnership', expected: 'foreignOwnershipConflict' },
      { fixture: 'requiredConfigMissing', expected: 'missingRequiredConfig' },
      { fixture: 'invalidConfig', expected: 'missingRequiredConfig' },
      { fixture: 'unreadableConfig', expected: 'missingRequiredConfig' },
      { fixture: 'trackingIdentityBroken', expected: 'recordCorrupted' },
      { fixture: 'roleOrMcpConflict', expected: 'foreignOwnershipConflict' },
      { fixture: 'unmanagedArtifactConflict', expected: 'foreignOwnershipConflict' },
      { fixture: 'catalogCapabilityChanged', expected: 'recordCorrupted' },
      { fixture: 'catalogUnavailable', expected: null },
    ];

    const forbiddenLegacyCodes = [
      'missingRecord',
      'adoptExisting',
      'ownerConflict',
      'dependencyProtected',
      'requiredConfigMissing',
      'invalidConfig',
      'unreadableConfig',
      'nativeResidue',
      'artifactDrift',
    ];

    for (const entry of cases) {
      const fixture = entry.fixture === 'upgradeEvidenceUnknown' ? upgradeCell : reasonFixture(entry.fixture);
      const summary = singleSummary(
        fixture,
        entry.fixture === 'upgradeEvidenceUnknown' ? diagnostics : undefined,
      );
      if (entry.expected) {
        expect(summary.reasonCodes).toContain(entry.expected);
      } else {
        expect(summary.reasonCodes).toEqual([]);
      }

      const serialized = JSON.stringify(summary);
      for (const legacyCode of forbiddenLegacyCodes) {
        expect(serialized).not.toContain(legacyCode);
      }
      expect(serialized).not.toContain('openInstallWizard');
      expect(serialized).not.toContain('diagnoseCommand');
    }
  });

  it('derives duplicate groups and summary-level features from controller locations', () => {
    const summaries = createPluginConsoleItems(matrix([
      cell({
        platform: 'codex',
        scope: 'user',
        installState: installState(),
        report: undefined,
      }),
      cell({
        platform: 'codex',
        scope: 'project',
        projectKey: '/workspace',
        installState: installState(),
        report: undefined,
      }),
    ]));

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.reasonCodes).toContain('duplicateInstall');
    expect(summaries[0]!.duplicateInstallGroups).toHaveLength(1);
    expect(summaries[0]!.features.map((feature) => feature.kind)).toContain('resolveDuplicateInstall');
    expect(summaries[0]!.locationSummary).toBe('Codex（个人 + 当前项目）');
  });

  it('covers the complete public reason-code floor without legacy status copy', () => {
    const adoptable = singleSummary(cell({
      scope: 'project',
      projectKey: '/workspace',
      installState: installState({
        kind: 'adoptable',
        summary: '发现了一份可认领的已有项目安装。',
        adoptExistingAvailable: true,
      }),
      report: undefined,
    }));
    const dependencyBlocked = singleSummary(cell({
      installState: installState({
        kind: 'needsRepair',
        summary: '缺少依赖。',
        issueCodes: ['dependencyMissing'],
      }),
      report: undefined,
    }));
    const duplicate = createPluginConsoleItems(matrix([
      cell({
        platform: 'codex',
        scope: 'user',
        installState: installState(),
        report: undefined,
      }),
      cell({
        platform: 'codex',
        scope: 'project',
        projectKey: '/workspace',
        installState: installState(),
        report: undefined,
      }),
    ]))[0]!;
    const alreadyCovered = [
      singleSummary(reasonFixture('nativeIncomplete')),
      singleSummary(reasonFixture('nativeResidue')),
      singleSummary(reasonFixture('missingRecord')),
      singleSummary(reasonFixture('artifactRefreshFailed')),
      singleSummary(reasonFixture('externalOwnership')),
      singleSummary(reasonFixture('requiredConfigMissing')),
    ];

    const allCodes = new Set([
      ...alreadyCovered.flatMap((summary) => summary.reasonCodes),
      ...adoptable.reasonCodes,
      ...dependencyBlocked.reasonCodes,
      ...duplicate.reasonCodes,
    ]);

    expect([...allCodes].sort()).toEqual([
      'adoptableInstall',
      'artifactRefreshFailed',
      'dependencyBlocked',
      'duplicateInstall',
      'foreignOwnershipConflict',
      'missingRequiredConfig',
      'nativeIncomplete',
      'recordCorrupted',
      'residueDetected',
    ]);
    expect(JSON.stringify([...alreadyCovered, adoptable, dependencyBlocked, duplicate]))
      .not.toMatch(/needsAction|partial|repoManaged|external|missingRecord|ownerConflict|dependencyProtected|requiredConfigMissing/);
  });

  it('uses manifest interface metadata for title and short description', () => {
    const plugin: PluginMeta = {
      rootDir: '/catalog/demo-plugin',
      manifestPath: '/catalog/demo-plugin/plugin.json',
      manifest: {
        name: 'demo-plugin',
        version: '1.2.3',
        description: 'fallback description',
        interface: {
          displayName: 'Demo Display Name',
          shortDescription: 'Demo short description',
        },
        marketplace: {
          category: 'test',
          strict: false,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'NONE',
          },
        },
      },
    };

    expect(resolvePluginConsoleMeta(plugin)).toEqual({
      title: 'Demo Display Name',
      description: 'Demo short description',
      version: '1.2.3',
    });
  });

  it('sorts home items by friendly status then display title and keeps catalog-only cells neutral', () => {
    const items = createConsoleControllerItems(matrix([
      cell({
        pluginName: 'zeta-installed',
        platform: 'codex',
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
        }),
      }),
      cell({
        pluginName: 'alpha-installed',
        platform: 'codex',
        report: report({
          scopeInitialized: 'yes',
          scopeManagedEvidence: { ledger: true },
        }),
      }),
      reasonFixture('requiredConfigMissing'),
      cell({
        pluginName: 'catalog-only',
        platform: 'claude',
        report: report({
          native: native(),
          scopeManagedEvidence: {},
          currentCatalog: {
            rootDir: '/catalog/catalog-only',
            source: 'local',
            available: true,
          },
        }),
      }),
    ]), {
      pluginMetaByName: {
        'zeta-installed': { title: 'Zeta Tool' },
        'alpha-installed': { title: 'Alpha Tool' },
        'catalog-only': { title: 'Catalog Only', description: 'Available but not installed.' },
      },
    });

    expect(items.map((entry) => entry.summary.title)).toEqual([
      'demo-plugin',
      'Alpha Tool',
      'Zeta Tool',
      'Catalog Only',
    ]);
    const catalogOnly = items.find((entry) => entry.summary.pluginName === 'catalog-only')!;
    expect(catalogOnly.summary.status).toBe('notInstalled');
    expect(catalogOnly.summary.reasonCodes).toEqual([]);
    expect(catalogOnly.summary.issueSummary).toBeUndefined();
    expect(catalogOnly.pageItem.primaryActionLabel).toBe('安装');
  });

  it('keeps controller-only actions and commands out of public summaries', () => {
    const controller = singleController(reasonFixture('artifactRefreshFailed'));
    const summary = controller.summary;

    expect(controller.locations[0]!.actions.map((action) => action.kind)).toContain('reapplyConfigRefresh');
    expect(summary.features.map((feature) => feature.kind)).toContain('reapplyConfigRefresh');
    expect(summary.features.map((feature) => feature.kind)).toContain('status');

    const publicJson = JSON.stringify(summary);
    expect(publicJson).not.toContain('reapplyConfigRefresh","target');
    expect(publicJson).not.toContain('command');
    expect(publicJson).not.toContain('confirmText');
  });

  it('derives page model fields without leaking them into JSON summaries', () => {
    const controller = singleController(reasonFixture('requiredConfigMissing'));

    expect(controller.pageItem.statusIcon).toBe('alert-circle');
    expect(controller.pageItem.statusTone).toBe('danger');
    expect(controller.pageItem.platformBadges).toEqual([
      {
        label: 'Codex',
        icon: 'square-terminal',
        tone: 'neutral',
      },
    ]);
    expect(controller.pageItem.primaryActionLabel).toBe('配置');

    expect(controller.summary).not.toHaveProperty('statusIcon');
    expect(controller.summary).not.toHaveProperty('statusTone');
    expect(controller.summary).not.toHaveProperty('platformBadges');
    expect(controller.summary).not.toHaveProperty('primaryActionLabel');
  });

  it('keeps controller action contracts intact and exposes status detail commands', () => {
    const controller = singleController(reasonFixture('nativeIncomplete'));
    const writeActions = controller.locations[0]!.actions.filter((action) =>
      action.kind === 'runUpgrade' ||
      action.kind === 'runUninstall' ||
      action.kind === 'repairInstall' ||
      action.kind === 'cleanupRecovery' ||
      action.kind === 'reapplyConfigRefresh',
    );

    expect(writeActions.length).toBeGreaterThan(0);
    for (const action of writeActions) {
      expect(action.target).toBeDefined();
    }

    const destructiveActions = controller.locations[0]!.actions.filter((action) => action.destructive);
    for (const action of destructiveActions) {
      expect(action.confirmText).toBeTruthy();
    }

    const statusAction = singleController(reasonFixture('catalogUnavailable'))
      .locations[0]!.actions.find((action) => action.kind === 'openStatus');
    expect(statusAction?.command).toEqual([
      'aw',
      'status',
      'demo-plugin',
      '--platform',
      'codex',
      '--scope',
      'user',
      '--verbose',
    ]);

    for (const feature of controller.summary.features) {
      const executableActions = createPluginConsoleExecutableActions(controller, feature.kind);
      for (const executableAction of executableActions) {
        expect(executableAction).not.toHaveProperty('command');
        if (executableAction.kind !== 'runCleanup') {
          expect(executableAction).not.toHaveProperty('force');
        }
      }
    }
  });

  it('projects adopt-existing and takeover flows as features plus controller-only commands', () => {
    const adoptable = singleController(cell({
      scope: 'project',
      projectKey: '/workspace',
      installState: installState({
        kind: 'adoptable',
        summary: '发现了一份可认领的已有项目安装。',
        nextSteps: [{
          kind: 'uiAction',
          label: '认领现有安装',
          description: '会进入认领流程，把当前项目里已有的安装纳入 AW 管理。',
          uiAction: 'runAdoptExisting',
        }],
        adoptExistingAvailable: true,
      }),
      report: undefined,
    }));
    const ownerConflict = singleController(cell({
      installState: installState({
        kind: 'needsRepair',
        summary: '共享触发策略当前由另一个安装位置控制。',
        nextSteps: [{
          kind: 'uiAction',
          label: '接管共享触发策略',
          description: '会进入接管流程，把共享 runtime 的控制权切换到当前安装位置。',
          uiAction: 'runTakeoverSharedRuntime',
        }],
        issueCodes: ['artifactMissing'],
        sharedRuntimeOwnerPresent: true,
        sharedRuntimeNeedsTakeover: true,
        sharedRuntimeParticipatesInOwner: true,
        sharedRuntimeSemanticDelta: 'change',
        sharedRuntimeOwnerConflict: true,
      }),
      report: undefined,
    }));

    expect(adoptable.summary.features.map((feature) => feature.kind)).toContain('adoptExisting');
    expect(adoptable.locations[0]!.actions.find((entry) => entry.label === '认领现有安装')?.kind).toBe('runAdoptExisting');

    expect(ownerConflict.summary.features.map((feature) => feature.kind)).toContain('takeoverSharedRuntime');
    expect(ownerConflict.locations[0]!.actions.find((entry) => entry.label === '接管共享触发策略')?.kind).toBe('runTakeoverSharedRuntime');
  });

  it('keeps public feature payload free of target, confirmText and command details', () => {
    const summary = singleSummary(reasonFixture('requiredConfigMissing'));

    for (const feature of summary.features) {
      expect(feature).not.toHaveProperty('target');
      expect(feature).not.toHaveProperty('confirmText');
      expect(feature).not.toHaveProperty('command');
      expect(feature).not.toHaveProperty('statusIcon');
    }
  });

  it('marks ordinary cross-platform features as multi-target but keeps takeover single-target', () => {
    const controller = createConsoleControllerItems(matrix([
      cell({
        platform: 'codex',
        installState: installState(),
        report: undefined,
      }),
      cell({
        platform: 'claude',
        installState: installState(),
        report: undefined,
      }),
      cell({
        pluginName: 'takeover-plugin',
        platform: 'codex',
        installState: installState({
          kind: 'needsRepair',
          issueCodes: ['artifactMissing'],
          sharedRuntimeOwnerPresent: true,
          sharedRuntimeNeedsTakeover: true,
          sharedRuntimeParticipatesInOwner: true,
          sharedRuntimeSemanticDelta: 'change',
          sharedRuntimeOwnerConflict: true,
        }),
        report: undefined,
      }),
    ]));

    const demo = controller.find((entry) => entry.summary.pluginName === 'demo-plugin');
    const takeover = controller.find((entry) => entry.summary.pluginName === 'takeover-plugin');
    expect(demo?.summary.features.find((feature) => feature.kind === 'uninstall')?.targetSelection).toBe('multiTargetAllowed');
    expect(takeover?.summary.features.find((feature) => feature.kind === 'takeoverSharedRuntime')?.targetSelection).toBe('singleTargetOnly');
  });

  it('keeps detail target options empty until a feature is chosen and special-cases duplicate labels', () => {
    const controller = singleController(cell({
      installState: installState(),
      report: undefined,
    }));

    expect(createConsolePluginDetailPageModel(controller).targetOptions).toEqual([]);

    const duplicateController = createConsoleControllerItems(matrix([
      cell({
        platform: 'codex',
        scope: 'user',
        installState: installState(),
        report: undefined,
      }),
      cell({
        platform: 'codex',
        scope: 'project',
        projectKey: '/workspace',
        installState: installState(),
        report: undefined,
      }),
    ]))[0]!;

    const detail = createConsolePluginDetailPageModel(duplicateController, 'resolveDuplicateInstall');
    expect(detail.targetOptions.map((option) => option.label)).toEqual(['保留个人位置', '保留当前项目位置']);

    const actions = createPluginConsoleExecutableActions(duplicateController, 'resolveDuplicateInstall');
    expect(actions.every((action) => action.confirmText)).toBe(true);
  });
});
