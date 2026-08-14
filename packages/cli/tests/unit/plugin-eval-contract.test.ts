import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  combinePluginEvalOutcome,
  readPluginEvalManifest,
} from '../../scripts/plugin-eval-contract.js';
import { materializePluginEvalSubjects } from '../../scripts/plugin-eval-materializer.js';

const tempDirs: string[] = [];

function skillEvalPath(pluginRoot: string, ...segments: string[]): string {
  return path.join(pluginRoot, 'skills', 'eval-fixture', 'evals', ...segments);
}

async function createStaticEvalPlugin(): Promise<string> {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-contract-'));
  tempDirs.push(pluginRoot);
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.ensureDir(path.join(pluginRoot, 'skills', 'eval-fixture', 'agents'));
  await fs.ensureDir(path.join(pluginRoot, 'skills', 'eval-fixture', 'evals'));
  await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
    name: 'eval-fixture',
    version: '0.1.0',
    description: 'Static plugin eval fixture.',
    compatibility: {
      aw: { minVersion: '0.0.0' },
    },
    skills: './skills',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    },
  }, { spaces: 2 });
  await fs.writeFile(
    path.join(pluginRoot, 'skills', 'eval-fixture', 'SKILL.md'),
    [
      '---',
      'name: eval-fixture',
      'description: Use only for the static plugin eval fixture.',
      'disable-model-invocation: true',
      'user-invocable: true',
      '---',
      '',
      '# Eval Fixture',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(pluginRoot, 'skills', 'eval-fixture', 'agents', 'openai.yaml'),
    [
      'interface:',
      '  display_name: "Eval Fixture"',
      '  short_description: "Materialize the static plugin eval fixture"',
      '  default_prompt: "Use $eval-fixture for this fixture."',
      'policy:',
      '  allow_implicit_invocation: false',
    ].join('\n'),
    'utf8',
  );
  await fs.writeJson(path.join(
    pluginRoot,
    'skills',
    'eval-fixture',
    'evals',
    'trigger-cases.json',
  ), {
    schemaVersion: 1,
    skill: 'eval-fixture',
    cases: [{
      id: 'explicit_fixture',
      split: 'validation',
      query: '$eval-fixture inspect the fixture.',
      should_load_skill: true,
    }],
  }, { spaces: 2 });
  await fs.writeJson(path.join(
    pluginRoot,
    'skills',
    'eval-fixture',
    'evals',
    'manifest.json',
  ), {
    schemaVersion: 2,
    plugin: 'eval-fixture',
    skill: 'eval-fixture',
    profiles: [
      {
        id: 'project-runtime',
        scope: 'project',
        plugins: [{ name: 'eval-fixture', config: {} }],
        runModel: true,
        requiredForRelease: true,
      },
      {
        id: 'user-runtime',
        scope: 'user',
        plugins: [{ name: 'eval-fixture', config: {} }],
        runModel: false,
        requiredForRelease: true,
      },
    ],
    suites: [
      {
        id: 'trigger',
        kind: 'trigger',
        skills: ['eval-fixture'],
        cases: './trigger-cases.json',
        observeSpawnAgent: false,
        isolation: 'standard',
        strictNegativeSplits: ['validation'],
        profiles: ['project-runtime'],
        defaultRuns: 1,
        releaseSplits: ['validation'],
        requiredForRelease: true,
        perRunTimeoutMs: 10_000,
      },
    ],
  }, { spaces: 2 });
  return pluginRoot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin eval contract and materialization', () => {
  it('materializes project and user evidence without starting a model', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    const plugin = await readPluginManifest(pluginRoot);
    const manifest = await readPluginEvalManifest(pluginRoot, 'eval-fixture');
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-output-'));
    const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-work-'));
    tempDirs.push(outputRoot);
    tempDirs.push(workRoot);

    const subjects = await materializePluginEvalSubjects({
      plugin,
      plugins: [plugin],
      manifest,
      outputRoot,
      workRoot,
      env: process.env,
    });

    expect(subjects).toHaveLength(2);
    expect(subjects.map((subject) => [subject.profile, subject.evidenceLevel])).toEqual([
      ['project-runtime', 'runtime-project'],
      ['user-runtime', 'materialized-user'],
    ]);
    expect(subjects[0].bundleDigest).toBe(subjects[1].bundleDigest);
    for (const subject of subjects) {
      expect(subject.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'skill', key: 'eval-fixture' }),
      ]));
      await expect(
        fs.pathExists(path.join(outputRoot, subject.root, '.agents', 'skills', 'eval-fixture', 'SKILL.md')),
      ).resolves.toBe(true);
      await expect(
        fs.readFile(
          path.join(outputRoot, subject.root, '.agents', 'skills', 'eval-fixture', 'agents', 'openai.yaml'),
          'utf8',
        ),
      ).resolves.toContain('allow_implicit_invocation: false');
      expect(subject.artifacts.some((artifact) => artifact.path.includes('/evals/'))).toBe(false);
    }
  });

  it('rejects release splits for conversation suites without split filtering', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    await fs.writeJson(skillEvalPath(pluginRoot, 'conversation-cases.json'), {
      skill_name: 'eval-fixture',
      evals: [{
        id: 'conversation-fixture',
        prompt: 'Inspect the fixture.',
        scripted_replies: [],
        expected_output: 'Return the result.',
        review: { checks: ['Inspects the fixture.'], workspace_unchanged: true },
      }],
    }, { spaces: 2 });
    const manifestPath = skillEvalPath(pluginRoot, 'manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.suites = [{
      id: 'conversation',
      kind: 'conversation',
      skills: ['eval-fixture'],
      cases: './conversation-cases.json',
      profiles: ['project-runtime'],
      defaultRuns: 1,
      releaseSplits: ['validation'],
      requiredForRelease: true,
      perRunTimeoutMs: 10_000,
    }];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'cannot declare releaseSplits because conversation cases do not support split filtering',
    );
  });

  it('parses conversation isolation and keeps the schema-v2 standard default', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    await fs.writeJson(skillEvalPath(pluginRoot, 'conversation-cases.json'), {
      skill_name: 'eval-fixture',
      evals: [{
        id: 'conversation-fixture',
        prompt: 'Inspect the fixture.',
        scripted_replies: [],
        expected_output: 'Return the result.',
        review: { checks: ['Inspects the fixture.'], workspace_unchanged: true },
      }],
    }, { spaces: 2 });
    const manifestPath = skillEvalPath(pluginRoot, 'manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.suites = [{
      id: 'conversation',
      kind: 'conversation',
      skills: ['eval-fixture'],
      cases: './conversation-cases.json',
      profiles: ['project-runtime'],
      defaultRuns: 1,
      releaseSplits: [],
      requiredForRelease: true,
      perRunTimeoutMs: 10_000,
      isolation: 'strict',
    }];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const strict = await readPluginEvalManifest(pluginRoot, 'eval-fixture');
    expect(strict.suites[0]).toMatchObject({ kind: 'conversation', isolation: 'strict' });

    delete manifest.suites[0].isolation;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const standard = await readPluginEvalManifest(pluginRoot, 'eval-fixture');
    expect(standard.suites[0]).toMatchObject({ kind: 'conversation', isolation: 'standard' });

    manifest.suites[0].isolation = 'partial';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'suites[0].isolation must be standard or strict',
    );
  });

  it('accepts bounded conversation workspace files and rejects unsafe paths', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    const casesPath = skillEvalPath(pluginRoot, 'conversation-cases.json');
    await fs.writeJson(casesPath, {
      skill_name: 'eval-fixture',
      evals: [{
        id: 'read_workspace_fact',
        prompt: 'Read docs/eval-context.md before answering.',
        scripted_replies: [],
        expected_output: 'Use the workspace fact.',
        workspace_files: {
          'docs/eval-context.md': 'Known project fact.\n',
        },
        review: { checks: ['Uses the workspace fact.'], workspace_unchanged: true },
      }],
    }, { spaces: 2 });
    const manifestPath = skillEvalPath(pluginRoot, 'manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.suites = [{
      id: 'conversation',
      kind: 'conversation',
      skills: ['eval-fixture'],
      cases: './conversation-cases.json',
      profiles: ['project-runtime'],
      defaultRuns: 1,
      releaseSplits: [],
      requiredForRelease: true,
      perRunTimeoutMs: 10_000,
    }];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).resolves.toMatchObject({
      suites: [expect.objectContaining({ kind: 'conversation' })],
    });

    const cases = await fs.readJson(casesPath);
    cases.evals[0].workspace_files = { '../escape.md': 'escape' };
    await fs.writeJson(casesPath, cases, { spaces: 2 });
    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'must be a normalized POSIX path inside the eval workspace',
    );

    cases.evals[0].workspace_files = { '.agents/skills/escape.md': 'escape' };
    await fs.writeJson(casesPath, cases, { spaces: 2 });
    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'must not target an eval control directory',
    );
  });

  it('accepts bounded workspace-write conversation cases with artifact assertions', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    await fs.writeJson(skillEvalPath(pluginRoot, 'conversation-cases.json'), {
      skill_name: 'eval-fixture',
      evals: [{
        id: 'write_artifact',
        prompt: 'Create the requested artifact.',
        scripted_replies: [],
        expected_output: 'Create outputs/result.json.',
        sandbox: 'workspace-write',
        review: {
          checks: ['Creates the requested bounded artifact.'],
          workspace_unchanged: false,
          allowed_workspace_changes: ['outputs/**'],
          artifacts: [{
            path: 'outputs/result.json',
            exists: true,
            contains: ['"status"'],
            not_contains: ['secret'],
            json: { status: 'ok' },
          }],
        },
      }],
    }, { spaces: 2 });
    const manifestPath = skillEvalPath(pluginRoot, 'manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.suites = [{
      id: 'conversation',
      kind: 'conversation',
      skills: ['eval-fixture'],
      cases: './conversation-cases.json',
      profiles: ['project-runtime'],
      defaultRuns: 1,
      releaseSplits: [],
      requiredForRelease: true,
      perRunTimeoutMs: 10_000,
    }];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).resolves.toMatchObject({
      suites: [expect.objectContaining({ kind: 'conversation' })],
    });

    const cases = await fs.readJson(skillEvalPath(pluginRoot, 'conversation-cases.json'));
    cases.evals[0].review.artifacts[0].path = 'outside/result.json';
    await fs.writeJson(skillEvalPath(pluginRoot, 'conversation-cases.json'), cases, { spaces: 2 });
    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'artifact path "outside/result.json" is outside review.allowed_workspace_changes',
    );
  });

  it('rejects workspace-write cases without a bounded write and artifact contract', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    await fs.writeJson(skillEvalPath(pluginRoot, 'conversation-cases.json'), {
      skill_name: 'eval-fixture',
      evals: [{
        id: 'unbounded_write',
        prompt: 'Change the workspace.',
        scripted_replies: [],
        expected_output: 'Change files.',
        sandbox: 'workspace-write',
        review: {
          checks: ['Changes files.'],
          workspace_unchanged: true,
          allowed_workspace_changes: ['.agents/**'],
          artifacts: [],
        },
      }],
    }, { spaces: 2 });
    const manifestPath = skillEvalPath(pluginRoot, 'manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.suites = [{
      id: 'conversation',
      kind: 'conversation',
      skills: ['eval-fixture'],
      cases: './conversation-cases.json',
      profiles: ['project-runtime'],
      defaultRuns: 1,
      releaseSplits: [],
      requiredForRelease: true,
      perRunTimeoutMs: 10_000,
    }];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'must not target an eval control directory',
    );
  });

  it('rejects model execution for a user profile', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    const manifestPath = skillEvalPath(pluginRoot, 'manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.profiles[1].runModel = true;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'does not allow real model execution for user-scope profiles',
    );
  });

  it('rejects unknown eval profile fields', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    const manifestPath = skillEvalPath(pluginRoot, 'manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.profiles[0].unsupportedField = true;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'profiles[0] has unknown field "unsupportedField"',
    );
  });

  it('rejects invalid native invocation metadata before eval materialization', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    await fs.writeFile(
      path.join(pluginRoot, 'skills', 'eval-fixture', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: "false"\n',
      'utf8',
    );
    const plugin = await readPluginManifest(pluginRoot);
    const manifest = await readPluginEvalManifest(pluginRoot, 'eval-fixture');
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-output-'));
    const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-work-'));
    tempDirs.push(outputRoot);
    tempDirs.push(workRoot);

    await expect(materializePluginEvalSubjects({
      plugin,
      plugins: [plugin],
      manifest,
      outputRoot,
      workRoot,
      env: process.env,
    })).rejects.toThrow('policy.allow_implicit_invocation 必须是 boolean');
  });

  it('rejects trigger cases that do not match the suite observation contract', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    const casesPath = skillEvalPath(pluginRoot, 'trigger-cases.json');
    const document = await fs.readJson(casesPath);
    document.cases[0].should_spawn_agent = true;
    await fs.writeJson(casesPath, document, { spaces: 2 });

    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'should_spawn_agent requires observeSpawnAgent=true',
    );
  });

  it('parses exact trigger routes and route scoring controls', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    const casesPath = skillEvalPath(pluginRoot, 'trigger-cases.json');
    const document = await fs.readJson(casesPath);
    delete document.cases[0].should_load_skill;
    document.cases[0].expected_loaded_skills = [];
    await fs.writeJson(casesPath, document, { spaces: 2 });

    const manifestPath = skillEvalPath(pluginRoot, 'manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.suites[0].minimumPassRate = 0.9;
    manifest.suites[0].forbidMultipleSkillLoads = true;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const parsed = await readPluginEvalManifest(pluginRoot, 'eval-fixture');
    expect(parsed.suites[0]).toMatchObject({
      kind: 'trigger',
      minimumPassRate: 0.9,
      forbidMultipleSkillLoads: true,
    });

    document.cases[0].should_load_skill = false;
    await fs.writeJson(casesPath, document, { spaces: 2 });
    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'must declare exactly one of should_load_skill or expected_loaded_skills',
    );
  });

  it('rejects a trigger route that names a non-participant Skill', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    const casesPath = skillEvalPath(pluginRoot, 'trigger-cases.json');
    const document = await fs.readJson(casesPath);
    delete document.cases[0].should_load_skill;
    document.cases[0].expected_loaded_skills = ['other-skill'];
    await fs.writeJson(casesPath, document, { spaces: 2 });

    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'contains non-participant Skill "other-skill"',
    );
  });

  it.runIf(process.platform !== 'win32')(
    'rejects eval assets whose symlinks resolve outside the plugin root',
    async () => {
      const pluginRoot = await createStaticEvalPlugin();
      const casesPath = skillEvalPath(pluginRoot, 'trigger-cases.json');
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-outside-'));
      tempDirs.push(outsideRoot);
      const outsideCasesPath = path.join(outsideRoot, 'trigger-cases.json');
      await fs.copyFile(casesPath, outsideCasesPath);
      await fs.remove(casesPath);
      await fs.symlink(outsideCasesPath, casesPath);

      await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
        'must stay inside the Skill eval directory',
      );
    },
  );

  it('combines suite outcomes by release severity', () => {
    expect(combinePluginEvalOutcome([{ outcome: 'passed' }])).toBe('passed');
    expect(combinePluginEvalOutcome([{ outcome: 'passed' }, { outcome: 'needs_review' }]))
      .toBe('needs_review');
    expect(combinePluginEvalOutcome([{ outcome: 'needs_review' }, { outcome: 'failed' }]))
      .toBe('failed');
    expect(combinePluginEvalOutcome([{ outcome: 'failed' }, { outcome: 'incomplete' }]))
      .toBe('incomplete');
  });
});
