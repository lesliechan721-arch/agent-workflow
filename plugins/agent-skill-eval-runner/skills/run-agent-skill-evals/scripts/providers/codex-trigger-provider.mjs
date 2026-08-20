#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
function usage() {
  return `Usage: codex-trigger-provider.mjs [--driver-root <packages/cli/dist/scripts>] [--codex-bin <path>] [--model <id>]\n\nSet AW_CODEX_EVAL_DRIVER_ROOT instead of --driver-root when preferred. The runner supplies AGENT_EVAL_CASE_PATH, AGENT_EVAL_SKILL_PATH and AGENT_EVAL_OUTPUT_DIR.`;
}
function parse(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const o = {
    driverRoot: process.env.AW_CODEX_EVAL_DRIVER_ROOT ?? null,
    codexBin: process.env.CODEX_BIN ?? 'codex',
    model: process.env.CODEX_MODEL ?? undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const f = argv[i],
      v = argv[i + 1];
    if (f === '--driver-root') {
      if (!v) throw new Error(f + ' requires a value');
      o.driverRoot = path.resolve(v);
      i += 1;
    } else if (f === '--codex-bin') {
      if (!v) throw new Error(f + ' requires a value');
      o.codexBin = v;
      i += 1;
    } else if (f === '--model') {
      if (!v) throw new Error(f + ' requires a value');
      o.model = v;
      i += 1;
    } else throw new Error('Unknown option: ' + f);
  }
  if (!o.driverRoot) throw new Error('Provide --driver-root or AW_CODEX_EVAL_DRIVER_ROOT.');
  return o;
}
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}
async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (required('AGENT_EVAL_SKILL_MODE') !== 'with-skill')
    throw new Error(
      'The built-in Codex trigger provider currently supports only with-skill execution.',
    );
  const caseDoc = JSON.parse(await readFile(required('AGENT_EVAL_CASE_PATH'), 'utf8'));
  if (caseDoc.eval_type && caseDoc.eval_type !== 'trigger')
    throw new Error('Codex trigger provider only accepts trigger cases.');
  const skillPath = path.resolve(required('AGENT_EVAL_SKILL_PATH')),
    skillText = await readFile(path.join(skillPath, 'SKILL.md'), 'utf8'),
    name =
      /^name:\s*([^\n]+)$/mu
        .exec(skillText)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/gu, '') ?? path.basename(skillPath);
  const work = await mkdtemp(path.join(tmpdir(), 'agent-skill-codex-trigger-'));
  try {
    const subject = path.join(work, 'subject'),
      installed = path.join(subject, '.agents', 'skills', name),
      pluginRoot = path.join(work, 'fixture');
    await mkdir(path.dirname(installed), { recursive: true });
    await mkdir(path.join(subject, '.git'), { recursive: true });
    await cp(skillPath, installed, { recursive: true, dereference: false, errorOnExist: true });
    await mkdir(pluginRoot, { recursive: true });
    const split = typeof caseDoc.split === 'string' ? caseDoc.split : 'validation',
      normalized = {
        ...caseDoc,
        id: String(caseDoc.id ?? required('AGENT_EVAL_CASE_ID')),
        split,
        eval_type: 'trigger',
        unit_under_test: caseDoc.unit_under_test ?? 'description',
        case_role: caseDoc.case_role ?? 'representative',
        provenance: caseDoc.provenance ?? 'representative-synthetic',
        scenario_family: caseDoc.scenario_family ?? 'codex-trigger-provider',
        preconditions: caseDoc.preconditions ?? { target_available: true },
        oracle: caseDoc.oracle ?? {
          rationale: 'Provider execution case.',
          rule_refs: ['SKILL.md description'],
          confidence: 'medium',
          allowed_variance: 'Observe actual Skill loading.',
        },
      };
    await writeFile(
      path.join(pluginRoot, 'cases.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          skill: name,
          policy: {
            optimization: 'balanced',
            false_negative_cost: 'high',
            false_positive_cost: 'high',
            rationale: 'Provider fixture policy.',
          },
          cases: [normalized],
        },
        null,
        2,
      ) + '\n',
    );
    const suite = {
      id: 'trigger',
      kind: 'trigger',
      skill: name,
      skills: [name],
      cases: './cases.json',
      profiles: ['project-default'],
      defaultRuns: 1,
      releaseSplits: [split],
      requiredForRelease: false,
      perRunTimeoutMs: Number(process.env.AGENT_EVAL_TIMEOUT_MS ?? 180000),
      isolation: 'strict',
      observeSpawnAgent: false,
      strictNegativeSplits: [split],
      forbidMultipleSkillLoads: true,
    };
    const driver = await import(
      pathToFileURL(path.join(o.driverRoot, 'codex-trigger-eval.js')).href
    );
    const reportPath = path.join(required('AGENT_EVAL_OUTPUT_DIR'), 'codex-trigger-report.json');
    const report = await driver.runCodexTriggerSuite({
      suite,
      split,
      subjectRoot: subject,
      pluginRoot,
      profile: 'project-default',
      runs: 1,
      caseId: normalized.id,
      codexBin: o.codexBin,
      model: o.model,
      reportPath,
      sourceEnv: process.env,
    });
    const rawReport = JSON.parse(await readFile(reportPath, 'utf8'));
    const usageRuns = (rawReport.results ?? [])
      .flatMap((entry) => entry.runs ?? [])
      .map((entry) => entry.usage)
      .filter((entry) => entry !== null && entry !== undefined);
    process.stdout.write(
      JSON.stringify({
        grading: {
          complete: report.complete,
          mechanicalPassed: report.mechanicalPassed,
          outcome: report.outcome,
          summary: report.summary,
        },
        usage: usageRuns.length > 0 ? { runs: usageRuns } : null,
        artifacts: [{ role: 'trace', path: reportPath }],
        limitations: [
          'This provider executes trigger discovery only. Behavior fixtures require another compatible provider.',
        ],
      }) + '\n',
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
main().catch((e) => {
  process.stderr.write('[ERROR] ' + e.message + '\n');
  process.exit(1);
});
