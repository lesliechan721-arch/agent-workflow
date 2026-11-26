import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { clients, sha256, fixedClientVersion, repoRoot } from './native-platform-runtime.mjs';
import { readCopilotSkills } from './native-platform-copilot-skills.mjs';
import { assertPublicStatus, expectedOpenCodeObservation, publicFixtureVersion, readPublicNativeState, readPublicRemovedNativeScope, readDynamicConsumerContent, writeGrokFixtureFolderDecisions } from './native-platform-public-state.mjs';
import { preparePublicOpenCodeObservation, capturePublicOpenCodePublication, readPublicOpenCodeSkills } from './native-platform-opencode-public.mjs';
import { addOfficialCatalog, qualifyShippedGitInstall } from './native-platform-shipped-git.mjs';
import { runComponentQualification } from './native-platform-public-components.mjs';
import { qualifyPiAgentPermission, qualifyPublicPlatformCases } from './native-platform-public-cases.mjs';

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
export async function preparePublicClientEntry(ctx) {
  const directory = ctx.clientBin ?? path.join(ctx.root, 'client-bin');
  await fs.mkdir(directory, { recursive: true });
  assert(ctx.launcher.prefix.length <= 1, 'Public AW requires a direct client entry.');
  const entry = ctx.launcher.prefix[0] ?? ctx.launcher.executable;
  const windows = process.platform === 'win32';
  const npmEntry = ctx.launcher.prefix.length === 1;
  const destination = path.join(directory, `${ctx.platform === 'antigravity' ? 'agy' : ctx.platform}${windows ? npmEntry ? '.cmd' : '.exe' : ''}`);
  if (windows && npmEntry) {
    const { renderNpmCmdShim } = await import('../../packages/cli/dist/src/utils/windows-npm-shim.js');
    const relative = path.relative(await fs.realpath(directory), await fs.realpath(entry));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('client-entry-outside-acquired-prefix');
    }
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
  return { directory, entry: await fs.realpath(destination) };
}

export async function preparePublicClientPaths(contexts) {
  const { env, project } = contexts[0];
  const clients = [];
  for (const ctx of contexts) clients.push(await preparePublicClientEntry(ctx));
  const windows = process.platform === 'win32';
  const systemDirectories = windows ? [path.join(env.SystemRoot, 'System32')] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  if (windows) {
    const { resolveWindowsPathCommand } = await import('../../packages/cli/dist/src/utils/windows-npm-shim.js');
    const git = await resolveWindowsPathCommand('git', project, env);
    assert(git, 'Public authoring requires the runner Git executable.');
    systemDirectories.push(path.dirname(git));
  }
  env.PATH = [...new Set(clients.map(({ directory }) => directory)), path.dirname(process.execPath), ...systemDirectories].join(path.delimiter);
  return clients.map(({ entry }) => entry);
}

export async function preparePublicClientPath(ctx) {
  const [entry] = await preparePublicClientPaths([ctx]);
  return entry;
}

export async function assertPublicClientDiscovery(result, ctx, expectedEntry) {
  const target = result.data.availability.find((item) => item.id === ctx.platform);
  assert.equal(target?.availability, 'available', `Public AW must find ${ctx.platform}.`);
  let found = false;
  for (const product of target.installations) {
    if (product.product === 'cli' && product.version === fixedClientVersion(ctx.platform) && product.entry?.kind === 'cli'
      && await fs.realpath(product.entry.executable) === expectedEntry) found = true;
  }
  assert(found, `Public AW must discover the acquired fixed-version ${ctx.platform} client.`);
  return { platform: ctx.platform, version: fixedClientVersion(ctx.platform), availability: target.availability };
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
    assert.equal(plugin.scope, ctx.scope);
    assert.equal(plugin.enabled, true);
    const installedRoot = await fs.realpath(ctx.scope === 'user'
      ? path.join(ctx.env.GROK_HOME, 'installed-plugins') : path.join(ctx.project, '.grok', 'plugins'));
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
    if (ctx.scope === 'user') assert.deepEqual(manifestBytes, await fs.readFile(path.join(ctx.grokPublicSource, '.grok-plugin/plugin.json')));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.name, ctx.pluginName);
    assert.equal(manifest.version, publicFixtureVersion(revision));
    const expectedSkill = await fs.readFile(ctx.publicSkillFile);
    if (ctx.scope === 'user') assert.deepEqual(await fs.readFile(path.join(ctx.grokPublicSource, 'skills', ctx.skillName, 'SKILL.md')), expectedSkill);
    assert.deepEqual(await fs.readFile(installedSkill), expectedSkill, 'Grok must load the current Skill body bytes.');
    ctx.grokInstalledPackage = installed;
  }
  return { level: 'fresh-process-skill-discovery', present, scope: ctx.scope, plugins, skills };
}

