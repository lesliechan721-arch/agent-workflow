import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublishedPackageTarballMatchesCandidate, isExactPackageVersionPublished, resolveRegistryUrl, runCommand } from '../../scripts/release/common.mjs';
import { WINDOWS_JOB_REQUIRED_CHECKS } from '../../scripts/qualification/windows-job-containment.mjs';
import { bytesDigest, readCandidate, writeAtomicJson } from './candidate.mjs';
import { windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs';

const repoRoot = path.resolve(windowsJobArtifactContract.toolRoot, '../..');
const requiredChecks = [...WINDOWS_JOB_REQUIRED_CHECKS, 'plugin-files-acl-cross-volume', 'go-native-tests'];

export async function assertNativeReleaseEvidence(selected) {
  const read = async (name) => JSON.parse(await readFile(path.join(selected.root, name), 'utf8'));
  const repro = await read('reproducibility.json');
  if (repro.kind !== 'windows-job-reproducibility' || repro.status !== 'passed'
    || repro.candidateDigest !== selected.candidateDigest || repro.sourceDigest !== selected.candidate.sourceDigest
    || repro.goVersion !== selected.candidate.goVersion || repro.architectures?.join(',') !== 'x64,arm64') throw new Error('Current x64 and arm64 reproducibility evidence is required.');
  for (const arch of ['x64', 'arm64']) {
    const report = await read(`qualification-${arch}.json`);
    if (report.schemaVersion !== 1 || report.kind !== 'windows-job-qualification' || report.mode !== 'source-candidate'
      || report.platform !== 'win32' || report.arch !== arch || report.status !== 'passed'
      || report.candidateDigest !== selected.candidateDigest || report.sourceDigest !== selected.candidate.sourceDigest
      || !Array.isArray(report.checks) || report.checks.some((check) => check.passed !== true || check.skipped)
      || requiredChecks.some((id) => report.checks.filter((check) => check.id === id && check.passed === true).length !== 1)) throw new Error(`Real Windows ${arch} qualification for this exact candidate is required.`);
  }
}

async function assertUnusedAttempt(attemptPath, selected, options) {
  let bytes;
  try { bytes = await readFile(attemptPath); }
  catch (error) { if (error.code === 'ENOENT' && !options.initialAttemptDigest) return; throw error; }
  const attempt = JSON.parse(bytes);
  if (!options.initialAttemptDigest || bytesDigest(bytes) !== options.initialAttemptDigest
    || attempt.publicationStarted !== false || attempt.candidateDigest !== selected.candidateDigest
    || attempt.product !== 'windows-job' || attempt.version !== selected.candidate.version) {
    throw new Error('This Windows Job version has a publication attempt. Bump the tool version; same-version repair is not supported.');
  }
}

export async function prepareWindowsJobPublication(options = {}) {
  const selected = await (options.readCandidate ?? readCandidate)(options.root);
  const attemptPath = options.attemptPath ?? path.join(repoRoot, '.release', 'native', 'windows-job', selected.candidate.version, 'attempted.json');
  await assertUnusedAttempt(attemptPath, selected, {});
  await (options.assertEvidence ?? assertNativeReleaseEvidence)(selected);
  await writeAtomicJson(attemptPath, { schemaVersion: 1, product: 'windows-job', version: selected.candidate.version, candidateDigest: selected.candidateDigest, publicationStarted: false, status: 'prepared' });
  return { attemptPath, attemptDigest: bytesDigest(await readFile(attemptPath)) };
}

export async function publishWindowsJobCandidate(options = {}) {
  const selected = await (options.readCandidate ?? readCandidate)(options.root);
  const attemptPath = options.attemptPath ?? path.join(repoRoot, '.release', 'native', 'windows-job', selected.candidate.version, 'attempted.json');
  await assertUnusedAttempt(attemptPath, selected, options);
  await (options.assertEvidence ?? assertNativeReleaseEvidence)(selected);
  for (const artifact of selected.candidate.packages) {
    const packageJsonPath = path.join(repoRoot, 'packages', `aw-windows-job-win32-${artifact.arch}`, 'package.json');
    if (await (options.isPublished ?? isExactPackageVersionPublished)(artifact.name, selected.candidate.version, packageJsonPath, options)) throw new Error('A native platform package already occupies this version. Bump the Windows Job version.');
  }
  const registry = options.registryUrl ?? await resolveRegistryUrl(path.join(repoRoot, 'packages/aw-windows-job-win32-x64/package.json'), options.env ?? process.env);
  // Persist the boundary before the first write. Any failure from this point
  // consumes the version, including a partial or uncertain registry outcome.
  const attempt = { schemaVersion: 1, product: 'windows-job', version: selected.candidate.version, candidateDigest: selected.candidateDigest, publicationStarted: true, status: 'attempted' };
  await writeAtomicJson(attemptPath, attempt);
  try {
    for (const artifact of selected.candidate.packages) {
      await (options.runPublish ?? runCommand)('npm', ['publish', path.join(selected.root, artifact.path), '--ignore-scripts', '--access', 'public', '--tag', selected.candidate.version.includes('-') ? 'beta' : 'latest', '--registry', registry], { env: options.env });
      await (options.assertPublished ?? assertPublishedPackageTarballMatchesCandidate)(artifact.name, selected.candidate.version, path.join(repoRoot, 'packages', `aw-windows-job-win32-${artifact.arch}`, 'package.json'), path.join(selected.root, artifact.path), options);
    }
    await writeAtomicJson(attemptPath, { ...attempt, status: 'published' });
  } catch (cause) {
    throw new Error('Native publication failed or its result is uncertain. Keep any published package and bump the Windows Job version before another attempt.', { cause });
  }
  return selected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter((arg) => arg !== '--');
    const prepare = args.includes('--prepare');
    const publish = args.includes('--publish');
    if (prepare === publish) throw new Error('Expected one of --prepare or --publish [--attempt-digest <digest>].');
    args.splice(args.indexOf(prepare ? '--prepare' : '--publish'), 1);
    let root, initialAttemptDigest;
    while (args.length) {
      const flag = args.shift();
      const value = args.shift();
      if (flag === '--candidate' && value && !root) root = path.resolve(value);
      else if (flag === '--attempt-digest' && /^sha256:[a-f0-9]{64}$/u.test(value ?? '') && !initialAttemptDigest) initialAttemptDigest = value;
      else throw new Error('Expected --candidate <directory> or --attempt-digest <digest>.');
    }
    if (prepare) {
      if (initialAttemptDigest) throw new Error('A native attempt cannot be prepared again. Bump the tool version.');
      const intent = await prepareWindowsJobPublication({ root });
      if (process.env.GITHUB_OUTPUT) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.GITHUB_OUTPUT, `attempt_digest=${intent.attemptDigest}\n`);
      }
      console.log(`Prepared native publication intent ${intent.attemptDigest}.`);
    } else {
    const selected = await publishWindowsJobCandidate({ root, initialAttemptDigest });
    console.log(`Published Windows Job ${selected.candidate.version}. Consumer references still require independent remote verification.`);
    }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
