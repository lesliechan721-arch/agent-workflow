import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './native-platform-runtime.mjs';

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
  let matches;
  if (ctx.platform === 'gemini') {
    if (ctx.scope === 'project') throw new Error('gemini-project-scope-unverified');
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
    } else if (ctx.platform === 'copilot') {
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

export async function readDynamicConsumerContent(ctx, cwd, revision) {
  let filename;
  if (['codex', 'pi'].includes(ctx.platform)) {
    const skill = single(await rpcSkills(ctx, cwd), 'dynamic-consumer-path-unverified');
    if (ctx.platform === 'codex') {
      assert.equal(skill.enabled, true, 'dynamic-consumer-path-unverified');
      filename = skill.path;
    } else filename = skill.sourceInfo?.path;
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
