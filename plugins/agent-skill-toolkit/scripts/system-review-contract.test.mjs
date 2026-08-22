#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  ? path.join(context.plugin.rootDir, context.platform, 'skills/review-agent-skill/scripts')
  : localRoot;
const validator = path.join(root, 'validate-review-result-lite.mjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'system-review-contract-'));
const digest = 'sha256:' + 'a'.repeat(64);

async function validate(review, expectedFailure = false) {
  const reviewPath = path.join(temp, `review-${Math.random()}.json`);
  const checkPath = path.join(temp, `check-${Math.random()}.json`);
  await writeFile(reviewPath, JSON.stringify(review));
  await writeFile(checkPath, JSON.stringify({
    schemaVersion: 1,
    producer: 'check-agent-skill',
    target: { name: 'review-system', digest },
    ok: true,
    errors: [],
    warnings: [],
  }));
  try {
    const { stdout } = await execFileAsync(process.execPath, [validator, reviewPath, '--check', checkPath], { encoding: 'utf8' });
    if (expectedFailure) throw new Error('expected validation failure');
    return JSON.parse(stdout);
  } catch (error) {
    if (!expectedFailure) throw error;
    return JSON.parse(error.stdout);
  }
}

try {
  const redesign = await validate({
    schemaVersion: 1,
    target: { name: 'review-system', digest },
    mode: 'full',
    design: 'redesign',
    complexity: 'over-engineered',
    summary: 'The common path persists recomputable state across redundant contracts.',
    findings: [{
      severity: 'advisory',
      area: 'system-composition',
      evidence: ['architecture/common-path.md', 'contracts/target-plan.schema.json'],
      issue: 'The system repeats target identity and readiness across multiple handoffs.',
      action: 'Replace the handoff chain with a machine check, a model review, and an optional release check.',
    }],
    unknowns: [],
    evalEvidence: 'structural',
  });
  assert.equal(redesign.valid, true);
  assert.equal(redesign.effectiveDecision, 'redesign');

  const noFinding = await validate({
    schemaVersion: 1,
    target: { name: 'review-system', digest },
    mode: 'full',
    design: 'redesign',
    complexity: 'over-engineered',
    summary: 'The system is too complex.',
    findings: [],
    unknowns: [],
    evalEvidence: 'none',
  }, true);
  assert.equal(noFinding.valid, false);
  assert.ok(noFinding.errors.includes('over-engineered complexity requires at least one evidence-based finding'));

  const wrongDecision = await validate({
    schemaVersion: 1,
    target: { name: 'review-system', digest },
    mode: 'full',
    design: 'needs-fixes',
    complexity: 'over-engineered',
    summary: 'The system should be redesigned.',
    findings: [{
      severity: 'minor',
      area: 'system-composition',
      evidence: ['architecture/common-path.md'],
      issue: 'The common path is dominated by redundant handoffs.',
      action: 'Collapse the path before adding more rules.',
    }],
    unknowns: [],
    evalEvidence: 'structural',
  }, true);
  assert.equal(wrongDecision.valid, false);
  assert.ok(wrongDecision.errors.includes('over-engineered complexity requires redesign or fail'));

  process.stdout.write('system review contracts passed\n');
} finally {
  await rm(temp, { recursive: true, force: true });
}
