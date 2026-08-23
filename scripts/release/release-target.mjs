import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  calculateCanonicalDigest,
  normalizeStableTargetVersion,
} from './release-model.mjs';
import { repoRoot as defaultRepoRoot, runReleaseGit } from './common.mjs';

const BUMPS = new Set(['major', 'minor', 'patch']);
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }
  return value;
}

function assertKeys(value, fieldName, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`Invalid ${fieldName}: unknown field "${key}".`);
  }
}

async function assertRegularPathChain(repoRoot, relativePath) {
  const parts = relativePath.split('/');
  let current = repoRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink() || (index === parts.length - 1 ? !stats.isFile() : !stats.isDirectory())) {
      throw new Error(`Release target path must be a regular path: ${relativePath}.`);
    }
  }
  return current;
}

export function serializeVersionTargets(targets) {
  return `${JSON.stringify({
    schemaVersion: targets.schemaVersion,
    cli: targets.cli,
    catalog: targets.catalog,
  }, null, 2)}\n`;
}

export function normalizeVersionTargets(raw) {
  const value = assertObject(raw, 'release version targets');
  assertKeys(value, 'release version targets', ['schemaVersion', 'cli', 'catalog']);
  if (value.schemaVersion !== 1) {
    throw new Error('Invalid release version targets.schemaVersion: expected 1.');
  }
  return {
    schemaVersion: 1,
    cli: normalizeStableTargetVersion(value.cli, 'release version targets.cli'),
    catalog: normalizeStableTargetVersion(value.catalog, 'release version targets.catalog'),
  };
}

export async function readVersionTargets(repoRoot = defaultRepoRoot) {
  const targetPath = await assertRegularPathChain(repoRoot, 'release/version-targets.json');
  const contents = await fs.readFile(targetPath, 'utf8');
  let raw;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    throw new Error('Release version targets are not valid JSON.', { cause: error });
  }
  const targets = normalizeVersionTargets(raw);
  if (contents !== serializeVersionTargets(targets)) {
    throw new Error('Release version targets must use canonical JSON formatting.');
  }
  return targets;
}

export async function assertVersionTargetsMatchHead(repoRoot = defaultRepoRoot, options = {}) {
  const relativePath = 'release/version-targets.json';
  const targetPath = await assertRegularPathChain(repoRoot, relativePath);
  const [worktreeBytes, headResult] = await Promise.all([
    fs.readFile(targetPath),
    (options.runGit ?? runReleaseGit)(['show', `HEAD:${relativePath}`], { cwd: repoRoot }),
  ]);
  if (!worktreeBytes.equals(Buffer.from(headResult.stdout))) {
    throw new Error('Release version targets bytes do not match source HEAD.');
  }
}

export function bumpStableVersion(version, bump) {
  normalizeStableTargetVersion(version);
  if (!BUMPS.has(bump)) throw new Error(`Invalid release bump "${bump}".`);
  const [major, minor, patch] = version.split('.').map(BigInt);
  if (bump === 'major') return `${major + 1n}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1n}.0`;
  return `${major}.${minor}.${patch + 1n}`;
}

export function parseTargetArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  const changes = { cli: null, catalog: null, plugins: new Map() };
  while (args.length > 0) {
    const token = args.shift();
    if (token === '--cli' || token === '--catalog') {
      const axis = token.slice(2);
      if (changes[axis] !== null) throw new Error(`Duplicate release target axis ${token}.`);
      const bump = args.shift();
      if (!BUMPS.has(bump)) throw new Error(`${token} requires major, minor, or patch.`);
      changes[axis] = bump;
      continue;
    }
    if (token === '--plugin') {
      const value = args.shift();
      const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)=(major|minor|patch)$/.exec(value ?? '');
      if (!match) {
        throw new Error('--plugin requires <name>=<bump>; bump must be major, minor, or patch.');
      }
      if (changes.plugins.has(match[1])) {
        throw new Error(`Duplicate release target axis --plugin ${match[1]}.`);
      }
      changes.plugins.set(match[1], match[2]);
      continue;
    }
    throw new Error(`Unknown release target argument ${JSON.stringify(token)}.`);
  }
  if (changes.cli === null && changes.catalog === null && changes.plugins.size === 0) {
    throw new Error('Release target requires at least one version bump.');
  }
  return changes;
}

async function readPluginManifest(repoRoot, name) {
  if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name "${name}".`);
  const relativePath = `plugins/${name}/.agents-plugin/plugin.json`;
  let manifestPath;
  let contents;
  try {
    manifestPath = await assertRegularPathChain(repoRoot, relativePath);
    contents = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Unknown plugin "${name}".`);
    throw error;
  }
  const manifest = assertObject(JSON.parse(contents), `${name} plugin manifest`);
  if (manifest.name !== name) throw new Error(`Plugin manifest name does not match "${name}".`);
  normalizeStableTargetVersion(manifest.version, `${name} plugin version`);
  return { manifestPath, manifest, mode: (await fs.stat(manifestPath)).mode & 0o777 };
}

