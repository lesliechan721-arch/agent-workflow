import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, sha256 } from './native-platform-runtime.mjs';
import { nativePath, readInstalled, targetOf, nativePackage, checkSettled, runGrokCommand, grokUserRegistration } from './native-platform-public-state.mjs';
import { addOfficialCatalog, officialSource } from './native-platform-shipped-git.mjs';

const manifestFile = '.agents-plugin/plugin.json';
const roleSkills = { 'agent-subagent': { subagent: 'spawn-subagent/assets/task-instructions.md' },
  'codex-enhance': { 'codex-explore': 'codex-explore/assets/explore-instructions.md',
    'codex-advisor': 'codex-advisor/assets/advisor-instructions.md' } };
export const shippedRoles = Object.fromEntries(Object.entries(roleSkills).map(([plugin, roles]) => [plugin, Object.keys(roles).sort()]));
export const rolePlatform = platform => !['generic', 'opencode'].includes(platform);

async function readGrokPersonalCopies(ctx, providers) {
  const workspace = await fs.realpath(path.join(ctx.env.AW_HOME, 'runtime', 'user'));
  const rows = JSON.parse(await runGrokCommand(ctx.env, workspace, ['plugin', 'list', '--json']));
  const installedRoot = await fs.realpath(path.join(ctx.env.GROK_HOME, 'installed-plugins'));
  const copies = [];
  for (const { id, source, skills, files } of providers) {
    const registration = grokUserRegistration(rows, ctx.env, id.split('/')[1], source);
    const directory = await fs.realpath(registration.path);
    assert.equal(path.relative(installedRoot, directory), registration.key);
    const actual = await Promise.all(skills.map(name => readInstalled(ctx, nativePath(ctx, { id }, 'skill', directory, name), name)));
    assert.deepEqual(actual.map(file => file.sha256), files.map(file => file.sha256));
    copies.push({ pluginId: id, key: registration.key, files: actual });
  }
  return copies;
}

