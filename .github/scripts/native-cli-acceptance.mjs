// TEMPORARY: copy to .github/scripts/native-cli-acceptance.mjs for dispatch acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const releaseRoot = path.join(repoRoot, '.release/native-cli-acceptance');
const bundleRoot = path.join(releaseRoot, 'bundle');

function argumentsFor(argv, allowed) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert.ok(allowed.includes(key) && !Object.hasOwn(values, key) && value && !value.startsWith('--'), `Invalid argument: ${key}`);
    values[key] = value;
  }
  for (const key of allowed) assert.ok(values[key], `Missing argument: ${key}`);
  return values;
}

async function assertBundleBinding(manifest) {
  const { calculateCanonicalDigest } = await import('../../scripts/release/release-model.mjs');
  const descriptor = JSON.parse(await fs.readFile(path.join(bundleRoot, 'cli/prepared/descriptor.json'), 'utf8'));
  const attempt = JSON.parse(await fs.readFile(path.join(bundleRoot, 'cli/attempted.json'), 'utf8'));
  assert.equal(manifest.product, 'cli');
  assert.equal(manifest.sourceHead, process.env.GITHUB_SHA);
  assert.equal(manifest.candidateHead, process.env.GITHUB_SHA);
  assert.equal(descriptor.source.head, manifest.sourceHead);
  assert.equal(manifest.version, descriptor.candidates.cli);
  assert.equal(manifest.descriptorDigest, calculateCanonicalDigest(descriptor));
  assert.equal(manifest.intentDigest, calculateCanonicalDigest(attempt));
  assert.equal(attempt.descriptorDigest, manifest.descriptorDigest);
  assert.equal(attempt.publicationStarted, false);
  assert.equal(descriptor.selection, 'exact');
  assert.deepEqual(descriptor.axes, { cli: true, catalog: false });
  assert.equal(descriptor.catalog, null);
  assert.equal(descriptor.npm.packages.length, 5);
  assert.equal(descriptor.npm.nativeEvidence.length, 4);
}

assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'This temporary script requires workflow_dispatch.');
assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const [command, ...argv] = process.argv.slice(2);
if (command === 'prepare') {
  const args = argumentsFor(argv, ['--native-candidate']);
  const { prepareLocalRelease, markPreparedCliAttempt, exportPreparedRelease } = await import('../../scripts/release/prepared-release.mjs');
  const { sealCandidateDirectory, archiveCandidate } = await import('../../scripts/release/candidate-archive.mjs');
  const { calculateCanonicalDigest, normalizeStableTargetVersion } = await import('../../scripts/release/release-model.mjs');
  const version = normalizeStableTargetVersion(JSON.parse(await fs.readFile(path.join(repoRoot, 'packages/cli/package.json'), 'utf8')).version);
  // Source package versions are stable targets. exactCandidates skips version occupancy reads.
  const options = { repoRoot, releaseRoot, nativeCandidateRoot: path.resolve(repoRoot, args['--native-candidate']) };
  const descriptor = await prepareLocalRelease('stable', {
    ...options, axes: { cli: true, catalog: false }, exactCandidates: { cli: version, catalog: null },
  });
  assert.equal(descriptor.source.head, process.env.GITHUB_SHA);
  const intent = await markPreparedCliAttempt(options);
  assert.equal(intent.attempt.publicationStarted, false);
  await exportPreparedRelease({ ...options, requireAttempt: true, destination: path.join(bundleRoot, 'cli') });
  const manifest = await sealCandidateDirectory(bundleRoot, {
    product: 'cli', version, channel: 'stable', sourceHead: descriptor.source.head,
    candidateHead: descriptor.source.head, descriptorDigest: calculateCanonicalDigest(descriptor),
    intentDigest: intent.intentDigest,
  });
  await assertBundleBinding(manifest);
  const archivePath = path.join(releaseRoot, 'candidate.tar');
  const bundleDigest = await archiveCandidate(bundleRoot, archivePath);
  const outputs = { version, candidate_head: descriptor.source.head, bundle_digest: bundleDigest };
  await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify({ ...outputs, archivePath, manifest }, null, 2));
} else if (command === 'unpack') {
  const args = argumentsFor(argv, ['--archive', '--digest']);
  const { extractCandidate } = await import('../../scripts/release/candidate-archive.mjs');
  const manifest = await extractCandidate(path.resolve(repoRoot, args['--archive']), bundleRoot, args['--digest']);
  await assertBundleBinding(manifest);
  console.log(JSON.stringify({ bundleRoot, version: manifest.version, archiveDigest: args['--digest'], candidateHead: manifest.candidateHead }, null, 2));
} else {
  throw new Error('Usage: native-cli-acceptance.mjs prepare --native-candidate <dir> | unpack --archive <tar> --digest <sha256:...>');
}
