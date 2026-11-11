import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { clients, sha256 } from './native-platform-runtime.mjs';

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

async function readSkills(ctx, cwd, revision, present) {
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

export async function qualifyPublicAw(ctx) {
  if (!['codex', 'pi'].includes(ctx.platform)) await ctx.defer('public-aw-read-only-skill-observer-not-implemented');
  const expectedEntry = await preparePublicClientPath(ctx);
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
  const writeRevision = async (revision) => {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.platforms = [ctx.platform]; manifest.skills = './skills'; manifest.version = `0.1.${revision - 1}`;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: ${ctx.skillName}\ndescription: AW public acceptance revision ${revision}\n---\nThis is an installation fixture. No model request is required.\n`);
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
    return { level: 'fixture-config', scope: 'project', trusted: true };
  });
  const pluginId = `qualification/${ctx.pluginName}`;
  await ctx.check('public-install', async () => {
    const result = await ctx.aw(['plugin', 'install', pluginId, '--scope', ctx.scope, '--target', ctx.platform, '--yes']);
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
    const result = await ctx.aw(['plugin', 'status', pluginId, '--context', ctx.scope]);
    return { command: result.command, status: result.status, data: result.data };
  });
  await ctx.check('public-remove', async () => {
    const result = await ctx.aw(['plugin', 'remove', pluginId, '--scope', ctx.scope, '--yes']);
    return { command: result.command, status: result.status };
  });
  await ctx.check('public-remove-skill-discovery', async () => {
    await readSkills(ctx, ctx.project, 2, false);
    return readSkills(ctx, ctx.neutral, 2, false);
  });
}
