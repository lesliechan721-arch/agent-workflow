import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertToolchainCompletion, installSavedCatalogToolchain, loadCatalogToolchainCore, prepareCatalogToolchain, readToolchainWithRetry, TOOLCHAIN_PACKAGES } from './catalog-toolchain.mjs';
import { assertPreparedCliAttempt, prepareLocalRelease, publishPreparedRelease, readPreparedDescriptor } from './prepared-release.mjs';
import { runRelease } from './release.mjs';

const digest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

// Test Value Gate: selected CLI tools must use their own import-only Core
// dependency in workspace and installed layouts, even with another Core nearby.
test('Catalog Core loads through the selected CLI ESM dependency context', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-selected-catalog-core-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writeCore = async (directory, selected) => {
    await fs.mkdir(path.join(directory, 'dist'), { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({
      name: '@lesliechan721/aw-plugin-core', type: 'module', exports: { '.': { import: './dist/index.js' } },
    }));
    await fs.writeFile(path.join(directory, 'dist/index.js'), `export const selected = ${JSON.stringify(selected)};`);
  };
  for (const layout of ['workspace', 'npm']) {
    const cliRoot = path.join(root, layout, layout === 'workspace' ? 'workspaces/cli' : 'node_modules/@lesliechan721/aw');
    const distRoot = path.join(cliRoot, 'dist');
    const dependency = path.join(cliRoot, 'node_modules/@lesliechan721/aw-plugin-core');
    await fs.mkdir(path.dirname(dependency), { recursive: true });
    await fs.mkdir(distRoot);
    await fs.writeFile(path.join(cliRoot, 'package.json'), JSON.stringify({ name: '@lesliechan721/aw', type: 'module' }));
    await writeCore(path.resolve(distRoot, '../../aw-plugin-core'), 'foreign-sibling');
    if (layout === 'workspace') {
      const coreRoot = path.join(root, layout, 'workspaces/plugin-core');
      await writeCore(coreRoot, layout);
      await fs.symlink(coreRoot, dependency, process.platform === 'win32' ? 'junction' : 'dir');
    } else await writeCore(dependency, layout);
    assert.equal((await loadCatalogToolchainCore(distRoot)).selected, layout);
  }
  const empty = path.join(root, 'without-dependency');
  await fs.mkdir(empty);
  await assert.rejects(loadCatalogToolchainCore(empty), /Cannot find package/u);
});

async function fixture(t, version = '2.3.4-beta.8') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-toolchain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reads = [];
  const options = {
    repoRoot: root, destination: path.join(root, 'selected'), registryUrl: 'https://registry.example.invalid/',
    captureCommand: async (_command, args, call) => {
      reads.push(args);
      assert.ok(args.includes('--prefer-online'));
      assert.ok(call.timeoutMs > 0);
      return { stdout: JSON.stringify(version) };
    },
    assertToolchainCompletion: async () => 'a'.repeat(40),
    downloadExactPackageTarball: async (name, exact, _metadata, directory, call) => {
      assert.equal(call.env.npm_config_prefer_online, 'true');
      reads.push([name, exact]);
      const tarballPath = path.join(directory, 'package.tgz');
      await fs.writeFile(tarballPath, `${name}@${exact}`);
      return { tarballPath };
    },
    installCandidatePackages: async (_bundle, manifest) => {
      assert.equal(manifest.files.length, 5);
      assert.equal(manifest.toolchain.version, version);
    },
    loadToolchainCapabilities: async () => ({ IMPLEMENTED_AW_CAPABILITIES: ['aw.catalog-publication.v1', 'aw.catalog-snapshot.v7', 'aw.catalog-authoring.v1'] }),
  };
  return { root, reads, options };
}

// Test Value Gate: Catalog-only must freeze a complete same-channel release,
// and recover with its saved tools after the floating npm tag changes.
test('Catalog-only freezes beta once and restores the five saved packages without querying tags', async (t) => {
  const f = await fixture(t);
  const selected = await prepareCatalogToolchain('beta', f.options);
  assert.equal(selected.toolchain.version, '2.3.4-beta.8');
  assert.equal(selected.toolchain.completionHead, 'a'.repeat(40));
  assert.deepEqual(f.reads.slice(1).map(([name]) => name), TOOLCHAIN_PACKAGES);
  const before = f.reads.length;
  const restored = await installSavedCatalogToolchain(selected.root, { toolchain: selected.toolchain,
    tools: await Promise.all(selected.tarballPaths.map(async (file) => ({ path: path.relative(selected.root, file), contentDigest: digest(await fs.readFile(file)) }))),
  }, { ...f.options, toolchainInstallRoot: path.join(f.root, 'restored'), captureCommand: async () => { throw new Error('Floating tag moved'); } });
  assert.match(restored.cliDistRoot, /restored/u);
  assert.equal(f.reads.length, before);
});

