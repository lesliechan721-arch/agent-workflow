// Public AW qualification with real client discovery in a private, credential-free home.
// Expected host paths and gaps are fixed here independently of discovery and planning.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { nativePath, readInstalled, targetOf, nativePackage, checkSettled, writeGrokFixtureFolderDecisions, runGrokCommand, grokUserRegistration } from './native-platform-public-state.mjs';
import { qualifyCatalog, qualifyProjectDependencies } from './native-platform-public-catalog.mjs';
import { executePublicAw, publicAwNodeLauncher } from './native-platform-public-process.mjs';
import { prepareEnvironment, readManagedTrace, repoRoot, sha256, execute, assertCommand, candidateFiles, clients } from './native-platform-runtime.mjs';
import { verifyFixtureRemoval } from './native-platform-public-removal.mjs';

export const componentPlatforms = ['codex', 'claude', 'cursor', 'antigravity', 'opencode', 'pi', 'copilot', 'grok', 'generic'];
const kinds = ['skill', 'agent', 'mcp', 'hook', 'instruction'];
const source = 'matrix';
const names = Object.fromEntries(kinds.map(kind => [kind, 'sample-' + kind]));
const token = (kind, revision) => 'qualification-' + kind + '-revision-' + revision;
const manifestFile = '.agents-plugin/plugin.json';
const cli = path.join(repoRoot, 'packages/cli/dist/index.js');

const specs = [
  ...kinds.map(kind => ({ name: 'single-' + kind, kinds: [kind] })),
  { name: 'mixed-components', kinds },
  { name: 'hook-only', kinds: ['hook'] },
  { name: 'without-skills', kinds: kinds.filter(kind => kind !== 'skill') },
];
const pairPrerequisites = new Map([
  ['pi-pair', 'single-instruction'],
  ['grok-hook-pair', 'single-hook'],
  ['grok-user-hook-pair', 'single-hook'],
  ['grok-rule-pair', 'single-instruction'],
]);
const componentCommands = new Set(['target.set', 'source.add', 'source.sync', 'dev.catalog.create', 'dev.catalog.build',
  'dev.plugin.create', 'plugin.install', 'plugin.remove', 'plugin.status', 'plugin.sync']);
const publicStatusByExitCode = new Map([[0, 'success'], [1, 'failed'], [2, 'failed'], [3, 'blocked'], [4, 'partial']]);
const publicStatuses = new Set(publicStatusByExitCode.values());
const rows = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
const receiptCodes = new Set(['commandFailed', 'operationInterrupted', 'operationPlanStale', 'operationReviewStale',
  'platformPreparationFailed', 'platformExecutionFailed', 'platformMutationFailed', 'platformComponentsUnmet',
  'processCleanupUnconfirmed', 'pluginProcessCleanupFailed', 'nativeCliExecutableMissing', 'nativeCliFailed', 'nativeCliTimedOut',
  'nativeObservationFailed', 'nativeObservationUnconfirmed',
  'preApplyExecutableMissing', 'preApplyInputFailed', 'preApplyStartFailed', 'preApplyTimedOut', 'preApplyExited']);
const deploymentStaleReasons = new Set(['deploymentInputsChanged', 'clientDiscoveryChanged', 'deploymentObservationChanged',
  'deploymentReferencesChanged', 'deploymentPathsChanged', 'marketplaceChanged', 'deploymentEvidenceReadFailed']);
// A few existing reasons distinguish stale checks and cleanup failures without publishing free-form messages.
const receiptReasons = new Set(['operationPlanStale: client discovery changed after the ordinary observation.',
  'operationPlanStale: deployment evidence changed after the ordinary observation.',
  'operationPlanStale: deployment evidence changed before source registration.',
  'operationPlanStale: deployment evidence changed during source registration.',
  'operationPlanStale: deployment evidence changed.',
  'The deployment evidence changed. Prepare and confirm a new operation.',
  'Process cleanup could not be confirmed.',
  'Process cleanup could not be confirmed. Check the client before retrying.',
  'Process cleanup could not be confirmed. Check status before retrying.',
  'The preApply process cleanup could not be confirmed.']);

function componentCommand(args, dependencies) {
  const command = args.slice(0, args[0] === 'dev' ? 3 : 2).join('.');
  const fields = {};
  for (const field of ['scope', 'context']) {
    const index = args.indexOf('--' + field);
    if (index >= 0 && ['project', 'user'].includes(args[index + 1])) fields[field] = args[index + 1];
  }
  if (command === 'target.set') fields.scope = 'user';
  const pluginIds = args.filter(id => dependencies.has(id) && id.length <= 192
    && /^[a-z\d][a-z\d_.-]*\/[a-z\d][a-z\d_.-]*$/iu.test(id)).slice(0, 16);
  return { command: componentCommands.has(command) ? command : 'unknown',
    ...fields, ...(pluginIds.length ? { pluginIds } : {}) };
}

function awProcessCompleted(result) {
  return result && !result.cancelled && !result.timedOut && !result.maxBufferExceeded && !result.signal
    && result.terminationReason === 'complete';
}

function awCommandCompleted(result) {
  return awProcessCompleted(result) && publicStatusByExitCode.has(result.exitCode);
}

function readComponentReceipt(result, command) {
  if (!awProcessCompleted(result) || (!publicStatusByExitCode.has(result.exitCode) && result.exitCode !== 250) || result.stdoutTruncated
    || typeof result.stdout !== 'string' || result.stdout.length > 2 * 1024 * 1024) return undefined;
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { return undefined; }
  if (value?.schemaVersion !== 2 || command === 'unknown' || value.command !== command || !publicStatuses.has(value.status)) return undefined;
  // AW can preserve a business status while overriding its exit to 1 for unconfirmed cleanup.
  const cleanupFailure = Array.isArray(value.diagnostics) && value.diagnostics.some(item => item?.code === 'processCleanupUnconfirmed');
  // The caller accepts Job 250 only as diagnostic evidence after rejecting the outer process.
  if (result.exitCode === 250 || (cleanupFailure ? result.exitCode === 1 : value.status === publicStatusByExitCode.get(result.exitCode))) return value;
}

function receiptDiagnostics(value) {
  const facts = rows(value, 64).filter(item => receiptCodes.has(item?.code)).slice(0, 8).map(item => {
    const reasonCode = item.detail?.reasonCode;
    const safeReason = receiptCodes.has(reasonCode) || item.code === 'operationPlanStale' && deploymentStaleReasons.has(reasonCode);
    return { code: item.code, ...(['error', 'warning', 'info'].includes(item.severity) ? { severity: item.severity } : {}),
      ...(safeReason ? { reasonCode } : {}), ...(receiptReasons.has(item.message) ? { reason: item.message } : {}) };
  });
  return facts.length ? { diagnostics: facts } : {};
}

const grokAvailabilityStates = ['available', 'missing', 'unsupported', 'unknown'];
const grokDiscoveryReasons = ['clientDiscoveryIncomplete', 'clientEntryUnresolved', 'clientIdentityUnconfirmed',
  'clientInstallInterfaceUnsupported', 'clientNotFound', 'clientProbeFailed', 'clientVersionUnknown', 'clientVersionUnsupported'];

