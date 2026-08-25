import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureCommand,
  computePackageTarballTreeDigest,
  relativeToRepo,
  runCommand,
} from './common.mjs';
import { packCliBundle } from './pack-cli.mjs';

const usage = 'node scripts/release/install-local-tarball.mjs [<cli-tarball> <eval-tarball> <core-tarball>]';
const cliPackageName = '@lesliechan721/aw';
const evalPackageName = '@lesliechan721/agent-skill-eval';
const corePackageName = '@lesliechan721/aw-plugin-core';

export function parseArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length > 3) throw new Error(`Too many arguments. Usage: ${usage}`);
  return {
    cliTarballArg: args[0],
    evalTarballArg: args[1],
    coreTarballArg: args[2],
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
  const [cliPackageJson, evalPackageJson, corePackageJson] = await Promise.all([
    readPackageJson(bundle.cliTarballPath, options),
    readPackageJson(bundle.evalTarballPath, options),
    readPackageJson(bundle.coreTarballPath, options),
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
    throw new Error('CLI, shared Eval, and plugin core tarballs must have the same package version.');
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
  return bundle;
}

export async function installLocalTarball(cliTarballArg, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const evalTarballArg = options.evalTarballArg;
  const coreTarballArg = options.coreTarballArg;
  let bundle;

  if (cliTarballArg || evalTarballArg || coreTarballArg) {
    if (!cliTarballArg || !evalTarballArg || !coreTarballArg) {
      throw new Error(
        `Local CLI installation requires both the CLI tarball and its exact shared Eval tarball. Usage: ${usage}`,
      );
    }
    bundle = {
      cliTarballPath: path.resolve(cwd, cliTarballArg),
      evalTarballPath: path.resolve(cwd, evalTarballArg),
      coreTarballPath: path.resolve(cwd, coreTarballArg),
    };
  } else {
    bundle = await (options.packCliBundle ?? packCliBundle)();
  }

  await (options.validateBundle ?? validateLocalTarballBundle)(bundle, options);
  await (options.runCommand ?? runCommand)('npm', [
    'install',
    '-g',
    bundle.evalTarballPath,
    bundle.coreTarballPath,
    bundle.cliTarballPath,
  ]);
  return bundle;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { cliTarballArg, evalTarballArg, coreTarballArg } = parseArgs(argv);
    const bundle = await installLocalTarball(cliTarballArg, { evalTarballArg, coreTarballArg });
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
