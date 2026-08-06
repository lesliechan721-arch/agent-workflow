import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runPluginEvals } from '../../scripts/eval-plugin-skills.js';
import {
  registerCurrentTestReadonlyFixtureRoot,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function skillScript(name: string): string {
  return path.join(repoRoot(), '.agents', 'skills', 'skill-review', 'scripts', name);
}

function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('skill-review author tools', () => {
  it('inspects dynamic source and materialized final artifacts together', async () => {
    const root = repoRoot();
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-review-inspect-'));
    tempDirs.push(outputRoot);
    registerCurrentTestReadonlyFixtureRoot(root);
    registerCurrentTestWritableStateRoot(outputRoot);
    const exitCode = await runPluginEvals([
      'codex-explore',
      '--materialize-only',
      '--output-dir',
      outputRoot,
    ], {
      repoRoot: root,
      env: process.env,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(exitCode).toBe(0);
    const evaluationPath = path.join(outputRoot, 'codex-explore', 'evaluation.json');

    const result = await execFileAsync('node', [
      skillScript('inspect_skill_target.mjs'),
      'codex-explore',
      '--evaluation',
      evaluationPath,
      '--format',
      'json',
    ], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    const report = JSON.parse(result.stdout);

    expect(report.target).toMatchObject({ kind: 'aw-plugin', name: 'codex-explore' });
    expect(report.plugin.dynamic_targets).toHaveLength(5);
    expect(report.source_skills[0].path).toBe('templates/codex-explore/SKILL.md');
    expect(report.evaluation.profiles).toHaveLength(4);
    expect(report.evaluation.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        profile: 'project-nondefault',
        evidence_level: 'runtime-project',
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: 'skill' }),
          expect.objectContaining({ kind: 'agent' }),
        ]),
      }),
    ]));
    await expect(
      fs.pathExists(report.evaluation.profiles[0].root),
    ).resolves.toBe(true);
    expect(report.final_skills).toHaveLength(4);
    expect(report.issues.filter((issue: { level: string }) => issue.level === 'error')).toEqual([]);
  });

  it('reviews itself and another project-local static Skill without treating nested examples as targets', async () => {
    const root = repoRoot();
    for (const skillName of ['skill-review', 'create-agent-workflows-plugin']) {
      const result = await execFileAsync('node', [
        skillScript('inspect_skill_target.mjs'),
        skillName,
        '--format',
        'json',
      ], {
        cwd: root,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });
      const report = JSON.parse(result.stdout);

      expect(report.target).toMatchObject({
        kind: 'static-skill',
        name: skillName,
      });
      expect(report.skill.frontmatter.name).toBe(skillName);
      expect(report.skill.codex_metadata.allow_implicit_invocation).toBe(true);
      expect(report.evals.parse_errors).toEqual([]);
      expect(report.issues.filter((issue: { level: string }) => issue.level === 'error')).toEqual([]);
      if (skillName === 'skill-review') {
        expect(report.evals.trigger).toEqual({ total: 24, positive: 12, negative: 12 });
        expect(report.evals.behavior_cases).toBe(12);
        expect(report.evals.scoring_cases).toBe(5);
        expect(report.scripts.count).toBe(2);
        expect(report.references.missing).toEqual([]);
      }
    }
  });

  it('reports standard static Skill contract errors without promoting nested fixture Skills', async () => {
    const root = repoRoot();
    const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-static-skill-review-'));
    tempDirs.push(skillRoot);
    await fs.ensureDir(path.join(skillRoot, 'agents'));
    await fs.ensureDir(path.join(skillRoot, 'references', 'fixture'));
    await fs.writeFile(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'name: wrong-name',
      'description: Review an invalid static Skill fixture.',
      '---',
      '',
      'Read references/missing.md before continuing.',
    ].join('\n'), 'utf8');
    await fs.writeFile(
      path.join(skillRoot, 'references', 'fixture', 'SKILL.md'),
      '---\nname: nested\ndescription: Nested fixture only.\n---\n',
      'utf8',
    );
    await fs.writeFile(path.join(skillRoot, 'agents', 'openai.yaml'), [
      'interface:',
      '  display_name: "Wrong Name"',
      '  short_description: "too short"',
      '  default_prompt: "Use $wrong-name."',
      'policy:',
      '  allow_implicit_invocation: false',
    ].join('\n'), 'utf8');

    const failure = await execFileAsync('node', [
      skillScript('inspect_skill_target.mjs'),
      path.join(skillRoot, 'SKILL.md'),
      '--format',
      'json',
    ], {
      cwd: root,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    }).then(
      () => null,
      (error: { stdout?: string }) => error,
    );
    expect(failure?.stdout).toBeTruthy();
    const report = JSON.parse(failure!.stdout!);

    expect(report.target.kind).toBe('static-skill');
    expect(report.skill.frontmatter.name).toBe('wrong-name');
    expect(report.issues.map((issue: { code: string }) => issue.code)).toEqual(
      expect.arrayContaining([
        'frontmatter.directory-name',
        'reference.missing',
        'codex.short-description',
      ]),
    );
  });

  it('computes release gates without letting a score override P0', async () => {
    const root = repoRoot();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-review-scorecard-'));
    tempDirs.push(tempRoot);
    const template = await fs.readJson(
      path.join(root, '.agents', 'skills', 'skill-review', 'assets', 'scorecard-template.json'),
    );
    template.review = {
      skill_name: 'fixture',
      mode: 'release',
      direction: 'aligned',
      notes: '',
    };
    for (const key of Object.keys(template.artifacts)) {
      template.artifacts[key] = true;
    }
    template.dimensions = template.dimensions.map((dimension: Record<string, unknown>) => ({
      ...dimension,
      score: 5,
      confidence: 'high',
      evidence: ['fixture evidence'],
    }));
    template.gates = template.gates.map((gate: Record<string, unknown>) => ({
      ...gate,
      status: 'pass',
      reason: '',
    }));
    const scorecardPath = path.join(tempRoot, 'scorecard.json');
    await fs.writeJson(scorecardPath, template, { spaces: 2 });

    const passed = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(passed.stdout)).toMatchObject({
      score: {
        weighted_score: 100,
        coverage_percent: 100,
        release: 'pass',
      },
      valid: true,
    });

    template.gates[0].status = 'fail';
    template.gates[0].reason = 'Invalid package.';
    await fs.writeJson(scorecardPath, template, { spaces: 2 });
    const failedGate = await execFileAsync('node', [
      skillScript('validate_scorecard.mjs'),
      scorecardPath,
      '--format',
      'json',
    ], { cwd: root, env: process.env });
    expect(JSON.parse(failedGate.stdout)).toMatchObject({
      score: {
        weighted_score: 100,
        release: 'fail',
      },
      valid: true,
    });
  });

  it('keeps evaluated upstream content unchanged outside documented project adapters', async () => {
    const skillRoot = path.join(repoRoot(), '.agents', 'skills', 'skill-review');
    const exactHashes: Record<string, string> = {
      'assets/report-template.md': '945dcf02599d5d029c8741a200d4e3086c0f180ef1ab4a1a5888a29034b2e900',
      'assets/scorecard-template.json': 'f3d5a76e6433ff4cccf18ee1a6b2966962fd15ef747269e4abe8c78a01718394',
      'evals/behavior_cases.json': '97e25eb610d7340241a5e547cd2e0db6043e80339a61746a0551e8ec1226f3ed',
      'evals/scoring_cases.json': '051eea73afb9ae69997092e9f1b3f2a18a166e2178c45a02a12916a5b29647df',
      'evals/trigger_queries.json': '8dfb320d3cc5d2e9bc4b69302f300e410a6667d16885e598896307017df131e4',
      'references/architecture-boundaries.md': 'ce8bdd8039a4677fcd4b91562456c2d45f886ede8480745c784b63c46f799285',
      'references/delta-review.md': '57615d644f21362a43f758d85fbb758147c78862a2da17542f1e885ed58c6361',
      'references/evals-and-triggering.md': '9a764f102e4f687c8504f1c9af1a4ad7c65b69a04e3cc0322e86d7716af6b81e',
      'references/official-agent-skills-basis.md': 'de97ada70c914ac12c7136cc9365cff131d963e12a08edac3a0003f59981738a',
      'references/review-dimensions.md': '43c53ecfcf26de5523977108e0b726142da8da0105f89940f4089d7e3cce96a3',
      'references/scripts-and-resources.md': '3a3ca84008513249efc072e8c0450fe7d995929cbf8d50a50ff78bead915d83e',
    };
    for (const [relative, expected] of Object.entries(exactHashes)) {
      expect(contentDigest(await fs.readFile(path.join(skillRoot, relative), 'utf8'))).toBe(expected);
    }
    const awTriggerCorpus = await fs.readJson(
      path.join(skillRoot, 'evals', 'aw_plugin_trigger_queries.json'),
    );
    expect(awTriggerCorpus).toHaveLength(4);
    expect(awTriggerCorpus.filter((entry: { should_trigger: boolean }) =>
      entry.should_trigger)).toHaveLength(2);
    expect(new Set(awTriggerCorpus.map((entry: { split: string }) => entry.split))).toEqual(
      new Set(['train', 'validation']),
    );

    const readme = (await fs.readFile(path.join(skillRoot, 'README.md'), 'utf8'))
      .replace('node scripts/inspect_skill_target.mjs', 'python3 scripts/inspect_skill.py')
      .replace('node scripts/validate_scorecard.mjs', 'python3 scripts/validate_scorecard.py');
    expect(contentDigest(readme)).toBe(
      '67c4ccea1a46c89d795ae7df8026888e0943acff1c02169d08b5b031a4f723bb',
    );

    const skill = (await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'))
      .replace(
        '角色配置、完整技能包或当前 agent-workflows 项目的插件 Skill 时使用',
        '角色配置或完整技能包时使用',
      )
      .replace(
        'node scripts/inspect_skill_target.mjs <skill-dir-or-SKILL.md-or-plugin>',
        'python3 scripts/inspect_skill.py <skill-dir-or-SKILL.md>',
      )
      .replace('node scripts/validate_scorecard.mjs', 'python3 scripts/validate_scorecard.py')
      .replace(
        '   - 当前仓库的 AW 插件或动态 Skill：`references/agent-workflows-plugin.md`\n',
        '',
      );
    expect(contentDigest(skill)).toBe(
      'e22280736b484b54d1ca59a33b9eeb03571b42b9929bc3eb93a52c9725484944',
    );

    const scoringModel = (
      await fs.readFile(path.join(skillRoot, 'references', 'scoring-model.md'), 'utf8')
    ).replace('validate_scorecard.mjs', 'validate_scorecard.py');
    expect(contentDigest(scoringModel)).toBe(
      '40252cf854daaf4a54c71882481828912d875d9da35fb83d0e1d85e51236808b',
    );
  });
});
