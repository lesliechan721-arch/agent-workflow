import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { clients, sha256 } from './native-platform-runtime.mjs';
import { readPublicOpenCodeState, capturePublicOpenCodeRemoval, readPublicOpenCodeDynamicContent } from './native-platform-opencode-public.mjs';

export const publicFixtureVersion = revision => `0.1.${Math.min(revision, 2) - 1}`;

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

async function geminiExtensions(ctx, cwd) {
  const result = await ctx.command(['extensions', 'list'], cwd);
  const text = `${result.stdout}\n${result.stderr}`.replace(/\r\n/gu, '\n').trim();
  if (text === 'No extensions installed.') return [];
  const lines = text.split('\n');
  const starts = lines.flatMap((line, index) => /^[✓✗] /u.test(line) ? [index] : []);
  assert(starts.length && starts[0] === 0, 'native-management-state-unverified');
  const matches = [];
  for (let index = 0; index < starts.length; index++) {
    const block = lines.slice(starts[index], starts[index + 1] ?? lines.length);
    const header = /^([✓✗]) (.+) \(([^()]+)\)$/u.exec(block[0]);
    assert(header, 'native-management-state-unverified');
    if (header[2] !== ctx.pluginName) continue;
    const workspace = block.filter(line => line.startsWith(' Enabled (Workspace): '));
    assert.equal(workspace.length, 1, 'native-management-state-unverified');
    assert(/^ Enabled \(Workspace\): (true|false)$/u.test(workspace[0]), 'native-management-state-unverified');
    const enabled = workspace[0] === ' Enabled (Workspace): true';
    assert.equal(header[1], enabled ? '✓' : '✗', 'native-management-state-unverified');
    matches.push({ name: header[2], version: header[3], enabled });
  }
  return matches;
}

export async function readPublicNativeState(ctx, cwd, revision, { active, absent = false }) {
  assert.equal(typeof active, 'boolean');
  if (ctx.platform === 'opencode') return readPublicOpenCodeState(ctx, cwd, revision, { active, absent, version: publicFixtureVersion(revision) });
  let matches;
  if (ctx.platform === 'gemini') {
    matches = await geminiExtensions(ctx, cwd);
  } else if (ctx.platform === 'pi') {
    const skills = await rpcSkills(ctx, cwd);
    if (absent || !active) {
      assert.equal(skills.length, 0, 'native-management-state-unverified');
      return { level: 'native-management-state', active: false, present: false };
    }
    const skill = single(skills);
    assert.equal(skill.source, 'skill');
    assert.equal(skill.sourceInfo.scope, ctx.scope);
    assert.equal(skill.sourceInfo.origin, 'package');
    assert.equal(typeof skill.sourceInfo.baseDir, 'string', 'native-management-state-unverified');
    const manifest = await isolatedFile(ctx, path.join(skill.sourceInfo.baseDir, 'package.json'));
    const metadata = JSON.parse(manifest.content.toString('utf8'));
    assert.equal(metadata.version, publicFixtureVersion(revision), 'native-management-version-mismatch');
    return { level: 'native-management-state', active: true, present: true, scope: skill.sourceInfo.scope,
      version: metadata.version, packagePath: manifest.path };
  } else if (ctx.platform === 'grok') {
    const result = await jsonCommand(ctx, ['inspect', '--json'], cwd);
    assert.equal(path.resolve(result.cwd), path.resolve(cwd), 'native-management-state-unverified');
    matches = array(result.plugins).filter(item => item.name === ctx.pluginName);
    if (!absent && matches.length) {
      const plugin = single(matches);
      assert.equal(plugin.scope, ctx.scope);
      assert.equal(typeof plugin.path, 'string', 'native-management-state-unverified');
      const manifest = await isolatedFile(ctx, path.join(plugin.path, '.grok-plugin', 'plugin.json'));
      const metadata = JSON.parse(manifest.content.toString('utf8'));
      assert.equal(metadata.name, ctx.pluginName);
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

function retainedSharedRegistration(ctx, result, pluginId) {
  const routes = { codex: 'codex-marketplace', claude: 'claude-marketplace',
    gemini: 'gemini-extension', copilot: 'copilot-marketplace' };
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
  } else if (ctx.platform === 'gemini') {
    const result = await ctx.command(['skills', 'list'], cwd);
    const text = result.stdout.replace(/\r\n/gu, '\n').replace(/\n+$/u, '');
    const heading = 'Discovered Agent Skills:\n\n';
    assert(text.startsWith(heading), 'dynamic-consumer-path-unverified');
    const blocks = text.slice(heading.length).split(/\n{2,}/u).map(block => block.split('\n'));
    const lines = single(blocks.filter(block => block[0] === `${ctx.skillName} [Enabled]`), 'dynamic-consumer-path-unverified');
    const locations = lines.filter(line => line.startsWith('  Location:    '));
    filename = single(locations, 'dynamic-consumer-path-unverified').slice('  Location:    '.length);
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
  assert.deepEqual(actual.content, await fs.readFile(ctx.publicSkillFile), 'dynamic-consumer-content-mismatch');
  return { level: 'dynamic-consumer-content', revision, path: actual.path,
    sha256: sha256(actual.content), bytes: actual.content.length };
}