// Install across scopes before any explicit Project request for either dependency.
// A green receipt alone cannot detect a second native package shadowing User.
export async function qualifyProjectDependencies(ctx, report) {
  const catalog = await addOfficialCatalog(ctx);
  const names = ['agent-content-toolkit', 'agent-skill-toolkit', 'aw-development-toolkit'];
  const ids = names.map(name => `${officialSource}/${name}`);
  const [content, skills, root] = ids;
  const manifest = JSON.parse(await fs.readFile(path.join(catalog, 'catalog-manifest.json'), 'utf8'));
  for (const entry of manifest.entries) ctx.dependencies.set(`${officialSource}/${entry.name}`,
    entry.dependencies.map(name => name.includes('/') ? name : `${officialSource}/${name}`));
  assert.deepEqual(ctx.dependencies.get(skills), [content]);
  assert.deepEqual([...ctx.dependencies.get(root)].sort(), [content, skills]);

  const install = (id, scope) => ctx.aw(['plugin', 'install', id, '--scope', scope, '--context', scope, '--target', ctx.platform, '--yes']);
  const user = { ...ctx, scope: 'user' };
  const personal = await install(skills, 'user');
  const providers = [];
  for (const [id, expected] of [[content, ['agent-content']], [skills,
    ['audit-agent-skill-evals', 'author-agent-skill', 'review-agent-skill', 'simplify-agent-skill']]]) {
    const target = targetOf(personal, user, id);
    const directory = ctx.platform === 'antigravity' ? path.join(ctx.env.HOME, '.gemini/config/plugins', id.split('/')[1]) : nativePackage(target);
    const files = await Promise.all(expected.map(name => readInstalled(ctx, nativePath(user, { id }, 'skill', directory, name), name)));
    providers.push({ id, source: directory, skills: expected, files });
  }
  const personalFiles = providers.flatMap(provider => provider.files);
  const grokPersonal = ctx.platform === 'grok' ? await readGrokPersonalCopies(user, providers) : undefined;
  const project = await install(root, 'project');
  const rootTarget = targetOf(project, ctx, root);
  assert.equal(rootTarget.execution, 'applied');
  const providerRows = project.data.targetResults.filter(row => [content, skills].includes(row.pluginId));
  for (const row of providerRows) assert.equal(row.providerScope, 'user', `${row.pluginId}: redundant Project dependency`);
  const expectedNames = ['develop-aw', 'publish-aw-catalog'];
  if (ctx.platform === 'antigravity') assert.equal(nativePackage(rootTarget), path.join(ctx.project, '.agents/plugins/aw-development-toolkit'));
  const rootFiles = [];
  for (const name of expectedNames) rootFiles.push(await readInstalled(ctx,
    nativePath(ctx, { id: root }, 'skill', nativePackage(rootTarget), name), name));
  const namespace = { antigravity: '.agents', generic: '.agents', cursor: '.cursor', pi: '.pi', grok: '.grok',
    opencode: '.opencode', codex: '.codex', claude: '.claude', copilot: '.github' }[ctx.platform];
  const publicRoot = path.join(ctx.project, namespace);
  const files = await fs.readdir(publicRoot, { recursive: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const projectFiles = files.filter(file => path.basename(file) === 'SKILL.md').map(file => path.join(namespace, file)).sort();
  const shared = ['codex', 'claude', 'copilot'].includes(ctx.platform);
  const expectedProjectFiles = shared ? [] : rootFiles.map(file => path.relative(ctx.project, path.resolve(ctx.root, file.path))).sort();
  assert.deepEqual(projectFiles, expectedProjectFiles, 'The project should contain only the requested plugin’s skill files.');

  const status = await ctx.aw(['plugin', 'status', '--context', 'project']);
  checkSettled(status);
  assert.equal(targetOf(status, ctx, root).content, 'satisfied');
  const sync = await ctx.aw(['plugin', 'sync', root, '--context', 'project', '--target', ctx.platform, '--yes']);
  assert.deepEqual(sync.data.remainingTargets, []);
  assert.equal(targetOf(sync, ctx, root).execution, 'no-op');
  assert(sync.data.targetResults.every(row => row.execution === 'no-op'), 'A second sync must leave the installation in place.');
  for (const file of personalFiles) assert.equal(sha256(await fs.readFile(path.join(ctx.root, file.path))), file.sha256);
  report.inheritance = { userRoot: skills, projectRoot: root, personalFiles, projectFiles, rootFiles,
    providers: providerRows.map(({ pluginId, providerScope }) => ({ pluginId, providerScope })),
    inSync: status.data.inSync, sync: sync.data.targetResults.map(({ pluginId, execution }) => ({ pluginId, execution })) };
  if (grokPersonal) {
    // A Project publication hides the matching User source. Retirement reveals it again.
    const explicit = await ctx.aw(['plugin', 'install', content, skills, '--scope', 'project', '--context', 'project', '--target', 'grok', '--yes']);
    const copies = [];
    for (const { id, skills: names, files } of providers) {
      const target = targetOf(explicit, ctx, id);
      assert.equal(target.execution, 'applied');
      const directory = nativePackage(target);
      assert.equal(path.dirname(directory), path.join(publicRoot, 'plugins'));
      const installed = await Promise.all(names.map(name => readInstalled(ctx, nativePath(ctx, { id }, 'skill', directory, name), name)));
      assert.deepEqual(installed.map(file => file.sha256), files.map(file => file.sha256));
      copies.push({ directory, files: installed });
    }
    assert.deepEqual(await readGrokPersonalCopies(user, providers), grokPersonal);
    await ctx.aw(['plugin', 'remove', content, skills, '--only', 'requirements', '--scope', 'project', '--context', 'project', '--yes']);
    for (const file of copies.flatMap(copy => copy.files)) assert.equal(sha256(await fs.readFile(path.join(ctx.root, file.path))), file.sha256);
    const pending = await ctx.aw(['plugin', 'status', root, '--context', 'project']);
    assert.deepEqual(pending.diagnostics.filter(item => item.code === 'projectSkillDuplicatePending').map(item => item.subject.pluginId).sort(), [content, skills].sort());
    const cleaned = await ctx.aw(['plugin', 'sync', '--context', 'project', '--target', 'grok', '--yes']);
    assert.deepEqual(cleaned.data.remainingTargets, []);
    for (const copy of copies) await assert.rejects(fs.stat(copy.directory), { code: 'ENOENT' });
    for (const file of [...personalFiles, ...rootFiles]) assert.equal(sha256(await fs.readFile(path.join(ctx.root, file.path))), file.sha256);
    assert.deepEqual(await readGrokPersonalCopies(user, providers), grokPersonal);
    checkSettled(await ctx.aw(['plugin', 'status', '--context', 'project']));
    report.inheritance.grokUserCopies = grokPersonal;
    report.inheritance.explicitProjectBatch = copies.flatMap(copy => copy.files);
    report.inheritance.retiredProjectDependencies = [content, skills];
  }
}

export async function qualifyCatalog(ctx, report, catalog, frozen) {
  const snapshot = await fs.readFile(path.join(catalog, 'catalog-manifest.json'));
  const metadata = JSON.parse(snapshot);
  const label = frozen ? 'frozen' : 'candidate';
  if (frozen) assert.equal(sha256(snapshot), '95b7be92ed40dc2068227c29459963bcb0170446e10646bc650d08a45c9e6b1f',
    'Frozen expectations refer to published catalog beta.76 at 2d866d18.');
  const local = path.join(ctx.root, label);
  await fs.cp(catalog, local, { recursive: true, filter: file => path.relative(catalog, file) !== '.git' });
  const marker = path.join(local, '.aw-generated.json');
  try {
    await fs.access(marker);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    assert(!frozen, 'A frozen release must carry its original catalog identity');
    const identity = 'sha256:' + sha256('native-component-qualification');
    await fs.writeFile(marker, JSON.stringify({ schemaVersion: 1, kind: 'catalog', workspaceIdentity: identity, sourceIdentity: identity }));
  }
  const catalogId = 'qualification-official';
  for (const entry of metadata.entries) ctx.dependencies.set(catalogId + '/' + entry.name,
    entry.dependencies.map(name => name.includes('/') ? name : catalogId + '/' + name));
  await ctx.aw(['source', 'add', catalogId, '--path', local, '--primary', '--no-auto-check', '--yes']);
  await ctx.aw(['source', 'sync', catalogId, '--yes']);
  const active = JSON.parse(await fs.readFile(path.join(ctx.env.AW_HOME, 'catalog-state.json'), 'utf8')).sources[catalogId].active;
  report.catalog = { kind: label, version: metadata.catalogVersion, manifestSha256: sha256(snapshot), active,
    config: 'isolated defaults', plugins: Object.fromEntries(Object.keys(roleSkills).map(name => {
      const plugin = metadata.entries.find(entry => entry.name === name);
      return [name, { version: plugin.version, artifactDigest: plugin.artifactDigest }];
    })) };
  const roots = Object.keys(roleSkills);
  const ids = roots.map(plugin => catalogId + '/' + plugin);
  const request = ['plugin', 'install', ...ids, '--scope', ctx.scope, '--target', ctx.platform, '--yes'];
  const installation = await ctx.result(request);
  report.install = { exitCode: installation.exitCode, status: installation.value.status,
    targets: installation.value.data.targetResults?.map(target => ({ pluginId: target.pluginId, execution: target.execution,
      blockerCodes: target.blockerCodes, gaps: target.componentGaps, plans: (target.deploymentPlans ?? []).map(plan => ({
        expected: plan.expected, actual: target.deploymentReceipts?.find(r => r.bindingId === plan.bindingId)?.after.components })) })) };
  const observation = await ctx.result(['plugin', 'status', '--context', ctx.scope]);
  if (!frozen || ctx.platform === 'codex') {
    assert.equal(installation.exitCode, 0, JSON.stringify(installation.value.diagnostics));
    assert.equal(observation.exitCode, 0, JSON.stringify(observation.value.diagnostics));
    checkSettled(observation.value);
  } else {
    assert.equal(metadata.release.state, 'published');
    assert.equal(installation.exitCode, 4, 'The frozen scheduling Skill reports a genuine unmet dependency.');
    assert.equal(installation.value.status, 'partial');
    assert(installation.value.diagnostics.some(item => item.code === 'platformComponentsUnmet' && item.severity === 'error'));
    assert(installation.value.data.remainingTargets.length > 0);
  }
  report.readOnlyStatus = { exitCode: observation.exitCode, status: observation.value.status, counts: observation.value.data.counts,
    inSync: observation.value.data.inSync, allSatisfied: observation.value.data.allSatisfied };
  const status = observation.value;
  for (const [plugin, roles] of Object.entries(roleSkills)) {
    const entry = metadata.entries.find(entry => entry.name === plugin);
    const id = catalogId + '/' + plugin;
    const target = targetOf(status, ctx, id, frozen);
    const installedTarget = targetOf(installation.value, ctx, id, frozen);
    const gaps = installedTarget.componentGaps ?? [];
    if (frozen && ctx.platform !== 'codex' && (plugin === 'codex-enhance' || ctx.platform !== 'claude')) {
      const missingSkills = gaps.filter(gap => gap.providerPluginId === id && gap.kind === 'skill');
      const names = plugin === 'agent-subagent' ? ['spawn-subagent'] : shippedRoles[plugin];
      assert.deepEqual(missingSkills.map(gap => gap.name).sort(), names);
      assert(missingSkills.every(gap => gap.reasonCode === 'dependency-unmet' && !gap.requiredFeatures.length));
    }
    const roleGaps = gaps.filter(gap => gap.providerPluginId === id && gap.kind === 'agent');
    const expectRoles = rolePlatform(ctx.platform) && (!frozen || ctx.platform === 'codex');
    const packageRoot = nativePackage(target);
    const installed = [];
    for (const [name, sourcePath] of Object.entries(roles)) {
      const gap = roleGaps.find(row => row.name === name);
      if (expectRoles) {
        assert(!gap, id + '/' + name + ' cannot be counted solely as a gap');
        const prompt = await fs.readFile(path.join(catalog, entry.source, 'skills', sourcePath), 'utf8');
        const file = nativePath(ctx, { id }, 'agent', packageRoot, name);
        // A TOML string escapes newlines. The authored first line identifies the
        // role while the stored digest identifies the complete installed bytes.
        installed.push({ name, ...await readInstalled(ctx, file, prompt.trim().split(/\r?\n/u)[0]) });
      } else {
        assert(gap?.reasonCode && gap.requiredFeatures.length, id + '/' + name + ' must retain its skipped reason');
        assert(!(installedTarget.installedComponentIds ?? []).includes(gap.id));
        if (ctx.platform === 'pi') {
          const dir = ctx.scope === 'project' ? path.join(ctx.project, '.pi') : ctx.env.PI_CODING_AGENT_DIR;
          const file = path.join(dir, 'aw-packages', 'aw-' + catalogId + '-' + plugin, 'agents', 'aw-' + catalogId + '-' + plugin + '-' + name + '.md');
          await assert.rejects(fs.stat(file), { code: 'ENOENT' });
        }
      }
    }
    report.catalog.plugins[plugin] = { version: entry.version, artifactDigest: entry.artifactDigest, installed,
      gaps: gaps.filter(gap => gap.providerPluginId === id).map(({ id, kind, name, reasonCode }) => ({ id, kind, name, reasonCode })) };
  }
  if (frozen && ctx.platform === 'pi') {
    const catalogCandidate = path.join(repoRoot, 'packages/cli/plugins-dist');
    const retained = path.join(ctx.root, 'old-publication');
    const requirements = installation.value.data.requirements.roots;
    assert.deepEqual([...requirements].sort(), [...ids].sort());
    await fs.rename(local, retained);
    await fs.cp(catalogCandidate, local, { recursive: true });
    // Keep this private path source and its on-disk identity fixed across the
    // change, so the original requirements are the inputs to an ordinary sync.
    await fs.copyFile(path.join(retained, '.aw-generated.json'), marker);
    await ctx.aw(['source', 'sync', catalogId, '--yes']);
    const refresh = await ctx.aw(['plugin', 'sync', ...ids, '--context', ctx.scope, '--target', 'pi', '--yes']);
    assert.deepEqual(refresh.data.remainingTargets, []);
    const current = await ctx.aw(['plugin', 'status', '--context', ctx.scope]);
    checkSettled(current);
    const candidateManifest = JSON.parse(await fs.readFile(path.join(local, 'catalog-manifest.json'), 'utf8'));
    const currentActive = JSON.parse(await fs.readFile(path.join(ctx.env.AW_HOME, 'catalog-state.json'), 'utf8')).sources[catalogId].active;
    assert.notEqual(currentActive.snapshotDigest, active.snapshotDigest);
    report.upgrade = { command: refresh.command, status: refresh.status, active: currentActive, plugins: {} };
    for (const [plugin, roles] of Object.entries(roleSkills)) {
      const entry = candidateManifest.entries.find(entry => entry.name === plugin);
      assert.notEqual(entry.artifactDigest, report.catalog.plugins[plugin].artifactDigest);
      const id = catalogId + '/' + plugin;
      const target = targetOf(current, ctx, id);
      const directory = nativePackage(target);
      const installed = [];
      for (const [name, sourcePath] of Object.entries(roles)) {
        const prompt = await fs.readFile(path.join(local, entry.source, 'skills', sourcePath), 'utf8');
        const file = nativePath(ctx, { id }, 'agent', directory, name);
        installed.push({ name, ...await readInstalled(ctx, file, prompt.trim().split(/\r?\n/u)[0]) });
      }
      report.upgrade.plugins[plugin] = { version: entry.version, artifactDigest: entry.artifactDigest, installed };
    }
  }
  if (!frozen) {
    const failures = [];
    for (const entry of metadata.entries.filter(entry => !Object.hasOwn(roleSkills, entry.name))) {
      const id = catalogId + '/' + entry.name;
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(catalog, entry.source, manifestFile), 'utf8'));
        const skillsPath = path.join(catalog, entry.source, ctx.platform, manifest.skills);
        const install = await ctx.aw(['plugin', 'install', id, '--scope', ctx.scope, '--target', ctx.platform, '--yes']);
        const receipt = targetOf(install, ctx, id);
        const verified = [];
        for (const dir of await fs.readdir(skillsPath, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const sourceFile = path.join(skillsPath, dir.name, 'SKILL.md');
          let skill;
          try { skill = await fs.readFile(sourceFile, 'utf8'); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          assert(!(receipt.componentGaps ?? []).some(gap => gap.providerPluginId === id && gap.kind === 'skill' && gap.name === dir.name));
          // Platform projections can translate frontmatter and command bindings.
          // Read back an authored body line at the actual native publication path.
          const body = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]+)$/u.exec(skill)?.[1];
          const authored = body?.split(/\r?\n/u).find(line => line.trim() && !line.includes('aw.command:') && !line.includes('{{'));
          assert(authored, id + '/' + dir.name + ' must have an authored body');
          const file = nativePath(ctx, { id }, 'skill', nativePackage(receipt), dir.name);
          verified.push({ name: dir.name, ...await readInstalled(ctx, file, authored) });
        }
        assert(verified.length > 0);
        report.catalog.plugins[entry.name] = { version: entry.version, artifactDigest: entry.artifactDigest, skills: verified };
      } catch (error) {
        failures.push(entry.name);
        const reason = error.message.replaceAll(ctx.root, '<isolated>').replaceAll(repoRoot, '<repo>');
        report.catalog.plugins[entry.name] = { version: entry.version, artifactDigest: entry.artifactDigest, error: reason };
      }
    }
    assert.equal(Object.keys(report.catalog.plugins).length, metadata.entries.length);
    assert.deepEqual(failures, [], 'Shipped plugin installation failed: ' + failures.join(', '));
    checkSettled(await ctx.aw(['plugin', 'status', '--context', ctx.scope]));
  }
}
