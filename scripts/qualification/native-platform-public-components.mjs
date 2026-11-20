// Public AW qualification with real client discovery in a private, credential-free home.
// Expected host paths and gaps are fixed here independently of discovery and planning.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { nativePath, readInstalled, targetOf, nativePackage, checkSettled } from './native-platform-public-state.mjs';
import { qualifyCatalog } from './native-platform-public-catalog.mjs';
import { executePublicAw } from './native-platform-public-process.mjs';
import { prepareEnvironment, repoRoot, sha256, execute, assertCommand, candidateFiles } from './native-platform-runtime.mjs';

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
  return { id, installed, skipped: gaps.map(({ id, reasonCode, requiredFeatures }) => ({ id, reasonCode, requiredFeatures })) };
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
  const fingerprints = () => Promise.all(paths.map(async file => {
    const stat = await fs.stat(file, { bigint: true });
    return { path: path.relative(ctx.root, file).split(path.sep).join('/'), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs),
      sha256: sha256(await fs.readFile(file)) };
  }));
  const before = await fingerprints();
  const observed = await status();
  checkSettled(observed);
  for (const spec of inputs) await verifyFixture(ctx, observed, spec, 1);
  const again = await sync();
  assert.deepEqual(again.data.remainingTargets, []);
  assert.equal(again.data.changes.outputs, 'none');
  for (const id of ids) assert.equal(targetOf(again, ctx, id).execution, 'no-op');
  assert.deepEqual(await fingerprints(), before, 'A satisfied Pi batch must preserve both packages and the scope settings.');
  Object.assign(report.pair, { registered, filesAfterSync: before, syncOutputs: again.data.changes.outputs });
}

