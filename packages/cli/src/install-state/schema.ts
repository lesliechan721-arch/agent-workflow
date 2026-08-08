import path from 'node:path';

import type {
  ArtifactState,
  ArtifactTarget,
  PlatformName,
  Scope,
  SkillTriggerPreference,
  TrackedHookGroupIdentity,
} from '../types.js';
import { getStrictSemVerValidationIssue } from '../utils/manifest.js';
import { resolveAwHome } from '../utils/paths.js';
import {
  createHistoricalLifecycleScopeKey,
  createRecordId,
  createSharedIdentityId,
  getSharedRuntimeOwnerFileName,
} from './ids.js';
import {
  ensureOnlyKeys,
  fail,
  isNonEmptyString,
  isPathInside,
  isRecord,
  isStringArray,
  normalizeRepoRelativePath,
  ok,
  type ValidationResult,
} from './internal.js';
import type {
  DynamicArtifactDiagnosticCache,
  DynamicArtifactDiagnosticEntry,
  GlobalDependencyIndex,
  GlobalDependencyIndexRecord,
  HistoricalLifecycleRuntimeRef,
  InstallRecord,
  InstallRecordArtifact,
  InstallRecordDependencyEdge,
  InstallRecordFile,
  InstallRecordInstallSource,
  NativeTransactionMarker,
  PluginLocation,
  ProjectArtifactIdentityArtifact,
  ProjectArtifactIdentityFile,
  ProjectArtifactSharedLocator,
  RepoManagedArtifactKind,
  SharedSkillTriggerRuntimeOwner,
} from './types.js';

const VALID_PLATFORMS = new Set<PlatformName>(['codex', 'claude']);
const VALID_SCOPES = new Set<Scope>(['user', 'project']);
const VALID_SKILL_TRIGGER_PREFERENCES = new Set<SkillTriggerPreference>(['default', 'manual', 'auto']);
const VALID_ARTIFACT_TARGETS = new Set<ArtifactTarget>([
  'codex.developerInstructionsBlock',
  'codex.agentRole',
  'codex.skill',
  'claude.skill',
]);
const VALID_ARTIFACT_STATES = new Set<ArtifactState>(['present', 'disabled']);
const VALID_REPO_MANAGED_ARTIFACT_KINDS = new Set<RepoManagedArtifactKind>([
  'instruction',
  'permission',
  'hook',
  'agent',
  'skill',
  'mcpServer',
]);
const VALID_DYNAMIC_DIAGNOSTIC_REFRESH_EVENTS = new Set(['install', 'upgrade', 'config']);
const LEGACY_DYNAMIC_DIAGNOSTIC_REFRESH_EVENT_ALIASES = new Map([
  ['repair', 'config'],
]);
const BANNED_RECORD_FIELDS = new Set([
  'ledgerState',
  'degradedAt',
  'degradedReason',
  'scopeInitialized',
  'capabilitySnapshot',
  'lastRequestedScope',
  'lastRequestedAt',
  'sharedNativeRefs',
  'skillTriggerWriteOrder',
  'dependents',
  'refCount',
  'autoRemovable',
  'unusedDependencyHint',
  'dependencies',
  'lastRefresh',
  'refreshReach',
  'configDigest',
  'contentDigest',
  'installSnapshot',
  'configSnapshot',
  'artifactHealthSnapshot',
  'lifecycleConfigSnapshot',
]);

const INSTALL_STATE_ARTIFACT_KIND_BY_TARGET: Record<ArtifactTarget, RepoManagedArtifactKind> = {
  'codex.developerInstructionsBlock': 'instruction',
  'codex.agentRole': 'agent',
  'codex.skill': 'skill',
  'claude.skill': 'skill',
};

function validateStrictSemVerString(
  value: unknown,
  context: string,
): ValidationResult<string> {
  const issue = getStrictSemVerValidationIssue(value, context);
  if (issue) {
    return fail(issue.code, issue.message);
  }

  return ok(value as string);
}

function validatePlatform(value: unknown, context: string): ValidationResult<PlatformName> {
  if (!VALID_PLATFORMS.has(value as PlatformName)) {
    return fail('invalidPlatform', `Invalid ${context}: expected "codex" or "claude".`);
  }
  return ok(value as PlatformName);
}

function validateScope(value: unknown, context: string): ValidationResult<Scope> {
  if (!VALID_SCOPES.has(value as Scope)) {
    return fail('invalidScope', `Invalid ${context}: expected "user" or "project".`);
  }
  return ok(value as Scope);
}

function validateSkillTriggerPreference(
  value: unknown,
  context: string,
): ValidationResult<SkillTriggerPreference> {
  if (!VALID_SKILL_TRIGGER_PREFERENCES.has(value as SkillTriggerPreference)) {
    return fail(
      'invalidSkillTriggerPreference',
      `Invalid ${context}: expected "default", "manual", or "auto".`,
    );
  }
  return ok(value as SkillTriggerPreference);
}

function validateHookGroupIdentity(
  value: unknown,
  context: string,
): ValidationResult<TrackedHookGroupIdentity> {
  if (!isRecord(value)) {
    return fail('invalidHookGroup', `Invalid ${context}: expected an object.`);
  }
  const allowedKeys = ensureOnlyKeys(value, ['event', 'matcher', 'command'], context);
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (!isNonEmptyString(value.event) || !isNonEmptyString(value.command)) {
    return fail('invalidHookGroup', `Invalid ${context}: "event" and "command" must be non-empty strings.`);
  }
  if (value.matcher !== undefined && !isNonEmptyString(value.matcher)) {
    return fail('invalidHookGroup', `Invalid ${context}.matcher: expected a non-empty string.`);
  }
  return ok(value as unknown as TrackedHookGroupIdentity);
}

