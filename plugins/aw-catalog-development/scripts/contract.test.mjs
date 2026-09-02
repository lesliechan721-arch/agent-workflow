import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? localRoot;
const runtimeRoot = context?.platform ? path.join(localRoot, context.platform) : localRoot;
const repoRoot = path.resolve(sourceRoot, '..', '..');
const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const execFileAsync = promisify(execFile);
const declaredCapabilities = [
  'aw.catalog-authoring.v1',
  'aw.catalog-dev-source.v1',
  'aw.catalog-publication.v1',
  'aw.plugin-authoring.v1',
  'aw.self-check.v1',
];

async function readCaseDocument(skill, name) {
  return JSON.parse(await readFile(path.join(
    sourceRoot,
    'skills',
    skill,
    'evals',
    `${name}-cases.json`,
  ), 'utf8'));
}

async function readRuntimeSkill(skill, relative = 'SKILL.md') {
  return readFile(path.join(runtimeRoot, 'skills', skill, relative), 'utf8');
}

function commandLines(skill) {
  return skill.match(/^aw .+$/gmu) ?? [];
}

async function materializeWorkspaceFiles(root, workspaceFiles) {
  for (const [relativePath, content] of Object.entries(workspaceFiles)) {
    assert.equal(path.isAbsolute(relativePath), false, `${relativePath} must be relative`);
    assert.equal(relativePath.includes('\\'), false, `${relativePath} must be POSIX`);
    assert.equal(relativePath.split('/').includes('..'), false, `${relativePath} must not escape`);
    const target = path.resolve(root, relativePath);
    assert.ok(target.startsWith(`${root}${path.sep}`), `${relativePath} must stay in the fixture`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

async function snapshotTree(root) {
  const snapshot = {};
  async function visit(current, prefix = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${relativePath}/`] = 'directory';
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        snapshot[relativePath] = createHash('sha256').update(await readFile(absolutePath)).digest('hex');
      } else if (entry.isSymbolicLink()) {
        snapshot[relativePath] = `symlink:${await readlink(absolutePath)}`;
      } else {
        snapshot[relativePath] = 'other';
      }
    }
  }
  await visit(root);
  return snapshot;
}

function parseSingleJson(stdout, label) {
  const trimmed = stdout.trim();
  assert.notEqual(trimmed, '', `${label} must return JSON`);
  return JSON.parse(trimmed);
}

async function runCli(args, cwd, env = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cliEntry, ...args], {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, ...result };
  } catch (error) {
    if (typeof error?.code !== 'number') throw error;
    return {
      exitCode: error.code,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function runEvalFixture(options) {
  const runOwnedBin = await mkdtemp(path.join(os.tmpdir(), 'aw-eval-owned-bin-'));
  const runOwnedAw = path.join(runOwnedBin, 'aw');
  await writeFile(runOwnedAw, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cliEntry)}, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});
if (result.error) {
  process.stderr.write(\`${'${result.error.message}'}\\n\`);
  process.exit(9);
}
process.exit(result.status ?? 9);
`, 'utf8');
  await chmod(runOwnedAw, 0o755);
  try {
    return await runCliThroughFixture({ ...options, runOwnedBin });
  } finally {
    await rm(runOwnedBin, { recursive: true, force: true });
  }
}

async function runCliThroughFixture(options) {
  try {
    const result = await execFileAsync(process.execPath, [options.fixture, ...options.args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATH: [path.dirname(options.fixture), options.runOwnedBin, process.env.PATH ?? '']
          .join(path.delimiter),
        AW_HOME: path.join(options.fixtureHome, 'aw'),
        AW_CODEX_HOME: path.join(options.fixtureHome, 'codex'),
        AW_CLAUDE_HOME: path.join(options.fixtureHome, 'claude'),
        TMPDIR: options.fixtureHome,
        TMP: options.fixtureHome,
        TEMP: options.fixtureHome,
        GIT_OPTIONAL_LOCKS: '0',
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, ...result };
  } catch (error) {
    if (typeof error?.code !== 'number') throw error;
    return {
      exitCode: error.code,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function commitFixture(root) {
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=AW Eval Fixture',
    '-c', 'user.email=aw-eval@example.invalid',
    'commit', '--quiet', '--no-verify', '-m', 'Materialize Eval fixture',
  ], { cwd: root });
}

test('manifest exposes the complete runtime capability contract', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.name, 'aw-catalog-development');
  assert.deepEqual(manifest.dependencies, ['aw-plugin-development']);
  assert.deepEqual(manifest.requires.aw.capabilities, declaredCapabilities);

  const result = await runCli([
    'plugin', 'requirements', sourceRoot, '--workspace-root', repoRoot, '--json',
  ], repoRoot);
  assert.equal(result.exitCode, 0, result.stderr);
  const receipt = parseSingleJson(result.stdout, 'plugin requirements');
  assert.deepEqual(receipt.declared, declaredCapabilities);
  assert.deepEqual(receipt.unsupportedByCurrentAw, []);
  assert.ok(receipt.detected.every((capability) => declaredCapabilities.includes(capability)));
  assert.ok(declaredCapabilities.every((capability) => receipt.effective.includes(capability)));
});

test('each materialized Skill starts AW work with self check', async () => {
  const skills = await Promise.all([
    readRuntimeSkill('author-aw-catalog'),
    readRuntimeSkill('review-aw-catalog'),
    readRuntimeSkill('publish-aw-catalog'),
  ]);

  // docs/testing.md Test Value Gate static exception: an installed Skill must stop before any unsupported AW command; this package test has no model tool session before the first command.
  for (const skill of skills) {
    assert.equal(commandLines(skill)[0], 'aw self check --from <skill-root> --json');
  }
});

test('Eval suites are minimal, distinct, and structurally observable', async () => {
  const expectedCounts = {
    'author-aw-catalog': { trigger: 4, behavior: 2 },
    'review-aw-catalog': { trigger: 4, behavior: 4 },
    'publish-aw-catalog': { trigger: 3, behavior: 4 },
  };
  assert.equal(
    Object.values(expectedCounts).reduce((total, counts) => total + counts.trigger + counts.behavior, 0),
    21,
  );
  for (const [skill, counts] of Object.entries(expectedCounts)) {
    for (const [kind, count] of Object.entries(counts)) {
      const document = await readCaseDocument(skill, kind);
      assert.equal(document.version, 1);
      assert.equal(document.suite.kind, kind === 'behavior' ? 'conversation' : 'trigger');
      assert.equal(document.suite.unitUnderTest, skill);
      assert.equal(document.cases.length, count);
      assert.equal(new Set(document.cases.map((entry) => entry.id)).size, count);
      for (const entry of document.cases) {
        assert.equal(entry.split, 'validation');
        assert.ok(Array.isArray(entry.tags) && entry.tags.length > 0);
        if (kind === 'trigger') {
          assert.match(entry.id, /^[a-z0-9][a-z0-9_]*$/u);
          assert.ok(entry.input?.expected?.loadedSkills?.length > 0);
        } else {
          assert.ok(typeof entry.prompt === 'string' && entry.prompt !== '');
          assert.ok(Array.isArray(entry.assertions) && entry.assertions.length > 0);
          for (const fixturePath of entry.input?.pathPrepend ?? []) {
            const fixture = path.join(sourceRoot, 'skills', skill, 'evals', fixturePath, 'aw');
            await assert.doesNotReject(readFile(fixture, 'utf8'));
          }
        }
        if (entry.tags.some((tag) => tag === 'boundary' || tag === 'regression')) {
          assert.ok(entry.audit?.rationale);
          assert.ok(entry.audit?.minimalCounterexample);
        }
        if (entry.tags.some((tag) => tag === 'release-critical' || tag === 'high-cost')) {
          assert.ok(entry.audit?.errorCost);
        }
      }
    }
  }
});

test('public Catalog commands auto-discover a Workspace and build schema 7', async () => {
  const document = await readCaseDocument('author-aw-catalog', 'behavior');
  const evalCase = document.cases.find((entry) => entry.id === 'maintain-plugin-and-aggregate');
  assert.ok(evalCase);
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-catalog-author-maintenance-'));
  try {
    await materializeWorkspaceFiles(root, evalCase.input.workspaceFiles);
    const nested = path.join(root, 'plugins', 'shared-rules');
    const status = await runCli(['catalog', 'status', '--json'], nested);
    assert.equal(status.exitCode, 0, status.stderr);
    const statusReceipt = parseSingleJson(status.stdout, 'auto-discovered status');
    assert.equal(await realpath(statusReceipt.workspaceRoot), await realpath(root));
    assert.notEqual(statusReceipt.workspaceRootResolvedFrom, 'explicit');
    assert.deepEqual(statusReceipt.plugins.map((plugin) => plugin.name), ['shared-rules']);

    const build = await runCli(['catalog', 'build', '--json'], nested);
    assert.equal(build.exitCode, 0, build.stderr);
    const buildReceipt = parseSingleJson(build.stdout, 'auto-discovered build');
    assert.equal(await realpath(buildReceipt.workspaceRoot), await realpath(root));
    const snapshotPath = path.join(root, '.aw', 'catalog');
    const validation = await runCli(['catalog', 'validate', snapshotPath, '--json'], root);
    assert.equal(validation.exitCode, 0, validation.stderr);
    assert.equal(parseSingleJson(validation.stdout, 'schema 7 validation').ok, true);
    const manifest = JSON.parse(await readFile(path.join(snapshotPath, 'catalog-manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 7);
    assert.deepEqual(manifest.requires.aw.capabilities, ['aw.catalog-snapshot.v7']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Author safe-delete fixture preserves the canonical handoff boundary', async () => {
  const document = await readCaseDocument('author-aw-catalog', 'behavior');
  const evalCase = document.cases.find((entry) => entry.id === 'remove-last-plugin-safely');
  assert.ok(evalCase);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-catalog-author-delete-')));
  const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'aw-catalog-author-delete-home-'));
  const fixture = path.join(sourceRoot, 'skills', 'author-aw-catalog', 'evals', 'fixtures', 'bin', 'aw');
  try {
    await materializeWorkspaceFiles(root, evalCase.input.workspaceFiles);
    await commitFixture(root);
    const common = { fixture, cwd: root, fixtureHome };
    const self = await runEvalFixture({
      ...common,
      args: ['self', 'check', '--from', path.join(sourceRoot, 'skills', 'author-aw-catalog'), '--json'],
    });
    assert.equal(self.exitCode, 0, self.stderr);
    const beforeDelete = await runEvalFixture({
      ...common,
      args: ['catalog', 'status', '--workspace-root', root, '--json'],
    });
    assert.equal(beforeDelete.exitCode, 0, beforeDelete.stderr);
    const initialStatus = parseSingleJson(beforeDelete.stdout, 'pre-delete status');
    assert.deepEqual(initialStatus.plugins.map((plugin) => ({
      name: plugin.name,
      dependencies: plugin.dependencies,
    })), [{ name: 'legacy-rules', dependencies: [] }]);
    const removeHelp = await runEvalFixture({
      ...common,
      args: ['plugin', 'remove', '--help'],
    });
    assert.equal(removeHelp.exitCode, 0, removeHelp.stderr);
    const removal = await runEvalFixture({
      ...common,
      args: ['plugin', 'remove', 'legacy-rules', '--workspace-root', root, '--yes', '--json'],
    });
    assert.equal(removal.exitCode, 0, removal.stderr);
    assert.equal(parseSingleJson(removal.stdout, 'plugin removal').ok, true);
    const afterDelete = await runEvalFixture({
      ...common,
      args: ['catalog', 'status', '--workspace-root', root, '--json'],
    });
    assert.equal(afterDelete.exitCode, 0, afterDelete.stderr);
    assert.deepEqual(parseSingleJson(afterDelete.stdout, 'post-delete status').plugins, []);
    const build = await runEvalFixture({
      ...common,
      args: ['catalog', 'build', '--workspace-root', root, '--json'],
    });
    assert.equal(build.exitCode, 0, build.stderr);
    const validation = await runEvalFixture({
      ...common,
      args: ['catalog', 'validate', path.join(root, '.aw', 'catalog'), '--json'],
    });
    assert.equal(validation.exitCode, 0, validation.stderr);
    const trace = (await readFile(path.join(root, 'fixtures', 'author-trace.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line).command);
    assert.deepEqual(trace, [
      'self check',
      'catalog status',
      'plugin remove',
      'plugin remove',
      'catalog status',
      'catalog build',
      'catalog validate',
    ]);
    const postDeleteStatus = trace.lastIndexOf('catalog status');
    assert.deepEqual(trace.slice(postDeleteStatus + 1), ['catalog build', 'catalog validate']);
    const manifest = JSON.parse(await readFile(path.join(root, '.aw', 'catalog', 'catalog-manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 7);
    assert.deepEqual(manifest.entries, []);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(fixtureHome, { recursive: true, force: true }),
    ]);
  }
});

test('Reviewer fixtures produce all four static snapshot states without writes', async () => {
  const document = await readCaseDocument('review-aw-catalog', 'behavior');
  const expectations = new Map([
    ['absent-snapshot-at-canonical-target', { state: 'absent', valid: false, matches: null }],
    ['current-snapshot-evidence', { state: 'current', valid: true, matches: true }],
    ['stale-snapshot-evidence', { state: 'stale', valid: true, matches: false }],
    ['invalid-snapshot-evidence', { state: 'invalid', valid: false, matches: null }],
  ]);
  assert.deepEqual(document.cases.map((entry) => entry.id).sort(), [...expectations.keys()].sort());

  for (const evalCase of document.cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `aw-catalog-review-${evalCase.id}-`));
    try {
      await materializeWorkspaceFiles(root, evalCase.input.workspaceFiles);
      const workspaceRoot = evalCase.id === 'absent-snapshot-at-canonical-target'
        ? path.join(root, 'targets', 'catalog-b')
        : root;
      const before = await snapshotTree(root);
      const status = await runCli(['catalog', 'status', '--workspace-root', workspaceRoot, '--json'], root, {
        GIT_OPTIONAL_LOCKS: '0',
      });
      assert.equal(status.exitCode, 0, `${evalCase.id}: ${status.stderr}`);
      const receipt = parseSingleJson(status.stdout, `${evalCase.id}: status`);
      const expected = expectations.get(evalCase.id);
      assert.equal(receipt.snapshot.state, expected.state);
      assert.equal(receipt.snapshot.valid, expected.valid);
      assert.equal(receipt.snapshot.sourceIdentityMatches, expected.matches);
      assert.equal(receipt.workspace.valid, true);

      if (expected.state !== 'absent') {
        const validation = await runCli(['catalog', 'validate', receipt.snapshot.path, '--json'], root);
        assert.equal(validation.exitCode, expected.state === 'invalid' ? 1 : 0);
        assert.equal(parseSingleJson(validation.stdout, `${evalCase.id}: validate`).ok, expected.state !== 'invalid');
      }
      assert.deepEqual(await snapshotTree(root), before, `${evalCase.id}: Reviewer command changed the fixture`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('Publisher fixture implements current plan and apply receipts', async () => {
  const document = await readCaseDocument('publish-aw-catalog', 'behavior');
  const fixture = path.join(sourceRoot, 'skills', 'publish-aw-catalog', 'evals', 'fixtures', 'bin', 'aw');
  const planDigest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  for (const evalCase of document.cases) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `aw-catalog-publisher-${evalCase.id}-`)));
    const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'aw-catalog-publisher-home-'));
    try {
      await materializeWorkspaceFiles(root, evalCase.input.workspaceFiles);
      const common = { fixture, cwd: root, fixtureHome };
      const self = await runEvalFixture({
        ...common,
        args: ['self', 'check', '--from', path.join(sourceRoot, 'skills', 'publish-aw-catalog'), '--json'],
      });
      assert.equal(self.exitCode, 0, `${evalCase.id}: ${self.stderr}`);

      const plan = await runEvalFixture({
        ...common,
        args: [
          'catalog', 'publish', 'plan', '--workspace-root', '.',
          '--remote', 'staging', '--branch', 'catalogs/team', '--json',
        ],
      });
      const planReceipt = parseSingleJson(plan.stdout, `${evalCase.id}: plan`);
      assert.equal(plan.exitCode, 0, `${evalCase.id}: ${plan.stderr}`);
      assert.equal(planReceipt.command, 'catalog:publish:plan');
      assert.equal(planReceipt.ok, true);
      assert.equal(planReceipt.planDigest, planDigest);
      assert.equal(planReceipt.state, evalCase.id === 'uncertain-same-plan-recovers' ? 'uncertain' : 'prepared');
      assert.deepEqual(Object.keys(planReceipt.descriptor).sort(), [
        'branch', 'parent', 'remote', 'schemaVersion', 'snapshotDigest', 'sourceHead', 'tag',
        'workspaceIdentity',
      ]);
      assert.match(planReceipt.descriptor.remote.identityDigest, /^sha256:[0-9a-f]{64}$/u);

      if (evalCase.id === 'authorization-refusal-has-no-apply') {
        assert.deepEqual(JSON.parse(await readFile(path.join(root, 'fixtures', 'publisher-state.json'), 'utf8')), {
          planCalls: 1,
          applyCalls: 0,
          state: 'prepared',
          lastPlanDigest: planDigest,
          reconciliation: null,
        });
        continue;
      }

      const apply = await runEvalFixture({
        ...common,
        args: [
          'catalog', 'publish', 'apply', '--workspace-root', planReceipt.workspaceRoot,
          '--remote', planReceipt.remote, '--branch', planReceipt.branch,
          '--expected-plan-digest', planReceipt.planDigest, '--yes', '--json',
        ],
      });
      if (evalCase.id === 'authorized-plan-drift-or-corrupt-pending-stops') {
        assert.equal(apply.exitCode, 1);
        const receipt = parseSingleJson(apply.stdout, `${evalCase.id}: apply`);
        assert.deepEqual(Object.keys(receipt).sort(), ['command', 'errors', 'ok']);
        assert.equal(receipt.command, 'catalog:publish:apply');
        assert.equal(receipt.ok, false);
        assert.match(receipt.errors[0].message, /bump Catalog version/u);
        assert.deepEqual(JSON.parse(await readFile(path.join(root, 'fixtures', 'publisher-state.json'), 'utf8')), {
          planCalls: 1,
          applyCalls: 1,
          state: 'prepared',
          lastPlanDigest: planDigest,
          authorizedPlanDigest: planDigest,
          pendingPlanDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
          reconciliation: null,
          stopReason: 'plan-drift-or-corrupt-pending',
          requiresVersionBump: true,
        });
        const trace = (await readFile(path.join(root, 'fixtures', 'publisher-trace.jsonl'), 'utf8'))
          .trim().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(trace.map((entry) => entry.command), [
          'self check',
          'catalog publish plan',
          'catalog publish apply',
        ]);
        assert.equal(
          trace[2].args[trace[2].args.indexOf('--expected-plan-digest') + 1],
          planDigest,
        );
        continue;
      }
      assert.equal(apply.exitCode, 0, `${evalCase.id}: ${apply.stderr}`);
      const applyReceipt = parseSingleJson(apply.stdout, `${evalCase.id}: apply`);
      assert.equal(applyReceipt.command, 'catalog:publish:apply');
      assert.equal(applyReceipt.ok, true);
      assert.equal(applyReceipt.state, 'published');
      for (const field of [
        'workspaceRoot', 'workspaceIdentity', 'sourceHead', 'remote', 'branch',
        'snapshotDigest', 'planDigest',
      ]) assert.equal(applyReceipt[field], planReceipt[field], `${evalCase.id}: ${field}`);
      assert.equal(
        applyReceipt.reconciliation,
        evalCase.id === 'uncertain-same-plan-recovers' ? 'already-remote' : 'atomic',
      );
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(fixtureHome, { recursive: true, force: true }),
      ]);
    }
  }
});

test('every declared Eval Workspace passes public static and plugin validation', async () => {
  const groups = await Promise.all([
    readCaseDocument('author-aw-catalog', 'behavior'),
    readCaseDocument('review-aw-catalog', 'behavior'),
    readCaseDocument('publish-aw-catalog', 'behavior'),
  ]);
  for (const evalCase of groups.flatMap((document) => document.cases)) {
    const markers = Object.keys(evalCase.input.workspaceFiles)
      .filter((relativePath) => relativePath.endsWith('.aw-workspace.json'));
    if (markers.length === 0) continue;
    const root = await mkdtemp(path.join(os.tmpdir(), `aw-catalog-eval-valid-${evalCase.id}-`));
    try {
      await materializeWorkspaceFiles(root, evalCase.input.workspaceFiles);
      for (const marker of markers) {
        const workspaceRoot = path.dirname(path.join(root, marker));
        const status = await runCli(['catalog', 'status', '--workspace-root', workspaceRoot, '--json'], root);
        assert.equal(status.exitCode, 0, `${evalCase.id}/${marker}: ${status.stderr}`);
        const receipt = parseSingleJson(status.stdout, `${evalCase.id}/${marker}: status`);
        assert.equal(receipt.workspace.valid, true);
        assert.equal(receipt.catalog.valid, true);
        assert.equal(receipt.dependencyGraph.valid, true);
        for (const plugin of receipt.plugins) {
          const validation = await runCli([
            'plugin', 'validate', path.join(workspaceRoot, 'plugins', plugin.name),
            '--workspace-root', workspaceRoot, '--json',
          ], root);
          assert.equal(validation.exitCode, 0, `${evalCase.id}/${plugin.name}: ${validation.stderr}`);
          assert.equal(parseSingleJson(validation.stdout, `${evalCase.id}/${plugin.name}`).ok, true);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
