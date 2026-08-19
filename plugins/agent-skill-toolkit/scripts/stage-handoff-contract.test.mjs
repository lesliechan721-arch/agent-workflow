import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const localPluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8')).sourceRoot
  : localPluginRoot;
const validator = path.join(pluginRoot, 'scripts', 'validate-review-stage-result.mjs');
const temporaryRoots = [];

async function run(args) {
  return execFileAsync(process.execPath, [validator, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function targetDigest(workspaceRoot, targetPath) {
  const output = await run([
    '--digest-only', targetPath,
    '--repo-root', workspaceRoot,
    '--format', 'json',
  ]);
  return JSON.parse(output.stdout).digest;
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('stage envelopes bind current targets and complete bundle records', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'review-stage-handoff-'));
  temporaryRoots.push(workspaceRoot);
  const targetRoot = path.join(workspaceRoot, 'target-skill');
  const handoffRoot = path.join(workspaceRoot, 'handoffs');
  await mkdir(targetRoot, { recursive: true });
  await mkdir(handoffRoot, { recursive: true });
  const targetContent = '---\nname: target-skill\n---\n# Target\n';
  const targetPath = path.join(targetRoot, 'SKILL.md');
  await writeFile(targetPath, targetContent, 'utf8');
  const digest = await targetDigest(workspaceRoot, targetRoot);
  const envelopePath = path.join(handoffRoot, 'reference-audit.json');
  const envelope = {
    schemaVersion: 1,
    stageId: 'reference-audit',
    producer: 'review-agent-content',
    independentContext: true,
    target: { path: 'target-skill', digest },
    resultSchema: 'ReferenceAuditResult',
    result: {
      schemaVersion: 1,
      target: 'target-skill',
      activePaths: [],
      references: [],
      findings: [],
      unknowns: [],
    },
  };
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  const stageOutput = await run([
    envelopePath,
    '--repo-root', workspaceRoot,
    '--format', 'json',
  ]);
  const stage = JSON.parse(stageOutput.stdout).stage;
  assert.equal(stage.id, 'reference-audit');
  assert.equal(stage.targetDigest, digest);
  assert.equal(stage.resultPath, 'handoffs/reference-audit.json');

  const bundlePath = path.join(workspaceRoot, 'review-input-bundle.json');
  const bundle = {
    schemaVersion: 3,
    target: { kind: 'agent-skill', name: 'target-skill', sourceDigest: digest },
    artifacts: [],
    environment: {},
    orchestration: { stageOwner: 'caller', providedStages: [stage] },
  };
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  const verified = JSON.parse((await run([
    '--verify-bundle', bundlePath,
    '--repo-root', workspaceRoot,
    '--format', 'json',
  ])).stdout);
  assert.equal(verified.valid, true);
  assert.equal(verified.stageCount, 1);

  const tampered = structuredClone(bundle);
  tampered.orchestration.providedStages[0].resultDigest = `sha256:${'9'.repeat(64)}`;
  await writeFile(bundlePath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
  await assert.rejects(run([
    '--verify-bundle', bundlePath,
    '--repo-root', workspaceRoot,
  ]), /providedStages record differs|resultDigest/u);

  const duplicate = structuredClone(bundle);
  duplicate.orchestration.providedStages.push(structuredClone(stage));
  await writeFile(bundlePath, `${JSON.stringify(duplicate, null, 2)}\n`, 'utf8');
  await assert.rejects(run([
    '--verify-bundle', bundlePath,
    '--repo-root', workspaceRoot,
  ]), /duplicate|unique/iu);

  await writeFile(targetPath, `${targetContent}changed\n`, 'utf8');
  await assert.rejects(run([
    envelopePath,
    '--repo-root', workspaceRoot,
  ]), /target\.digest does not match/u);

  await writeFile(targetPath, targetContent, 'utf8');
  envelope.independentContext = false;
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  await assert.rejects(run([
    envelopePath,
    '--repo-root', workspaceRoot,
  ]), /independentContext=true/u);
});

test('ReviewResult stage envelopes bind result.target.digest and target kind', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'review-stage-result-'));
  temporaryRoots.push(workspaceRoot);
  const targetRoot = path.join(workspaceRoot, 'target-skill');
  const handoffRoot = path.join(workspaceRoot, 'handoffs');
  await mkdir(targetRoot, { recursive: true });
  await mkdir(handoffRoot, { recursive: true });
  await writeFile(path.join(targetRoot, 'SKILL.md'), '---\nname: target-skill\n---\n', 'utf8');
  const digest = await targetDigest(workspaceRoot, targetRoot);
  const reviewResult = JSON.parse(await readFile(
    path.join(pluginRoot, 'skills', 'review-agent-skill', 'assets', 'review-result-template.json'),
    'utf8',
  ));
  reviewResult.target = {
    kind: 'agent-skill',
    name: 'target-skill',
    profile: null,
    digest,
  };
  const envelopePath = path.join(handoffRoot, 'source-review.json');
  const envelope = {
    schemaVersion: 1,
    stageId: 'source-skill-review',
    producer: 'review-agent-skill',
    independentContext: true,
    target: { path: 'target-skill', digest },
    resultSchema: 'ReviewResult',
    result: reviewResult,
  };
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  const output = JSON.parse((await run([
    envelopePath,
    '--repo-root', workspaceRoot,
    '--format', 'json',
  ])).stdout);
  assert.equal(output.stage.schema, 'ReviewResult');

  envelope.result.target.digest = `sha256:${'0'.repeat(64)}`;
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  await assert.rejects(run([
    envelopePath,
    '--repo-root', workspaceRoot,
  ]), /result\.target\.digest/u);
});