test('stable selection rejects beta latest and missing completion before downloading packages', async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareCatalogToolchain('stable', f.options), /Publish the stable CLI first/u);
  assert.equal(f.reads.length, 1);
  const stable = await fixture(t, '2.3.4');
  await assert.rejects(prepareCatalogToolchain('stable', { ...stable.options,
    assertToolchainCompletion: async () => { throw new Error('not completed'); },
  }), /Publish the stable CLI first/u);
  assert.equal(stable.reads.length, 1);
});

test('same-batch tools use explicit artifacts without any registry lookup and reject missing capabilities', async (t) => {
  const f = await fixture(t);
  const paths = [];
  for (let index = 0; index < 5; index += 1) {
    const file = path.join(f.root, `${index}.tgz`); await fs.writeFile(file, String(index)); paths.push(file);
  }
  const cliBundle = { version: '2.3.4-beta.8', candidateHead: 'b'.repeat(40), cliTarballPath: paths[0], evalTarballPath: paths[1], coreTarballPath: paths[2], windowsJobTarballPaths: paths.slice(3) };
  const selected = await prepareCatalogToolchain('beta', { ...f.options, cliBundle });
  assert.equal(selected.toolchain.source, 'candidate');
  assert.equal(f.reads.length, 0);
  const pluginRoot = path.join(f.root, 'plugins/demo/.agents-plugin');
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(pluginRoot, 'plugin.json'), JSON.stringify({ requires: { aw: { capabilities: ['aw.native-tools.v2'] } } }));
  await assert.rejects(prepareCatalogToolchain('beta', { ...f.options, cliBundle }), /lacks aw.native-tools.v2/u);
  await assert.rejects(prepareCatalogToolchain('beta', { ...f.options, cliBundle,
    loadToolchainCapabilities: async () => ({ IMPLEMENTED_AW_CAPABILITIES: [] }),
  }), /lacks aw.catalog-publication/u);
});

test('read-only registry retries recover temporary absence and stop at the total deadline', async () => {
  let now = 0;
  let reads = 0;
  const options = { now: () => now, pause: async (ms) => { now += ms; }, registryReadDeadlineMs: 5, registryReadRetryMs: 2 };
  assert.equal(await readToolchainWithRetry(async (remaining) => { assert.ok(remaining <= 5); if (++reads < 3) throw new Error('not visible'); return 'ready'; }, options), 'ready');
  now = 0; reads = 0;
  await assert.rejects(readToolchainWithRetry(async () => { reads += 1; throw new Error('not visible'); }, options), /deadline/u);
  assert.equal(reads, 3);
});

test('completion gate requires an annotated tag for the exact same-batch CLI head', async () => {
  const ref = 'refs/tags/cli-v2.3.4-beta.8';
  await assert.rejects(assertToolchainCompletion('2.3.4-beta.8', { runGit: async () => ({ stdout: `${'a'.repeat(40)}\t${ref}\n` }) }), /no completed/u);
  await assert.rejects(assertToolchainCompletion('2.3.4-beta.8', { expectedCliHead: 'b'.repeat(40), runGit: async () => ({ stdout: `${'a'.repeat(40)}\t${ref}\n${'a'.repeat(40)}\t${ref}^{}\n` }) }), /does not match/u);
});

async function pendingCatalog(t) {
  const f = await fixture(t);
  const version = '4.5.6-beta.2';
  const plan = { catalogVersion: version, planDigest: digest('original-plan'), state: 'uncertain' };
  const attemptRoot = path.join(f.root, '.aw/publish', version);
  await fs.mkdir(path.join(f.root, 'plugins'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'plugins/marketplace-source.json'), JSON.stringify({ catalog: { version } }));
  const options = { ...f.options, releaseRoot: path.join(f.root, '.release'), axes: { cli: false, catalog: true },
    assertClean: async () => {}, resolveHead: async () => 'a'.repeat(40),
    resolveCandidates: async () => ({ cli: null, catalog: version }),
    prepareCatalog: async (_mode, call) => {
      assert.match(call.cliDistRoot, /node_modules/u);
      await fs.mkdir(attemptRoot, { recursive: true });
      await fs.writeFile(path.join(attemptRoot, 'journal.json'), JSON.stringify(plan));
      return plan;
    },
  };
  const descriptor = await prepareLocalRelease('beta', options);
  const forbiddenSelection = async () => { throw new Error('Floating tag moved or is unavailable'); };
  const recoveryOptions = { ...options, prepareCatalogToolchain: forbiddenSelection, captureCommand: forbiddenSelection,
    commitMetadata: async () => null,
    prepareCatalogMetadata: async (_parsed, call) => {
      assert.equal(call.selectedCatalogToolchain.toolchain.version, '2.3.4-beta.8');
      return { version, candidate: version, commit: null };
    },
    publish: async (call) => (await readPreparedDescriptor(call)).descriptor,
  };
  return { ...f, descriptor, version, attemptRoot, recoveryOptions };
}

