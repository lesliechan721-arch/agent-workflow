#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(root, 'check-agent-skill.mjs');
const validator = path.join(root, 'validate-review-result-lite.mjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'lightweight-review-'));

async function run(file, args, expectFailure = false) {
  try {
    return await execFileAsync(process.execPath, [file, ...args], { encoding: 'utf8' });
  } catch (error) {
    if (!expectFailure) throw error;
    return { stdout: error.stdout, stderr: error.stderr };
  }
}

try {
  const good = path.join(temp, 'good-skill');
  await mkdir(path.join(good, 'references'), { recursive: true });
  await writeFile(path.join(good, 'SKILL.md'), '---\nname: good-skill\ndescription: Review supplied facts.\n---\n\nRead [the guide](references/guide.md).\n');
  await writeFile(path.join(good, 'references', 'guide.md'), '# Guide\n\nReturn the key facts.\n');
  const goodCheckPath = path.join(temp, 'good-check.json');
  const goodRun = await run(checker, [good, '--output', goodCheckPath]);
  const goodCheck = JSON.parse(goodRun.stdout);
  assert.equal(goodCheck.ok, true);

  const projectedPlugin = path.join(temp, 'projected-plugin');
  const projected = path.join(projectedPlugin, 'skills', 'projected-skill');
  await mkdir(path.join(projectedPlugin, '.agents-plugin'), { recursive: true });
  await mkdir(projected, { recursive: true });
  await writeFile(path.join(projectedPlugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'projected-plugin',
    skills: './skills',
    buildConfig: {
      skillRuntimeFiles: [
        { skill: 'projected-skill', source: './scripts/tool.mjs', target: 'scripts/tool.mjs' }
      ]
    }
  }));
  await writeFile(path.join(projected, 'SKILL.md'), '---\nname: projected-skill\ndescription: Run the projected tool.\n---\n\nRun `node scripts/tool.mjs`.\n');
  const projectedRun = await run(checker, [projected, '--root-kind', 'source']);
  const projectedCheck = JSON.parse(projectedRun.stdout);
  assert.equal(projectedCheck.ok, true);
  assert.ok(projectedCheck.warnings.some((entry) => entry.code === 'declared-runtime-projection'));

  const bad = path.join(temp, 'bad-skill');
  await mkdir(path.join(bad, 'references'), { recursive: true });
  await writeFile(path.join(bad, 'SKILL.md'), '---\nname: bad-skill\ndescription: Run the supplied workflow.\n---\n\nRead [the guide](references/guide.md).\n');
  await writeFile(path.join(bad, 'references', 'guide.md'), '# Guide\n\nRun `node scripts/missing.mjs`.\n');
  const badCheckPath = path.join(temp, 'bad-check.json');
  const badRun = await run(checker, [bad, '--output', badCheckPath], true);
  const badCheck = JSON.parse(badRun.stdout);
  assert.equal(badCheck.ok, false);
  assert.ok(badCheck.errors.some((entry) => entry.code === 'missing-runtime-resource' && entry.origin === 'references/guide.md'));

  const reviewPath = path.join(temp, 'review.json');
  await writeFile(reviewPath, JSON.stringify({
    schemaVersion: 1,
    target: { name: goodCheck.target.name, digest: goodCheck.target.digest },
    mode: 'quick',
    design: 'pass',
    summary: 'The Skill is focused and proportionate.',
    findings: [],
    unknowns: [],
    evalEvidence: 'structural'
  }, null, 2));
  const valid = JSON.parse((await run(validator, [reviewPath, '--check', goodCheckPath])).stdout);
  assert.equal(valid.valid, true);
  assert.equal(valid.effectiveDecision, 'pass');

  const badReviewPath = path.join(temp, 'bad-review.json');
  await writeFile(badReviewPath, JSON.stringify({
    schemaVersion: 1,
    target: { name: badCheck.target.name, digest: badCheck.target.digest },
    mode: 'full',
    design: 'pass',
    summary: 'Semantic design is otherwise focused.',
    findings: [],
    unknowns: [],
    evalEvidence: 'none'
  }, null, 2));
  const combined = JSON.parse((await run(validator, [badReviewPath, '--check', badCheckPath])).stdout);
  assert.equal(combined.valid, true);
  assert.equal(combined.machineCheck, 'fail');
  assert.equal(combined.effectiveDecision, 'fail');

  const mismatch = JSON.parse(await readFile(reviewPath, 'utf8'));
  mismatch.target.digest = badCheck.target.digest;
  const mismatchPath = path.join(temp, 'mismatch.json');
  await writeFile(mismatchPath, JSON.stringify(mismatch));
  const mismatchRun = await run(validator, [mismatchPath, '--check', goodCheckPath], true);
  assert.equal(JSON.parse(mismatchRun.stdout).valid, false);

  process.stdout.write('lightweight review contracts passed\n');
} finally {
  await rm(temp, { recursive: true, force: true });
}
