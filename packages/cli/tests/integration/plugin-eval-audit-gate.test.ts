import os from 'node:os';
import path from 'node:path';

import {
  computeSkillDigest,
} from '@lesliechan721/agent-skill-eval';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeAuditCaseCorpusDigest,
  runAuditedPluginEvals,
} from '../../scripts/eval-plugin-skills-audited.js';

const temporaryRoots: string[] = [];

async function fixture(validity: 'pass' | 'fail' = 'pass') {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-audit-gate-'));
  temporaryRoots.push(repoRoot);
  const pluginRoot = path.join(repoRoot, 'plugins', 'sample');
  const skillRoot = path.join(pluginRoot, 'skills', 'sample-skill');
  const evalRoot = path.join(skillRoot, 'evals');
  await fs.ensureDir(evalRoot);
  await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
    name: 'sample',
    version: '0.1.0',
    skills: './skills',
  }, { spaces: 2 });
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), [
    '---',
    'name: sample-skill',
    'description: Evaluate a sample task.',
    '---',
    '',
    '# Sample',
    '',
    'Return the requested fact.',
    '',
  ].join('\n'));
  await fs.writeJson(path.join(evalRoot, 'manifest.json'), {
    schemaVersion: 2,
    plugin: 'sample',
    skill: 'sample-skill',
    profiles: [{
      id: 'project-default',
      scope: 'project',
      plugins: [{ name: 'sample', config: {} }],
      runModel: true,
      requiredForRelease: true,
    }],
    suites: [{
      id: 'trigger',
      kind: 'trigger',
      skills: ['sample-skill'],
      cases: './trigger-cases.json',
      observeSpawnAgent: false,
      isolation: 'strict',
      strictNegativeSplits: ['validation'],
      profiles: ['project-default'],
      defaultRuns: 1,
      releaseSplits: ['validation'],
      requiredForRelease: true,
      perRunTimeoutMs: 1000,
    }],
  }, { spaces: 2 });
  const casesPath = path.join(evalRoot, 'trigger-cases.json');
  await fs.writeJson(casesPath, {
    schemaVersion: 1,
    skill: 'sample-skill',
    cases: [{
      id: 'positive',
      split: 'validation',
      query: 'Use the sample skill.',
      should_load_skill: true,
    }],
  }, { spaces: 2 });
  const targetSkillDigest = await computeSkillDigest(skillRoot);
  const caseCorpusDigest = await computeAuditCaseCorpusDigest([casesPath]);
  const auditPath = path.join(repoRoot, 'audit.json');
  await fs.writeJson(auditPath, {
    schemaVersion: 2,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'sample-audit',
    mode: 'preflight',
    targetSkillDigest,
    caseCorpusDigest,
    validity,
    optimizationPolicy: 'precision-first',
    cases: [{
      caseId: 'positive',
      releaseRelevant: true,
      admission: validity === 'pass' ? 'pass' : 'fail',
      oracleConfidence: 'high',
      findings: [],
    }],
    blockedCases: validity === 'pass' ? [] : ['positive'],
    releaseEligible: validity === 'pass',
    failureTriage: [],
    recommendedAction: validity === 'pass' ? 'accepted-risk' : 'fix-eval-first',
  }, { spaces: 2 });
  return { repoRoot, auditPath };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.remove(root)));
});

describe('plugin Eval Audit gate', () => {
  it('rejects model execution before the delegate when no Audit is supplied', async () => {
    const { repoRoot } = await fixture();
    let called = false;
    const errors: string[] = [];
    const code = await runAuditedPluginEvals([
      'sample', '--skill', 'sample-skill', '--suite', 'trigger',
      '--split', 'validation', '--batch-name', 'test',
    ], {
      repoRoot,
      stderr: (text) => errors.push(text),
      delegate: async () => {
        called = true;
        return 0;
      },
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(errors.join('')).toContain('requires --audit');
  });

  it('passes a current independent Audit and strips the wrapper flag', async () => {
    const { repoRoot, auditPath } = await fixture();
    let forwarded: string[] = [];
    const code = await runAuditedPluginEvals([
      'sample', '--skill', 'sample-skill', '--suite', 'trigger',
      '--split', 'validation', '--batch-name', 'test', '--audit', auditPath,
    ], {
      repoRoot,
      delegate: async (args) => {
        forwarded = args;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(forwarded).not.toContain('--audit');
    expect(forwarded).not.toContain(auditPath);
  });

  it('blocks a failed Audit before the delegate', async () => {
    const { repoRoot, auditPath } = await fixture('fail');
    let called = false;
    const code = await runAuditedPluginEvals([
      'sample', '--skill', 'sample-skill', '--suite', 'trigger',
      '--split', 'validation', '--batch-name', 'test', '--audit', auditPath,
    ], {
      repoRoot,
      stderr: () => {},
      delegate: async () => {
        called = true;
        return 0;
      },
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  it('allows materialization without an Audit', async () => {
    let called = false;
    const code = await runAuditedPluginEvals([
      'sample', '--skill', 'sample-skill', '--materialize-only', '--batch-name', 'test',
    ], {
      delegate: async () => {
        called = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(called).toBe(true);
  });
});
