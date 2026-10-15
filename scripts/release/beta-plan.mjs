import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertReleaseWorktreeClean,
  captureCommand,
  compareReleaseSemVer,
  computePackageTarballTreeDigest,
  downloadExactPackageTarball,
  packCli,
  packCore,
  packEval,
  packWindowsJobArm64,
  packWindowsJobX64,
  RELEASE_NETWORK_TIMEOUT_MS,
  repoRoot as defaultRepoRoot,
  resolveRegistryUrl,
  runReleaseGit,
  withReleaseBuildSnapshot,
} from './common.mjs';
import { readCatalogAttemptVersions } from './catalog-publication.mjs';
import { calculateCanonicalDigest } from './release-model.mjs';
import { resolveMainSource } from './source-candidate.mjs';

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/u;
const CLI_PACKAGES = [
  ['aw-windows-job-win32-x64', '@lesliechan721/aw-windows-job-win32-x64', packWindowsJobX64],
  ['aw-windows-job-win32-arm64', '@lesliechan721/aw-windows-job-win32-arm64', packWindowsJobArm64],
  ['agent-skill-eval', '@lesliechan721/agent-skill-eval', packEval],
  ['plugin-core', '@lesliechan721/aw-plugin-core', packCore],
  ['cli', '@lesliechan721/aw', packCli],
];
const CATALOG_MANIFEST = 'catalog-manifest.json';

function base(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`Automatic beta requires a stable or exact beta version: ${JSON.stringify(version)}.`);
  }
  return version.split('-', 1)[0];
}

function highest(versions) {
  return [...versions].sort(compareReleaseSemVer).at(-1) ?? null;
}

function patch(version) {
  const parts = base(version).split('.');
  parts[2] = String(BigInt(parts[2]) + 1n);
  return parts.join('.');
}

function nextVersion({ declaration, previousDeclaration, occupied, productionChanged, firstRelease }) {
  const declaredBase = base(declaration);
  const explicit = previousDeclaration !== null && declaredBase !== base(previousDeclaration);
  const used = [...new Set(occupied.filter((version) => VERSION.test(version)))];
  const usedStable = highest(used.filter((version) => !version.includes('-')));
  const usedBase = highest(used.map(base));
  if (explicit && (
    (usedBase !== null && compareReleaseSemVer(declaredBase, usedBase) < 0)
    || (usedStable !== null && compareReleaseSemVer(declaredBase, usedStable) <= 0)
    || compareReleaseSemVer(declaredBase, base(previousDeclaration)) < 0
  )) {
    throw new Error(`Explicit version target ${declaredBase} conflicts with the already used version line ${usedBase ?? previousDeclaration}.`);
  }
  const unfinished = highest(used.filter((version) => version.includes('-'))
    .map(base).filter((version) => usedStable === null || compareReleaseSemVer(version, usedStable) > 0));
  const recoveredBase = unfinished ?? (usedStable === null ? declaredBase : patch(usedStable));
  const baseVersion = explicit ? declaredBase
    : firstRelease ? highest([declaredBase, recoveredBase]) : recoveredBase;
  if (!productionChanged && !explicit && !firstRelease) {
    return { changed: false, version: null, baseVersion, reason: 'No production changes or new explicit version target.' };
  }
  const numbers = used.filter((version) => version.startsWith(`${baseVersion}-beta.`))
    .map((version) => BigInt(version.slice(`${baseVersion}-beta.`.length)));
  const sequence = numbers.reduce((maximum, value) => value > maximum ? value : maximum, 0n) + 1n;
  return {
    changed: true,
    version: `${baseVersion}-beta.${sequence}`,
    baseVersion,
    reason: explicit ? 'Explicit version target changed.' : firstRelease
      ? 'No successful delivery exists.' : 'Production content differs from the successful delivery.',
  };
}

function git(root, args, env) {
  return runReleaseGit(args, {
    cwd: root,
    env,
    captureCommand: (command, commandArgs, options) => captureCommand(command, commandArgs, {
      ...options, timeoutMs: RELEASE_NETWORK_TIMEOUT_MS,
    }),
  });
}

async function jsonAt(root, commit, relativePath, env) {
  return JSON.parse((await git(root, ['show', `${commit}:${relativePath}`], env)).stdout);
}

async function declarationAt(root, commit, product, env) {
  const value = await jsonAt(root, commit, product === 'cli'
    ? 'release/version-targets.json' : 'plugins/marketplace-source.json', env);
  const declaration = product === 'cli' ? value.cli : value.catalog?.version;
  base(declaration);
  if (product === 'cli' && declaration.includes('-')) throw new Error('CLI source target must be stable.');
  return declaration;
}