async function readCliPackage(repoRoot, relativePath, expectedName) {
  const packagePath = await assertRegularPathChain(repoRoot, relativePath);
  const contents = await fs.readFile(packagePath, 'utf8');
  let manifest;
  try {
    manifest = assertObject(JSON.parse(contents), `${expectedName} package manifest`);
  } catch (error) {
    throw new Error(`Invalid ${relativePath}.`, { cause: error });
  }
  if (manifest.name !== expectedName) {
    throw new Error(`${relativePath} must declare package name ${expectedName}.`);
  }
  const version = normalizeStableTargetVersion(manifest.version, `${relativePath} version`);
  return {
    packagePath,
    manifest,
    name: expectedName,
    version,
    mode: (await fs.stat(packagePath)).mode & 0o777,
  };
}

async function writeAtomically(changes, fileSystem = fs) {
  const staged = [];
  const replaced = [];
  try {
    for (const change of changes) {
      const temporaryPath = `${change.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fileSystem.writeFile(temporaryPath, change.contents, {
        encoding: 'utf8',
        mode: change.mode,
        flag: 'wx',
      });
      staged.push({ ...change, temporaryPath });
    }
    for (const change of staged) {
      const backupPath = `${change.path}.${process.pid}.${crypto.randomUUID()}.bak`;
      await fileSystem.rename(change.path, backupPath);
      try {
        await fileSystem.rename(change.temporaryPath, change.path);
      } catch (error) {
        await fileSystem.rename(backupPath, change.path);
        throw error;
      }
      replaced.push({ ...change, backupPath });
    }
    await Promise.all(replaced.map((entry) =>
      fileSystem.rm(entry.backupPath, { force: true }).catch(() => undefined)));
  } catch (error) {
    for (const entry of replaced.toReversed()) {
      await fileSystem.rm(entry.path, { force: true }).catch(() => undefined);
      await fileSystem.rename(entry.backupPath, entry.path).catch(() => undefined);
    }
    throw error;
  } finally {
    await Promise.all(staged.map((entry) => fileSystem.rm(entry.temporaryPath, { force: true })));
  }
}

export async function updateReleaseTargets(argv, options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const requested = parseTargetArgs(argv);
  const current = await readVersionTargets(repoRoot);
  const cliPackages = requested.cli ? await Promise.all([
    readCliPackage(repoRoot, 'packages/cli/package.json', '@lesliechan721/aw'),
    readCliPackage(
      repoRoot,
      'packages/agent-skill-eval/package.json',
      '@lesliechan721/agent-skill-eval',
    ),
  ]) : [];
  if (requested.cli && cliPackages.some((entry) => entry.version !== current.cli)) {
    throw new Error(
      `CLI release target ${current.cli} must match packages/cli/package.json and ` +
      'packages/agent-skill-eval/package.json before release:target can update it.',
    );
  }
  if (
    requested.cli
    && cliPackages[0].manifest.dependencies?.['@lesliechan721/agent-skill-eval']
      !== `workspace:${current.cli}`
  ) {
    throw new Error(
      `packages/cli/package.json must exactly depend on ` +
      `@lesliechan721/agent-skill-eval@workspace:${current.cli}.`,
    );
  }
  const next = {
    ...current,
    cli: requested.cli ? bumpStableVersion(current.cli, requested.cli) : current.cli,
    catalog: requested.catalog ? bumpStableVersion(current.catalog, requested.catalog) : current.catalog,
  };
  const pluginChanges = await Promise.all([...requested.plugins].map(async ([name, bump]) => {
    const plugin = await readPluginManifest(repoRoot, name);
    const version = bumpStableVersion(plugin.manifest.version, bump);
    return {
      name,
      version,
      path: plugin.manifestPath,
      contents: `${JSON.stringify({ ...plugin.manifest, version }, null, 2)}\n`,
      mode: plugin.mode,
    };
  }));
  const changes = [];
  if (requested.cli || requested.catalog) {
    const targetsPath = path.join(repoRoot, 'release', 'version-targets.json');
    changes.push({
      path: targetsPath,
      contents: serializeVersionTargets(next),
      mode: (await fs.stat(targetsPath)).mode & 0o777,
    });
  }
  if (requested.cli) {
    for (const entry of cliPackages) {
      const manifest = entry.name === '@lesliechan721/aw'
        ? {
            ...entry.manifest,
            version: next.cli,
            dependencies: {
              ...entry.manifest.dependencies,
              '@lesliechan721/agent-skill-eval': `workspace:${next.cli}`,
            },
          }
        : { ...entry.manifest, version: next.cli };
      changes.push({
        path: entry.packagePath,
        contents: `${JSON.stringify(manifest, null, 2)}\n`,
        mode: entry.mode,
      });
    }
    const lockPath = await assertRegularPathChain(repoRoot, 'pnpm-lock.yaml');
    const lockContents = await fs.readFile(lockPath, 'utf8');
    const currentSpecifier = `specifier: workspace:${current.cli}`;
    if (lockContents.split(currentSpecifier).length !== 2) {
      throw new Error(`pnpm-lock.yaml must contain one exact ${currentSpecifier} entry.`);
    }
    changes.push({
      path: lockPath,
      contents: lockContents.replace(currentSpecifier, `specifier: workspace:${next.cli}`),
      mode: (await fs.stat(lockPath)).mode & 0o777,
    });
  }
  changes.push(...pluginChanges);
  await (options.writeAtomically ?? writeAtomically)(changes, options.fileSystem);
  return {
    targets: next,
    plugins: pluginChanges.map(({ name, version }) => ({ name, version })),
    targetsDigest: calculateCanonicalDigest(next),
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await updateReleaseTargets(argv);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