function grokTargetAvailability(value) {
  const target = rows(value.data?.availability, 16).find(item => item?.id === 'grok');
  if (!grokAvailabilityStates.includes(target?.availability)) return undefined;
  const diagnosticCodes = rows(target.diagnostics, 8).map(item => item?.code).filter(code => grokDiscoveryReasons.includes(code));
  return { target: 'grok', availability: target.availability, installations: rows(target.installations, 8)
    .filter(item => item?.product === 'cli' && grokAvailabilityStates.includes(item.availability)).map(item => ({
      availability: item.availability, reasonCodes: rows(item.reasonCodes, 8).filter(code => grokDiscoveryReasons.includes(code)),
    })), ...(diagnosticCodes.length ? { diagnosticCodes } : {}) };
}

export function componentReceiptEvidence(value, command, platform) {
  if (!value) return {};
  const requestedScope = ['plugin.install', 'plugin.remove'].includes(command.command) ? command.scope : undefined;
  const targets = rows(value.data?.targetResults, 64).filter(target => command.pluginIds?.includes(target?.pluginId)
    && target.target === platform && ['user', 'project'].includes(target.scope)
    && (!requestedScope || target.scope === requestedScope)).slice(0, 16).map(target => {
    const diagnostics = rows(target.deploymentReceipts, 8).flatMap(receipt => rows(receipt?.diagnostics, 8));
    return { pluginId: target.pluginId, target: platform, scope: target.scope,
      ...(['not-run', 'no-op', 'applied', 'partial', 'failed'].includes(target.execution) ? { execution: target.execution } : {}),
      blockerCodes: rows(target.blockerCodes, 16).filter(code => receiptCodes.has(code)), ...receiptDiagnostics(diagnostics) };
  });
  const targetAvailability = platform === 'grok' && command.command === 'target.set' ? grokTargetAvailability(value) : undefined;
  return { awReceipt: { status: value.status, ...receiptDiagnostics(value.diagnostics), ...(targets.length ? { targets } : {}),
    ...(targetAvailability ? { targetAvailability } : {}) } };
}

const componentTraceCategories = {
  'codex-component-install': ['codex-version', 'codex-plugin-list', 'codex-marketplace-list', 'windows-system-powershell'],
  'grok-component-discovery': ['grok-version', 'grok-help', 'grok-plugin-help', 'grok-plugin-list-help'],
  'claude-component-remove': ['claude-version', 'claude-plugin-list', 'claude-marketplace-list', 'claude-plugin-disable', 'claude-plugin-uninstall'],
};

async function readComponentTrace(file, mode) {
  const { state, records } = await readManagedTrace(file);
  const installation = records.filter(row => ['loading-runner', 'installed', 'runner-install-failed', 'configuration-rejected'].includes(row?.state)
    && row.phase === 'installation').at(-1)?.state;
  return { state, ...(installation ? { installation } : {}), records: records.filter(row => row?.phase === 'finish'
    && componentTraceCategories[mode].includes(row.category)
    && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && typeof row.threw === 'boolean'
    && (row.exitCode === null || Number.isSafeInteger(row.exitCode))).map(row => ({
    category: row.category, elapsedMs: row.elapsedMs, threw: row.threw, exitCode: row.exitCode,
    ...Object.fromEntries(['timedOut', 'cleanupUnconfirmed'].filter(field => typeof row[field] === 'boolean').map(field => [field, row[field]])),
    ...(['timeout', 'aborted', 'exit'].includes(row.reason) ? { reason: row.reason } : {}),
    ...(['nativeCliTimedOut', 'nativeCliFailed', 'nativeCliExecutableMissing'].includes(row.errorCode) ? { errorCode: row.errorCode } : {}),
    ...(['ENOENT', 'EACCES', 'EPERM'].includes(row.causeCode) ? { causeCode: row.causeCode } : {}),
    ...(mode === 'claude-component-remove' && row.cleanupUnconfirmed === true
      && ['identity-lookup', 'marker-lookup', 'inspection-deadline', 'cleanup-deadline', 'process-group-live',
        'process-group-sigterm', 'process-group-sigkill', 'process-group-exit-check', 'child-pid-unavailable'].includes(row.cleanupKind)
      ? { cleanupKind: row.cleanupKind } : {}),
  })) };
}

// These snapshots carry identities, states and timing metadata. Select their
// fields again at the artifact boundary so extra properties cannot publish raw input.
function observationFields(value, fields) {
  return Object.fromEntries(fields.split(' ').flatMap(field => {
    const fact = value?.[field];
    if (fact === null || typeof fact === 'boolean' || Number.isFinite(fact)) return [[field, fact]];
    if (typeof fact === 'string' && (/^[a-z\d_.?+:<>-]{1,128}$/iu.test(fact)
      || ['startTime', 'knownStartTime'].includes(field) && /^[a-z]{3} [a-z]{3} \d{1,2} \d\d:\d\d:\d\d \d{4}$/iu.test(fact))) return [[field, fact]];
    return [];
  }));
}

const processIdentityFields = 'pid ppid pgid state startTime';

function processObservation(row) {
  const affectedPids = rows(row.affectedPids, 32).filter(Number.isSafeInteger);
  const focus = new Set([row.rootPid, ...affectedPids]);
  const processes = (Array.isArray(row.processes) ? row.processes : [])
    .toSorted((left, right) => Number(focus.has(right?.pid)) - Number(focus.has(left?.pid)));
  return { ...observationFields(row, 'capturedAt stage reason rootPid rootPgid rootPgidMode markerLookupSucceeded snapshotStartedAt snapshotDeadline markerLookupAttempts'),
    affectedPids, processes: rows(processes, 32).map(process => observationFields(process, processIdentityFields + ' present knownStartTime markerMatches')),
    ...(processes.length > 32 ? { omittedProcesses: processes.length - 32 } : {}),
    ...(row.lookupFailure ? { lookupFailure: observationFields(row.lookupFailure, 'reason code signal killed') } : {}),
    ...(row.sentinel ? { sentinel: observationFields(row.sentinel, 'pid knownStartTime present startTime identityMatches markerMatches') } : {}),
    ...(row.queries ? { queries: rows(row.queries, 8).map(query => observationFields(query,
      'kind startedAt deadline callbackAt settledAt callbackState completion failureReason')) } : {}) };
}

