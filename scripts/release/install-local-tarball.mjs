import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureCommand,
  computePackageTarballTreeDigest,
  relativeToRepo,
  runCommand,
  WINDOWS_JOB_PACKAGE_NAMES,
} from './common.mjs';
import { packCliBundle } from './pack-cli.mjs';

const usage = 'node scripts/release/install-local-tarball.mjs [<cli-tarball> <eval-tarball> <core-tarball> <windows-x64-tarball> <windows-arm64-tarball>]';
const cliPackageName = '@lesliechan721/aw';
const evalPackageName = '@lesliechan721/agent-skill-eval';
const corePackageName = '@lesliechan721/aw-plugin-core';

export function parseArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length > 5) throw new Error(`Too many arguments. Usage: ${usage}`);
  return {
    cliTarballArg: args[0],
    evalTarballArg: args[1],
    coreTarballArg: args[2],
    windowsJobTarballArgs: args.slice(3),
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
    ...nativePackages
  ] = await Promise.all([
    readPackageJson(bundle.cliTarballPath, options),
    readPackageJson(bundle.evalTarballPath, options),
    readPackageJson(bundle.coreTarballPath, options),
    ...(bundle.windowsJobTarballPaths ?? []).map((tarball) => readPackageJson(tarball, options)),
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


  if (
    typeof cliPackageJson.version !== 'string'
    || cliPackageJson.version === ''
    || cliPackageJson.version !== evalPackageJson.version
    || cliPackageJson.version !== corePackageJson.version
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


  if (nativePackages.length !== 2) throw new Error('Local CLI installation requires both Windows platform tarballs.');
  for (const [index, name] of WINDOWS_JOB_PACKAGE_NAMES.entries()) {
    const metadata = nativePackages[index];
    if (metadata.name !== name || metadata.version !== cliPackageJson.version
      || JSON.stringify(metadata.os) !== '["win32"]'
      || JSON.stringify(metadata.cpu) !== JSON.stringify([['x64', 'arm64'][index]])) {
      throw new Error(`Windows platform tarball must contain ${name} at the same package version with the correct OS and CPU.`);
    }
    if (evalPackageJson.optionalDependencies?.[name] !== cliPackageJson.version) {
      throw new Error(`Eval tarball must optionally depend on ${name} at its exact package version.`);
    }
  }
  return bundle;
}

export async function installLocalTarball(cliTarballArg, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const evalTarballArg = options.evalTarballArg;
  const coreTarballArg = options.coreTarballArg;
  const windowsJobTarballArgs = options.windowsJobTarballArgs ?? [];
  let bundle;

  if (cliTarballArg || evalTarballArg || coreTarballArg || windowsJobTarballArgs.length) {
    if (!cliTarballArg || !evalTarballArg || !coreTarballArg || windowsJobTarballArgs.length !== 2) {
      throw new Error(
        `Local CLI installation requires all five release tarballs. Usage: ${usage}`,
      );
    }
    bundle = {
      cliTarballPath: path.resolve(cwd, cliTarballArg),
      evalTarballPath: path.resolve(cwd, evalTarballArg),
      coreTarballPath: path.resolve(cwd, coreTarballArg),
      windowsJobTarballPaths: windowsJobTarballArgs.map((entry) => path.resolve(cwd, entry)),
    };
  } else {
    bundle = await (options.packCliBundle ?? packCliBundle)();
  }

  await (options.validateBundle ?? validateLocalTarballBundle)(bundle, options);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform === 'win32' && !['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Windows architecture ${arch}.`);
  await (options.runCommand ?? runCommand)('npm', [
    'install',
    '-g',
    '--ignore-scripts',
    ...(platform === 'win32' ? [bundle.windowsJobTarballPaths[['x64', 'arm64'].indexOf(arch)]] : []),
    bundle.evalTarballPath,
    bundle.coreTarballPath,
    bundle.cliTarballPath,
  ]);
  return bundle;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const {
      cliTarballArg,
      evalTarballArg,
      coreTarballArg,
      windowsJobTarballArgs,
    } = parseArgs(argv);
    const bundle = await installLocalTarball(cliTarballArg, {
      evalTarballArg,
      coreTarballArg,
      windowsJobTarballArgs,
    });
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
