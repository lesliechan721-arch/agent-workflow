#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bytesDigest, verifyCandidateDirectory } from './candidate-archive.mjs';
import { computePackageTarballTreeDigest } from './common.mjs';
import { validateLocalTarballBundle } from './install-local-tarball.mjs';
import { runWindowsJobQualification, WINDOWS_JOB_REQUIRED_CHECKS } from '../qualification/windows-job-containment.mjs';

const PACKAGE_NAMES = [
  '@lesliechan721/aw',
  '@lesliechan721/agent-skill-eval',
  '@lesliechan721/aw-plugin-core',
  '@lesliechan721/aw-windows-job-win32-x64',
  '@lesliechan721/aw-windows-job-win32-arm64',
];
const scriptPath = fileURLToPath(import.meta.url);

export function parseCandidateSmokeArgs(argv) {
  const options = {};
  const fields = { '--bundle-root': 'bundleRoot', '--product': 'product', '--os': 'os', '--arch': 'arch', '--candidate-digest': 'candidateDigest' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--minimum-node' && options.minimumNode === undefined) {
      options.minimumNode = true;
    } else if (fields[arg] && options[fields[arg]] === undefined && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      options[fields[arg]] = argv[++index];
    } else {
      throw new Error(`Invalid candidate smoke argument: ${arg}`);
    }
  }
  if (!options.bundleRoot || !['cli', 'catalog'].includes(options.product)
    || !['linux', 'darwin', 'win32'].includes(options.os) || !['x64', 'arm64'].includes(options.arch)
    || (options.candidateDigest !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(options.candidateDigest))) {
    throw new Error('Required: --bundle-root <dir> --product <cli|catalog> --os <linux|darwin|win32> --arch <x64|arm64> [--minimum-node] [--candidate-digest <sha256:...>]');
  }
  options.bundleRoot = path.resolve(options.bundleRoot);
  return options;
}

export function assertCandidateHost(options, actual = { os: process.platform, arch: process.arch, node: process.versions.node }) {
  if (options.os !== actual.os || options.arch !== actual.arch) throw new Error('Candidate smoke requires the selected native OS and CPU.');
  if (options.minimumNode ? actual.node !== '22.0.0' : actual.node.split('.')[0] !== '24') {
    throw new Error(options.minimumNode ? 'Minimum Node smoke requires exactly Node 22.0.0.' : 'Platform candidate smoke requires Node 24.');
  }
}

export function assertRequiredChecks(checks, required) {
  if (checks.some((check) => check.passed !== true || check.skipped)) {
    throw new Error('Required candidate checks did not pass.');
  }
  for (const id of required) {
    const matching = checks.filter((check) => check.id === id);
    if (matching.length !== 1 || matching[0].passed !== true || matching[0].skipped) {
      throw new Error(`Required candidate check did not pass: ${id}`);
    }
  }
}