export function validatePluginLocation(
  value: unknown,
  context = 'plugin location',
): ValidationResult<PluginLocation> {
  if (!isRecord(value)) {
    return fail('invalidPluginLocation', `Invalid ${context}: expected an object.`);
  }
  const allowedKeys = ensureOnlyKeys(value, ['plugin', 'platform', 'scope', 'projectKey'], context);
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (!isNonEmptyString(value.plugin)) {
    return fail('invalidPluginLocation', `Invalid ${context}.plugin: expected a non-empty string.`);
  }
  const platform = validatePlatform(value.platform, `${context}.platform`);
  if (!platform.ok) {
    return platform;
  }
  const scope = validateScope(value.scope, `${context}.scope`);
  if (!scope.ok) {
    return scope;
  }

  if (scope.value === 'user') {
    if (value.projectKey !== undefined && value.projectKey !== null) {
      return fail('invalidPluginLocation', `Invalid ${context}.projectKey: user scope must not define projectKey.`);
    }
    return ok({
      plugin: value.plugin,
      platform: platform.value,
      scope: scope.value,
    });
  }

  if (!isNonEmptyString(value.projectKey)) {
    return fail('invalidPluginLocation', `Invalid ${context}.projectKey: project scope requires a non-empty string.`);
  }

  return ok({
    plugin: value.plugin,
    platform: platform.value,
    scope: scope.value,
    projectKey: value.projectKey,
  });
}

function validateInstallSource(
  value: unknown,
  context: string,
): ValidationResult<InstallRecordInstallSource> {
  if (!isRecord(value)) {
    return fail('invalidInstallSource', `Invalid ${context}: expected an object.`);
  }
  const allowedKeys = ensureOnlyKeys(value, ['kind', 'explicitlyRequested'], context);
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if ((value.kind !== 'explicit' && value.kind !== 'dependency') || typeof value.explicitlyRequested !== 'boolean') {
    return fail(
      'invalidInstallSource',
      `Invalid ${context}: expected { kind: "explicit" | "dependency", explicitlyRequested: boolean }.`,
    );
  }
  return ok(value as unknown as InstallRecordInstallSource);
}

function validateInstallDependencyEdge(
  value: unknown,
  context: string,
): ValidationResult<InstallRecordDependencyEdge> {
  if (!isRecord(value)) {
    return fail('invalidDependencyEdge', `Invalid ${context}: expected an object.`);
  }
  const allowedKeys = ensureOnlyKeys(value, ['dependency', 'declaration'], context);
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  const dependency = validatePluginLocation(value.dependency, `${context}.dependency`);
  if (!dependency.ok) {
    return dependency;
  }
  if (!isRecord(value.declaration)) {
    return fail('invalidDependencyEdge', `Invalid ${context}.declaration: expected an object.`);
  }
  const declarationKeys = ensureOnlyKeys(
    value.declaration,
    ['name', 'minVersion', 'target', 'inheritInstallOptions', 'when'],
    `${context}.declaration`,
  );
  if (!declarationKeys.ok) {
    return declarationKeys;
  }
  if (!isNonEmptyString(value.declaration.name)) {
    return fail('invalidDependencyEdge', `Invalid ${context}.declaration.name: expected a non-empty string.`);
  }
  if (value.declaration.minVersion !== undefined) {
    const minVersion = validateStrictSemVerString(
      value.declaration.minVersion,
      `${context}.declaration.minVersion`,
    );
    if (!minVersion.ok) {
      return minVersion;
    }
  }
  if (value.declaration.target !== undefined) {
    if (!isRecord(value.declaration.target)) {
      return fail('invalidDependencyEdge', `Invalid ${context}.declaration.target: expected an object.`);
    }
    const targetKeys = ensureOnlyKeys(value.declaration.target, ['scope'], `${context}.declaration.target`);
    if (!targetKeys.ok) {
      return targetKeys;
    }
    if (value.declaration.target.scope !== undefined) {
      const scope = validateScope(value.declaration.target.scope, `${context}.declaration.target.scope`);
      if (!scope.ok) {
        return scope;
      }
    }
  }
  if (
    value.declaration.inheritInstallOptions !== undefined &&
    typeof value.declaration.inheritInstallOptions !== 'boolean'
  ) {
    return fail(
      'invalidDependencyEdge',
      `Invalid ${context}.declaration.inheritInstallOptions: expected a boolean.`,
    );
  }
  if (value.declaration.when !== undefined) {
    if (!isRecord(value.declaration.when)) {
      return fail('invalidDependencyEdge', `Invalid ${context}.declaration.when: expected an object.`);
    }
    const whenKeys = ensureOnlyKeys(value.declaration.when, ['platforms'], `${context}.declaration.when`);
    if (!whenKeys.ok) {
      return whenKeys;
    }
    if (
      value.declaration.when.platforms !== undefined &&
      (
        !Array.isArray(value.declaration.when.platforms) ||
        value.declaration.when.platforms.length === 0 ||
        value.declaration.when.platforms.some((platform) => !VALID_PLATFORMS.has(platform as PlatformName))
      )
    ) {
      return fail(
        'invalidDependencyEdge',
        `Invalid ${context}.declaration.when.platforms: expected a non-empty array of platforms.`,
      );
    }
  }
  return ok(value as unknown as InstallRecordDependencyEdge);
}

