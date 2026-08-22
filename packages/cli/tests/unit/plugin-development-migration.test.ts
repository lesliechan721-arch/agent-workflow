import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSkillEvalRunLayout,
  publishEvalRunToBatch,
  sealSkillReportBatch,
} from '../../scripts/skill-reporting.js';

import {
  computeMigrationSourceDigest,
  verifyPluginDevelopmentMigration,
} from '../../../../scripts/migration/verify-plugin-development-migration.mjs';
import { cutoverPluginDevelopment } from '../../../../scripts/migration/cutover-plugin-development.mjs';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const contractSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/plugin-development-migration.json',
);
const legacyRouteLinks = [
  '[create-aw-plugin](.agents/skills/create-aw-plugin/SKILL.md)',
  '[skill-review](.agents/skills/skill-review/SKILL.md)',
];
const replacementRouteLink = '[author-aw-plugin](plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md)';
const hiddenRouteCases: Array<[string, (route: string) => string]> = [
  ['a multiline HTML comment', (route) => `<!--\n${route}\n-->`],
  ['an unclosed HTML comment', (route) => `<!--\n${route}`],
  ['a backtick fence', (route) => `\`\`\`markdown\n${route}\n\`\`\``],
  ['a tilde fence', (route) => `~~~markdown\n${route}\n~~~`],
  ['a blockquote fence', (route) => `> > \`\`\`markdown\n> > ${route}\n> > \`\`\``],
  ['an HTML pre block', (route) => `<PRE class="example">\n${route}\n</PRE>`],
  ['an HTML code block', (route) => `<code>\n${route}\n</code>`],
  ['indented code', (route) => `    ${route}`],
  ['inline code', (route) => `\`${route}\``],
  ['multiline inline code', (route) => `\`hidden\n${route}\ncontent\``],
];

async function writeFile(root: string, relative: string, content = 'fixture\n'): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
}

async function writeFixture(mutate?: (contract: Record<string, any>) => void): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-migration-'));
  roots.push(root);
  const contract = JSON.parse(await fs.readFile(contractSource, 'utf8'));
  mutate?.(contract);
  await writeFile(root, 'docs/plugin-development-migration.json', `${JSON.stringify(contract, null, 2)}\n`);

  const files = new Set<string>([
    ...contract.legacyEntrypoints,
    ...contract.replacementEntrypoints,
    ...contract.capabilityMatrix.map((entry: { owner: string }) => entry.owner).filter(Boolean),
  ]);
  for (const gate of contract.cutoverGates) {
    for (const item of gate.implementationEvidence ?? []) {
      for (const relative of item.paths) files.add(relative);
    }
    for (const requirement of gate.requiredSuites ?? []) files.add(requirement.manifest);
  }
  for (const relative of files) await writeFile(root, relative);

  const routes = contract.legacyRoutes.map((route: { contains: string }) => route.contains).join('\n');
  await writeFile(root, 'AGENTS.md', `${routes}\n`);
  return root;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

let evidenceSequence = 0;

