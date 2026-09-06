import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureCommand,
  computePackageTarballTreeDigest,
  relativeToRepo,
  runCommand,
} from './common.mjs';
import { packCliBundle } from './pack-cli.mjs';

const usage = 'node scripts/release/install-local-tarball.mjs [<cli-tarball> <eval-tarball> <core-tarball> <windows-x64-tarball> <windows-arm64-tarball>]';
const cliPackageName = '@lesliechan721/aw';
const evalPackageName = '@lesliechan721/agent-skill-eval';
const corePackageName = '@lesliechan721/aw-plugin-core';
const windowsX64PackageName = '@lesliechan721/aw-windows-job-win32-x64';
const windowsArm64PackageName = '@lesliechan721/aw-windows-job-win32-arm64';

export function parseArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length > 5) throw new Error(`Too many arguments. Usage: ${usage}`);
  return {
    cliTarballArg: args[0],
    evalTarballArg: args[1],
    coreTarballArg: args[2],
    windowsX64TarballArg: args[3],
    windowsArm64TarballArg: args[4],
  };
}

async function readTarballPackageJson(tarballPath, options = {}) {
  await (options.validateTarball ?? computePackageTarballTreeDigest)(tarballPath);
  let stdout;
  try {
    ({ stdout } = await (options.captureCommand ?? captureCommand)(
      'tar',
      ['-xOf', tarballPath, 'package/package.json'],
    ));
  } catch (error) {
    throw new Error(`Package tarball ${tarballPath} is missing package/package.json.`, {
      cause: error,
    });
  }

  let packageJson;
  try {
    packageJson = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Package tarball ${tarballPath} has an invalid package/package.json.`, {
      cause: error,
    });
  }
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new Error(`Package tarball ${tarballPath} has an invalid package/package.json.`);
  }
  return packageJson;
}

export async function validateLocalTarballBundle(bundle, options = {}) {
  const readPackageJson = options.readPackageJson ?? readTarballPackageJson;
  const [
    cliPackageJson,
    evalPackageJson,
    corePackageJson,
    windowsX64PackageJson,
    windowsArm64PackageJson,
  ] = await Promise.all([
    readPackageJson(bundle.cliTarballPath, options),
    readPackageJson(bundle.evalTarballPath, options),
    readPackageJson(bundle.coreTarballPath, options),
    readPackageJson(bundle.windowsX64TarballPath, options),
    readPackageJson(bundle.windowsArm64TarballPath, options),
  ]);

  if (cliPackageJson.name !== cliPackageName) {
    throw new Error(`CLI tarball must contain package ${cliPackageName}.`);
  }
  if (evalPackageJson.name !== evalPackageName) {
    throw new Error(`Shared Eval tarball must contain package ${evalPackageName}.`);
  }
  if (corePackageJson.name !== corePackageName) {
    throw new Error(`Plugin core tarball must contain package ${corePackageName}.`);
  }
  if (windowsX64PackageJson.name !== windowsX64PackageName) {
    throw new Error(`Windows Job x64 tarball must contain package ${windowsX64PackageName}.`);
  }
  if (windowsArm64PackageJson.name !== windowsArm64PackageName) {
    throw new Error(`Windows Job arm64 tarball must contain package ${windowsArm64PackageName}.`);
  }
  if (
    typeof cliPackageJson.version !== 'string'
    || cliPackageJson.version === ''
    || cliPackageJson.version !== evalPackageJson.version
    || cliPackageJson.version !== corePackageJson.version
    || cliPackageJson.version !== windowsX64PackageJson.version
    || cliPackageJson.version !== windowsArm64PackageJson.version
  ) {
    throw new Error('All five CLI release tarballs must have the same package version.');
  }
  if (cliPackageJson.dependencies?.[evalPackageName] !== cliPackageJson.version) {
    throw new Error(
      `CLI tarball must depend on ${evalPackageName} at its exact package version ` +
      `${JSON.stringify(cliPackageJson.version)}.`,
    );
  }
  if (cliPackageJson.dependencies?.[corePackageName] !== cliPackageJson.version) {
    throw new Error(
      `CLI tarball must depend on ${corePackageName} at its exact package version ` +
      `${JSON.stringify(cliPackageJson.version)}.`,
    );
  }
  if (evalPackageJson.optionalDependencies?.[windowsX64PackageName] !== cliPackageJson.version) {
    throw new Error(
      `Shared Eval tarball must optionally depend on ${windowsX64PackageName} at its exact package version.`,
    );
  }
  if (evalPackageJson.optionalDependencies?.[windowsArm64PackageName] !== cliPackageJson.version) {
    throw new Error(
      `Shared Eval tarball must optionally depend on ${windowsArm64PackageName} at its exact package version.`,
    );
  }
  return bundle;
}

export async function installLocalTarball(cliTarballArg, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const evalTarballArg = options.evalTarballArg;
  const coreTarballArg = options.coreTarballArg;
  const windowsX64TarballArg = options.windowsX64TarballArg;
  const windowsArm64TarballArg = options.windowsArm64TarballArg;
  let bundle;

  if (cliTarballArg || evalTarballArg || coreTarballArg || windowsX64TarballArg || windowsArm64TarballArg) {
    if (!cliTarballArg || !evalTarballArg || !coreTarballArg || !windowsX64TarballArg || !windowsArm64TarballArg) {
      throw new Error(
        `Local CLI installation requires all five release tarballs. Usage: ${usage}`,
      );
    }
    bundle = {
      cliTarballPath: path.resolve(cwd, cliTarballArg),
      evalTarballPath: path.resolve(cwd, evalTarballArg),
      coreTarballPath: path.resolve(cwd, coreTarballArg),
      windowsX64TarballPath: path.resolve(cwd, windowsX64TarballArg),
      windowsArm64TarballPath: path.resolve(cwd, windowsArm64TarballArg),
    };
  } else {
    bundle = await (options.packCliBundle ?? packCliBundle)();
  }

  await (options.validateBundle ?? validateLocalTarballBundle)(bundle, options);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  let platformTarballs = [];
  if (platform === 'win32') {
    if (arch !== 'x64' && arch !== 'arm64') {
      throw new Error(`Windows Job containment is unsupported on architecture ${arch}.`);
    }
    platformTarballs = [
      arch === 'arm64' ? bundle.windowsArm64TarballPath : bundle.windowsX64TarballPath,
    ];
  }
  await (options.runCommand ?? runCommand)('npm', [
    'install',
    '-g',
    ...(platform === 'win32' ? [] : ['--omit=optional']),
    bundle.evalTarballPath,
    bundle.coreTarballPath,
    bundle.cliTarballPath,
    ...platformTarballs,
  ]);
  return bundle;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const {
      cliTarballArg,
      evalTarballArg,
      coreTarballArg,
      windowsX64TarballArg,
      windowsArm64TarballArg,
    } = parseArgs(argv);
    const bundle = await installLocalTarball(cliTarballArg, {
      evalTarballArg,
      coreTarballArg,
      windowsX64TarballArg,
      windowsArm64TarballArg,
    });
    console.log(`Validated Windows Job x64 tarball: ${relativeToRepo(bundle.windowsX64TarballPath)}`);
    console.log(`Validated Windows Job arm64 tarball: ${relativeToRepo(bundle.windowsArm64TarballPath)}`);
    console.log(`Installed shared Eval tarball globally: ${relativeToRepo(bundle.evalTarballPath)}`);
    console.log(`Installed plugin core tarball globally: ${relativeToRepo(bundle.coreTarballPath)}`);
    console.log(`Installed CLI tarball globally: ${relativeToRepo(bundle.cliTarballPath)}`);
    return bundle;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedPath === currentEntryPath) {
  await main();
}
