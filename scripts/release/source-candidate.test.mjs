import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  parseSourceTag,
  prepareSourceCandidate,
  resolveMainSource,
  validateSourceCandidate,
} from './source-candidate.mjs';
import { setReleaseTargets } from './release-target.mjs';

const exec = promisify(execFile);
const packageNames = {
  'aw-windows-job-win32-x64': '@lesliechan721/aw-windows-job-win32-x64',
  'aw-windows-job-win32-arm64': '@lesliechan721/aw-windows-job-win32-arm64',
  'agent-skill-eval': '@lesliechan721/agent-skill-eval',
  'plugin-core': '@lesliechan721/aw-plugin-core',
  cli: '@lesliechan721/aw',
};

async function git(root, ...args) {
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })).stdout.trim();
}

async function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-source-candidate-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  await fs.mkdir(repoRoot);
  await git(root, 'init', '--initial-branch=main', repoRoot);
  await git(repoRoot, 'config', 'user.name', 'Test');
  await git(repoRoot, 'config', 'user.email', 'test@example.invalid');
  await git(repoRoot, 'config', 'commit.gpgSign', 'false');
  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  for (const [directory, name] of Object.entries(packageNames)) {
    await writeJson(repoRoot, `packages/${directory}/package.json`, {
      name, version: '1.2.3',
      ...(directory === 'agent-skill-eval' ? {
        optionalDependencies: {
          [packageNames['aw-windows-job-win32-x64']]: 'workspace:1.2.3',
          [packageNames['aw-windows-job-win32-arm64']]: 'workspace:1.2.3',
        },
      } : {}),
      ...(directory === 'cli' ? {
        dependencies: {
          [packageNames['agent-skill-eval']]: 'workspace:1.2.3',
          [packageNames['plugin-core']]: 'workspace:1.2.3',
        },
      } : {}),
    });
  }
  await writeJson(repoRoot, 'release/version-targets.json', { schemaVersion: 2, cli: '1.2.3' });
  await fs.writeFile(path.join(repoRoot, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'", 'importers:',
    ...Object.entries(packageNames).filter(([directory]) => ['cli', 'agent-skill-eval'].includes(directory))
      .flatMap(([directory]) => [
        `  packages/${directory}:`, directory === 'cli' ? '    dependencies:' : '    optionalDependencies:',
        ...(directory === 'cli'
          ? [packageNames['agent-skill-eval'], packageNames['plugin-core']]
          : [packageNames['aw-windows-job-win32-x64'], packageNames['aw-windows-job-win32-arm64']])
          .flatMap((name) => [`      '${name}':`, '        specifier: workspace:1.2.3', '        version: link:../fixture']),
      ]),
    '',
  ].join('\n'));
  await writeJson(repoRoot, '.aw-workspace.json', {
    schemaVersion: 1, kind: 'aw-catalog-workspace', workspaceIdentity: 'candidate-test',
  });
  await writeJson(repoRoot, 'plugins/marketplace-source.json', {
    owner: { name: 'Test', url: 'https://example.invalid' },
    interface: { displayName: 'Test' }, catalog: { version: '2.0.0-beta.1' },
  });
  await fs.writeFile(path.join(repoRoot, 'production.js'), 'export const value = 1;\n');
  await git(repoRoot, 'add', '.');
  await git(repoRoot, 'commit', '-m', 'source');
  await git(repoRoot, 'remote', 'add', 'origin', remote);
  await git(repoRoot, 'push', 'origin', 'main');
  return { repoRoot, remote, sourceHead: await git(repoRoot, 'rev-parse', 'HEAD') };
}

async function assertRejectedCandidate(t, change, expected) {
  const { repoRoot } = await fixture(t);
  await git(repoRoot, 'checkout', '-b', 'candidate');
  await change(repoRoot);
  await git(repoRoot, 'add', '-A');
  await git(repoRoot, 'commit', '--allow-empty', '-m', 'candidate');
  await git(repoRoot, 'tag', 'release/cli/v1.2.3-beta.1');
  await assert.rejects(validateSourceCandidate({ repoRoot, tag: 'release/cli/v1.2.3-beta.1' }), expected);
}