// Test Value Gate: use the public local release entry after a saved plan exists.
// A moved/unreadable tag must not change the CLI used to resume that plan.
test('local Catalog rerun uses the original five prepared tools without a floating registry query', async (t) => {
  const f = await pendingCatalog(t);
  const before = f.reads.length;
  const result = await runRelease(['beta', '--catalog'], f.recoveryOptions);
  assert.equal(f.reads.length, before);
  assert.deepEqual(result.descriptor.catalog, f.descriptor.catalog);
  assert.equal(result.descriptor.catalog.toolchain.version, '2.3.4-beta.8');
});

test('local Catalog rerun refuses damaged or missing pending materials before selecting other tools', async (t) => {
  for (const damage of ['tool', 'descriptor', 'journal', 'plan']) {
    const f = await pendingCatalog(t);
    const prepared = path.join(f.root, '.release/prepared');
    if (damage === 'tool') await fs.appendFile(path.join(prepared, f.descriptor.catalog.tools[0].path), 'changed');
    if (damage === 'descriptor') await fs.rm(path.join(prepared, 'descriptor.json'));
    if (damage === 'journal') await fs.rm(path.join(f.attemptRoot, 'journal.json'));
    if (damage === 'plan') await fs.writeFile(path.join(f.attemptRoot, 'journal.json'), JSON.stringify({ state: 'uncertain', planDigest: digest('other-plan') }));
    const before = f.reads.length;
    await assert.rejects(runRelease(['beta', '--catalog'], f.recoveryOptions), /Increase the Catalog version/u);
    assert.equal(f.reads.length, before);
  }
});

async function pendingBatch(t) {
  const f = await fixture(t);
  const cliVersion = '2.3.4-beta.8';
  const catalogVersion = '4.5.6-beta.2';
  const head = 'a'.repeat(40);
  const plan = { catalogVersion, planDigest: digest('batch-plan'), state: 'prepared' };
  const releaseRoot = path.join(f.root, '.release');
  const snapshot = { generationId: 'fixture', inputDigest: 'input', outputDigest: 'output', cliPackageDigest: 'cli' };
  for (const [field, index] of [['evalPackageRoot', 1], ['corePackageRoot', 2], ['cliPackageRoot', 0]]) {
    const root = path.join(f.root, field);
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: TOOLCHAIN_PACKAGES[index], version: '2.3.4', dependencies: {} }));
    snapshot[field] = root;
  }
  const nativeRoot = path.join(f.root, 'native');
  await fs.mkdir(nativeRoot);
  for (const name of ['candidate.json', 'reproducibility.json', 'qualification-x64.json', 'qualification-arm64.json']) {
    await fs.writeFile(path.join(nativeRoot, name), '{}');
  }
  await fs.mkdir(path.join(f.root, 'plugins'));
  await fs.writeFile(path.join(f.root, 'plugins/marketplace-source.json'), JSON.stringify({ catalog: { version: catalogVersion } }));
  const pack = (index) => async ({ destination }) => {
    const file = path.join(destination, `${index}.tgz`);
    await fs.writeFile(file, `${TOOLCHAIN_PACKAGES[index]}@${cliVersion}`);
    return file;
  };
  let completion = 'missing';
  let completionReads = 0;
  let catalogWrites = 0;
  const options = { ...f.options, releaseRoot, axes: { cli: true, catalog: true },
    assertToolchainCompletion: undefined,
    assertClean: async () => {}, assertTargetsMatchHead: async () => {}, resolveHead: async () => head,
    readTargets: async () => ({ schemaVersion: 2, cli: '2.3.4' }),
    assertPackageVersions: async () => ({ targetVersion: '2.3.4' }),
    resolveCandidates: async (_channel, _targets, call) => ({ cli: call.axes.cli ? cliVersion : null, catalog: call.axes.catalog ? catalogVersion : null }),
    withSnapshot: async (callback) => callback(snapshot),
    prepareWindowsJobTarballs: async ({ destination }) => ({ root: nativeRoot, tarballPaths: await Promise.all([pack(3)({ destination }), pack(4)({ destination })]) }),
    // Fixture bytes and reports exercise release recovery, not native qualification or package installation.
    assertWindowsJobCandidateEvidence: async () => {},
    packEval: pack(1), packCore: pack(2), packCli: pack(0), computeTarballTreeDigest: async (file) => digest(await fs.readFile(file)),
    readPackageVersions: async () => [], readPackageChannelVersion: async () => null, assertCliTagAvailable: async () => {},
    assertPublishedCliArtifactsMatch: async () => {},
    runNpmCommand: async () => { throw new Error('CLI publish failed'); },
    publishCliTag: async () => { completion = 'complete'; },
    prepareCatalog: async () => {
      const root = path.join(f.root, '.aw/publish', catalogVersion);
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, 'journal.json'), JSON.stringify(plan));
      return plan;
    },
    publishCatalog: async (_request, call) => { await call.beforeRemoteWrite?.('catalog'); catalogWrites += 1; },
    runGit: async (args) => {
      const ref = `refs/tags/cli-v${cliVersion}`;
      assert.deepEqual(args, ['ls-remote', 'origin', ref, `${ref}^{}`]);
      completionReads += 1;
      if (completion === 'read-failed') throw new Error('Completion query unavailable');
      if (completion === 'missing' || (completion === 'lost-before-replace' && completionReads > 1)) return { stdout: '' };
      const completedHead = completion === 'conflict' ? 'b'.repeat(40) : head;
      return { stdout: `${'c'.repeat(40)}\t${ref}\n${completedHead}\t${ref}^{}\n` };
    },
  };
  const descriptor = await prepareLocalRelease('beta', options);
  assert.equal(descriptor.axes.cli, true);
  assert.equal(descriptor.catalog.toolchain.source, 'candidate');
  const forbiddenSelection = async () => { throw new Error('Floating registry queries are forbidden during recovery'); };
  const recoveryOptions = { ...options, captureCommand: forbiddenSelection, prepareCatalogToolchain: forbiddenSelection,
    commitMetadata: async () => null,
    prepareCatalogMetadata: async () => ({ version: catalogVersion, candidate: catalogVersion, commit: null }),
  };
  const repairFiles = async () => {
    const files = {};
    const walk = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else files[path.relative(releaseRoot, file)] = (await fs.readFile(file)).toString('base64');
      }
    };
    await walk(path.join(releaseRoot, 'prepared'));
    files['attempted.json'] = await fs.readFile(path.join(releaseRoot, 'attempted.json'), 'base64');
    return files;
  };
  return { ...f, options, recoveryOptions, descriptor, repairFiles,
    setCompletion: (value) => { completion = value; completionReads = 0; },
    catalogWrites: () => catalogWrites, completionReads: () => completionReads };
}