function componentProcessEvidence(error, response) {
  const result = error?.result ?? response;
  const diagnostics = error?.publicAwProcessDiagnostics?.length ? error.publicAwProcessDiagnostics : error?.processTreeDiagnostics;
  const names = error?.publicAwProcessNames ?? error?.qualificationProcessNames;
  const markerRows = error?.publicAwMarkerRows ?? error?.qualificationMarkerRows;
  const confirmations = error?.qualificationMarkerIdentityConfirmations;
  return {
    ...observationFields(result, 'exitCode timedOut cancelled maxBufferExceeded terminationReason'),
    ...(result?.exitCode === 250 ? {} : observationFields(result, 'descendantCleanupGuaranteed')),
    ...(typeof result?.signal === 'string' && Object.hasOwn(os.constants.signals, result.signal) ? { signal: result.signal } : {}),
    ...(diagnostics?.length ? { processDiagnostics: (diagnostics.length === 1 ? [diagnostics[0]]
      : [diagnostics[0], diagnostics.at(-1)]).map(processObservation) } : {}),
    ...(names?.length ? { processNames: rows(names, 8).map(row => observationFields(row, 'pid processName unavailable startTime source')) } : {}),
    ...(markerRows?.length ? { markerRows: rows(markerRows, 8).map(row => ({
      ...observationFields(row, processIdentityFields + ' queryId queryStartedAt queryCallbackAt queryDeadlineAt unparsedLines source commandForm markerMatches markerAssignmentPresent cacheEvictions queryCandidateCount omittedMatches association'),
      ...(row.startupEnvironment ? { startupEnvironment: observationFields(row.startupEnvironment,
        'source sourceQueryId status markerMatches environmentBytes identity binding startedAt finishedAt') } : {}),
    })) } : {}),
    ...(confirmations ? { markerIdentityConfirmations: { ...observationFields(confirmations, 'source omitted'),
      records: rows(confirmations.records, 8).map(row => observationFields(row, 'rootPid pid startTime phase queryStartedAt queryCompletedAt deadline result')) } } : {}),
  };
}

// Recover only the trust requests actually observed in this isolated Catalog.
export function grokTrustTargets(value, dependencies, alreadyAuthorized) {
  const blocked = value.data.targetResults.filter(target => target.blockerCodes.length);
  const trustReasons = ['nativeTrustRequired', 'dependencyInstallFailed'];
  if (!blocked.length || blocked.some(target => target.target !== 'grok' || target.scope !== 'user' ||
      target.blockerCodes.some(code => !trustReasons.includes(code)) ||
      target.blockerCodes.length > 1 && !(target.execution === 'not-run' && target.blockerCodes.includes('dependencyInstallFailed'))) ||
      value.diagnostics.some(item => item.severity === 'error' && !trustReasons.includes(item.code))) return [];
  const direct = blocked.filter(target => target.blockerCodes.length === 1 && target.blockerCodes[0] === 'nativeTrustRequired'
    && target.execution !== 'not-run');
  if (!direct.length || direct.some(target => !dependencies.has(target.pluginId) || alreadyAuthorized.has(target.pluginId))) return [];
  const blockedIds = new Set(blocked.map(target => target.pluginId));
  const explained = new Set(direct.map(target => target.pluginId));
  for (let previous = -1; previous !== explained.size;) {
    previous = explained.size;
    for (const target of blocked) {
      const causes = (dependencies.get(target.pluginId) ?? []).filter(id => blockedIds.has(id));
      if (causes.length && causes.every(id => explained.has(id))) explained.add(target.pluginId);
    }
  }
  return explained.size === blockedIds.size ? direct : [];
}

async function writeFixture(workspace, scaffold, spec, revision) {
  const directory = path.join(workspace, 'plugins', spec.name);
  const json = async (file, obj) => {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), JSON.stringify(obj, null, 2) + '\n');
  };
  const manifest = { ...scaffold, name: spec.name, version: '0.1.' + revision, platforms: componentPlatforms };
  delete manifest.skills;
  if (spec.dependencies) manifest.dependencies = spec.dependencies;
  const extensions = {};
  if (spec.kinds.includes('agent')) extensions.agents = [{ name: names.agent, description: 'Local fixture.', prompt: token('agent', revision) }];
  if (spec.kinds.includes('instruction')) extensions.instructions = [{ name: names.instruction, title: 'Local fixture',
    content: token('instruction', revision), coverage: ['main'] }];
  if (spec.kinds.includes('hook')) extensions.hooks = [{ id: names.hook, event: 'session_start', feedback: 'notify',
    ...(spec.name === 'single-hook' ? { agentOverrides: { opencode: { event: 'before_tool' } } } : {}),
    command: 'echo ' + token('hook', revision) }];
  if (Object.keys(extensions).length) manifest.extensions = extensions;
  if (spec.kinds.includes('mcp')) {
    manifest.mcpServers = './servers.json';
    await json('servers.json', { mcpServers: { [names.mcp]: { type: 'http', url: 'http://127.0.0.1:1/' + token('mcp', revision) } } });
  }
  if (spec.kinds.includes('skill')) {
    const name = spec.name + '-skill';
    const body = '---\nname: ' + name + '\ndescription: Local qualification fixture.\n---\n' + token('skill', revision);
    if (spec.name === 'mixed-components') {
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'render.mjs'), [
        "import fs from 'node:fs';",
        "const ctx = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
        'const name = ' + JSON.stringify(name) + ';',
        'const text = ' + JSON.stringify(body) + " + (ctx.platform === 'generic' ? ' portable edition' : ' native edition') + '\\n';",
        "const skill = { id: 'skill:' + name, kind: 'skill', name, content: { files: { 'SKILL.md': {text}, 'README.md': {text: 'Local qualification fixture.'} } } };",
        "console.log(JSON.stringify({version: 3, components: ctx.allowedOutputKinds.includes('skill') ? [skill] : [], omitted: [], unmet: []}));",
      ].join('\n'));
    } else {
      manifest.skills = './skills';
      const location = path.join(directory, 'skills', name);
      await fs.mkdir(location, { recursive: true });
      await fs.writeFile(path.join(location, 'SKILL.md'), body + '\n');
      await fs.writeFile(path.join(location, 'README.md'), 'Component qualification fixture.\n');
    }
  }
  await json(manifestFile, manifest);
}

function expectedKinds(platform, spec) {
  return spec.kinds.filter(kind => platform === 'generic' ? kind === 'skill'
    : !(platform === 'opencode' && (kind === 'agent' || kind === 'hook' && spec.name !== 'single-hook')));
}


