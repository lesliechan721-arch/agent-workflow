import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compareStrictSemVer, parseStrictSemVer } from './semver.mjs';
import {
  assertAuthoringPluginPathFence,
  resolveAuthoringPluginRoot,
} from './plugin-root.mjs';

const execFileAsync = promisify(execFile);
const EXPECTED_MANIFEST_CONTRACT_VERSION = 6;
const CLI_PACKAGE_NAME = '@lesliechan721/aw';
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLI_REGISTRY_RELATIVE_PATH = 'src/utils/skill-frontmatter-capabilities.json';
const CLI_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

export class PluginVersionCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PluginVersionCheckError';
    this.code = code;
  }
}

function codedError(code, message) {
  return new PluginVersionCheckError(code, message);
}

function parseStablePluginVersion(version, fieldName) {
  const parsed = parseStrictSemVer(version, fieldName);
  if (parsed.prerelease.length > 0 || parsed.build.length > 0) {
    throw codedError(
      'invalidPlugin',
      `${fieldName} must be a stable SemVer without prerelease or build metadata.`,
    );
  }
  return parsed;
}

async function runGit(repoRoot, args, options = {}) {
  try {
    const result = await execFileAsync('git', args, {
      cwd: repoRoot,
      encoding: options.buffer ? null : 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const detail = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString('utf8').trim()
      : String(error.stderr ?? error.message).trim();
    throw codedError(
      options.code ?? 'gitFailed',
      `${options.label ?? `git ${args.join(' ')}`} failed${detail ? `: ${detail}` : '.'}`,
    );
  }
}

async function resolveBaseCommit(repoRoot, base) {
  await runGit(repoRoot, ['rev-parse', '--show-toplevel'], {
    code: 'gitUnavailable',
    label: 'Git repository discovery',
  });
  const output = await runGit(repoRoot, ['rev-parse', '--verify', `${base}^{commit}`], {
    code: 'invalidBase',
    label: `Git base ${JSON.stringify(base)}`,
  });
  return output.trim();
}

async function loadProductionBundler(cliPackageRoot) {
  const manifestModulePath = path.join(
    cliPackageRoot,
    'dist',
    'src',
    'utils',
    'manifest.js',
  );
  const generatorModulePath = path.join(
    cliPackageRoot,
    'dist',
    'src',
    'generators',
    'local-plugin.js',
  );
  const digestModulePath = path.join(
    cliPackageRoot,
    'dist',
    'src',
    'utils',
    'catalog-digests.js',
  );
  const runtimeProjectionModulePath = path.join(
    cliPackageRoot,
    'dist',
    'src',
    'utils',
    'catalog-runtime-projection.js',
  );
  const requiredPaths = [
    manifestModulePath,
    generatorModulePath,
    digestModulePath,
    runtimeProjectionModulePath,
  ];
  const exists = await Promise.all(requiredPaths.map((filePath) => fs.stat(filePath).then(
    (stat) => stat.isFile(),
    () => false,
  )));
  if (exists.some((value) => !value)) {
    throw codedError(
      'bundlerUnavailable',
      'Plugin version checking requires a built CLI; run `pnpm build` first.',
    );
  }

  let manifestModule;
  let generatorModule;
  let digestModule;
  let runtimeProjectionModule;
  try {
    [manifestModule, generatorModule, digestModule, runtimeProjectionModule] = await Promise.all([
      import(pathToFileURL(manifestModulePath).href),
      import(pathToFileURL(generatorModulePath).href),
      import(pathToFileURL(digestModulePath).href),
      import(pathToFileURL(runtimeProjectionModulePath).href),
    ]);
  } catch (error) {
    throw codedError('bundlerUnavailable', `Failed to load built CLI bundler: ${error.message}`);
  }
  if (
    manifestModule.SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION
      !== EXPECTED_MANIFEST_CONTRACT_VERSION
    || typeof manifestModule.readPluginManifest !== 'function'
    || typeof manifestModule.discoverPlugins !== 'function'
    || typeof generatorModule.bundleLocalPlugin !== 'function'
    || typeof digestModule.calculateCatalogEntryArtifactDigest !== 'function'
    || typeof runtimeProjectionModule.createCatalogRuntimeImportResolver !== 'function'
  ) {
    throw codedError(
      'bundlerUnavailable',
      'Built CLI authoring contract is incompatible; run `pnpm build` and retry.',
    );
  }
  return {
    readPluginManifest: manifestModule.readPluginManifest,
    discoverPlugins: manifestModule.discoverPlugins,
    bundleLocalPlugin: generatorModule.bundleLocalPlugin,
    calculateArtifactDigest: digestModule.calculateCatalogEntryArtifactDigest,
    createRuntimeResolver: runtimeProjectionModule.createCatalogRuntimeImportResolver,
  };
}

function parseTreeRecord(record) {
  const tabIndex = record.indexOf('\t');
  const metadata = record.slice(0, tabIndex).split(' ');
  return {
    mode: metadata[0],
    type: metadata[1],
    objectId: metadata[2],
    filePath: record.slice(tabIndex + 1),
  };
}

async function materializeBaseAuthoringSourceSet(repoRoot, baseCommit, outputRoot, pluginRootPath) {
  const sourcePaths = [
    'plugins',
    'packages/cli/package.json',
    'packages/cli/src/utils/skill-frontmatter-capabilities.json',
  ];
  if (pluginRootPath && !sourcePaths.includes(pluginRootPath)) sourcePaths.push(pluginRootPath);
  const output = await runGit(
    repoRoot,
    ['ls-tree', '-r', '-z', baseCommit, '--', ...sourcePaths],
    { buffer: true, label: 'Git authoring source tree' },
  );
  const records = output.toString('utf8').split('\0').filter(Boolean).map(parseTreeRecord);

  for (const record of records) {
    if (record.type !== 'blob') continue;
    const normalizedPath = path.posix.normalize(record.filePath);
    if (
      normalizedPath !== record.filePath
      || normalizedPath === '..'
      || normalizedPath.startsWith('../')
      || path.posix.isAbsolute(normalizedPath)
    ) {
      throw codedError('gitFailed', `Unsafe Git authoring path: ${JSON.stringify(record.filePath)}.`);
    }
    const targetPath = path.join(outputRoot, ...normalizedPath.split('/'));
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const content = await runGit(repoRoot, ['cat-file', 'blob', record.objectId], {
      buffer: true,
      label: `Git blob ${record.objectId}`,
    });
    if (record.mode === '120000') {
      await fs.symlink(content.toString('utf8'), targetPath);
    } else {
      await fs.writeFile(targetPath, content);
      if (record.mode === '100755') await fs.chmod(targetPath, 0o755);
    }
  }
  return outputRoot;
}

async function lstatOrNull(filePath) {
  return fs.lstat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
}

async function assertRegularFilePath(rootDir, relativePath, label) {
  const rootStat = await lstatOrNull(rootDir);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw codedError('invalidPlugin', `${label} root must be a non-symbolic-link directory.`);
  }
  let currentPath = rootDir;
  const segments = relativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    const stat = await lstatOrNull(currentPath);
    if (!stat) {
      throw codedError('invalidPlugin', `${label} is missing ${JSON.stringify(relativePath)}.`);
    }
    if (stat.isSymbolicLink()) {
      throw codedError('invalidPlugin', `${label} contains a symbolic-link node: ${currentPath}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw codedError('invalidPlugin', `${label} contains a non-directory path node: ${currentPath}`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw codedError('invalidPlugin', `${label} must use a regular file: ${currentPath}`);
    }
  }
  return currentPath;
}

async function assertDirectoryPathChain(boundaryRoot, targetRoot, label) {
  const relative = path.relative(boundaryRoot, targetRoot);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw codedError('invalidPlugin', `${label} source root must stay inside its workspace.`);
  }
  let currentPath = boundaryRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const stat = await lstatOrNull(currentPath);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw codedError('invalidPlugin', `${label} contains a symbolic-link path node: ${currentPath}`);
    }
    if (!stat.isDirectory()) {
      throw codedError('invalidPlugin', `${label} contains a non-directory path node: ${currentPath}`);
    }
  }
}

function calculateCliSourceSetDigest(packageBytes, registryBytes) {
  return `sha256:${crypto.createHash('sha256')
    .update('package.json\0')
    .update(packageBytes)
    .update(`\0${CLI_REGISTRY_RELATIVE_PATH}\0`)
    .update(registryBytes)
    .digest('hex')}`;
}

async function inspectWorkspaceCliSourceSet(cliRoot, label, boundaryRoot) {
  if (boundaryRoot) await assertDirectoryPathChain(boundaryRoot, cliRoot, label);
  const packagePath = path.join(cliRoot, 'package.json');
  const registryPath = path.join(cliRoot, ...CLI_REGISTRY_RELATIVE_PATH.split('/'));
  const [packageStat, registryStat] = await Promise.all([
    lstatOrNull(packagePath),
    lstatOrNull(registryPath),
  ]);
  if (!packageStat && !registryStat) {
    const cliRootStat = await lstatOrNull(cliRoot);
    if (cliRootStat?.isSymbolicLink() || (cliRootStat && !cliRootStat.isDirectory())) {
      throw codedError('invalidPlugin', `${label} @aw/cli source root has an invalid node: ${cliRoot}`);
    }
    return { state: 'none', root: cliRoot };
  }
  if (!packageStat || !registryStat) {
    return { state: 'partial', root: cliRoot };
  }

  await Promise.all([
    assertRegularFilePath(cliRoot, 'package.json', `${label} @aw/cli source set`),
    assertRegularFilePath(
      cliRoot,
      CLI_REGISTRY_RELATIVE_PATH,
      `${label} @aw/cli source set`,
    ),
  ]);
  const [packageBytes, registryBytes] = await Promise.all([
    fs.readFile(packagePath),
    fs.readFile(registryPath),
  ]);
  let packageDocument;
  try {
    packageDocument = JSON.parse(packageBytes.toString('utf8'));
    JSON.parse(registryBytes.toString('utf8'));
  } catch (error) {
    throw codedError('invalidPlugin', `${label} @aw/cli source set contains invalid JSON: ${error.message}`);
  }
  if (typeof packageDocument?.name !== 'string' || packageDocument.name.trim() === '') {
    throw codedError('invalidPlugin', `${label} @aw/cli package name is missing.`);
  }
  parseStrictSemVer(packageDocument.version, `${label} @aw/cli package version`);
  return {
    state: 'complete',
    root: cliRoot,
    packageName: packageDocument.name,
    providerVersion: packageDocument.version,
    digest: calculateCliSourceSetDigest(packageBytes, registryBytes),
  };
}

async function materializeCliSourceSet(source, outputRoot, label) {
  await fs.mkdir(path.join(outputRoot, 'src', 'utils'), { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(source.root, 'package.json'), path.join(outputRoot, 'package.json')),
    fs.copyFile(
      path.join(source.root, ...CLI_REGISTRY_RELATIVE_PATH.split('/')),
      path.join(outputRoot, ...CLI_REGISTRY_RELATIVE_PATH.split('/')),
    ),
  ]);
  const materialized = await inspectWorkspaceCliSourceSet(outputRoot, label);
  if (
    materialized.state !== 'complete'
    || materialized.packageName !== source.packageName
    || materialized.providerVersion !== source.providerVersion
    || materialized.digest !== source.digest
  ) {
    throw codedError('invalidPlugin', `${label} @aw/cli source identity changed during materialization.`);
  }
  return materialized;
}

async function inspectExternalCliProvider(cliPackageRoot) {
  const canonicalRoot = await fs.realpath(cliPackageRoot).catch(() => null);
  if (!canonicalRoot) {
    throw codedError('bundlerUnavailable', 'Plugin version checking cannot resolve the installed CLI package root.');
  }
  const packagePath = await assertRegularFilePath(
    canonicalRoot,
    'package.json',
    'Installed CLI provider',
  );
  const externalRegistryRelativePath = `dist/${CLI_REGISTRY_RELATIVE_PATH}`;
  const registryPath = await assertRegularFilePath(
    canonicalRoot,
    externalRegistryRelativePath,
    'Installed CLI provider',
  );
  const [packageBytes, registryBytes] = await Promise.all([
    fs.readFile(packagePath),
    fs.readFile(registryPath),
  ]);
  let packageDocument;
  try {
    packageDocument = JSON.parse(packageBytes.toString('utf8'));
    JSON.parse(registryBytes.toString('utf8'));
  } catch (error) {
    throw codedError('bundlerUnavailable', `Installed CLI provider contains invalid JSON: ${error.message}`);
  }
  if (packageDocument?.name !== CLI_PACKAGE_NAME) {
    throw codedError('bundlerUnavailable', `Installed CLI provider package name must be ${JSON.stringify(CLI_PACKAGE_NAME)}.`);
  }
  parseStrictSemVer(packageDocument.version, 'installed CLI provider version');
  return {
    root: canonicalRoot,
    packagePath,
    registryPath,
    packageName: packageDocument.name,
    providerVersion: packageDocument.version,
    digest: calculateCliSourceSetDigest(packageBytes, registryBytes),
  };
}

async function materializeExternalCliProvider(provider, outputRoot, label) {
  await fs.mkdir(path.join(outputRoot, 'src', 'utils'), { recursive: true });
  await Promise.all([
    fs.copyFile(provider.packagePath, path.join(outputRoot, 'package.json')),
    fs.copyFile(
      provider.registryPath,
      path.join(outputRoot, ...CLI_REGISTRY_RELATIVE_PATH.split('/')),
    ),
  ]);
  return inspectWorkspaceCliSourceSet(outputRoot, label);
}

async function resolveCliVirtualSourceSets(options) {
  const baseSource = await inspectWorkspaceCliSourceSet(
    path.join(options.baseSourceRoot, 'packages', 'cli'),
    'Git base',
    options.baseSourceRoot,
  );
  const currentSource = await inspectWorkspaceCliSourceSet(
    path.join(options.repoRoot, 'packages', 'cli'),
    'current workspace',
    options.repoRoot,
  );
  if (baseSource.state === 'partial') {
    throw codedError('invalidPlugin', 'Git base contains an incomplete @aw/cli virtual authoring source set.');
  }
  if (currentSource.state === 'partial') {
    throw codedError('invalidPlugin', 'Found an incomplete current workspace @aw/cli source set.');
  }
  if (baseSource.state !== currentSource.state) {
    throw codedError(
      'invalidPlugin',
      'Git base and current workspace CLI source ownership differs; version checking cannot mix workspace and external providers.',
    );
  }
  if (baseSource.state === 'complete') {
    const currentMaterialized = await materializeCliSourceSet(
      currentSource,
      path.join(options.tempRoot, 'current-cli-workspace'),
      'current workspace materialization',
    );
    return {
      base: baseSource,
      current: currentMaterialized,
    };
  }

  const externalProvider = await inspectExternalCliProvider(options.cliPackageRoot);
  const [baseExternal, currentExternal] = await Promise.all([
    materializeExternalCliProvider(
      externalProvider,
      path.join(options.tempRoot, 'base-cli-external'),
      'base external CLI provider',
    ),
    materializeExternalCliProvider(
      externalProvider,
      path.join(options.tempRoot, 'current-cli-external'),
      'current external CLI provider',
    ),
  ]);
  for (const materialized of [baseExternal, currentExternal]) {
    if (
      materialized.state !== 'complete'
      || materialized.packageName !== externalProvider.packageName
      || materialized.providerVersion !== externalProvider.providerVersion
      || materialized.digest !== externalProvider.digest
    ) {
      throw codedError('invalidPlugin', 'External CLI provider identity changed during independent materialization.');
    }
  }
  if (baseExternal.root === currentExternal.root || baseExternal.digest !== currentExternal.digest) {
    throw codedError('invalidPlugin', 'External CLI provider materializations are not independent and identical.');
  }
  return { base: baseExternal, current: currentExternal };
}

async function readManifestDocument(pluginRoot) {
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw codedError('invalidPlugin', `Cannot read ${manifestPath}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw codedError('invalidPlugin', `${manifestPath} must contain a JSON object.`);
  }
  return { manifestPath, manifest };
}

async function hashBundleEntries(rootDir) {
  const entries = new Map();
  async function visit(currentDir, prefix = '') {
    const children = await fs.readdir(currentDir, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const absolutePath = path.join(currentDir, child.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (stat.isSymbolicLink()) {
        entries.set(relativePath, `symlink:${await fs.readlink(absolutePath)}`);
      } else {
        const digest = crypto.createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex');
        entries.set(relativePath, `sha256:${digest}`);
      }
    }
  }
  await visit(rootDir);
  return entries;
}

function compareBundleEntries(baseEntries, currentEntries) {
  const paths = new Set([...baseEntries.keys(), ...currentEntries.keys()]);
  return [...paths]
    .filter((filePath) => baseEntries.get(filePath) !== currentEntries.get(filePath))
    .sort();
}

async function bundlePlugin(
  bundler,
  sourceSetRoot,
  cliVirtualExportRoot,
  cliProviderVersion,
  pluginRoot,
  outputRoot,
  runtimeSkillClosureValidation = 'current',
) {
  const sourceSetPlugins = await bundler.discoverPlugins(sourceSetRoot);
  const plugin = await bundler.readPluginManifest(pluginRoot);
  if (!sourceSetPlugins.some((candidate) => candidate.manifest.name === plugin.manifest.name)) {
    sourceSetPlugins.push(plugin);
  }
  const runtimeResolver = bundler.createRuntimeResolver(sourceSetPlugins, {
    cliVirtualExportRoot,
    cliProviderVersion,
  });
  await bundler.bundleLocalPlugin(plugin, outputRoot, {
    buildMode: 'staging',
    runtimeResolver,
    runtimeSkillClosureValidation,
  });
  return {
    digest: await bundler.calculateArtifactDigest(outputRoot),
    entries: await hashBundleEntries(outputRoot),
  };
}

function createCheckResult(pluginName, values = {}) {
  return {
    plugin: pluginName,
    ok: values.ok ?? true,
    status: values.status ?? 'unchanged',
    baseVersion: values.baseVersion ?? null,
    currentVersion: values.currentVersion ?? null,
    baseTarget: values.baseTarget ?? values.baseVersion ?? null,
    currentTarget: values.currentTarget ?? values.currentVersion ?? null,
    productionChanged: values.productionChanged ?? null,
    baseDigest: values.baseDigest ?? null,
    currentDigest: values.currentDigest ?? null,
    changedPaths: values.changedPaths ?? [],
    warnings: values.warnings ?? [],
    errors: values.errors ?? [],
  };
}

async function checkOnePlugin(options) {
  const {
    repoRoot,
    pluginName,
    bundler,
    tempRoot,
    baseSourceRoot,
    cliVirtualSources,
    currentRoot,
    baseRoot,
  } = options;
  if (!PLUGIN_NAME_PATTERN.test(pluginName)) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      errors: [`Invalid plugin name ${JSON.stringify(pluginName)}.`],
    });
  }
  const currentExists = await fs.stat(currentRoot).then((stat) => stat.isDirectory(), () => false);
  if (!currentExists && !baseRoot) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      errors: [`Plugin ${JSON.stringify(pluginName)} does not exist in the base or working tree.`],
    });
  }
  if (!currentExists) {
    return createCheckResult(pluginName, { status: 'deleted' });
  }

  let currentDocument;
  try {
    currentDocument = await readManifestDocument(currentRoot);
    if (currentDocument.manifest.name !== pluginName) {
      throw codedError(
        'invalidPlugin',
        `Current manifest name ${JSON.stringify(currentDocument.manifest.name)} does not match ${JSON.stringify(pluginName)}.`,
      );
    }
    parseStablePluginVersion(currentDocument.manifest.version, 'current plugin version');
  } catch (error) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      errors: [error.message],
    });
  }
  if (!baseRoot) {
    let currentBundle;
    try {
      currentBundle = await bundlePlugin(
        bundler,
        repoRoot,
        cliVirtualSources.current.root,
        cliVirtualSources.current.providerVersion,
        currentRoot,
        path.join(tempRoot, 'bundles', pluginName, 'current'),
      );
    } catch (error) {
      return createCheckResult(pluginName, {
        ok: false,
        status: 'error',
        currentVersion: currentDocument.manifest.version,
        errors: [`Production bundle failed: current: ${error.message}`],
      });
    }
    return createCheckResult(pluginName, {
      status: 'new',
      currentVersion: currentDocument.manifest.version,
      productionChanged: true,
      currentDigest: currentBundle.digest,
      changedPaths: [...currentBundle.entries.keys()].sort(),
    });
  }

  let baseDocument;
  try {
    baseDocument = await readManifestDocument(baseRoot);
    if (baseDocument.manifest.name !== pluginName) {
      throw codedError(
        'invalidPlugin',
        `Base manifest name ${JSON.stringify(baseDocument.manifest.name)} does not match ${JSON.stringify(pluginName)}.`,
      );
    }
    parseStablePluginVersion(baseDocument.manifest.version, 'base plugin version');
  } catch (error) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      currentVersion: currentDocument.manifest.version,
      errors: [error.message],
    });
  }

  const baseVersion = baseDocument.manifest.version;
  const currentVersion = currentDocument.manifest.version;
  const precedence = compareStrictSemVer(currentVersion, baseVersion);
  baseDocument.manifest.version = currentVersion;
  await fs.writeFile(
    baseDocument.manifestPath,
    `${JSON.stringify(baseDocument.manifest, null, 2)}\n`,
    'utf8',
  );

  let baseBundle;
  let currentBundle;
  let bundleResults;
  try {
    bundleResults = await Promise.allSettled([
      bundlePlugin(
        bundler,
        baseSourceRoot,
        cliVirtualSources.base.root,
        cliVirtualSources.base.providerVersion,
        baseRoot,
        path.join(tempRoot, 'bundles', pluginName, 'base'),
        'historical',
      ),
      bundlePlugin(
        bundler,
        repoRoot,
        cliVirtualSources.current.root,
        cliVirtualSources.current.providerVersion,
        currentRoot,
        path.join(tempRoot, 'bundles', pluginName, 'current'),
      ),
    ]);
  } finally {
    baseDocument.manifest.version = baseVersion;
    await fs.writeFile(
      baseDocument.manifestPath,
      `${JSON.stringify(baseDocument.manifest, null, 2)}\n`,
      'utf8',
    );
  }
  const bundleFailures = bundleResults
    .map((result, index) => result.status === 'rejected'
      ? `${index === 0 ? 'base' : 'current'}: ${result.reason?.message ?? String(result.reason)}`
      : null)
    .filter(Boolean);
  if (bundleFailures.length > 0) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      baseVersion,
      currentVersion,
      errors: [
        `Production bundle failed: ${bundleFailures[0]}`,
        ...bundleFailures.slice(1).map((failure) => `Secondary bundle failure: ${failure}`),
      ],
    });
  }
  [baseBundle, currentBundle] = bundleResults.map((result) => result.value);
  const changedPaths = compareBundleEntries(baseBundle.entries, currentBundle.entries);
  const productionChanged = baseBundle.digest !== currentBundle.digest;
  const common = {
    baseVersion,
    currentVersion,
    productionChanged,
    baseDigest: baseBundle.digest,
    currentDigest: currentBundle.digest,
    changedPaths,
  };

  if (precedence < 0) {
    return createCheckResult(pluginName, {
      ...common,
      ok: false,
      status: 'versionDowngrade',
      errors: [`Plugin version decreased from ${baseVersion} to ${currentVersion}.`],
    });
  }
  if (precedence === 0 && currentVersion !== baseVersion) {
    return createCheckResult(pluginName, {
      ...common,
      ok: false,
      status: 'nonIncreasingVersion',
      errors: [
        `Plugin version changed from ${baseVersion} to ${currentVersion} without higher SemVer precedence.`,
      ],
    });
  }
  if (productionChanged && precedence === 0) {
    return createCheckResult(pluginName, {
      ...common,
      status: 'unreleasedChanges',
      warnings: [
        `Production bundle changed while the current stable target remains ${currentVersion}; the release target may need adjustment before publishing.`,
      ],
    });
  }
  if (!productionChanged && precedence > 0) {
    return createCheckResult(pluginName, {
      ...common,
      status: 'versionOnly',
      warnings: [`Plugin version increased from ${baseVersion} to ${currentVersion}, but the production bundle is unchanged.`],
    });
  }
  return createCheckResult(pluginName, {
    ...common,
    status: productionChanged ? 'versionBumped' : 'unchanged',
  });
}

