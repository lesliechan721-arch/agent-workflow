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
const expectedDeclaredCapabilities = [
  'aw.catalog-dev-source.v1',
  'aw.plugin-authoring.v1',
];
const expectedDetectedCapabilities = [
  'aw.catalog-authoring.v1',
  'aw.catalog-context.v1',
  'aw.catalog-publication.v1',
  'aw.self-check.v1',
];
const execFileAsync = promisify(execFile);

async function readBehaviorCases(skill) {
  const corpus = JSON.parse(await readFile(path.join(
    sourceRoot,
    'skills',
    skill,
    'evals',
    'behavior-cases.json',
  ), 'utf8'));
  assert.equal(corpus.version, 1);
  assert.equal(corpus.suite?.unitUnderTest, skill);
  assert.equal(Array.isArray(corpus.cases), true);
  return corpus.cases;
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

async function runEvalFixture(options) {
  const runOwnedBin = await mkdtemp(path.join(os.tmpdir(), 'aw-eval-run-owned-bin-'));
  const runOwnedAw = path.join(runOwnedBin, 'aw');
  const fixtureHome = options.fixtureHome ?? path.join(options.cwd, '.fixture-home');
  await writeFile(runOwnedAw, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(options.cliEntry)}, ...process.argv.slice(2)], {
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
    const result = await execFileAsync(process.execPath, [options.fixture, ...options.args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        PATH: [path.dirname(options.fixture), runOwnedBin, process.env.PATH ?? '']
          .join(path.delimiter),
        AW_HOME: path.join(fixtureHome, 'aw'),
        AW_CODEX_HOME: path.join(fixtureHome, 'codex'),
        AW_CLAUDE_HOME: path.join(fixtureHome, 'claude'),
        ...(options.tmpDir ? { TMPDIR: options.tmpDir, TMP: options.tmpDir, TEMP: options.tmpDir } : {}),
        GIT_OPTIONAL_LOCKS: '0',
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
  } finally {
    await rm(runOwnedBin, { recursive: true, force: true });
  }
}

test('Eval wrappers forward through PATH without private host CLI entry variables', async () => {
  const wrappers = await Promise.all([
    'author-aw-catalog',
    'publish-aw-catalog',
  ].map((skill) => readFile(path.join(
    sourceRoot,
    'skills',
    skill,
    'evals',
    'fixtures',
    'bin',
    'aw',
  ), 'utf8')));
  for (const wrapper of wrappers) {
    assert.doesNotMatch(wrapper, /AW_PLUGIN_EVAL_CLI_/u);
    assert.match(wrapper, /spawnSync\('aw', args/u);
    assert.match(wrapper, /PATH: forwardedPath/u);
  }
});

test('dependency aggregation trigger allows the required Plugin Author handoff', async () => {
  const evalRoot = path.join(sourceRoot, 'skills', 'author-aw-catalog', 'evals');
  const document = JSON.parse(await readFile(path.join(evalRoot, 'trigger-cases.json'), 'utf8'));
  const evalCase = document.cases.find((entry) => entry.id === 'catalog_dependency_update_requires_aggregation');
  assert.ok(evalCase);
  assert.deepEqual(evalCase.input.expected.loadedSkills, ['author-aw-catalog']);
  assert.equal(document.suite.runtime.forbidMultipleSkillLoads, true);
});

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

test('manifest declares inline-only commands and keeps hard evidence scanner-derived', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.name, 'aw-catalog-development');
  assert.deepEqual(manifest.dependencies, ['aw-plugin-development']);

  const requirements = await readRequirementsReceipt();
  assert.deepEqual(requirements.declared, expectedDeclaredCapabilities);
  assert.deepEqual(requirements.detected, expectedDetectedCapabilities);
  assert.ok([
    ...expectedDeclaredCapabilities,
    ...expectedDetectedCapabilities,
  ].every((capability) => requirements.effective.includes(capability)));
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
  assert.match(author, /合法 marker 使 `workspace\.found` 为 true/u);
  assert.match(author, /`workspace\.health` 为 `degraded` 时也保留该 root 和 identity 并进入修复/u);
  assert.match(author, /非阻断的 `workspace-content` 或 `development-source` issue/u);
  assert.match(author, /无关 publication issue 不阻止普通作者流程/u);
  assert.match(author, /initialization\.suggestedRoot/u);
  assert.match(author, /aw catalog dev activate --workspace-root <workspace\.root> --json/u);
  assert.match(author, /aw catalog dev status --workspace-root <workspace\.root> --json/u);
  assert.match(author, /`ok` 和 `ready` 都为 `true`/u);
  assert.match(author, /`ok: false` 是诊断失败/u);
  assert.match(author, /`ok: true, ready: false`/u);
  assert.match(author, /使用 activate receipt 的 `source\.id` 组成 `<source\.id>\/<plugin>`/u);
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
  assert.match(reviewer, /`workspace\.health` 为 `degraded` 时仍在该 root 完成可得的只读检查/u);
  assert.match(reviewer, /非阻断 `workspace-content` issue 作为 finding/u);
  assert.match(reviewer, /`development-source` 或无关 publication issue 不阻止/u);
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
    await materializeWorkspaceFiles(cwdRoot, evalCase.input.workspaceFiles);
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

test('degraded Review fixture keeps the legal Workspace identity in Context v3', async () => {
  const repoRoot = path.resolve(sourceRoot, '..', '..');
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  const evalCase = (await readBehaviorCases('review-aw-catalog'))
    .find((entry) => entry.id === 'degraded-workspace-remains-locatable');
  assert.ok(evalCase);
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-catalog-degraded-review-'));
  try {
    await materializeWorkspaceFiles(root, evalCase.input.workspaceFiles);
    const context = await execFileAsync(process.execPath, [
      cliEntry, 'catalog', 'context', '--workspace-root', root, '--json',
    ], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    const receipt = parseSingleJson(context.stdout, 'degraded review context');
    assert.equal(receipt.schemaVersion, 3);
    assert.equal(receipt.workspace.found, true);
    assert.equal(receipt.workspace.root, path.resolve(root));
    assert.equal(receipt.workspace.identity, 'degraded-review-fixture');
    assert.equal(receipt.workspace.health, 'degraded');
    assert.deepEqual(receipt.issues.map((issue) => [issue.scope, issue.blocking]), [
      ['workspace-content', false],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Catalog publisher preflights and binds the user authorization to the receipt', async () => {
  const [publisher, metadata, behaviorCases] = await Promise.all([
    readRuntimeSkill('publish-aw-catalog'),
    readRuntimeSkill('publish-aw-catalog', 'agents/openai.yaml'),
    readBehaviorCases('publish-aw-catalog'),
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
  assert.match(publisher, /存在 blocking publication issue 时，不进入 preflight/u);
  assert.match(publisher, /新 receipt 仍有 blocking issue 时停止/u);
  assert.match(publisher, /--workspace-root <context\.workspace\.root>/u);
  assert.match(publisher, /--remote <context\.publication\.remote>/u);
  assert.match(publisher, /--branch <context\.publication\.branch> --preflight --json/u);
  for (const field of [
    'workspace.root', 'workspace.identity', 'git.sourceHead', 'catalog.version',
    'publication.remote', 'publication.fetchUrl', 'publication.pushUrl',
    'publication.branch', 'publication.parent', 'publication.tag',
    'publication.snapshotDigest', 'publication.planId', 'publication.descriptorDigest',
  ]) {
    assert.ok(publisher.includes(`\`${field}\``), `Publisher must display ${field} before authorization.`);
  }
  assert.match(publisher, /请求用户精确授权这一次完整 `publication\.descriptorDigest`/u);
  assert.match(publisher, /不是独立授权 token/u);
  assert.match(publisher, /--workspace-root <preflight\.workspace\.root>/u);
  assert.match(publisher, /--remote <preflight\.publication\.remote>/u);
  assert.match(publisher, /--branch <preflight\.publication\.branch>/u);
  assert.match(publisher, /--expected-descriptor-digest <preflight\.publication\.descriptorDigest>/u);
  assert.match(publisher, /Catalog 不重试或 repair 同一 version/u);
  assert.doesNotMatch(publisher, /--branch catalog/u);

  const invalidRemote = behaviorCases.find((entry) => (
    entry.id === 'invalid-explicit-remote-requires-fresh-context'
  ));
  assert.ok(invalidRemote);
  assert.deepEqual(
    invalidRemote.input.scriptedReplies.map((reply) => reply.answersByIndex),
    [['remote 名称改为 staging。'], ['拒绝，这次不要发布。']],
    'remote correction and publication refusal must be separate conversation turns',
  );
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
    await materializeWorkspaceFiles(root, initializeCase.input.workspaceFiles);
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

test('Author removal Eval fixture creates a clean Git precondition and restores the provider Git snapshot', async () => {
  const repoRoot = path.resolve(sourceRoot, '..', '..');
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  const fixture = path.join(sourceRoot, 'skills', 'author-aw-catalog', 'evals', 'fixtures', 'bin', 'aw');
  const removalCase = (await readBehaviorCases('author-aw-catalog'))
    .find((entry) => entry.id === 'remove-canonical-plugin-through-handoff');
  assert.ok(removalCase);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-author-remove-eval-real-cli-')));
  const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'aw-author-remove-eval-home-'));
  const fixtureOptions = { fixture, cliEntry, cwd: root, fixtureHome, tmpDir: fixtureHome };
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await materializeWorkspaceFiles(root, removalCase.input.workspaceFiles);
    const initialGit = await snapshotTree(path.join(root, '.git'));

    const self = await runEvalFixture({
      ...fixtureOptions,
      args: ['self', 'check', '--from', path.join(sourceRoot, 'skills', 'author-aw-catalog'), '--json'],
    });
    assert.equal(self.exitCode, 0, self.stderr);
    assert.equal(parseSingleJson(self.stdout, 'author removal self check').command, 'self:check');
    const cleanAfterSelf = await execFileAsync('git', [
      'status', '--porcelain=v1', '--untracked-files=all',
    ], { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    assert.equal(cleanAfterSelf.stdout, '', 'self check leaves the prepared fixture clean');

    const context = await runEvalFixture({
      ...fixtureOptions,
      args: ['catalog', 'context', '--workspace-root', root, '--json'],
    });
    assert.equal(context.exitCode, 0, context.stderr);
    assert.equal(parseSingleJson(context.stdout, 'author removal context').git.clean, true);

    const initialStatus = await runEvalFixture({
      ...fixtureOptions,
      args: ['catalog', 'status', '--workspace-root', root, '--json'],
    });
    assert.equal(initialStatus.exitCode, 0, initialStatus.stderr);
    const initialStatusReceipt = parseSingleJson(initialStatus.stdout, 'author removal initial status');
    assert.equal(initialStatusReceipt.ok, true);
    assert.equal(initialStatusReceipt.git.clean, true);
    assert.deepEqual(initialStatusReceipt.plugins.map((plugin) => plugin.name).sort(), [
      'remove-me', 'survivor',
    ]);

    const remove = await runEvalFixture({
      ...fixtureOptions,
      args: ['plugin', 'remove', 'remove-me', '--workspace-root', root, '--yes', '--json'],
    });
    assert.equal(remove.exitCode, 0, remove.stderr);
    const removeReceipt = parseSingleJson(remove.stdout, 'author removal receipt');
    assert.equal(removeReceipt.schemaVersion, 1);
    assert.equal(removeReceipt.command, 'plugin:remove');
    assert.equal(removeReceipt.ok, true);
    assert.equal(removeReceipt.removed, true);
    assert.equal(removeReceipt.plugin.name, 'remove-me');
    assert.deepEqual(removeReceipt.errors, []);
    await assert.rejects(readFile(path.join(root, 'plugins', 'remove-me', 'README.md'), 'utf8'));

    const finalStatus = await runEvalFixture({
      ...fixtureOptions,
      args: ['catalog', 'status', '--workspace-root', root, '--json'],
    });
    assert.equal(finalStatus.exitCode, 0, finalStatus.stderr);
    const finalStatusReceipt = parseSingleJson(finalStatus.stdout, 'author removal final status');
    assert.equal(finalStatusReceipt.ok, true);
    assert.deepEqual(finalStatusReceipt.plugins.map((plugin) => plugin.name), ['survivor']);

    const survivor = await runEvalFixture({
      ...fixtureOptions,
      args: ['plugin', 'validate', path.join(root, 'plugins', 'survivor'), '--workspace-root', root, '--json'],
    });
    assert.equal(survivor.exitCode, 0, `${survivor.stderr}\n${survivor.stdout}`);
    assert.equal(parseSingleJson(survivor.stdout, 'author removal survivor validation').ok, true);
    const build = await runEvalFixture({
      ...fixtureOptions,
      args: ['catalog', 'build', '--workspace-root', root, '--json'],
    });
    assert.equal(build.exitCode, 0, build.stderr);
    assert.equal(parseSingleJson(build.stdout, 'author removal Catalog build').ok, true);
    const validate = await runEvalFixture({
      ...fixtureOptions,
      args: ['catalog', 'validate', path.join(root, '.aw', 'catalog'), '--json'],
    });
    assert.equal(validate.exitCode, 0, validate.stderr);
    assert.equal(parseSingleJson(validate.stdout, 'author removal Catalog validation').ok, true);
    assert.equal(JSON.parse(await readFile(path.join(root, 'plugins', 'marketplace-source.json'), 'utf8')).catalog.version, '0.3.0');
    assert.doesNotMatch(await readFile(path.join(root, '.aw', 'catalog', 'catalog-manifest.json'), 'utf8'), /remove-me/u);
    assert.deepEqual(await snapshotTree(path.join(root, '.git')), initialGit);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(fixtureHome, { recursive: true, force: true }),
    ]);
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
      await materializeWorkspaceFiles(root, evalCase.input.workspaceFiles);
      await execFileAsync('git', ['init'], { cwd: root });
      const scenario = evalCase.input.workspaceFiles['fixtures/scenario.txt'].trim()
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

      const invalidPublicationTarget = scenario === 'invalid-publication-target';
      const contextArgs = isDefault
        ? ['catalog', 'context', '--json']
        : ['catalog', 'context', '--remote', invalidPublicationTarget ? 'missing' : remote, '--branch', branch, '--json'];
      let context = await runEvalFixture({ fixture, cliEntry, cwd: root, args: contextArgs });
      assert.equal(context.exitCode, 0, context.stderr);
      let contextReceipt = parseSingleJson(context.stdout, `${evalCase.id}: context`);
      assert.equal(contextReceipt.schemaVersion, 3);
      assert.equal(contextReceipt.workspace.health, 'healthy');
      if (invalidPublicationTarget) {
        assert.equal(contextReceipt.workspace.found, true);
        assert.equal(contextReceipt.publication.remote, null);
        assert.deepEqual(contextReceipt.issues.map((issue) => [issue.scope, issue.blocking]), [
          ['publication', true],
        ]);
        context = await runEvalFixture({
          fixture,
          cliEntry,
          cwd: root,
          args: ['catalog', 'context', '--workspace-root', root, '--remote', remote, '--branch', branch, '--json'],
        });
        assert.equal(context.exitCode, 0, context.stderr);
        contextReceipt = parseSingleJson(context.stdout, `${evalCase.id}: corrected context`);
        assert.deepEqual(contextReceipt.issues, []);
      }
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

test('Eval fixtures with a workspace marker pass the public Catalog and plugin preflight', async () => {
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
      .filter((entry) => expectedReviewerSnapshots.has(entry.id))
    .map((entry) => entry.id)
    .sort(),
    [...expectedReviewerSnapshots.keys()].sort(),
    'Reviewer snapshot case IDs must have explicit snapshot expectations',
  );
  const cases = caseGroups.flat()
    .filter((entry) => (
      entry.input.workspaceFiles['.aw-workspace.json'] !== undefined
      && !entry.tags.includes('workspace-invalid')
    ));
  assert.ok(cases.length > 0, 'at least one Eval fixture must materialize a workspace marker');

  for (const evalCase of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `aw-catalog-eval-${evalCase.id}-`));
    try {
      await materializeWorkspaceFiles(root, evalCase.input.workspaceFiles);
      const expectedPluginNames = Object.keys(evalCase.input.workspaceFiles)
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
