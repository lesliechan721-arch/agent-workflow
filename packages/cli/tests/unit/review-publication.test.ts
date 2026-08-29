import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeReviewComponentDigest,
  listReviewRecords,
  parseReviewAttachment,
  publishReviewRecord,
  showReviewRecord,
  verifyReviewRecord,
  type PublishReviewRecordInput,
  type ReviewPublicationKind,
} from '../../src/commands/review-publication.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function scope(kind: 'workflow' | 'aw-workflow', id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind,
    id,
    userOutcome: 'Publish one immutable review.',
    entry: '.agents/skills/static-skill/SKILL.md',
    components: [{
      kind: 'skill',
      id: 'reviewer',
      path: '.agents/skills/static-skill',
      digest: 'sha256:4cb2b5f110f3deefe6f3f79187b22029a2b1f521322312f74dc9e0c93677812b',
    }],
    representativePaths: ['machine check -> static review -> optional audited Eval -> report'],
    externalDependencies: [],
    excluded: [],
  };
}

async function fixture(options: { generatedRuntime?: string } = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-publication-'));
  roots.push(root);
  await fs.ensureDir(path.join(root, '.agents', 'skills', 'static-skill'));
  await fs.writeFile(path.join(root, '.agents', 'skills', 'static-skill', 'SKILL.md'), '# Static\n');
  await fs.writeFile(path.join(root, '.agents', 'skills', 'static-skill', 'README.md'), '# Static\n');
  await fs.ensureDir(path.join(root, '.agents', 'skills', 'other-skill'));
  await fs.writeFile(path.join(root, '.agents', 'skills', 'other-skill', 'SKILL.md'), '# Other\n');
  await fs.writeFile(path.join(root, '.agents', 'skills', 'other-skill', 'README.md'), '# Other\n');
  await fs.ensureDir(path.join(root, 'plugins', 'demo-plugin', 'skills', 'plugin-skill'));
  await fs.writeFile(
    path.join(root, 'plugins', 'demo-plugin', 'skills', 'plugin-skill', 'SKILL.md'),
    [
      '---',
      'name: plugin-skill',
      'description: Review one plugin target.',
      '---',
      '# Plugin skill',
      ...(options.generatedRuntime ? ['[Generated](references/generated.md)'] : []),
      '',
    ].join('\n'),
  );
  await fs.writeFile(path.join(root, 'plugins', 'demo-plugin', 'skills', 'plugin-skill', 'README.md'), '# Plugin skill\n');
  await fs.outputFile(
    path.join(root, 'plugins', 'demo-plugin', 'skills', 'plugin-skill', 'agents', 'openai.yaml'),
    'interface:\n  display_name: Plugin skill\n',
  );
  await writeJson(path.join(root, 'plugins', 'demo-plugin', '.agents-plugin', 'plugin.json'), {
    name: 'demo-plugin',
    version: '0.1.0',
    description: 'Demo plugin.',
    schemaVersion: 2,
    skills: './skills',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    scripts: {
      tests: { node: ['./scripts/**/*.test.mjs'] },
      ...(options.generatedRuntime ? {
        node: { build: { runner: 'node', path: './scripts/build.mjs' } },
      } : {}),
    },
    ...(options.generatedRuntime ? {
      buildConfig: {
        generatedSkillRuntimeFiles: [{
          skill: 'plugin-skill',
          target: 'references/generated.md',
        }],
      },
    } : {}),
  });
  await fs.outputFile(
    path.join(root, 'plugins', 'demo-plugin', 'scripts', 'fixture.test.mjs'),
    'export {};\n',
  );
  if (options.generatedRuntime) {
    await fs.outputFile(
      path.join(root, 'plugins', 'demo-plugin', 'scripts', 'build.mjs'),
      [
        "import { mkdir, writeFile } from 'node:fs/promises';",
        "await mkdir('skills/plugin-skill/references', { recursive: true });",
        `await writeFile('skills/plugin-skill/references/generated.md', ${JSON.stringify(`${options.generatedRuntime}\n`)});`,
        '',
      ].join('\n'),
    );
  }
  await fs.writeFile(path.join(root, 'plugins', 'demo-plugin', 'runtime.txt'), 'runtime\n');
  await fs.writeFile(path.join(root, 'report.md'), '# Review\n');
  await fs.writeFile(path.join(root, 'report-2.md'), '# Review two\n');
  await writeJson(path.join(root, 'check.json'), { passed: true });
  await writeJson(path.join(root, 'check-2.json'), { passed: false });
  await writeJson(path.join(root, 'result.json'), { verdict: 'pass' });
  await writeJson(path.join(root, 'release.json'), { ready: true });
  await writeJson(path.join(root, 'workflow-scope.json'), scope('workflow', 'review-flow'));
  await writeJson(path.join(root, 'aw-workflow-scope.json'), scope('aw-workflow', 'aw-review-flow'));
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Review Test'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

function base(repoRoot: string, overrides: Partial<PublishReviewRecordInput> = {}): PublishReviewRecordInput {
  return {
    repoRoot,
    kind: 'skill',
    target: 'static-skill',
    report: 'report.md',
    now: new Date('2026-08-25T01:02:03Z'),
    ...overrides,
  };
}

async function configureDirectProviderConsumer(repoRoot: string): Promise<string> {
  const consumerRoot = path.join(repoRoot, 'extensions', 'demo-plugin');
  await fs.move(path.join(repoRoot, 'plugins', 'demo-plugin'), consumerRoot);
  const manifestPath = path.join(consumerRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  manifest.buildConfig = {
    skillRuntimeFiles: [{
      skill: 'plugin-skill',
      target: 'references/provider.txt',
      import: { plugin: 'runtime-provider', export: 'standard' },
    }],
  };
  await writeJson(manifestPath, manifest);
  return consumerRoot;
}

async function writeDirectProvider(root: string): Promise<void> {
  await writeJson(path.join(root, '.agents-plugin', 'plugin.json'), {
    name: 'runtime-provider',
    version: '0.1.0',
    description: 'Runtime provider.',
    schemaVersion: 2,
    skills: './skills',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    buildConfig: { runtimeExports: [{ name: 'standard', source: './standard.txt' }] },
  });
  await fs.outputFile(path.join(root, 'standard.txt'), 'provider bytes\n');
  await fs.outputFile(
    path.join(root, 'skills', 'provider-skill', 'SKILL.md'),
    '---\nname: provider-skill\ndescription: Provide runtime bytes.\n---\n# Provider\n',
  );
  await fs.outputFile(path.join(root, 'skills', 'provider-skill', 'README.md'), '# Provider\n');
}

describe('review publication', () => {
  it('publishes and verifies all four target kinds with canonical binding', async () => {
    const repoRoot = await fixture();
    const inputs: Array<Pick<PublishReviewRecordInput, 'kind' | 'target' | 'scope'>> = [
      { kind: 'skill', target: 'demo-plugin/plugin-skill' },
      { kind: 'aw-plugin', target: 'demo-plugin' },
      { kind: 'workflow', target: 'review-flow', scope: 'workflow-scope.json' },
      { kind: 'aw-workflow', target: 'aw-workflow-scope.json', scope: 'aw-workflow-scope.json' },
    ];
    for (const [index, input] of inputs.entries()) {
      const record = await publishReviewRecord(base(repoRoot, {
        ...input,
        now: new Date(`2026-08-25T01:02:0${index}Z`),
      }));
      expect(record.manifest.target.kind).toBe(input.kind);
      expect(record.manifest.target.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(path.basename(path.dirname(record.root))).toMatch(/^id-/u);
      await expect(verifyReviewRecord({
        repoRoot,
        reportDir: record.root,
      })).resolves.toMatchObject({ manifest: record.manifest });
    }
  });

  it('archives optional JSON attachments canonically and parses CLI attachment syntax', async () => {
    const repoRoot = await fixture();
    expect(parseReviewAttachment('eval-check=check.json')).toEqual({ kind: 'eval-check', path: 'check.json' });
    expect(() => parseReviewAttachment('Bad=check.json')).toThrow('lowercase kebab-case');
    const record = await publishReviewRecord(base(repoRoot, {
      result: 'result.json',
      checks: [{ kind: 'eval-check', path: 'check.json' }],
      evidence: [{ kind: 'trace', path: 'check.json' }],
      releaseCheck: 'release.json',
    }));
    expect(await fs.readFile(path.join(record.root, 'checks', 'eval-check.json'), 'utf8'))
      .toBe('{\n  "passed": true\n}\n');
    expect(record.manifest).toMatchObject({
      result: { path: 'review-result.json' },
      releaseCheck: { path: 'release-check.json' },
      source: { dirty: false },
    });
  });

  it('excludes author-only and transient files from the AW plugin production digest', async () => {
    const cleanRepo = await fixture();
    const noisyRepo = await fixture();
    const pluginRoot = path.join(noisyRepo, 'plugins', 'demo-plugin');
    await fs.outputFile(path.join(pluginRoot, 'reports', 'review.md'), 'author only\n');
    await fs.outputFile(path.join(pluginRoot, 'skills', 'plugin-skill', 'evals', 'case.json'), '{}\n');
    await fs.outputFile(path.join(pluginRoot, 'skills', 'plugin-skill', 'reports', 'result.md'), 'author only\n');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'another.test.mjs'), 'export {};\n');
    await fs.outputFile(path.join(pluginRoot, 'node_modules', 'dependency', 'index.js'), 'ignored\n');
    await fs.symlink(
      path.join(pluginRoot, 'node_modules', 'dependency'),
      path.join(pluginRoot, 'node_modules', 'linked-dependency'),
    );
    await fs.outputFile(path.join(pluginRoot, '.DS_Store'), 'ignored\n');
    const clean = await publishReviewRecord(base(cleanRepo, { kind: 'aw-plugin', target: 'demo-plugin' }));
    const noisy = await publishReviewRecord(base(noisyRepo, { kind: 'aw-plugin', target: 'demo-plugin' }));
    expect(noisy.manifest.target.digest).toBe(clean.manifest.target.digest);
  });

  it('binds the AW plugin digest to production Skill and generated runtime bytes', async () => {
    const cleanRepo = await fixture();
    const changedSkillRepo = await fixture();
    await fs.appendFile(
      path.join(changedSkillRepo, 'plugins', 'demo-plugin', 'skills', 'plugin-skill', 'SKILL.md'),
      'Production change.\n',
    );
    const clean = await publishReviewRecord(base(cleanRepo, { kind: 'aw-plugin', target: 'demo-plugin' }));
    const changedSkill = await publishReviewRecord(base(changedSkillRepo, { kind: 'aw-plugin', target: 'demo-plugin' }));
    expect(changedSkill.manifest.target.digest).not.toBe(clean.manifest.target.digest);

    const generatedOneRepo = await fixture({ generatedRuntime: 'generated one' });
    const generatedTwoRepo = await fixture({ generatedRuntime: 'generated two' });
    const generatedOne = await publishReviewRecord(base(generatedOneRepo, { kind: 'aw-plugin', target: 'demo-plugin' }));
    const generatedTwo = await publishReviewRecord(base(generatedTwoRepo, { kind: 'aw-plugin', target: 'demo-plugin' }));
    expect(generatedTwo.manifest.target.digest).not.toBe(generatedOne.manifest.target.digest);
  });

  it('accepts a repository-local custom AW plugin root and rejects an incorrect target id', async () => {
    const repoRoot = await fixture();
    const customRoot = await configureDirectProviderConsumer(repoRoot);
    await fs.outputFile(
      path.join(repoRoot, 'plugins', 'unrelated-broken', '.agents-plugin', 'plugin.json'),
      '{ broken default plugin',
    );
    await fs.outputFile(
      path.join(repoRoot, 'extensions', 'unrelated-broken', '.agents-plugin', 'plugin.json'),
      '{ broken sibling plugin',
    );
    const targetManifestPath = path.join(customRoot, '.agents-plugin', 'plugin.json');
    const providerRoot = path.join(repoRoot, 'extensions', 'runtime-provider');
    await writeDirectProvider(providerRoot);
    const original = await publishReviewRecord(base(repoRoot, {
      kind: 'aw-plugin',
      target: 'extensions/demo-plugin',
    }));
    expect(original.manifest.target.id).toBe('demo-plugin');

    await fs.outputFile(path.join(providerRoot, 'standard.txt'), 'changed provider bytes\n');
    const changed = await publishReviewRecord(base(repoRoot, {
      kind: 'aw-plugin',
      target: 'extensions/demo-plugin',
      report: 'report-2.md',
    }));
    expect(changed.manifest.target.digest).not.toBe(original.manifest.target.digest);

    const brokenProviderManifest = await fs.readJson(
      path.join(providerRoot, '.agents-plugin', 'plugin.json'),
    ) as Record<string, unknown>;
    brokenProviderManifest.version = 'broken';
    await writeJson(path.join(providerRoot, '.agents-plugin', 'plugin.json'), brokenProviderManifest);
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'aw-plugin',
      target: 'extensions/demo-plugin',
    }))).rejects.toThrow('strict SemVer');

    await fs.remove(providerRoot);
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'aw-plugin',
      target: 'extensions/demo-plugin',
    }))).rejects.toThrow('provider plugin "runtime-provider" is unavailable');

    const manifestPath = targetManifestPath;
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    manifest.name = 'wrong-plugin';
    await writeJson(manifestPath, manifest);
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'aw-plugin',
      target: 'extensions/demo-plugin',
      report: 'report-2.md',
    }))).rejects.toThrow('match target id');
  });

  it('rejects unsafe direct provider paths without scanning unrelated symlink plugins', async () => {
    const unsafeCases: Array<{
      name: string;
      arrange: (repoRoot: string, providerRoot: string) => Promise<void>;
    }> = [
      {
        name: 'default plugins ancestor',
        arrange: async (repoRoot, providerRoot) => {
          const externalPlugins = path.dirname(providerRoot);
          await fs.remove(path.join(repoRoot, 'plugins'));
          await fs.symlink(externalPlugins, path.join(repoRoot, 'plugins'));
        },
      },
      {
        name: 'sibling provider root',
        arrange: async (repoRoot, providerRoot) => {
          await fs.symlink(providerRoot, path.join(repoRoot, 'extensions', 'runtime-provider'));
        },
      },
      {
        name: 'sibling provider metadata directory',
        arrange: async (repoRoot, providerRoot) => {
          const siblingRoot = path.join(repoRoot, 'extensions', 'runtime-provider');
          await fs.move(providerRoot, siblingRoot);
          const externalMetadata = path.join(path.dirname(providerRoot), 'provider-metadata');
          await fs.move(path.join(siblingRoot, '.agents-plugin'), externalMetadata);
          await fs.symlink(externalMetadata, path.join(siblingRoot, '.agents-plugin'));
        },
      },
      {
        name: 'sibling provider manifest',
        arrange: async (repoRoot, providerRoot) => {
          const siblingRoot = path.join(repoRoot, 'extensions', 'runtime-provider');
          await fs.move(providerRoot, siblingRoot);
          const externalManifest = path.join(path.dirname(providerRoot), 'provider-manifest.json');
          await fs.move(path.join(siblingRoot, '.agents-plugin', 'plugin.json'), externalManifest);
          await fs.symlink(externalManifest, path.join(siblingRoot, '.agents-plugin', 'plugin.json'));
        },
      },
    ];

    for (const unsafeCase of unsafeCases) {
      const repoRoot = await fixture();
      await configureDirectProviderConsumer(repoRoot);
      const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-provider-'));
      roots.push(externalRoot);
      const providerRoot = path.join(externalRoot, 'runtime-provider');
      await writeDirectProvider(providerRoot);
      await unsafeCase.arrange(repoRoot, providerRoot);
      await expect(publishReviewRecord(base(repoRoot, {
        kind: 'aw-plugin',
        target: 'extensions/demo-plugin',
      })), unsafeCase.name).rejects.toThrow('symlink');
    }

    const repoRoot = await fixture();
    await configureDirectProviderConsumer(repoRoot);
    await writeDirectProvider(path.join(repoRoot, 'extensions', 'runtime-provider'));
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-unrelated-'));
    roots.push(externalRoot);
    await fs.symlink(externalRoot, path.join(repoRoot, 'plugins', 'unrelated-provider'));
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'aw-plugin',
      target: 'extensions/demo-plugin',
    }))).resolves.toMatchObject({ manifest: { target: { id: 'demo-plugin' } } });
  });

  it('is idempotent only when every publication input is unchanged', async () => {
    const repoRoot = await fixture();
    const input = base(repoRoot, { checks: [{ kind: 'gate', path: 'check.json' }] });
    const first = await publishReviewRecord(input);
    const second = await publishReviewRecord(input);
    expect(second.root).toBe(first.root);
    expect(second.existing).toBe(true);
    await expect(publishReviewRecord(base(repoRoot, {
      checks: [{ kind: 'gate', path: 'check-2.json' }],
    }))).rejects.toThrow('conflicting publication inputs');
    expect(await fs.readFile(path.join(first.root, 'checks', 'gate.json'), 'utf8')).toContain('true');
  });

  it('does not leave a partial record when commit fails', async () => {
    const repoRoot = await fixture();
    await expect(publishReviewRecord(base(repoRoot, {
      beforeCommit: () => { throw new Error('injected failure'); },
    }))).rejects.toThrow('injected failure');
    const reviewRoot = path.join(repoRoot, 'reports', 'reviews');
    const entries = await fs.pathExists(reviewRoot)
      ? (await fs.readdir(reviewRoot, { recursive: true }) as string[])
      : [];
    expect(entries.some((entry) => entry.endsWith('manifest.json') || entry.includes('.tmp-'))).toBe(false);
  });

  it('ignores weak temp staging in scans but rejects direct temp verification', async () => {
    const repoRoot = await fixture();
    const first = await publishReviewRecord(base(repoRoot));
    const targetParent = path.dirname(first.root);
    const emptyTemp = path.join(targetParent, '.tmp-empty');
    const partialTemp = path.join(targetParent, '.tmp-partial');
    const fullTemp = path.join(targetParent, '.tmp-full');
    await fs.mkdir(emptyTemp);
    await fs.outputFile(path.join(partialTemp, 'report.md'), '# partial\n');
    await fs.copy(first.root, fullTemp);

    expect(await listReviewRecords({ repoRoot })).toHaveLength(1);
    await expect(verifyReviewRecord({ repoRoot, reportDir: emptyTemp })).rejects.toThrow();
    await expect(verifyReviewRecord({ repoRoot, reportDir: partialTemp })).rejects.toThrow();
    await expect(verifyReviewRecord({ repoRoot, reportDir: fullTemp })).rejects.toThrow('storage path');

    const second = await publishReviewRecord(base(repoRoot, {
      report: 'report-2.md',
      now: new Date('2026-08-25T01:02:04Z'),
    }));
    expect(second.existing).toBe(false);
    expect(await listReviewRecords({ repoRoot })).toHaveLength(2);
    await expect(showReviewRecord({ repoRoot, reviewId: first.manifest.reviewId }))
      .resolves.toMatchObject({ root: first.root });
  });

  it('never overwrites a colliding review directory', async () => {
    const repoRoot = await fixture();
    const first = await publishReviewRecord(base(repoRoot));
    await fs.remove(first.root);
    await fs.ensureDir(first.root);
    await fs.writeFile(path.join(first.root, 'foreign.txt'), 'keep\n');
    await expect(publishReviewRecord(base(repoRoot))).rejects.toThrow();
    await expect(listReviewRecords({ repoRoot })).rejects.toThrow('manifest');
    expect(await fs.readFile(path.join(first.root, 'foreign.txt'), 'utf8')).toBe('keep\n');
  });

  it('detects archived-byte tampering', async () => {
    const repoRoot = await fixture();
    const record = await publishReviewRecord(base(repoRoot));
    await fs.writeFile(path.join(record.root, 'report.md'), '# changed\n');
    await expect(verifyReviewRecord({
      repoRoot,
      reportDir: record.root,
    })).rejects.toThrow('digest mismatch');
  });

  it('rejects every manifest identity mutation through verify, show, and supersedes', async () => {
    const mutations: Array<(recordRoot: string) => Promise<void>> = [
      async (recordRoot) => {
        const manifestPath = path.join(recordRoot, 'manifest.json');
        const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
        manifest.publishedAt = '2026-08-25T01:02:04.123Z';
        await writeJson(manifestPath, manifest);
      },
      async (recordRoot) => {
        const manifestPath = path.join(recordRoot, 'manifest.json');
        const manifest = await fs.readJson(manifestPath) as { target: { digest: string } };
        manifest.target.digest = `sha256:${'2'.repeat(64)}`;
        await writeJson(manifestPath, manifest);
      },
      async (recordRoot) => {
        const reportBytes = Buffer.from('# Replaced review\n');
        await fs.writeFile(path.join(recordRoot, 'report.md'), reportBytes);
        const manifestPath = path.join(recordRoot, 'manifest.json');
        const manifest = await fs.readJson(manifestPath) as { report: { digest: string } };
        manifest.report.digest = `sha256:${createHash('sha256').update(reportBytes).digest('hex')}`;
        await writeJson(manifestPath, manifest);
      },
    ];
    for (const mutate of mutations) {
      const repoRoot = await fixture();
      const record = await publishReviewRecord(base(repoRoot, {
        now: new Date('2026-08-25T01:02:03.123Z'),
      }));
      await mutate(record.root);
      await expect(verifyReviewRecord({ repoRoot, reportDir: record.root }))
        .rejects.toThrow('identity');
      await expect(showReviewRecord({ repoRoot, reviewId: record.manifest.reviewId }))
        .rejects.toThrow('identity');
      await expect(publishReviewRecord(base(repoRoot, {
        report: 'report-2.md',
        now: new Date('2026-08-25T01:02:05Z'),
        supersedes: record.manifest.reviewId,
      }))).rejects.toThrow('identity');
    }
  });

  it('keeps an old leaf record verifiable and supersedable after production changes', async () => {
    const repoRoot = await fixture();
    const previous = await publishReviewRecord(base(repoRoot));
    await fs.appendFile(path.join(repoRoot, '.agents', 'skills', 'static-skill', 'SKILL.md'), 'changed\n');
    await expect(verifyReviewRecord({
      repoRoot,
      reportDir: path.relative(await fs.realpath(repoRoot), previous.root),
    })).resolves.toMatchObject({ manifest: previous.manifest });
    await expect(showReviewRecord({ repoRoot, reviewId: previous.manifest.reviewId }))
      .resolves.toMatchObject({ manifest: previous.manifest });
    const next = await publishReviewRecord(base(repoRoot, {
      report: 'report-2.md',
      now: new Date('2026-08-25T01:02:04Z'),
      supersedes: previous.manifest.reviewId,
    }));
    expect(next.manifest.supersedes).toBe(previous.manifest.reviewId);
    expect(next.manifest.target.digest).not.toBe(previous.manifest.target.digest);
  });

  it('uses canonical scope digest and rejects unknown fields and path escape', async () => {
    const repoRoot = await fixture();
    const first = await publishReviewRecord(base(repoRoot, {
      kind: 'workflow', target: 'review-flow', scope: 'workflow-scope.json',
    }));
    const reorderedRepo = await fixture();
    const reordered = scope('workflow', 'review-flow');
    await writeJson(path.join(reorderedRepo, 'workflow-scope-reordered.json'), Object.fromEntries(
      Object.entries(reordered).reverse(),
    ));
    const second = await publishReviewRecord(base(reorderedRepo, {
      kind: 'workflow', target: 'review-flow', scope: 'workflow-scope-reordered.json',
    }));
    expect(second.manifest.target.digest).toBe(first.manifest.target.digest);

    await writeJson(path.join(repoRoot, 'bad-scope.json'), { ...scope('workflow', 'bad'), extra: true });
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'workflow', target: 'bad', scope: 'bad-scope.json',
    }))).rejects.toThrow('unknown or missing fields');

    const escaped = scope('workflow', 'escaped');
    (escaped.components as Array<Record<string, unknown>>)[0]!.path = '../outside';
    await writeJson(path.join(repoRoot, 'escaped-scope.json'), escaped);
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'workflow', target: 'escaped', scope: 'escaped-scope.json',
    }))).rejects.toThrow('escape');
  });

  it('binds workflow scope components to existing non-symlink repository content', async () => {
    const repoRoot = await fixture();
    const record = await publishReviewRecord(base(repoRoot, {
      kind: 'workflow', target: 'review-flow', scope: 'workflow-scope.json',
    }));
    await expect(verifyReviewRecord({ repoRoot, reportDir: record.root }))
      .resolves.toMatchObject({ manifest: record.manifest });

    const fileComponent = scope('workflow', 'file-flow');
    const component = (fileComponent.components as Array<Record<string, unknown>>)[0]!;
    component.path = '.agents/skills/static-skill/SKILL.md';
    component.digest = 'sha256:c795433b52117e631aab3560e920bf55b0be0b49de62f6ad240ea1edd789c3d5';
    await writeJson(path.join(repoRoot, 'file-scope.json'), fileComponent);
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'workflow', target: 'file-flow', scope: 'file-scope.json',
    }))).resolves.toMatchObject({ manifest: { target: { id: 'file-flow' } } });

    const missing = scope('workflow', 'missing-flow');
    (missing.components as Array<Record<string, unknown>>)[0]!.path = 'missing-component';
    await writeJson(path.join(repoRoot, 'missing-scope.json'), missing);
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'workflow', target: 'missing-flow', scope: 'missing-scope.json',
    }))).rejects.toThrow('does not exist');

    const forged = scope('workflow', 'forged-flow');
    (forged.components as Array<Record<string, unknown>>)[0]!.digest = `sha256:${'f'.repeat(64)}`;
    await writeJson(path.join(repoRoot, 'forged-scope.json'), forged);
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'workflow', target: 'forged-flow', scope: 'forged-scope.json',
    }))).rejects.toThrow('does not match repository content');

    await fs.appendFile(path.join(repoRoot, '.agents', 'skills', 'static-skill', 'SKILL.md'), 'stale\n');
    await expect(verifyReviewRecord({ repoRoot, reportDir: record.root }))
      .resolves.toMatchObject({ manifest: record.manifest });

    const linkedRoot = path.join(repoRoot, 'linked-component');
    await fs.symlink(path.join(repoRoot, '.agents', 'skills', 'static-skill'), linkedRoot);
    const linked = scope('workflow', 'linked-flow');
    (linked.components as Array<Record<string, unknown>>)[0]!.path = 'linked-component';
    await writeJson(path.join(repoRoot, 'linked-scope.json'), linked);
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'workflow', target: 'linked-flow', scope: 'linked-scope.json',
    }))).rejects.toThrow('symlink');
  });

  it('computes canonical file and directory digests and rejects unsafe component nodes', async () => {
    const repoRoot = await fixture();
    const directory = await computeReviewComponentDigest({
      repoRoot,
      path: '.agents/skills/static-skill',
    });
    const repeated = await computeReviewComponentDigest({
      repoRoot,
      path: path.join('.agents', 'skills', 'static-skill'),
    });
    const file = await computeReviewComponentDigest({
      repoRoot,
      path: '.agents/skills/static-skill/SKILL.md',
    });
    expect(repeated).toEqual(directory);
    expect(directory).toEqual({
      path: '.agents/skills/static-skill',
      digest: 'sha256:4cb2b5f110f3deefe6f3f79187b22029a2b1f521322312f74dc9e0c93677812b',
    });
    expect(file).toEqual({
      path: '.agents/skills/static-skill/SKILL.md',
      digest: 'sha256:c795433b52117e631aab3560e920bf55b0be0b49de62f6ad240ea1edd789c3d5',
    });

    await expect(computeReviewComponentDigest({ repoRoot, path: 'missing' }))
      .rejects.toThrow('does not exist');
    await expect(computeReviewComponentDigest({ repoRoot, path: path.dirname(repoRoot) }))
      .rejects.toThrow('escapes');

    const linkedRoot = path.join(repoRoot, 'linked-root');
    await fs.symlink(path.join(repoRoot, '.agents', 'skills', 'static-skill'), linkedRoot);
    await expect(computeReviewComponentDigest({ repoRoot, path: 'linked-root' }))
      .rejects.toThrow('symlink');
    await expect(computeReviewComponentDigest({ repoRoot, path: 'linked-root/SKILL.md' }))
      .rejects.toThrow('symlink');

    const treeRoot = path.join(repoRoot, 'component-tree');
    await fs.ensureDir(treeRoot);
    await fs.writeFile(path.join(treeRoot, 'ordinary.txt'), 'ordinary\n');
    await fs.symlink(path.join(repoRoot, 'report.md'), path.join(treeRoot, 'linked.txt'));
    await expect(computeReviewComponentDigest({ repoRoot, path: 'component-tree' }))
      .rejects.toThrow('symlink');

    if (process.platform !== 'win32') {
      const fifo = path.join(repoRoot, 'unsafe-node');
      await execFileAsync('mkfifo', [fifo]);
      await expect(computeReviewComponentDigest({ repoRoot, path: 'unsafe-node' }))
        .rejects.toThrow('regular file or directory');
    }
  });

  it('treats a workflow target equal to scope id as an id before a repository path', async () => {
    const repoRoot = await fixture();
    await fs.writeFile(path.join(repoRoot, 'review-flow'), 'unrelated repository file\n');
    const record = await publishReviewRecord(base(repoRoot, {
      kind: 'workflow',
      target: 'review-flow',
      scope: 'workflow-scope.json',
    }));
    expect(record.manifest.target.id).toBe('review-flow');

    const explicit = await publishReviewRecord(base(repoRoot, {
      kind: 'aw-workflow',
      target: 'aw-workflow-scope.json',
      scope: 'aw-workflow-scope.json',
    }));
    expect(explicit.manifest.target.id).toBe('aw-review-flow');
  });

  it('treats canonical Skill and plugin targets as ids before colliding repository paths', async () => {
    const repoRoot = await fixture();
    await fs.writeFile(path.join(repoRoot, 'static-skill'), 'unrelated file\n');
    await fs.writeFile(path.join(repoRoot, 'demo-plugin'), 'unrelated file\n');
    await expect(publishReviewRecord(base(repoRoot, { target: 'static-skill' })))
      .resolves.toMatchObject({ manifest: { target: { id: 'static-skill' } } });
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'aw-plugin',
      target: 'demo-plugin',
      report: 'report-2.md',
    }))).resolves.toMatchObject({ manifest: { target: { id: 'demo-plugin' } } });
  });

  it('accepts a direct ordinary static Skill path as a compatible review target', async () => {
    const repoRoot = await fixture();
    await expect(publishReviewRecord(base(repoRoot, { target: '.agents/skills/static-skill' })))
      .resolves.toMatchObject({ manifest: { target: { id: 'static-skill', kind: 'skill' } } });
  });

  it('accepts supersedes only for a verified record with the same target', async () => {
    const repoRoot = await fixture();
    const previous = await publishReviewRecord(base(repoRoot));
    const next = await publishReviewRecord(base(repoRoot, {
      report: 'report-2.md',
      now: new Date('2026-08-25T01:02:04Z'),
      supersedes: previous.manifest.reviewId,
    }));
    expect(next.manifest.supersedes).toBe(previous.manifest.reviewId);
    await expect(publishReviewRecord(base(repoRoot, {
      target: 'other-skill',
      report: 'report-2.md',
      now: new Date('2026-08-25T01:02:05Z'),
      supersedes: previous.manifest.reviewId,
    }))).rejects.toThrow('same kind and target');
  });

  it('lists with stable filtering and shows only globally unique review ids', async () => {
    const repoRoot = await fixture();
    const later = await publishReviewRecord(base(repoRoot, {
      report: 'report-2.md', now: new Date('2026-08-25T02:00:00Z'),
    }));
    const earlier = await publishReviewRecord(base(repoRoot, {
      target: 'other-skill', now: new Date('2026-08-25T01:00:00Z'),
    }));
    expect((await listReviewRecords({ repoRoot })).map((entry) => entry.manifest.reviewId))
      .toEqual([earlier.manifest.reviewId, later.manifest.reviewId]);
    expect(await listReviewRecords({ repoRoot, kind: 'skill', targetId: 'static-skill' }))
      .toHaveLength(1);
    await expect(showReviewRecord({ repoRoot, reviewId: later.manifest.reviewId }))
      .resolves.toMatchObject({ root: later.root });

    const duplicate = path.join(repoRoot, 'reports', 'reviews', 'workflow', 'id-ZHVwbGljYXRl', later.manifest.reviewId);
    await fs.copy(later.root, duplicate);
    await expect(showReviewRecord({ repoRoot, reviewId: later.manifest.reviewId }))
      .rejects.toThrow('found 2');
  });

  it('rejects input escape and symlinks without publishing', async () => {
    const repoRoot = await fixture();
    const outside = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-outside.md`);
    await fs.writeFile(outside, '# outside\n');
    try {
      await expect(publishReviewRecord(base(repoRoot, { report: outside }))).rejects.toThrow('escapes');
      await fs.symlink(path.join(repoRoot, 'report.md'), path.join(repoRoot, 'linked-report.md'));
      await expect(publishReviewRecord(base(repoRoot, { report: 'linked-report.md' }))).rejects.toThrow('symlink');
      await fs.symlink(
        path.join(repoRoot, '.agents', 'skills', 'static-skill'),
        path.join(repoRoot, '.agents', 'skills', 'linked-skill'),
      );
      await expect(publishReviewRecord(base(repoRoot, { target: '.agents/skills/linked-skill' })))
        .rejects.toThrow('symlink');

      await fs.symlink(path.join(repoRoot, 'report.md'), path.join(repoRoot, 'plugins', 'demo-plugin', 'linked.txt'));
      await expect(publishReviewRecord(base(repoRoot, { kind: 'aw-plugin', target: 'demo-plugin' })))
        .rejects.toThrow('symlink');
    } finally {
      await fs.remove(outside);
    }
  });

  it('rejects a symlink in the publication storage path', async () => {
    const repoRoot = await fixture();
    const redirected = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-redirect-'));
    roots.push(redirected);
    await fs.symlink(redirected, path.join(repoRoot, 'reports'));
    await expect(publishReviewRecord(base(repoRoot))).rejects.toThrow('symlink');
    expect(await fs.readdir(redirected)).toEqual([]);
  });

  it('rejects verify directories outside the repository or reached through symlinks', async () => {
    const repoRoot = await fixture();
    const record = await publishReviewRecord(base(repoRoot));
    await expect(verifyReviewRecord({ repoRoot, reportDir: path.dirname(repoRoot) }))
      .rejects.toThrow('escapes');
    const linkedRecord = path.join(repoRoot, 'linked-record');
    await fs.symlink(record.root, linkedRecord);
    await expect(verifyReviewRecord({ repoRoot, reportDir: linkedRecord }))
      .rejects.toThrow('symlink');
  });

  it('rejects scope for leaf kinds and mismatched workflow targets', async () => {
    const repoRoot = await fixture();
    for (const kind of ['skill', 'aw-plugin'] as ReviewPublicationKind[]) {
      await expect(publishReviewRecord(base(repoRoot, {
        kind,
        target: kind === 'skill' ? 'static-skill' : 'demo-plugin',
        scope: 'workflow-scope.json',
      }))).rejects.toThrow('does not accept scope');
    }
    await expect(publishReviewRecord(base(repoRoot, {
      kind: 'workflow', target: 'different', scope: 'workflow-scope.json',
    }))).rejects.toThrow('match scope id');
  });
});
