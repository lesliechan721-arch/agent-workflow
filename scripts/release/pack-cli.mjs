import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  packCli,
  packCore,
  packEval,
  relativeToRepo,
  readPackageJson,
  repoRoot,
  tarballDir,
  withReleaseBuildSnapshot,
} from './common.mjs';

const usage = 'node scripts/release/pack-cli.mjs [--pack-destination <directory>] [--native-candidate <directory>]';

export function parseArgs(argv) {
  const args = [...argv];
  let destination;
  let nativeCandidateRoot;

  while (args[0] === '--') {
    args.shift();
  }

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--pack-destination' && destination === undefined) {
      destination = args.shift();
      if (!destination) {
        throw new Error(`Missing value for --pack-destination. Usage: ${usage}`);
      }
      continue;
    }
    if (token === '--native-candidate' && nativeCandidateRoot === undefined) {
      nativeCandidateRoot = args.shift();
      if (!nativeCandidateRoot || nativeCandidateRoot.startsWith('--')) throw new Error(`Missing value for --native-candidate. Usage: ${usage}`);
      continue;
    }
    throw new Error(`Unknown argument "${token}". Usage: ${usage}`);
  }

  return { destination, ...(nativeCandidateRoot ? { nativeCandidateRoot } : {}) };
}

export async function prepareWindowsJobTarballs(options = {}) {
  const version = options.version ?? (await readPackageJson(path.join(
    options.snapshot?.cliPackageRoot ?? path.join(options.repoRoot ?? repoRoot, 'packages/cli'), 'package.json',
  ))).version;
  const nativeOptions = { ...options, version, repoRoot: options.repoRoot ?? repoRoot };
  const selected = options.nativeCandidateRoot
    ? await (options.readWindowsJobCandidate ?? (await import('../../native-tools/windows-job/candidate.mjs')).readCandidate)(path.resolve(nativeOptions.repoRoot, options.nativeCandidateRoot), nativeOptions)
    : await (options.buildWindowsJobCandidate ?? (await import('../../native-tools/windows-job/pack.mjs')).buildWindowsJobCandidate)(nativeOptions);
  if (selected.candidate.version !== version || selected.candidate.packages.length !== 2) {
    throw new Error('Windows Job candidate must contain both architectures at the current CLI version.');
  }
  const destination = path.resolve(nativeOptions.repoRoot, options.destination ?? tarballDir);
  await fs.mkdir(destination, { recursive: true });
  const tarballPaths = [];
  for (const entry of selected.candidate.packages) {
    const source = path.join(selected.root, entry.path);
    const target = path.join(destination, path.basename(entry.path));
    if (path.resolve(source) !== target) await fs.copyFile(source, target);
    tarballPaths.push(target);
  }
  return { ...selected, tarballPaths };
}

export async function packCliBundle(options = {}) {
  const destination = options.destination;
  const snapshotRunner = options.withBuildSnapshot ?? withReleaseBuildSnapshot;
  const packEvalTarball = options.packEval ?? packEval;
  const packCoreTarball = options.packCore ?? packCore;
  const packCliTarball = options.packCli ?? packCli;

  return snapshotRunner(async (snapshot) => {
    const native = await (options.prepareWindowsJobTarballs ?? prepareWindowsJobTarballs)({ ...options, destination, snapshot });
    const evalTarballPath = await packEvalTarball({ destination, snapshot });
    const coreTarballPath = await packCoreTarball({ destination, snapshot });
    const cliTarballPath = await packCliTarball({ destination, snapshot });
    return {
      evalTarballPath,
      coreTarballPath,
      cliTarballPath,
      windowsJobTarballPaths: native.tarballPaths,
    };
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { destination, nativeCandidateRoot } = parseArgs(argv);
    const bundle = await packCliBundle({ destination, nativeCandidateRoot });
    for (const tarball of bundle.windowsJobTarballPaths) console.log(`Packed Windows Job tarball: ${relativeToRepo(tarball)}`);
    console.log(`Packed shared Eval tarball: ${relativeToRepo(bundle.evalTarballPath)}`);
    console.log(`Packed plugin core tarball: ${relativeToRepo(bundle.coreTarballPath)}`);
    console.log(`Packed CLI tarball: ${relativeToRepo(bundle.cliTarballPath)}`);
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