async function verifyFixture(ctx, result, spec, revision) {
  const id = source + '/' + spec.name;
  const target = targetOf(result, ctx, id);
  const expected = expectedKinds(ctx.platform, spec);
  const gaps = target.componentGaps ?? [];
  assert.deepEqual(gaps.map(item => item.kind).sort(), spec.kinds.filter(kind => !expected.includes(kind)).sort(), id);
  const installed = [];
  for (const kind of expected) {
    const name = kind === 'skill' ? spec.name + '-skill' : names[kind];
    if (ctx.platform !== 'generic') {
      const observations = target.deploymentObservations ?? target.deploymentReceipts;
      assert(observations.some(({ after }) => after.components.some(row => row.id === kind + ':' + name && row.presence === 'present')),
        'Native observation missing ' + id + '/' + name);
    }
    const file = nativePath(ctx, { id }, kind, nativePackage(target), name);
    const suffix = kind === 'skill' && spec.name === 'mixed-components' ? ctx.platform === 'generic' ? ' portable edition' : ' native edition' : '';
    installed.push({ kind, ...await readInstalled(ctx, file, token(kind, revision) + suffix) });
    if (ctx.platform === 'generic' && kind === 'skill') {
      const marker = JSON.parse(await fs.readFile(path.join(path.dirname(file), '.agent-workflows-owner.json'), 'utf8'));
      assert.equal(marker.pluginId, id);
      assert.equal(marker.skill, name);
      assert.equal(marker.owner, 'agent-workflows');
      assert.equal(marker.scope, ctx.scope);
    }
    if (ctx.platform === 'pi' && kind === 'agent') {
      const manifest = JSON.parse(await fs.readFile(path.join(nativePackage(target), 'package.json'), 'utf8'));
      assert.deepEqual(manifest.pi.subagents.agents, ['./agents']);
    }
  }
  for (const gap of gaps) {
    assert.equal(gap.providerPluginId, id);
    assert.equal(gap.id, gap.kind + ':' + names[gap.kind]);
    assert.equal(gap.reasonCode, ctx.platform === 'generic' ? 'interface-unsupported' : 'delivery-unavailable');
    assert(gap.requiredFeatures.length > 0, 'Missing capability reason for ' + gap.id);
  }
  if (!expected.length) {
    assert.equal(target.satisfaction, 'not-applicable');
    assert.equal(target.installedComponentCount, 0);
    assert(!nativePackage(target), 'A clean zero-output install published a package');
  }
  const outcome = { id, installed, skipped: gaps.map(({ id, reasonCode, requiredFeatures }) => ({ id, reasonCode, requiredFeatures })) };
  if (ctx.platform === 'claude' && result.command === 'plugin.status'
    && ['single-agent', 'single-skill'].includes(spec.name)) {
    const state = target.deploymentObservations.find(({ after }) => after.nativeIdentity?.packageId === spec.name)?.after;
    const registrationId = state?.nativeIdentity?.registrationId;
    assert(registrationId?.startsWith(spec.name + '@'), id + ': missing native registration identity');
    assert.equal(state.registration, 'present');
    assert.equal(state.ownership, 'aw');
    assert.equal(state.scopeRegistration, 'present');
    assert.equal(target.content, 'satisfied');
    const { runNativeCli } = await import('../../packages/cli/dist/src/utils/native-cli.js');
    const details = await runNativeCli({ command: 'claude', agentKind: 'claude', args: ['plugin', 'details', registrationId],
      cwd: ctx.scope === 'project' ? ctx.project : ctx.root, env: ctx.env });
    assert.equal(details.exitCode, 0, details.stderr);
    const inventory = /^\s*Agents \((\d+)\)([^\r\n]*)$/mu.exec(details.stdout);
    assert(inventory, 'Claude plugin details did not report the Agent inventory for ' + id);
    const roles = inventory[2].trim().split(/\s+/u).filter(Boolean);
    const expectedRoles = spec.name === 'single-agent' ? [names.agent] : [];
    assert.equal(Number(inventory[1]), expectedRoles.length, id);
    assert.deepEqual(roles, expectedRoles, id);
    outcome.nativeAgentInventory = { level: 'component-inventory', registrationId, roles };
  }
  return outcome;
}

function fingerprints(root, files) {
  return Promise.all(files.map(async file => {
    const stat = await fs.stat(file, { bigint: true });
    return { path: path.relative(root, file).split(path.sep).join('/'), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs),
      sha256: sha256(await fs.readFile(file)) };
  }));
}

async function grokUserRefresh(ctx, report, spec, observed, sync) {
  const id = source + '/' + spec.name;
  const awPackage = nativePackage(targetOf(observed, ctx, id));
  const workspace = await fs.realpath(path.join(ctx.env.AW_HOME, 'runtime', 'user'));
  const native = async (args, cwd = workspace) => JSON.parse(await runGrokCommand(ctx.env, cwd, args));
  const registration = async () => grokUserRegistration(await native(['plugin', 'list', '--json']), ctx.env, spec.name, awPackage);
  const trust = async allowed => {
    // Only the qualification owns this empty Grok home. Give the calling
    // project the opposite decision to detect accidental trust inheritance.
    const entries = [[workspace, allowed], [ctx.project, !allowed]];
    await writeGrokFixtureFolderDecisions(ctx.env, entries);
    for (const [folder, trusted] of entries) {
      const state = await native(['inspect', '--json'], folder);
      assert.equal(state.grokVersion, clients.grok.version);
      assert.equal(path.relative(folder, state.cwd), '');
      if (folder === workspace) assert.equal(state.projectRoot, null);
      assert.equal(state.projectTrusted, trusted, 'The native host must confirm the exact fixture folder decision.');
    }
  };
  const original = await registration();
  const files = spec.kinds.filter(kind => kind !== 'instruction').map(kind => ({ kind,
    file: nativePath(ctx, { id }, kind, original.path, kind === 'skill' ? spec.name + '-skill' : names[kind]) }));
  const readCopy = revision => Promise.all(files.map(({ kind, file }) => readInstalled(ctx, file, token(kind, revision))));
  const originalFiles = await readCopy(1);
  report.grokUserRefresh = { oldNativeFiles: originalFiles };
  await trust(false);
  const denied = await ctx.result(['plugin', 'sync', id, '--context', 'user', '--target', 'grok', '--yes']);
  assert.equal(denied.exitCode, denied.value.status === 'partial' ? 4 : 3);
  assert(['blocked', 'partial'].includes(denied.value.status));
  const refused = targetOf(denied.value, ctx, id, true);
  assert.deepEqual(refused.blockerCodes, ['nativeTrustRequired']);
  assert(denied.value.diagnostics.some(item => item.subject?.pluginId === id
    && item.detail?.reasonCode === 'grokNativeRefreshWorkspaceTrust'));
  assert(denied.value.diagnostics.some(item => item.subject?.pluginId === id
    && item.code === 'grokNativeInstallWorkspace' && path.relative(workspace, item.detail.path) === ''));
  assert.deepEqual(await registration(), original, 'Denied refresh must preserve the native registration.');
  assert.deepEqual(await readCopy(1), originalFiles, 'Denied refresh must preserve the installed revision.');
  report.grokUserRefresh.denied = refused.blockerCodes;
  await trust(true);
  report.grokUserRefresh.explicitWorkspaceTrust = true;
  const changed = await sync();
  assert.deepEqual(changed.data.remainingTargets, []);
  assert.deepEqual(await registration(), original);
  report.grokUserRefresh.newNativeFiles = await readCopy(2);
  return changed;
}

