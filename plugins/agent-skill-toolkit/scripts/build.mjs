#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDigestSource = process.env.AW_PLUGIN_IMPORT_CASE_CORPUS_DIGEST;
const bundleValidatorSource = process.env.AW_PLUGIN_IMPORT_EVAL_RUN_BUNDLE_VALIDATOR;
if (!corpusDigestSource) {
  process.stderr.write('[ERROR] AW_PLUGIN_IMPORT_CASE_CORPUS_DIGEST is required.\n');
  process.exit(2);
}
if (!bundleValidatorSource) {
  process.stderr.write('[ERROR] AW_PLUGIN_IMPORT_EVAL_RUN_BUNDLE_VALIDATOR is required.\n');
  process.exit(2);
}
const corpusDigestTarget = path.join(root, 'skills/audit-agent-skill-evals/scripts/corpus-digest.mjs');
mkdirSync(path.dirname(corpusDigestTarget), { recursive: true });
copyFileSync(corpusDigestSource, corpusDigestTarget);
const bundleValidatorTarget = path.join(root, 'skills/audit-agent-skill-evals/scripts/eval-run-bundle-validator.mjs');
copyFileSync(bundleValidatorSource, bundleValidatorTarget);
const result = spawnSync(process.execPath, [path.join(root, 'scripts/generate-standard-views.mjs')], {
  cwd: root,
  env: process.env,
  encoding: 'utf8',
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 2);
