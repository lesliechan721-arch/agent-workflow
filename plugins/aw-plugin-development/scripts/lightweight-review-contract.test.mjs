#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const localRoot = path.dirname(fileURLToPath(import.meta.url));
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const root = context
  ? path.join(context.plugin.rootDir, context.platform, 'skills/review-aw-plugin/scripts')
  : localRoot;
const releaseCheck = path.join(root, 'check-aw-plugin-release.mjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'aw-light-review-'));

try {
  const plugin = path.join(temp, 'plugin');
  const source = path.join(plugin, 'skills', 'demo');
  const finalRoot = path.join(temp, 'final');
  const final = path.join(finalRoot, 'demo');
  await mkdir(source, { recursive: true });
  await mkdir(path.join(final, 'references'), { recursive: true });
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo-plugin',
    version: '1.0.0',
    description: 'Demo',
    skills: './skills',
    scripts: { node: { build: { runner: 'node', path: './scripts/build.mjs', args: [] } } },
    marketplace: { policy: { products: ['CODEX'] } }
  }));
  const skill = '---\nname: demo\ndescription: Perform the demo task.\n---\n\n# Demo\n\nRead [the generated guide](references/generated.md).\n';
  await writeFile(path.join(source, 'SKILL.md'), skill);
  await writeFile(path.join(final, 'SKILL.md'), skill);
  await writeFile(path.join(final, 'references', 'generated.md'), '# Generated\n\nReturn the supplied value.\n');

  const sharedScripts = context
    ? root
    : path.resolve(root, '..', '..', 'agent-skill-toolkit', 'scripts');
  const checker = path.join(sharedScripts, 'check-agent-skill.mjs');
  const { stdout: checkStdout } = await execFileAsync(process.execPath, [checker, final, '--root-kind', 'materialized', '--profile', 'codex-project', '--format', 'json'], { encoding: 'utf8' });
  const check = JSON.parse(checkStdout);
  const review = path.join(temp, 'review.json');
  await writeFile(review, JSON.stringify({
    schemaVersion: 1,
    target: { name: 'demo', digest: check.target.digest },
    mode: 'full',
    design: 'pass',
    complexity: 'proportionate',
    summary: 'The Skill is focused.',
    findings: [],
    unknowns: [],
    evalEvidence: 'structural'
  }));

  const env = {
    ...process.env,
    AW_SKILL_CHECK_BIN: path.join(sharedScripts, 'check-agent-skill.mjs'),
    AW_REVIEW_LITE_VALIDATOR: path.join(sharedScripts, 'validate-review-result-lite.mjs'),
  };

  const run = await execFileAsync(process.execPath, [
    releaseCheck,
    plugin,
    '--review', review,
    '--profile', 'codex-project',
    '--final', `codex-project=${finalRoot}`,
    '--format', 'json'
  ], { encoding: 'utf8', env });
  assert.equal(JSON.parse(run.stdout).ready, true);

  let blocked;
  try {
    await execFileAsync(process.execPath, [
      releaseCheck,
      plugin,
      '--review', review,
      '--profile', 'codex-project',
      '--format', 'json'
    ], { encoding: 'utf8', env });
  } catch (error) {
    blocked = JSON.parse(error.stdout);
  }
  assert.equal(blocked.ready, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes('is missing')));
  process.stdout.write('AW lightweight review contracts passed\n');
} finally {
  await rm(temp, { recursive: true, force: true });
}
