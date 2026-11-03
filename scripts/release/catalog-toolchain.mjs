import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { captureCommand, downloadExactPackageTarball, repoRoot as defaultRoot, resolveRegistryUrl, runReleaseGit } from './common.mjs';
import { installCandidatePackages } from './candidate-smoke.mjs';

export const TOOLCHAIN_PACKAGES = [
  '@lesliechan721/aw', '@lesliechan721/agent-skill-eval', '@lesliechan721/aw-plugin-core',
  '@lesliechan721/aw-windows-job-win32-x64', '@lesliechan721/aw-windows-job-win32-arm64',
];
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/u;

export async function loadCatalogToolchainCore(cliDistRoot, options = {}) {
  if (typeof cliDistRoot !== 'string' || cliDistRoot === '') throw new Error('Catalog tools require an explicit selected CLI dist directory.');
  // Core exposes its ESM import entry. Resolve from the selected CLI dependency
  // context, which works for both workspace links and normal npm installations.
  const { stdout } = await captureCommand(process.execPath, [
    '--input-type=module', '--eval',
    'console.log(JSON.stringify(import.meta.resolve("@lesliechan721/aw-plugin-core")))',
  ], { cwd: path.resolve(cliDistRoot), env: options.env ?? process.env, timeoutMs: 30_000 });
  return import(JSON.parse(stdout));
}

export function assertToolchainChannel(version, channel) {
  if (!VERSION.test(version ?? '') || !['beta', 'stable'].includes(channel)
    || version.includes('-beta.') !== (channel === 'beta')) {
    throw new Error(`Catalog requires a completed ${channel} CLI. Publish the ${channel} CLI first.`);
  }
}

// Retry only read operations. The deadline includes each registry request.
export async function readToolchainWithRetry(read, options = {}) {
  const now = options.now ?? Date.now;
  const deadline = options.registryReadDeadlineAt ?? now() + (options.registryReadDeadlineMs ?? 120_000);
  const pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  do {
    try { return await read(Math.max(1, deadline - now())); }
    catch (error) { if (error.code === 'releasePackageMismatch') throw error; lastError = error; }
    if (now() >= deadline) break;
    await pause(Math.min(options.registryReadRetryMs ?? 2_000, deadline - now()));
  } while (now() < deadline);
  throw new Error('Cannot obtain the complete Catalog CLI toolchain within the registry read deadline.', { cause: lastError });
}

export async function assertToolchainCompletion(version, options = {}) {
  const ref = `refs/tags/cli-v${version}`;
  const result = await (options.runGit ?? runReleaseGit)([
    'ls-remote', options.remote ?? 'origin', ref, `${ref}^{}`,
  ], { ...options, cwd: options.repoRoot ?? defaultRoot });
  const refs = new Map(result.stdout.trim().split('\n').filter(Boolean).map((line) => line.split(/\s+/u).reverse()));
  const head = refs.get(`${ref}^{}`);
  if (!refs.has(ref) || !/^[0-9a-f]{40,64}$/u.test(head ?? '')) {
    throw new Error(`CLI ${version} has no completed publication tag.`);
  }
  if (options.expectedCliHead && head !== options.expectedCliHead) throw new Error('CLI completion tag does not match this release batch.');
  return head;
}

export async function assertCandidateToolchainCompleted(toolchain, options = {}) {
  if (toolchain?.source !== 'candidate') return;
  try {
    assertToolchainChannel(toolchain.version, toolchain.channel);
    if (!/^[0-9a-f]{40,64}$/u.test(toolchain.candidateHead ?? '')) {
      throw new Error('Catalog candidate tools require their exact CLI candidate head.');
    }
    await (options.assertToolchainCompletion ?? assertToolchainCompletion)(toolchain.version, {
      ...options, expectedCliHead: toolchain.candidateHead,
    });
  } catch (cause) {
    const error = new Error(`Catalog must wait for the exact CLI ${toolchain.version} completion tag. Preserve the CLI prepared release and repair the CLI first. ${cause.message}`, { cause });
    error.code = 'cliToolchainIncomplete';
    throw error;
  }
}