async function mainTip(root, remote, env) {
  const { stdout } = await git(root, ['ls-remote', '--refs', remote, 'refs/heads/main'], env);
  const entries = stdout.trim().split('\n').filter(Boolean);
  if (entries.length !== 1 || !/^[0-9a-f]{40,64}\trefs\/heads\/main$/u.test(entries[0])) {
    throw new Error('The remote must expose one main branch for automatic beta planning.');
  }
  return entries[0].split('\t')[0];
}

async function readPackageVersions(name, options) {
  const registryUrl = options.registryUrl ?? await resolveRegistryUrl(
    path.join(options.repoRoot, 'packages', 'cli', 'package.json'), options.env,
  );
  let stdout;
  try {
    ({ stdout } = await (options.captureCommand ?? captureCommand)('npm', [
      'view', name, 'versions', '--json', '--registry', registryUrl,
    ], { cwd: options.repoRoot, env: options.env, timeoutMs: RELEASE_NETWORK_TIMEOUT_MS }));
  } catch (error) {
    if (/\bE404\b|404 Not Found|is not in this registry/iu.test(String(error?.message))) return [];
    throw error;
  }
  const versions = JSON.parse(stdout);
  if (!Array.isArray(versions) || versions.some((version) => typeof version !== 'string')) {
    throw new Error(`Registry returned invalid versions for ${name}.`);
  }
  return versions;
}

async function readCliAttempt(root) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(path.join(root, '.release', 'attempted.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error('Cannot determine the occupied CLI version from the local attempt.', { cause: error });
  }
  base(value.candidates?.cli);
  return [value.candidates.cli];
}

async function latestSource(root, releases, env) {
  let latest = null;
  for (const release of releases) {
    if (latest === null || latest.sourceHead === release.sourceHead) {
      if (latest === null || compareReleaseSemVer(release.version, latest.version) > 0) latest = release;
      continue;
    }
    const bases = (await git(root, ['merge-base', '--all', latest.sourceHead, release.sourceHead], env))
      .stdout.trim().split('\n');
    if (bases.length !== 1 || (bases[0] !== latest.sourceHead && bases[0] !== release.sourceHead)) {
      throw new Error('Successful releases do not have one ordered main source history.');
    }
    if (bases[0] === latest.sourceHead) latest = release;
  }
  return latest;
}

async function releaseHistory(root, tags, selectedProduct, versionSets, env) {
  const releases = [];
  for (const tag of tags) {
    const match = /^(cli|catalog)-v(.+)$/u.exec(tag);
    if (!match || !VERSION.test(match[2])) continue;
    const [, product, version] = match;
    if (product !== selectedProduct) continue;
    if (product === 'cli' && !versionSets.every((versions) => versions.includes(version))) continue;
    const commit = (await git(root, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], env)).stdout.trim();
    let sourceCommit = commit;
    let manifest;
    if (product === 'catalog') {
      manifest = await jsonAt(root, commit, CATALOG_MANIFEST, env);
      if (manifest.schemaVersion !== 7 || manifest.catalogVersion !== version
        || !['latest', 'beta'].includes(manifest.channel)
        || manifest.release?.state !== 'published' || !/^[0-9a-f]{40,64}$/u.test(manifest.release.sourceHead)) {
        throw new Error(`Cannot prove the published Catalog source for ${tag}.`);
      }
      const channelRef = `refs/heads/catalog/${manifest.channel}`;
      const containingRefs = (await git(root, [
        'for-each-ref', `--contains=${commit}`, '--format=%(refname)', channelRef,
      ], env)).stdout.trim().split('\n');
      // An immutable tag occupies the version even if the channel write failed.
      if (!containingRefs.includes(channelRef)) continue;
      sourceCommit = manifest.release.sourceHead;
    }
    const source = await resolveMainSource({
      repoRoot: root, candidateHead: sourceCommit, product,
      mainRef: 'refs/heads/main', allowLegacyHistory: true,
    });
    releases.push({ version, tag, commit, ...source, manifest });
  }
  return releases;
}

async function exportSnapshot(root, commit, destination, env) {
  await fs.mkdir(destination);
  const archive = `${destination}.tar`;
  await git(root, ['archive', '--format=tar', `--output=${archive}`, commit], env);
  await captureCommand('tar', ['-xf', archive, '-C', destination], { env });
  await fs.rm(archive);
}

