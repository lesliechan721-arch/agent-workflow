import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { clients, fixedClientVersion, sha256 } from './native-platform-runtime.mjs';
import { readPublicOpenCodeState, capturePublicOpenCodeRemoval, readPublicOpenCodeDynamicContent } from './native-platform-opencode-public.mjs';

export const publicFixtureVersion = revision => `0.1.${Math.min(revision, 2) - 1}`;

const directoryRegistration = ctx => ctx.platform === 'opencode' || ctx.platform === 'grok' && ctx.scope === 'project';

export function expectedOpenCodeObservation(result, ctx, pluginId) {
  const optionalOutcomes = {
    opencodeNativeObservationFailed: 'unknown',
    opencodeNativeActivationPending: 'unknown',
    opencodePluginLoadFailed: 'not-observed',
  };
  const outcomes = result.diagnostics.filter(item => Object.hasOwn(optionalOutcomes, item.code));
  if (!outcomes.length) return { activation: 'enabled', load: 'observed' };
  const outcome = single(outcomes, 'opencode-optional-observation-ambiguous');
  assert.equal(outcome.severity, 'warning');
  assert.deepEqual({ pluginId: outcome.subject?.pluginId, target: outcome.subject?.target, scope: outcome.subject?.scope },
    { pluginId, target: 'opencode', scope: ctx.scope });
  return { activation: 'unknown', load: optionalOutcomes[outcome.code] };
}

export function assertPublicTarget(result, ctx, pluginId, expected) {
  const inventory = result.data?.inventory?.filter(item => item.pluginId === pluginId
    && item.targetResults.some(target => target.scope === ctx.scope && target.target === ctx.platform));
  const item = single(inventory ?? [], 'public-status-fixture-missing');
  assert.equal(item.sourceState, 'ready');
  assert.deepEqual(item.blockerCodes, []);
  const target = single(item.targetResults.filter(item => item.scope === ctx.scope && item.target === ctx.platform),
    'public-status-target-missing');
  assert.equal(target.pluginId, pluginId);
  assert.equal(target.delivery?.kind, 'native');
  assert.equal(target.delivery.platform, ctx.platform);
  assert.equal(target.content, expected.content);
  assert.deepEqual(target.blockerCodes, expected.blockerCodes ?? []);
  const deployment = single(target.deploymentObservations.filter(item => item.after?.nativeIdentity?.packageId === ctx.pluginName),
    'public-status-deployment-missing');
  const products = deployment.products.filter(item => item.product === 'cli');
  assert(products.length && products.every(item => item.version === fixedClientVersion(ctx.platform)),
    'Public status must identify the fixed CLI product.');
  assert.equal(deployment.after.registration, expected.registration ?? (directoryRegistration(ctx) ? 'not-applicable' : 'present'));
  if (expected.scopeActivation !== undefined) assert.equal(deployment.after.scopeActivation, expected.scopeActivation);
  assert.equal(deployment.after.package, expected.package ?? 'present');
  if (deployment.after.package === 'present') {
    assert.equal(deployment.after.ownership, expected.ownership ?? 'aw');
    if (expected.registration !== 'absent') assert.deepEqual(deployment.after.components.find(item => item.id === `skill:${ctx.skillName}`),
      { id: `skill:${ctx.skillName}`, presence: 'present', reasonCodes: [] });
  }
  if (ctx.platform === 'claude' && expected.registration !== 'absent') {
    assert.equal(deployment.after.scopeRegistration, expected.scopeRegistration ?? 'present');
  }
  assert(!Object.hasOwn(deployment.after.configuration ?? {}, 'trust'), 'Public configuration must use the v2 deployment contract.');
  assert(deployment.after.consumers.every(consumer => !Object.hasOwn(consumer, 'trust')),
    'Public deployment must use the v2 consumer contract.');
  const consumer = deployment.after.consumers.find(item => item.productId === products[0].id);
  assert(consumer, 'Public status must retain observations for the selected CLI product.');
  if (expected.activation !== undefined) assert.equal(consumer.activation, expected.activation);
  if (expected.load !== undefined) assert.equal(consumer.load, expected.load);
  return { target, deployment, consumer };
}