test('source tags select one product and an exact stable or positive beta version', () => {
  assert.deepEqual(parseSourceTag('release/cli/v1.2.3'), { product: 'cli', version: '1.2.3', channel: 'stable' });
  assert.deepEqual(parseSourceTag('release/catalog/v0.3.0-beta.9'), {
    product: 'catalog', version: '0.3.0-beta.9', channel: 'beta',
  });
  for (const tag of [
    'cli-v1.2.3', 'release/other/v1.2.3', 'release/cli/v01.2.3', 'release/cli/v1.2.3+build',
    'release/cli/v1.2.3-rc.1', 'release/cli/v1.2.3-beta.0', 'release/cli/v1.2.3-beta.01',
    'release/cli/v1.2.3\n', 'refs/tags/release/cli/v1.2.3',
  ]) assert.throws(() => parseSourceTag(tag), /Invalid source tag/);
});

test('CLI preparation uses exact stable metadata in a direct child and preserves the caller tree', async (t) => {
  const { repoRoot, remote, sourceHead } = await fixture(t);
  await fs.writeFile(path.join(repoRoot, 'production.js'), 'local user change\n');
  await fs.writeFile(path.join(repoRoot, 'untracked.txt'), 'keep\n');
  const before = await git(repoRoot, 'status', '--porcelain=v1');
  const candidate = await prepareSourceCandidate({ repoRoot, product: 'cli', version: '1.2.4-beta.7', sourceHead });
  assert.notEqual(candidate.candidateHead, sourceHead);
  assert.equal(await git(repoRoot, 'rev-parse', `${candidate.candidateHead}^`), sourceHead);
  assert.equal(await git(repoRoot, 'rev-parse', 'HEAD'), sourceHead);
  assert.equal(await git(repoRoot, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(await git(repoRoot, 'status', '--porcelain=v1'), before);
  assert.equal(await fs.readFile(path.join(repoRoot, 'production.js'), 'utf8'), 'local user change\n');
  assert.equal(await git(repoRoot, 'ls-remote', '--refs', remote, `refs/tags/${candidate.tag}`), '');
  assert.deepEqual(await validateSourceCandidate({ repoRoot, tag: candidate.tag }), {
    product: 'cli', version: '1.2.4-beta.7', channel: 'beta', sourceHead, candidateHead: candidate.candidateHead, tag: candidate.tag,
  });
  for (const directory of Object.keys(packageNames)) {
    assert.equal(JSON.parse(await git(repoRoot, 'show', `${candidate.candidateHead}:packages/${directory}/package.json`)).version, '1.2.4');
  }
  assert.equal(JSON.parse(await git(repoRoot, 'show', `${candidate.candidateHead}:release/version-targets.json`)).cli, '1.2.4');
  await assert.rejects(prepareSourceCandidate({
    repoRoot, product: 'cli', version: '1.2.4-beta.7', sourceHead,
  }), /already occupied/);
});

test('unchanged stable base uses main commit directly and pushes immutable candidate refs only when requested', async (t) => {
  const { repoRoot, remote, sourceHead } = await fixture(t);
  const candidate = await prepareSourceCandidate({
    repoRoot, remote, product: 'cli', version: '1.2.3', sourceHead, push: true,
  });
  assert.equal(candidate.candidateHead, sourceHead);
  const refs = await git(repoRoot, 'ls-remote', '--refs', remote,
    `refs/heads/${candidate.branch}`, `refs/tags/${candidate.tag}`, 'refs/heads/main');
  assert.deepEqual(refs.split('\n').map((line) => line.split('\t')[0]), [sourceHead, sourceHead, sourceHead]);
  await git(repoRoot, 'tag', '-d', candidate.tag);
  await git(repoRoot, 'branch', '-D', candidate.branch);
  await assert.rejects(prepareSourceCandidate({
    repoRoot, remote, product: 'cli', version: '1.2.3', sourceHead, push: true,
  }), /Remote source candidate.*occupied/);
  await assert.rejects(prepareSourceCandidate({
    repoRoot, remote, product: 'cli', version: '1.2.4', sourceHead, push: 'true',
  }), /explicit boolean/);
});

test('automatic candidates reject stale main sources and recheck the tip before remote writes', async (t) => {
  const { repoRoot, remote, sourceHead } = await fixture(t);
  await fs.appendFile(path.join(repoRoot, 'production.js'), 'export const next = 2;\n');
  await git(repoRoot, 'add', '.');
  await git(repoRoot, 'commit', '-m', 'new main');
  await git(repoRoot, 'push', 'origin', 'main');
  const current = await git(repoRoot, 'rev-parse', 'HEAD');
  await assert.rejects(prepareSourceCandidate({
    repoRoot, remote, sourceHead, product: 'cli', version: '1.2.4-beta.1', push: true, requireMainTip: true,
  }), /Main source is stale/);
  await assert.rejects(prepareSourceCandidate({
    repoRoot, remote, sourceHead: current, product: 'catalog', version: '2.0.0-beta.2',
    push: true, requireMainTip: true,
    mutateCatalogVersion: async (checkout, version) => {
      const metadataPath = 'plugins/marketplace-source.json';
      const value = JSON.parse(await fs.readFile(path.join(checkout, metadataPath), 'utf8'));
      await writeJson(checkout, metadataPath, { ...value, catalog: { version } });
      // Another actor changes main after the initial check.
      await git(remote, 'update-ref', 'refs/heads/main', sourceHead);
    },
  }), /Main source is stale/);
  assert.equal(await git(repoRoot, 'ls-remote', '--refs', remote, 'refs/tags/release/*'), '');
  assert.equal(await git(repoRoot, 'rev-parse', 'HEAD'), current);
});

test('Catalog preparation uses the public mutation and modifies only requested plugin stable bases', async (t) => {
  const { repoRoot, sourceHead } = await fixture(t);
  // The real public mutation validates the Workspace; an empty inventory is valid.
  const candidate = await prepareSourceCandidate({
    repoRoot, product: 'catalog', version: '2.0.0-beta.2', sourceHead,
  });
  assert.deepEqual(await validateSourceCandidate({ repoRoot, tag: candidate.tag }), {
    product: 'catalog', version: '2.0.0-beta.2', channel: 'beta', sourceHead, candidateHead: candidate.candidateHead, tag: candidate.tag,
  });
  assert.equal(await git(repoRoot, 'diff', '--name-only', sourceHead, candidate.candidateHead), 'plugins/marketplace-source.json');

  await writeJson(repoRoot, 'plugins/p/.agents-plugin/plugin.json', { name: 'p', version: '1.0.0', description: 'keep' });
  await writeJson(repoRoot, 'plugins/q/.agents-plugin/plugin.json', { name: 'q', version: '1.0.0', description: 'keep' });
  await git(repoRoot, 'add', '.');
  await git(repoRoot, 'commit', '-m', 'plugin metadata');
  await git(repoRoot, 'push', 'origin', 'main');
  const nextSource = await git(repoRoot, 'rev-parse', 'HEAD');
  const next = await prepareSourceCandidate({
    repoRoot, product: 'catalog', version: '2.1.0-beta.1', sourceHead: nextSource,
    pluginBaseVersions: { p: '1.1.0' },
    // Keep this fixture's reduced manifests out of complete plugin validation.
    // The first candidate above covers the real public mutation boundary.
    mutateCatalogVersion: async (checkout, version) => {
      const metadataPath = 'plugins/marketplace-source.json';
      const value = JSON.parse(await fs.readFile(path.join(checkout, metadataPath), 'utf8'));
      await writeJson(checkout, metadataPath, { ...value, catalog: { version } });
    },
  });
  await validateSourceCandidate({ repoRoot, tag: next.tag });
  assert.equal(JSON.parse(await git(repoRoot, 'show', `${next.candidateHead}:plugins/p/.agents-plugin/plugin.json`)).version, '1.1.0');
  assert.equal(JSON.parse(await git(repoRoot, 'show', `${next.candidateHead}:plugins/q/.agents-plugin/plugin.json`)).version, '1.0.0');
});

test('validation rejects production edits and extra fields in version metadata', async (t) => {
  await t.test('production file', (t) => assertRejectedCandidate(t,
    (root) => fs.writeFile(path.join(root, 'production.js'), 'malicious\n'), /non-version path/));
  await t.test('package bin', (t) => assertRejectedCandidate(t, async (root) => {
    const file = 'packages/cli/package.json';
    const manifest = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
    await writeJson(root, file, { ...manifest, bin: { aw: 'other.js' } });
  }, /non-version fields/));
  await t.test('unrelated lockfile field', (t) => assertRejectedCandidate(t,
    (root) => fs.appendFile(path.join(root, 'pnpm-lock.yaml'), 'extra: bad\n'), /lockfile changes exceed/));
  await t.test('file mode', (t) => assertRejectedCandidate(t,
    (root) => fs.chmod(path.join(root, 'packages/cli/package.json'), 0o755), /file mode/));
});

test('validation rejects mismatched version and internal dependency metadata even on main', async (t) => {
  const { repoRoot } = await fixture(t);
  await git(repoRoot, 'tag', 'release/cli/v1.2.4-beta.1');
  await assert.rejects(validateSourceCandidate({ repoRoot, tag: 'release/cli/v1.2.4-beta.1' }), /stable release target/);
  const file = 'packages/agent-skill-eval/package.json';
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, file), 'utf8'));
  manifest.optionalDependencies[packageNames['aw-windows-job-win32-arm64']] = 'workspace:1.2.2';
  await writeJson(repoRoot, file, manifest);
  await git(repoRoot, 'add', '.');
  await git(repoRoot, 'commit', '-m', 'invalid dependency');
  await git(repoRoot, 'push', 'origin', 'main');
  await git(repoRoot, 'tag', 'release/cli/v1.2.3-beta.1');
  await assert.rejects(validateSourceCandidate({ repoRoot, tag: 'release/cli/v1.2.3-beta.1' }), /mismatched internal dependency/);
});