// Test Value Gate: the public recovery entry must preserve the exact CLI repair
// material when an all-products candidate has not completed its CLI publication.
test('local Catalog recovery blocks unfinished batch CLI and preserves every repair file', async (t) => {
  const f = await pendingBatch(t);
  await assert.rejects(publishPreparedRelease(f.options), /publish failed or its result is uncertain/u);
  const original = await f.repairFiles();
  for (const completion of ['missing', 'conflict', 'read-failed', 'lost-before-replace']) {
    f.setCompletion(completion);
    await assert.rejects(runRelease(['beta', '--catalog'], f.recoveryOptions), /repair the CLI first/u);
    assert.deepEqual(await f.repairFiles(), original);
    await assertPreparedCliAttempt(f.descriptor, f.options);
    assert.equal(f.catalogWrites(), 0);
    assert.ok(f.completionReads() > 0);
  }
  assert.equal(f.reads.length, 0);
});

test('completed batch CLI permits same-plan Catalog recovery and remains required at its publisher', async (t) => {
  const f = await pendingBatch(t);
  await assert.rejects(publishPreparedRelease({ ...f.options, runNpmCommand: async () => {},
    publishCatalog: async () => { throw new Error('Catalog write failed after CLI completion'); },
  }), /Catalog write failed/u);
  const result = await runRelease(['beta', '--catalog'], f.recoveryOptions);
  assert.deepEqual(result.descriptor.catalog, f.descriptor.catalog);
  assert.equal(result.descriptor.axes.cli, false);
  assert.equal(f.catalogWrites(), 1);
  assert.equal(f.reads.length, 0);
  assert.ok(f.completionReads() >= 3);

  f.setCompletion('missing');
  await assert.rejects(publishPreparedRelease(f.recoveryOptions), /repair the CLI first/u);
  assert.equal(f.catalogWrites(), 1);
  const { root, descriptor } = await readPreparedDescriptor(f.recoveryOptions);
  delete descriptor.catalog.toolchain.candidateHead;
  await fs.writeFile(path.join(root, 'descriptor.json'), JSON.stringify(descriptor));
  f.setCompletion('complete');
  await assert.rejects(publishPreparedRelease(f.recoveryOptions), /exact CLI candidate head/u);
  assert.equal(f.completionReads(), 0);
  assert.equal(f.catalogWrites(), 1);
});