export function assertPublicStatus(result, ctx, pluginId, expected) {
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.command, 'plugin.status');
  assert.equal(result.data.context, ctx.scope);
  assert.deepEqual(result.data.coverage.scopes, ctx.scope === 'user' ? ['user'] : ['user', 'project']);
  const ready = expected.content === 'satisfied';
  const unknown = expected.content === 'unknown';
  const blocked = Boolean(expected.blockerCodes?.length);
  assert.equal(result.status, unknown || blocked ? 'blocked' : 'success');
  assert.deepEqual(result.data.counts, { blocked: blocked ? 1 : 0, pending: !ready && !unknown ? 1 : 0,
    unconfirmed: unknown ? 1 : 0, ready: ready ? 1 : 0 });
  assert.equal(result.data.allSatisfied, unknown ? null : ready);
  assert.equal(result.data.inSync, unknown ? null : ready);
  if (unknown) assert.equal(result.data.coverage.requestComplete, false);
  if (!ready && !unknown && !blocked) {
    const sync = ['aw', 'plugin', 'sync', pluginId, '--context', ctx.scope, '--target', ctx.platform];
    assert(result.nextActions.some(item => item.kind === 'command' && item.argv.length === sync.length
      && item.argv.every((arg, index) => arg === sync[index])), 'Public status must offer a sync for the affected target and scope.');
  }
  const { target, deployment, consumer } = assertPublicTarget(result, ctx, pluginId, expected);
  if (ready) assert.equal(target.observation, 'verified');
  assert.equal(target.satisfaction, ready ? expected.satisfaction ?? 'installed' : unknown ? 'unknown' : 'pending');
  return { command: result.command, status: result.status, counts: result.data.counts, allSatisfied: result.data.allSatisfied,
    inSync: result.data.inSync, coverage: result.data.coverage, diagnostics: result.diagnostics, target,
    deployment: { package: deployment.after.package, registration: deployment.after.registration, activation: consumer.activation, load: consumer.load } };
}

async function jsonCommand(ctx, args, cwd) {
  return JSON.parse((await ctx.command(args, cwd)).stdout);
}

function array(value) {
  assert(Array.isArray(value), 'native-management-state-unverified');
  return value;
}

function single(items, reason = 'native-management-state-unverified') {
  assert.equal(items.length, 1, reason);
  return items[0];
}

function fixtureIdentity(ctx, item) {
  return item.name === ctx.pluginName || typeof item.pluginId === 'string'
    && item.pluginId.startsWith(`${ctx.pluginName}@`);
}