test('lockfile version prefixes cannot satisfy the exact internal dependency contract', async (t) => {
  const { repoRoot } = await fixture(t);
  const lockPath = path.join(repoRoot, 'pnpm-lock.yaml');
  await fs.writeFile(lockPath, (await fs.readFile(lockPath, 'utf8')).replaceAll('workspace:1.2.3', 'workspace:1.2.30'));
  await git(repoRoot, 'add', '.');
  await git(repoRoot, 'commit', '-m', 'inconsistent lockfile');
  await git(repoRoot, 'push', 'origin', 'main');
  await git(repoRoot, 'tag', 'release/cli/v1.2.3');
  await assert.rejects(validateSourceCandidate({ repoRoot, tag: 'release/cli/v1.2.3' }), /four exact specifier/);
});

test('Catalog candidates reject mismatched exact versions and non-version owner changes', async (t) => {
  const { repoRoot } = await fixture(t);
  await git(repoRoot, 'tag', 'release/catalog/v2.0.0-beta.2');
  await assert.rejects(validateSourceCandidate({ repoRoot, tag: 'release/catalog/v2.0.0-beta.2' }), /does not match metadata version/);
  await git(repoRoot, 'checkout', '-b', 'catalog-candidate');
  await writeJson(repoRoot, 'plugins/marketplace-source.json', {
    owner: { name: 'Other', url: 'https://example.invalid' },
    interface: { displayName: 'Test' }, catalog: { version: '2.1.0' },
  });
  await git(repoRoot, 'add', '.');
  await git(repoRoot, 'commit', '-m', 'changed owner');
  await git(repoRoot, 'tag', 'release/catalog/v2.1.0');
  await assert.rejects(validateSourceCandidate({ repoRoot, tag: 'release/catalog/v2.1.0' }), /non-version fields/);
});

