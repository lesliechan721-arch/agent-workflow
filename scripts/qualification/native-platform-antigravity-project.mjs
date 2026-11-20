// Fresh AW home, two Git projects, and a checked local AW build.
// Optional session queries read only the existing Antigravity login.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { antigravitySkillQuery, parseAntigravitySkillInventory } from './native-platform-antigravity-management.mjs';
import { addOfficialCatalog, gitPluginId, ordinaryGitSkills, qualifyShippedGitInstall } from './native-platform-shipped-git.mjs';
import { preparePublicClientPath } from './native-platform-public-aw.mjs';
import { executePublicAw } from './native-platform-public-process.mjs';
import { candidateFiles, execute, prepareEnvironment, repoRoot, sha256 } from './native-platform-runtime.mjs';

const version = '1.5.13';
const awEntry = path.join(repoRoot, 'packages/cli/dist/index.js');
const nativeManifest = '.antigravity-plugin/plugin.json';
const source = 'project-proof';
const rootName = 'scope-root';
const dependencyA = 'scope-dependency-a';
const dependencyB = 'scope-dependency-b';
const orderedSkills = {
  [rootName]: ['scope-manual', 'scope-ordinary', 'scope-extra'],
  [dependencyA]: ['dependency-a-first', 'dependency-a-second'],
  [dependencyB]: ['dependency-b-first', 'dependency-b-second'],
};
const names = Object.keys(orderedSkills);
const projectGit = name => `aw-qualification-official-git-toolkit:${name}`;
const direct = 'aw-scope-proof-direct';
const projectKey = name => `aw-${source}-${name}`;
const noticeCode = 'skillInvocationPolicyNotGuaranteed';
const skillFile = (folder, name) => path.join(folder, 'skills', name, 'SKILL.md');
const skillText = (name, revision) => [
  '---', `name: ${name}`, 'description: Local installation verification fixture.',
  ...(name === 'scope-manual' ? ['disable-model-invocation: true'] : []),
  ...(name === 'scope-hidden' ? ['user-invocable: false'] : []),
  '---', `Local fixture, revision ${revision}. No action is required.`, '',
].join('\n');
const resourceText = (name, revision) => `Fixture resource for ${name}, revision ${revision}.\n`;
const skillsFor = (name, revision) => revision === 1 || name !== rootName ? orderedSkills[name]
  : ['scope-manual', 'scope-updated', 'scope-hidden'];