async function isolatedFile(ctx, filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('dynamic-consumer-path-unverified');
  try {
    const root = await fs.realpath(ctx.root);
    let actual = await fs.realpath(filename);
    if ((await fs.stat(actual)).isDirectory()) actual = await fs.realpath(path.join(actual, 'SKILL.md'));
    const relative = path.relative(root, actual);
    assert(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    assert((await fs.stat(actual)).isFile());
    return { path: actual, content: await fs.readFile(actual) };
  } catch (error) {
    throw new Error('dynamic-consumer-path-unverified', { cause: error });
  }
}

async function rpcSkills(ctx, cwd) {
  const result = await ctx.rpc(cwd);
  if (ctx.platform === 'codex') {
    const row = single(array(result.data).filter(item => typeof item.cwd === 'string'
      && path.resolve(item.cwd) === path.resolve(cwd)));
    assert.deepEqual(row.errors, [], 'native-management-state-unverified');
    return array(row.skills).filter(item => item.name === `${ctx.pluginName}:${ctx.skillName}`);
  }
  assert.equal(result.state.messageCount, 0);
  assert.equal(result.state.pendingMessageCount, 0);
  assert.equal(result.state.isStreaming, false);
  assert.equal(result.state.isCompacting, false);
  return array(result.commands.commands).filter(item => item.name === `skill:${ctx.skillName}`);
}

export async function readPublicNativeState(ctx, cwd, revision, { active, absent = false }) {
  assert.equal(typeof active, 'boolean');
  if (ctx.platform === 'opencode') return readPublicOpenCodeState(ctx, cwd, revision, { active, absent, version: publicFixtureVersion(revision) });
  let matches;
  if (ctx.platform === 'pi') {
    const skills = await rpcSkills(ctx, cwd);
    const inventory = await readPiPublicInventory(ctx, cwd);
    if (absent || !active) {
      assert.equal(skills.length, 0, 'native-management-state-unverified');
      assert(!ctx.piPublicPackage || !inventory.entries.some(row => path.relative(row.path, ctx.piPublicPackage) === ''),
        'The selected Pi package must be absent from native list in this scope.');
      return { level: 'native-management-state', active: false, present: false, scopes: inventory.scopes };
    }
    const skill = single(skills);
    assert.equal(skill.source, 'skill');
    assert.equal(skill.sourceInfo.scope, ctx.scope);
    assert.equal(skill.sourceInfo.origin, 'package');
    assert.equal(typeof skill.sourceInfo.baseDir, 'string', 'native-management-state-unverified');
    const manifest = await isolatedFile(ctx, path.join(skill.sourceInfo.baseDir, 'package.json'));
    const metadata = JSON.parse(manifest.content.toString('utf8'));
    assert.equal(metadata.version, publicFixtureVersion(revision), 'native-management-version-mismatch');
    const packageRoot = path.dirname(manifest.path);
    const row = single(inventory.entries.filter(row => path.relative(row.path, packageRoot) === ''), 'pi-native-registration-unverified');
    assert.equal(row.scope, ctx.scope);
    const scopeRoot = ctx.scope === 'project' ? path.join(ctx.project, '.pi') : ctx.env.PI_CODING_AGENT_DIR;
    const sourcePath = row.source.startsWith('~/') ? path.join(ctx.env.HOME, row.source.slice(2)) : path.resolve(scopeRoot, row.source);
    assert.equal(path.relative(sourcePath, packageRoot), '', 'Pi native list must report the exact source.');
    ctx.piPublicPackage = packageRoot;
    return { level: 'native-management-state', active: true, present: true, scope: row.scope,
      version: metadata.version, packagePath: packageRoot, listActivation: 'unreported' };
  } else if (ctx.platform === 'grok') {
    const result = await jsonCommand(ctx, ['inspect', '--json'], cwd);
    assert.equal(path.resolve(result.cwd), path.resolve(cwd), 'native-management-state-unverified');
    matches = array(result.plugins).filter(item => item.name === ctx.pluginName);
    const registered = array(await jsonCommand(ctx, ['plugin', 'list', '--json'], cwd)).filter(item => item.name === ctx.pluginName);
    assert.equal(registered.length, !absent && active && ctx.scope === 'user' ? 1 : 0, 'Grok User list must match the expected registration.');
    if (!absent && matches.length) {
      const plugin = single(matches);
      assert.equal(plugin.scope, ctx.scope);
      assert.equal(typeof plugin.path, 'string', 'native-management-state-unverified');
      const manifest = await isolatedFile(ctx, path.join(plugin.path, '.grok-plugin', 'plugin.json'));
      const metadata = JSON.parse(manifest.content.toString('utf8'));
      assert.equal(metadata.name, ctx.pluginName);
      if (ctx.scope === 'user') {
        assert.equal(registered[0].status, 'installed');
        assert.equal(registered[0].version, metadata.version);
        assert.equal(path.relative(registered[0].source, ctx.grokPublicSource), '');
        assert.equal(path.relative(registered[0].path, plugin.path), '');
        ctx.grokInstalledPackage = path.dirname(path.dirname(manifest.path));
      } else {
        assert.equal(result.projectTrusted, true);
        const installed = path.dirname(path.dirname(manifest.path));
        assert.equal(path.relative(path.join(ctx.project, '.grok', 'plugins'), path.dirname(installed)), '');
      }
      matches = [{ ...plugin, version: metadata.version }];
    }
  } else {
    const result = await jsonCommand(ctx, ['plugin', 'list', '--json'], cwd);
    if (ctx.platform === 'codex') {
      const rows = array(result.installed).filter(item => fixtureIdentity(ctx, item));
      assert(rows.every(item => typeof item.installed === 'boolean'), 'native-management-state-unverified');
      matches = rows.filter(item => item.installed);
    } else if (ctx.platform === 'claude') {
      matches = array(result).filter(item => typeof item.id === 'string' && item.id.startsWith(`${ctx.pluginName}@`));
      if (active) {
        const entry = single(matches);
        assert.equal(entry.scope, ctx.scope === 'user' ? 'user' : 'local');
        if (ctx.scope === 'project') assert.equal(path.relative(entry.projectPath, ctx.project), '');
      }
    } else if (['copilot', 'antigravity'].includes(ctx.platform)) {
      matches = array(result).filter(item => item.name === ctx.pluginName);
    } else throw new Error('native-management-state-unverified');
  }
  if (absent || !active && matches.length === 0) {
    assert.equal(matches.length, 0, 'native-management-state-unverified');
    return { level: 'native-management-state', active: false, present: false };
  }
  const item = single(matches);
  assert.equal(typeof item.enabled, 'boolean', 'native-management-state-unverified');
  assert.equal(item.enabled, active, 'native-management-scope-mismatch');
  assert.equal(item.version, publicFixtureVersion(revision), 'native-management-version-mismatch');
  return { level: 'native-management-state', active, present: true, version: item.version,
    ...(item.scope ? { scope: item.scope } : {}) };
}

export async function readPiPublicInventory(ctx, cwd) {
  const lines = (await ctx.command(['list'], cwd)).stdout.replace(/\u001b\[[0-9;]*m/gu, '').trimEnd().split(/\r?\n/u);
  if (lines.length === 1 && lines[0] === 'No packages installed.') return { scopes: [], entries: [] };
  const scopes = [];
  const entries = [];
  let scope;
  for (const line of lines.filter(Boolean)) {
    if (line === 'User packages:' || line === 'Project packages:') {
      scope = line.startsWith('User') ? 'user' : 'project';
      assert(!scopes.includes(scope));
      scopes.push(scope);
    } else if (line.startsWith('    ')) {
      const entry = entries.at(-1);
      assert(entry?.scope === scope && !entry.path && path.isAbsolute(line.slice(4)), 'pi-native-registration-unverified');
      entry.path = path.normalize(line.slice(4));
    } else {
      assert(scope && /^  \S/u.test(line), 'pi-native-registration-unverified');
      entries.push({ scope, source: line.slice(2).replace(/ \(filtered\)$/u, '') });
    }
  }
  assert(scopes.length && entries.length && entries.every(entry => entry.path), 'pi-native-registration-unverified');
  return { scopes, entries };
}

function retainedSharedRegistration(ctx, result, pluginId) {
  const routes = { codex: 'codex-marketplace', claude: 'claude-marketplace',
    copilot: 'copilot-marketplace' };
  if (!routes[ctx.platform] || result?.command !== 'plugin.remove' || result.status !== 'success') return false;
  const request = result.data?.request;
  if (request?.scope !== ctx.scope || request.plugins?.length !== 1 || request.plugins[0] !== pluginId
    || request.targets?.length !== 1 || request.targets[0] !== ctx.platform) return false;
  const targets = result.data?.targetResults;
  if (!Array.isArray(targets) || targets.length !== 1) return false;
  const target = targets[0];
  const empty = (items) => Array.isArray(items) && items.length === 0;
  if (target?.pluginId !== pluginId || target.target !== ctx.platform || target.scope !== ctx.scope
    || target.delivery?.kind !== 'native' || target.delivery.platform !== ctx.platform
    || target.execution !== 'applied' || !empty(target.blockerCodes)
    || target.deploymentPlans?.length !== 1 || target.deploymentReceipts?.length !== 1) return false;
  const plan = target.deploymentPlans[0];
  const receipt = target.deploymentReceipts[0];
  if (!['present', 'unknown'].includes(plan?.sharedReferences) || typeof plan.bindingId !== 'string'
    || !plan.bindingId || receipt?.bindingId !== plan.bindingId
    || typeof plan.physicalKey !== 'string' || !plan.physicalKey
    || receipt.after?.physicalKey !== plan.physicalKey
    || plan.effects?.length !== 1 || receipt.effects?.length !== 1
    || plan.products?.length !== 1 || receipt.products?.length !== 1 || !empty(receipt.unmet)) return false;
  const effect = plan.effects[0];
  const applied = receipt.effects[0];
  const product = plan.products[0];
  if (effect?.kind !== 'deactivate' || typeof effect.id !== 'string' || !effect.id
    || effect.physicalKey !== plan.physicalKey || typeof effect.activationKey !== 'string' || !effect.activationKey
    || applied?.id !== effect.id || applied.status !== 'applied' || applied.mutation !== 'confirmed'
    || product?.product !== 'cli' || product.version !== clients[ctx.platform].version
    || typeof product.id !== 'string' || !product.id || receipt.products[0]?.id !== product.id) return false;
  const after = receipt.after;
  if (after.package !== 'present' || after.registration !== 'present' || after.ownership !== 'aw'
    || after.nativeIdentity?.route !== routes[ctx.platform] || after.nativeIdentity.packageId !== ctx.pluginName
    || !Array.isArray(after.consumers) || after.consumers.length !== 1) return false;
  const consumer = after.consumers[0];
  if (consumer?.productId !== product.id || consumer.activationKey !== effect.activationKey
    || consumer.activation !== 'disabled') return false;
  const warning = plan.sharedReferences === 'unknown' ? 'sharedReferenceUnknown' : 'sharedPackageRetained';
  return Array.isArray(receipt.diagnostics) && receipt.diagnostics.some((item) => item.code === warning
    && item.severity === 'warning' && item.subject?.pluginId === pluginId
    && item.subject.target === ctx.platform && item.subject.scope === ctx.scope);
}

export async function readPublicRemovedNativeScope(ctx, revision, result, pluginId) {
  if (ctx.platform === 'opencode') capturePublicOpenCodeRemoval(ctx, result, pluginId);
  // A successful shared-retention receipt permits a disabled registration. The
  // new client processes still have to prove effective off in both directories.
  const retainedRegistration = retainedSharedRegistration(ctx, result, pluginId);
  const options = { active: false, absent: !retainedRegistration };
  return { retainedRegistration,
    target: await readPublicNativeState(ctx, ctx.project, revision, options),
    neutral: await readPublicNativeState(ctx, ctx.neutral, revision, options) };
}

export async function readDynamicConsumerContent(ctx, cwd, revision) {
  if (ctx.platform === 'opencode') return readPublicOpenCodeDynamicContent(ctx, cwd, revision, publicFixtureVersion(revision));
  let filename;
  if (['codex', 'pi'].includes(ctx.platform)) {
    const skill = single(await rpcSkills(ctx, cwd), 'dynamic-consumer-path-unverified');
    if (ctx.platform === 'codex') {
      assert.equal(skill.enabled, true, 'dynamic-consumer-path-unverified');
      filename = skill.path;
    } else filename = skill.sourceInfo?.path;
  } else if (ctx.platform === 'antigravity') {
    const plugins = await jsonCommand(ctx, ['plugin', 'list', '--json'], cwd);
    const plugin = single(array(plugins).filter(item => item.name === ctx.pluginName), 'dynamic-consumer-path-unverified');
    assert.equal(plugin.enabled, true, 'dynamic-consumer-path-unverified');
    assert.equal(plugin.version, publicFixtureVersion(revision), 'native-management-version-mismatch');
    if (typeof plugin.path === 'string') filename = path.join(plugin.path, 'skills', ctx.skillName, 'SKILL.md');
  } else if (ctx.platform === 'claude') {
    const plugins = await jsonCommand(ctx, ['plugin', 'list', '--json'], cwd);
    const plugin = single(array(plugins).filter(item => typeof item.id === 'string'
      && item.id.startsWith(`${ctx.pluginName}@`)), 'dynamic-consumer-path-unverified');
    assert.equal(plugin.enabled, true, 'dynamic-consumer-path-unverified');
    const root = plugin.readFromFolder ?? plugin.installPath;
    if (typeof root === 'string') filename = path.join(root, 'skills', ctx.skillName, 'SKILL.md');
  } else if (ctx.platform === 'copilot') {
    const skills = await jsonCommand(ctx, ['skill', 'list', '--json'], cwd);
    const skill = single(array(skills).filter(item => item.name === ctx.skillName
      || item.name === `${ctx.pluginName}/${ctx.skillName}`), 'dynamic-consumer-path-unverified');
    assert.equal(skill.enabled, true, 'dynamic-consumer-path-unverified');
    filename = skill.path;
  } else if (ctx.platform === 'grok') {
    const result = await jsonCommand(ctx, ['inspect', '--json'], cwd);
    const skills = array(result.skills).filter(item => item.name === ctx.skillName
      && item.source?.plugin_name === ctx.pluginName);
    if (skills.length) {
      const skill = single(skills, 'dynamic-consumer-path-unverified');
      assert.equal(skill.source.type, 'plugin', 'dynamic-consumer-path-unverified');
      filename = skill.source.path;
    } else {
      // Fixed Grok project inspect can expose the installed plugin while its
      // Skill inventory is empty. Its enabled installed directory is sufficient
      // to identify this fixture's actual copy; loading remains an observation.
      const plugin = single(array(result.plugins).filter(item => item.name === ctx.pluginName), 'dynamic-consumer-path-unverified');
      assert.equal(plugin.enabled, true, 'dynamic-consumer-path-unverified');
      assert.equal(plugin.scope, ctx.scope, 'dynamic-consumer-path-unverified');
      if (typeof plugin.path === 'string') filename = path.join(plugin.path, 'skills', ctx.skillName, 'SKILL.md');
    }
  }
  const actual = await isolatedFile(ctx, filename);
  assert.deepEqual(actual.content, ctx.publicConsumedSkill ?? await fs.readFile(ctx.publicSkillFile), 'dynamic-consumer-content-mismatch');
  return { level: 'dynamic-consumer-content', revision, path: actual.path,
    sha256: sha256(actual.content), bytes: actual.content.length };
}