test('new tags reject more than one candidate commit while legacy provenance can prove the full version-only difference', async (t) => {
  const { repoRoot, sourceHead } = await fixture(t);
  await git(repoRoot, 'checkout', '-b', 'legacy');
  await setReleaseTargets({ cli: '1.2.4' }, { repoRoot });
  await git(repoRoot, 'add', '.');
  await git(repoRoot, 'commit', '-m', 'version one');
  await setReleaseTargets({ cli: '1.2.5' }, { repoRoot });
  await git(repoRoot, 'add', '.');
  await git(repoRoot, 'commit', '-m', 'version two');
  const candidateHead = await git(repoRoot, 'rev-parse', 'HEAD');
  await git(repoRoot, 'tag', 'release/cli/v1.2.5-beta.1');
  await assert.rejects(validateSourceCandidate({ repoRoot, tag: 'release/cli/v1.2.5-beta.1' }), /direct version-only child/);
  assert.deepEqual(await resolveMainSource({ repoRoot, candidateHead, product: 'cli', allowLegacyHistory: true }), {
    sourceHead, candidateHead,
  });
  await assert.rejects(prepareSourceCandidate({
    repoRoot, product: 'cli', version: '1.2.6-beta.1', sourceHead: candidateHead,
  }), /direct version-only child/);
});

test('unrelated Git history cannot supply a main source', async (t) => {
  const { repoRoot } = await fixture(t);
  await git(repoRoot, 'checkout', '--orphan', 'unrelated');
  await git(repoRoot, 'commit', '-m', 'unrelated');
  await git(repoRoot, 'tag', 'release/cli/v1.2.3-beta.1');
  await assert.rejects(validateSourceCandidate({ repoRoot, tag: 'release/cli/v1.2.3-beta.1' }));
});
