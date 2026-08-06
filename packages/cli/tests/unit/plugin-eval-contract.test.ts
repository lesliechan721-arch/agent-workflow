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

async function createStaticEvalPlugin(): Promise<string> {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-contract-'));
  tempDirs.push(pluginRoot);
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.ensureDir(path.join(pluginRoot, 'skills', 'eval-fixture', 'agents'));
  await fs.ensureDir(path.join(pluginRoot, 'evals'));
  await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
    name: 'eval-fixture',
    version: '0.1.0',
    description: 'Static plugin eval fixture.',
    compatibility: {
      aw: { minVersion: '0.0.0' },
    },
    skills: './skills',
    skillTriggers: {
      'eval-fixture': {
        defaultTrigger: 'manual',
        allowDynamicTrigger: false,
      },
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
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
  await fs.writeJson(path.join(pluginRoot, 'evals', 'trigger-cases.json'), {
    schemaVersion: 1,
    skill: 'eval-fixture',
    cases: [{
      id: 'explicit_fixture',
      split: 'validation',
      query: '$eval-fixture inspect the fixture.',
      should_load_skill: true,
    }],
  }, { spaces: 2 });
  await fs.writeJson(path.join(pluginRoot, 'evals', 'manifest.json'), {
    schemaVersion: 1,
    plugin: 'eval-fixture',
    profiles: [
      {
        id: 'project-default',
        scope: 'project',
        config: {},
        triggerPreference: 'default',
        runModel: true,
        requiredForRelease: true,
      },
      {
        id: 'user-default',
        scope: 'user',
        config: {},
        triggerPreference: 'default',
        runModel: false,
        requiredForRelease: true,
      },
    ],
    suites: [
      {
        id: 'trigger',
        kind: 'trigger',
        skill: 'eval-fixture',
        cases: './evals/trigger-cases.json',
        observeSpawnAgent: false,
        isolation: 'standard',
        strictNegativeSplits: ['validation'],
        profiles: ['project-default'],
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
    tempDirs.push(outputRoot);

    const subjects = await materializePluginEvalSubjects({
      plugin,
      manifest,
      outputRoot,
      env: process.env,
    });

    expect(subjects).toHaveLength(2);
    expect(subjects.map((subject) => [subject.profile, subject.evidenceLevel])).toEqual([
      ['project-default', 'runtime-project'],
      ['user-default', 'materialized-user'],
    ]);
    expect(subjects[0].bundleDigest).toBe(subjects[1].bundleDigest);
    for (const subject of subjects) {
      expect(subject.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'skill', key: 'eval-fixture' }),
      ]));
      await expect(
        fs.pathExists(path.join(outputRoot, subject.root, '.agents', 'skills', 'eval-fixture', 'SKILL.md')),
      ).resolves.toBe(true);
      expect(subject.artifacts.some((artifact) => artifact.path.includes('/evals/'))).toBe(false);
    }
  });

  it('rejects model execution for a user profile', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    const manifestPath = path.join(pluginRoot, 'evals', 'manifest.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.profiles[1].runModel = true;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'does not allow real model execution for user-scope profiles',
    );
  });

  it('rejects trigger cases that do not match the suite observation contract', async () => {
    const pluginRoot = await createStaticEvalPlugin();
    const casesPath = path.join(pluginRoot, 'evals', 'trigger-cases.json');
    const document = await fs.readJson(casesPath);
    document.cases[0].should_spawn_agent = true;
    await fs.writeJson(casesPath, document, { spaces: 2 });

    await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
      'should_spawn_agent requires observeSpawnAgent=true',
    );
  });

  it.runIf(process.platform !== 'win32')(
    'rejects eval assets whose symlinks resolve outside the plugin root',
    async () => {
      const pluginRoot = await createStaticEvalPlugin();
      const casesPath = path.join(pluginRoot, 'evals', 'trigger-cases.json');
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-eval-outside-'));
      tempDirs.push(outsideRoot);
      const outsideCasesPath = path.join(outsideRoot, 'trigger-cases.json');
      await fs.copyFile(casesPath, outsideCasesPath);
      await fs.remove(casesPath);
      await fs.symlink(outsideCasesPath, casesPath);

      await expect(readPluginEvalManifest(pluginRoot, 'eval-fixture')).rejects.toThrow(
        'must stay inside the plugin root',
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