// Both roots share Pi's settings file. The dependency makes the extension
// publish before the role, so the second target must observe AW's own write.
async function piPair(ctx, report, inputs, install, status, sync) {
  const ids = inputs.map(spec => source + '/' + spec.name);
  const first = await install(ids);
  assert.deepEqual(first.data.remainingTargets, []);
  const scopeRoot = ctx.scope === 'project' ? path.join(ctx.project, '.pi') : ctx.env.PI_CODING_AGENT_DIR;
  const settings = path.join(scopeRoot, 'settings.json');
  const paths = [settings];
  const warnings = first.diagnostics.filter(item => item.code === 'piAgentConsumerUnavailable'
    && item.subject?.pluginId === source + '/single-agent' && item.subject.scope === ctx.scope);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].detail.reasonCode, 'piAgentConsumerMissing');
  report.pair = { targets: [], scope: ctx.scope, consumerWarning: warnings[0].detail.reasonCode };
  for (const spec of inputs) {
    const id = source + '/' + spec.name;
    const target = targetOf(first, ctx, id);
    assert.equal(target.execution, 'applied');
    const receipts = target.deploymentReceipts.filter(receipt => receipt.after.nativeIdentity?.packageId === spec.name);
    assert.equal(receipts.length, 1);
    const [receipt] = receipts;
    assert.equal(receipt.after.registration, 'present');
    assert.equal(receipt.after.ownership, 'aw');
    const plan = target.deploymentPlans.find(plan => plan.bindingId === receipt.bindingId);
    for (const kind of ['publish-package', 'register']) {
      const effects = plan.effects.filter(effect => effect.kind === kind);
      assert.equal(effects.length, 1, id + '/' + kind);
      assert.deepEqual(receipt.effects.filter(effect => effect.id === effects[0].id).map(effect => [effect.status, effect.mutation]),
        [['applied', 'confirmed']], id + '/' + kind);
    }
    const installed = await verifyFixture(ctx, first, spec, 1);
    assert.equal(installed.installed.length, 1);
    paths.push(path.join(ctx.root, installed.installed[0].path), path.join(nativePackage(target), 'package.json'));
    report.pair.targets.push(installed);
  }
  const packages = JSON.parse(await fs.readFile(settings, 'utf8')).packages;
  const registered = packages.map(entry => path.basename(typeof entry === 'string' ? entry : entry.source));
  assert.deepEqual(registered, inputs.map(spec => 'aw-matrix-' + spec.name), 'Pi must register each package once, extension first.');
  const before = await fingerprints(ctx.root, paths);
  const observed = await status();
  checkSettled(observed);
  for (const spec of inputs) await verifyFixture(ctx, observed, spec, 1);
  const again = await sync();
  assert.deepEqual(again.data.remainingTargets, []);
  assert.equal(again.data.changes.outputs, 'none');
  for (const id of ids) assert.equal(targetOf(again, ctx, id).execution, 'no-op');
  assert.deepEqual(await fingerprints(ctx.root, paths), before, 'A satisfied Pi batch must preserve both packages and the scope settings.');
  Object.assign(report.pair, { registered, filesAfterSync: before, syncOutputs: again.data.changes.outputs });
}

async function readGrokHook(ctx, name, scope, directory) {
  const inspection = JSON.parse(await runGrokCommand(ctx.env, ctx.project, ['inspect', '--json']));
  const plugins = inspection.plugins.filter(plugin => plugin.name === name);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].scope, scope);
  assert.equal(plugins[0].enabled, true);
  assert.equal(path.relative(directory, plugins[0].path), '');
  const hooks = inspection.hooks.filter(hook => hook.source?.plugin_name === name);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].source.type, 'plugin');
  assert.equal(hooks[0].event, '(plugin)');
  assert.equal(hooks[0].hookType, 'file');
  assert.equal(hooks[0].matcher, null);
  assert.equal(path.relative(directory, hooks[0].source.path), '');
  assert.equal(path.relative(directory, hooks[0].target), path.join('hooks', 'hooks.json'));
  return readInstalled(ctx, hooks[0].target, token('hook', 1));
}