async function matrix(ctx, report) {
  const { aw, platform, scope } = ctx;
  const workspace = path.join(ctx.root, 'workspace');
  await fs.mkdir(workspace);
  await aw(['dev', 'catalog', 'create', '--workspace-root', workspace, '--owner-url', 'https://example.com/qualification'], workspace);
  const inputs = report.suite === 'pi-pair' ? [
    specs.find(spec => spec.name === 'single-instruction'),
    { ...specs.find(spec => spec.name === 'single-agent'), dependencies: ['single-instruction'] },
  ] : platform === 'generic' ? specs : specs.filter(spec => spec.name !== 'without-skills');
  await aw(['dev', 'plugin', 'create', inputs[0].name, '--description', 'Local component qualification.', '--no-skills', '--workspace-root', workspace], workspace);
  const scaffold = JSON.parse(await fs.readFile(path.join(workspace, 'plugins', inputs[0].name, manifestFile), 'utf8'));
  for (const spec of inputs) await writeFixture(workspace, scaffold, spec, 1);
  const build = () => aw(['dev', 'catalog', 'build', '--force', '--yes', '--workspace-root', workspace], workspace);
  await build();
  await aw(['source', 'add', source, '--path', path.join(workspace, '.aw/catalog'), '--primary', '--no-auto-check', '--yes']);
  const ids = inputs.map(spec => source + '/' + spec.name);
  const install = ids => aw(['plugin', 'install', ...ids, '--scope', scope, '--context', scope, '--target', platform, '--yes']);
  const sync = () => aw(['plugin', 'sync', '--context', scope, '--yes']);
  const status = () => aw(['plugin', 'status', '--context', scope]);
  if (report.suite === 'pi-pair') return piPair(ctx, report, inputs, install, status, sync);
  if (report.suite === 'pi-seven') {
    // Replay the seven independent roots from the first failed Pi User batch.
    const installed = await install(ids);
    assert.deepEqual(installed.data.remainingTargets, []);
    assert.deepEqual(installed.data.requirements.roots.toSorted(), ids.toSorted());
    const observed = await status();
    checkSettled(observed);
    for (const spec of inputs) report.cases.push(await verifyFixture(ctx, observed, spec, 1));
    const unchanged = await sync();
    assert.deepEqual(unchanged.data.remainingTargets, []);
    assert.equal(unchanged.data.changes.outputs, 'none');
    report.batch = { roots: ids, installStatus: installed.status, syncOutputs: unchanged.data.changes.outputs };
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
  for (const spec of inputs) {
    const id = source + '/' + spec.name;
    const installed = await install([id]);
    assert.deepEqual(installed.data.remainingTargets, []);
    if (spec.name.startsWith('single-')) {
      const [kind] = spec.kinds;
      const row = report.cells.find(row => row.kind === kind);
      const outcome = await verifyFixture(ctx, installed, spec, 1);
      row.observed = outcome.installed.length ? 'installed' : 'skipped';
      row.evidence = outcome.installed[0] ?? outcome.skipped[0];
    }
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
  await writeFixture(workspace, scaffold, mixed, 2);
  await build();
  await aw(['source', 'sync', source, '--yes']);
  await sync();
  report.updated = await verifyFixture(ctx, await status(), mixed, 2);
  for (const id of ids) await aw(['plugin', 'remove', id, '--scope', scope, '--yes']);
  for (const entry of report.cases.flatMap(item => item.installed)) await assert.rejects(fs.stat(path.join(ctx.root, entry.path)), { code: 'ENOENT' });
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


export async function runComponentQualification({ platform, scope, clientPath, suite = 'matrix', catalog }) {
  assert(componentPlatforms.includes(platform) && ['user', 'project'].includes(scope));
  assert(['matrix', 'pi-pair', 'pi-seven', 'candidate', 'frozen'].includes(suite));
  if (suite.startsWith('pi-')) assert.equal(platform, 'pi');
  const artifactIdentity = async () => {
    const files = Object.entries(await candidateFiles()).filter(([name]) => name.startsWith('packages/'));
    return sha256(JSON.stringify(files));
  };
  const candidateSha256 = await artifactIdentity();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-components-')));
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
    assertCommand(await execute({ executable: 'git', prefix: [] }, ['init', '--quiet', '--template=', project], { cwd: root, env }));
    async function result(args, cwd = project) {
      const response = await executePublicAw({ executable: process.execPath, prefix: [cli] }, [...args, '--json'], { cwd, env, timeoutMs: 180000 });
      assert(!response.cancelled && !response.timedOut && response.terminationReason === 'complete', args.join(' '));
      const value = JSON.parse(response.stdout);
      assert.equal(value.schemaVersion, 2);
      if (platform === 'grok' && scope === 'user' && args[0] === 'plugin' && args[1] === 'install'
        && value.status === 'partial' && response.exitCode === 4) {
        const authorized = [];
        for (const target of value.data.targetResults) {
          if (!target.blockerCodes.length) continue;
          assert.deepEqual(target.blockerCodes, ['nativeTrustRequired']);
          const after = target.deploymentReceipts.find(item => item.after.ownership === 'aw' && item.after.registration === 'absent')?.after;
          assert.equal(after?.nativeIdentity.route, 'grok-cli');
          const location = await fs.realpath(after.nativeIdentity.sourceLocation);
          const [provider, name] = target.pluginId.split('/');
          const parts = path.relative(env.AW_HOME, location).split(path.sep);
          assert.deepEqual(parts.slice(0, 2), ['platforms', 'grok']);
          assert.match(parts[2], /^[a-f0-9]{64}$/u);
          assert.deepEqual(parts.slice(3), ['packages', provider, name]);
          assert.equal(JSON.parse(await fs.readFile(path.join(location, '.agent-workflows-owner.json'), 'utf8')).pluginId, target.pluginId);
          assert(value.diagnostics.some(diagnostic => diagnostic.code === 'grokNativeInstallRecovery'
            && diagnostic.subject?.pluginId === target.pluginId && diagnostic.detail.path === location));
          assertCommand(await execute({ executable: 'grok', prefix: [] }, ['plugin', 'install', location, '--trust'],
            { cwd: path.join(env.AW_HOME, 'runtime', 'user'), env }));
          authorized.push(target.pluginId);
        }
        assert(authorized.length);
        report.explicitFixtureTrust = [...(report.explicitFixtureTrust ?? []), ...authorized];
        return result(['plugin', 'sync', '--context', 'user', '--target', 'grok', '--yes'], cwd);
      }
      return { exitCode: response.exitCode, value, stderr: response.stderr };
    }
    async function aw(args, cwd) {
      const { exitCode, value, stderr } = await result(args, cwd);
      if (exitCode) report.failedCommand = { command: value.command, exitCode, status: value.status,
        remainingTargets: value.data.remainingTargets, targets: value.data.targetResults?.map(target => ({
          pluginId: target.pluginId, target: target.target, scope: target.scope, execution: target.execution, blockerCodes: target.blockerCodes,
          gaps: target.componentGaps, installed: target.installedComponentIds })) };
      assert.equal(exitCode, 0, args.join(' ') + ' ' + JSON.stringify({ diagnostics: value.diagnostics, stderr: stderr.slice(-2000) }));
      assert.equal(value.status, 'success', args.join(' '));
      return value;
    }
    if (platform === 'codex' && scope === 'project')
      await fs.writeFile(path.join(env.CODEX_HOME, 'config.toml'), '[projects.' + JSON.stringify(project) + ']\ntrust_level = "trusted"\n');
    if (platform === 'pi' && scope === 'project')
      await fs.writeFile(path.join(env.PI_CODING_AGENT_DIR, 'trust.json'), JSON.stringify({ [project]: true }));
    if (platform === 'grok' && scope === 'project')
      await fs.writeFile(path.join(env.GROK_HOME, 'trusted_folders.toml'), '[folders.' + JSON.stringify(project) + ']\ntrusted = true\ndecided_at = ' + Math.floor(Date.now() / 1000) + '\n');
    if (platform === 'copilot' && scope === 'project' && process.env.GITHUB_ACTIONS === 'true') {
      // Same temporary, offline management precondition as the public Copilot route.
      env.COPILOT_ALLOW_ALL = 'true';
      report.fixtureTrust = 'hosted COPILOT_ALLOW_ALL in the isolated environment';
    }
    const target = await aw(['target', 'set', platform]);
    report.products = target.data.availability.find(row => row.id === platform)?.installations.map(({ product, version, availability }) => ({ product, version, availability }));
    const ctx = { root, project, env, aw, result, scope, platform };
    if (suite === 'matrix' || suite.startsWith('pi-')) await matrix(ctx, report);
    else await qualifyCatalog(ctx, report, catalog ?? path.join(repoRoot, 'packages/cli/plugins-dist'), suite === 'frozen');
    assert.equal(await artifactIdentity(), candidateSha256, 'Candidate bytes changed during qualification');
    report.status = 'passed';
  } catch (error) {
    report.reason = (error.stack ?? error.message).replaceAll(root, '<isolated>').replaceAll(repoRoot, '<repo>').replaceAll(os.homedir(), '<home>');
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