function validateArtifactIdentityFields(
  value: Record<string, unknown>,
  context: string,
  options: {
    allowState?: boolean;
    allowConfigDigest?: boolean;
    allowContentDigest?: boolean;
    expectAbsolutePath: boolean;
  },
): ValidationResult<void> {
  if (!VALID_REPO_MANAGED_ARTIFACT_KINDS.has(value.kind as RepoManagedArtifactKind)) {
    return fail('invalidArtifact', `Invalid ${context}.kind: unsupported artifact kind.`);
  }
  const platform = validatePlatform(value.platform, `${context}.platform`);
  if (!platform.ok) {
    return platform;
  }
  if (!isNonEmptyString(value.path)) {
    return fail('invalidArtifact', `Invalid ${context}.path: expected a non-empty string.`);
  }
  if (options.expectAbsolutePath && !path.isAbsolute(value.path)) {
    return fail('invalidArtifact', `Invalid ${context}.path: install record paths must be absolute.`);
  }
  if (!options.expectAbsolutePath) {
    const normalized = normalizeRepoRelativePath(value.path);
    if (!normalized.ok) {
      return fail('invalidArtifact', `Invalid ${context}.path: ${normalized.error}`);
    }
  }
  if (value.paths !== undefined) {
    if (!isStringArray(value.paths) || value.paths.length === 0) {
      return fail('invalidArtifact', `Invalid ${context}.paths: expected a non-empty string array.`);
    }
    for (const [index, entry] of value.paths.entries()) {
      if (options.expectAbsolutePath) {
        if (!path.isAbsolute(entry)) {
          return fail('invalidArtifact', `Invalid ${context}.paths[${index}]: install record paths must be absolute.`);
        }
      } else {
        const normalized = normalizeRepoRelativePath(entry);
        if (!normalized.ok) {
          return fail('invalidArtifact', `Invalid ${context}.paths[${index}]: ${normalized.error}`);
        }
      }
    }
  }
  if (value.artifactKey !== undefined && !isNonEmptyString(value.artifactKey)) {
    return fail('invalidArtifact', `Invalid ${context}.artifactKey: expected a non-empty string.`);
  }
  if (value.ownershipMarker !== undefined && !isNonEmptyString(value.ownershipMarker)) {
    return fail('invalidArtifact', `Invalid ${context}.ownershipMarker: expected a non-empty string.`);
  }
  if (value.id !== undefined && !isNonEmptyString(value.id)) {
    return fail('invalidArtifact', `Invalid ${context}.id: expected a non-empty string.`);
  }
  if (value.target !== undefined && !VALID_ARTIFACT_TARGETS.has(value.target as ArtifactTarget)) {
    return fail('invalidArtifact', `Invalid ${context}.target: unsupported artifact target.`);
  }
  if ((value.id === undefined) !== (value.target === undefined)) {
    return fail('invalidArtifact', `Invalid ${context}: dynamic artifact identity requires both "id" and "target".`);
  }
  if (value.target !== undefined) {
    const expectedKind = INSTALL_STATE_ARTIFACT_KIND_BY_TARGET[value.target as ArtifactTarget];
    if (value.kind !== expectedKind) {
      return fail(
        'invalidArtifact',
        `Invalid ${context}: target "${value.target}" must use artifact kind "${expectedKind}".`,
      );
    }
  }
  if (value.roleKey !== undefined && !isNonEmptyString(value.roleKey)) {
    return fail('invalidArtifact', `Invalid ${context}.roleKey: expected a non-empty string.`);
  }
  if (value.target !== 'codex.agentRole' && value.roleKey !== undefined) {
    return fail('invalidArtifact', `Invalid ${context}.roleKey: only codex.agentRole may declare roleKey.`);
  }
  if (value.hookGroups !== undefined) {
    if (!Array.isArray(value.hookGroups) || value.hookGroups.length === 0) {
      return fail('invalidArtifact', `Invalid ${context}.hookGroups: expected a non-empty array.`);
    }
    for (const [index, group] of value.hookGroups.entries()) {
      const validatedGroup = validateHookGroupIdentity(group, `${context}.hookGroups[${index}]`);
      if (!validatedGroup.ok) {
        return validatedGroup;
      }
    }
  }
  if (options.allowState) {
    if (value.state !== undefined && !VALID_ARTIFACT_STATES.has(value.state as ArtifactState)) {
      return fail('invalidArtifact', `Invalid ${context}.state: expected "present" or "disabled".`);
    }
  }
  if (!options.allowState && value.state !== undefined) {
    return fail('unexpectedField', `Invalid ${context}: install record artifacts must not persist "state".`);
  }
  if (options.allowConfigDigest) {
    if (value.configDigest !== undefined && !isNonEmptyString(value.configDigest)) {
      return fail('invalidArtifact', `Invalid ${context}.configDigest: expected a non-empty string.`);
    }
  } else if (value.configDigest !== undefined) {
    return fail('unexpectedField', `Invalid ${context}: install record artifacts must not persist "configDigest".`);
  }
  if (options.allowContentDigest) {
    if (value.contentDigest !== undefined && !isNonEmptyString(value.contentDigest)) {
      return fail('invalidArtifact', `Invalid ${context}.contentDigest: expected a non-empty string.`);
    }
  } else if (value.contentDigest !== undefined) {
    return fail('unexpectedField', `Invalid ${context}: install record artifacts must not persist "contentDigest".`);
  }

  if ((value.kind === 'skill' || value.kind === 'mcpServer') && !isNonEmptyString(value.artifactKey)) {
    return fail(
      'missingArtifactIdentity',
      `Invalid ${context}: artifact kind "${value.kind}" requires "artifactKey".`,
    );
  }
  if (value.kind === 'hook' && (!Array.isArray(value.hookGroups) || value.hookGroups.length === 0)) {
    return fail('missingArtifactIdentity', `Invalid ${context}: hook artifacts require "hookGroups".`);
  }
  if (value.target === 'codex.agentRole' && !isNonEmptyString(value.roleKey)) {
    return fail('missingArtifactIdentity', `Invalid ${context}: codex agent role artifacts require "roleKey".`);
  }

  return ok(undefined);
}