async function listPluginNames(sourceSetRoot) {
  const entries = await fs.readdir(path.join(sourceSetRoot, 'plugins'), {
    withFileTypes: true,
  }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

export async function checkPluginVersions(options = {}) {
  const requestedRepoRoot = path.resolve(options.repoRoot ?? '.');
  const cliPackageRoot = path.resolve(options.cliPackageRoot ?? CLI_PACKAGE_ROOT);
  const requestedBase = options.base;
  assertAuthoringPluginPathFence({
    repoRoot: requestedRepoRoot,
    pluginRoot: requestedRepoRoot,
  });
  const explicitRoot = options.pluginRoot === undefined
    ? null
    : resolveAuthoringPluginRoot({
        repoRoot: requestedRepoRoot,
        pluginRoot: options.pluginRoot,
        pluginName: options.pluginNames?.[0],
      });
  const repoRoot = explicitRoot?.repoRoot ?? requestedRepoRoot;
  if (requestedBase === undefined) {
    let pluginNames = options.all
      ? (await listPluginNames(repoRoot)).sort()
      : [...new Set(options.pluginNames ?? [])].sort();
    if (explicitRoot) pluginNames = [...new Set(options.pluginNames ?? [])].sort();
    if (pluginNames.length === 0 && !options.all) {
      throw codedError('usage', 'Provide a plugin name or use --all.');
    }
    const checks = [];
    for (const pluginName of pluginNames) {
      const currentRoot = explicitRoot?.pluginRoot ?? path.join(repoRoot, 'plugins', pluginName);
      assertAuthoringPluginPathFence({
        repoRoot,
        pluginRoot: currentRoot,
        requireManifest: true,
      });
      try {
        const document = await readManifestDocument(currentRoot);
        if (document.manifest.name !== pluginName) {
          throw codedError(
            'invalidPlugin',
            `Current manifest name ${JSON.stringify(document.manifest.name)} does not match ${JSON.stringify(pluginName)}.`,
          );
        }
        parseStablePluginVersion(document.manifest.version, 'current plugin version');
        checks.push(createCheckResult(pluginName, {
          status: 'current',
          currentVersion: document.manifest.version,
        }));
      } catch (error) {
        checks.push(createCheckResult(pluginName, {
          ok: false,
          status: 'error',
          errors: [error.message],
        }));
      }
    }
    return {
      schemaVersion: 3,
      policy: 'development',
      ok: checks.every((check) => check.ok),
      base: null,
      requestedBase: null,
      baseCommit: null,
      checkedPlugins: pluginNames.length,
      checks,
    };
  }
  const baseCommit = await resolveBaseCommit(repoRoot, requestedBase);
  const bundler = await loadProductionBundler(cliPackageRoot);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-version-check-'));
  try {
    const baseSourceRoot = path.join(tempRoot, 'base-source');
    await materializeBaseAuthoringSourceSet(
      repoRoot,
      baseCommit,
      baseSourceRoot,
      explicitRoot?.relativePluginRoot,
    );
    let pluginNames;
    if (options.all) {
      const [basePluginNames, currentPluginNames] = await Promise.all([
        listPluginNames(baseSourceRoot),
        listPluginNames(repoRoot),
      ]);
      pluginNames = [...new Set([...basePluginNames, ...currentPluginNames])].sort();
    } else {
      pluginNames = [...new Set(options.pluginNames ?? [])].sort();
    }
    if (pluginNames.length === 0 && !options.all) {
      throw codedError('usage', 'Provide a plugin name or use --all.');
    }
    const currentRoots = new Map();
    for (const pluginName of pluginNames) {
      const currentRoot = explicitRoot?.pluginRoot ?? path.join(repoRoot, 'plugins', pluginName);
      if (await lstatOrNull(currentRoot)) {
        assertAuthoringPluginPathFence({
          repoRoot,
          pluginRoot: currentRoot,
          requireManifest: true,
        });
      }
      currentRoots.set(pluginName, currentRoot);
    }
    const cliVirtualSources = await resolveCliVirtualSourceSets({
      baseSourceRoot,
      repoRoot,
      cliPackageRoot,
      tempRoot,
    });
    const checks = [];
    for (const pluginName of pluginNames) {
      const currentRoot = currentRoots.get(pluginName);
      const candidateBaseRoot = explicitRoot
        ? path.join(baseSourceRoot, ...explicitRoot.relativePluginRoot.split('/'))
        : path.join(baseSourceRoot, 'plugins', pluginName);
      const baseNode = await lstatOrNull(candidateBaseRoot);
      const baseRoot = baseNode ? candidateBaseRoot : null;
      if (baseRoot) {
        assertAuthoringPluginPathFence({
          repoRoot: baseSourceRoot,
          pluginRoot: baseRoot,
          requirePluginRoot: true,
          requireManifest: true,
        });
      }
      checks.push(await checkOnePlugin({
        repoRoot,
        pluginName,
        bundler,
        tempRoot,
        baseSourceRoot,
        cliVirtualSources,
        currentRoot,
        baseRoot,
      }));
    }
    return {
      schemaVersion: 3,
      policy: 'development',
      ok: checks.every((check) => check.ok),
      base: {
        requested: requestedBase,
        commit: baseCommit,
      },
      requestedBase,
      baseCommit,
      checkedPlugins: pluginNames.length,
      checks,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export function formatPluginVersionCheck(result) {
  if (result.checkedPlugins === 0) {
    return result.requestedBase
      ? `[PASS] No plugin source changes relative to ${result.requestedBase}.`
      : '[PASS] No current workspace plugins.';
  }
  const lines = [];
  for (const check of result.checks) {
    lines.push(`${check.ok ? '[PASS]' : '[FAIL]'} ${check.plugin}: ${check.status}`);
    if (check.baseVersion || check.currentVersion) {
      lines.push(`  stable target: ${check.baseTarget ?? '(new)'} -> ${check.currentTarget ?? '(deleted)'}`);
    }
    for (const changedPath of check.changedPaths) lines.push(`  changed: ${changedPath}`);
    for (const warning of check.warnings) lines.push(`  warning: ${warning}`);
    for (const error of check.errors) lines.push(`  error: ${error}`);
  }
  return lines.join('\n');
}
