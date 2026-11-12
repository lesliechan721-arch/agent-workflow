import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { clients, sha256 } from './native-platform-runtime.mjs';

// One fixed Node child, using AW's real default native backend and the same
// isolated cwd/env as Pi. This observes path spelling without granting trust.
export async function observeNativeWorkingDirectory(ctx) {
  const { runNativeCli } = await import('../../packages/cli/dist/src/utils/native-cli.js');
  const result = await runNativeCli({ command: process.execPath, args: ['-e',
    'const cwd=process.cwd(); process.stdout.write(JSON.stringify({cwd,realpath:require("node:fs").realpathSync(cwd)}));'],
    cwd: ctx.project, env: ctx.env, timeoutMs: 5000 });
  assert.equal(result.exitCode, 0, 'The isolated native cwd probe must succeed.');
  assert(result.stdout.length < 16 * 1024, 'The native cwd probe output must be bounded.');
  const value = JSON.parse(result.stdout);
  for (const key of ['cwd', 'realpath']) assert(typeof value[key] === 'string' && path.isAbsolute(value[key])
    && value[key].length <= 4096, 'The native cwd probe must return absolute paths.');
  const namespaced = (value) => value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\');
  return { requestedCwd: ctx.project, cwd: value.cwd, realpath: value.realpath,
    requestedUtf16Length: ctx.project.length, cwdUtf16Length: value.cwd.length, realpathUtf16Length: value.realpath.length,
    requestedNamespaced: namespaced(ctx.project), cwdNamespaced: namespaced(value.cwd), realpathNamespaced: namespaced(value.realpath) };
}

