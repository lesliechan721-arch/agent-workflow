import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { compareStrictSemVer, parseStrictSemVer } from './semver.mjs';
import {
  readPluginReleasePlans,
  resolvePluginReleasePlan,
} from './plugin-release-intents.mjs';

const execFileAsync = promisify(execFile);
const EXPECTED_MANIFEST_CONTRACT_VERSION = 3;
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

async function loadProductionBundler(repoRoot) {
  const manifestModulePath = path.join(
    repoRoot,
    'packages',
    'cli',
    'dist',
    'src',
    'utils',
    'manifest.js',
  );
  const generatorModulePath = path.join(
    repoRoot,
    'packages',
    'cli',
    'dist',
    'src',
    'generators',
    'local-plugin.js',
  );
  const digestModulePath = path.join(
    repoRoot,
    'packages',
    'cli',
    'dist',
    'src',
    'utils',
    'catalog-digests.js',
  );
  const requiredPaths = [manifestModulePath, generatorModulePath, digestModulePath];
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
  try {
    [manifestModule, generatorModule, digestModule] = await Promise.all([
      import(pathToFileURL(manifestModulePath).href),
      import(pathToFileURL(generatorModulePath).href),
      import(pathToFileURL(digestModulePath).href),
    ]);
  } catch (error) {
    throw codedError('bundlerUnavailable', `Failed to load built CLI bundler: ${error.message}`);
  }
  if (
    manifestModule.SOURCE_PLUGIN_MANIFEST_CONTRACT_VERSION
      !== EXPECTED_MANIFEST_CONTRACT_VERSION
    || typeof manifestModule.readPluginManifest !== 'function'
    || typeof generatorModule.bundleLocalPlugin !== 'function'
    || typeof digestModule.calculateCatalogEntryArtifactDigest !== 'function'
  ) {
    throw codedError(
      'bundlerUnavailable',
      'Built CLI authoring contract is incompatible; run `pnpm build` and retry.',
    );
  }
  return {
    readPluginManifest: manifestModule.readPluginManifest,
    bundleLocalPlugin: generatorModule.bundleLocalPlugin,
    calculateArtifactDigest: digestModule.calculateCatalogEntryArtifactDigest,
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

async function materializeBasePlugin(repoRoot, baseCommit, pluginName, outputRoot) {
  const pluginRelativeRoot = `plugins/${pluginName}`;
  const output = await runGit(
    repoRoot,
    ['ls-tree', '-r', '-z', baseCommit, '--', pluginRelativeRoot],
    { buffer: true, label: `Git tree for ${pluginName}` },
  );
  const records = output.toString('utf8').split('\0').filter(Boolean).map(parseTreeRecord);
  if (records.length === 0) return null;

  const pluginRoot = path.join(outputRoot, 'plugins', pluginName);
  for (const record of records) {
    if (record.type !== 'blob') continue;
    const relativePath = path.posix.relative(pluginRelativeRoot, record.filePath);
    if (
      relativePath === ''
      || relativePath === '..'
      || relativePath.startsWith('../')
      || path.posix.isAbsolute(relativePath)
    ) {
      throw codedError('gitFailed', `Unsafe Git plugin path: ${JSON.stringify(record.filePath)}.`);
    }
    const targetPath = path.join(pluginRoot, ...relativePath.split('/'));
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
  return pluginRoot;
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

async function bundlePlugin(bundler, pluginRoot, outputRoot) {
  const plugin = await bundler.readPluginManifest(pluginRoot);
  await bundler.bundleLocalPlugin(plugin, outputRoot, { buildMode: 'staging' });
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
    productionChanged: values.productionChanged ?? null,
    baseDigest: values.baseDigest ?? null,
    currentDigest: values.currentDigest ?? null,
    plannedBump: values.plannedBump ?? null,
    targetVersion: values.targetVersion ?? null,
    releaseIntentFiles: values.releaseIntentFiles ?? [],
    changedPaths: values.changedPaths ?? [],
    warnings: values.warnings ?? [],
    errors: values.errors ?? [],
  };
}

async function checkOnePlugin(options) {
  const {
    repoRoot,
    baseCommit,
    pluginName,
    bundler,
    tempRoot,
    mode,
    releasePlans,
  } = options;
  if (!PLUGIN_NAME_PATTERN.test(pluginName)) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      errors: [`Invalid plugin name ${JSON.stringify(pluginName)}.`],
    });
  }
  const currentRoot = path.join(repoRoot, 'plugins', pluginName);
  const currentExists = await fs.stat(currentRoot).then((stat) => stat.isDirectory(), () => false);
  const baseRoot = await materializeBasePlugin(
    repoRoot,
    baseCommit,
    pluginName,
    path.join(tempRoot, 'base-source'),
  );
  if (!currentExists && !baseRoot) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      errors: [`Plugin ${JSON.stringify(pluginName)} does not exist in the base or working tree.`],
    });
  }
  if (!currentExists) {
    const pendingIntent = releasePlans.get(pluginName);
    if (mode === 'release' && pendingIntent) {
      return createCheckResult(pluginName, {
        ok: false,
        status: 'unappliedReleaseIntent',
        plannedBump: pendingIntent.bump,
        releaseIntentFiles: pendingIntent.files,
        errors: [
          `Plugin ${pluginName} still has release intent files; apply them before a stable release.`,
        ],
      });
    }
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
    parseStrictSemVer(currentDocument.manifest.version, 'current plugin version');
  } catch (error) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      errors: [error.message],
    });
  }
  if (!baseRoot) {
    const pendingIntent = releasePlans.get(pluginName);
    if (pendingIntent) {
      return createCheckResult(pluginName, {
        ok: false,
        status: 'unexpectedReleaseIntent',
        currentVersion: currentDocument.manifest.version,
        productionChanged: true,
        plannedBump: pendingIntent.bump,
        releaseIntentFiles: pendingIntent.files,
        errors: [
          `New plugin ${pluginName} must keep its initial version without release intent files.`,
        ],
      });
    }
    return createCheckResult(pluginName, {
      status: 'new',
      currentVersion: currentDocument.manifest.version,
      productionChanged: true,
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
    parseStrictSemVer(baseDocument.manifest.version, 'base plugin version');
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
  let releasePlan = null;
  try {
    releasePlan = resolvePluginReleasePlan(currentVersion, releasePlans.get(pluginName));
  } catch (error) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'invalidReleaseIntent',
      baseVersion,
      currentVersion,
      errors: [error.message],
    });
  }
  baseDocument.manifest.version = currentVersion;
  await fs.writeFile(
    baseDocument.manifestPath,
    `${JSON.stringify(baseDocument.manifest, null, 2)}\n`,
    'utf8',
  );

  let baseBundle;
  let currentBundle;
  try {
    [baseBundle, currentBundle] = await Promise.all([
      bundlePlugin(bundler, baseRoot, path.join(tempRoot, 'bundles', pluginName, 'base')),
      bundlePlugin(bundler, currentRoot, path.join(tempRoot, 'bundles', pluginName, 'current')),
    ]);
  } catch (error) {
    return createCheckResult(pluginName, {
      ok: false,
      status: 'error',
      baseVersion,
      currentVersion,
      errors: [`Production bundle failed: ${error.message}`],
    });
  }
  const changedPaths = compareBundleEntries(baseBundle.entries, currentBundle.entries);
  const productionChanged = baseBundle.digest !== currentBundle.digest;
  const common = {
    baseVersion,
    currentVersion,
    productionChanged,
    baseDigest: baseBundle.digest,
    currentDigest: currentBundle.digest,
    plannedBump: releasePlan?.bump ?? null,
    targetVersion: releasePlan?.targetVersion ?? null,
    releaseIntentFiles: releasePlan?.files ?? [],
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
  if (mode === 'author') {
    if (productionChanged && precedence === 0 && !releasePlan) {
      return createCheckResult(pluginName, {
        ...common,
        ok: false,
        status: 'missingReleaseIntent',
        errors: [
          `Production bundle changed but plugin ${pluginName} has no release intent.`,
        ],
      });
    }
    if (productionChanged && precedence === 0) {
      return createCheckResult(pluginName, {
        ...common,
        status: 'releasePlanned',
      });
    }
    if (!productionChanged && releasePlan) {
      return createCheckResult(pluginName, {
        ...common,
        status: 'intentOnly',
        warnings: [
          `Plugin ${pluginName} has a release intent, but its production bundle is unchanged.`,
        ],
      });
    }
  }
  if (mode === 'release' && releasePlan) {
    return createCheckResult(pluginName, {
      ...common,
      ok: false,
      status: 'unappliedReleaseIntent',
      errors: [
        `Plugin ${pluginName} still has release intent files; apply them before a stable release.`,
      ],
    });
  }
  if (productionChanged && precedence === 0) {
    return createCheckResult(pluginName, {
      ...common,
      ok: false,
      status: 'missingVersionBump',
      errors: [
        `Production bundle changed but plugin version remains ${currentVersion}.`,
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

function pluginNamesFromPaths(paths) {
  const names = new Set();
  for (const filePath of paths) {
    const normalized = filePath.split(path.sep).join('/');
    const match = normalized.match(/^plugins\/([^/]+)\//);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

async function listChangedPluginNames(repoRoot, baseCommit) {
  const [tracked, untracked] = await Promise.all([
    runGit(repoRoot, ['diff', '--name-only', '-z', baseCommit, '--', 'plugins'], {
      buffer: true,
      label: 'Git plugin diff',
    }),
    runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', 'plugins'], {
      buffer: true,
      label: 'Git untracked plugin scan',
    }),
  ]);
  const paths = `${tracked.toString('utf8')}\0${untracked.toString('utf8')}`
    .split('\0')
    .filter(Boolean);
  return pluginNamesFromPaths(paths);
}

export async function checkPluginVersions(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? '.');
  const requestedBase = options.base ?? 'HEAD';
  const mode = options.mode ?? 'author';
  if (mode !== 'author' && mode !== 'release') {
    throw codedError('usage', 'Plugin version check mode must be "author" or "release".');
  }
  const baseCommit = await resolveBaseCommit(repoRoot, requestedBase);
  const [bundler, releasePlans] = await Promise.all([
    loadProductionBundler(repoRoot),
    readPluginReleasePlans(repoRoot),
  ]);
  const pluginNames = options.all
    ? [...new Set([
      ...await listChangedPluginNames(repoRoot, baseCommit),
      ...(mode === 'release' ? releasePlans.keys() : []),
    ])].sort()
    : [...new Set(options.pluginNames ?? [])].sort();
  if (pluginNames.length === 0 && !options.all) {
    throw codedError('usage', 'Provide a plugin name or use --all.');
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-version-check-'));
  try {
    const checks = [];
    for (const pluginName of pluginNames) {
      checks.push(await checkOnePlugin({
        repoRoot,
        baseCommit,
        pluginName,
        bundler,
        tempRoot,
        mode,
        releasePlans,
      }));
    }
    return {
      schemaVersion: 1,
      ok: checks.every((check) => check.ok),
      mode,
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
    return `[PASS] No plugin source changes relative to ${result.requestedBase}.`;
  }
  const lines = [];
  for (const check of result.checks) {
    lines.push(`${check.ok ? '[PASS]' : '[FAIL]'} ${check.plugin}: ${check.status}`);
    if (check.baseVersion || check.currentVersion) {
      lines.push(`  version: ${check.baseVersion ?? '(new)'} -> ${check.currentVersion ?? '(deleted)'}`);
    }
    if (check.targetVersion) {
      lines.push(`  planned: ${check.plannedBump} -> ${check.targetVersion}`);
    }
    for (const changedPath of check.changedPaths) lines.push(`  changed: ${changedPath}`);
    for (const warning of check.warnings) lines.push(`  warning: ${warning}`);
    for (const error of check.errors) lines.push(`  error: ${error}`);
  }
  return lines.join('\n');
}