// Entry contentDigest already covers the complete, version-neutral plugin tree,
// including native/Portable projections, requirements receipts and file modes.
async function catalogProductionContent(root, manifest) {
  const normalized = JSON.parse(JSON.stringify(manifest));
  delete normalized.catalogVersion;
  delete normalized.channel;
  delete normalized.release;
  for (const entry of normalized.entries) {
    delete entry.version;
    delete entry.artifactDigest;
    delete entry.manifestDigest;
  }
  const projections = [];
  for (const relativePath of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
    const target = path.join(root, relativePath);
    const stat = await fs.lstat(target);
    if (!stat.isFile()) throw new Error('Catalog marketplace projection must be a regular file.');
    projections.push({ path: relativePath, mode: stat.mode & 0o111,
      value: JSON.parse(await fs.readFile(target, 'utf8')) });
  }
  return calculateCanonicalDigest({ manifest: normalized, projections });
}

async function compareCli(artifacts, baseline, root, options) {
  if (!Array.isArray(artifacts) || artifacts.length !== CLI_PACKAGES.length
    || new Set(artifacts.map((artifact) => artifact.name)).size !== CLI_PACKAGES.length) {
    throw new Error('Production comparison requires all five candidate npm packages.');
  }
  let changed = baseline === null;
  for (const [directory, name] of CLI_PACKAGES) {
    const artifact = artifacts.find((entry) => entry.name === name);
    if (!artifact) throw new Error(`Production comparison is missing ${name}.`);
    const candidateDigest = await computePackageTarballTreeDigest(artifact.tarballPath, {
      normalizeReleaseMetadata: true, expectedPackageName: name,
    });
    if (baseline === null) continue;
    const destination = path.join(root, directory);
    await fs.mkdir(destination);
    const downloaded = await (options.downloadExactPackageTarball ?? downloadExactPackageTarball)(
      name, baseline.version, path.join(options.repoRoot, 'packages', directory, 'package.json'), destination, options,
    );
    const publishedDigest = await computePackageTarballTreeDigest(downloaded.tarballPath, {
      normalizeReleaseMetadata: true, expectedPackageName: name, expectedVersion: baseline.version,
    });
    if (candidateDigest !== publishedDigest) changed = true;
  }
  return changed;
}

async function sourcePluginVersions(root, sourceHead, env) {
  if (sourceHead === null) return {};
  const paths = (await git(root, ['ls-tree', '-r', '--name-only', '-z', sourceHead, '--', 'plugins'], env))
    .stdout.split('\0').filter((entry) => /^plugins\/[^/]+\/\.agents-plugin\/plugin\.json$/u.test(entry));
  return Object.fromEntries(await Promise.all(paths.map(async (relativePath) => {
    const manifest = await jsonAt(root, sourceHead, relativePath, env);
    return [manifest.name, manifest.version];
  })));
}

async function compareCatalog(artifacts, baseline, cache, temporaryRoot, options) {
  if (artifacts.catalogError) throw artifacts.catalogError;
  const validate = artifacts.validateCatalogSnapshot;
  if (typeof validate !== 'function') throw new Error('Catalog production comparison requires complete snapshot validation.');
  const current = await validate(artifacts.catalogRoot);
  let productionChanged = baseline === null;
  let previousSnapshot;
  if (baseline !== null) {
    const destination = path.join(temporaryRoot, 'catalog-baseline');
    await exportSnapshot(cache, baseline.commit, destination, options.env);
    previousSnapshot = await validate(destination);
    productionChanged = await catalogProductionContent(artifacts.catalogRoot, current.manifest)
      !== await catalogProductionContent(destination, previousSnapshot.manifest);
  }
  const pluginHistory = await artifacts.readCatalogPublicationPluginHistory({
    workspaceRoot: options.repoRoot, remoteUrl: cache,
    branches: ['catalog/latest', 'catalog/beta'], env: options.env,
  });
  const sourceVersions = await sourcePluginVersions(cache, baseline?.sourceHead ?? null, options.env);
  const pluginVersions = artifacts.resolvePublishedPluginVersions({
    channel: 'beta', entries: current.manifest.entries,
    officialPluginHistory: pluginHistory, sourcePluginVersionsAtBaseline: sourceVersions,
  });
  const pluginBaseVersions = {};
  const affectedPlugins = [];
  for (const entry of current.manifest.entries) {
    if (base(pluginVersions[entry.name]) !== entry.version) pluginBaseVersions[entry.name] = base(pluginVersions[entry.name]);
    const previousVersion = highest(pluginHistory.filter((previous) => previous.name === entry.name).map((previous) => previous.version));
    const previous = pluginHistory.find((previous) => previous.name === entry.name && previous.version === previousVersion);
    if (!previous || previous.contentDigest !== entry.contentDigest || previous.version !== pluginVersions[entry.name]) affectedPlugins.push(entry.name);
    if (previous && previous.contentDigest === entry.contentDigest && previous.version !== pluginVersions[entry.name]) productionChanged = true;
  }
  for (const previous of previousSnapshot?.manifest.entries ?? []) {
    if (!current.manifest.entries.some((entry) => entry.name === previous.name)) affectedPlugins.push(previous.name);
  }
  return { productionChanged, affectedPlugins: [...new Set(affectedPlugins)].sort(), pluginBaseVersions };
}