async function matrix(ctx, report) {
  const { aw, platform, scope } = ctx;
  const workspace = path.join(ctx.root, 'workspace');
  await fs.mkdir(workspace);
  await aw(['dev', 'catalog', 'create', '--workspace-root', workspace, '--owner-url', 'https://example.com/qualification'], workspace);
  const prerequisite = pairPrerequisites.get(report.suite);
  const inputs = prerequisite ? [
    specs.find(spec => spec.name === prerequisite),
    { ...specs.find(spec => spec.name === 'single-agent'), dependencies: [prerequisite] },
  ] : platform === 'generic' ? specs : specs.filter(spec => spec.name !== 'without-skills');
  for (const spec of inputs) ctx.dependencies.set(source + '/' + spec.name, (spec.dependencies ?? []).map(name => source + '/' + name));
  await aw(['dev', 'plugin', 'create', inputs[0].name, '--description', 'Local component qualification.', '--no-skills', '--workspace-root', workspace], workspace);
  const scaffold = JSON.parse(await fs.readFile(path.join(workspace, 'plugins', inputs[0].name, manifestFile), 'utf8'));
  for (const spec of inputs) await writeFixture(workspace, scaffold, spec, 1);
  const build = () => aw(['dev', 'catalog', 'build', '--force', '--yes', '--workspace-root', workspace], workspace);
  await build();
  await aw(['source', 'add', source, '--path', path.join(workspace, '.aw/catalog'), '--primary', '--no-auto-check', '--yes']);
  const ids = inputs.map(spec => source + '/' + spec.name);
  const installArgs = ids => ['plugin', 'install', ...ids, '--scope', scope, '--context', scope, '--target', platform, '--yes'];
  const install = ids => aw(installArgs(ids));
  const sync = () => aw(['plugin', 'sync', '--context', scope, '--yes']);
  const status = () => aw(['plugin', 'status', '--context', scope]);
  if (report.suite === 'pi-pair') return piPair(ctx, report, inputs, install, status, sync);
  if (report.suite === 'pi-seven' || prerequisite) {
    // Grok must accept its own prerequisite's Hook or rule before publishing the role.
    // The Pi scenario replays the seven independent roots of its original batch.
    let personalHook;
    if (report.suite === 'grok-user-hook-pair') {
      const personal = await aw(['plugin', 'install', ...ids, '--scope', 'user', '--context', 'user', '--target', 'grok', '--yes']);
      const personalSource = nativePackage(targetOf(personal, { ...ctx, scope: 'user' }, ids[0]));
      const workspace = path.join(ctx.env.AW_HOME, 'runtime', 'user');
      const rows = JSON.parse(await runGrokCommand(ctx.env, workspace, ['plugin', 'list', '--json']));
      const registration = grokUserRegistration(rows, ctx.env, prerequisite, personalSource);
      personalHook = await readGrokHook(ctx, prerequisite, 'user', registration.path);
    }
    const installed = await install(ids);
    assert.deepEqual(installed.data.remainingTargets, []);
    assert.deepEqual(installed.data.requirements.roots.toSorted(), ids.toSorted());
    if (prerequisite) {
      for (const id of ids) assert.equal(targetOf(installed, ctx, id).execution, 'applied', id);
    }
    const observed = await status();
    checkSettled(observed);
    for (const spec of inputs) report.cases.push(await verifyFixture(ctx, observed, spec, 1));
    const files = prerequisite ? report.cases.flatMap(item => item.installed.map(file => path.join(ctx.root, file.path))) : [];
    const before = await fingerprints(ctx.root, files);
    const unchanged = await sync();
    assert.deepEqual(unchanged.data.remainingTargets, []);
    assert.equal(unchanged.data.changes.outputs, 'none');
    assert.deepEqual(await fingerprints(ctx.root, files), before);
    report.batch = { roots: ids, installStatus: installed.status, syncOutputs: unchanged.data.changes.outputs };
    if (prerequisite) report.batch.filesAfterSync = before;
    if (personalHook) {
      const directory = nativePackage(targetOf(installed, ctx, ids[0]));
      const projectHook = await readGrokHook(ctx, prerequisite, 'project', directory);
      assert.equal(projectHook.sha256, personalHook.sha256);
      assert.equal(sha256(await fs.readFile(path.join(ctx.root, personalHook.path))), personalHook.sha256);
      report.batch.hooks = { personal: personalHook, project: projectHook };
    }
    return;
  }
  // A target with only missing capability starts in a genuinely empty scope.
  if (['opencode', 'generic'].includes(platform)) {
    const spec = inputs.find(spec => spec.name === 'hook-only');
    const initial = await install([source + '/' + spec.name]);
    assert.deepEqual(initial.data.remainingTargets, []);
    const observed = await status();
    checkSettled(observed);
    report.onlyHook = await verifyFixture(ctx, observed, spec, 1);
    const directory = platform === 'generic' ? path.join(scope === 'project' ? ctx.project : ctx.env.HOME, '.agents/skills')
      : scope === 'project' ? path.join(ctx.project, '.opencode/plugins') : path.join(ctx.env.XDG_CONFIG_HOME, 'opencode/plugins');
    const entries = await fs.readdir(directory).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(entries, [], 'A clean zero-output scope must have no installed artifact');
    report.onlyHook.artifactDirectory = 'absent-or-empty';
    const unchanged = await sync();
    assert.deepEqual(unchanged.data.remainingTargets, []);
    assert.equal(unchanged.data.changes.outputs, 'none');
  }
  const installFailures = [];
  report.installFailures = installFailures;
  for (const spec of inputs) {
    const id = source + '/' + spec.name;
    const row = report.cells.find(row => spec.name === 'single-' + row.kind);
    // A returned business failure for one independent root must not hide
    // unrelated reads. An incomplete process observation still stops this scope.
    const { exitCode, value, failure: commandFailure } = await ctx.result(installArgs([id]));
    if (exitCode !== 0) {
      assert(['blocked', 'partial', 'failed'].includes(value.status), id + ': unexpected command result');
      const target = commandFailure.awReceipt.targets?.find(item => item.pluginId === id);
      const failure = { id, exitCode, status: value.status, execution: target?.execution, blockerCodes: target?.blockerCodes,
        diagnostics: (commandFailure.awReceipt.diagnostics ?? []).map(item => item.code) };
      if (row) row.failure = failure;
      installFailures.push(failure);
      continue;
    }
    assert.equal(value.status, 'success');
    const { remainingTargets } = value.data;
    assert(Array.isArray(remainingTargets), id + ': invalid remaining targets');
    const remainingTargetCount = remainingTargets.length;
    if (remainingTargetCount) {
      const failure = { id, exitCode, status: value.status, remainingTargetCount };
      if (row) row.failure = failure;
      installFailures.push(failure);
      continue;
    }
    if (!row) continue;
    try {
      const outcome = await verifyFixture(ctx, value, spec, 1);
      row.observed = outcome.installed.length ? 'installed' : 'skipped';
      row.evidence = outcome.installed[0] ?? outcome.skipped[0];
    } catch (error) {
      if (error.code !== 'ERR_ASSERTION' && error.code !== 'ENOENT') throw error;
      row.failure = { id, exitCode, status: value.status, reason: error.message.replaceAll(ctx.root, '<isolated>') };
      installFailures.push(row.failure);
    }
  }
  if (installFailures.length) {
    assert.fail('Independent plugin installation failures: ' + installFailures.map(item => item.id).join(', '));
  }
  const observed = await status();
  checkSettled(observed);
  for (const spec of inputs) {
    try { report.cases.push(await verifyFixture(ctx, observed, spec, 1)); }
    catch (error) { report.cases.push({ id: source + '/' + spec.name, error: error.message }); }
  }
  const failed = report.cases.filter(row => row.error);
  assert.equal(failed.length, 0, JSON.stringify(failed));
  const second = await sync();
  assert.deepEqual(second.data.remainingTargets, []);
  assert.equal(second.data.changes.outputs, 'none');
  const mixed = inputs.find(spec => spec.name === 'mixed-components');
  const mixedId = source + '/' + mixed.name;
  const unchangedGrokFiles = platform === 'grok'
    ? report.cases.filter(item => item.id !== mixedId).flatMap(item => item.installed.map(file => path.join(ctx.root, file.path))) : [];
  const unchangedFiles = await fingerprints(ctx.root, unchangedGrokFiles);
  await writeFixture(workspace, scaffold, mixed, 2);
  await build();
  await aw(['source', 'sync', source, '--yes']);
  const update = platform === 'grok' && scope === 'user' ? await grokUserRefresh(ctx, report, mixed, observed, sync) : await sync();
  if (unchangedGrokFiles.length) {
    report.upgradeTargets = ids.map(id => ({ id, execution: targetOf(update, ctx, id).execution }));
    for (const target of report.upgradeTargets) assert.equal(target.execution, target.id === mixedId ? 'applied' : 'no-op', target.id);
    assert.deepEqual(update.data.remainingTargets, []);
    assert.deepEqual(await fingerprints(ctx.root, unchangedGrokFiles), unchangedFiles, 'The six unchanged Grok packages must retain their files.');
  }
  const beforeRemoval = await status();
  report.updated = await verifyFixture(ctx, beforeRemoval, mixed, 2);
  report.removals = [];
  const controls = new Set();
  const remainingRoots = new Set(ids);
  for (const fixture of report.cases) {
    remainingRoots.delete(fixture.id);
    await verifyFixtureRemoval(ctx, report, beforeRemoval, fixture.id === report.updated.id ? report.updated : fixture, controls, remainingRoots);
  }
  await install([source + '/' + mixed.name]);
  report.reinstalled = await verifyFixture(ctx, await status(), mixed, 2);
  if (platform === 'generic') {
    const skill = inputs.find(spec => spec.name === 'single-skill');
    const file = nativePath(ctx, { id: source + '/' + skill.name }, 'skill', undefined, skill.name + '-skill');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'foreign bytes');
    const failure = await ctx.result(['plugin', 'install', source + '/' + skill.name, '--scope', scope, '--target', platform, '--yes']);
    assert.notEqual(failure.exitCode, 0);
    assert(['blocked', 'partial', 'failed'].includes(failure.value.status));
    assert(failure.value.diagnostics.some(item => item.code === 'portableOutputConflict'));
    assert(failure.value.data.remainingTargets.some(target => target.pluginId === source + '/' + skill.name));
    assert.equal(await fs.readFile(file, 'utf8'), 'foreign bytes');
    report.foreign = { preserved: true, exitCode: failure.exitCode, status: failure.value.status,
      diagnostics: failure.value.diagnostics.map(item => item.code) };
    if (process.platform !== 'win32' && process.getuid() !== 0) {
      await fs.unlink(file);
      await fs.rmdir(path.dirname(file));
      const parent = path.dirname(path.dirname(file));
      const mode = (await fs.stat(parent)).mode & 0o777;
      try {
        await fs.chmod(parent, 0o555);
        await assert.rejects(fs.access(parent, constants.W_OK), { code: 'EACCES' });
        const denied = await ctx.result(['plugin', 'install', source + '/' + skill.name, '--scope', scope, '--target', platform, '--yes']);
        assert.notEqual(denied.exitCode, 0);
        const target = targetOf(denied.value, ctx, source + '/' + skill.name, true);
        assert(target.blockerCodes.includes('portableWriteFailed'));
        assert(denied.value.data.remainingTargets.some(row => row.pluginId === target.pluginId));
        await assert.rejects(fs.stat(file), { code: 'ENOENT' });
        report.writeDenied = { exitCode: denied.exitCode, status: denied.value.status,
          execution: target.execution, blockerCodes: target.blockerCodes };
      } finally { await fs.chmod(parent, mode); }
      await install([source + '/' + skill.name]);
      report.recovered = await verifyFixture(ctx, await status(), skill, 1);
    } else report.writeDenied = { observed: 'unverified', reason: 'POSIX non-root write-denial fixture' };
  }
}


