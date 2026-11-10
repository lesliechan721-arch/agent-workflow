import type { AwSelfCheckResult, AwSelfDescribeResult, PluginRequirementsResult } from '../commands/aw-capabilities.js';
import type { CatalogSourceMutationReceipt } from '../commands/catalog-source.js';
import type { CatalogGenerationStatusEntry } from '../utils/catalog-generation-service.js';
import type { CatalogGenerationSyncResult, ConfigApplyResult, CommandProducerResult, CatalogSourceImpact } from '../types.js';
import type { CatalogStoreStatusResult, CatalogStorePruneResult } from '../commands/catalog-store.js';
import type { ReviewInspectionReceipt } from '../commands/review-inspection.js';
import type { ReviewPreparationV1 } from '../commands/review-preparation.js';
import type { PrepareSkillEvalReceipt } from '../commands/skill-eval.js';
import type { CatalogStatusReceipt } from '../commands/catalog-status.js';
import type { CatalogPublishPlanReceipt, CatalogPublishApplyReceipt } from '../commands/catalog-publish.js';
import type { CatalogDevActivateReceipt, CatalogDevStatusReceipt, CatalogDevDeactivateReceipt } from '../commands/catalog-dev-source.js';
import type { CommandManagementResult } from '../commands/managed-commands.js';
import type { PluginCapabilitiesResult } from '../commands/plugin-capabilities.js';
import type { PortableMaterializeReceipt } from '../portable/commands.js';
import type { RecoveryReceipt } from '../recovery/receipt.js';
import { projectTarget } from '../commands/public-lifecycle-result.js';
import { commandResult, safePublicMessage, type CommandResult, type Confirmation, type Diagnostic, type NextAction } from './public-result.js';

