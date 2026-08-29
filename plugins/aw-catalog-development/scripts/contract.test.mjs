import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
const expectedDetectedCapabilities = [
  'aw.catalog-authoring.v1',
  'aw.catalog-context.v1',
  'aw.catalog-dev-source.v1',
  'aw.catalog-publication.v1',
  'aw.plugin-authoring.v1',
  'aw.self-check.v1',
];
const execFileAsync = promisify(execFile);

async function readBehaviorCases(skill) {
  return JSON.parse(await readFile(path.join(
    sourceRoot,
    'skills',
    skill,
    'evals',
    'behavior-cases.json',
  ), 'utf8')).evals;
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

function parseSingleJson(stdout, label) {
  const trimmed = stdout.trim();
  assert.notEqual(trimmed, '', `${label} must return JSON`);
  return JSON.parse(trimmed);
}

async function runEvalFixture(options) {
  try {
    const result = await execFileAsync(process.execPath, [options.fixture, ...options.args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        AW_PLUGIN_EVAL_CLI_NODE: process.execPath,
        AW_PLUGIN_EVAL_CLI_ENTRY: options.cliEntry,
        AW_HOME: path.join(options.cwd, '.fixture-home', 'aw'),
        AW_CODEX_HOME: path.join(options.cwd, '.fixture-home', 'codex'),
        AW_CLAUDE_HOME: path.join(options.cwd, '.fixture-home', 'claude'),
      },
      maxBuffer: 10 * 1024 * 1024,
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

function assertNoPrivatePublisherFields(receipt, label) {
  const serialized = JSON.stringify(receipt);
  for (const field of ['remoteWrites', 'attemptWritten', 'resultUnknown']) {
    assert.equal(serialized.includes(`\"${field}\"`), false, `${label}: ${field} is private`);
  }
}

async function commitFixture(root) {
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=AW Eval Fixture',
    '-c', 'user.email=aw-eval@example.invalid',
    'commit', '--no-verify', '-m', 'Materialize Eval fixture',
  ], { cwd: root });
}

async function readRuntimeSkill(skill, relative = 'SKILL.md') {
  return readFile(path.join(runtimeRoot, 'skills', skill, relative), 'utf8');
}

function commandLines(skill) {
  return skill.match(/^aw .+$/gmu) ?? [];
}

async function readRequirementsReceipt() {
  const repoRoot = path.resolve(sourceRoot, '..', '..');
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliEntry,
    'plugin',
    'requirements',
    sourceRoot,
    '--workspace-root',
    repoRoot,
    '--json',
  ], { cwd: repoRoot });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('manifest keeps only scanner-derived Catalog capability requirements', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.name, 'aw-catalog-development');
  assert.deepEqual(manifest.dependencies, ['aw-plugin-development']);

  const requirements = await readRequirementsReceipt();
  assert.deepEqual(requirements.declared, []);
  assert.deepEqual(requirements.detected, expectedDetectedCapabilities);
  assert.ok(expectedDetectedCapabilities.every((capability) => requirements.effective.includes(capability)));
  assert.deepEqual(requirements.unsupportedByCurrentAw, []);

  const pluginDevelopment = JSON.parse(await readFile(
    path.join(sourceRoot, '..', 'aw-plugin-development', '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(pluginDevelopment.dependencies.includes('aw-catalog-development'), false);
});

test('each Skill starts its AW workflow with the runtime compatibility check', async () => {
  const skills = await Promise.all([
    readRuntimeSkill('author-aw-catalog'),
    readRuntimeSkill('review-aw-catalog'),
    readRuntimeSkill('publish-aw-catalog'),
  ]);

  // Static contract exception: an installed Skill must stop before an unsupported AW command; behavior test is not suitable because this test only receives the final instruction package, not a model tool session.
  for (const skill of skills) {
    assert.equal(commandLines(skill)[0], 'aw self check --from <skill-root> --json');
    assert.match(skill, /missingCapabilities/u);
    assert.match(skill, /不添加 `--require`/u);
  }
});

test('Catalog author uses context and Catalog development-source commands', async () => {
  const author = await readRuntimeSkill('author-aw-catalog');

  // Static contract exception: these installed commands prevent a Catalog author from mutating a generic source; behavior test is not suitable because source mutation is intentionally outside this deterministic package test.
  assert.match(author, /aw catalog context \[--workspace-root <target-root>\] --json/u);
  assert.match(author, /用户明确的 Workspace root.*canonical.*上游 handoff.*current Workspace/su);
  assert.match(author, /receipt 的 `workspace\.root` 必须与 target 或 handoff path 一致/u);
  assert.match(author, /只在 root 缺失或歧义时询问/u);
  assert.match(author, /initialization\.suggestedRoot/u);
  assert.match(author, /aw catalog dev activate --workspace-root <workspace\.root> --json/u);
  assert.match(author, /aw catalog dev status --workspace-root <workspace\.root> --json/u);
  assert.match(author, /`ok` 和 `ready` 都为 `true`/u);
  assert.match(author, /`ok: false` 是诊断失败/u);
  assert.match(author, /`ok: true, ready: false`/u);
  assert.match(author, /catalog dev deactivate/u);
  assert.doesNotMatch(author, /aw catalog source/u);
  assert.match(author, /受影响插件及其反向依赖闭包/u);
  assert.match(author, /aw catalog build --workspace-root <workspace\.root> --json/u);
  assert.match(author, /aw catalog validate <workspace\.root>\/\.aw\/catalog --json/u);
});

test('Catalog reviewer only consumes static context, status, and an existing snapshot', async () => {
  const reviewer = await readRuntimeSkill('review-aw-catalog');

  // Static contract exception: these installed prohibitions preserve the Review read-only boundary; behavior test is not suitable because executing a prohibited command would itself violate that boundary.
  assert.match(reviewer, /aw catalog context \[--workspace-root <target-root>\] --json/u);
  assert.match(reviewer, /用户明确的 Workspace root.*canonical.*上游 handoff.*current Workspace/su);
  assert.match(reviewer, /receipt 的 `workspace\.root` 必须与 target 或 handoff path 一致/u);
  assert.match(reviewer, /只在 root 缺失或歧义时询问/u);
  assert.match(reviewer, /aw catalog status --workspace-root <workspace\.root> --json/u);
  assert.match(reviewer, /absent.*current.*stale.*invalid/u);
  assert.match(reviewer, /aw catalog validate <snapshot\.path> --json/u);
  assert.match(reviewer, /不运行 plugin test\/build、catalog build、`catalog status --preflight`、publish 或其它 mutation/u);
});

test('explicit-target behavior fixture keeps context and status on Workspace B instead of cwd A', async () => {
  const repoRoot = path.resolve(sourceRoot, '..', '..');
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  const evalCase = (await readBehaviorCases('review-aw-catalog'))
    .find((entry) => entry.id === 'explicit-plugin-target-keeps-workspace-b');
  assert.ok(evalCase);
  const cwdRoot = await mkdtemp(path.join(os.tmpdir(), 'aw-catalog-target-a-'));
  try {
    await materializeWorkspaceFiles(cwdRoot, evalCase.workspace_files);
    const targetRoot = path.join(cwdRoot, 'targets', 'catalog-b');
    const cwdContext = await execFileAsync(process.execPath, [
      cliEntry, 'catalog', 'context', '--json',
    ], { cwd: cwdRoot, maxBuffer: 10 * 1024 * 1024 });
    assert.equal(
      parseSingleJson(cwdContext.stdout, 'cwd context').workspace.root,
      await realpath(cwdRoot),
      'no-argument context resolves Workspace A',
    );

    const targetContext = await execFileAsync(process.execPath, [
      cliEntry, 'catalog', 'context', '--workspace-root', targetRoot, '--json',
    ], { cwd: cwdRoot, maxBuffer: 10 * 1024 * 1024 });
    const targetReceipt = parseSingleJson(targetContext.stdout, 'target context');
    assert.equal(targetReceipt.workspace.root, path.resolve(targetRoot));

    const status = await execFileAsync(process.execPath, [
      cliEntry,
      'catalog',
      'status',
      '--workspace-root', targetReceipt.workspace.root,
      '--json',
    ], { cwd: cwdRoot, maxBuffer: 10 * 1024 * 1024 });
    const statusReceipt = parseSingleJson(status.stdout, 'target status');
    assert.equal(
      await realpath(statusReceipt.workspace.root),
      await realpath(targetRoot),
      'the follow-up command stays on Workspace B',
    );
    assert.deepEqual(statusReceipt.plugins.map((plugin) => plugin.name), ['worker']);
  } finally {
    await rm(cwdRoot, { recursive: true, force: true });
  }
});

test('Catalog publisher preflights and binds the user authorization to the receipt', async () => {
  const [publisher, metadata] = await Promise.all([
    readRuntimeSkill('publish-aw-catalog'),
    readRuntimeSkill('publish-aw-catalog', 'agents/openai.yaml'),
  ]);

  // Static contract exception: the final publication command and receipt fields are user-facing authorization controls; behavior test is not suitable because it would perform remote publication.
  assert.doesNotMatch(publisher, /^disable-model-invocation:/mu);
  assert.match(metadata, /^\s*allow_implicit_invocation: true$/mu);
  assert.match(publisher, /普通修改、build、验证或只读 Review 不使用/u);
  assert.match(publisher, /aw catalog context --json/u);
  assert.match(publisher, /--workspace-root <user\.root>/u);
  assert.match(publisher, /--remote <user\.remote>/u);
  assert.match(publisher, /--branch <user\.branch>/u);
  assert.match(publisher, /aw catalog context --workspace-root <selected\.workspaceRoot>/u);
  assert.match(publisher, /--remote <selected\.remote> --branch <selected\.branch> --json/u);
  assert.match(publisher, /丢弃先前 context receipt，只消费这个新 receipt/u);
  assert.match(publisher, /--workspace-root <context\.workspace\.root>/u);
  assert.match(publisher, /--remote <context\.publication\.remote>/u);
  assert.match(publisher, /--branch <context\.publication\.branch> --preflight --json/u);
  assert.match(publisher, /绝对 `workspace\.root`、`publication\.remote`、`publication\.branch` 和 `publication\.descriptorDigest`/u);
  assert.match(publisher, /仅对这一次 identity 明确授权/u);
  assert.match(publisher, /--workspace-root <preflight\.workspace\.root>/u);
  assert.match(publisher, /--remote <preflight\.publication\.remote>/u);
  assert.match(publisher, /--branch <preflight\.publication\.branch>/u);
  assert.match(publisher, /--expected-descriptor-digest <preflight\.publication\.descriptorDigest>/u);
  assert.match(publisher, /Catalog 不重试或 repair 同一 version/u);
  assert.doesNotMatch(publisher, /--branch catalog/u);
});

test('Author Eval fixture forwards local work to the run-owned AW CLI', async () => {
  const repoRoot = path.resolve(sourceRoot, '..', '..');
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  const fixture = path.join(sourceRoot, 'skills', 'author-aw-catalog', 'evals', 'fixtures', 'bin', 'aw');
  const initializeCase = (await readBehaviorCases('author-aw-catalog'))
    .find((entry) => entry.id === 'initialize-and-activate-development-source');
  assert.ok(initializeCase);
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-author-eval-real-cli-'));
  try {
    await materializeWorkspaceFiles(root, initializeCase.workspace_files);
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=AW Eval Fixture',
      '-c', 'user.email=aw-eval@example.invalid',
      'commit', '--no-verify', '-m', 'Initialize Author Eval fixture',
    ], { cwd: root });

    const self = await runEvalFixture({
      fixture, cliEntry, cwd: root,
      args: ['self', 'check', '--from', path.join(sourceRoot, 'skills', 'author-aw-catalog'), '--json'],
    });
    assert.equal(self.exitCode, 0, self.stderr);
    assert.equal(parseSingleJson(self.stdout, 'author self check').command, 'self:check');

    const before = await runEvalFixture({
      fixture, cliEntry, cwd: root, args: ['catalog', 'context', '--json'],
    });
    assert.equal(before.exitCode, 0, before.stderr);
    assert.equal(parseSingleJson(before.stdout, 'author context').workspace.found, false);

    const init = await runEvalFixture({
      fixture, cliEntry, cwd: root,
      args: [
        'catalog', 'init', '--workspace-root', root,
        '--owner-name', 'Fixture Owner',
        '--owner-url', 'https://example.invalid/catalog-owner',
        '--display-name', 'Author Runtime Fixture',
        '--json',
      ],
    });
    assert.equal(init.exitCode, 0, init.stderr);
    assert.equal(parseSingleJson(init.stdout, 'author init').ok, true);

    const build = await runEvalFixture({
      fixture, cliEntry, cwd: root,
      args: ['catalog', 'build', '--workspace-root', root, '--json'],
    });
    assert.equal(build.exitCode, 0, build.stderr);
    assert.deepEqual(parseSingleJson(build.stdout, 'author build'), {
      command: 'catalog:build',
      ok: true,
      workspaceRoot: root,
      workspaceRootResolvedFrom: 'explicit',
      outputRoot: path.join(await realpath(root), '.aw', 'catalog'),
      catalogVersion: '0.1.0',
      channel: 'latest',
      pluginNames: [],
    });
    const validate = await runEvalFixture({
      fixture, cliEntry, cwd: root,
      args: ['catalog', 'validate', path.join(root, '.aw', 'catalog'), '--json'],
    });
    assert.equal(validate.exitCode, 0, validate.stderr);
    assert.equal(parseSingleJson(validate.stdout, 'author validate').ok, true);
    const activate = await runEvalFixture({
      fixture, cliEntry, cwd: root,
      args: ['catalog', 'dev', 'activate', '--workspace-root', root, '--json'],
    });
    assert.equal(activate.exitCode, 0, activate.stderr);
    assert.equal(parseSingleJson(activate.stdout, 'author dev activate').ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Publisher Eval fixture separates public receipts from private remote evidence', async () => {
  const repoRoot = path.resolve(sourceRoot, '..', '..');
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  const fixture = path.join(sourceRoot, 'skills', 'publish-aw-catalog', 'evals', 'fixtures', 'bin', 'aw');
  const cases = await readBehaviorCases('publish-aw-catalog');
  const expectedPublishState = new Map([
    ['authorization-followed-by-descriptor-drift', {
      exitCode: 1, attemptState: 'none', remoteResult: 'not-started', ok: false,
    }],
    ['successful-authorized-publish', {
      exitCode: 0, attemptState: 'published', remoteResult: 'confirmed', ok: true,
    }],
    ['uncertain-remote-result-does-not-retry-version', {
      exitCode: 1, attemptState: 'attempted', remoteResult: 'unknown', ok: false,
    }],
  ]);

  for (const evalCase of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `aw-publisher-eval-${evalCase.id}-`));
    try {
      await materializeWorkspaceFiles(root, evalCase.workspace_files);
      await execFileAsync('git', ['init'], { cwd: root });
      const scenario = evalCase.workspace_files['fixtures/scenario.txt'].trim()
        .replace(/^scenario=/u, '');
      const isDefault = scenario === 'default-authorization';
      const remote = isDefault ? 'origin' : 'staging';
      const branch = isDefault ? 'catalog' : 'catalogs/team';

      const self = await runEvalFixture({
        fixture, cliEntry, cwd: root,
        args: ['self', 'check', '--from', path.join(sourceRoot, 'skills', 'publish-aw-catalog'), '--json'],
      });
      assert.equal(self.exitCode, 0, `${evalCase.id}: ${self.stderr}`);
      const selfReceipt = parseSingleJson(self.stdout, `${evalCase.id}: self check`);
      assert.equal(selfReceipt.command, 'self:check');
      assertNoPrivatePublisherFields(selfReceipt, `${evalCase.id}: self check`);

      const contextArgs = isDefault
        ? ['catalog', 'context', '--json']
        : ['catalog', 'context', '--remote', remote, '--branch', branch, '--json'];
      const context = await runEvalFixture({ fixture, cliEntry, cwd: root, args: contextArgs });
      assert.equal(context.exitCode, 0, context.stderr);
      const contextReceipt = parseSingleJson(context.stdout, `${evalCase.id}: context`);
      assert.equal(contextReceipt.schemaVersion, 2);
      assert.equal(contextReceipt.developmentSource.configured, false);
      assert.deepEqual(Object.keys(contextReceipt.developmentSource).sort(), [
        'configured', 'existingSourceId', 'snapshotPath', 'suggestedSourceId',
      ]);
      assert.deepEqual(Object.keys(contextReceipt).sort(), [
        'command', 'developmentSource', 'git', 'initialization', 'issues',
        'publication', 'schemaVersion', 'toolchain', 'workspace',
      ].sort());
      assertNoPrivatePublisherFields(contextReceipt, `${evalCase.id}: context`);
      const resolvedRoot = contextReceipt.workspace.root;

      const status = await runEvalFixture({
        fixture, cliEntry, cwd: root,
        args: [
          'catalog', 'status', '--workspace-root', resolvedRoot,
          '--remote', remote, '--branch', branch, '--preflight', '--json',
        ],
      });
      const statusReceipt = parseSingleJson(status.stdout, `${evalCase.id}: status`);
      assert.equal(status.exitCode, scenario === 'preflight-failure' ? 1 : 0);
      assert.deepEqual(Object.keys(statusReceipt).sort(), [
        'catalog', 'command', 'dependencyGraph', 'git', 'issues', 'ok', 'plugins',
        'publication', 'schemaVersion', 'snapshot', 'workspace', 'workspaceRoot',
        'workspaceRootResolvedFrom',
      ].sort());
      assert.equal(statusReceipt.schemaVersion, 2);
      assert.equal(statusReceipt.command, 'catalog:status');
      assert.equal(statusReceipt.ok, scenario !== 'preflight-failure');
      assertNoPrivatePublisherFields(statusReceipt, `${evalCase.id}: status`);

      const publishExpectation = expectedPublishState.get(evalCase.id);
      if (!publishExpectation) {
        const trace = await readFile(path.join(root, 'fixtures', 'publisher-trace.jsonl'), 'utf8');
        assert.doesNotMatch(trace, /"command":"catalog publish"/u);
        continue;
      }
      const publish = await runEvalFixture({
        fixture, cliEntry, cwd: root,
        args: [
          'catalog', 'publish', '--workspace-root', resolvedRoot,
          '--remote', remote, '--branch', branch,
          '--expected-descriptor-digest', statusReceipt.publication.descriptorDigest,
          '--yes', '--json',
        ],
      });
      assert.equal(publish.exitCode, publishExpectation.exitCode);
      const publishReceipt = parseSingleJson(publish.stdout, `${evalCase.id}: publish`);
      assert.equal(publishReceipt.command, 'catalog:publish');
      assert.equal(publishReceipt.ok, publishExpectation.ok);
      assert.deepEqual(
        Object.keys(publishReceipt).sort(),
        publishExpectation.ok
          ? [
              'branch', 'branchResolvedFrom', 'catalogVersion', 'channel', 'command', 'commit',
              'descriptorDigest', 'fetchUrl', 'ok', 'parent', 'planId', 'pluginCount',
              'pushUrl', 'remote', 'remoteResolvedFrom', 'remoteUrl', 'snapshotDigest',
              'sourceHead', 'tag', 'workspaceIdentity', 'workspaceRoot',
              'workspaceRootResolvedFrom',
            ].sort()
          : ['command', 'errors', 'ok'],
      );
      assertNoPrivatePublisherFields(publishReceipt, `${evalCase.id}: publish`);
      const state = JSON.parse(await readFile(path.join(root, 'fixtures', 'publisher-state.json'), 'utf8'));
      assert.deepEqual(state, {
        publishCalls: 1,
        catalogVersion: '0.4.0',
        attemptState: publishExpectation.attemptState,
        remoteResult: publishExpectation.remoteResult,
        sameVersionRetry: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('workspace_valid Eval fixtures pass the public Catalog and plugin preflight', async () => {
  const repoRoot = path.resolve(sourceRoot, '..', '..');
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  const owningValidation = await execFileAsync(process.execPath, [
    cliEntry,
    'plugin',
    'validate',
    sourceRoot,
    '--workspace-root', repoRoot,
    '--json',
  ], { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(owningValidation.stderr, '', 'owning plugin validate stderr');
  assert.equal(
    parseSingleJson(owningValidation.stdout, 'owning plugin validate').ok,
    true,
    'owning plugin must pass its public validator before fixture preflight',
  );
  const expectedReviewerSnapshots = new Map([
    ['dirty-workspace-remains-static-reviewable', {
      state: 'absent', valid: false, sourceIdentityMatches: null,
    }],
    ['current-snapshot-is-existing-positive-evidence', {
      state: 'current', valid: true, sourceIdentityMatches: true,
    }],
    ['stale-snapshot-is-not-current-evidence', {
      state: 'stale', valid: true, sourceIdentityMatches: false,
    }],
  ]);
  const caseGroups = await Promise.all([
    readBehaviorCases('author-aw-catalog'),
    readBehaviorCases('review-aw-catalog'),
    readBehaviorCases('publish-aw-catalog'),
  ]);
  assert.deepEqual(
    caseGroups[1]
      .filter((entry) => entry.preconditions?.workspace_valid === true)
      .map((entry) => entry.id)
      .sort(),
    [...expectedReviewerSnapshots.keys()].sort(),
    'Reviewer workspace_valid case IDs must have explicit snapshot expectations',
  );
  const cases = caseGroups.flat()
    .filter((entry) => entry.preconditions?.workspace_valid === true);
  assert.ok(cases.length > 0, 'at least one Eval fixture must declare workspace_valid=true');

  for (const evalCase of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `aw-catalog-eval-${evalCase.id}-`));
    try {
      await materializeWorkspaceFiles(root, evalCase.workspace_files);
      const expectedPluginNames = Object.keys(evalCase.workspace_files)
        .map((relativePath) => relativePath.match(/^plugins\/([^/]+)\/\.agents-plugin\/plugin\.json$/u)?.[1])
        .filter((name) => name !== undefined)
        .sort();
      await commitFixture(root);
      const status = await execFileAsync(process.execPath, [
        cliEntry,
        'catalog',
        'status',
        '--workspace-root', root,
        '--json',
      ], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
      assert.equal(status.stderr, '', `${evalCase.id}: catalog status stderr`);
      const statusReceipt = parseSingleJson(status.stdout, `${evalCase.id}: catalog status`);
      assert.equal(statusReceipt.ok, true, `${evalCase.id}: catalog status ok`);
      assert.equal(statusReceipt.workspace?.valid, true, `${evalCase.id}: workspace valid`);
      assert.equal(statusReceipt.catalog?.valid, true, `${evalCase.id}: catalog valid`);
      assert.equal(statusReceipt.dependencyGraph?.valid, true, `${evalCase.id}: dependency graph valid`);
      const expectedSnapshot = expectedReviewerSnapshots.get(evalCase.id);
      if (expectedSnapshot) {
        assert.equal(
          statusReceipt.snapshot?.state,
          expectedSnapshot.state,
          `${evalCase.id}: exact snapshot state`,
        );
        assert.equal(
          statusReceipt.snapshot?.valid,
          expectedSnapshot.valid,
          `${evalCase.id}: exact snapshot validity`,
        );
        assert.equal(
          statusReceipt.snapshot?.sourceIdentityMatches,
          expectedSnapshot.sourceIdentityMatches,
          `${evalCase.id}: exact source identity match`,
        );
      }
      assert.deepEqual(
        (statusReceipt.plugins ?? []).map((plugin) => plugin.name).sort(),
        expectedPluginNames,
        `${evalCase.id}: status inventories every declared plugin`,
      );

      for (const pluginName of expectedPluginNames) {
        const plugin = statusReceipt.plugins.find((entry) => entry.name === pluginName);
        assert.ok(plugin, `${evalCase.id}/${pluginName}: plugin is in status`);
        assert.equal(plugin.sourceValid, true, `${evalCase.id}/${plugin.name}: source valid`);
        const validation = await execFileAsync(process.execPath, [
          cliEntry,
          'plugin',
          'validate',
          path.join(root, 'plugins', plugin.name),
          '--workspace-root', root,
          '--json',
        ], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
        assert.equal(validation.stderr, '', `${evalCase.id}/${plugin.name}: validate stderr`);
        const validationReceipt = parseSingleJson(
          validation.stdout,
          `${evalCase.id}/${plugin.name}: validate`,
        );
        assert.equal(validationReceipt.ok, true, `${evalCase.id}/${plugin.name}: validate ok`);
        assert.deepEqual(
          validationReceipt.unsupportedByCurrentAw ?? [],
          [],
          `${evalCase.id}/${plugin.name}: current AW capability support`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