export async function prepareCatalogToolchain(channel, options = {}) {
  options = { ...options, registryReadDeadlineAt: options.registryReadDeadlineAt ?? Date.now() + (options.registryReadDeadlineMs ?? 120_000) };
  const repoRoot = options.repoRoot ?? defaultRoot;
  const destination = options.destination ?? path.join(repoRoot, '.release', 'catalog-toolchain');
  const env = options.env ?? process.env;
  const tag = channel === 'stable' ? 'latest' : 'beta';
  await fs.mkdir(destination, { recursive: true });
  let toolchain;
  let tarballPaths;
  try {
    if (options.cliBundle) {
      const bundle = options.cliBundle;
      assertToolchainChannel(bundle.version, channel);
      tarballPaths = [bundle.cliTarballPath ?? bundle.tarballPath, bundle.evalTarballPath, bundle.coreTarballPath, ...bundle.windowsJobTarballPaths];
      toolchain = { version: bundle.version, channel, source: 'candidate', candidateHead: bundle.candidateHead ?? options.expectedCliHead };
    } else {
      const packageJson = path.join(repoRoot, 'packages/cli/package.json');
      const registryUrl = options.registryUrl ?? await resolveRegistryUrl(packageJson, env);
      // Resolve the floating tag once. Retries and recovery use this exact version.
      const version = await readToolchainWithRetry(async (remaining) => {
        const result = await (options.captureCommand ?? captureCommand)('npm', [
          'view', `${TOOLCHAIN_PACKAGES[0]}@${tag}`, 'version', '--json', '--prefer-online', '--registry', registryUrl,
        ], { cwd: repoRoot, env, timeoutMs: remaining });
        return JSON.parse(result.stdout);
      }, options);
      assertToolchainChannel(version, channel);
      const completionHead = await (options.assertToolchainCompletion ?? assertToolchainCompletion)(version, { ...options, timeoutMs: Math.max(1, options.registryReadDeadlineAt - Date.now()) });
      tarballPaths = await readToolchainWithRetry(async (remaining) => {
        const deadline = Date.now() + remaining;
        const paths = [];
        for (const [index, name] of TOOLCHAIN_PACKAGES.entries()) {
          if (Date.now() >= deadline) throw new Error('Registry read deadline expired before all five packages were obtained.');
          const directory = path.join(destination, `download-${index}`);
          await fs.rm(directory, { recursive: true, force: true });
          await fs.mkdir(directory);
          const result = await (options.downloadExactPackageTarball ?? downloadExactPackageTarball)(name, version, packageJson, directory, {
            ...options, env: { ...env, npm_config_prefer_online: 'true', NPM_CONFIG_PREFER_ONLINE: 'true' }, registryUrl,
            timeoutMs: Math.max(1, deadline - Date.now()),
          });
          paths.push(result.tarballPath);
        }
        return paths;
      }, options);
      toolchain = { version, channel, source: 'registry', completionHead };
    }
    if (tarballPaths.length !== 5 || tarballPaths.some((entry) => typeof entry !== 'string')) throw new Error('A complete five-package CLI toolchain is required.');
    const tools = path.join(destination, 'tools');
    await fs.mkdir(tools, { recursive: true });
    const saved = [];
    for (const [index, tarball] of tarballPaths.entries()) {
      const target = path.join(tools, `${index}-${path.basename(tarball)}`);
      await fs.copyFile(tarball, target);
      saved.push(target);
    }
    const installRoot = path.join(destination, 'installed');
    await fs.rm(installRoot, { recursive: true, force: true });
    await fs.mkdir(installRoot);
    await (options.installCandidatePackages ?? installCandidatePackages)(destination, {
      product: 'catalog', toolchain, files: saved.map((file) => ({ path: path.relative(destination, file) })),
    }, installRoot, env);
    const cliDistRoot = path.join(installRoot, 'node_modules/@lesliechan721/aw/dist');
    const capability = await (options.loadToolchainCapabilities ?? (async () => import(pathToFileURL(path.join(cliDistRoot, 'src/commands/aw-capabilities.js')).href)))();
    const requiredCapabilities = new Set(['aw.catalog-publication.v1', 'aw.catalog-snapshot.v7', 'aw.catalog-authoring.v1']);
    const plugins = await fs.readdir(path.join(repoRoot, 'plugins'), { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const plugin of plugins.filter((entry) => entry.isDirectory())) {
      let manifest;
      try { manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'plugins', plugin.name, '.agents-plugin/plugin.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const required of manifest.requires?.aw?.capabilities ?? []) requiredCapabilities.add(required);
    }
    for (const required of requiredCapabilities) {
      if (!capability.IMPLEMENTED_AW_CAPABILITIES?.includes(required)) throw new Error(`Selected CLI lacks ${required}.`);
    }
    return { cliDistRoot, toolchain, tarballPaths: saved, root: destination };
  } catch (error) {
    throw new Error(`Catalog requires the complete compatible ${channel} CLI. Publish the ${channel} CLI first. ${error.message}`, { cause: error });
  }
}

export async function installSavedCatalogToolchain(root, catalog, options = {}) {
  await assertSavedCatalogTools(root, catalog);
  const destination = options.toolchainInstallRoot ?? path.join(options.releaseRoot ?? path.join(options.repoRoot ?? defaultRoot, '.release'), 'catalog-tools');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await (options.installCandidatePackages ?? installCandidatePackages)(root, {
    product: 'catalog', toolchain: catalog.toolchain,
    files: catalog.tools.map((entry) => ({ path: entry.path })),
  }, destination, options.env ?? process.env);
  return { cliDistRoot: path.join(destination, 'node_modules/@lesliechan721/aw/dist') };
}

async function assertSavedCatalogTools(root, catalog) {
  if (catalog.tools?.length !== 5) throw new Error('Catalog recovery requires its exact five tool packages.');
  assertToolchainChannel(catalog.toolchain?.version, catalog.toolchain?.channel);
  const tarballPaths = [];
  for (const artifact of catalog.tools) {
    if (typeof artifact.path !== 'string' || path.isAbsolute(artifact.path)) throw new Error('Saved Catalog tool path is invalid.');
    const file = path.resolve(root, artifact.path);
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Saved Catalog tool path escapes its prepared directory.');
    const stats = await fs.lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Saved Catalog toolchain must contain regular files.');
    const [realFile, realRoot] = await Promise.all([fs.realpath(file), fs.realpath(root)]);
    if (!realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error('Saved Catalog tool path escapes its prepared directory.');
    const digest = `sha256:${crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
    if (digest !== artifact.contentDigest) throw new Error('Saved Catalog toolchain changed.');
    tarballPaths.push(file);
  }
  return tarballPaths;
}

// A pending plan already owns its tools. Read this local evidence before any
// floating registry selection, then let those exact tools validate the plan.
export async function restorePendingCatalogToolchain(channel, options = {}) {
  const repoRoot = options.repoRoot ?? defaultRoot;
  const preparedRoot = options.preparedRoot ?? path.join(options.releaseRoot ?? path.join(repoRoot, '.release'), 'prepared');
  const publishRoot = path.join(repoRoot, '.aw/publish');
  const exists = async (file) => fs.lstat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
  if (!await exists(publishRoot) && !await exists(preparedRoot)) return null;
  const { readCatalogSourceVersion, prepareCatalogRelease } = await import('./catalog-publication.mjs');
  const version = await (options.readCatalogVersion ?? readCatalogSourceVersion)({ ...options, repoRoot });
  if (version.includes('-beta.') !== (channel === 'beta')) return null;
  const attemptRoot = path.join(publishRoot, version);
  const hasAttempt = await exists(attemptRoot);
  try {
    let journal;
    if (hasAttempt) {
      const stats = await fs.lstat(attemptRoot);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Catalog attempt directory is invalid.');
      const journalPath = path.join(attemptRoot, 'journal.json');
      const journalStats = await fs.lstat(journalPath);
      if (!journalStats.isFile() || journalStats.isSymbolicLink()) throw new Error('Catalog journal is invalid.');
      journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      // Completed plans can select a new candidate without their weak prepared directory.
      if (journal.state === 'published') {
        if (journal.schemaVersion !== 2 || !/^sha256:[0-9a-f]{64}$/u.test(journal.planDigest ?? '')
          || journal.display?.catalogVersion !== version || journal.repository !== null) throw new Error('Completed Catalog journal is invalid.');
        return null;
      }
      if (!['prepared', 'uncertain'].includes(journal.state)) throw new Error('Catalog journal state is invalid.');
    }
    const { readPreparedDescriptor } = await import('./prepared-release.mjs');
    let saved;
    try { saved = await readPreparedDescriptor({ ...options, preparedRoot }); }
    catch (error) { if (!hasAttempt) return null; throw error; }
    const savedMatches = saved.descriptor.catalog?.version === version;
    if (!hasAttempt && !savedMatches) return null;
    if (!journal || !savedMatches
      || saved.descriptor.channel !== channel
      || journal.planDigest !== saved.descriptor.catalog.publication.planDigest) throw new Error('Catalog plan and prepared tools do not match.');
    const tarballPaths = await assertSavedCatalogTools(saved.root, saved.descriptor.catalog);
    await assertCandidateToolchainCompleted(saved.descriptor.catalog.toolchain, options);
    const installed = await (options.installSavedCatalogToolchain ?? installSavedCatalogToolchain)(saved.root, saved.descriptor.catalog, options);
    const plan = await (options.prepareCatalog ?? prepareCatalogRelease)(channel === 'stable' ? 'latest' : 'beta', {
      ...options, repoRoot, cliDistRoot: installed.cliDistRoot,
    });
    if (plan.catalogVersion !== version || plan.planDigest !== journal.planDigest
      || !['prepared', 'uncertain'].includes(plan.state)) throw new Error('Saved Catalog plan changed.');
    return { ...installed, root: saved.root, toolchain: saved.descriptor.catalog.toolchain, tarballPaths,
      recoveredPlan: { version, planDigest: plan.planDigest } };
  } catch (error) {
    if (error.code === 'cliToolchainIncomplete') throw error;
    throw new Error(`Catalog ${version} recovery materials are missing, damaged, or changed. Increase the Catalog version. ${error.message}`, { cause: error });
  }
}