async function writePlugin(workspace, name, revision) {
  const plugin = path.join(workspace, 'plugins', name);
  const file = path.join(plugin, '.agents-plugin', 'plugin.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.platforms = ['antigravity'];
  manifest.skills = './skills';
  manifest.version = `1.0.${revision}`;
  if (name === rootName) manifest.dependencies = [dependencyA, dependencyB];
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.rm(path.join(plugin, 'skills'), { recursive: true, force: true });
  for (const skill of skillsFor(name, revision)) {
    await fs.mkdir(path.dirname(skillFile(plugin, skill)), { recursive: true });
    await fs.writeFile(skillFile(plugin, skill), skillText(skill, revision));
    await fs.writeFile(path.join(path.dirname(skillFile(plugin, skill)), 'README.md'), resourceText(skill, revision));
  }
}

async function projectBytes(cwd, revision) {
  const records = [];
  for (const name of names) {
    const folder = path.join(cwd, '.agents', 'plugins', projectKey(name));
    const manifest = JSON.parse(await fs.readFile(path.join(folder, nativeManifest), 'utf8'));
    assert.equal(manifest.version, `1.0.${revision}`);
    assert.equal(manifest.name, name);
    const marker = JSON.parse(await fs.readFile(path.join(folder, '.agent-workflows-owner.json'), 'utf8'));
    assert.equal(marker.scope, 'project');
    assert.equal(marker.pluginId, `${source}/${name}`);
    assert.deepEqual((await fs.readdir(path.join(folder, 'skills'))).sort(), [...skillsFor(name, revision)].sort());
    for (const skill of skillsFor(name, revision)) {
      const body = await fs.readFile(skillFile(folder, skill), 'utf8');
      const resource = await fs.readFile(path.join(path.dirname(skillFile(folder, skill)), 'README.md'), 'utf8');
      assert.equal(body.split('\n---\n')[1], skillText(skill, revision).split('\n---\n')[1]);
      assert.equal(resource, resourceText(skill, revision));
      records.push({ plugin: name, skill, bodySha256: sha256(body), resourceSha256: sha256(resource) });
    }
  }
  return records;
}

function requireNotice(result, expected) {
  const notices = (result.diagnostics ?? []).filter(item => item.code === noticeCode);
  assert.deepEqual(notices.map(({ subject, detail }) => ({ subject, detail })), expected);
}

async function runQualification(executable, authenticatedSkills, report) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-antigravity-project-')));
  try {
    const env = await prepareEnvironment(root);
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    const workspace = path.join(root, 'workspace');
    const cli = { executable, prefix: [] };
    await preparePublicClientPath({ root, env, project: a, platform: 'antigravity', launcher: cli });
    const sessionEnv = { ...env, HOME: os.homedir(), USERPROFILE: os.homedir() };
    // agy can refresh its existing login before returning the local inventory.
    // Only this read-only session uses the caller's normal proxy settings.
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
      if (process.env[name]) sessionEnv[name] = process.env[name];
      else delete sessionEnv[name];
    }
    const run = async (launcher, args, cwd, env, label) => {
      const isAw = launcher.prefix[0] === awEntry;
      const invoke = isAw ? executePublicAw : execute;
      const result = await invoke(launcher, args, { cwd, env, stdin: '', timeoutMs: isAw ? 180_000 : 60_000 })
        .catch((error) => { throw new Error(`${label}-process-${error.result?.terminationReason ?? 'unconfirmed'}`); });
      if (result.timedOut || result.cancelled || result.maxBufferExceeded || result.terminationReason !== 'complete'
        || !isAw && (result.containmentMode !== 'verified-observed' || result.gradingEvidenceAccepted !== true)) {
        throw new Error(`${label}-process-${result.terminationReason ?? 'unconfirmed'}`);
      }
      if (result.exitCode !== 0) {
        let codes = [];
        if (isAw) {
          try { codes = JSON.parse(result.stdout).diagnostics.map(({ code }) => code); } catch { /* output is unavailable */ }
        }
        throw new Error(`${label}-exit-${result.exitCode}${codes.length ? '-' + codes.join('/') : ''}`);
      }
      return result.stdout;
    };
    const aw = async (args, cwd = a) => {
      const result = JSON.parse(await run({ executable: process.execPath, prefix: [awEntry] }, [...args, '--json'], cwd, env,
        'aw-' + args.slice(0, args[0] === 'dev' ? 3 : 2).join('-')));
      assert.equal(result.status, 'success');
      return result;
    };
    const native = (args, cwd, activeEnv = env) => run(cli, args, cwd, activeEnv, 'antigravity-' + (args[0] === '-p' ? 'skills' : args[0]));
    for (const directory of [a, b, workspace]) await fs.mkdir(directory);
    for (const cwd of [a, b]) await run({ executable: '/usr/bin/git', prefix: [] }, ['init', '-q'], cwd, env, 'git-init');
    report.client = (await native(['--version'], a)).trim();
    assert.equal(report.client, version);
    const discovery = await aw(['target', 'set', 'antigravity']);
    const products = discovery.data.availability.find(({ id }) => id === 'antigravity').installations;
    const userCli = products.find(({ product, version: found, availability }) => product === 'cli' && found === version && availability === 'available');
    assert.equal(await fs.realpath(userCli?.entry?.executable ?? ''), await fs.realpath(executable));
    report.app = products.some(({ product, availability }) => product === 'app' && availability !== 'missing') ? 'unobserved' : 'absent';
    report.coReading = 'unobserved';

    await addOfficialCatalog({ root, aw });
    const context = { root, env, platform: 'antigravity', aw, project: a };
    report.userDelivery = await qualifyShippedGitInstall({ ...context, scope: 'user' });
    const userDirectory = path.join(env.HOME, '.gemini', 'config', 'plugins', 'git-toolkit');
    const userBytes = () => Promise.all([nativeManifest, '.agent-workflows-owner.json',
      ...['git-commit', ...ordinaryGitSkills].flatMap(name => [`skills/${name}/SKILL.md`, `skills/${name}/README.md`])]
      .map(file => fs.readFile(path.join(userDirectory, file))));
    const userBefore = await userBytes();
    const userManifest = JSON.parse(userBefore[0]);
    assert.equal(userManifest.name, 'git-toolkit');
    const inventory = async cwd => JSON.parse(await native(['plugin', 'list', '--json'], cwd));
    const userRegistration = async cwd => {
      const inventoryRows = await inventory(cwd);
      const rows = inventoryRows.filter(row => row.name === 'git-toolkit');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].enabled, true);
      assert.equal(rows[0].path, userDirectory);
      assert.equal(rows[0].version, userManifest.version);
      assert.equal(inventoryRows.filter(row => names.includes(row.name)).length, 0);
    };
    await userRegistration(a);
    await userRegistration(b);
    report.projectGitDelivery = await qualifyShippedGitInstall({ ...context, scope: 'project' });
    const projectContext = ['--scope', 'project', '--target', 'antigravity', '--yes'];
    const directFile = path.join(a, '.agents', 'skills', direct, 'SKILL.md');
    const foreign = path.join(a, '.agents', 'plugins', 'foreign', 'keep.txt');
    await fs.mkdir(path.dirname(directFile), { recursive: true });
    await fs.writeFile(directFile, skillText(direct, 1));
    await fs.mkdir(path.dirname(foreign), { recursive: true });
    await fs.writeFile(foreign, 'Retain unrelated project files.\n');

    const approved = [direct, ...['git-commit', ...ordinaryGitSkills].map(projectGit),
      ...names.flatMap(name => [1, 2].flatMap(revision => skillsFor(name, revision).map(skill => `${projectKey(name)}:${skill}`)))];
    const samples = {};
    report.sessions = { status: 'unverified', user: 'unobserved', project: 'unobserved',
      ...(authenticatedSkills ? { samples } : { reason: 'authentication-session-probe-not-requested' }) };
    const query = async (stage, cwd) => {
      if (!authenticatedSkills) return;
      try {
        const stdout = await native(antigravitySkillQuery, cwd, sessionEnv);
        samples[stage] = parseAntigravitySkillInventory({ status: 'observed', exitCode: 0, stdout }, approved, cwd);
      } catch (error) {
        const wrongLocation = error?.message === 'skill-inventory-location-mismatch';
        samples[stage] = wrongLocation ? { status: 'mismatch', reason: 'skill-inventory-location-mismatch' }
          : { status: 'unverified', reason: 'session-inventory-unconfirmed' };
      }
    };
    await query('git-project-a', a);
    await query('git-project-b', b);

    await aw(['dev', 'catalog', 'create', '--workspace-root', workspace, '--owner-url', 'https://example.com/qualification'], workspace);
    for (const name of names) {
      await aw(['dev', 'plugin', 'create', name, '--description', 'Local installation verification fixture.', '--no-skills', '--workspace-root', workspace], workspace);
      await writePlugin(workspace, name, 1);
    }
    await aw(['dev', 'catalog', 'build', '--workspace-root', workspace], workspace);
    await aw(['source', 'add', source, '--path', path.join(workspace, '.aw', 'catalog'), '--no-auto-check', '--primary', '--yes']);
    await aw(['source', 'sync', source, '--yes']);
    const id = `${source}/${rootName}`;
    const syncProject = ['plugin', 'sync', id, '--context', 'project', '--target', 'antigravity', '--yes'];
    await aw(['plugin', 'install', id, '--scope', 'project', '--only', 'requirements', '--yes']);
    requireNotice(await aw(syncProject), []);
    report.firstPublication = await projectBytes(a, 1);
    assert.equal(report.firstPublication.length, 7);
    for (const name of names) await assert.rejects(fs.stat(path.join(b, '.agents', 'plugins', projectKey(name))), { code: 'ENOENT' });
    await query('first-project-a', a);
    await query('first-project-b', b);
    requireNotice(await aw(['plugin', 'install', id, ...projectContext], b), []);
    const bBytes = await projectBytes(b, 1);
    assert.deepEqual(bBytes, report.firstPublication);

    for (const name of names) await writePlugin(workspace, name, 2);
    await aw(['dev', 'catalog', 'build', '--workspace-root', workspace, '--force', '--yes'], workspace);
    await aw(['source', 'sync', source, '--yes']);
    const update = await aw(syncProject);
    const expected = process.platform === 'darwin' && process.arch === 'arm64' ? [{
      subject: { pluginId: id, target: 'antigravity', scope: 'project', field: 'skill.scope-hidden' },
      detail: { reasonCode: 'invocationControlUnsupported', skillInvocationControls: [
        { feature: 'skill.visibility', values: ['hidden'], reasonCode: 'invocationControlUnsupported', product: 'cli' },
      ] },
    }] : [];
    requireNotice(update, expected);
    report.updatedPublication = await projectBytes(a, 2);
    report.updateNotices = expected.map(({ detail }) => detail);
    assert.deepEqual(await projectBytes(b, 1), bBytes);
    await userRegistration(a);
    await userRegistration(b);
    await query('updated-project-a', a);
    await query('updated-project-b', b);

    requireNotice(await aw(['plugin', 'remove', id, gitPluginId, '--scope', 'project', '--yes']), []);
    for (const key of [...names.map(projectKey), 'aw-qualification-official-git-toolkit']) {
      await assert.rejects(fs.stat(path.join(a, '.agents', 'plugins', key)), { code: 'ENOENT' });
    }
    assert.deepEqual(await projectBytes(b, 1), bBytes);
    await userRegistration(a);
    await userRegistration(b);
    assert.deepEqual(await userBytes(), userBefore);
    assert.equal(await fs.readFile(foreign, 'utf8'), 'Retain unrelated project files.\n');
    assert.equal(await fs.readFile(directFile, 'utf8'), skillText(direct, 1));
    report.mixedCleanup = 'project-a-owned-project-b-user-and-foreign-retained';
    await query('removed-project-a', a);
    await query('removed-project-b', b);
    if (Object.values(samples).some(sample => sample.status === 'mismatch')) throw new Error('skill-inventory-location-mismatch');
    if (authenticatedSkills && Object.values(samples).every(sample => sample.status === 'SUCCESS')) {
      const projectNames = revision => names.flatMap(name => skillsFor(name, revision).map(skill => `${projectKey(name)}:${skill}`));
      const present = (stage, expected, withGit = true) => {
        const fixtures = [...expected, ...(withGit ? ['git-commit', ...ordinaryGitSkills].map(projectGit) : [])];
        const rows = samples[stage].skills;
        assert.deepEqual(rows.map(({ name }) => name).sort(), fixtures.sort());
        for (const row of rows) assert.equal(row.model_invocable, !['scope-manual', 'git-commit'].includes(row.name.split(':').at(-1)));
      };
      present('git-project-a', [direct]);
      present('git-project-b', [], false);
      present('first-project-a', [direct, ...projectNames(1)]);
      present('first-project-b', [], false);
      present('updated-project-a', [direct, ...projectNames(2)]);
      present('updated-project-b', projectNames(1), false);
      present('removed-project-a', [direct], false);
      present('removed-project-b', projectNames(1), false);
      report.sessions.project = 'observed';
      report.sessions.status = 'observed';
      report.sessions.explicitInvocation = 'unverified';
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: { executable: { type: 'string' }, report: { type: 'string' },
    'authenticated-skills': { type: 'boolean', default: false } } });
  assert(values.executable && path.isAbsolute(values.executable) && values.report,
    'Usage: --executable <absolute agy path> --report <file> [--authenticated-skills]');
  const files = await candidateFiles();
  const report = { schemaVersion: 1, date: new Date().toISOString(), host: `${process.platform}-${process.arch}`,
    baseSourceSha: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    candidateSha256: sha256(JSON.stringify(files)), fixture: 'repository git-toolkit plus a local root and two dependencies with seven Skills',
    clientSha256: sha256(await fs.readFile(values.executable)) };
  try {
    await runQualification(values.executable, values['authenticated-skills'], report);
    report.status = report.sessions.status === 'observed' ? 'passed' : 'unverified';
  } catch (error) {
    report.status = 'failed';
    report.reason = error.code === 'ERR_ASSERTION' ? `fixture-assertion-failed:${error.stack.split('\n').find(line => line.includes('native-platform-antigravity-project.mjs'))?.match(/:(\d+):\d+\)?$/u)?.[1] ?? 'unknown'}`
      : /^[a-z0-9/-]+$/iu.test(error.message) ? error.message : error.code ?? 'qualification-failed';
  }
  await fs.writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