// Expose the acquired client to public AW discovery. Only the temporary npm
// prefix or this scope's private bin is writable; no user launcher is changed.
export async function preparePublicClientPath(ctx) {
  const directory = ctx.clientBin ?? path.join(ctx.root, 'client-bin');
  await fs.mkdir(directory, { recursive: true });
  assert(ctx.launcher.prefix.length <= 1, 'Public AW requires a direct client entry.');
  const entry = ctx.launcher.prefix[0] ?? ctx.launcher.executable;
  const windows = process.platform === 'win32';
  const npmEntry = ctx.launcher.prefix.length === 1;
  const destination = path.join(directory, `${ctx.platform}${windows ? npmEntry ? '.cmd' : '.exe' : ''}`);
  if (windows && npmEntry) {
    const { renderNpmCmdShim } = await import('../../packages/cli/dist/src/utils/windows-npm-shim.js');
    const relative = path.relative(directory, entry);
    assert(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
      'The acquired npm entry must be inside its temporary prefix.');
    const content = renderNpmCmdShim(relative.replaceAll('/', '\\'));
    try { await fs.writeFile(destination, content, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await fs.readFile(destination, 'utf8'), content); }
  } else if (windows) {
    try { await fs.copyFile(entry, destination, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    assert.equal(sha256(await fs.readFile(destination)), sha256(await fs.readFile(entry)));
  } else {
    try { await fs.symlink(entry, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await fs.realpath(destination), await fs.realpath(entry)); }
  }
  const systemDirectories = windows ? [path.join(ctx.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'];
  if (windows) {
    const { resolveWindowsPathCommand } = await import('../../packages/cli/dist/src/utils/windows-npm-shim.js');
    const git = await resolveWindowsPathCommand('git', ctx.project, ctx.env);
    assert(git, 'Public authoring requires the runner Git executable.');
    systemDirectories.push(path.dirname(git));
  }
  ctx.env.PATH = [directory, path.dirname(process.execPath), ...systemDirectories].join(path.delimiter);
  return fs.realpath(destination);
}

async function readGrokSkills(ctx, cwd, revision, present) {
  // inspect is a new, read-only client process. It starts no RPC or model session.
  const native = await ctx.command(['inspect', '--json'], cwd);
  assert(!native.cancelled && native.terminationReason === 'complete', 'Grok inspect must complete normally.');
  const result = JSON.parse(native.stdout);
  assert.equal(result.grokVersion, clients.grok.version);
  assert.equal(path.resolve(result.cwd), path.resolve(cwd));
  assert(Array.isArray(result.plugins) && Array.isArray(result.skills));
  const plugins = result.plugins.filter((plugin) => plugin.name === ctx.pluginName);
  const skills = result.skills.filter((skill) => skill.name === ctx.skillName || skill.source?.plugin_name === ctx.pluginName);
  assert.equal(plugins.length, present ? 1 : 0, 'Grok must observe the requested fixture registration.');
  assert.equal(skills.length, present ? 1 : 0, 'Grok must discover the requested fixture Skill.');
  if (present) {
    const plugin = plugins[0];
    const skill = skills[0];
    assert.equal(plugin.scope, 'user');
    assert.equal(plugin.enabled, true);
    const installedRoot = await fs.realpath(path.join(ctx.env.GROK_HOME, 'installed-plugins'));
    const installed = await fs.realpath(plugin.path);
    const relative = path.relative(installedRoot, installed);
    assert(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    assert.equal(skill.name, ctx.skillName);
    assert.equal(skill.description, `AW public acceptance revision ${revision}`);
    assert.equal(skill.source?.type, 'plugin');
    assert.equal(skill.source.plugin_name, ctx.pluginName);
    const installedSkill = path.join(installed, 'skills', ctx.skillName, 'SKILL.md');
    assert.equal(await fs.realpath(skill.source.path), await fs.realpath(installedSkill));
    const manifestBytes = await fs.readFile(path.join(installed, '.grok-plugin/plugin.json'));
    assert.deepEqual(manifestBytes, await fs.readFile(path.join(ctx.grokPublicSource, '.grok-plugin/plugin.json')));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.name, ctx.pluginName);
    assert.equal(manifest.version, `0.1.${revision - 1}`);
    const expectedSkill = await fs.readFile(ctx.publicSkillFile);
    assert.deepEqual(await fs.readFile(path.join(ctx.grokPublicSource, 'skills', ctx.skillName, 'SKILL.md')), expectedSkill);
    assert.deepEqual(await fs.readFile(installedSkill), expectedSkill, 'Grok must load the current Skill body bytes.');
    ctx.grokInstalledPackage = installed;
  }
  return { level: 'fresh-process-skill-discovery', present, scope: 'user', plugins, skills };
}

async function readSkills(ctx, cwd, revision, present) {
  if (ctx.platform === 'grok') return readGrokSkills(ctx, cwd, revision, present);
  const result = await ctx.rpc(cwd);
  let skills;
  if (ctx.platform === 'codex') {
    const rows = result.data.filter((row) => path.resolve(row.cwd) === path.resolve(cwd));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].errors, []);
    skills = rows[0].skills.filter((skill) => skill.name === `${ctx.pluginName}:${ctx.skillName}`);
  } else {
    assert.equal(result.state.messageCount, 0);
    assert.equal(result.state.pendingMessageCount, 0);
    assert.equal(result.state.isStreaming, false);
    assert.equal(result.state.isCompacting, false);
    skills = result.commands.commands.filter((skill) => skill.name === `skill:${ctx.skillName}`);
  }
  assert.equal(skills.length, present ? 1 : 0, 'Public AW Skill discovery must match the requested scope and lifecycle.');
  if (present) {
    assert.equal(skills[0].description, `AW public acceptance revision ${revision}`);
    if (ctx.platform === 'codex') assert.equal(skills[0].enabled, true);
    else {
      assert.equal(skills[0].source, 'skill');
      assert.equal(skills[0].sourceInfo.scope, ctx.scope);
      assert.equal(skills[0].sourceInfo.origin, 'package');
    }
  }
  return { level: 'fresh-process-skill-discovery', present, skills };
}

export async function grokBootstrapSource(ctx, result, pluginId) {
  assert.equal(result.command, 'plugin.install');
  assert.equal(result.status, 'partial');
  assert.equal(result.data.changes.requirements, 'changed', 'The public install must save the User requirement.');
  assert.equal(result.data.requirements.state, 'valid');
  assert.deepEqual(result.data.requirements.roots, [pluginId]);
  assert.deepEqual(result.data.request.plugins, [pluginId]);
  assert.equal(result.data.request.scope, 'user');
  assert.deepEqual(result.data.request.targets, ['grok']);
  assert.equal(result.data.targetResults.length, 1);
  const target = result.data.targetResults[0];
  assert.equal(target.pluginId, pluginId);
  assert.equal(target.target, 'grok');
  assert.equal(target.scope, 'user');
  assert.deepEqual(target.blockerCodes, ['nativeTrustRequired']);
  assert(result.diagnostics.every((item) => ['nativeTrustRequired', 'grokNativeInstallRecovery'].includes(item.code)),
    'A partial with another failure must not grant host trust.');
  assert.equal(target.deploymentPlans.length, 1);
  assert.equal(target.deploymentReceipts.length, 1);
  const plan = target.deploymentPlans[0];
  const receipt = target.deploymentReceipts[0];
  assert.equal(plan.sharedReferences, 'none');
  assert.equal(plan.products.length, 1);
  assert.equal(plan.products[0].product, 'cli');
  assert.equal(plan.products[0].version, clients.grok.version);
  assert.deepEqual(plan.expected.components, [{ id: `skill:${ctx.skillName}`, kind: 'skill', name: ctx.skillName }]);
  assert.deepEqual(plan.expected.omitted, []);
  assert.deepEqual(plan.expected.unmet, []);
  assert.equal(receipt.bindingId, plan.bindingId);
  assert.equal(receipt.after.ownership, 'aw');
  assert.equal(receipt.after.package, 'present');
  assert.equal(receipt.after.registration, 'absent');
  assert.equal(receipt.after.nativeIdentity?.route, 'grok-cli');
  assert.equal(receipt.after.nativeIdentity.packageId, ctx.pluginName);
  const publishes = plan.effects.filter((effect) => effect.kind === 'publish-package');
  const registers = plan.effects.filter((effect) => effect.kind === 'register');
  const activates = plan.effects.filter((effect) => effect.kind === 'activate');
  assert.equal(publishes.length, 1);
  assert.equal(registers.length, 1);
  assert.equal(activates.length, 1);
  assert.equal(plan.effects.length, 3);
  const source = publishes[0].destination;
  assert.equal(typeof source, 'string');
  assert(path.isAbsolute(source));
  const actualSource = await fs.realpath(source);
  assert.equal(actualSource, path.resolve(source), 'The self-created source must not use a symlink.');
  const parts = path.relative(await fs.realpath(ctx.env.AW_HOME), actualSource).split(path.sep);
  assert.equal(parts.length, 6);
  assert.deepEqual([parts[0], parts[1], parts[3], parts[4], parts[5]],
    ['platforms', 'grok', 'packages', 'qualification', ctx.pluginName]);
  assert.match(parts[2], /^[a-f0-9]{64}$/u);
  assert.equal(registers[0].destination, source);
  assert.equal(receipt.after.nativeIdentity.sourceLocation, source);
  const effectResult = (effect) => {
    const matches = receipt.effects.filter((item) => item.id === effect.id);
    assert.equal(matches.length, 1);
    return matches[0];
  };
  assert.equal(receipt.effects.length, plan.effects.length);
  const published = effectResult(publishes[0]);
  assert.equal(published.status, 'applied');
  assert.equal(published.mutation, 'confirmed');
  assert.deepEqual(published.diagnostics, []);
  const blocked = effectResult(registers[0]);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.mutation, 'none');
  assert(blocked.diagnostics.some((item) => item.code === 'nativeTrustRequired'
    && item.subject?.pluginId === pluginId && item.subject.target === 'grok' && item.subject.scope === 'user'));
  assert(blocked.diagnostics.every((item) => ['nativeTrustRequired', 'grokNativeInstallRecovery'].includes(item.code)),
    'Only the known first-install trust boundary may be accepted as bootstrap.');
  const skipped = effectResult(activates[0]);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.mutation, 'none');
  assert(skipped.diagnostics.every((item) => item.code === 'deploymentDependencyFailed'));
  assert.deepEqual(receipt.diagnostics, []);
  const manifest = JSON.parse(await fs.readFile(path.join(actualSource, '.grok-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, ctx.pluginName);
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(await fs.readFile(path.join(actualSource, 'skills', ctx.skillName, 'SKILL.md')),
    await fs.readFile(ctx.publicSkillFile), 'The retained source must contain the complete fixture Skill bytes.');
  return actualSource;
}

async function grokStatusFiles(ctx) {
  const { SKILL_OWNER_MARKER } = await import('../../packages/cli/dist/src/utils/ownership.js');
  const files = ['plugin-intents.json', 'deployment-preferences.json'].map((file) => path.join(ctx.env.AW_HOME, file));
  files.push(path.join(ctx.env.GROK_HOME, 'config.toml'), path.join(ctx.grokPublicSource, SKILL_OWNER_MARKER));
  for (const directory of [ctx.grokPublicSource, ctx.grokInstalledPackage]) {
    files.push(path.join(directory, '.grok-plugin/plugin.json'), path.join(directory, 'skills', ctx.skillName, 'SKILL.md'));
  }
  return Promise.all(files.map(async (file) => [file, await fs.readFile(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  })]));
}

export async function qualifyPublicAw(ctx) {
  if (!['codex', 'pi', 'grok'].includes(ctx.platform)) await ctx.defer('public-aw-read-only-skill-observer-not-implemented');
  if (ctx.platform === 'grok' && ctx.scope !== 'user') await ctx.defer('public-aw-grok-project-skill-unverified');
  const expectedEntry = await preparePublicClientPath(ctx);
  ctx.publicClientEntry = expectedEntry;
  await ctx.check('public-target-discovery', async () => {
    const result = await ctx.aw(['target', 'set', ctx.platform]);
    const target = result.data.availability.find((item) => item.id === ctx.platform);
    assert.equal(target.availability, 'available');
    let found = false;
    for (const product of target.installations) {
      if (product.product === 'cli' && product.version === clients[ctx.platform].version && product.entry?.kind === 'cli'
        && await fs.realpath(product.entry.executable) === expectedEntry) found = true;
    }
    assert(found, 'Public AW must discover the acquired fixed-version client.');
    return { platform: ctx.platform, version: clients[ctx.platform].version, availability: target.availability };
  });
  // Production qualification remains authoritative. Never inject a candidate
  // profile or use --force to turn a missing capability into public success.
  const { getQualifiedPlatformProfile } = await import('../../packages/cli/dist/src/platforms/capabilities.js');
  const profile = getQualifiedPlatformProfile(ctx.platform);
  if (profile.kinds.skill.status !== 'supported'
    || !profile.qualifiedConsumers?.skill?.some((consumer) => consumer.product === 'cli' && consumer.version === clients[ctx.platform].version)) {
    await ctx.defer('public-aw-production-skill-profile-unverified');
  }
  const workspace = path.join(ctx.root, 'workspace');
  await fs.mkdir(workspace);
  const plugin = path.join(workspace, 'plugins', ctx.pluginName);
  const manifestPath = path.join(plugin, '.agents-plugin', 'plugin.json');
  const skillPath = path.join(plugin, 'skills', ctx.skillName);
  if (ctx.platform === 'grok') ctx.publicSkillFile = path.join(skillPath, 'SKILL.md');
  const writeRevision = async (revision) => {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.platforms = [ctx.platform]; manifest.skills = './skills'; manifest.version = `0.1.${revision - 1}`;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: ${ctx.skillName}\ndescription: AW public acceptance revision ${revision}\n---\nThis is an installation fixture. No model request is required.\n${ctx.platform === 'grok' ? `Fixture body revision ${revision}.\n` : ''}`);
    await fs.writeFile(path.join(skillPath, 'README.md'), '# Public acceptance fixture\n\nTests installation and discovery without a model request.\n');
  };
  await ctx.check('public-authoring-and-source', async () => {
    await ctx.aw(['dev', 'catalog', 'create', '--workspace-root', workspace, '--owner-url', 'https://example.com/qualification'], workspace);
    await ctx.aw(['dev', 'plugin', 'create', ctx.pluginName, '--description', 'Public Native acceptance fixture.', '--no-skills', '--workspace-root', workspace], workspace);
    await writeRevision(1);
    await ctx.aw(['dev', 'catalog', 'build', '--workspace-root', workspace], workspace);
    await ctx.aw(['source', 'add', 'qualification', '--path', path.join(workspace, '.aw/catalog'), '--no-auto-check', '--primary', '--yes']);
    return { source: 'qualification', plugin: ctx.pluginName, version: '0.1.0' };
  });
  if (ctx.scope === 'project') await ctx.check('explicit-host-project-trust', async () => {
    // Host trust is an explicit isolated fixture, separate from AW --yes.
    if (ctx.platform === 'codex') await fs.writeFile(path.join(ctx.env.CODEX_HOME, 'config.toml'),
      `[projects.${JSON.stringify(ctx.project)}]\ntrust_level = "trusted"\n`);
    else await fs.writeFile(path.join(ctx.env.PI_CODING_AGENT_DIR, 'trust.json'),
      JSON.stringify({ [ctx.project]: true, [ctx.neutral]: true }) + '\n');
    const cwdObservation = ctx.platform === 'pi' && process.platform === 'win32'
      && process.env.GITHUB_ACTIONS === 'true' && process.env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE === '1'
      ? await observeNativeWorkingDirectory(ctx) : undefined;
    return { level: 'fixture-config', scope: 'project', trusted: true, ...(cwdObservation ? { cwdObservation } : {}) };
  });
  const pluginId = `qualification/${ctx.pluginName}`;
  if (ctx.platform === 'grok') {
    await ctx.check('public-install-host-trust-boundary', async () => {
      const result = await ctx.aw(['plugin', 'install', pluginId, '--scope', 'user', '--target', 'grok', '--yes'],
        ctx.project, { expectedExitCode: 4, expectedStatus: 'partial' });
      ctx.grokPublicSource = await grokBootstrapSource(ctx, result, pluginId);
      return { command: result.command, status: result.status, requirements: result.data.requirements,
        source: ctx.grokPublicSource, sourceRetained: true, nativeTrustRequired: true };
    });
    await ctx.check('explicit-host-user-plugin-trust', async () => {
      // This grants host trust only to the source just published for this fixture.
      const native = await ctx.command(['plugin', 'install', ctx.grokPublicSource, '--trust']);
      assert(!native.cancelled && native.terminationReason === 'complete', 'The explicit Grok trust install must complete normally.');
      return { scope: 'user', source: ctx.grokPublicSource, trust: 'explicit-native-install-trust' };
    });
  }
  await ctx.check('public-install', async () => {
    const result = ctx.platform === 'grok'
      ? await ctx.aw(['plugin', 'sync', pluginId, '--context', 'user', '--target', 'grok', '--yes'])
      : await ctx.aw(['plugin', 'install', pluginId, '--scope', ctx.scope, '--target', ctx.platform, '--yes']);
    return { command: result.command, status: result.status };
  });
  await ctx.check('public-install-skill-discovery', () => readSkills(ctx, ctx.project, 1, true));
  await ctx.check('public-install-neutral-scope', () => readSkills(ctx, ctx.neutral, 1, ctx.scope === 'user'));
  await ctx.check('public-update', async () => {
    await writeRevision(2);
    await ctx.aw(['dev', 'catalog', 'version', '--bump', 'patch', '--workspace-root', workspace], workspace);
    await ctx.aw(['dev', 'catalog', 'build', '--workspace-root', workspace, '--force', '--yes'], workspace);
    await ctx.aw(['source', 'sync', 'qualification', '--yes']);
    const result = await ctx.aw(['plugin', 'sync', pluginId, '--target', ctx.platform, '--yes']);
    return { command: result.command, status: result.status };
  });
  await ctx.check('public-update-skill-discovery', () => readSkills(ctx, ctx.project, 2, true));
  await ctx.check('public-update-neutral-scope', () => readSkills(ctx, ctx.neutral, 2, ctx.scope === 'user'));
  await ctx.check('public-status', async () => {
    const observeNative = ctx.platform === 'codex' && ctx.scope === 'project';
    const before = ctx.platform === 'grok' ? await grokStatusFiles(ctx) : undefined;
    const result = await ctx.aw(['plugin', 'status', pluginId, '--context', ctx.scope,
      ...(observeNative ? ['--observe-native'] : [])]);
    if (observeNative) assert(result.diagnostics.some(item => item.code === 'nativeObservationSideEffects'
      && item.severity === 'warning'), 'Explicit native observation must disclose client startup side effects.');
    if (ctx.platform === 'grok') {
      assert.equal(result.data.allSatisfied, true);
      assert.equal(result.data.inSync, true);
      assert.deepEqual(result.data.counts, { blocked: 0, unconfirmed: 0, pending: 0, ready: 1 });
      const inventory = result.data.inventory.filter((item) => item.pluginId === pluginId);
      assert.equal(inventory.length, 1);
      assert.equal(inventory[0].targetResults.length, 1);
      const target = inventory[0].targetResults[0];
      assert.equal(target.target, 'grok');
      assert.equal(target.scope, 'user');
      assert.equal(target.content, 'satisfied');
      assert.equal(target.observation, 'verified');
      assert.deepEqual(target.blockerCodes, []);
      assert.equal(target.deploymentObservations.length, 1);
      const observed = target.deploymentObservations[0].after;
      assert.equal(observed.package, 'present');
      assert.equal(observed.registration, 'present');
      assert.equal(observed.ownership, 'aw');
      assert.equal(observed.nativeIdentity?.route, 'grok-cli');
      assert.equal(observed.nativeIdentity.sourceLocation, ctx.grokPublicSource);
      assert.deepEqual(observed.components, [{ id: `skill:${ctx.skillName}`, presence: 'present', reasonCodes: [] }]);
      assert.deepEqual(await grokStatusFiles(ctx), before, 'Public status must retain configuration and package bytes.');
    }
    return { command: result.command, status: result.status, data: result.data,
      ...(observeNative ? { observation: 'explicit-native-startup', credentials: 'isolated-none', modelRequests: 'none' } : {}) };
  });
  await ctx.check('public-remove', async () => {
    const result = await ctx.aw(['plugin', 'remove', pluginId, '--scope', ctx.scope, '--yes']);
    if (ctx.platform === 'grok') await assert.rejects(fs.stat(ctx.grokPublicSource), { code: 'ENOENT' });
    return { command: result.command, status: result.status };
  });
  await ctx.check('public-remove-skill-discovery', async () => {
    await readSkills(ctx, ctx.project, 2, false);
    return readSkills(ctx, ctx.neutral, 2, false);
  });
}
