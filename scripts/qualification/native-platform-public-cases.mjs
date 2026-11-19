import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPublicTarget, readPiPublicInventory, readPublicNativeState } from './native-platform-public-state.mjs';
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
  } finally {
    await fs.writeFile(userConfig, user);
    if (project === null) await fs.rm(projectConfig, { force: true });
    else await fs.writeFile(projectConfig, project);
  }
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
      { ...asProject, pluginName: dependentName }, dependentId, { content, activation: 'enabled' }).target;
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
    try {
      const evidence = {};
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
        const before = provider(dependentTarget(settled), 'present');
        assert.equal(before.after.consumers[0].activation, 'enabled');
        const remove = await ctx.command(['plugin', 'uninstall', registration, '--scope', 'local', '--json'], ctx.project);
        const result = JSON.parse(remove.stdout);
        assert.equal(result.outcome, 'ok');
        assert.equal(result.pluginId, registration);
        evidence.independentProjectRegistration = { native: local[0], public: before };
        settled = await readStatus();
      }
      const dependent = dependentTarget(settled);
      const inheritedProvider = provider(dependent, ctx.platform === 'claude' ? 'absent' : undefined);
      assert.equal(inheritedProvider.after.consumers[0].activation, 'enabled');
      const native = await readPublicNativeState(ctx, ctx.project, 1, { active: true });
      Object.assign(evidence, { inheritedProvider, native, dependent });
      if (disableProjectProvider) {
        const disabledNative = await disableProjectProvider();
        const result = await readStatus();
        const affected = dependentTarget(result, 'drifted');
        const after = provider(affected);
        assert.equal(after.after.consumers[0].activation, 'disabled');
        const unaffected = assertPublicTarget(result, ctx, pluginId, { content: 'satisfied', activation: 'enabled' });
        Object.assign(evidence, { disabledNative, disabledProvider: after, affected, unaffectedUser: unaffected.target });
      }
      return evidence;
    } finally {
      await restoreProjectProvider?.();
      await ctx.aw(['plugin', 'remove', dependentId, '--scope', 'project', '--yes']);
    }
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
  if (ctx.platform === 'gemini') await ctx.check('gemini-native-disable', async () => {
    const file = path.join(ctx.env.GEMINI_CLI_HOME, '.gemini', 'extensions', 'extension-enablement.json');
    const before = await fs.readFile(file);
    try {
      if (ctx.scope === 'project') await ctx.command(['extensions', 'disable', ctx.pluginName, '--scope', 'Workspace']);
      else {
        // 0.67.0's User disable command changes a home-path rule. Use its
        // native global default-off rule to also disable fresh external cwd.
        const config = JSON.parse(before);
        assert(config[ctx.pluginName]?.overrides.includes('*'));
        config[ctx.pluginName].overrides = ['!*'];
        await fs.writeFile(file, JSON.stringify(config, null, 2));
      }
      const native = await readPublicNativeState(ctx, ctx.project, 1, { active: false });
      assert.equal(native.present, true, 'Native disable must retain the Gemini registration.');
      return { native, public: await status({ expected: { ...ready, content: 'drifted', activation: 'disabled' } }) };
    } finally { await fs.writeFile(file, before); }
  });
}

export async function qualifyPiAgentPermission(ctx) {
  const id = `qualification/${ctx.pluginName}-agent`;
  await ctx.check('pi-agent-without-native-consumer', async () => {
    const native = await readPiPublicInventory(ctx, ctx.project);
    assert(!native.entries.some(item => item.source.includes('pi-subagents')));
    await ctx.aw(['plugin', 'install', id, '--scope', 'project', '--only', 'requirements', '--yes']);
    try {
      const result = await ctx.aw(['plugin', 'status', id, '--context', 'project'], ctx.project,
        { expectedExitCode: 3, expectedStatus: 'blocked' });
      const entry = result.data.inventory.find(item => item.pluginId === id);
      assert.equal(entry.targetResults.length, 1);
      const target = entry.targetResults[0];
      assert.equal(target.target, 'pi');
      assert.equal(target.scope, 'project');
      assert.equal(target.content, 'unknown');
      assert(target.blockerCodes.includes('consumer-missing'), 'Pi must report the missing native Agent permission path.');
      assert.equal(result.data.counts.ready, 0);
      return { native, target, diagnostics: result.diagnostics };
    } finally { await ctx.aw(['plugin', 'remove', id, '--scope', 'project', '--only', 'requirements', '--yes']); }
  });
}