export async function readSkills(ctx, cwd, revision, present, { requireAbsent = false } = {}) {
  if (ctx.platform === 'antigravity') await ctx.defer('antigravity-skill-loading-unverified; native-management-scope-and-consumer-content-checked-separately');
  if (ctx.platform === 'opencode') return readPublicOpenCodeSkills(ctx, cwd, revision, present);
  if (ctx.platform === 'claude') await ctx.defer('claude-skill-discovery-interface-unverified');
  if (ctx.platform === 'grok') return readGrokSkills(ctx, cwd, revision, present);
  if (ctx.platform === 'copilot') {
    const result = await readCopilotSkills(ctx, cwd, `AW public acceptance revision ${revision}`, present);
    if (requireAbsent) assert.equal(result.present, false, 'Public remove must leave no fixture Skill in Copilot discovery.');
    return { ...result, level: 'fresh-process-skill-discovery' };
  }
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

function grokUserWorkspace(ctx) {
  return path.join(ctx.env.AW_HOME, 'runtime', 'user');
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
  assert.equal(target.deploymentPlans.length, 1);
  assert.equal(target.deploymentReceipts.length, 1);
  const plan = target.deploymentPlans[0];
  const receipt = target.deploymentReceipts[0];
  assert.equal(plan.sharedReferences, 'none');
  assert.equal(plan.products.length, 1);
  assert.equal(plan.products[0].product, 'cli');
  assert.equal(plan.products[0].version, clients.grok.version);
  assert.equal(plan.products[0].entry?.configRoot, ctx.env.GROK_HOME);
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
  const locations = new Map([
    ['grokNativeInstallRecovery', { field: 'nativeSource', reasonCode: 'grokNativeInstallSource', path: source }],
    ['grokNativeInstallWorkspace', { field: 'workspace', reasonCode: 'grokNativeInstallWorkspace', path: grokUserWorkspace(ctx) }],
    ['grokNativeInstallConfigRoot', { field: 'nativeConfigRoot', reasonCode: 'grokNativeInstallConfigRoot', path: ctx.env.GROK_HOME }],
  ]);
  for (const diagnostics of [result.diagnostics, blocked.diagnostics]) {
    const seenLocations = new Set();
    for (const item of diagnostics) {
      if (item.code === 'nativeTrustRequired') {
        assert.equal(item.severity, 'error');
        continue;
      }
      const location = locations.get(item.code);
      assert(location && (item.severity === 'info' || item.severity === 'warning'),
        'A partial with another failure must not grant host trust.');
      assert.deepEqual(item.subject, { pluginId, target: 'grok', scope: 'user', field: location.field });
      assert.deepEqual(item.detail, { reasonCode: location.reasonCode, path: location.path });
      seenLocations.add(item.code);
    }
    assert.equal(seenLocations.size, locations.size, 'The trust recovery must identify the source, workspace and Grok configuration.');
  }
  const nativeArguments = JSON.stringify(['plugin', 'install', source, '--trust']);
  assert(result.nextActions.some(item => item.kind === 'manual' && item.message.includes(nativeArguments)
    && item.message.includes(`aw plugin sync ${pluginId} --context user --target grok`)),
  'Public install must give the exact source-scoped native consent and AW recovery steps.');
  const skipped = effectResult(activates[0]);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.mutation, 'none');
  assert(skipped.diagnostics.every((item) => item.code === 'deploymentDependencyFailed'));
  assert.deepEqual(receipt.diagnostics, []);
  const manifest = JSON.parse(await fs.readFile(path.join(actualSource, '.grok-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, ctx.pluginName);
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(await fs.readFile(path.join(actualSource, 'skills', ctx.skillName, 'SKILL.md')),
    ctx.publicConsumedSkill, 'The retained source must contain the complete expected Grok Skill bytes.');
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

// These products have a manual-policy contract to verify on each supported
// host. Reuse its real public installation and the fixed CLI acquired for this run.
function publicManualProbe(platform, scope) {
  if (scope !== 'user' && !(scope === 'project' && ['claude', 'pi', 'opencode'].includes(platform))) return null;
  if (platform === 'codex') return './native-platform-codex-behavior.mjs';
  if (platform === 'claude' || platform === 'antigravity') return './native-platform-claude-antigravity-manual.mjs';
  if (platform === 'pi' || platform === 'opencode') return './native-platform-pi-opencode-manual.mjs';
  if (platform === 'copilot' || platform === 'grok') return './native-platform-copilot-grok-manual.mjs';
  return null;
}

export async function writePublicFixtureRevision(ctx, plugin, revision, platforms = [ctx.platform]) {
  const manifestPath = path.join(plugin, '.agents-plugin', 'plugin.json');
  const skillPath = path.join(plugin, 'skills', ctx.skillName);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.platforms = platforms; manifest.skills = './skills'; manifest.version = publicFixtureVersion(revision);
    ctx.publicSkillFile = revision === 3 ? path.join(ctx.root, 'expected-dynamic-SKILL.md') : path.join(skillPath, 'SKILL.md');
    if (revision === 3) await fs.rm(path.join(plugin, 'skills'), { recursive: true, force: true });
    else await fs.mkdir(skillPath, { recursive: true });
    const projected = `---\nname: ${ctx.skillName}\ndescription: AW public acceptance revision ${revision}\n---\nThis is an installation fixture. No model request is required.\nFixture body revision ${revision}.\n`;
    const manual = platforms.length === 1 && publicManualProbe(ctx.platform, ctx.scope);
    const fields = 'user-invocable: true\ndisable-model-invocation: true';
    const withFields = value => projected.replace('\n---\n', `\n${value}\n---\n`);
    const body = manual ? withFields(fields) : projected;
    const consumed = !manual || ctx.platform === 'codex' ? projected
      : ctx.platform === 'opencode' ? withFields('metadata:\n  opencode/autoinvoke: "false"')
      : ['pi', 'antigravity'].includes(ctx.platform) ? withFields('disable-model-invocation: true') : body;
    ctx.publicConsumedSkill = Buffer.from(consumed);
    await fs.writeFile(ctx.publicSkillFile, body);
    if (revision !== 3) await fs.writeFile(path.join(skillPath, 'README.md'), '# Public acceptance fixture\n\nTests installation and discovery without a model request.\n');
    if (revision === 3) {
      // Keep the plugin version fixed while switching the same component to an
      // actual renderer. Only bytes at the client's consumption path prove refresh.
      delete manifest.skills;
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      const plan = { version: 3, components: [{ id: `skill:${ctx.skillName}`, kind: 'skill', name: ctx.skillName,
        content: { files: { 'SKILL.md': { text: body },
          'README.md': { text: '# Public acceptance fixture\n\nTests generated content without a model request.\n' } } } }], omitted: [], unmet: [] };
      await fs.mkdir(path.join(plugin, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(plugin, 'scripts', 'render.mjs'),
        `import fs from 'node:fs';\nconst context=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));\nconst plan=${JSON.stringify(plan)};\nif(!context.allowedOutputKinds.includes('skill'))plan.components=[];\nconsole.log(JSON.stringify(plan));\n`);
    }
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

export async function requireProductionSkillProfile(ctx) {
  const { getQualifiedPlatformProfile } = await import('../../packages/cli/dist/src/platforms/capabilities.js');
  const profile = getQualifiedPlatformProfile(ctx.platform);
  if (profile.kinds.skill.status !== 'supported') await ctx.defer('public-aw-production-skill-profile-unsupported');
}

async function observePublicComponentSuites(ctx, publicClientEntry) {
  const scopes = ctx.platform === 'antigravity' ? ['user', 'project'] : [ctx.scope];
  const failures = [];
  for (const scope of scopes) {
    const suites = ctx.platform === 'pi' ? ['pi-pair', 'matrix', 'candidate', 'frozen'] : ['matrix', 'candidate'];
    if (scope === 'project') suites.push('project-inheritance');
    if (ctx.platform === 'grok' && scope === 'project') suites.push('grok-hook-pair', 'grok-rule-pair', 'grok-user-hook-pair');
    for (const suite of suites) {
      try {
        await ctx.check('public-components-' + scope + '-' + suite, async () => {
          const hostedTrace = process.env.GITHUB_ACTIONS === 'true' && process.env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE === '1';
          let traceEntry;
          if (hostedTrace && process.platform === 'win32') {
            if (['copilot', 'antigravity', 'grok'].includes(ctx.platform)) traceEntry = ctx.launcher.prefix[0] ?? publicClientEntry;
            else if (ctx.platform === 'codex' && scope === 'project' && ['matrix', 'candidate'].includes(suite)) traceEntry = publicClientEntry;
          }
          if (hostedTrace && process.platform === 'darwin' && ctx.platform === 'claude' && scope === 'project' && suite === 'matrix') {
            traceEntry = publicClientEntry;
          }
          const result = await runComponentQualification({ platform: ctx.platform, scope, suite, clientPath: ctx.env.PATH,
            ...(traceEntry ? { traceEntry } : {}),
            ...(suite === 'frozen' ? { catalog: path.join(repoRoot, '.qualification-frozen') } : {}) });
          if (result.status !== 'passed') ctx.recordCommand({ componentQualification: result });
          assert.equal(result.status, 'passed', result.reason);
          return result;
        });
      } catch (error) { failures.push(scope + '/' + suite + ': ' + error.message); }
    }
  }
  return failures;
}

export async function qualifyPublicAw(ctx, { components = false } = {}) {
  if (!components) return qualifyPublicLifecycle(ctx);
  // Component delivery has its own file and receipt evidence. Collect it before
  // the runtime/session observer can defer an unsupported platform.
  const entry = await preparePublicClientPath(ctx);
  const failures = await observePublicComponentSuites(ctx, entry);
  try {
    await qualifyPublicLifecycle(ctx, entry);
  } catch (error) {
    if (!failures.length) throw error;
    failures.push('public lifecycle: ' + error.message);
  }
  assert.deepEqual(failures, []);
}

async function qualifyPublicLifecycle(ctx, preparedEntry) {
  if (!['codex', 'pi', 'grok', 'copilot', 'claude', 'opencode', 'antigravity'].includes(ctx.platform)) await ctx.defer('public-aw-native-management-observer-not-implemented');
  if (ctx.platform === 'antigravity') {
    if (ctx.scope !== 'user' || process.env.GITHUB_ACTIONS !== 'true') await ctx.defer('antigravity-public-aw-limited-to-hosted-user');
    // The Hosted User restriction is specific to this qualification scenario.
    // Check before even target preferences are written in the isolated AW home.
    await requireProductionSkillProfile(ctx);
  }
  const expectedEntry = preparedEntry ?? await preparePublicClientPath(ctx);
  ctx.publicClientEntry = expectedEntry;
  await ctx.check('public-target-discovery', async () => assertPublicClientDiscovery(
    await ctx.aw(['target', 'set', ctx.platform]), ctx, expectedEntry));
  // Production capability mappings remain authoritative. Never inject a candidate
  // profile or use --force to turn a missing capability into public success.
  if (ctx.platform !== 'antigravity') await requireProductionSkillProfile(ctx);
  if (ctx.platform === 'opencode') await ctx.check('public-opencode-observation-environment', () => preparePublicOpenCodeObservation(ctx));
  const workspace = path.join(ctx.root, 'workspace');
  await fs.mkdir(workspace);
  const plugin = path.join(workspace, 'plugins', ctx.pluginName);
  const writeRevision = revision => writePublicFixtureRevision(ctx, plugin, revision);
  await ctx.check('public-authoring-and-source', async () => {
    await ctx.aw(['dev', 'catalog', 'create', '--workspace-root', workspace, '--owner-url', 'https://example.com/qualification'], workspace);
    await ctx.aw(['dev', 'plugin', 'create', ctx.pluginName, '--description', 'Public Native acceptance fixture.', '--no-skills', '--workspace-root', workspace], workspace);
    await writeRevision(1);
    if (ctx.scope === 'user' && ['codex', 'claude'].includes(ctx.platform)) {
      const name = `${ctx.pluginName}-dependent`;
      const directory = path.join(workspace, 'plugins', name);
      await ctx.aw(['dev', 'plugin', 'create', name, '--description', 'Project dependency qualification fixture.', '--no-skills', '--workspace-root', workspace], workspace);
      await writePublicFixtureRevision({ ...ctx, scope: 'project', pluginName: name }, directory, 1);
      const file = path.join(directory, '.agents-plugin', 'plugin.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.dependencies = [ctx.pluginName];
      await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
    }
    if (ctx.platform === 'pi' && ctx.scope === 'project') {
      const name = `${ctx.pluginName}-agent`;
      const directory = path.join(workspace, 'plugins', name);
      await ctx.aw(['dev', 'plugin', 'create', name, '--description', 'Pi Agent permission qualification fixture.', '--no-skills', '--workspace-root', workspace], workspace);
      const file = path.join(directory, '.agents-plugin', 'plugin.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.platforms = ['pi'];
      manifest.extensions = { agents: [{ name: 'qualification', description: 'Pi Agent qualification fixture.',
        prompt: 'Return only a local fixture marker.' }] };
      await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
    }
    await ctx.aw(['dev', 'catalog', 'build', '--workspace-root', workspace], workspace);
    await ctx.aw(['source', 'add', 'qualification', '--path', path.join(workspace, '.aw/catalog'), '--no-auto-check', '--primary', '--yes']);
    return { source: 'qualification', plugin: ctx.pluginName, version: '0.1.0' };
  });
  if (ctx.scope === 'project') await ctx.check('explicit-host-project-trust', async () => {
    // Host trust is an explicit isolated fixture, separate from AW --yes.
    if (ctx.platform === 'codex') await fs.writeFile(path.join(ctx.env.CODEX_HOME, 'config.toml'),
      `[projects.${JSON.stringify(ctx.project)}]\ntrust_level = "trusted"\n`);
    else if (ctx.platform === 'pi') await fs.writeFile(path.join(ctx.env.PI_CODING_AGENT_DIR, 'trust.json'),
      JSON.stringify({ [ctx.project]: true, [ctx.neutral]: true }) + '\n');
    else if (ctx.platform === 'grok') {
      const canonical = await fs.realpath(ctx.project);
      await writeGrokFixtureFolderDecisions(ctx.env, [[canonical, true]]);
      return { level: 'fixture-config', interface: 'empirical-isolated-folder-trust-state',
        exactVersion: '1.0.77', project: 'exact-canonical-fixture-project', productionAutomaticTrust: false };
    }
    else if (ctx.platform === 'copilot') {
      // The same explicit Hosted fixture precondition as native management.
      // It also approves tools; this fixture sends no tool or model requests.
      assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Real Copilot qualification requires a credential-free Hosted environment.');
      ctx.env.COPILOT_ALLOW_ALL = 'true';
      return { level: 'fixture-environment', interface: 'COPILOT_ALLOW_ALL=true',
        directories: 'isolated project and neutral', sessionRequests: 'none' };
    }
    else if (ctx.platform === 'opencode') return { level: 'fixture-environment', scope: 'project', nativeTrustOverridesWritten: false,
      consumerState: 'required-fresh-Native-scope-query; no-trust-state-inferred-from-AW-yes' };
    const cwdObservation = ctx.platform === 'pi' && process.platform === 'win32'
      && process.env.GITHUB_ACTIONS === 'true' && process.env.AW_NATIVE_QUALIFICATION_MANAGED_TRACE === '1'
      ? await observeNativeWorkingDirectory(ctx) : undefined;
    return { level: 'fixture-config', scope: 'project', trusted: true, ...(cwdObservation ? { cwdObservation } : {}) };
  });
  const pluginId = `qualification/${ctx.pluginName}`;
  const ready = { content: 'satisfied', activation: ['pi', 'opencode'].includes(ctx.platform) ? 'unknown' : 'enabled' };
  const status = async ({ cwd = ctx.project, expected = ready, explicit = false, observeNative = false, diagnostic } = {}) => {
    const before = ctx.platform === 'grok' && ctx.grokInstalledPackage ? await grokStatusFiles(ctx) : undefined;
    const command = ['plugin', 'status', ...(explicit ? [pluginId] : []), '--context', ctx.scope,
      ...(observeNative ? ['--observe-native'] : [])];
    const options = expected.content === 'unknown' || expected.blockerCodes?.length ? { expectedExitCode: 3, expectedStatus: 'blocked' } : undefined;
    const result = await ctx.aw(command, cwd, options);
    const runtime = observeNative && ctx.platform === 'opencode' ? expectedOpenCodeObservation(result, ctx, pluginId) : undefined;
    const evidence = assertPublicStatus(result, ctx, pluginId, { ...expected, ...runtime });
    if (diagnostic) assert(result.diagnostics.some(item => item.code === diagnostic && item.severity === (expected.blockerCodes?.includes(diagnostic) ? 'error' : 'warning')
      && item.subject?.target === ctx.platform && item.subject.scope === ctx.scope), `Public status must report ${diagnostic} for this scope.`);
    assert.equal(result.diagnostics.some(item => item.code === 'nativeObservationSideEffects'), observeNative,
      'Only the selected native observation may warn that it starts a client service.');
    if (before) assert.deepEqual(await grokStatusFiles(ctx), before, 'Public status must retain configuration and package bytes.');
    return evidence;
  };
  const consumerContent = async (revision) => ({ target: await readDynamicConsumerContent(ctx, ctx.project, revision),
    ...(ctx.scope === 'user' ? { neutral: await readDynamicConsumerContent(ctx, ctx.neutral, revision) } : {}) });
  const publishRevision = async (revision) => {
    await writeRevision(revision);
    await ctx.aw(['dev', 'catalog', 'version', '--bump', 'patch', '--workspace-root', workspace], workspace);
    await ctx.aw(['dev', 'catalog', 'build', '--workspace-root', workspace, '--force', '--yes'], workspace);
    await ctx.aw(['source', 'sync', 'qualification', '--yes']);
  };
  const syncedRevision = async (revision) => {
    const result = await ctx.aw(['plugin', 'sync', pluginId, '--target', ctx.platform, '--yes']);
    let nativeRefresh;
    if (ctx.platform === 'grok' && ctx.scope === 'user') {
      const target = result.data.targetResults.find(item => item.pluginId === pluginId && item.target === 'grok' && item.scope === 'user');
      const plan = target.deploymentPlans[0];
      const receipt = target.deploymentReceipts[0];
      assert.equal(plan.sharedReferences, 'none');
      assert.equal(receipt.bindingId, plan.bindingId);
      const refresh = plan.effects.find(effect => effect.kind === 'refresh');
      const applied = receipt.effects.find(effect => effect.id === refresh?.id);
      assert.equal(applied?.status, 'applied');
      assert.equal(applied.mutation, 'confirmed');
      assert.equal(receipt.after.nativeIdentity.sourceLocation, ctx.grokPublicSource);
      nativeRefresh = { mutation: applied.mutation, source: receipt.after.nativeIdentity.sourceLocation, sharedReferences: plan.sharedReferences };
    }
    return { command: result.command, status: result.status, version: publicFixtureVersion(revision), revision,
      ...(nativeRefresh ? { nativeRefresh } : {}),
      ...(ctx.platform === 'opencode' ? { publication: await capturePublicOpenCodePublication(ctx, result, revision, publicFixtureVersion(revision)) } : {}) };
  };
  if (ctx.platform === 'grok' && ctx.scope === 'user') {
    await ctx.check('public-install-host-trust-boundary', async () => {
      const result = await ctx.aw(['plugin', 'install', pluginId, '--scope', 'user', '--target', 'grok', '--yes'],
        ctx.project, { expectedExitCode: 4, expectedStatus: 'partial' });
      ctx.grokPublicSource = await grokBootstrapSource(ctx, result, pluginId);
      return { command: result.command, status: result.status, requirements: result.data.requirements,
        source: ctx.grokPublicSource, sourceRetained: true, nativeTrustRequired: true };
    });
    await ctx.check('public-install-before-native-consent', async () => ({
      ...await status({ expected: { content: 'absent', registration: 'absent' } }),
      native: await readPublicNativeState(ctx, ctx.project, 1, { active: false, absent: true }),
    }));
    await ctx.check('explicit-host-user-plugin-trust', async () => {
      // This grants host trust only to the source just published for this fixture.
      const native = await ctx.command(['plugin', 'install', ctx.grokPublicSource, '--trust'], grokUserWorkspace(ctx));
      assert(!native.cancelled && native.terminationReason === 'complete', 'The explicit Grok trust install must complete normally.');
      return { scope: 'user', source: ctx.grokPublicSource, trust: 'explicit-native-install-trust' };
    });
  }
  await ctx.check('public-install', async () => {
    const result = ctx.platform === 'grok' && ctx.scope === 'user'
      ? await ctx.aw(['plugin', 'sync', pluginId, '--context', 'user', '--target', 'grok', '--yes'])
      : await ctx.aw(['plugin', 'install', pluginId, '--scope', ctx.scope, '--target', ctx.platform, '--yes']);
    return { command: result.command, status: result.status,
      ...(ctx.platform === 'opencode' ? { publication: await capturePublicOpenCodePublication(ctx, result, 1, publicFixtureVersion(1)) } : {}) };
  });
  const nativeScope = async (revision) => ({
    target: await readPublicNativeState(ctx, ctx.project, revision, { active: true }),
    neutral: await readPublicNativeState(ctx, ctx.neutral, revision, { active: ctx.scope === 'user' }),
  });
  await ctx.check('public-install-native-scope', () => nativeScope(1));
  await ctx.check('public-install-status', () => status(ctx.platform === 'opencode'
    ? { expected: { ...ready, load: 'unknown' }, diagnostic: 'opencodeNativeObservationRequired' } : {}));
  await ctx.check('public-install-consumer-content', () => consumerContent(1));
  if (ctx.scope === 'user') await ctx.check('public-install-neutral-status', () => status({ cwd: ctx.neutral }));
  await ctx.observe('public-install-skill-discovery', () => readSkills(ctx, ctx.project, 1, true));
  await ctx.observe('public-install-neutral-skill-observation', () => readSkills(ctx, ctx.neutral, 1, ctx.scope === 'user'));
  const manualProbe = publicManualProbe(ctx.platform, ctx.scope);
  if (manualProbe) {
    const probe = await import(manualProbe);
    if (ctx.platform === 'codex') await probe.qualifyPublicCodexManualSkill(ctx);
    else await ctx.check(`public-${ctx.platform}-manual-skill`, () => probe.readPublicManualSkill(ctx));
  }
  await qualifyPublicPlatformCases(ctx, { pluginId, ready, status });
  await ctx.check('public-update', async () => {
    await publishRevision(2);
    if (ctx.platform === 'grok' && ctx.scope === 'user') {
      const workspace = await fs.realpath(grokUserWorkspace(ctx));
      await writeGrokFixtureFolderDecisions(ctx.env, [[workspace, false], [ctx.project, true]]);
      const inspection = JSON.parse((await ctx.command(['inspect', '--json'], workspace)).stdout);
      assert.equal(path.relative(workspace, inspection.cwd), '');
      assert.equal(inspection.projectRoot, null);
      assert.equal(typeof inspection.projectTrusted, 'boolean');
      const inventory = async () => JSON.parse((await ctx.command(['plugin', 'list', '--json'], workspace)).stdout)
        .filter(row => row.name === ctx.pluginName);
      const registered = await inventory();
      assert.equal(registered.length, 1);
      assert.equal(path.relative(registered[0].path, ctx.grokInstalledPackage), '');
      const skill = path.join(ctx.grokInstalledPackage, 'skills', ctx.skillName, 'SKILL.md');
      const oldSkill = await fs.readFile(skill);
      const refused = await ctx.aw(['plugin', 'sync', pluginId, '--context', 'user', '--target', 'grok', '--yes'],
        ctx.project, { expectedExitCode: 4, expectedStatus: 'partial' });
      const target = refused.data.targetResults.find(row => row.pluginId === pluginId && row.target === 'grok' && row.scope === 'user');
      assert.deepEqual(target?.blockerCodes, ['nativeTrustRequired']);
      assert(refused.diagnostics.some(item => item.subject?.pluginId === pluginId && item.detail?.reasonCode === 'grokNativeRefreshWorkspaceTrust'));
      assert.deepEqual(await inventory(), registered);
      assert.deepEqual(await fs.readFile(skill), oldSkill);
      await writeGrokFixtureFolderDecisions(ctx.env, [[workspace, true], [ctx.project, false]]);
      return { ...await syncedRevision(2), explicitFolderRefusal: { runtimeProjectTrusted: inspection.projectTrusted,
        retainedRegistration: true, retainedSkillSha256: sha256(oldSkill) } };
    }
    return syncedRevision(2);
  });
  await ctx.check('public-update-native-scope', () => nativeScope(2));
  await ctx.check('public-status', () => status());
  await ctx.observe('public-update-skill-discovery', () => readSkills(ctx, ctx.project, 2, true));
  await ctx.observe('public-update-neutral-skill-observation', () => readSkills(ctx, ctx.neutral, 2, ctx.scope === 'user'));
  await ctx.check('public-same-version-status-needs-sync', async () => {
    await publishRevision(3);
    return status({ expected: { ...ready, content: 'drifted' }, diagnostic: 'platformInputDrift' });
  });
  await ctx.check('public-dynamic-same-version-update', async () => {
    return { ...await syncedRevision(3), samePluginVersion: true };
  });
  await ctx.check('public-dynamic-native-scope', () => nativeScope(3));
  await ctx.check('public-dynamic-consumer-content', () => consumerContent(3));
  await ctx.check('public-dynamic-status', () => status());
  await ctx.observe('public-dynamic-skill-observation', () => readSkills(ctx, ctx.project, 3, true));
  let removeResult;
  await ctx.check('public-remove', async () => {
    const result = await ctx.aw(['plugin', 'remove', pluginId, '--scope', ctx.scope, '--yes']);
    removeResult = result;
    if (ctx.platform === 'grok' && ctx.scope === 'user') await assert.rejects(fs.stat(ctx.grokPublicSource), { code: 'ENOENT' });
    return { command: result.command, status: result.status };
  });
  await ctx.check('public-remove-native-scope', () => readPublicRemovedNativeScope(ctx, 3, removeResult, pluginId));
  await ctx.observe('public-remove-skill-discovery', async () => {
    await readSkills(ctx, ctx.project, 3, false, { requireAbsent: true });
    return readSkills(ctx, ctx.neutral, 3, false, { requireAbsent: true });
  });
  if (ctx.platform === 'pi' && ctx.scope === 'project') await qualifyPiAgentPermission(ctx);
  // Grok User authorizes each source separately. Its existing single-package
  // trust probe already exercises the manual policy on that authorized source.
  if (ctx.scope === 'user' && ctx.platform !== 'grok') {
    await ctx.check('public-shipped-git-toolkit-install', async () => {
      await addOfficialCatalog(ctx);
      return qualifyShippedGitInstall(ctx);
    });
  }
  if (ctx.platform === 'codex' && ctx.scope === 'user') {
    const { qualifyPublicCodexBehavior } = await import('./native-platform-codex-behavior.mjs');
    await qualifyPublicCodexBehavior(ctx);
  }
}
