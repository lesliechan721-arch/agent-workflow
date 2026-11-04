import path from 'node:path';
import { verifyWindowsJobReproducibility, windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs';
import { readCandidate, writeAtomicJson } from './candidate.mjs';
try {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length && (args.length !== 2 || args[0] !== '--candidate' || !args[1])) throw new Error('Expected [--candidate <directory>].');
  const nativeRoot = args.length ? path.resolve(args[1]) : windowsJobArtifactContract.defaultNativeRoot;
  await verifyWindowsJobReproducibility({ nativeRoot });
  const { candidateDigest, candidate } = await readCandidate(nativeRoot);
  await writeAtomicJson(path.join(nativeRoot, 'reproducibility.json'), {
    schemaVersion: 1, kind: 'windows-job-reproducibility', status: 'passed',
    candidateDigest, sourceDigest: candidate.sourceDigest, goVersion: candidate.goVersion,
    architectures: ['x64', 'arm64'],
  });
  console.log('Windows Job fixed-toolchain reproducibility passed for x64 and arm64.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