async function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(command)} exited ${code}: ${stderr || stdout}`)));
  });
}

function packagePath(root, name) {
  return path.join(root, 'node_modules', ...name.split('/'));
}

async function npmEntry(env) {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  if (path.basename(env.npm_execpath ?? '') === 'npm-cli.js') candidates.push(env.npm_execpath);
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    candidates.push(path.join(directory, 'npm'), path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      if (resolved.endsWith(`${path.sep}npm-cli.js`)) return resolved;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error('The Node installation must provide npm-cli.js.');
}

export async function installCandidatePackages(bundleRoot, manifest, root, env, options = {}) {
  const entries = manifest.files.filter((entry) => entry.path.endsWith('.tgz'));
  if (entries.length !== 5) throw new Error('Candidate smoke requires exactly five tarballs.');
  const packages = new Map();
  for (const [index, entry] of entries.entries()) {
    const tarball = path.join(bundleRoot, entry.path);
    await computePackageTarballTreeDigest(tarball);
    const unpack = path.join(root, `unpack-${index}`);
    await fs.mkdir(unpack, { recursive: true });
    await capture('tar', ['-xzf', tarball, '-C', unpack], { env });
    const unpackedRoot = path.join(unpack, 'package');
    const metadata = JSON.parse(await fs.readFile(path.join(unpackedRoot, 'package.json'), 'utf8'));
    if (!PACKAGE_NAMES.includes(metadata.name) || packages.has(metadata.name)) throw new Error('Candidate tarballs must contain each of the five release packages once.');
    packages.set(metadata.name, { metadata, tarball, unpackedRoot });
  }
  const bundle = Object.fromEntries(['cliTarballPath', 'evalTarballPath', 'coreTarballPath', 'windowsX64TarballPath', 'windowsArm64TarballPath'].map((key, index) => [key, packages.get(PACKAGE_NAMES[index])?.tarball]));
  await validateLocalTarballBundle(bundle, { readPackageJson: async (tarball) => [...packages.values()].find((entry) => entry.tarball === tarball)?.metadata });
  if (manifest.product === 'cli' && packages.get(PACKAGE_NAMES[0]).metadata.version !== manifest.version) throw new Error('CLI candidate version differs from its tarballs.');

  // Install only third-party dependencies through npm. Candidate package names
  // never enter a registry request, including Eval's optional platform packages.
  const installDependencies = options.installDependencies ?? (async (directory) => {
    await capture(process.execPath, [await npmEntry(env), 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--omit=dev'], { cwd: directory, env });
  });
  for (const name of PACKAGE_NAMES) {
    const entry = packages.get(name);
    const destination = packagePath(root, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(entry.unpackedRoot, destination);
    const dependencies = Object.fromEntries(Object.entries(entry.metadata.dependencies ?? {}).filter(([dependency]) => !PACKAGE_NAMES.includes(dependency)));
    if (Object.keys(dependencies).length > 0) {
      const dependencyRoot = path.join(root, `dependencies-${PACKAGE_NAMES.indexOf(name)}`);
      await fs.mkdir(dependencyRoot);
      await fs.writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({ private: true, dependencies }));
      await installDependencies(dependencyRoot, dependencies);
      await fs.rename(path.join(dependencyRoot, 'node_modules'), path.join(destination, 'node_modules'));
    }
    assert.equal((await fs.lstat(destination)).isSymbolicLink(), false);
  }
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }));
  if ([...packages.values()].some((entry) => entry.metadata.bin)) {
    // Rebuild links installed bins and sets their executable mode. It does not
    // install or fetch packages; lifecycle scripts remain disabled.
    await capture(process.execPath, [await npmEntry(env), 'rebuild', '--ignore-scripts', ...PACKAGE_NAMES.slice(0, 2)], { cwd: root, env });
  }
  return { version: packages.get(PACKAGE_NAMES[0]).metadata.version };
}

async function candidateImport(root, name, relative = 'dist/index.js') {
  return import(pathToFileURL(path.join(packagePath(root, name), relative)).href);
}

function candidateCliImport(root, relative) {
  return candidateImport(root, PACKAGE_NAMES[0], `dist/src/${relative}.js`);
}

async function checkInstalledEntrypoints(root, env) {
  const cliRoot = packagePath(root, PACKAGE_NAMES[0]);
  const evalRoot = packagePath(root, PACKAGE_NAMES[1]);
  const cli = JSON.parse(await fs.readFile(path.join(cliRoot, 'package.json'), 'utf8'));
  const evaluator = JSON.parse(await fs.readFile(path.join(evalRoot, 'package.json'), 'utf8'));
  for (const [packageRoot, metadata, bin, argument] of [[cliRoot, cli, 'aw', '--version'], [evalRoot, evaluator, 'aw-skill-eval', '--help']]) {
    const entry = path.resolve(packageRoot, metadata.bin[bin]);
    assert.ok(entry.startsWith(`${packageRoot}${path.sep}`));
    const stats = await fs.lstat(entry);
    assert.ok(stats.isFile() && !stats.isSymbolicLink());
    if (process.platform !== 'win32') assert.ok(stats.mode & 0o111, `${bin} must be executable`);
    const shim = path.join(root, 'node_modules', '.bin', `${bin}${process.platform === 'win32' ? '.cmd' : ''}`);
    await fs.access(shim);
    const result = process.platform === 'win32'
      ? await capture('cmd.exe', ['/d', '/s', '/c', `""${shim}" ${argument}"`], { cwd: root, env, windowsVerbatimArguments: true })
      : await capture(shim, [argument], { cwd: root, env });
    if (bin === 'aw') assert.equal(result.stdout.trim(), cli.version);
    else assert.match(result.stdout, /Usage: aw-skill-eval/u);
  }
  const resolved = await capture(process.execPath, ['--input-type=module', '--eval', "const resolved = []; for (const name of process.argv.slice(1)) { await import(name); resolved.push(import.meta.resolve(name)); } console.log(JSON.stringify(resolved));", ...PACKAGE_NAMES.slice(1, 3)], { cwd: cliRoot, env });
  for (const [index, url] of JSON.parse(resolved.stdout).entries()) assert.ok(fileURLToPath(url).startsWith(`${packagePath(root, PACKAGE_NAMES[index + 1])}${path.sep}`));
}

async function checkInstalledImportsAndPaths(root, env) {
  const [core, manifest, evaluator, paths] = await Promise.all([
    candidateImport(root, PACKAGE_NAMES[2]), candidateImport(root, PACKAGE_NAMES[2], 'dist/manifest.js'),
    candidateImport(root, PACKAGE_NAMES[1]), candidateCliImport(root, 'utils/paths'),
  ]);
  assert.equal(typeof core.validateCatalogSnapshotComplete, 'function');
  assert.equal(typeof manifest.readPluginManifest, 'function');
  assert.equal(typeof evaluator.runProviderProcess, 'function');
  const config = manifest.normalizePluginConfigDefinition({ fields: { value: { type: 'string', validation: { pattern: '\\p{Han}+', maxLength: 20 } } } });
  assert.equal(manifest.validatePluginConfigValue(config.fields.value, '中文', 'value').length, 0);
  assert.equal(paths.resolveCliPackageRoot(), packagePath(root, PACKAGE_NAMES[0]));
  assert.equal(paths.resolveAwHome(env), env.AW_HOME);
  assert.equal(paths.resolveCodexPaths(root, 'user', env).configDir, env.AW_CODEX_HOME);
  assert.equal(paths.resolveClaudePaths(root, 'user', env).configDir, env.AW_CLAUDE_HOME);
}

async function checkHelpers(root) {
  for (const [index, arch, machine] of [[3, 'x64', 0x8664], [4, 'arm64', 0xaa64]]) {
    const packageRoot = packagePath(root, PACKAGE_NAMES[index]);
    const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.deepEqual(metadata.os, ['win32']);
    assert.deepEqual(metadata.cpu, [arch]);
    const bytes = await fs.readFile(path.join(packageRoot, 'dist', 'aw-windows-job.exe'));
    assert.equal(bytes.subarray(0, 2).toString('ascii'), 'MZ');
    const peOffset = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.subarray(peOffset, peOffset + 4).toString('ascii'), 'PE\0\0');
    assert.equal(bytes.readUInt16LE(peOffset + 4), machine);
  }
}

async function checkCatalog(root, bundleRoot, candidate, env, record) {
  const repository = path.join(bundleRoot, 'catalog', 'publication', 'repository');
  const snapshot = path.join(root, 'catalog-snapshot');
  // A published snapshot excludes Git storage. Preserve the saved repository
  // for Git consumption and use the identical worktree bytes for path sources.
  await fs.cp(repository, snapshot, { recursive: true, filter: (source) => source !== path.join(repository, '.git') });
  const [validation, providers, manifests, dependencies, materializer, native, marketplace] = await Promise.all([
    candidateCliImport(root, 'utils/catalog-snapshot'),
    Promise.all([candidateCliImport(root, 'utils/path-catalog-provider'), candidateCliImport(root, 'utils/git-catalog-provider')]),
    candidateCliImport(root, 'utils/manifest'), candidateCliImport(root, 'utils/plugin-dependencies'),
    candidateCliImport(root, 'commands/rebuild-integration'), candidateCliImport(root, 'utils/native-cli'),
    candidateCliImport(root, 'utils/local-marketplace'),
  ]);
  const validated = await validation.validateCatalogSnapshotComplete(snapshot);
  const layout = await candidateCliImport(root, 'utils/bundle-layout');
  await layout.validateBundleLayout(snapshot);
  assert.equal(validated.manifest.catalogVersion, candidate.version);
  assert.equal(validated.manifest.release.state, 'published');
  assert.equal(validated.manifest.release.sourceHead, candidate.candidateHead);
  assert.ok(validated.manifest.entries.length > 0, 'Candidate Catalog must contain plugins.');
  record('catalog-validate');
  const gitSnapshot = path.join(root, 'catalog.git');
  await capture('git', ['clone', '--bare', '--no-hardlinks', repository, gitSnapshot], { env });
  const head = (await capture('git', ['--git-dir', gitSnapshot, 'rev-parse', 'HEAD'], { env })).stdout.trim();
  let sourceIdentity;
  for (const [type, source, provider] of [
    ['path', { path: snapshot }, providers[0].catalogPathProviderInternal],
    ['git', { url: gitSnapshot, refPolicy: { type: 'explicit', ref: head } }, providers[1].catalogGitProviderInternal],
  ]) {
    const resolution = await provider.resolve({ id: `smoke-${type}`, type, primary: true, ...source }, { cliVersion: '99.0.0', freshnessPolicy: 'forceRemote', env });
    try {
      assert.equal(resolution.snapshotDigest, validated.snapshotDigest);
      assert.equal(resolution.manifestDigest, validated.manifestDigest);
      if (type === 'path') sourceIdentity = resolution.sourceIdentity;
    } finally { await resolution.cleanup(); }
    record(`catalog-${type}-consumption`);
  }
  const plugins = (await manifests.resolvePluginsFromCatalog(snapshot)).map((plugin) => ({
    ...plugin, sourceId: 'smoke-path', sourceIdentity, pluginId: `smoke-path/${plugin.manifest.name}`,
  }));
  dependencies.validatePluginMetaDependencyGraph(plugins);
  const ordered = dependencies.orderPluginMetasByDependencies(plugins);
  assert.equal(ordered.length, validated.manifest.entries.length);
  for (const plugin of plugins) {
    const closure = dependencies.resolvePluginMetaDependencyClosure(plugins, [plugin.manifest.name]);
    assert.ok(closure.some((entry) => entry.manifest.name === plugin.manifest.name));
  }
  record('catalog-dependencies');
  const { supportsPlatform } = await candidateCliImport(root, 'utils/platform-support');
  const { readMarketplaceManifestAtPath } = await candidateCliImport(root, 'utils/marketplace');
  for (const platform of ['codex', 'claude']) {
    const platformManifest = await readMarketplaceManifestAtPath(path.join(snapshot, platform === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json'));
    const projected = marketplace.projectMarketplaceManifestForPlatform(platformManifest, platform);
    assert.ok(projected.plugins.length > 0);
    assert.deepEqual(projected.plugins.map((plugin) => plugin.name).sort(), plugins.filter((plugin) => supportsPlatform(plugin.manifest, platform)).map((plugin) => plugin.manifest.name).sort());
    let skillCount = 0;
    for (const plugin of plugins.filter((entry) => supportsPlatform(entry.manifest, platform))) {
      const staticRoot = path.join(plugin.rootDir, platform, 'skills');
      const staticSkills = await fs.readdir(staticRoot).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
      const dynamic = (plugin.manifest.artifacts?.targets ?? []).filter((target) => target.platform === platform && target.target === `${platform}.skill` && target.scopes.includes('user'));
      const selections = [...staticSkills.map((skill) => ({ skill, targetId: null })), ...dynamic.map((target) => ({ skill: target.skillKey, targetId: target.id }))];
      if (selections.length === 0) continue;
      const outputRoot = path.join(root, 'materialized', platform, plugin.manifest.name);
      const result = await materializer.materializeReviewNativeSkills({ plugin, platform, scope: 'user', cwd: root, env, outputRoot, skills: selections, allowDisabledNativeSkills: true });
      for (const skill of result.skills) await fs.access(path.join(skill.path, 'SKILL.md'));
      skillCount += result.skills.length;
    }
    assert.ok(skillCount > 0, `${platform} materialization must run at least one Skill`);
    record(`catalog-${platform}-materialize`, { skills: skillCount });
    const calls = [];
    const invocation = platform === 'codex'
      ? native.buildCodexMarketplaceAddInvocation(native.SYSTEM_CODEX_MANAGER, snapshot, root, env)
      : { command: 'claude', args: ['plugin', 'marketplace', 'add', snapshot], cwd: root, env };
    await native.runNativeCliChecked(invocation, async (call) => {
      calls.push(call);
      assert.ok(call.args.includes(snapshot));
      assert.equal(call.env.AW_HOME, env.AW_HOME);
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    assert.equal(calls.length, 1);
    record(`catalog-${platform}-native-projection`, { evidence: 'simulated-external-cli', plugins: projected.plugins.length });
  }
}

// Run in a fresh Node process: imported candidate code sees only isolated homes
// and its own installed dependency closure.
export async function probeInstalledCandidate({ root, bundleRoot, candidate, minimumNode = false }) {
  const checks = [];
  const record = (id, detail = {}) => checks.push({ id, passed: true, ...detail });
  try {
    await checkInstalledEntrypoints(root, process.env); record('installed-bins');
    await checkInstalledImportsAndPaths(root, process.env); record('esm-imports-and-config-paths');
    await checkHelpers(root); record('platform-helper-packages');
    if (candidate.product === 'catalog' && !minimumNode) await checkCatalog(root, bundleRoot, candidate, process.env, record);
    if (process.platform === 'win32' && !minimumNode) {
      const helperPath = path.join(packagePath(root, `@lesliechan721/aw-windows-job-win32-${process.arch}`), 'dist', 'aw-windows-job.exe');
      const resolver = await candidateImport(root, PACKAGE_NAMES[1], 'dist/windows-job.js');
      assert.equal(resolver.resolveWindowsJobHelperPath(), helperPath);
      const evaluator = await candidateImport(root, PACKAGE_NAMES[1]);
      const qualification = await runWindowsJobQualification({ helperPath, runProviderProcess: evaluator.runProviderProcess });
      record('windows-job-qualification', { passed: qualification.status === 'passed', qualification });
      assertRequiredChecks(qualification.checks, WINDOWS_JOB_REQUIRED_CHECKS);
      assert.equal(qualification.status, 'passed');
    }
  } catch (error) {
    checks.push({ id: 'installed-probe-failure', passed: false, message: error instanceof Error ? error.message : String(error) });
  }
  return checks;
}

function requiredCandidateChecks(options) {
  const required = ['native-host', 'candidate-integrity', 'five-package-closure', 'installed-bins', 'esm-imports-and-config-paths', 'platform-helper-packages'];
  if (!options.minimumNode && options.product === 'catalog') required.push('catalog-validate', 'catalog-path-consumption', 'catalog-git-consumption', 'catalog-dependencies', 'catalog-codex-materialize', 'catalog-claude-materialize', 'catalog-codex-native-projection', 'catalog-claude-native-projection');
  if (!options.minimumNode && options.os === 'win32') required.push('windows-job-qualification');
  return required;
}

export async function runCandidateSmoke(options) {
  const report = {
    schemaVersion: 1, kind: 'candidate-smoke', product: options.product,
    platform: process.platform, arch: process.arch, node: process.versions.node,
    mode: options.minimumNode ? 'minimum-node' : 'platform',
    archiveDigest: options.candidateDigest ?? null, candidateDigest: null,
    externalCliQualification: 'not-run', status: 'failed', checks: [],
  };
  let root;
  const record = (id) => report.checks.push({ id, passed: true });
  try {
    assertCandidateHost(options); record('native-host');
    const candidate = await verifyCandidateDirectory(options.bundleRoot, { product: options.product });
    report.candidateDigest = bytesDigest(await fs.readFile(path.join(options.bundleRoot, 'candidate.json')));
    record('candidate-integrity');
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-candidate-smoke-')));
    const env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), AW_HOME: path.join(root, 'aw-home'), AW_CODEX_HOME: path.join(root, 'codex-home'), CODEX_HOME: path.join(root, 'codex-home'), AW_CLAUDE_HOME: path.join(root, 'claude-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'), XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_CACHE_HOME: path.join(root, 'xdg-cache'), npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'npmrc'), NODE_PATH: '', NODE_OPTIONS: '', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    for (const directory of [env.HOME, env.AW_HOME, env.AW_CODEX_HOME, env.AW_CLAUDE_HOME]) await fs.mkdir(directory, { recursive: true });
    await installCandidatePackages(options.bundleRoot, candidate, root, env); record('five-package-closure');
    const probe = { root, bundleRoot: options.bundleRoot, candidate, minimumNode: options.minimumNode === true };
    const input = path.join(root, 'probe.json');
    await fs.writeFile(input, JSON.stringify(probe));
    const result = await capture(process.execPath, ['--input-type=module', '--eval', `import fs from 'node:fs/promises'; const { probeInstalledCandidate } = await import(process.argv[1]); console.log(JSON.stringify(await probeInstalledCandidate(JSON.parse(await fs.readFile(process.argv[2], 'utf8')))));`, pathToFileURL(scriptPath).href, input], { cwd: root, env });
    report.checks.push(...JSON.parse(result.stdout));
    assertRequiredChecks(report.checks, requiredCandidateChecks(options));
    report.status = 'passed';
  } catch (error) {
    report.checks.push({ id: 'candidate-smoke-failure', passed: false, message: error instanceof Error ? error.message : String(error) });
    for (const id of requiredCandidateChecks(options)) {
      if (!report.checks.some((check) => check.id === id)) report.checks.push({ id, passed: false, code: 'requiredCheckNotCompleted' });
    }
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const report = await runCandidateSmoke(parseCandidateSmokeArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