export async function runComponentQualification({ platform, scope, clientPath, traceEntry, suite = 'matrix', catalog },
  { executeAw = executePublicAw, executeCommand = execute } = {}) {
  assert(componentPlatforms.includes(platform) && ['user', 'project'].includes(scope));
  assert(['matrix', 'pi-seven', 'candidate', 'frozen', 'project-inheritance'].includes(suite) || pairPrerequisites.has(suite));
  if (suite === 'project-inheritance') assert.equal(scope, 'project');
  if (suite.startsWith('pi-')) assert.equal(platform, 'pi');
  if (suite.startsWith('grok-')) assert.deepEqual([platform, scope], ['grok', 'project']);
  const artifactIdentity = async () => {
    const files = Object.entries(await candidateFiles()).filter(([name]) => name.startsWith('packages/'));
    return sha256(JSON.stringify(files));
  };
  const candidateSha256 = await artifactIdentity();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-components-')));
  const publicAwFailures = new Map();
  const publicAwFailureReason = error => publicAwFailures.get(error);
  const report = { suite, level: 'public-AW-install-status-and-files', platform, scope,
    host: process.platform + '-' + process.arch, candidateSha256, cases: [], status: 'failed',
    ...(suite === 'matrix' ? { cells: specs.filter(spec => spec.name.startsWith('single-')).map(spec => ({
      kind: spec.kinds[0], expected: expectedKinds(platform, spec).length ? 'installed' : 'skipped', observed: 'unverified' })) } : {}) };
  try {
    const env = await prepareEnvironment(root);
    if (clientPath) env.PATH = clientPath;
    else if (process.platform !== 'win32') {
      const bin = path.join(root, 'bin');
      await fs.mkdir(bin);
      await fs.symlink(process.execPath, path.join(bin, 'node'));
      const name = ({ antigravity: 'agy', cursor: 'cursor-agent' })[platform] ?? platform;
      if (platform !== 'generic') {
        let entry;
        for (const directory of env.PATH.split(path.delimiter)) {
          const candidate = path.join(directory, name);
          if (await fs.access(candidate, constants.X_OK).then(() => true, () => false)) {
            entry = await fs.realpath(candidate);
            break;
          }
        }
        assert(entry, 'Native client unavailable: ' + name);
        await fs.symlink(entry, path.join(bin, name));
      }
      env.PATH = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    }
    if (suite === 'candidate') {
      // Keep only this real preApply prerequisite on the otherwise isolated PATH.
      const entryName = process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser';
      const hosted = process.env.AW_QUALIFICATION_BROWSER_BIN;
      const search = hosted ? [hosted] : (process.env.PATH ?? '').split(path.delimiter);
      report.browserUsePrerequisite = { available: false };
      for (const directory of search.filter(directory => path.isAbsolute(directory))) {
        const entry = path.join(directory, entryName);
        if (!(await fs.access(entry, constants.X_OK).then(() => true, () => false))) continue;
        const bin = path.join(root, 'browser-prerequisite');
        await fs.mkdir(bin);
        const destination = path.join(bin, entryName);
        if (process.platform === 'win32') await fs.copyFile(entry, destination);
        else await fs.symlink(await fs.realpath(entry), destination);
        env.PATH = [bin, env.PATH].join(path.delimiter);
        report.browserUsePrerequisite = { available: true, sha256: sha256(await fs.readFile(destination)),
          ...(hosted ? { source: 'agent-browser@0.38.1' } : { source: 'local executable' }) };
        break;
      }
    }
    const project = path.join(root, 'project');
    await fs.mkdir(project);
    assertCommand(await executeCommand({ executable: 'git', prefix: [] }, ['init', '--quiet', '--template=', project], { cwd: root, env }));
    const dependencies = new Map();
    if (process.platform === 'linux') {
      report.pluginScriptSupervision = 'outer-qualification-marker-at-managed-launch';
    }
    let componentTraceIndex = 0;
    async function result(args, cwd = project, trustRetry) {
      // Trace the first real discovery in this fresh home. A later probe could
      // succeed and lose the reason target selection originally failed.
      const command = componentCommand(args, dependencies);
      const discoveryTrace = traceEntry && ['copilot', 'antigravity'].includes(platform) && command.command === 'target.set';
      const matrixInstall = suite === 'matrix' && command.pluginIds?.length === 1;
      const installTrace = traceEntry && platform === 'codex' && scope === 'project' && command.command === 'plugin.install'
        && (suite === 'candidate' || matrixInstall);
      const grokTrace = traceEntry && platform === 'grok' && command.command === 'target.set';
      const claudeTrace = traceEntry && platform === 'claude' && scope === 'project' && suite === 'matrix'
        && command.command === 'plugin.remove' && command.scope === 'project' && command.pluginIds?.length === 1
        && command.pluginIds[0] === 'matrix/hook-only';
      const traceMode = installTrace ? 'codex-component-install' : grokTrace ? 'grok-component-discovery'
        : claudeTrace ? 'claude-component-remove' : undefined;
      const trace = Boolean(discoveryTrace || traceMode);
      const traceFile = discoveryTrace ? path.join(root, 'target-discovery.jsonl')
        : traceMode ? path.join(root, `${traceMode}-${++componentTraceIndex}.jsonl`) : undefined;
      const commandEnv = trace ? { ...env, GITHUB_ACTIONS: 'true', AW_NATIVE_QUALIFICATION_MANAGED_TRACE: '1',
        AW_NATIVE_QUALIFICATION_MANAGED_TRACE_CLIENT: platform, AW_NATIVE_QUALIFICATION_MANAGED_TRACE_FILE: traceFile,
        ...(traceMode ? { AW_NATIVE_QUALIFICATION_MANAGED_TRACE_MODE: traceMode } : {}),
        AW_NATIVE_QUALIFICATION_MANAGED_TRACE_ENTRIES: JSON.stringify([traceEntry]) } : env;
      let response;
      let value;
      let failure;
      let stage = 'execute';
      const recordFailure = (stage, kind, error, receipt) => {
        failure = { ...command, stage, error: kind, ...componentProcessEvidence(error, response),
          ...componentReceiptEvidence(receipt, command, platform) };
        const failures = report.commandFailures ??= [];
        if (failures.length < 16) failures.push(failure);
        else report.omittedCommandFailures = (report.omittedCommandFailures ?? 0) + 1;
      };
      try {
        response = await executeAw(publicAwNodeLauncher(cli, trace), [...args, '--json'], { cwd, env: commandEnv, timeoutMs: 180000 });
        // A Windows Job failure can return 250 even after AW has printed a receipt.
        // Only AW's public exit codes carry command results in this suite.
        assert(awCommandCompleted(response), 'Public AW process did not complete');
        stage = 'response';
        value = readComponentReceipt(response, command.command);
        assert(value, 'Public AW receipt does not match its command and exit code');
        if (response.exitCode !== 0) recordFailure('command', 'public-aw-failed', undefined, value);
      } catch (error) {
        const kind = stage === 'response' ? 'invalid-public-receipt'
          : error?.name === 'ProviderProcessCleanupError' ? 'ProviderProcessCleanupError' : 'process-failed';
        recordFailure(stage, kind, error, stage === 'execute' ? readComponentReceipt(error?.result ?? response, command.command) : undefined);
        publicAwFailures.set(error, `${failure.command} ${stage} failed (${kind})`);
        throw error;
      } finally {
        if (discoveryTrace) report.targetDiscoveryTrace = await readManagedTrace(traceFile);
        if (traceMode && report.commandFailures?.includes(failure)) failure.nativeCommandTrace = await readComponentTrace(traceFile, traceMode);
      }
      const outcome = { exitCode: response.exitCode, value, failure };
      const userCommand = scope === 'user' || ['project-inheritance', 'grok-user-hook-pair'].includes(suite)
        && args[args.indexOf('--context') + 1] === 'user';
      if (platform === 'grok' && userCommand && args[0] === 'plugin' && (args[1] === 'install' || trustRetry)
        && value.status === 'partial' && response.exitCode === 4) {
        const retry = trustRetry ?? { roots: value.data.request.plugins, authorized: new Set() };
        const direct = grokTrustTargets(value, dependencies, retry.authorized);
        if (!direct.length) return outcome;
        assert(Array.isArray(retry.roots) && retry.roots.length);
        for (const target of direct) {
          const [provider, name] = target.pluginId.split('/');
          const after = target.deploymentReceipts.find(item => item.after.ownership === 'aw' && item.after.registration === 'absent'
            && item.after.nativeIdentity?.packageId === name)?.after;
          assert.equal(after?.nativeIdentity.route, 'grok-cli');
          const location = await fs.realpath(after.nativeIdentity.sourceLocation);
          const parts = path.relative(env.AW_HOME, location).split(path.sep);
          assert.deepEqual(parts.slice(0, 2), ['platforms', 'grok']);
          assert.match(parts[2], /^[a-f0-9]{64}$/u);
          assert.deepEqual(parts.slice(3), ['packages', provider, name]);
          assert.equal(JSON.parse(await fs.readFile(path.join(location, '.agent-workflows-owner.json'), 'utf8')).pluginId, target.pluginId);
          assert(value.diagnostics.some(diagnostic => diagnostic.code === 'grokNativeInstallRecovery'
            && diagnostic.subject?.pluginId === target.pluginId && diagnostic.detail.path === location));
          await runGrokCommand(env, path.join(env.AW_HOME, 'runtime', 'user'), ['plugin', 'install', location, '--trust']);
          retry.authorized.add(target.pluginId);
          (report.explicitFixtureTrust ??= []).push(target.pluginId);
        }
        return result(['plugin', 'sync', ...retry.roots, '--context', 'user', '--target', 'grok', '--yes'], cwd, retry);
      }
      return outcome;
    }
    async function aw(args, cwd) {
      const { exitCode, value, failure } = await result(args, cwd);
      if (exitCode !== 0) {
        const reason = `${failure.command} failed (exit ${exitCode})`;
        const error = new Error(reason);
        publicAwFailures.set(error, reason);
        throw error;
      }
      return value;
    }
    if (platform === 'codex' && scope === 'project')
      await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), '[projects.' + JSON.stringify(project) + ']\ntrust_level = "trusted"\n');
    if (platform === 'pi' && scope === 'project')
      await fs.writeFile(path.join(env.PI_CODING_AGENT_DIR, 'trust.json'), JSON.stringify({ [project]: true }));
    if (platform === 'grok' && scope === 'project')
      await writeGrokFixtureFolderDecisions(env, [[project, true]]);
    if (platform === 'copilot' && suite === 'project-inheritance') {
      await fs.writeFile(path.join(env.COPILOT_HOME, 'config.json'), JSON.stringify({ trustedFolders: [project] }), { flag: 'wx' });
      report.fixtureTrust = 'isolated project directory in trustedFolders';
    } else if (platform === 'copilot' && scope === 'project' && process.env.GITHUB_ACTIONS === 'true') {
      // Same temporary, offline management precondition as the public Copilot route.
      env.COPILOT_ALLOW_ALL = 'true';
      report.fixtureTrust = 'hosted COPILOT_ALLOW_ALL in the isolated environment';
    }
    const target = await aw(['target', 'set', platform]);
    report.products = target.data.availability.find(row => row.id === platform)?.installations.map(({ product, version, availability }) => ({ product, version, availability }));
    const ctx = { root, project, env, aw, result, scope, platform, dependencies, publicAwFailureReason };
    if (suite === 'project-inheritance') await qualifyProjectDependencies(ctx, report);
    else if (suite === 'matrix' || suite === 'pi-seven' || pairPrerequisites.has(suite)) await matrix(ctx, report);
    else await qualifyCatalog(ctx, report, catalog ?? path.join(repoRoot, 'packages/cli/plugins-dist'), suite === 'frozen');
    assert.equal(await artifactIdentity(), candidateSha256, 'Candidate bytes changed during qualification');
    report.status = 'passed';
  } catch (error) {
    report.reason = publicAwFailureReason(error)
      ?? (error.stack ?? error.message).replaceAll(root, '<isolated>').replaceAll(repoRoot, '<repo>').replaceAll(os.homedir(), '<home>');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { target: { type: 'string' }, scope: { type: 'string' }, suite: { type: 'string' },
    catalog: { type: 'string' }, report: { type: 'string' } } });
  const platforms = values.target ? values.target.split(',') : componentPlatforms;
  const scopes = values.scope ? values.scope.split(',') : ['user', 'project'];
  const reports = [];
  for (const platform of platforms) for (const scope of scopes) {
    const result = await runComponentQualification({ platform, scope, suite: values.suite, catalog: values.catalog });
    reports.push(result);
    if (values.report) await fs.writeFile(values.report, JSON.stringify(reports, null, 2) + '\n');
    console.log(platform, scope, result.status, result.reason ?? '');
  }
  if (reports.some(row => row.status !== 'passed')) process.exitCode = 1;
}
