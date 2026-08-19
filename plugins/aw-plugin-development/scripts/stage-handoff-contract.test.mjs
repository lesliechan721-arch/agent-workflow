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
const validator = path.join(
  pluginRoot,
  'skills',
  'review-aw-plugin',
  'scripts',
  'validate-review-stage-result.mjs',
);
const temporaryRoots = [];

async function run(args) {
  return execFileAsync(process.execPath, [validator, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('installed AW reviewer validates generic stage envelopes before synthesis', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'aw-stage-handoff-'));
  temporaryRoots.push(workspaceRoot);
  const pluginTarget = path.join(workspaceRoot, 'packages', 'demo-plugin');
  const skillTarget = path.join(pluginTarget, 'skills', 'demo');
  const handoffRoot = path.join(workspaceRoot, 'handoffs');
  await mkdir(path.join(pluginTarget, '.agents-plugin'), { recursive: true });
  await mkdir(skillTarget, { recursive: true });
  await mkdir(handoffRoot, { recursive: true });
  await writeFile(
    path.join(pluginTarget, '.agents-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'demo-plugin', version: '0.1.0' }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(path.join(skillTarget, 'SKILL.md'), '---\nname: demo\n---\n# Demo\n', 'utf8');
  const digest = JSON.parse((await run([
    '--digest-only', skillTarget,
    '--repo-root', workspaceRoot,
    '--format', 'json',
  ])).stdout).digest;
  const envelopePath = path.join(handoffRoot, 'reference-audit.json');
  const envelope = {
    schemaVersion: 1,
    stageId: 'reference-audit',
    producer: 'review-agent-content',
    independentContext: true,
    target: { path: 'packages/demo-plugin/skills/demo', digest },
    resultSchema: 'ReferenceAuditResult',
    result: {
      schemaVersion: 1,
      target: 'packages/demo-plugin/skills/demo',
      activePaths: [],
      references: [],
      findings: [],
      unknowns: [],
    },
  };
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  const stage = JSON.parse((await run([
    envelopePath,
    '--repo-root', workspaceRoot,
    '--format', 'json',
  ])).stdout).stage;
  const bundlePath = path.join(workspaceRoot, 'review-input-bundle.json');
  const bundle = {
    schemaVersion: 3,
    target: { kind: 'aw-plugin', name: 'demo-plugin', sourceDigest: `sha256:${'0'.repeat(64)}` },
    artifacts: [],
    environment: { repository: path.basename(workspaceRoot), client: 'codex' },
    orchestration: { stageOwner: 'caller', providedStages: [stage] },
  };
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  const verified = JSON.parse((await run([
    '--verify-bundle', bundlePath,
    '--repo-root', workspaceRoot,
    '--format', 'json',
  ])).stdout);
  assert.equal(verified.stageCount, 1);

  envelope.result.findings.push('changed after bundle creation');
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  await assert.rejects(run([
    '--verify-bundle', bundlePath,
    '--repo-root', workspaceRoot,
  ]), /resultDigest|providedStages record differs/u);
});
