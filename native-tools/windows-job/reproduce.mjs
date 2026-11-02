import path from 'node:path';
import { verifyWindowsJobReproducibility, windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs';
import { readCandidate, writeAtomicJson } from './candidate.mjs';
try {
  await verifyWindowsJobReproducibility();
  const { candidateDigest, candidate } = await readCandidate();
  await writeAtomicJson(path.join(windowsJobArtifactContract.defaultNativeRoot, 'reproducibility.json'), {
    schemaVersion: 1, kind: 'windows-job-reproducibility', status: 'passed',
    candidateDigest, sourceDigest: candidate.sourceDigest, goVersion: candidate.goVersion,
    architectures: ['x64', 'arm64'],
  });
  console.log('Windows Job fixed-toolchain reproducibility passed for x64 and arm64.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
