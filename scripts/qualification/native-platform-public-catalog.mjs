import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, sha256 } from './native-platform-runtime.mjs';
import { nativePath, readInstalled, targetOf, nativePackage, checkSettled } from './native-platform-public-state.mjs';

const manifestFile = '.agents-plugin/plugin.json';
const roleSkills = { 'agent-subagent': { subagent: 'spawn-subagent/assets/task-instructions.md' },
  'codex-enhance': { 'codex-explore': 'codex-explore/assets/explore-instructions.md',
    'codex-advisor': 'codex-advisor/assets/advisor-instructions.md' } };
export const shippedRoles = Object.fromEntries(Object.entries(roleSkills).map(([plugin, roles]) => [plugin, Object.keys(roles).sort()]));
export const rolePlatform = platform => !['generic', 'opencode'].includes(platform);

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