async function withProductionArtifacts({ repoRoot, sourceHead, env }, callback) {
  await assertReleaseWorktreeClean({ cwd: repoRoot });
  if ((await git(repoRoot, ['rev-parse', 'HEAD'], env)).stdout.trim() !== sourceHead) {
    throw new Error('Production comparison must build the verified main source HEAD.');
  }
  const result = await withReleaseBuildSnapshot(async (snapshot) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-beta-pack-'));
    try {
      const [cli, catalog] = await Promise.allSettled([
        Promise.all(CLI_PACKAGES.map(async ([, name, pack]) => ({
          name, tarballPath: await pack({ snapshot, destination: directory, quiet: true }),
        }))),
        Promise.all([
          import(pathToFileURL(path.join(snapshot.corePackageRoot, 'dist', 'index.js')).href),
          import(pathToFileURL(path.join(snapshot.cliDistRoot, 'src', 'commands', 'catalog-publication-inspection.js')).href),
        ]),
      ]);
      const [core, inspection] = catalog.status === 'fulfilled' ? catalog.value : [];
      return await callback({
        cli: cli.status === 'fulfilled' ? cli.value : null,
        cliError: cli.status === 'rejected' ? cli.reason : null,
        catalogRoot: snapshot.catalogOutputRoot,
        catalogError: catalog.status === 'rejected' ? catalog.reason : null,
        validateCatalogSnapshot: core?.validateCatalogSnapshotComplete,
        resolvePublishedPluginVersions: core?.resolvePublishedPluginVersions,
        readCatalogPublicationPluginHistory: inspection?.readCatalogPublicationPluginHistory,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, { repoRoot });
  await assertReleaseWorktreeClean({ cwd: repoRoot });
  if ((await git(repoRoot, ['rev-parse', 'HEAD'], env)).stdout.trim() !== sourceHead) {
    throw new Error('Main source HEAD changed during production comparison.');
  }
  return result;
}

function skipped(sourceHead, mainHead) {
  return { schemaVersion: 1, sourceHead, skipped: true, reason: 'Verified source is no longer the main tip.', mainHead,
    products: Object.fromEntries(['cli', 'catalog'].map((product) => [product, {
      changed: false, version: null, baseVersion: null, baselineSource: null, reason: 'Source CI was superseded.',
    }])) };
}

/** Read-only planner. The artifact callback owns its temporary outputs until it returns. */
export async function planAutomaticBeta({ repoRoot = defaultRepoRoot, sourceHead, remote = 'origin',
  env = process.env, ...injected } = {}) {
  if (!/^[0-9a-f]{40,64}$/u.test(sourceHead ?? '')) throw new Error('Automatic beta requires the exact verified source SHA.');
  repoRoot = path.resolve(repoRoot);
  const remotes = (await git(repoRoot, ['remote'], env)).stdout.trim().split('\n');
  if (remotes.includes(remote)) remote = (await git(repoRoot, ['remote', 'get-url', remote], env)).stdout.trim();
  if (typeof remote !== 'string' || remote === '' || remote.startsWith('-')
    || /^[a-z][a-z\d+.-]*:\/\/[^/\s?#]*@/iu.test(remote)) throw new Error('Planning remote must not contain credentials.');
  const initialMain = await mainTip(repoRoot, remote, env);
  if (initialMain !== sourceHead) return skipped(sourceHead, initialMain);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-beta-plan-'));
  try {
    const cache = path.join(temporaryRoot, 'repository');
    await captureCommand('git', ['init', '--quiet', '--initial-branch=aw-beta-inspection', cache], { env });
    await git(cache, ['fetch', '--no-tags', '--no-recurse-submodules', remote,
      '+refs/heads/main:refs/heads/main', '+refs/tags/*:refs/tags/*',
      '+refs/heads/catalog/*:refs/heads/catalog/*'], env);
    const fetchedMain = (await git(cache, ['rev-parse', 'refs/heads/main'], env)).stdout.trim();
    if (fetchedMain !== sourceHead) return skipped(sourceHead, fetchedMain);
    const tags = (await git(cache, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags'], env))
      .stdout.trim().split('\n').filter(Boolean);
    const options = { ...injected, repoRoot, env };
    const states = {};
    const products = {};
    function failed(product, error) {
      const state = states[product];
      return { changed: false, version: null, baseVersion: state?.declaration ? base(state.declaration) : null,
        baselineSource: state?.baseline?.sourceHead ?? null, baselineVersion: state?.baseline?.version ?? null,
        reason: 'Automatic beta planning failed.', error: error instanceof Error ? error.message : String(error) };
    }
    for (const product of ['cli', 'catalog']) {
      try {
        const versionSets = product === 'cli' ? await Promise.all(CLI_PACKAGES.map(([, name]) =>
          (injected.readPackageVersions ?? readPackageVersions)(name, options))) : [];
        if (versionSets.some((versions) => !Array.isArray(versions)
          || versions.some((version) => typeof version !== 'string'))) throw new Error('Invalid registry version history.');
        const history = await releaseHistory(cache, tags, product, versionSets, env);
        const baseline = await latestSource(cache, history, env);
        const declaration = await declarationAt(cache, sourceHead, product, env);
        const previousDeclaration = baseline === null ? null : await declarationAt(cache, baseline.sourceHead, product, env);
        const occupied = tags.flatMap((tag) => {
          const prefix = `release/${product}/v`;
          const completionPrefix = `${product}-v`;
          const version = tag.startsWith(prefix) ? tag.slice(prefix.length)
            : tag.startsWith(completionPrefix) ? tag.slice(completionPrefix.length) : null;
          return version !== null && VERSION.test(version) ? [version] : [];
        });
        occupied.push(...(product === 'cli' ? [...versionSets.flat(), ...await readCliAttempt(repoRoot)]
          : await readCatalogAttemptVersions({ repoRoot })));
        const inputPaths = baseline === null ? null : (await git(cache, [
          'diff', '--no-renames', '--name-only', '-z', baseline.sourceHead, sourceHead, '--',
        ], env)).stdout.split('\0').filter(Boolean);
        states[product] = { declaration, previousDeclaration, occupied, baseline, inputPaths };
        // Detect target conflicts before building either product. Content is still
        // compared below; a source path match alone never authorizes a release.
        nextVersion({ declaration, previousDeclaration, occupied, productionChanged: false, firstRelease: baseline === null });
      } catch (error) {
        products[product] = failed(product, error);
      }
    }
    if (Object.keys(products).length < 2) {
      try {
        await (injected.withProductionArtifacts ?? withProductionArtifacts)(
          { repoRoot, sourceHead, env }, async (artifacts) => {
            for (const product of ['cli', 'catalog']) {
              if (products[product]?.error) continue;
              const state = states[product];
              try {
                if (product === 'cli' && artifacts.cliError) throw artifacts.cliError;
                const comparison = product === 'cli'
                  ? { productionChanged: await compareCli(artifacts.cli, state.baseline, temporaryRoot, options) }
                  : await compareCatalog(artifacts, state.baseline, cache, temporaryRoot, options);
                const { productionChanged, ...details } = comparison;
                products[product] = {
                  ...nextVersion({ ...state, productionChanged, firstRelease: state.baseline === null }),
                  baselineSource: state.baseline?.sourceHead ?? null, baselineVersion: state.baseline?.version ?? null,
                  inputPaths: state.inputPaths, ...details,
                };
              } catch (error) {
                products[product] = failed(product, error);
              }
            }
          },
        );
      } catch (error) {
        // Build/source evidence is shared. A failure after the callback also
        // invalidates its decisions, such as a changed source HEAD.
        for (const product of ['cli', 'catalog']) {
          if (!products[product]?.error) products[product] = failed(product, error);
        }
      }
    }
    const finalMain = await mainTip(repoRoot, remote, env);
    if (finalMain !== sourceHead) return skipped(sourceHead, finalMain);
    return { schemaVersion: 1, sourceHead, skipped: false, products };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
