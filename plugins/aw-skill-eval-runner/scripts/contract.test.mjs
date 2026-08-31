import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = pluginContext?.sourceRoot ?? root;
const runtimeRoot = pluginContext?.platform ? path.join(root, pluginContext.platform) : root;
const runtimeSkillRoot = path.join(runtimeRoot, 'skills', 'run-aw-skill-evals');
const workspaceRoot = path.resolve(sourceRoot, '..', '..');
const publicAwBin = path.join(workspaceRoot, 'packages', 'cli', 'dist', 'index.js');
const publicEvalBin = process.env.AW_SKILL_EVAL_TEST_BIN
  ?? path.join(workspaceRoot, 'packages', 'agent-skill-eval', 'dist', 'bin.js');

async function readRuntime(relativePath) {
  return readFile(path.join(runtimeSkillRoot, relativePath), 'utf8');
}

async function exists(relativePath) {
  return access(path.join(runtimeSkillRoot, relativePath)).then(() => true, () => false);
}

async function runInjectedBin(bin, args) {
  return bin.endsWith('.js')
    ? execFileAsync(process.execPath, [bin, ...args], { encoding: 'utf8' })
    : execFileAsync(bin, args, { encoding: 'utf8' });
}

async function materializeWorkspaceFiles(workspaceFiles, destination) {
  for (const [relativePath, content] of Object.entries(workspaceFiles)) {
    const target = path.join(destination, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

test('Runner declares the Auditor dependency and no copied engine contract', async () => {
  const manifest = JSON.parse(await readFile(
    path.join(sourceRoot, '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(manifest.name, 'aw-skill-eval-runner');
  assert.deepEqual(manifest.dependencies, ['agent-skill-toolkit']);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.buildConfig, undefined);
  assert.deepEqual(manifest.requires.aw.capabilities, ['aw.skill-eval.v1']);
  for (const relativePath of [
    'assets/aw-skill-eval-execution-plan.template.json',
    'schemas',
    'providers',
    'scripts',
  ]) {
    assert.equal(await exists(relativePath), false, relativePath);
  }
});

test('Runner exposes prepare, Audit, authorization, execution, and triage boundaries', async () => {
  const skill = await readRuntime('SKILL.md');
  const openai = await readRuntime('agents/openai.yaml');
  assert.match(skill, /^user-invocable: true$/mu);
  assert.match(openai, /^\s*allow_implicit_invocation: true$/mu);
  // Static contract exception: an installed Agent could start paid provider work without the required Audit and authorization; behavior test is not suitable because deterministic plugin tests do not run a model provider.
  for (const command of [
    'aw skill eval prepare <plugin> --skill <skill> --suite <suite> --profile <profile> --output <new-plan-directory> --json',
    'aw-skill-eval capabilities --json',
    'aw-skill-eval schema print aw-skill-eval-execution-plan',
    'aw-skill-eval schema print eval-run-bundle',
    'aw-skill-eval schema print eval-audit-result',
    'aw-skill-eval schema print eval-provider-capabilities',
    'aw-skill-eval schema print eval-provider-output',
    'aw-skill-eval plan validate <plan.json>',
    'aw-skill-eval audit validate <audit.json>',
    'aw-skill-eval run <plan.json> --audit <audit.json>',
    'aw-skill-eval bundle validate <bundle.json>',
  ]) {
    assert.ok(skill.includes(command), command);
  }
  assert.match(skill, /无 passing preflight Audit 不得启动 provider/u);
  assert.match(skill, /只有全部 preflight Audit 通过后/u);
  assert.match(skill, /临时输出、持久输出/u);
  assert.match(skill, /只要求 validate 时不得创建任何输出/u);
  assert.match(skill, /不得创建 checkpoint、batch ledger/u);
  assert.match(skill, /新的全新上下文/u);
  assert.doesNotMatch(skill, /\bnpx\b/u);
});

test('trigger cases route direct selection and reject unaudited execution', async () => {
  const triggerDocument = JSON.parse(await readFile(
    path.join(sourceRoot, 'skills/run-aw-skill-evals/evals/trigger-cases.json'),
    'utf8',
  ));
  assert.equal(triggerDocument.audit_status, 'not assessed');
  const cases = triggerDocument.cases;
  assert.equal(cases.find((entry) => entry.id === 'prepare_selection')?.should_load_skill, true);
  assert.equal(cases.find((entry) => entry.id === 'unaudited')?.should_load_skill, true);
  assert.equal(cases.find((entry) => entry.id === 'audit')?.should_load_skill, false);

  const behaviorDocument = JSON.parse(await readFile(
    path.join(sourceRoot, 'skills/run-aw-skill-evals/evals/behavior-cases.json'),
    'utf8',
  ));
  assert.equal(behaviorDocument.audit_status, 'not assessed');
});

test('required writable cases prepare and validate Plan v4 from their materialized fixtures', async () => {
  const behaviorDocument = JSON.parse(await readFile(
    path.join(sourceRoot, 'skills/run-aw-skill-evals/evals/behavior-cases.json'),
    'utf8',
  ));
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-runner-contract-')));
  try {
    for (const caseId of [
      'selection-entry-prepares-before-audit',
      'interrupted-run-restarts-evidence-chain',
    ]) {
      const evalCase = behaviorDocument.evals.find((entry) => entry.id === caseId);
      assert.equal(evalCase.sandbox, 'workspace-write', caseId);
      const fixtureRoot = path.join(tempRoot, caseId);
      await materializeWorkspaceFiles(evalCase.workspace_files, fixtureRoot);

      const catalogStatus = JSON.parse((await runInjectedBin(publicAwBin, [
        'catalog',
        'status',
        '--workspace-root',
        fixtureRoot,
        '--json',
      ])).stdout);
      assert.equal(catalogStatus.ok, true, caseId);

      const pluginValidation = JSON.parse((await runInjectedBin(publicAwBin, [
        'plugin',
        'validate',
        path.join(fixtureRoot, 'plugins', 'fixture-eval-plugin'),
        '--workspace-root',
        fixtureRoot,
        '--json',
      ])).stdout);
      assert.equal(pluginValidation.ok, true, caseId);

      const preparation = JSON.parse((await runInjectedBin(publicAwBin, [
        'skill',
        'eval',
        'prepare',
        'fixture-eval-plugin',
        '--skill',
        'fixture-skill',
        '--suite',
        'trigger',
        '--profile',
        'project-default',
        '--case',
        'run_fixture',
        '--workspace-root',
        fixtureRoot,
        '--output',
        path.join(fixtureRoot, 'eval-plan'),
        '--json',
      ])).stdout);
      assert.equal(preparation.ok, true, caseId);
      assert.equal(preparation.plans.length, 1, caseId);

      const planValidation = JSON.parse((await runInjectedBin(
        publicEvalBin,
        ['plan', 'validate', preparation.plans[0].planPath],
      )).stdout);
      assert.equal(planValidation.valid, true, caseId);
      const plan = JSON.parse(await readFile(preparation.plans[0].planPath, 'utf8'));
      assert.equal(plan.schemaVersion, 4, caseId);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test(
  'an injected canonical CLI reports the current schema set and requires Audit input',
  async () => {
    const bin = publicEvalBin;
    const capabilities = JSON.parse(
      (await runInjectedBin(bin, ['capabilities', '--json'])).stdout,
    );
    assert.equal(capabilities.schemaVersion, 2);

    const help = (await runInjectedBin(bin, ['--help'])).stdout;
    assert.match(help, /run <plan\.json> --audit <audit\.json> \[--audit <audit\.json>\.\.\.\]/u);
    await assert.rejects(
      runInjectedBin(bin, ['run', 'missing-plan.json']),
      (error) => error.stderr.includes('run <plan.json> --audit <audit.json>'),
    );

    for (const [schemaName, version] of [
      ['aw-skill-eval-execution-plan', 4],
      ['eval-run-bundle', 4],
      ['eval-audit-result', 3],
      ['eval-provider-capabilities', 2],
      ['eval-provider-output', 1],
    ]) {
      const schema = JSON.parse(
        (await runInjectedBin(bin, ['schema', 'print', schemaName])).stdout,
      );
      assert.equal(schema.properties.schemaVersion.const, version);
    }
  },
);