async function writeCanonicalEvidenceBatch(options: {
  root: string;
  plugin: string;
  skill: string;
  manifest: Record<string, any>;
  sourceDigest: string;
  gitHead: string;
}): Promise<{ path: string; digest: string }> {
  evidenceSequence += 1;
  const requiredTargets = [
    ...options.manifest.profiles
      .filter((profile: any) => profile.requiredForRelease)
      .map((profile: any) => `materialization/${profile.id}`),
    ...options.manifest.suites
      .filter((suite: any) => suite.requiredForRelease)
      .flatMap((suite: any) => suite.profiles.flatMap((profile: string) =>
        (suite.releaseSplits.length > 0 ? suite.releaseSplits : ['all'])
          .map((split: string) => `${suite.kind}/${suite.id}/${profile}/${split}/all`))),
  ].sort();
  const owner = {
    kind: 'plugin-skill' as const,
    plugin: options.plugin,
    skill: options.skill,
  };
  const suffix = evidenceSequence.toString(16).padStart(8, '0');
  const layout = await createSkillEvalRunLayout({
    repoRoot: options.root,
    owner,
    batchName: `migration-${options.skill}`,
    runId: `20260821T000000Z-${suffix}`,
    source: {
      digest: options.sourceDigest,
      gitHead: options.gitHead,
      inScopeDirty: false,
    },
    environmentDigest: `sha256:${'2'.repeat(64)}`,
    modelEnvironmentDigest: `sha256:${'3'.repeat(64)}`,
    harnessDigest: `sha256:${'4'.repeat(64)}`,
    requiredTargets,
  });
  const evaluation = {
    generatedAt: '2026-08-21T00:00:00.000Z',
    outcome: 'passed' as const,
    complete: true,
    mechanicalPassed: true,
    subjects: options.manifest.profiles
      .filter((profile: any) => profile.requiredForRelease)
      .map((profile: any) => ({ profile: profile.id, scope: profile.scope })),
    suites: options.manifest.suites
      .filter((suite: any) => suite.requiredForRelease)
      .flatMap((suite: any) => suite.profiles.flatMap((profile: string) =>
        (suite.releaseSplits.length > 0 ? suite.releaseSplits : ['all']).map((split: string) => ({
          id: suite.id,
          kind: suite.kind,
          profile,
          split,
          outcome: 'passed' as const,
          complete: true,
          mechanicalPassed: true,
        })))),
    diagnostics: [],
  };
  await fs.writeFile(path.join(layout.reportRoot, 'report.md'), '# Eval Run\n');
  await fs.writeFile(
    path.join(layout.reportRoot, 'summary.json'),
    `${JSON.stringify(evaluation, null, 2)}\n`,
  );
  await publishEvalRunToBatch({
    repoRoot: options.root,
    layout,
    evaluation,
    requiredTargets,
  });
  await sealSkillReportBatch({ repoRoot: options.root, owner, batchId: layout.batchId });
  const archive = `docs/plugin-development-evidence/${options.plugin}/${options.skill}/${layout.batchId}`;
  await fs.cp(layout.batchRoot, path.join(options.root, archive), { recursive: true });
  const relative = `${archive}/evals/evaluation.json`;
  const value = await fs.readFile(path.join(options.root, relative), 'utf8');
  return { path: relative, digest: digest(value) };
}

