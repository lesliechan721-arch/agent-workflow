import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPublicTarget, readPiPublicInventory, readPublicNativeState, readPublicRemovedNativeScope } from './native-platform-public-state.mjs';
import { fixedClientVersion, sha256 } from './native-platform-runtime.mjs';

async function codexList(ctx, cwd, { entry, name = ctx.pluginName } = {}) {
  const result = await ctx.command(['plugin', 'list', '--json'], cwd, { entry });
  const rows = JSON.parse(result.stdout).installed.filter(row => row.name === name && row.installed === true);
  assert.equal(rows.length, 1, 'Codex must list the installed fixture registration.');
  const row = rows[0];
  assert.equal(typeof row.enabled, 'boolean');
  assert.equal(typeof row.pluginId, 'string');
  assert(!Object.hasOwn(row, 'trust'), 'The native list does not supply a general deployment trust field.');
  return { id: row.pluginId, installed: row.installed, enabled: row.enabled, version: row.version };
}

async function qualifyCodexEntries(ctx, status) {
  const file = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const [originalDirectory, ...systemDirectories] = ctx.env.PATH.split(path.delimiter);
  const dir = path.join(ctx.root, 'alternate-codex-bin');
  await fs.mkdir(dir);
  const alternate = path.join(dir, file);
  await fs.copyFile(ctx.publicClientEntry, alternate);
  if (process.platform !== 'win32') await fs.chmod(alternate, 0o755);
  ctx.publicAlternateClientEntry = alternate;
  assert.equal(sha256(await fs.readFile(alternate)), sha256(await fs.readFile(ctx.publicClientEntry)));
  const primaryList = await codexList(ctx, ctx.project);
  assert.deepEqual(await codexList(ctx, ctx.project, { entry: alternate }), primaryList);
  assert.equal((await ctx.command(['--version'], ctx.project, { entry: alternate })).stdout.trim(),
    `codex-cli ${fixedClientVersion('codex')}`);
  const records = [];
  const originalPath = ctx.env.PATH;
  try {
    for (const directories of [[originalDirectory, dir], [dir, originalDirectory]]) {
      ctx.env.PATH = [...directories, ...systemDirectories].join(path.delimiter);
      const targets = await ctx.aw(['target', 'list']);
      const installs = targets.data.availability.find(item => item.id === 'codex').installations.filter(item => item.product === 'cli');
      assert.equal(installs.length, 2, 'AW must discover both separate Codex entry paths.');
      const discovered = await Promise.all(installs.map(async installation => ({ version: installation.version,
        entry: await fs.realpath(installation.entry.executable) })));
      const expected = await Promise.all(directories.map(async directory => ({ version: fixedClientVersion('codex'),
        entry: await fs.realpath(path.join(directory, file)) })));
      assert.deepEqual(discovered, expected, 'AW discovery must observe the reversed order of the actual Codex entries.');
      const { counts, allSatisfied, inSync, deployment } = await status();
      records.push({ discovered, counts, allSatisfied, inSync, deployment });
    }
  } finally { ctx.env.PATH = originalPath; }
  return { native: primaryList, entries: records };
}