export function validateInstallRecordArtifact(
  value: unknown,
  context = 'install record artifact',
): ValidationResult<InstallRecordArtifact> {
  if (!isRecord(value)) {
    return fail('invalidArtifact', `Invalid ${context}: expected an object.`);
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    [
      'kind',
      'platform',
      'path',
      'paths',
      'artifactKey',
      'hookGroups',
      'id',
      'target',
      'state',
      'refreshKeys',
      'roleKey',
      'ownershipMarker',
      'configDigest',
      'contentDigest',
    ],
    context,
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  const validated = validateArtifactIdentityFields(value, context, {
    allowState: true,
    allowConfigDigest: true,
    allowContentDigest: true,
    expectAbsolutePath: true,
  });
  if (!validated.ok) {
    return validated;
  }
  if (value.refreshKeys !== undefined && !isStringArray(value.refreshKeys)) {
    return fail('invalidArtifact', `Invalid ${context}.refreshKeys: expected a string array.`);
  }
  return ok(value as unknown as InstallRecordArtifact);
}

export function validateProjectArtifactSharedLocator(
  value: unknown,
  options: {
    projectKey?: string | null;
    cwd?: string;
    homeDir?: string;
  } = {},
): ValidationResult<ProjectArtifactSharedLocator> {
  if (!isRecord(value)) {
    return fail('invalidSharedLocator', 'Invalid project artifact shared locator: expected an object.');
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    ['plugin', 'platform', 'scope', 'repoRelativeProjectRoot'],
    'project artifact shared locator',
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (!isNonEmptyString(value.plugin)) {
    return fail('invalidSharedLocator', 'Invalid project artifact shared locator.plugin: expected a non-empty string.');
  }
  const platform = validatePlatform(value.platform, 'project artifact shared locator.platform');
  if (!platform.ok) {
    return platform;
  }
  if (value.scope !== 'project') {
    return fail('invalidSharedLocator', 'Invalid project artifact shared locator.scope: expected "project".');
  }
  if (!isNonEmptyString(value.repoRelativeProjectRoot)) {
    return fail(
      'invalidSharedLocator',
      'Invalid project artifact shared locator.repoRelativeProjectRoot: expected a non-empty string.',
    );
  }
  const normalized = normalizeRepoRelativePath(value.repoRelativeProjectRoot, { allowDot: true });
  if (!normalized.ok) {
    return fail('invalidSharedLocator', normalized.error);
  }
  if (options.projectKey && value.repoRelativeProjectRoot === options.projectKey) {
    return fail('invalidSharedLocator', 'Invalid project artifact shared locator: must not reuse PluginLocation.projectKey.');
  }
  if (options.cwd && value.repoRelativeProjectRoot === options.cwd) {
    return fail('invalidSharedLocator', 'Invalid project artifact shared locator: must not embed cwd.');
  }
  if (options.homeDir && (
    value.repoRelativeProjectRoot === options.homeDir ||
    value.repoRelativeProjectRoot.startsWith(`${options.homeDir}/`)
  )) {
    return fail('invalidSharedLocator', 'Invalid project artifact shared locator: must not embed the home directory.');
  }

  return ok(value as unknown as ProjectArtifactSharedLocator);
}

export function validateProjectArtifactIdentityArtifact(
  value: unknown,
  context = 'project artifact identity artifact',
): ValidationResult<ProjectArtifactIdentityArtifact> {
  if (!isRecord(value)) {
    return fail('invalidArtifact', `Invalid ${context}: expected an object.`);
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    [
      'kind',
      'platform',
      'path',
      'paths',
      'artifactKey',
      'hookGroups',
      'id',
      'target',
      'roleKey',
      'ownershipMarker',
      'state',
      'configDigest',
      'contentDigest',
    ],
    context,
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  const validated = validateArtifactIdentityFields(value, context, {
    allowState: true,
    allowConfigDigest: true,
    allowContentDigest: true,
    expectAbsolutePath: false,
  });
  if (!validated.ok) {
    return validated;
  }
  return ok(value as unknown as ProjectArtifactIdentityArtifact);
}

function validateHistoricalLifecycleRuntimeRef(
  value: unknown,
  context: string,
  options: {
    awHome?: string;
    env?: NodeJS.ProcessEnv;
    location?: PluginLocation;
    recordId?: string;
  } = {},
): ValidationResult<HistoricalLifecycleRuntimeRef> {
  if (!isRecord(value)) {
    return fail('invalidLifecycleRuntime', `Invalid ${context}: expected an object.`);
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    [
      'runtimeRoot',
      'bundleRoot',
      'manifestPath',
      'pluginVersion',
      'sourceManifestDigest',
      'bundleFingerprint',
      'events',
      'createdAt',
    ],
    context,
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (
    !isNonEmptyString(value.runtimeRoot) ||
    !isNonEmptyString(value.bundleRoot) ||
    !isNonEmptyString(value.manifestPath) ||
    !isNonEmptyString(value.sourceManifestDigest) ||
    !isNonEmptyString(value.bundleFingerprint) ||
    !isNonEmptyString(value.createdAt)
  ) {
    return fail('invalidLifecycleRuntime', `Invalid ${context}: missing required runtime fields.`);
  }
  if (
    !path.isAbsolute(value.runtimeRoot) ||
    !path.isAbsolute(value.bundleRoot) ||
    !path.isAbsolute(value.manifestPath)
  ) {
    return fail('invalidLifecycleRuntime', `Invalid ${context}: runtime paths must be absolute.`);
  }
  if (!Array.isArray(value.events) || value.events.some((entry) => !['install', 'upgrade', 'uninstall'].includes(String(entry)))) {
    return fail('invalidLifecycleRuntime', `Invalid ${context}.events: expected install/upgrade/uninstall event names.`);
  }
  const pluginVersion = validateStrictSemVerString(value.pluginVersion, `${context}.pluginVersion`);
  if (!pluginVersion.ok) {
    return pluginVersion;
  }
  if (!isPathInside(value.runtimeRoot, value.bundleRoot)) {
    return fail('invalidLifecycleRuntime', `Invalid ${context}.bundleRoot: must stay within runtimeRoot.`);
  }
  if (!isPathInside(value.bundleRoot, value.manifestPath)) {
    return fail('invalidLifecycleRuntime', `Invalid ${context}.manifestPath: must stay within bundleRoot.`);
  }
  if (options.location && options.recordId) {
    const expectedRuntimeRootBase = path.join(
      path.resolve(options.awHome ?? resolveAwHome(options.env)),
      'lifecycle-runtimes',
      options.location.platform,
      options.location.scope,
      createHistoricalLifecycleScopeKey(options.location),
      options.recordId,
    );
    if (!isPathInside(expectedRuntimeRootBase, value.runtimeRoot)) {
      return fail(
        'invalidLifecycleRuntime',
        `Invalid ${context}.runtimeRoot: must stay within ${expectedRuntimeRootBase}.`,
      );
    }
  }
  return ok(value as unknown as HistoricalLifecycleRuntimeRef);
}

function validateInstallRecord(
  value: unknown,
  context: string,
): ValidationResult<InstallRecord> {
  if (!isRecord(value)) {
    return fail('invalidInstallRecord', `Invalid ${context}: expected an object.`);
  }
  const legacyField = Object.keys(value).find((key) => BANNED_RECORD_FIELDS.has(key));
  if (legacyField) {
    return fail(
      'unsupportedLegacyField',
      `Unsupported ${context}: legacy field "${legacyField}" must not be persisted in install record v2.`,
    );
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    [
      'pluginName',
      'platform',
      'scope',
      'projectKey',
      'installedAt',
      'updatedAt',
      'source',
      'installSource',
      'options',
      'native',
      'lifecycle',
      'artifacts',
      'dependencyEdges',
    ],
    context,
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (!isNonEmptyString(value.pluginName) || !isNonEmptyString(value.installedAt) || !isNonEmptyString(value.updatedAt)) {
    return fail('invalidInstallRecord', `Invalid ${context}: missing required top-level fields.`);
  }
  const platform = validatePlatform(value.platform, `${context}.platform`);
  if (!platform.ok) {
    return platform;
  }
  const scope = validateScope(value.scope, `${context}.scope`);
  if (!scope.ok) {
    return scope;
  }
  if (scope.value === 'project') {
    if (!isNonEmptyString(value.projectKey)) {
      return fail('invalidInstallRecord', `Invalid ${context}.projectKey: project records require a non-empty string.`);
    }
  } else if (value.projectKey !== undefined) {
    return fail('invalidInstallRecord', `Invalid ${context}.projectKey: user records must not define projectKey.`);
  }
  if (!isRecord(value.source)) {
    return fail('invalidInstallRecord', `Invalid ${context}.source: expected an object.`);
  }
  const sourceKeys = ensureOnlyKeys(value.source, ['pluginVersion', 'manifestDigest', 'bundleFingerprint'], `${context}.source`);
  if (!sourceKeys.ok) {
    return sourceKeys;
  }
  if (
    !isNonEmptyString(value.source.manifestDigest) ||
    !isNonEmptyString(value.source.bundleFingerprint)
  ) {
    return fail('invalidInstallRecord', `Invalid ${context}.source: version, manifestDigest, and bundleFingerprint are required.`);
  }
  const sourcePluginVersion = validateStrictSemVerString(
    value.source.pluginVersion,
    `${context}.source.pluginVersion`,
  );
  if (!sourcePluginVersion.ok) {
    return sourcePluginVersion;
  }
  const installSource = validateInstallSource(value.installSource, `${context}.installSource`);
  if (!installSource.ok) {
    return installSource;
  }
  if (value.options !== undefined) {
    if (!isRecord(value.options)) {
      return fail('invalidInstallRecord', `Invalid ${context}.options: expected an object.`);
    }
    const optionKeys = ensureOnlyKeys(value.options, ['skillTriggerPreference'], `${context}.options`);
    if (!optionKeys.ok) {
      return optionKeys;
    }
    if (value.options.skillTriggerPreference !== undefined) {
      const preference = validateSkillTriggerPreference(
        value.options.skillTriggerPreference,
        `${context}.options.skillTriggerPreference`,
      );
      if (!preference.ok) {
        return preference;
      }
    }
  }
  if (value.native !== undefined) {
    if (!isRecord(value.native)) {
      return fail('invalidInstallRecord', `Invalid ${context}.native: expected an object.`);
    }
    const nativeKeys = ensureOnlyKeys(value.native, ['pluginId', 'installedByAw'], `${context}.native`);
    if (!nativeKeys.ok) {
      return nativeKeys;
    }
    if (!isNonEmptyString(value.native.pluginId) || typeof value.native.installedByAw !== 'boolean') {
      return fail('invalidInstallRecord', `Invalid ${context}.native: expected pluginId and installedByAw.`);
    }
  }
  if (!Array.isArray(value.artifacts)) {
    return fail('invalidInstallRecord', `Invalid ${context}.artifacts: expected an array.`);
  }
  for (const [index, artifact] of value.artifacts.entries()) {
    const validatedArtifact = validateInstallRecordArtifact(artifact, `${context}.artifacts[${index}]`);
    if (!validatedArtifact.ok) {
      return validatedArtifact;
    }
  }
  if (!Array.isArray(value.dependencyEdges)) {
    return fail('missingDependencyEdges', `Invalid ${context}.dependencyEdges: expected an array.`);
  }
  for (const [index, edge] of value.dependencyEdges.entries()) {
    const validatedEdge = validateInstallDependencyEdge(edge, `${context}.dependencyEdges[${index}]`);
    if (!validatedEdge.ok) {
      return validatedEdge;
    }
  }
  return ok(value as unknown as InstallRecord);
}

export function validateInstallRecordFile(
  value: unknown,
  options: {
    expectedPath?: string;
    awHome?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): ValidationResult<InstallRecordFile> {
  if (!isRecord(value)) {
    return fail('invalidInstallRecordFile', 'Invalid install record file: expected an object.');
  }
  const allowedKeys = ensureOnlyKeys(value, ['version', 'recordId', 'record'], 'install record file');
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (value.version !== 2) {
    return fail('unsupportedVersion', 'Unsupported install record file version: expected version 2.');
  }
  if (!isNonEmptyString(value.recordId)) {
    return fail('invalidInstallRecordFile', 'Invalid install record file.recordId: expected a non-empty string.');
  }
  const record = validateInstallRecord(value.record, 'install record file.record');
  if (!record.ok) {
    return record;
  }
  const location: PluginLocation = {
    plugin: record.value.pluginName,
    platform: record.value.platform,
    scope: record.value.scope,
    ...(record.value.scope === 'project' ? { projectKey: record.value.projectKey } : {}),
  };
  const expectedRecordId = createRecordId(location);
  if (record.value.lifecycle !== undefined) {
    const lifecycle = validateHistoricalLifecycleRuntimeRef(
      record.value.lifecycle,
      'install record file.record.lifecycle',
      {
        awHome: options.awHome,
        env: options.env,
        location,
        recordId: expectedRecordId,
      },
    );
    if (!lifecycle.ok) {
      return lifecycle;
    }
  }
  if (value.recordId !== expectedRecordId) {
    return fail(
      'recordIdMismatch',
      `Invalid install record file.recordId: expected "${expectedRecordId}" for the embedded location.`,
    );
  }
  if (options.expectedPath) {
    const basename = path.basename(options.expectedPath, '.json');
    if (basename !== value.recordId) {
      return fail(
        'recordIdMismatch',
        `Invalid install record file path: file name "${basename}" does not match recordId "${value.recordId}".`,
      );
    }
  }
  return ok(value as unknown as InstallRecordFile);
}

function validateDiagnosticEntry(
  value: unknown,
  context: string,
): ValidationResult<DynamicArtifactDiagnosticEntry> {
  if (!isRecord(value)) {
    return fail('invalidDiagnosticEntry', `Invalid ${context}: expected an object.`);
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    [
      'id',
      'target',
      'state',
      'disabledReason',
      'artifactKey',
      'roleKey',
      'refreshKeys',
      'configDigest',
      'contentDigest',
      'lastRefresh',
      'refreshReach',
    ],
    context,
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (!isNonEmptyString(value.id) || !VALID_ARTIFACT_TARGETS.has(value.target as ArtifactTarget)) {
    return fail('invalidDiagnosticEntry', `Invalid ${context}: expected valid id and target.`);
  }
  if (!VALID_ARTIFACT_STATES.has(value.state as ArtifactState)) {
    return fail('invalidDiagnosticEntry', `Invalid ${context}.state: expected "present" or "disabled".`);
  }
  if (value.disabledReason !== undefined && !isNonEmptyString(value.disabledReason)) {
    return fail('invalidDiagnosticEntry', `Invalid ${context}.disabledReason: expected a non-empty string.`);
  }
  if (value.disabledReason !== undefined && value.state !== 'disabled') {
    return fail('invalidDiagnosticEntry', `Invalid ${context}: disabledReason requires state "disabled".`);
  }
  if (value.artifactKey !== undefined && !isNonEmptyString(value.artifactKey)) {
    return fail('invalidDiagnosticEntry', `Invalid ${context}.artifactKey: expected a non-empty string.`);
  }
  if (value.roleKey !== undefined && !isNonEmptyString(value.roleKey)) {
    return fail('invalidDiagnosticEntry', `Invalid ${context}.roleKey: expected a non-empty string.`);
  }
  if (value.target !== 'codex.agentRole' && value.roleKey !== undefined) {
    return fail('invalidDiagnosticEntry', `Invalid ${context}.roleKey: only codex.agentRole may declare roleKey.`);
  }
  if (value.refreshKeys !== undefined && !isStringArray(value.refreshKeys)) {
    return fail('invalidDiagnosticEntry', `Invalid ${context}.refreshKeys: expected a string array.`);
  }
  if (value.configDigest !== undefined && !isNonEmptyString(value.configDigest)) {
    return fail('invalidDiagnosticEntry', `Invalid ${context}.configDigest: expected a non-empty string.`);
  }
  if (value.contentDigest !== undefined && !isNonEmptyString(value.contentDigest)) {
    return fail('invalidDiagnosticEntry', `Invalid ${context}.contentDigest: expected a non-empty string.`);
  }
  let normalizedValue: Record<string, unknown> = value;
  if (value.lastRefresh !== undefined) {
    if (!isRecord(value.lastRefresh)) {
      return fail('invalidDiagnosticEntry', `Invalid ${context}.lastRefresh: expected an object.`);
    }
    const refreshKeys = ensureOnlyKeys(value.lastRefresh, ['status', 'at', 'event', 'error'], `${context}.lastRefresh`);
    if (!refreshKeys.ok) {
      return refreshKeys;
    }
    const refreshEvent = String(value.lastRefresh.event);
    const normalizedRefreshEvent = VALID_DYNAMIC_DIAGNOSTIC_REFRESH_EVENTS.has(refreshEvent)
      ? refreshEvent
      : LEGACY_DYNAMIC_DIAGNOSTIC_REFRESH_EVENT_ALIASES.get(refreshEvent);
    if (
      (value.lastRefresh.status !== 'success' && value.lastRefresh.status !== 'failed') ||
      !isNonEmptyString(value.lastRefresh.at) ||
      normalizedRefreshEvent === undefined ||
      (value.lastRefresh.error !== undefined && !isNonEmptyString(value.lastRefresh.error))
    ) {
      return fail('invalidDiagnosticEntry', `Invalid ${context}.lastRefresh: unsupported refresh summary.`);
    }
    if (normalizedRefreshEvent !== refreshEvent) {
      normalizedValue = {
        ...normalizedValue,
        lastRefresh: {
          ...value.lastRefresh,
          event: normalizedRefreshEvent,
        },
      };
    }
  }
  if (value.refreshReach !== undefined) {
    if (!isRecord(value.refreshReach)) {
      return fail('invalidDiagnosticEntry', `Invalid ${context}.refreshReach: expected an object.`);
    }
    const reachKeys = ensureOnlyKeys(
      value.refreshReach,
      ['commandScope', 'refreshedUserTarget', 'refreshedCurrentProjectTarget'],
      `${context}.refreshReach`,
    );
    if (!reachKeys.ok) {
      return reachKeys;
    }
    if (
      (value.refreshReach.commandScope !== 'user' && value.refreshReach.commandScope !== 'projectShared') ||
      (value.refreshReach.refreshedUserTarget !== undefined && typeof value.refreshReach.refreshedUserTarget !== 'boolean') ||
      (
        value.refreshReach.refreshedCurrentProjectTarget !== undefined &&
        typeof value.refreshReach.refreshedCurrentProjectTarget !== 'boolean'
      )
    ) {
      return fail('invalidDiagnosticEntry', `Invalid ${context}.refreshReach: unsupported reach metadata.`);
    }
  }
  return ok(normalizedValue as unknown as DynamicArtifactDiagnosticEntry);
}

export function validateDynamicArtifactDiagnosticCache(
  value: unknown,
  options: {
    expectedRecordId?: string;
    expectedLocation?: PluginLocation;
    currentRecord?: InstallRecordFile;
  } = {},
): ValidationResult<DynamicArtifactDiagnosticCache> {
  if (!isRecord(value)) {
    return fail('invalidDiagnosticCache', 'Invalid dynamic artifact diagnostic cache: expected an object.');
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    ['version', 'recordId', 'location', 'updatedAt', 'artifacts'],
    'dynamic artifact diagnostic cache',
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (value.version !== 1) {
    return fail('unsupportedVersion', 'Unsupported dynamic artifact diagnostic cache version: expected version 1.');
  }
  if (!isNonEmptyString(value.recordId) || !isNonEmptyString(value.updatedAt)) {
    return fail('invalidDiagnosticCache', 'Invalid dynamic artifact diagnostic cache: missing recordId or updatedAt.');
  }
  const location = validatePluginLocation(value.location, 'dynamic artifact diagnostic cache.location');
  if (!location.ok) {
    return location;
  }
  if (!Array.isArray(value.artifacts)) {
    return fail('invalidDiagnosticCache', 'Invalid dynamic artifact diagnostic cache.artifacts: expected an array.');
  }
  const artifacts: DynamicArtifactDiagnosticEntry[] = [];
  for (const [index, artifact] of value.artifacts.entries()) {
    const validatedArtifact = validateDiagnosticEntry(artifact, `dynamic artifact diagnostic cache.artifacts[${index}]`);
    if (!validatedArtifact.ok) {
      return validatedArtifact;
    }
    artifacts.push(validatedArtifact.value);
  }
  if (options.expectedRecordId && value.recordId !== options.expectedRecordId) {
    return fail('recordIdMismatch', 'Dynamic diagnostic cache recordId does not match the current install record.');
  }
  if (options.expectedLocation) {
    const expectedLocation = options.expectedLocation;
    const actualLocation = location.value;
    if (
      actualLocation.plugin !== expectedLocation.plugin ||
      actualLocation.platform !== expectedLocation.platform ||
      actualLocation.scope !== expectedLocation.scope ||
      (actualLocation.projectKey ?? null) !== (expectedLocation.projectKey ?? null)
    ) {
      return fail('locationMismatch', 'Dynamic diagnostic cache location does not match the current install record.');
    }
  }
  if (options.currentRecord) {
    const dynamicArtifacts = options.currentRecord.record.artifacts.filter((artifact) =>
      artifact.id !== undefined && artifact.target !== undefined,
    );
    for (const entry of artifacts) {
      const match = dynamicArtifacts.find((artifact) =>
        artifact.id === entry.id &&
        artifact.target === entry.target &&
        (artifact.artifactKey ?? null) === (entry.artifactKey ?? null) &&
        (artifact.roleKey ?? null) === (entry.roleKey ?? null)
      );
      if (!match) {
        return fail(
          'artifactMismatch',
          `Dynamic diagnostic cache entry "${entry.id}" cannot be aligned to the current record artifact identity.`,
        );
      }
    }
  }
  return ok({
    ...value,
    location: location.value,
    artifacts,
  } as unknown as DynamicArtifactDiagnosticCache);
}

export function validateProjectArtifactIdentityFile(
  value: unknown,
  options: {
    projectKey?: string | null;
    cwd?: string;
    homeDir?: string;
    expectedPath?: string;
  } = {},
): ValidationResult<ProjectArtifactIdentityFile> {
  if (!isRecord(value)) {
    return fail('invalidProjectIdentity', 'Invalid project artifact identity file: expected an object.');
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    ['version', 'sharedIdentityId', 'locator', 'source', 'generatedAt', 'artifacts'],
    'project artifact identity file',
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (value.version !== 1) {
    return fail('unsupportedVersion', 'Unsupported project artifact identity file version: expected version 1.');
  }
  if (!isNonEmptyString(value.sharedIdentityId) || !isNonEmptyString(value.generatedAt)) {
    return fail('invalidProjectIdentity', 'Invalid project artifact identity file: missing sharedIdentityId or generatedAt.');
  }
  const locator = validateProjectArtifactSharedLocator(value.locator, {
    projectKey: options.projectKey,
    cwd: options.cwd,
    homeDir: options.homeDir,
  });
  if (!locator.ok) {
    return locator;
  }
  if (!isRecord(value.source)) {
    return fail('invalidProjectIdentity', 'Invalid project artifact identity file.source: expected an object.');
  }
  const sourceKeys = ensureOnlyKeys(value.source, ['pluginVersion', 'manifestDigest', 'bundleFingerprint'], 'project artifact identity file.source');
  if (!sourceKeys.ok) {
    return sourceKeys;
  }
  if (
    !isNonEmptyString(value.source.manifestDigest) ||
    !isNonEmptyString(value.source.bundleFingerprint)
  ) {
    return fail('invalidProjectIdentity', 'Invalid project artifact identity file.source: missing source identity fields.');
  }
  const sourcePluginVersion = validateStrictSemVerString(
    value.source.pluginVersion,
    'project artifact identity file.source.pluginVersion',
  );
  if (!sourcePluginVersion.ok) {
    return sourcePluginVersion;
  }
  if (!Array.isArray(value.artifacts)) {
    return fail('invalidProjectIdentity', 'Invalid project artifact identity file.artifacts: expected an array.');
  }
  for (const [index, artifact] of value.artifacts.entries()) {
    const validatedArtifact = validateProjectArtifactIdentityArtifact(
      artifact,
      `project artifact identity file.artifacts[${index}]`,
    );
    if (!validatedArtifact.ok) {
      return validatedArtifact;
    }
  }
  const expectedId = createSharedIdentityId(locator.value);
  if (value.sharedIdentityId !== expectedId) {
    return fail(
      'sharedIdentityIdMismatch',
      `Invalid project artifact identity file.sharedIdentityId: expected "${expectedId}" for the embedded locator.`,
    );
  }
  if (options.expectedPath) {
    const basename = path.basename(options.expectedPath, '.json');
    if (basename !== value.sharedIdentityId) {
      return fail(
        'sharedIdentityIdMismatch',
        `Invalid project artifact identity file path: file name "${basename}" does not match sharedIdentityId "${value.sharedIdentityId}".`,
      );
    }
  }
  return ok(value as unknown as ProjectArtifactIdentityFile);
}

function validateDependencyIndexRecord(
  value: unknown,
  context: string,
): ValidationResult<GlobalDependencyIndexRecord> {
  if (!isRecord(value)) {
    return fail('invalidDependencyIndex', `Invalid ${context}: expected an object.`);
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    ['location', 'recordPath', 'recordDigest', 'installSource', 'dependencyEdges', 'lastSeenAt'],
    context,
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  const location = validatePluginLocation(value.location, `${context}.location`);
  if (!location.ok) {
    return location;
  }
  if (!isNonEmptyString(value.recordPath) || !path.isAbsolute(value.recordPath)) {
    return fail('invalidDependencyIndex', `Invalid ${context}.recordPath: expected an absolute path.`);
  }
  if (!isNonEmptyString(value.recordDigest) || !isNonEmptyString(value.lastSeenAt)) {
    return fail('invalidDependencyIndex', `Invalid ${context}: missing recordDigest or lastSeenAt.`);
  }
  const installSource = validateInstallSource(value.installSource, `${context}.installSource`);
  if (!installSource.ok) {
    return installSource;
  }
  if (!Array.isArray(value.dependencyEdges)) {
    return fail('invalidDependencyIndex', `Invalid ${context}.dependencyEdges: expected an array.`);
  }
  for (const [index, edge] of value.dependencyEdges.entries()) {
    const validatedEdge = validateInstallDependencyEdge(edge, `${context}.dependencyEdges[${index}]`);
    if (!validatedEdge.ok) {
      return validatedEdge;
    }
  }
  return ok(value as unknown as GlobalDependencyIndexRecord);
}

export function validateGlobalDependencyIndex(
  value: unknown,
): ValidationResult<GlobalDependencyIndex> {
  if (!isRecord(value)) {
    return fail('invalidDependencyIndex', 'Invalid global dependency index: expected an object.');
  }
  const allowedKeys = ensureOnlyKeys(value, ['version', 'updatedAt', 'records'], 'global dependency index');
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (value.version !== 1) {
    return fail('unsupportedVersion', 'Unsupported global dependency index version: expected version 1.');
  }
  if (!isNonEmptyString(value.updatedAt) || !Array.isArray(value.records)) {
    return fail('invalidDependencyIndex', 'Invalid global dependency index: missing updatedAt or records.');
  }
  for (const [index, record] of value.records.entries()) {
    const validatedRecord = validateDependencyIndexRecord(record, `global dependency index.records[${index}]`);
    if (!validatedRecord.ok) {
      return validatedRecord;
    }
  }
  return ok(value as unknown as GlobalDependencyIndex);
}

function looksLikeLegacyBreadcrumb(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    value.platform === 'codex' &&
    value.scope === 'user' &&
    ('state' in value || 'reason' in value || 'nativeWrittenAt' in value || 'marketplaceName' in value)
  );
}

export function validateNativeTransactionMarker(
  value: unknown,
): ValidationResult<NativeTransactionMarker> {
  if (!isRecord(value)) {
    return fail('invalidNativeMarker', 'Invalid native transaction marker: expected an object.');
  }
  if (looksLikeLegacyBreadcrumb(value)) {
    return fail('unsupportedLegacyFormat', 'Legacy Codex breadcrumb is not supported by the install-state marker model.');
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    [
      'version',
      'pluginName',
      'pluginId',
      'platform',
      'scope',
      'operation',
      'nativeWriteSucceeded',
      'createdAt',
      'updatedAt',
      'lastError',
    ],
    'native transaction marker',
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (
    value.version !== 1 ||
    !isNonEmptyString(value.pluginName) ||
    !isNonEmptyString(value.pluginId) ||
    value.platform !== 'codex' ||
    value.scope !== 'user' ||
    (value.operation !== 'install' && value.operation !== 'uninstall') ||
    value.nativeWriteSucceeded !== true ||
    !isNonEmptyString(value.createdAt) ||
    !isNonEmptyString(value.updatedAt) ||
    (value.lastError !== undefined && !isNonEmptyString(value.lastError))
  ) {
    return fail('invalidNativeMarker', 'Invalid native transaction marker payload.');
  }
  if (!String(value.pluginId).endsWith('@aw')) {
    return fail('invalidNativeMarker', 'Invalid native transaction marker.pluginId: expected an @aw id.');
  }
  return ok(value as unknown as NativeTransactionMarker);
}

export function validateSharedSkillTriggerRuntimeOwner(
  value: unknown,
  options: { expectedPath?: string } = {},
): ValidationResult<SharedSkillTriggerRuntimeOwner> {
  if (!isRecord(value)) {
    return fail('invalidSharedOwner', 'Invalid shared runtime owner file: expected an object.');
  }
  const allowedKeys = ensureOnlyKeys(
    value,
    ['version', 'pluginName', 'platform', 'owner', 'ownerRecordPath', 'ownerRecordDigest', 'preference', 'updatedAt'],
    'shared runtime owner file',
  );
  if (!allowedKeys.ok) {
    return allowedKeys;
  }
  if (
    value.version !== 1 ||
    !isNonEmptyString(value.pluginName) ||
    !isNonEmptyString(value.ownerRecordPath) ||
    !path.isAbsolute(value.ownerRecordPath) ||
    !isNonEmptyString(value.ownerRecordDigest) ||
    !isNonEmptyString(value.updatedAt)
  ) {
    return fail('invalidSharedOwner', 'Invalid shared runtime owner file payload.');
  }
  const platform = validatePlatform(value.platform, 'shared runtime owner file.platform');
  if (!platform.ok) {
    return platform;
  }
  const owner = validatePluginLocation(value.owner, 'shared runtime owner file.owner');
  if (!owner.ok) {
    return owner;
  }
  if (owner.value.plugin !== value.pluginName || owner.value.platform !== value.platform) {
    return fail('invalidSharedOwner', 'Invalid shared runtime owner file: owner location must match pluginName and platform.');
  }
  if (value.preference !== undefined) {
    const preference = validateSkillTriggerPreference(value.preference, 'shared runtime owner file.preference');
    if (!preference.ok) {
      return preference;
    }
  }
  if (options.expectedPath) {
    const expectedFileName = getSharedRuntimeOwnerFileName(value.pluginName);
    if (path.basename(options.expectedPath) !== expectedFileName) {
      return fail(
        'sharedOwnerFileNameMismatch',
        `Invalid shared runtime owner file path: expected "${expectedFileName}".`,
      );
    }
  }
  return ok(value as unknown as SharedSkillTriggerRuntimeOwner);
}