async function writeReadyFixture(): Promise<string> {
  const root = await writeFixture();
  await fs.writeFile(path.join(root, 'AGENTS.md'), [
    '- 创建或维护 `plugins/<name>/` 时，使用 [create-aw-plugin](.agents/skills/create-aw-plugin/SKILL.md)。修改 manifest/schema、adapter、scope、插件分发/安装流程或作者合同工具时，读取[插件维护指南](docs/plugin-maintenance.md)和相关架构说明。',
    '- 只读评审静态 Skill 或插件 Skill 时，使用 [skill-review](.agents/skills/skill-review/SKILL.md)。',
    '',
  ].join('\n'));
  const contractPath = path.join(root, 'docs/plugin-development-migration.json');
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  const suitesByManifest = new Map<string, Set<string>>();
  for (const gate of contract.cutoverGates) {
    for (const requirement of gate.requiredSuites ?? []) {
      const suites = suitesByManifest.get(requirement.manifest) ?? new Set<string>();
      suites.add(requirement.suite);
      suitesByManifest.set(requirement.manifest, suites);
    }
  }
  for (const [manifestPath, suiteIds] of suitesByManifest) {
    const [, plugin, , skill] = manifestPath.split('/');
    await writeFile(root, manifestPath, `${JSON.stringify({
      schemaVersion: 2,
      plugin,
      skill,
      profiles: [{
        id: 'project-default',
        scope: 'project',
        plugins: [{ name: plugin, config: {} }],
        runModel: true,
        requiredForRelease: true,
      }],
      suites: [...suiteIds].map((id) => ({
        id,
        kind: id === 'trigger' ? 'trigger' : 'conversation',
        skills: [skill],
        cases: `./${id}-cases.json`,
        profiles: ['project-default'],
        defaultRuns: 1,
        releaseSplits: [],
        requiredForRelease: true,
        perRunTimeoutMs: 1,
        isolation: 'strict',
      })),
    }, null, 2)}\n`);
  }
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'AW Test'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'aw-test@example.invalid'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  })).stdout.trim();
  const evidenceByTarget = new Map<string, { path: string; digest: string }>();
  for (const gate of contract.cutoverGates) {
    for (const evidence of gate.modelEvidence ?? []) {
      const key = `${evidence.plugin}/${evidence.skill}`;
      let record = evidenceByTarget.get(key);
      if (!record) {
        const manifestPath = `plugins/${evidence.plugin}/skills/${evidence.skill}/evals/manifest.json`;
        const manifest = JSON.parse(await fs.readFile(path.join(root, manifestPath), 'utf8'));
        const pluginNames = [...new Set(manifest.profiles.flatMap((profile: any) =>
          profile.plugins.map((plugin: any) => plugin.name)))];
        record = await writeCanonicalEvidenceBatch({
          root,
          plugin: evidence.plugin,
          skill: evidence.skill,
          manifest,
          sourceDigest: await computeMigrationSourceDigest(root, pluginNames),
          gitHead: head,
        });
        evidenceByTarget.set(key, record);
      }
      evidence.evidencePath = record.path;
      evidence.evidenceDigest = record.digest;
    }
  }
  contract.status = 'ready-for-cutover';
  await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-qm', 'add migration evidence'], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('plugin development migration gate', () => {
  it('accepts only the canonical parallel migration and never claims cutover readiness', async () => {
    const result = await verifyPluginDevelopmentMigration({ root: await writeFixture() });

    expect(result).toMatchObject({
      ok: true,
      status: 'parallel',
      cutoverReady: false,
      capabilityCounts: { migrated: 9, legacyRetained: 3 },
      gateCount: 7,
      errors: [],
    });
  });

  it.each(['ready-for-cutover', 'retired'])('fails closed for self-reported %s status without model evidence', async (status) => {
    const result = await verifyPluginDevelopmentMigration({
      root: await writeFixture((contract) => {
        contract.status = status;
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.cutoverReady).toBe(false);
    expect(result.errors).toContain(
      'reviewer-behavior model evidence for agent-skill-toolkit/review-agent-skill is required for cutover',
    );
  });

  it('accepts ready-for-cutover only with current, passed release model evidence', async () => {
    const result = await verifyPluginDevelopmentMigration({ root: await writeReadyFixture() });

    expect(result).toMatchObject({
      schemaVersion: 2,
      ok: true,
      status: 'ready-for-cutover',
      cutoverReady: true,
      errors: [],
    });
  });

  it('rejects tampered model evidence and dirty release sources', async () => {
    const root = await writeReadyFixture();
    const contract = JSON.parse(await fs.readFile(
      path.join(root, 'docs/plugin-development-migration.json'),
      'utf8',
    ));
    const evidence = contract.cutoverGates[2].modelEvidence[0];
    await fs.appendFile(path.join(root, evidence.evidencePath), 'tampered\n');
    await fs.appendFile(
      path.join(root, 'plugins/agent-skill-toolkit/.agents-plugin/plugin.json'),
      'dirty\n',
    );

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'reviewer-behavior model evidence for agent-skill-toolkit/review-agent-skill digest does not match',
    );
    expect(result.errors).toContain(
      'four-layer-trigger model evidence for agent-skill-toolkit/author-agent-skill source plugin set is dirty or cannot be verified',
    );
  });

  it('rejects model evidence with a fabricated source digest', async () => {
    const root = await writeReadyFixture();
    const contractPath = path.join(root, 'docs/plugin-development-migration.json');
    const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
    const evidence = contract.cutoverGates[2].modelEvidence[0];
    const evaluationPath = path.join(root, evidence.evidencePath);
    const evaluation = JSON.parse(await fs.readFile(evaluationPath, 'utf8'));
    evaluation.source.digest = `sha256:${'1'.repeat(64)}`;
    const value = `${JSON.stringify(evaluation, null, 2)}\n`;
    await fs.writeFile(evaluationPath, value);
    for (const gate of contract.cutoverGates) {
      for (const candidate of gate.modelEvidence ?? []) {
        if (candidate.evidencePath === evidence.evidencePath) candidate.evidenceDigest = digest(value);
      }
    }
    await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-qm', 'tamper migration evidence'], { cwd: root });

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'reviewer-behavior model evidence for agent-skill-toolkit/review-agent-skill source digest does not match current production sources',
    );
  });

  it('rejects model evidence from a temporary path', async () => {
    const root = await writeReadyFixture();
    const contractPath = path.join(root, 'docs/plugin-development-migration.json');
    const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
    const evidence = contract.cutoverGates[2].modelEvidence[0];
    const value = await fs.readFile(path.join(root, evidence.evidencePath), 'utf8');
    const temporaryPath = '.tmp/evidence/evaluation.json';
    await writeFile(root, temporaryPath, value);
    evidence.evidencePath = temporaryPath;
    evidence.evidenceDigest = digest(value);
    await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'reviewer-behavior model evidence for agent-skill-toolkit/review-agent-skill must use a persistent migration evidence path',
    );
  });

  it('rejects a hand-written minimal evaluation without canonical batch evidence', async () => {
    const root = await writeReadyFixture();
    const contractPath = path.join(root, 'docs/plugin-development-migration.json');
    const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
    const evidence = contract.cutoverGates[2].modelEvidence[0];
    const evaluationPath = path.join(root, evidence.evidencePath);
    const canonical = JSON.parse(await fs.readFile(evaluationPath, 'utf8'));
    const minimal = `${JSON.stringify({
      schemaVersion: 1,
      batchId: canonical.batchId,
      owner: canonical.owner,
      source: canonical.source,
      outcome: 'passed',
      complete: true,
      mechanicalPassed: true,
      targets: canonical.targets.map((target: any) => ({
        target: target.target,
        runId: target.runId,
        requiredForRelease: true,
        outcome: 'passed',
        complete: true,
        mechanicalPassed: true,
      })),
    }, null, 2)}\n`;
    await fs.writeFile(evaluationPath, minimal);
    for (const gate of contract.cutoverGates) {
      for (const candidate of gate.modelEvidence ?? []) {
        if (candidate.evidencePath === evidence.evidencePath) candidate.evidenceDigest = digest(minimal);
      }
    }
    await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-qm', 'replace canonical evidence'], { cwd: root });

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'reviewer-behavior model evidence for agent-skill-toolkit/review-agent-skill does not match its canonical sealed batch summary',
    );
  });

  it('rejects untracked batch support files restored after deletion from HEAD', async () => {
    const root = await writeReadyFixture();
    const contract = JSON.parse(await fs.readFile(
      path.join(root, 'docs/plugin-development-migration.json'),
      'utf8',
    ));
    const evidence = contract.cutoverGates[2].modelEvidence[0];
    const archive = path.posix.dirname(path.posix.dirname(evidence.evidencePath));
    const batchRelative = `${archive}/batch.json`;
    const batchPath = path.join(root, batchRelative);
    const batch = await fs.readFile(batchPath);
    await execFileAsync('git', ['rm', '-q', '--', batchRelative], { cwd: root });
    await execFileAsync('git', ['commit', '-qm', 'remove batch support'], { cwd: root });
    await fs.writeFile(batchPath, batch);

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'reviewer-behavior model evidence for agent-skill-toolkit/review-agent-skill batch must match evidence committed at HEAD',
    );
  });

  it('provides a verified dry run and an explicit reversible cutover action', async () => {
    const root = await writeReadyFixture();
    await expect(cutoverPluginDevelopment({ root })).resolves.toMatchObject({
      applied: false,
      status: 'ready-for-cutover',
    });
    await expect(cutoverPluginDevelopment({ root, apply: true })).resolves.toMatchObject({
      applied: true,
      status: 'retired',
    });
    await expect(verifyPluginDevelopmentMigration({ root })).resolves.toMatchObject({
      ok: true,
      status: 'retired',
    });
  });

  it('rejects retired state that deletes legacy routes and entrypoints', async () => {
    const result = await verifyPluginDevelopmentMigration({
      root: await writeFixture((contract) => {
        contract.status = 'retired';
        contract.legacyRoutes = [];
        contract.legacyEntrypoints = [];
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('legacyRoutes must exactly match the canonical migration contract');
    expect(result.errors).toContain('legacyEntrypoints must exactly match the canonical migration contract');
  });

  it.each([
    ['deleted capability', (contract: Record<string, any>) => contract.capabilityMatrix.pop(), 'capabilityMatrix'],
    ['redirected capability', (contract: Record<string, any>) => { contract.capabilityMatrix[0].owner = 'README.md'; }, 'capabilityMatrix'],
    ['extra capability', (contract: Record<string, any>) => { contract.capabilityMatrix.push({ id: 'extra', disposition: 'migrated', owner: 'README.md' }); }, 'capabilityMatrix'],
    ['changed gate suite target', (contract: Record<string, any>) => { contract.cutoverGates[2].requiredSuites[0].suite = 'trigger'; }, 'cutoverGates'],
    ['changed implementation evidence', (contract: Record<string, any>) => { contract.cutoverGates[0].implementationEvidence[0].paths = []; }, 'cutoverGates'],
    ['non-null model evidence', (contract: Record<string, any>) => { contract.cutoverGates[2].modelEvidence[0].evidencePath = 'fake.json'; }, 'cutoverGates'],
  ])('rejects a parallel contract with %s', async (_name, mutate, section) => {
    const result = await verifyPluginDevelopmentMigration({ root: await writeFixture(mutate) });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`${section} must exactly match the canonical migration contract`);
  });

  it('rejects a missing legacy route and a missing replacement entrypoint', async () => {
    const root = await writeFixture();
    // Static contract exception: removing the public repository route makes the retained workflow unreachable; behavior test is not suitable because AGENTS.md is the routing contract consumed by the agent host.
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'no legacy routes\n');
    await fs.rm(path.join(root, 'plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md'));

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('legacy route must be present: AGENTS.md');
    expect(result.errors).toContain('replacement entrypoint is missing or unsafe: plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md');
  });

  it.each(hiddenRouteCases)('rejects a legacy route hidden in %s', async (_name, hideRoute) => {
    const root = await writeFixture();
    // Static contract exception: a hidden public repository route makes the retained workflow unreachable; behavior test is not suitable because AGENTS.md is the routing contract consumed by the agent host.
    await fs.writeFile(
      path.join(root, 'AGENTS.md'),
      `${legacyRouteLinks[0]}\n${hideRoute(legacyRouteLinks[1])}\n`,
    );

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('legacy route must be present: AGENTS.md');
  });

  it.each(hiddenRouteCases)('does not activate a replacement route hidden in %s', async (_name, hideRoute) => {
    const root = await writeFixture();
    // Static contract exception: a hidden future route must not block the parallel migration; behavior test is not suitable because AGENTS.md is the routing contract consumed by the agent host.
    await fs.appendFile(path.join(root, 'AGENTS.md'), `${hideRoute(replacementRouteLink)}\n`);

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(true);
  });

  it('rejects a replacement route that claims to be active during parallel migration', async () => {
    const root = await writeFixture();
    // Static contract exception: activating the future public route early can silently replace the retained workflow; behavior test is not suitable because AGENTS.md is the routing contract consumed by the agent host.
    await fs.appendFile(
      path.join(root, 'AGENTS.md'),
      `${replacementRouteLink}\n`,
    );

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('replacement route must not be active while status is parallel: AGENTS.md');
  });

  it('rejects an external final entrypoint symlink without disclosing its referent', async () => {
    const root = await writeFixture();
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-migration-external-'));
    roots.push(external);
    const relative = 'plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md';
    const target = path.join(root, relative);
    const externalFile = path.join(external, 'secret');
    await fs.writeFile(externalFile, 'secret\n');
    await fs.rm(target);
    await fs.symlink(externalFile, target);

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`replacement entrypoint is missing or unsafe: ${relative}`);
    expect(result.errors.join('\n')).not.toContain(externalFile);
  });

  it('rejects an external parent symlink without disclosing its referent', async () => {
    const root = await writeFixture();
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-migration-parent-'));
    roots.push(external);
    const parent = path.join(root, '.agents/skills/create-aw-plugin/scripts');
    await fs.rm(parent, { recursive: true });
    await fs.symlink(external, parent);

    const result = await verifyPluginDevelopmentMigration({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('legacy entrypoint is missing or unsafe: .agents/skills/create-aw-plugin/scripts/add_skill.mjs');
    expect(result.errors.join('\n')).not.toContain(external);
  });
});