async function qualifyCodexScopes(ctx, { status, ready, pluginId }) {
  const { upsertCodexPluginEnabled } = await import('../../packages/cli/dist/src/utils/codex-config.js');
  const userConfig = path.join(ctx.env.CODEX_HOME, 'config.toml');
  const projectConfig = path.join(ctx.project, '.codex', 'config.toml');
  const user = await fs.readFile(userConfig, 'utf8');
  const project = await fs.readFile(projectConfig, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const id = (await codexList(ctx, ctx.project)).id;
  const projectHeader = `[projects.${JSON.stringify(ctx.project)}]`;
  const trustEntry = `${projectHeader}\ntrust_level = "trusted"`;
  async function configure(userEnabled, projectEnabled, trusted = true) {
    assert(!user.includes(projectHeader) || user.includes(trustEntry));
    const trust = `${projectHeader}\ntrust_level = "${trusted ? 'trusted' : 'untrusted'}"`;
    const userBase = user.includes(trustEntry) ? user.replace(trustEntry, trust) : `${user}\n${trust}\n`;
    await fs.writeFile(userConfig, upsertCodexPluginEnabled(userBase, id, { enabled: userEnabled }));
    if (projectEnabled === undefined) await fs.rm(projectConfig, { force: true });
    else {
      await fs.mkdir(path.dirname(projectConfig), { recursive: true });
      await fs.writeFile(projectConfig, upsertCodexPluginEnabled(project ?? '', id, { enabled: projectEnabled }));
    }
  }
  async function readPair(userEnabled, projectEnabled) {
    const exact = await codexList(ctx, ctx.project);
    const neutral = await codexList(ctx, ctx.neutral);
    assert.equal(exact.id, id);
    assert.equal(neutral.id, id);
    assert.equal(exact.enabled, projectEnabled);
    assert.equal(neutral.enabled, userEnabled);
    return { exact, neutral };
  }
  let checked = false;
  try {
    if (ctx.scope === 'project') {
      await ctx.check('codex-project-independent-activation', async () => ({ ...await readPair(false, true),
        public: await status({ expected: { ...ready, scopeActivation: 'enabled' } }) }));
      await ctx.check('codex-equal-native-results-cannot-confirm-independent-project-activation', async () => {
        await configure(true, true);
        const native = await readPair(true, true);
        await ctx.aw(['plugin', 'install', pluginId, '--scope', 'user', '--only', 'requirements', '--yes']);
        try {
          const query = await ctx.aw(['plugin', 'status', pluginId, '--context', 'project'], ctx.project,
            { expectedExitCode: 4, expectedStatus: 'partial' });
          const userTarget = assertPublicTarget(query, { ...ctx, scope: 'user' }, pluginId, ready);
          const projectTarget = assertPublicTarget(query, ctx, pluginId, { ...ready, content: 'unknown', scopeActivation: 'unknown' });
          assert.deepEqual(query.data.counts, { blocked: 0, pending: 0, unconfirmed: 1, ready: 1 });
          assert.equal(query.data.coverage.requestComplete, false);
          assert.equal(query.data.allSatisfied, null);
          assert.equal(query.data.inSync, null);
          assert(query.diagnostics.some(item => item.code === 'codexProjectActivationUnconfirmed' && item.severity === 'warning'
            && item.subject?.pluginId === pluginId && item.subject.scope === 'project'));
          return { native, counts: query.data.counts, status: query.status, user: userTarget.target, project: projectTarget.target };
        } finally { await ctx.aw(['plugin', 'remove', pluginId, '--scope', 'user', '--only', 'requirements', '--yes']); }
      });
      await ctx.check('codex-project-layer-refused-by-host', async () => {
        await configure(false, true, false);
        return { ...await readPair(false, false), public: await status({ expected: { ...ready, activation: 'disabled',
          scopeActivation: 'disabled', content: 'drifted' } }) };
      });
    } else {
      await ctx.check('codex-user-native-disability', async () => {
        await configure(false, undefined);
        return { ...await readPair(false, false), public: await status({ expected: { ...ready, activation: 'disabled', content: 'drifted' } }) };
      });
      await configure(true, undefined);
      let installedProjectConfig;
      await qualifySharedProvider(ctx, pluginId, async () => {
        installedProjectConfig = await fs.readFile(projectConfig, 'utf8');
        await fs.writeFile(projectConfig, upsertCodexPluginEnabled(installedProjectConfig, id, { enabled: false }));
        return readPair(true, false);
      }, async () => {
        if (installedProjectConfig !== undefined) await fs.writeFile(projectConfig, installedProjectConfig);
      });
    }
    checked = true;
  } finally {
    try {
      await fs.writeFile(userConfig, user);
      if (project === null) await fs.rm(projectConfig, { force: true });
      else await fs.writeFile(projectConfig, project);
    } catch (error) { if (checked) throw error; }
  }
}

export async function verifyCodexSharedProviderRemoval(ctx, { pluginId, dependentId, userProvider, dependentDeployment, removal }) {
  assert.equal(removal.command, 'plugin.remove');
  assert.equal(removal.data.request.scope, 'project');
  assert.deepEqual(removal.data.request.plugins, [dependentId]);
  assert.deepEqual(removal.data.request.targets, ['codex']);
  assert.equal(removal.data.changes.requirements, 'changed');
  assert(Array.isArray(removal.data.requirements.roots) && !removal.data.requirements.roots.includes(dependentId),
    'The remove receipt must confirm cancellation of the Project dependent requirement.');

  const { packageId, registrationId } = dependentDeployment.after.nativeIdentity;
  assert.equal(typeof registrationId, 'string');
  const { parseCodexConfig } = await import('../../packages/cli/dist/src/utils/codex-config.js');
  const projectConfig = await fs.readFile(path.join(ctx.project, '.codex', 'config.toml'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  assert.equal(parseCodexConfig(projectConfig).plugins[registrationId]?.enabled, undefined,
    'The removed dependent must have no explicit Project activation.');
  const native = await readPublicRemovedNativeScope({ ...ctx, scope: 'project', pluginName: packageId }, 1, removal, dependentId);

  const result = await ctx.aw(['plugin', 'status', '--context', 'project']);
  const { declarations } = result.data.requirements;
  const project = declarations.find((entry) => entry.scope === 'project');
  const user = declarations.find((entry) => entry.scope === 'user');
  assert(Array.isArray(project?.roots) && !project.roots.includes(dependentId),
    'Fresh status must confirm the Project dependent requirement is gone.');
  assert(user?.roots?.includes(pluginId), 'Fresh status must retain the User provider requirement.');
  const { target, deployment, consumer } = assertPublicTarget(result, ctx, pluginId, { content: 'satisfied', activation: 'enabled' });
  assert.equal(target.observation, 'verified');
  assert.equal(target.satisfaction, 'installed');
  assert.equal(deployment.after.physicalKey, userProvider.after.physicalKey);
  assert.equal(consumer.activationKey, userProvider.after.consumers[0].activationKey);
  return { command: removal.command, requirements: declarations, projectActivation: 'absent', native,
    userProvider: { target, physicalKey: deployment.after.physicalKey, activationKey: consumer.activationKey } };
}

async function qualifySharedProvider(ctx, pluginId, disableProjectProvider, restoreProjectProvider) {
  const dependentName = `${ctx.pluginName}-dependent`;
  const dependentId = `qualification/${dependentName}`;
  const asProject = { ...ctx, scope: 'project' };
  await ctx.check(`${ctx.platform}-project-shared-user-provider`, async () => {
    const initial = await ctx.aw(['plugin', 'status', '--context', 'user']);
    const { deployment: userProvider } = assertPublicTarget(initial, ctx, pluginId, { content: 'satisfied', activation: 'enabled' });
    await ctx.aw(['plugin', 'install', dependentId, '--scope', 'project', '--target', ctx.platform, '--yes']);
    const readStatus = () => ctx.aw(['plugin', 'status', pluginId, dependentId, '--context', 'project']);
    const dependentTarget = (result, content = 'satisfied') => assertPublicTarget(result,
      { ...asProject, pluginName: dependentName }, dependentId, { content, activation: 'enabled' });
    const provider = (target, scopeRegistration) => {
      const deployments = target.deploymentObservations.filter(item => item.after.nativeIdentity?.packageId === ctx.pluginName);
      assert.equal(deployments.length, 1, 'The Project dependent must observe its actual User package provider.');
      assert.equal(deployments[0].after.physicalKey, userProvider.after.physicalKey);
      assert.equal(deployments[0].after.registration, 'present');
      assert.equal(deployments[0].after.package, 'present');
      if (scopeRegistration) assert.equal(deployments[0].after.scopeRegistration, scopeRegistration);
      assert.notEqual(deployments[0].after.consumers[0].activationKey, userProvider.after.consumers[0].activationKey);
      return deployments[0];
    };
    const evidence = {};
    let dependentDeployment;
    let removal;
    let checked = false;
    try {
      let settled = await readStatus();
      if (ctx.platform === 'claude') {
        // Claude creates a local registration for an installed Project dependency
        // and keeps its underlying User provider package. Observe both scopes,
        // then remove only the local registration to exercise actual inheritance.
        const registration = userProvider.after.nativeIdentity.registrationId;
        assert.equal(typeof registration, 'string');
        const inventory = JSON.parse((await ctx.command(['plugin', 'list', '--json'], ctx.project)).stdout);
        const local = inventory.filter(item => item.id === registration && item.scope === 'local');
        assert.equal(local.length, 1);
        assert.equal(path.relative(local[0].projectPath, ctx.project), '');
        assert.equal(local[0].enabled, true);
        const before = provider(dependentTarget(settled).target, 'present');
        assert.equal(before.after.consumers[0].activation, 'enabled');
        const remove = await ctx.command(['plugin', 'uninstall', registration, '--scope', 'local', '--json'], ctx.project);
        const result = JSON.parse(remove.stdout);
        assert.equal(result.outcome, 'ok');
        assert.equal(result.pluginId, registration);
        evidence.independentProjectRegistration = { native: local[0], public: before };
        settled = await readStatus();
      }
      const { target: dependent, deployment } = dependentTarget(settled);
      dependentDeployment = deployment;
      const inheritedProvider = provider(dependent, ctx.platform === 'claude' ? 'absent' : undefined);
      assert.equal(inheritedProvider.after.consumers[0].activation, 'enabled');
      const native = await readPublicNativeState(ctx, ctx.project, 1, { active: true });
      Object.assign(evidence, { inheritedProvider, native, dependent });
      if (disableProjectProvider) {
        const disabledNative = await disableProjectProvider();
        const result = await readStatus();
        const { target: affected } = dependentTarget(result, 'drifted');
        const after = provider(affected);
        assert.equal(after.after.consumers[0].activation, 'disabled');
        const unaffected = assertPublicTarget(result, ctx, pluginId, { content: 'satisfied', activation: 'enabled' });
        Object.assign(evidence, { disabledNative, disabledProvider: after, affected, unaffectedUser: unaffected.target });
      }
      checked = true;
    } finally {
      try {
        await restoreProjectProvider?.();
        removal = await ctx.aw(['plugin', 'remove', dependentId, '--scope', 'project', '--yes']);
      } catch (error) { if (checked) throw error; }
    }
    if (ctx.platform === 'codex') {
      evidence.removal = await verifyCodexSharedProviderRemoval(ctx, { pluginId, dependentId, userProvider, dependentDeployment, removal });
    }
    return evidence;
  });
}

async function qualifyGrokForeignReplacement(ctx, pluginId) {
  const originalSource = ctx.grokPublicSource;
  const clone = path.join(ctx.root, 'grok-foreign-source');
  const inventory = async () => {
    const result = JSON.parse((await ctx.command(['plugin', 'list', '--json'], ctx.neutral)).stdout);
    const matches = result.filter(item => item.name === ctx.pluginName);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].status, 'installed');
    return matches[0];
  };
  const initial = await inventory();
  assert.equal(path.relative(initial.source, originalSource), '');
  const initialAuthorization = JSON.parse((await ctx.command(['inspect', '--json'], ctx.neutral)).stdout);
  assert.equal(initialAuthorization.projectTrusted, true, 'The User refresh fixture must have actual Grok authorization.');
  await fs.mkdir(clone);
  for (const directory of ['.grok-plugin', 'skills']) {
    await fs.cp(path.join(originalSource, directory), path.join(clone, directory), { recursive: true });
  }
  const uninstall = () => ctx.command(['plugin', 'uninstall', ctx.pluginName, '--confirm'], ctx.neutral);
  const install = (source) => ctx.command(['plugin', 'install', source, '--trust'], ctx.neutral);
  await uninstall();
  await install(clone);
  try {
    const before = await inventory();
    assert.equal(path.relative(before.source, clone), '');
    const target = await ctx.aw(['plugin', 'sync', pluginId, '--context', 'user', '--target', 'grok', '--yes'], ctx.neutral,
      { expectedExitCode: 3, expectedStatus: 'blocked' });
    const safety = target.data.targetResults.find(item => item.pluginId === pluginId && item.target === 'grok' && item.scope === 'user');
    assert(safety?.blockerCodes.some(code => ['deploymentOwnershipUnconfirmed', 'nativeIdentityUnconfirmed'].includes(code)),
      'Grok refresh must refuse the registered plugin from another source.');
    assert.deepEqual(await inventory(), before, 'The refused refresh must preserve the registered external source.');
    return { projectTrusted: true, registeredSource: before.source, blocked: safety.blockerCodes };
  } finally { await uninstall(); await install(originalSource); }
}

export async function qualifyPublicPlatformCases(ctx, { pluginId, ready, status }) {
  if (ctx.platform === 'codex') {
    if (ctx.scope === 'user') await ctx.check('codex-equivalent-client-entries-and-order', () => qualifyCodexEntries(ctx, status));
    await qualifyCodexScopes(ctx, { status, ready, pluginId });
  }
  if (ctx.platform === 'claude' && ctx.scope === 'user') await qualifySharedProvider(ctx, pluginId);
  if (ctx.platform === 'grok' && ctx.scope === 'user') {
    await ctx.check('grok-user-refresh-refuses-other-source', () => qualifyGrokForeignReplacement(ctx, pluginId));
  }
  if (ctx.platform === 'pi' && ctx.scope === 'project') await ctx.check('pi-hidden-project-registration', async () => {
    const file = path.join(ctx.env.PI_CODING_AGENT_DIR, 'trust.json');
    const before = await fs.readFile(file);
    try {
      await fs.writeFile(file, JSON.stringify({ ...JSON.parse(before), [ctx.project]: false }) + '\n');
      const native = await readPiPublicInventory(ctx, ctx.project);
      assert(!native.scopes.includes('project'), 'The fixed Pi client must omit the hidden Project section.');
      const query = await status({ expected: { ...ready, content: 'unknown', registration: 'unknown' },
        explicit: true, diagnostic: 'piProjectRegistrationNotVisible' });
      return { native, query };
    } finally { await fs.writeFile(file, before); }
  });
  if (ctx.platform === 'grok' && ctx.scope === 'project') await ctx.check('grok-project-host-authorization', async () => {
    const file = path.join(ctx.env.GROK_HOME, 'trusted_folders.toml');
    const before = await fs.readFile(file, 'utf8');
    assert(before.includes('trusted = true'));
    try {
      await fs.writeFile(file, before.replace('trusted = true', 'trusted = false'));
      const native = JSON.parse((await ctx.command(['inspect', '--json'], ctx.project)).stdout);
      assert.equal(native.projectTrusted, false);
      const publicResult = await status({ expected: { content: 'drifted', blockerCodes: ['grokProjectAuthorizationDenied'] },
        diagnostic: 'grokProjectAuthorizationDenied' });
      return { projectTrusted: native.projectTrusted, public: publicResult };
    } finally { await fs.writeFile(file, before); }
  });
  if (ctx.platform === 'opencode') await ctx.check('opencode-explicit-optional-load', () => status({
    observeNative: true,
  }));
}

export async function qualifyPiAgentPermission(ctx) {
  const id = `qualification/${ctx.pluginName}-agent`;
  await ctx.check('pi-agent-without-native-consumer', async () => {
    const native = await readPiPublicInventory(ctx, ctx.project);
    assert(!native.entries.some(item => item.source.includes('pi-subagents')));
    const installation = await ctx.aw(['plugin', 'install', id, '--scope', 'project', '--target', 'pi', '--yes']);
    try {
      const notices = installation.diagnostics.filter(item => item.code === 'piAgentConsumerUnavailable'
        && item.subject?.pluginId === id && item.subject.target === 'pi' && item.subject.scope === 'project');
      assert.equal(notices.length, 1);
      assert.equal(notices[0].severity, 'warning');
      assert.equal(notices[0].detail.reasonCode, 'piAgentConsumerMissing');
      const result = await ctx.aw(['plugin', 'status', '--context', 'project']);
      const item = result.data.inventory.find(entry => entry.pluginId === id);
      const target = item.targetResults.find(target => target.target === 'pi' && target.scope === 'project');
      assert.equal(target.satisfaction, 'installed');
      assert.deepEqual(target.blockerCodes, []);
      const after = target.deploymentObservations.find(observation => observation.after.ownership === 'aw').after;
      const directory = after.nativeIdentity.sourceLocation;
      const relative = path.relative(path.join(ctx.project, '.pi', 'aw-packages'), directory);
      assert.equal(relative, 'aw-qualification-' + ctx.pluginName + '-agent');
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      assert.deepEqual(manifest.pi.subagents.agents, ['./agents']);
      const role = await fs.readFile(path.join(directory, 'agents', relative + '-qualification.md'), 'utf8');
      assert(role.includes('Return only a local fixture marker.'));
      return { native, roleInstalled: true, target, missingConsumerNotice: notices[0], diagnostics: result.diagnostics };
    } finally { await ctx.aw(['plugin', 'remove', id, '--scope', 'project', '--yes']); }
  });
}