type RecordValue = Record<string, unknown>;
/** Pick only the declared domain DTO members. Never spread a service result. */
function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]])) as Pick<T, K>;
}
function record(value: unknown): RecordValue { return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Error) ? value as RecordValue : {}; }
function list(value: unknown): RecordValue[] { return Array.isArray(value) ? value.map(record) : []; }
function mapField(data: RecordValue, key: string, project: (value: RecordValue) => object): void {
  if (Array.isArray(data[key])) data[key] = list(data[key]).map(project);
  else if (data[key] !== undefined && data[key] !== null) data[key] = project(record(data[key]));
}
function message(value: unknown, code: string, publicRoots: readonly string[] = []): string {
  // Legacy domain messages can contain translated text, exception paths, or script output.
  // Their stable codes remain usable; only safe English messages cross this boundary.
  const text = typeof value === 'string' ? value : '';
  if (!text || /[\u3400-\u9fff]/u.test(text)) return `The operation reported ${code}.`;
  return safePublicMessage(text.replace(/\n\s*at\s[\s\S]*/u, '')
    .replace(/(^|[\s"'`(])((?:\/[^\s"'`),;]+|[A-Za-z]:\\[^\s"'`),;]+))/gu, (_match, prefix: string, location: string) =>
      `${prefix}${!location.split(/[\\/]/u).includes('..') && publicRoots.some((root) => location === root || location.startsWith(`${root}/`) || location.startsWith(`${root}\\`)) ? location : '<path>'}`), code);
}
function diagnostic(value: unknown, severity: Diagnostic['severity'] = 'error', subject?: Diagnostic['subject'], publicRoots: readonly string[] = []): Diagnostic {
  const entry = typeof value === 'string' ? { message: value } : record(value);
  const code = typeof entry.code === 'string' ? entry.code : severity === 'warning' ? 'commandWarning' : 'commandFailed';
  const identity = { ...subject, ...pick(entry, ['pluginId', 'sourceId', 'scope', 'field']),
    ...(typeof entry.plugin === 'string' ? { pluginId: entry.plugin } : {}) } as Diagnostic['subject'];
  return { code, severity: entry.blocking === false || entry.severity === 'warning' ? 'warning' : severity,
    message: message(entry.message, code, publicRoots), ...(Object.keys(identity!).length ? { subject: identity } : {}) };
}
function issue(value: RecordValue): RecordValue {
  return { ...pick(value, ['code', 'path', 'blocking', 'stage', 'severity']), ...(typeof value.subject === 'string' ? { subject: value.subject } : {}), message: message(value.message, String(value.code ?? 'commandFailed')) };
}
function configIssue(value: RecordValue): RecordValue {
  return { ...pick(value, ['type', 'code', 'key', 'source', 'path']), message: message(value.message, String(value.code ?? 'configInvalid')) };
}
function configField(value: RecordValue): RecordValue {
  const data = pick(value, ['key', 'title', 'kind', 'reserved', 'writable', 'canSet', 'canUnset', 'valueState', 'effectiveValue', 'sourceLayer', 'storedValue', 'storedSourceLayer', 'invalidOverride', 'fallback', 'value', 'source', 'matchedPreset', 'valid', 'issues']);
  mapField(data, 'issues', configIssue);
  for (const key of ['invalidOverride', 'fallback']) mapField(data, key, (entry) => {
    const result = pick(entry, ['state', 'sourceLayer', 'effectiveValue', 'issues']);
    mapField(result, 'issues', configIssue); return result;
  });
  return data;
}
function configDefinition(value: RecordValue): RecordValue {
  const data = pick(value, ['type', 'title', 'description', 'default', 'required', 'sensitive', 'const', 'valueRef', 'choices', 'validation', 'properties', 'additionalProperties', 'variants', 'items']);
  mapField(data, 'valueRef', (entry) => pick(entry, ['plugin', 'field', 'key', 'label', 'include']));
  mapField(data, 'choices', (entry) => ({ allowCustom: entry.allowCustom, presets: list(entry.presets).map((preset) => pick(preset, ['id', 'title', 'description', 'value', 'recommended'])) }));
  mapField(data, 'validation', (entry) => {
    const validation = pick(entry, ['minLength', 'maxLength', 'pattern', 'format', 'integer', 'minimum', 'maximum', 'multipleOf', 'minProperties', 'maxProperties', 'key', 'minItems', 'maxItems', 'uniqueItems', 'uniqueBy']);
    mapField(validation, 'key', (key) => pick(key, ['minLength', 'maxLength', 'pattern', 'format'])); return validation;
  });
  if (data.properties) data.properties = Object.fromEntries(Object.entries(record(data.properties)).map(([key, field]) => [key, configDefinition(record(field))]));
  if (data.additionalProperties && typeof data.additionalProperties === 'object') data.additionalProperties = configDefinition(record(data.additionalProperties));
  if (data.items) data.items = configDefinition(record(data.items));
  mapField(data, 'variants', (entry) => {
    const variant = (value: unknown) => ({ properties: Object.fromEntries(Object.entries(record(record(value).properties)).map(([key, field]) => [key, configDefinition(record(field))])) });
    return { ...pick(entry, ['discriminator', 'missing']), cases: Object.fromEntries(Object.entries(record(entry.cases)).map(([key, value]) => [key, variant(value)])), ...(entry.otherwise ? { otherwise: variant(entry.otherwise) } : {}) };
  });
  return data;
}
function nativeClosure(value: RecordValue): RecordValue {
  return { reader: value.reader, definitions: list(value.definitions).map((entry) => pick(entry, ['key', 'protocol'])), consumers: list(value.consumers).map((entry) => ({ ...pick(entry, ['kind', 'key']), tools: list(entry.tools).map((tool) => pick(tool, ['key', 'platforms', 'policy', 'fallback'])) })) };
}
function nativeChange(value: RecordValue): RecordValue {
  return { producer: producer(record(value.producer)), before: value.before === null ? null : nativeClosure(record(value.before)), after: value.after === null ? null : nativeClosure(record(value.after)) };
}
function versionCheck(value: RecordValue): RecordValue {
  const data: RecordValue = pick(value, ['plugin', 'ok', 'status', 'baseVersion', 'currentVersion', 'baseTarget', 'currentTarget', 'productionChanged', 'baseDigest', 'currentDigest', 'changedPaths', 'warnings', 'errors']);
  for (const key of ['warnings', 'errors']) if (Array.isArray(data[key])) data[key] = (data[key] as unknown[]).map((entry) => typeof entry === 'string' ? message(entry, 'pluginVersionCheck') : issue(record(entry)));
  return data;
}
function versionReport(value: RecordValue): RecordValue {
  const data = pick(value, ['schemaVersion', 'policy', 'ok', 'base', 'requestedBase', 'baseCommit', 'checkedPlugins', 'checks']);
  mapField(data, 'base', (entry) => pick(entry, ['requested', 'commit']));
  mapField(data, 'checks', versionCheck);
  return data;
}
function producer(value: RecordValue): RecordValue {
  return pick(value, ['sourceId', 'sourceIdentity', 'pluginName', 'kind', 'key', 'scope', 'projectRoot', 'platform', 'placementKey']);
}
function commandResults(values: CommandProducerResult[] | undefined, diagnostics: Diagnostic[]): unknown {
  return values?.map((entry) => {
    const subject = { pluginId: `${entry.producer.sourceId}/${entry.producer.pluginName}`, scope: entry.producer.scope };
    diagnostics.push(...entry.errors.map((error) => diagnostic(error, 'error', subject)));
    return { ...pick(entry, ['state', 'commandIds', 'removedCommandIds']), producer: producer(record(entry.producer)), errors: entry.errors.map((error) => issue(record(error))), blockerCodes: entry.errors.map((error) => error.code) };
  });
}
function applyResult(value: ConfigApplyResult, diagnostics: Diagnostic[]): RecordValue {
  const data: RecordValue = pick(value as ConfigApplyResult & { reason?: string }, ['state', 'reason']);
  data.targetResults = value.targetResults.map((entry) => {
    const subject = { pluginId: entry.target.pluginId ?? entry.target.pluginName, target: entry.target.platform, scope: entry.target.scope };
    if (entry.errorCode) diagnostics.push(diagnostic({ code: entry.errorCode, message: entry.message }, 'error', subject));
    return { ...pick(entry, ['action', 'state', 'relation', 'requiredBy', 'errorCode']), ...(entry.message ? { message: message(entry.message, entry.errorCode ?? 'configApplyFailed') } : {}), target: pick(entry.target, ['pluginName', 'pluginId', 'platform', 'scope']),
      ...(entry.errorCode ? { blockerCodes: [entry.errorCode] } : {}) };
  });
  if ('error' in value && value.error) { data.error = issue(record(value.error)); diagnostics.push(diagnostic(value.error)); }
  if ('errors' in value && value.errors) { data.errors = value.errors.map((entry) => issue(record(entry))); diagnostics.push(...value.errors.map((entry) => diagnostic(entry))); }
  if (value.commandResults) data.commandResults = commandResults(value.commandResults, diagnostics);
  return data;
}
function sourceImpact(value: RecordValue): RecordValue {
  const data = pick(value, ['impactSchemaVersion', 'inventorySchemaVersion', 'sourceId', 'inventoryComplete', 'primaryChange', 'references', 'affectedReferences', 'changes', 'errors']);
  mapField(data, 'primaryChange', (entry) => pick(entry, ['fromSourceId', 'toSourceId']));
  for (const key of ['references', 'affectedReferences']) mapField(data, key, (entry) => pick(entry, ['category', 'sourceId', 'pluginId', 'platform', 'scope', 'projectRecord', 'marketplaceName']));
  mapField(data, 'changes', (entry) => {
    const changes = pick(entry, ['added', 'removed', 'changed', 'newlyIncompatible', 'dependencyChanged', 'platformSupportChanged']);
    mapField(changes, 'platformSupportChanged', (change) => pick(change, ['pluginId', 'removedPlatforms', 'addedPlatforms']));
    return changes;
  });
  mapField(data, 'errors', (entry) => ({ ...pick(entry, ['code', 'kind']), ...(entry.relevance ? { relevance: pick(record(entry.relevance), ['global', 'sourceId', 'pluginName', 'platform', 'scope']) } : {}) }));
  return data;
}
function active(value: RecordValue): RecordValue { return pick(value, ['sourceConfigFingerprint', 'sourceIdentity', 'requestedRef', 'resolvedCommit', 'logicalIdentity', 'manifestDigest', 'snapshotDigest', 'activatedAt']); }
function resolution(value: RecordValue): RecordValue { return pick(value, ['sourceIdentity', 'logicalIdentity', 'catalogVersion', 'channel', 'requestedRef', 'resolvedCommit', 'manifestDigest', 'snapshotDigest']); }
function compatibility(value: RecordValue): RecordValue { return pick(value, ['state', 'requiredCapabilities', 'missingCapabilities']); }
function sourceEntry(value: RecordValue): RecordValue {
  const data: RecordValue = pick(value as unknown as CatalogGenerationStatusEntry, ['sourceId', 'configuredSourceIdentity', 'active', 'activeReady', 'configMatchesActive', 'catalogVersion', 'channel', 'storeKey', 'lastSync', 'compatibility', 'errorCode']);
  if (value.configuration) {
    const configuration = pick(record(value.configuration), ['id', 'type', 'url', 'path', 'refPolicy', 'subdir', 'primary', 'autoCheck', 'sourceIdentity', 'managedBy']);
    mapField(configuration, 'refPolicy', (entry) => pick(entry, ['type', 'ref']));
    mapField(configuration, 'managedBy', (entry) => pick(entry, ['kind', 'workspaceIdentity']));
    data.configuration = configuration;
  }
  mapField(data, 'active', active);
  mapField(data, 'lastSync', (entry) => pick(entry, ['syncedAt', 'mode', 'state', 'resolvedCommit', 'errorCode']));
  mapField(data, 'compatibility', compatibility);
  return data;
}
function reviewSkills(value: RecordValue): RecordValue {
  return { ...pick(value, ['skill', 'sourcePath', 'finalPath', 'digest', 'state', 'evidencePath']), profile: pick(record(value.profile), ['platform', 'scope', 'inputDigest']) };
}
function requirementsObservations(value: RecordValue): RecordValue { return { ...pick(value, ['code', 'blocking', 'path', 'provenance', 'command', 'capability']), message: message(value.message, String(value.code)) }; }

const writeCommands = new Set(['source.add', 'source.update', 'source.remove', 'source.sync', 'cache.prune', 'target.set', 'target.exclude', 'target.include',
  'plugin.config.set', 'plugin.config.unset', 'plugin.config.reset', 'plugin.config.apply', 'command.install', 'command.update', 'command.remove', 'command.package.sync', 'command.package.remove',
  'dev.source.activate', 'dev.source.deactivate', 'dev.plugin.create', 'dev.plugin.remove', 'dev.plugin.build', 'dev.skill.create', 'dev.skill.export', 'dev.catalog.create', 'dev.catalog.version',
  'dev.catalog.build', 'dev.catalog.publish.plan', 'dev.catalog.publish.apply', 'dev.review.prepare', 'dev.eval.prepare', 'dev.plugin.requirements']);
export function isPublicWrite(command: string): boolean { return writeCommands.has(command); }

function projectData(command: string, r: RecordValue, diagnostics: Diagnostic[]): RecordValue {
  switch (command) {
    case 'self.describe': return pick(r as unknown as AwSelfDescribeResult, ['awVersion', 'coreVersion', 'capabilities', 'capabilitySetDigest']);
    case 'self.check': {
      const data: RecordValue = pick(r as unknown as AwSelfCheckResult, ['awVersion', 'coreVersion', 'source', 'plugin', 'requiredCapabilities', 'capabilitySetDigest', 'missingCapabilities', 'observations']);
      mapField(data, 'source', (entry) => pick(entry, ['kind', 'path']));
      mapField(data, 'plugin', (entry) => pick(entry, ['name', 'version']));
      mapField(data, 'observations', requirementsObservations);
      return data;
    }
    case 'dev.plugin.requirements': {
      const data: RecordValue = pick(r as unknown as PluginRequirementsResult, ['plugin', 'pluginDirectory', 'workspaceRoot', 'workspaceRootResolvedFrom', 'mutation', 'declared', 'derived', 'detected', 'effective', 'capabilitySetDigest', 'unsupportedByCurrentAw', 'observations']);
      mapField(data, 'plugin', (entry) => pick(entry, ['name', 'version']));
      mapField(data, 'mutation', (entry) => pick(entry, ['action', 'capability', 'changed']));
      mapField(data, 'observations', requirementsObservations);
      return data;
    }
    case 'dev.plugin.capabilities': {
      const data: RecordValue = pick(r as unknown as PluginCapabilitiesResult, ['awVersion', 'coreVersion', 'surface']);
      if (r.capabilities) data.capabilities = Object.fromEntries(Object.entries(record(r.capabilities)).map(([surface, entries]) => [surface,
        list(entries).map((entry) => pick(entry, ['field', 'type', 'required', 'acceptedValues', 'owner', 'provenance', 'requires', 'conflicts', 'profiles']))]));
      return data;
    }
    case 'source.status': {
      const data = pick(r, ['primarySourceId', 'sources', 'remote', 'complete']);
      mapField(data, 'sources', sourceEntry);
      mapField(data, 'remote', (entry) => {
        const remote = pick(entry, ['sourceId', 'checked', 'candidate', 'outcome']);
        mapField(remote, 'candidate', resolution);
        if (entry.error) diagnostics.push(diagnostic(entry.error, 'error', { sourceId: String(entry.sourceId) }));
        return remote;
      });
      for (const entry of list(r.sources)) if (entry.errorCode) diagnostics.push(diagnostic({ code: entry.errorCode }, 'error', { sourceId: String(entry.sourceId) }));
      return data;
    }
    case 'source.add': case 'source.update': case 'source.remove': {
      const data: RecordValue = pick(r as unknown as CatalogSourceMutationReceipt, ['sourceId', 'changed', 'primarySourceId', 'configDigest', 'primaryChange', 'references']);
      mapField(data, 'primaryChange', (entry) => pick(entry, ['fromSourceId', 'toSourceId']));
      mapField(data, 'references', (entry) => pick(entry, ['category', 'sourceId', 'pluginId', 'platform', 'scope', 'projectRecord', 'marketplaceName']));
      if (r.impact) data.impact = sourceImpact(record(r.impact));
      return data;
    }
    case 'source.sync': {
      const data: RecordValue = pick(r as unknown as CatalogGenerationSyncResult, ['sourceId', 'mode', 'outcome', 'activeChanged', 'resolution', 'active', 'lastSync', 'impact']);
      mapField(data, 'resolution', resolution); mapField(data, 'active', active); mapField(data, 'impact', sourceImpact);
      mapField(data, 'lastSync', (entry) => pick(entry, ['syncedAt', 'mode', 'state', 'resolvedCommit', 'errorCode']));
      return data;
    }
    case 'cache.status': case 'cache.prune': {
      const data: RecordValue = command === 'cache.status'
        ? pick(r as unknown as CatalogStoreStatusResult, ['entries', 'totals'])
        : { ...pick(r as unknown as CatalogStorePruneResult, ['dryRun', 'entries', 'deleted', 'retained', 'reclaimableBytes', 'deletedBytes']), preview: r.dryRun === true };
      mapField(data, 'entries', (entry) => pick(entry, ['storeKey', 'category', 'status', 'generationReference', 'ageMs', 'reclaimableBytes', 'reason']));
      mapField(data, 'totals', (entry) => pick(entry, ['entries', 'reclaimableEntries', 'reclaimableBytes']));
      mapField(data, 'deleted', (entry) => pick(entry, ['storeKey', 'bytes']));
      mapField(data, 'retained', (entry) => pick(entry, ['storeKey', 'reason']));
      return data;
    }
    case 'target.list': case 'target.set': case 'target.exclude': case 'target.include': {
      // Recovery's backend member includes live execution details and is intentionally not projected.
      const recovery = r as unknown as RecoveryReceipt;
      const data: RecordValue = pick(r, ['scope', 'policy', 'preferencesChanged', 'allSatisfied', 'inSync', 'outputsMayHaveChanged']);
      if (r.policy) data.policy = pick(record(r.policy), ['schemaVersion', 'targets', 'exclusions']);
      if (Array.isArray(r.availability)) data.availability = list(r.availability).map((entry) => ({
        ...pick(entry, ['id', 'platform', 'displayName', 'selected', 'availability', 'recovery']),
        installations: list(entry.installations).map((product) => pick(product, ['id', 'product', 'version', 'availability', 'reasonCodes', 'entry'])),
        diagnostics: list(entry.diagnostics).map((item) => diagnostic(item, 'warning')),
      }));
      if (r.selection) data.selection = { targets: record(r.selection).agents, ...pick(record(r.selection), ['origin', 'preferences']) };
      if (r.intent) data.requirements = pick(record(r.intent), ['state', 'digest', 'roots']);
      if (recovery.targetResults) data.targetResults = recovery.targetResults.map((entry) => {
        diagnostics.push(...entry.blockers.map((error) => diagnostic(error, 'error', { pluginId: entry.pluginId, target: entry.agent, scope: entry.scope })));
        return projectTarget(entry);
      });
      if (recovery.remainingTargets) data.remainingTargets = recovery.remainingTargets.map((entry) => ({ pluginId: entry.pluginId, target: entry.agent, scope: entry.scope }));
      if (recovery.requestedTargets) data.requestedTargets = recovery.requestedTargets.map((entry) => ({ pluginId: entry.pluginId, target: entry.agent, scope: entry.scope, delivery: entry.delivery }));
      if (recovery.coverage) data.coverage = { scopes: recovery.coverage.scopes, currentProject: recovery.coverage.scopes.includes('project'), otherProjects: 'unobserved' };
      if (recovery.commandResults) data.commandResults = commandResults(recovery.commandResults, diagnostics);
      if (recovery.nativeToolChanges) data.nativeToolChanges = recovery.nativeToolChanges.map((entry) => nativeChange(record(entry)));
      if (r.apply) data.apply = projectData(command, record(r.apply), diagnostics);
      return data;
    }
    case 'plugin.config.schema': case 'plugin.config.get': case 'plugin.config.set': case 'plugin.config.unset': case 'plugin.config.reset': case 'plugin.config.apply': {
      const data: RecordValue = pick(r, ['configSchemaVersion', 'plugin', 'pluginName', 'pluginId', 'sourceId', 'sourceIdentity', 'scope', 'platform', 'schema', 'fields', 'key', 'configWrite', 'affectedFields', 'removedKey', 'existed', 'deleted', 'resetDisposition', 'quarantineBasename', 'updatedKeys', 'removedKeys', 'effective', 'otherProjectsMayRequireSync', 'staleRemovedKeys']);
      if (typeof r.context === 'string') data.context = r.context;
      else if (r.context) data.context = pick(record(r.context), ['context', 'projectRoot']);
      if (r.apply) data.apply = applyResult(r.apply as ConfigApplyResult, diagnostics);
      mapField(data, 'schema', (entry) => pick(entry, ['source', 'platform', 'identity', 'pluginVersion', 'manifestDigest']));
      if (command === 'plugin.config.schema' && data.fields) data.fields = Object.fromEntries(Object.entries(record(data.fields)).map(([key, value]) => [key, configDefinition(record(value))]));
      else mapField(data, 'fields', configField);
      for (const field of list(r.fields)) for (const entry of list(field.issues)) {
        diagnostics.push(diagnostic({ ...entry, code: entry.code ?? entry.type ?? 'configInvalid' }, 'error', {
          ...(typeof r.pluginId === 'string' ? { pluginId: r.pluginId } : {}), field: String(field.key),
        }));
      }
      for (const entry of list(record(r.effective).issues)) diagnostics.push(diagnostic({ ...entry, code: entry.code ?? entry.type ?? 'configInvalid' }, 'error', {
        ...(typeof r.pluginId === 'string' ? { pluginId: r.pluginId } : {}), ...(typeof entry.key === 'string' ? { field: entry.key } : {}),
      }));
      mapField(data, 'affectedFields', (entry) => pick(entry, ['key', 'title', 'kind', 'reserved', 'action', 'scope', 'valueState', 'stale']));
      return data;
    }
    case 'dev.review.inspect': case 'dev.review.prepare': {
      const data: RecordValue = command === 'dev.review.inspect'
        ? pick(r as unknown as ReviewInspectionReceipt, ['view', 'target', 'sources', 'snapshot', 'skills', 'issues'])
        : pick(r as unknown as ReviewPreparationV1, ['target', 'sourceBindingPath', 'skills', 'issues']);
      mapField(data, 'target', (entry) => pick(entry, ['kind', 'path']));
      mapField(data, 'snapshot', (entry) => pick(entry, ['path', 'state']));
      mapField(data, 'skills', reviewSkills); mapField(data, 'issues', issue);
      return data;
    }
    case 'dev.eval.prepare': return pick(r as unknown as PrepareSkillEvalReceipt, ['suite', 'profile', 'platform', 'specPath', 'targetDigest', 'corpusDigest', 'sourceBindingPath', 'workspacePath']);
    case 'dev.eval.check': {
      const data = pick(r, ['providers', 'codex', 'credentials', 'permission', 'keychain', 'processManagement', 'cleanup']);
      mapField(data, 'codex', (entry) => ({ ...pick(entry, ['requestedExecutable', 'resolvedExecutable']), runtimeConfig: pick(record(entry.runtimeConfig), ['model', 'modelProvider', 'credentialSource']) }));
      mapField(data, 'credentials', (entry) => pick(entry, ['name', 'present']));
      mapField(data, 'permission', (entry) => pick(entry, ['profile', 'status']));
      mapField(data, 'keychain', (entry) => pick(entry, ['platform', 'status']));
      mapField(data, 'processManagement', (entry) => pick(entry, ['managedAvailable', 'unmanagedAvailable', 'defaultMode']));
      mapField(data, 'cleanup', (entry) => pick(entry, ['platform', 'supported', 'mechanism']));
      return data;
    }
    case 'dev.skill.export': {
      const data: RecordValue = pick(r as unknown as PortableMaterializeReceipt, ['plugin', 'platform', 'scope', 'out', 'selectedSkills', 'requestedSkills', 'dependencies', 'configDigest', 'materializationDigest', 'outputDigest', 'sourceBindingPath']);
      mapField(data, 'plugin', (entry) => pick(entry, ['id', 'sourceId', 'sourceIdentity', 'version']));
      mapField(data, 'selectedSkills', (entry) => pick(entry, ['name', 'description', 'shortDescription', 'shortDescriptionSource', 'providerPluginId', 'providerDisplayName', 'relation', 'dynamic', 'filesDigest', 'configDigest']));
      return data;
    }
    case 'dev.catalog.status': {
      const data: RecordValue = pick(r as unknown as CatalogStatusReceipt, ['workspaceRoot', 'workspaceRootResolvedFrom', 'workspace', 'catalog', 'plugins', 'dependencyGraph', 'git', 'snapshot', 'issues']);
      mapField(data, 'workspace', (entry) => pick(entry, ['root', 'resolvedFrom', 'valid', 'identity']));
      mapField(data, 'catalog', (entry) => pick(entry, ['valid', 'version', 'channel', 'ownerName', 'ownerUrl', 'displayName']));
      mapField(data, 'plugins', (entry) => pick(entry, ['name', 'version', 'dependencies', 'sourceValid']));
      mapField(data, 'dependencyGraph', (entry) => pick(entry, ['valid', 'order']));
      mapField(data, 'git', (entry) => pick(entry, ['checked', 'sourceHead', 'clean']));
      mapField(data, 'snapshot', (entry) => pick(entry, ['path', 'state', 'valid', 'catalogVersion', 'snapshotDigest', 'sourceIdentityMatches']));
      mapField(data, 'issues', issue);
      return data;
    }
    case 'dev.catalog.publish.plan': case 'dev.catalog.publish.apply': {
      const data: RecordValue = pick(r as unknown as CatalogPublishPlanReceipt, ['workspaceRoot', 'workspaceRootResolvedFrom', 'workspaceIdentity', 'catalogVersion', 'channel', 'remote', 'remoteResolvedFrom', 'remoteUrl', 'fetchUrl', 'pushUrl', 'branch', 'branchResolvedFrom', 'parent', 'tag', 'expectedCommit', 'sourceHead', 'pluginCount', 'snapshotDigest', 'planDigest', 'descriptor', 'state']);
      mapField(data, 'descriptor', (entry) => ({ ...pick(entry, ['schemaVersion', 'workspaceIdentity', 'sourceHead', 'branch', 'parent', 'tag', 'snapshotDigest']), remote: pick(record(entry.remote), ['name', 'identityDigest']) }));
      if (command === 'dev.catalog.publish.apply') {
        Object.assign(data, pick(r as unknown as CatalogPublishApplyReceipt, ['commit', 'reconciliation']));
        Object.assign(data, pick(r, ['journalState', 'remoteWriteAttempted', 'remoteVerified']));
      }
      else data.prepared = r.ok === true;
      return data;
    }
    case 'dev.source.activate': case 'dev.source.status': case 'dev.source.deactivate': {
      const data: RecordValue = command === 'dev.source.activate' ? pick(r as unknown as CatalogDevActivateReceipt, ['state', 'workspaceIdentity', 'snapshot', 'source', 'active'])
        : command === 'dev.source.status' ? pick(r as unknown as CatalogDevStatusReceipt, ['ready', 'workspaceIdentity', 'snapshot', 'source', 'active', 'issues'])
          : pick(r as unknown as CatalogDevDeactivateReceipt, ['state', 'workspaceIdentity', 'source', 'replacementPrimarySourceId', 'impact']);
      mapField(data, 'snapshot', (entry) => pick(entry, ['action', 'digest', 'state', 'valid']));
      mapField(data, 'source', (entry) => pick(entry, ['id', 'action', 'primary', 'exists', 'pathMatches', 'previousPrimary']));
      mapField(data, 'active', (entry) => {
        const result = pick(entry, ['ready', 'snapshotDigest', 'exists', 'digestMatchesSnapshot', 'compatibility']);
        mapField(result, 'compatibility', compatibility); return result;
      });
      mapField(data, 'issues', issue); mapField(data, 'impact', sourceImpact);
      return data;
    }
    case 'command.install': case 'command.update': case 'command.remove': case 'command.list': case 'command.show': case 'command.package.sync': case 'command.package.remove': {
      const data: RecordValue = pick(r as unknown as CommandManagementResult, ['commands', 'packages', 'changes', 'nativeToolChanges']);
      mapField(data, 'commands', (entry) => {
        const result: RecordValue = pick(entry, ['id', 'name', 'availability', 'resourceRoot', 'launch']);
        const owner = record(entry.owner);
        result.owner = { kind: owner.kind, ...(owner.producer ? { producer: producer(record(owner.producer)) } : {}) };
        mapField(result, 'launch', (launch) => pick(launch, ['runner', 'entry', 'args', 'env', 'envFrom', 'cwd']));
        diagnostics.push(...list(entry.errors).map((error) => diagnostic(error)));
        result.blockerCodes = list(entry.errors).map((error) => error.code);
        result.errors = list(entry.errors).map(issue);
        return result;
      });
      mapField(data, 'packages', (entry) => {
        diagnostics.push(...list(entry.errors).map((error) => diagnostic(error)));
        return { ...pick(entry, ['id', 'availability', 'resourceRoot']), producer: producer(record(entry.producer)), sets: list(entry.sets).map((set) => pick(set, ['set', 'state', 'commandIds'])), errors: list(entry.errors).map(issue), blockerCodes: list(entry.errors).map((error) => error.code) };
      });
      mapField(data, 'changes', (entry) => pick(entry, ['kind', 'id', 'action']));
      mapField(data, 'nativeToolChanges', nativeChange);
      return data;
    }
    // These authoring tools return JSON DTOs, not runtime objects. Their paths are
    // explicitly requested source/output artifacts and remain part of the contract.
    case 'dev.plugin.create': return pick(r, ['pluginName', 'pluginRoot', 'workspaceRoot', 'workspaceRootResolvedFrom', 'files', 'created', 'version']);
    case 'dev.skill.create': return pick(r, ['pluginName', 'skillName', 'skillDirectory', 'workspaceRoot', 'workspaceRootResolvedFrom', 'created', 'files']);
    case 'dev.plugin.remove': {
      const data = pick(r, ['workspaceRoot', 'workspaceRootResolvedFrom', 'baseCommit', 'plugin', 'removed']);
      mapField(data, 'plugin', (entry) => pick(entry, ['name', 'version', 'root'])); return data;
    }
    case 'dev.plugin.status': {
      const data = pick(r, ['policy', 'base', 'requestedBase', 'baseCommit', 'checkedPlugins', 'checks', 'workspaceRoot', 'workspaceRootResolvedFrom']);
      mapField(data, 'base', (entry) => pick(entry, ['requested', 'commit']));
      mapField(data, 'checks', (entry) => {
        for (const error of Array.isArray(entry.errors) ? entry.errors : []) diagnostics.push(diagnostic(error, 'error', { pluginId: String(entry.plugin) }));
        return versionCheck(entry);
      }); return data;
    }
    case 'dev.plugin.validate': {
      const data = pick(r, ['profile', 'claudeSkillProfile', 'pluginDirectory', 'workspaceRoot', 'workspaceRootResolvedFrom', 'versionCheck', 'plugin', 'missingCapabilities', 'availableCapabilities']);
      mapField(data, 'versionCheck', versionReport); return data;
    }
    case 'dev.skill.validate': return pick(r, ['skillDirectory', 'frontmatterProfile', 'codexMetadata']);
    case 'dev.plugin.build': return pick(r, ['workspaceRoot', 'workspaceRootResolvedFrom', 'pluginName', 'outputRoot', 'dependencies', 'digest']);
    case 'dev.plugin.test': return pick(r, ['workspaceRoot', 'workspaceRootResolvedFrom', 'pluginName', 'exitCode']);
    case 'dev.catalog.create': return pick(r, ['workspaceRoot', 'workspaceRootResolvedFrom', 'metadataPath', 'catalogVersion']);
    case 'dev.catalog.version': return pick(r, ['workspaceRoot', 'workspaceRootResolvedFrom', 'catalogVersion', 'changed']);
    case 'dev.catalog.build': return pick(r, ['workspaceRoot', 'workspaceRootResolvedFrom', 'outputRoot', 'catalogVersion', 'channel', 'pluginNames']);
    case 'dev.catalog.validate': return pick(r, ['snapshotDirectory', 'catalogVersion', 'channel', 'snapshotDigest']);
    default: throw new Error(`No public result projection is defined for ${command}.`);
  }
}

const confirmationCodes = new Set(['confirmationRequired', 'catalogImpactConfirmationRequired', 'catalogSourceImpactConfirmationRequired', 'catalogSourceIdentityChangeConfirmationRequired', 'preApplyAuthorizationRequired', 'sharedNativeConfigApplyConfirmationRequired', 'nativeToolAuthorizationRequired', 'sourceRefreshConfirmationRequired']);
const blockedCodes = new Set([...confirmationCodes, 'operationReviewStale', 'reviewStale', 'catalogSourceUnavailable', 'catalogGenerationUnavailable', 'catalogGenerationSourceMissing', 'catalogGenerationIdentityMismatch', 'catalogGenerationReviewStale', 'catalogReplaceDamagedRequired', 'catalogGenerationActiveComparisonUnavailable', 'catalogLogicalIdentityChanged', 'catalogVersionConflict', 'catalogRollbackDetected', 'sourceMissing', 'sourceChanged', 'configSchemaUnavailable', 'schemaUnavailable', 'configUnavailable', 'projectRootUnavailable', 'awCapabilityUnsupported', 'commandNotFound', 'commandOwnerMismatch', 'commandIdentityConflict', 'commandResourceInvalid', 'commandBindingInvalid', 'managedSourceProtected', 'dependencyStillRequired', 'identityMismatch', 'catalogWorkspaceMissing', 'portableOutputConflict', 'portableUnsupported', 'requiredConfigMissing', 'portableSkillNameConflict', 'portableRuntimeImportMissing']);
function resultStatus(command: string, r: RecordValue, diagnostics: Diagnostic[], exitCode: number): CommandResult['status'] {
  const unsuccessful = r.ok === false || r.valid === false || exitCode !== 0;
  if (command === 'source.status') {
    const sources = list(r.sources), remote = list(r.remote);
    const failed = sources.filter((entry) => entry.errorCode).length + remote.filter((entry) => entry.checked === false || entry.error).length;
    if (failed) return sources.some((entry) => !entry.errorCode) || remote.some((entry) => entry.checked === true) ? 'partial' : 'blocked';
    return unsuccessful ? 'failed' : 'success';
  }
  if (command === 'cache.status' && unsuccessful) return list(r.entries).some((entry) => entry.status !== 'error') ? 'partial' : 'failed';
  if (command === 'cache.prune') return r.overallState === 'partial' ? 'partial' : unsuccessful ? list(r.deleted).length ? 'partial' : 'failed' : 'success';
  if (command === 'dev.review.inspect' && r.target !== null && Array.isArray(r.skills) && exitCode === 0) return 'success';
  if (command === 'dev.review.prepare' && unsuccessful && list(r.skills).some((entry) => entry.state === 'ready')) return 'partial';
  if (r.overallState === 'partial' || r.state === 'partial') return 'partial';
  if (!unsuccessful) return 'success';
  // A persisted config/preference, an attempted output, or publication uncertainty
  // cannot be collapsed to an uncommitted failure.
  if (r.configWrite === 'succeeded' || r.preferencesChanged === true || r.outputsMayHaveChanged === true || r.activeChanged === true || r.changed === true || r.removed === true || r.state === 'uncertain'
    || list(r.changes).some((entry) => entry.action !== 'retained')
    || list(r.targetResults).some((entry) => ['applied', 'partial', 'failed'].includes(String(entry.execution)))) return 'partial';
  if ((command === 'command.list' || command === 'command.show') && (list(r.commands).length || list(r.packages).length)) return 'partial';
  if (diagnostics.some((entry) => blockedCodes.has(entry.code))) return 'blocked';
  if (command.startsWith('target.') || command.startsWith('source.') || record(r.apply).state === 'unavailable') return 'blocked';
  return exitCode === 3 ? 'blocked' : 'failed';
}
function confirmationFor(command: string, r: RecordValue, yes: boolean, supplied: Confirmation | null | undefined, diagnostics: Diagnostic[]): Confirmation | null {
  if (supplied && r.confirmation) {
    const prepared = r.confirmation as Confirmation;
    return { required: supplied.required || prepared.required, provided: supplied.provided || prepared.provided,
      effects: [...new Map([...supplied.effects, ...prepared.effects].map((effect) => [JSON.stringify(effect), effect])).values()] };
  }
  if (supplied) return supplied;
  if (r.confirmation !== undefined) return r.confirmation as Confirmation | null;
  const missing = diagnostics.some((entry) => confirmationCodes.has(entry.code));
  const sourceId = typeof r.sourceId === 'string' ? r.sourceId : typeof record(r.source).id === 'string' ? String(record(r.source).id) : undefined;
  const pluginId = typeof r.pluginId === 'string' ? r.pluginId : typeof r.plugin === 'string' ? r.plugin : undefined;
  if (command === 'source.sync' && r.impact) {
    const impact = r.impact as CatalogSourceImpact;
    const required = impact.inventoryComplete === false || impact.affectedReferences?.length > 0 || impact.primaryChange !== null && impact.primaryChange !== undefined;
    return { required, provided: yes, effects: required ? [{ code: 'changeSource', message: 'Activate the selected source version and affect its existing references.', subject: { sourceId }, impact: impact.inventoryComplete ? 'user-wide' : 'unknown' }] : [] };
  }
  if (command === 'cache.prune') return r.dryRun === true ? { required: false, provided: yes, effects: [] }
    : { required: true, provided: yes, effects: [{ code: 'removeOwnedOutput', message: 'Delete the selected reclaimable Catalog cache entries.', impact: 'user-wide' }] };
  if (command === 'plugin.config.reset') return { required: true, provided: yes, effects: [{ code: 'deletePluginConfig', message: 'Delete the selected plugin configuration overrides.', subject: { pluginId, scope: 'user' }, impact: 'user-wide' }] };
  if (missing) {
    const source = command.startsWith('source.') || command.startsWith('dev.source.');
    const preApply = diagnostics.some((entry) => entry.code === 'preApplyConfirmationRequired' || entry.code === 'preApplyAuthorizationRequired');
    return { required: true, provided: yes, effects: [{ code: source ? 'changeSource' : preApply ? 'runPreApply' : 'replaceSharedOutput',
      message: source ? 'Change the selected Catalog source and its references.' : preApply ? 'Run the selected plugin preApply script.' : 'Change the selected shared output.',
      subject: source ? { sourceId } : { pluginId, scope: 'user' }, impact: 'unknown' }] };
  }
  const ordinary = new Set(['source.add', 'target.set', 'target.exclude', 'target.include', 'dev.plugin.create', 'dev.skill.create', 'dev.plugin.build', 'dev.skill.export', 'dev.catalog.create', 'dev.catalog.version', 'dev.catalog.build', 'dev.catalog.publish.plan', 'dev.review.prepare', 'dev.eval.prepare', 'dev.plugin.requirements']);
  if (ordinary.has(command) || command.startsWith('plugin.config.') && (!r.apply || record(r.apply).state === 'skipped')) return { required: false, provided: yes, effects: [] };
  // The handler owns prepared impact evidence. Absence is not evidence of no effects.
  return null;
}

function publicationApplyAction(receipt: RecordValue, reason: string): NextAction | undefined {
  if (typeof receipt.workspaceRoot !== 'string' || typeof receipt.remote !== 'string' || typeof receipt.branch !== 'string'
    || typeof receipt.planDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(receipt.planDigest)) return undefined;
  return { kind: 'command', argv: ['aw', 'dev', 'catalog', 'publish', 'apply', '--workspace-root', receipt.workspaceRoot,
    '--remote', receipt.remote, '--branch', receipt.branch, '--expected-plan-digest', receipt.planDigest], reason, requiresConfirmation: true };
}

export function projectReceipt(command: string, input: unknown, options: { yes?: boolean; exitCode?: number; confirmation?: Confirmation | null } = {}): CommandResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The command returned an invalid result.');
  const r = record(input);
  if (r.schemaVersion === 1 && ['success', 'partial', 'blocked', 'failed'].includes(String(r.status)) && r.data && Array.isArray(r.diagnostics) && Array.isArray(r.nextActions)) return input as CommandResult;
  const authorRoots = command.startsWith('dev.') && typeof r.workspaceRoot === 'string' ? [r.workspaceRoot] : [];
  const subject: Diagnostic['subject'] = {
    ...(typeof r.sourceId === 'string' ? { sourceId: r.sourceId } : {}),
    ...(command.startsWith('dev.source.') && typeof record(r.source).id === 'string' ? { sourceId: String(record(r.source).id) } : {}),
    ...(typeof r.pluginId === 'string' ? { pluginId: r.pluginId } : typeof record(r.plugin).id === 'string' ? { pluginId: String(record(r.plugin).id) } : {}),
    ...(r.scope === 'user' || r.scope === 'project' ? { scope: r.scope } : {}),
  };
  const diagnostics = [...(Array.isArray(r.errors) ? r.errors : []), ...(Array.isArray(r.issues) ? r.issues : []), ...(Array.isArray(r.blockers) ? r.blockers : [])].map((entry) => diagnostic(entry, 'error', subject, authorRoots));
  if (r.error || r.ok === false && r.message) diagnostics.push(diagnostic({ code: r.code, message: r.error ?? r.message }, 'error', subject, authorRoots));
  if (Array.isArray(r.warnings)) diagnostics.push(...r.warnings.map((entry) => diagnostic(entry, 'warning', subject, authorRoots)));
  const data = projectData(command, r, diagnostics);
  const capabilityFailure = list(r.errors).find((entry) => entry.code === 'awCapabilityUnsupported');
  if (capabilityFailure) data.compatibility = pick(capabilityFailure, ['missingCapabilities', 'availableCapabilities']);
  if (command === 'self.check' && Array.isArray(r.missingCapabilities) && r.missingCapabilities.length) {
    diagnostics.push(diagnostic({ code: 'awCapabilityUnsupported', message: 'The current AW executable does not support all required capabilities.' }));
  }
  let status = resultStatus(command, r, diagnostics, options.exitCode ?? 0);
  if (isPublicWrite(command)) {
    const confirmation = confirmationFor(command, r, options.yes === true, options.confirmation, diagnostics);
    data.confirmation = confirmation;
    if (confirmation?.required && !confirmation.provided && diagnostics.some((entry) => confirmationCodes.has(entry.code))) {
      if (!diagnostics.some((entry) => entry.code === 'confirmationRequired')) diagnostics.push(diagnostic({ code: 'confirmationRequired', message: 'Repeat the command with --yes to confirm the listed effects.' }));
      if (status !== 'partial') status = 'blocked';
    }
  }
  const result = commandResult(command, data, { status, diagnostics: [...new Map(diagnostics.map((entry) => [JSON.stringify(entry), entry])).values()] });
  if (command === 'target.set' && Array.isArray(r.forceRetry)) result.nextActions.push({ kind: 'command',
    argv: r.forceRetry as string[], reason: 'Save the requested unavailable targets explicitly. Installation requirements still apply.', requiresConfirmation: false });
  if (status === 'success' && command === 'dev.catalog.publish.plan' && r.state === 'prepared') {
    const action = publicationApplyAction(r, 'Apply this exact prepared publication after reviewing its target and digest.');
    if (action) result.nextActions.push(action);
  }
  if (status !== 'success') {
    if (diagnostics.some((entry) => entry.code === 'catalogWorkspaceMissing')) result.nextActions.push({ kind: 'command',
      argv: ['aw', 'dev', 'catalog', 'create'], reason: 'Create a Catalog Workspace explicitly before running authoring commands.', requiresConfirmation: false });
    if (command === 'dev.catalog.publish.apply' && typeof r.planDigest === 'string') {
      const action = publicationApplyAction(r, 'Reconcile the same publication plan before attempting any different publication.');
      if (action) result.nextActions.push(action);
      else result.nextActions.push({ kind: 'manual', message: `Use the original workspace and remote selection to reconcile publication plan ${r.planDigest}. Review its current state before confirming apply.` });
    }
    if (command.startsWith('plugin.config.')) {
      const apply = record(r.apply);
      for (const entry of list(apply.commandResults)) {
        const identity = record(entry.producer);
        if (entry.state !== 'completed' && identity.kind === 'package' && typeof identity.sourceId === 'string'
          && typeof identity.pluginName === 'string' && typeof identity.key === 'string' && (identity.scope === 'user' || identity.scope === 'project')) {
          result.nextActions.push({ kind: 'command', argv: ['aw', 'command', 'package', 'sync', `${identity.sourceId}/${identity.pluginName}`, identity.key, '--scope', identity.scope], reason: 'Repair the affected command package after resolving its diagnostics.', requiresConfirmation: true });
        }
      }
      for (const entry of list(apply.targetResults)) {
        const target = record(entry.target);
        if (entry.state !== 'completed' && (entry.state !== 'skipped' || entry.errorCode) && typeof target.pluginId === 'string' && typeof target.platform === 'string' && (target.scope === 'user' || target.scope === 'project')) {
          result.nextActions.push({ kind: 'command', argv: ['aw', 'plugin', 'sync', target.pluginId, '--context', target.scope, '--target', target.platform], reason: 'Repair the affected deployment target after resolving its diagnostics.', requiresConfirmation: true });
        }
      }
    }
    if (command === 'source.status' || command === 'source.sync') for (const entry of diagnostics) if (entry.subject?.sourceId) result.nextActions.push({ kind: 'command', argv: ['aw', 'source', 'status', entry.subject.sourceId], reason: 'Inspect the selected source before retrying a source change.', requiresConfirmation: false });
    if (!result.nextActions.length) result.nextActions.push({ kind: 'manual', message: status === 'partial' ? 'Review completed and incomplete results before retrying the operation.' : 'Resolve the reported diagnostics before retrying the operation.' });
  }
  return result;
}
