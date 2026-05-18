import path from 'node:path';
import fs from 'node:fs/promises';

import {
  assertVersionKind,
  loadCatalogModules,
  publishCatalogRelease,
  readCliPackageJson,
  relativeToRepo,
  runCommand,
} from './common.mjs';

const SIDE_CAR_PACKAGE_NAME = '@yiliang/aw-plugins-manifest';
const FULL_PACKAGE_NAME = '@yiliang/aw-plugins';

function parseArgs(argv) {
  const args = [...argv];
  const mode = args.shift();
  let catalogVersion;

  while (args[0] === '--') {
    args.shift();
  }

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--catalog-version') {
      catalogVersion = args.shift();
      continue;
    }
    throw new Error(
      `Unknown argument "${token}". Usage: node scripts/release/publish-catalog.mjs <beta|latest> --catalog-version <version>`,
    );
  }

  if (mode !== 'beta' && mode !== 'latest') {
    throw new Error('Missing publish mode. Use "beta" or "latest".');
  }
  if (!catalogVersion) {
    throw new Error(
      'Missing catalog version. Usage: node scripts/release/publish-catalog.mjs <beta|latest> --catalog-version <version>',
    );
  }

  return {
    mode,
    catalogVersion,
  };
}

async function resolveRegistryUrl() {
  const fromEnv = process.env.AW_NPM_REGISTRY_URL || process.env.npm_config_registry;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }

  const cliPackageJson = await readCliPackageJson();
  if (typeof cliPackageJson.publishConfig?.registry === 'string' && cliPackageJson.publishConfig.registry.trim() !== '') {
    return cliPackageJson.publishConfig.registry.trim();
  }

  return 'https://registry.npmjs.org/';
}

function isMissingRegistryPackageError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('HTTP 404')
    || message.includes('missing dist-tag')
    || message.includes('is missing dist.integrity or dist.tarball')
  );
}

async function listFilesRecursively(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(entryPath);
      files.push(...nested.map((filePath) => path.join(entry.name, filePath).split(path.sep).join('/')));
      continue;
    }
    files.push(entry.name);
  }
  return files.sort();
}

async function comparePackageDirectories(expectedRoot, actualRoot) {
  const [expectedFiles, actualFiles] = await Promise.all([
    listFilesRecursively(expectedRoot),
    listFilesRecursively(actualRoot),
  ]);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    return {
      ok: false,
      reason: `File list mismatch.\nexpected=${expectedFiles.join(', ')}\nactual=${actualFiles.join(', ')}`,
    };
  }

  for (const relativePath of expectedFiles) {
    const [expectedBuffer, actualBuffer] = await Promise.all([
      fs.readFile(path.join(expectedRoot, relativePath)),
      fs.readFile(path.join(actualRoot, relativePath)),
    ]);
    if (!expectedBuffer.equals(actualBuffer)) {
      return {
        ok: false,
        reason: `File content mismatch at ${relativePath}.`,
      };
    }
  }

  return {
    ok: true,
  };
}

function packageNameForKind(kind) {
  if (kind === 'full') {
    return FULL_PACKAGE_NAME;
  }
  return SIDE_CAR_PACKAGE_NAME;
}

async function createRegistryAdapter() {
  const registryUrl = await resolveRegistryUrl();
  const { marketplace } = await loadCatalogModules();

  return {
    async readChannelManifest(channel) {
      try {
        const archive = await marketplace.resolveCatalogPackageByDistTag(
          SIDE_CAR_PACKAGE_NAME,
          channel,
          process.env,
        );
        try {
          return {
            status: 'ready',
            manifest: archive.rawManifest,
          };
        } finally {
          await archive.dispose();
        }
      } catch (error) {
        if (isMissingRegistryPackageError(error)) {
          return {
            status: 'missing',
          };
        }
        return {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async verifyExistingPackage(kind, context) {
      const packageName = packageNameForKind(kind);
      try {
        const identity = await marketplace.resolveCatalogPackageIdentityByVersion(
          packageName,
          context.version,
          process.env,
        );
        const archive = await marketplace.downloadCatalogPackageArchive(identity, process.env);
        try {
          const comparison = await comparePackageDirectories(context.packageRoot, archive.packageRoot);
          return comparison.ok
            ? { exists: true, verified: true }
            : { exists: true, verified: false, reason: comparison.reason };
        } finally {
          await archive.dispose();
        }
      } catch (error) {
        if (isMissingRegistryPackageError(error)) {
          return { exists: false, verified: false };
        }
        throw error;
      }
    },
    async publishPackage(_kind, context) {
      await runCommand('pnpm', ['publish', '--tag', context.channel], {
        cwd: context.packageRoot,
      });
    },
    async ensureDistTag(kind, context) {
      await runCommand('npm', [
        'dist-tag',
        'add',
        `${packageNameForKind(kind)}@${context.version}`,
        context.channel,
        '--registry',
        registryUrl,
      ]);
    },
  };
}

try {
  const { mode, catalogVersion } = parseArgs(process.argv.slice(2));
  assertVersionKind(catalogVersion, mode === 'beta' ? 'prerelease' : 'stable');

  await runCommand('pnpm', ['run', 'release:verify:catalog']);
  const registry = await createRegistryAdapter();
  const staged = await publishCatalogRelease({
    channel: mode,
    catalogVersion,
    registry,
  });

  console.log(
    `Published catalog ${staged.manifest.catalogVersion} to ${mode} (${SIDE_CAR_PACKAGE_NAME}, ${FULL_PACKAGE_NAME}).`,
  );
  console.log(
    `  sidecar: ${relativeToRepo(path.join(staged.sidecarPackageRoot, 'package.json'))}`,
  );
  console.log(
    `  full: ${relativeToRepo(path.join(staged.fullPackageRoot, 'package.json'))}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
