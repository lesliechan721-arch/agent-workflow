import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const execFileAsync = promisify(execFile);
const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? localRoot;
const bundleRoot = context?.plugin.rootDir ?? localRoot;
const root = context ? path.join(bundleRoot, context.platform) : localRoot;
const temps = [];
const PRODUCTION_DIGEST_DOMAIN = 'aw-production-records-v1';
after(async () => Promise.all(temps.map((p) => rm(p, { recursive: true, force: true }))));
async function run(rel, args = []) {
  const runtimeRelative = rel.startsWith('scripts/')
    ? `skills/review-agent-skill/${rel}`
    : rel;
  return execFileAsync(process.execPath, [path.join(root, runtimeRelative), ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}
async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' });
}
function sha(d) {
  return 'sha256:' + createHash('sha256').update(d).digest('hex');
}
function comparePosixPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function updateLengthPrefixed(hash, value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}
function productionDigest(files, owner = null) {
  const hash = createHash('sha256');
  updateLengthPrefixed(hash, PRODUCTION_DIGEST_DOMAIN);
  const records = files.map((file) => ({
    path: owner === null ? file.relative : `${owner}/${file.relative}`,
    mode: file.mode,
    content: file.content,
  }));
  for (const record of records.sort((left, right) =>
    comparePosixPaths(left.path, right.path))) {
    updateLengthPrefixed(hash, record.path);
    updateLengthPrefixed(hash, record.mode);
    updateLengthPrefixed(hash, createHash('sha256').update(record.content).digest());
  }
  return `sha256:${hash.digest('hex')}`;
}

async function createSkillReviewSubject(directory, options = {}) {
  const subjectRelative = options.subjectRelative ?? 'skills/fixture';
  const owner = options.owner ?? 'fixture';
  const role = options.role ?? 'source';
  const executableMode = process.platform === 'win32' ? '100644' : '100755';
  const files = [
    { relative: 'SKILL.md', content: '---\nname: fixture\ndescription: fixture\n---\n', mode: '100644' },
    { relative: 'scripts/run.mjs', content: 'export const value = 1;\n', mode: executableMode },
  ];
  for (const file of files) {
    const filePath = path.join(directory, subjectRelative, file.relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content);
    await chmod(filePath, file.mode === '100755' ? 0o755 : 0o644);
  }
  return {
    environment: { repositoryRoot: directory },
    artifacts: files.map((file) => ({
      role,
      path: `${subjectRelative}/${file.relative}`,
      profile: role === 'final' ? 'codex-project' : null,
      digest: sha(file.content),
      mode: file.mode,
      owner,
      currentness: 'unknown',
    })),
    sourceDigest: productionDigest(files),
  };
}

async function createPluginReviewSubject(directory, options = {}) {
  const owner = options.owner ?? 'fixture';
  const pluginRelative = options.pluginRelative ?? `plugins/${owner}`;
  const relative = '.agents-plugin/plugin.json';
  const content = `${JSON.stringify({ name: owner, version: '1.0.0' })}\n`;
  const filePath = path.join(directory, pluginRelative, relative);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  await chmod(filePath, 0o644);
  return {
    environment: { repositoryRoot: directory },
    artifacts: [{
      role: 'project-profile',
      path: `${pluginRelative}/${relative}`,
      profile: 'aw',
      digest: sha(content),
      mode: '100644',
      owner,
      currentness: 'unknown',
    }],
    sourceDigest: productionDigest([{ relative, content, mode: '100644' }], owner),
  };
}
async function files(d) {
  const out = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
test('staged runtime contains fresh generated views and projected canonical files', async () => {
  if (context) {
    await execFileAsync(process.execPath, [
      path.join(sourceRoot, 'scripts/generate-standard-views.mjs'),
      '--check',
      '--source-root', sourceRoot,
      '--output-root', root,
      '--content-rules',
      path.resolve(sourceRoot, '..', 'agent-content-toolkit', 'standards', 'rules.json'),
    ], { cwd: context.cwd, encoding: 'utf8' });
  }
  const sourceManifest = JSON.parse(
    await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'),
  );
  for (const projection of sourceManifest.buildConfig.skillRuntimeFiles) {
    const providerRoot = projection.source
      ? sourceRoot
      : path.resolve(sourceRoot, '..', projection.import.plugin);
    const source = projection.source
      ? projection.source.replace(/^\.\//u, '')
      : projection.import.export === 'reference-audit-result-schema'
        ? 'schemas/reference-audit-result.schema.json'
        : null;
    assert.ok(source, `unknown imported runtime file: ${JSON.stringify(projection)}`);
    const [canonicalRaw, runtimeRaw] = await Promise.all([
      readFile(path.join(providerRoot, source)),
      readFile(path.join(root, 'skills', projection.skill, projection.target)),
    ]);
    assert.equal(
      createHash('sha256').update(runtimeRaw).digest('hex'),
      createHash('sha256').update(canonicalRaw).digest('hex'),
      `${projection.skill}/${projection.target} must match its canonical source`,
    );
  }
});
test('standard generation fails closed without the catalog content-rules import', async () => {
  const env = { ...process.env };
  delete env.AW_PLUGIN_IMPORT_CONTENT_RULES;
  await assert.rejects(
    execFileAsync(process.execPath, [
      path.join(sourceRoot, 'scripts/generate-standard-views.mjs'),
      '--check',
      '--source-root', sourceRoot,
      '--output-root', root,
    ], { cwd: context?.cwd ?? root, env, encoding: 'utf8' }),
    /AW_PLUGIN_IMPORT_CONTENT_RULES/u,
  );
});
test('cacheable standard render is deterministic across undeclared environment changes', async () => {
  async function render(marker) {
    const outputRoot = await mkdtemp(path.join(tmpdir(), 'skill-standard-render-'));
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        path.join(sourceRoot, 'scripts/generate-standard-views.mjs'),
        '--source-root', sourceRoot,
        '--output-root', outputRoot,
        '--content-rules',
        path.resolve(sourceRoot, '..', 'agent-content-toolkit', 'standards', 'rules.json'),
      ], {
        cwd: context?.cwd ?? sourceRoot,
        env: { ...process.env, AW_PLUGIN_TEST_UNDECLARED: marker },
        encoding: 'utf8',
      });
      const { targets } = JSON.parse(stdout);
      return Promise.all(
        targets.map(async (relative) => [
          relative,
          createHash('sha256').update(await readFile(path.join(outputRoot, relative))).digest('hex'),
        ]),
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }
  assert.deepEqual(await render('first'), await render('second'));
});
test('source excludes generated views and projected runtime copies', async () => {
  const violations = (await files(path.join(sourceRoot, 'skills')))
    .map((file) => path.relative(sourceRoot, file).split(path.sep).join('/'))
    .filter((relative) =>
      relative.includes('.generated.') ||
      relative.endsWith('/references/composition-audit.md') ||
      relative.endsWith('/references/composition-fitness.md') ||
      relative.endsWith('/references/evidence-and-severity.md') ||
      relative.endsWith('.schema.json') ||
      (/\/scripts\/(inspect-agent-skill|validate-json-contract|validate-review-result|validate-review-input-bundle|validate-eval-audit-result|validate-eval-run-bundle)\.mjs$/u).test(relative),
    );
  assert.deepEqual(violations, []);
});
test('owned contracts and manifest use release version', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(bundleRoot, '.agents-plugin/plugin.json'), 'utf8'),
  );
  const sourceManifest = JSON.parse(
    await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(manifest.version, '0.7.1');
  assert.equal(sourceManifest.buildConfig.cacheable, true);
  for (const [name, id] of [
    [
      'skill-design-brief.schema.json',
      'https://agent-skill-toolkit.invalid/schemas/skill-design-brief.schema.json',
    ],
    [
      'eval-audit-result.schema.json',
      'https://agent-skill-toolkit.invalid/schemas/eval-audit-result.schema.json',
    ],
  ])
    assert.equal(
      JSON.parse(
        await readFile(path.join(root, 'skills/author-agent-skill/assets', name), 'utf8'),
      ).$id,
      id,
    );
});
test('starter contracts validate', async () => {
  const pairs = [
    [
      'skills/author-agent-skill/assets/skill-design-brief.schema.json',
      'skills/author-agent-skill/assets/skill-design-brief.template.json',
    ],
    [
      'skills/audit-agent-skill-evals/assets/eval-audit-result.schema.json',
      'skills/audit-agent-skill-evals/assets/eval-audit-result-template.json',
    ],
    [
      'skills/review-agent-skill/assets/review-input-bundle.schema.json',
      'skills/review-agent-skill/assets/review-input-bundle.json',
    ],
  ];
  for (const [s, v] of pairs) await run('scripts/validate-json-contract.mjs', [s, v]);
  await run('scripts/validate-review-result.mjs', [
    'skills/review-agent-skill/assets/review-result-template.json',
  ]);
});
test('ReviewInputBundle validator binds a real stage file and digest', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'review-handoff-'));
  temps.push(t);
  const subject = await createSkillReviewSubject(t);
  const result = {
    schemaVersion: 2,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'a',
    mode: 'preflight',
    targetSkillDigest: subject.sourceDigest,
    caseCorpusDigest: 'sha256:' + '2'.repeat(64),
    validity: 'unknown',
    optimizationPolicy: 'balanced',
    cases: [],
    blockedCases: [],
    releaseEligible: false,
    failureTriage: [],
    recommendedAction: 'collect-more-data',
  };
  const raw = JSON.stringify(result),
    rp = path.join(t, 'audit.json');
  await writeFile(rp, raw);
  const bundle = {
    schemaVersion: 4,
    target: {
      kind: 'agent-skill',
      name: 'x',
      profile: null,
      sourceDigest: subject.sourceDigest,
      currentness: 'unknown',
    },
    artifacts: subject.artifacts,
    environment: subject.environment,
    orchestration: {
      stageOwner: 'caller',
      providedStages: [
        {
          id: 'eval-audit',
          producer: 'audit-agent-skill-evals',
          independentContext: true,
          subjectDigest: subject.sourceDigest,
          resultPath: 'audit.json',
          resultDigest: sha(raw),
          schema: 'EvalAuditResult',
          profile: null,
        },
      ],
    },
    evalAudit: result,
    evalResults: [],
  };
  const bp = path.join(t, 'bundle.json');
  await writeFile(bp, JSON.stringify(bundle));
  assert.equal(
    JSON.parse(
      (
        await run('scripts/validate-review-input-bundle.mjs', [
          bp,
          '--handoff-root',
          t,
          '--format',
          'json',
        ])
      ).stdout,
    ).valid,
    true,
  );
  bundle.schemaVersion = 3;
  await writeFile(bp, JSON.stringify(bundle));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bp, '--handoff-root', t]),
    /Command failed/u,
  );
  bundle.schemaVersion = 4;
  bundle.orchestration.providedStages[0].resultPath = 'missing.json';
  await writeFile(bp, JSON.stringify(bundle));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bp, '--handoff-root', t]),
    /Command failed/u,
  );

  const missingStage = structuredClone(bundle);
  missingStage.orchestration.providedStages = [];
  await writeFile(bp, JSON.stringify(missingStage));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bp, '--handoff-root', t]),
    /Command failed/u,
  );

  const replacement = {
    ...result,
    auditId: 'replacement',
    recommendedAction: 'runtime-issue',
  };
  const replacementRaw = JSON.stringify(replacement);
  await writeFile(rp, replacementRaw);
  const replacedStage = structuredClone(bundle);
  replacedStage.orchestration.providedStages[0].resultPath = 'audit.json';
  replacedStage.orchestration.providedStages[0].resultDigest = sha(replacementRaw);
  await writeFile(bp, JSON.stringify(replacedStage));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bp, '--handoff-root', t]),
    /Command failed/u,
  );
});

test('ReviewInputBundle binds production artifacts to real files, modes, and sourceDigest', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-artifact-binding-'));
  temps.push(directory);
  const subject = await createSkillReviewSubject(directory);
  const bundlePath = path.join(directory, 'bundle.json');
  const bundle = {
    schemaVersion: 4,
    target: {
      kind: 'agent-skill',
      name: 'fixture',
      profile: null,
      sourceDigest: subject.sourceDigest,
      currentness: 'unknown',
    },
    artifacts: subject.artifacts,
    environment: subject.environment,
    orchestration: { stageOwner: 'caller', providedStages: [] },
    evalAudit: null,
    evalResults: [],
  };

  async function rejects(candidate, pattern) {
    await writeFile(bundlePath, JSON.stringify(candidate));
    await assert.rejects(
      run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']),
      pattern,
    );
  }

  await writeFile(bundlePath, JSON.stringify(bundle));
  assert.equal(
    JSON.parse(
      (await run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']))
        .stdout,
    ).valid,
    true,
  );

  await writeFile(path.join(directory, 'skills/fixture/.DS_Store'), 'finder metadata\n');
  await mkdir(path.join(directory, 'skills/fixture/references/.DS_Store'), { recursive: true });
  await writeFile(
    path.join(directory, 'skills/fixture/references/.DS_Store/metadata'),
    'nested finder metadata\n',
  );
  await writeFile(bundlePath, JSON.stringify(bundle));
  assert.equal(
    JSON.parse(
      (await run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']))
        .stdout,
    ).valid,
    true,
  );

  const hiddenPath = path.join(directory, 'skills/fixture/.runtime-hidden');
  await writeFile(hiddenPath, 'hidden production file\n');
  await rejects(bundle, /Command failed/u);
  await rm(hiddenPath);

  const omittedPath = path.join(directory, 'skills/fixture/omitted.md');
  await writeFile(omittedPath, 'omitted production file\n');
  await rejects(bundle, /Command failed/u);
  await rm(omittedPath);

  const extraPath = path.join(directory, 'extra.md');
  const extraContent = 'extra production artifact\n';
  await writeFile(extraPath, extraContent);
  const extra = structuredClone(bundle);
  extra.artifacts.push({
    role: 'source',
    path: 'extra.md',
    profile: null,
    digest: sha(extraContent),
    mode: '100644',
    owner: 'fixture',
    currentness: 'current',
  });
  await rejects(extra, /Command failed/u);

  const missing = structuredClone(bundle);
  missing.artifacts[0].path = 'skills/fixture/missing.md';
  await rejects(missing, /Command failed/u);

  const tampered = structuredClone(bundle);
  tampered.artifacts[0].digest = sha('forged');
  await rejects(tampered, /Command failed/u);

  const escaped = structuredClone(bundle);
  escaped.artifacts[0].path = '../outside.md';
  await rejects(escaped, /Command failed/u);

  const absolute = structuredClone(bundle);
  absolute.artifacts[0].path = path.join(directory, 'skills/fixture/SKILL.md');
  await rejects(absolute, /Command failed/u);

  const missingRoot = structuredClone(bundle);
  missingRoot.environment = {};
  await rejects(missingRoot, /Command failed/u);

  const relativeRoot = structuredClone(bundle);
  relativeRoot.environment.repositoryRoot = '.';
  await rejects(relativeRoot, /Command failed/u);

  const wrongMode = structuredClone(bundle);
  wrongMode.artifacts[0].mode = '100755';
  await rejects(wrongMode, /Command failed/u);

  const wrongSourceDigest = structuredClone(bundle);
  wrongSourceDigest.target.sourceDigest = `sha256:${'f'.repeat(64)}`;
  await rejects(wrongSourceDigest, /Command failed/u);

  const conflict = structuredClone(bundle);
  conflict.artifacts.push({ ...conflict.artifacts[0], digest: sha('conflict') });
  await rejects(conflict, /Command failed/u);

  const duplicate = structuredClone(bundle);
  duplicate.artifacts.push({ ...duplicate.artifacts[0] });
  await rejects(duplicate, /Command failed/u);

  const empty = structuredClone(bundle);
  empty.artifacts = [];
  await rejects(empty, /Command failed/u);

  const evidenceOnly = structuredClone(bundle);
  evidenceOnly.artifacts = evidenceOnly.artifacts.map((artifact) => ({
    ...artifact,
    role: 'evidence',
  }));
  await rejects(evidenceOnly, /Command failed/u);

  const symlinked = structuredClone(bundle);
  const linkedRoot = path.join(directory, 'linked-skill');
  await symlink(path.join(directory, 'skills/fixture'), linkedRoot, 'dir');
  symlinked.artifacts[0].path = 'linked-skill/SKILL.md';
  await rejects(symlinked, /Command failed/u);

  const linkedFile = path.join(directory, 'skills/fixture/linked.md');
  await symlink(path.join(directory, 'skills/fixture/SKILL.md'), linkedFile);
  await rejects(bundle, /Command failed/u);
});

test('ReviewInputBundle currentness fails closed against Git and accepts unknown without Git', async () => {
  const nonGitDirectory = await mkdtemp(path.join(tmpdir(), 'review-currentness-nongit-'));
  temps.push(nonGitDirectory);
  const nonGitSubject = await createSkillReviewSubject(nonGitDirectory);
  nonGitSubject.artifacts.forEach((artifact) => {
    artifact.currentness = 'unknown';
  });
  const nonGitBundlePath = path.join(nonGitDirectory, 'bundle.json');
  const nonGitBundle = {
    schemaVersion: 4,
    target: {
      kind: 'agent-skill',
      name: 'fixture',
      profile: null,
      sourceDigest: nonGitSubject.sourceDigest,
      currentness: 'unknown',
    },
    artifacts: nonGitSubject.artifacts,
    environment: nonGitSubject.environment,
    orchestration: { stageOwner: 'caller', providedStages: [] },
    evalAudit: null,
    evalResults: [],
  };
  await writeFile(nonGitBundlePath, JSON.stringify(nonGitBundle));
  assert.equal(
    JSON.parse(
      (await run('scripts/validate-review-input-bundle.mjs', [
        nonGitBundlePath,
        '--format',
        'json',
      ])).stdout,
    ).valid,
    true,
  );

  const gitDirectory = await mkdtemp(path.join(tmpdir(), 'review-currentness-git-'));
  temps.push(gitDirectory);
  const cleanSubject = await createPluginReviewSubject(gitDirectory);
  cleanSubject.artifacts[0].currentness = 'current';
  await git(gitDirectory, ['init', '-q']);
  await git(gitDirectory, ['config', 'user.name', 'AW Test']);
  await git(gitDirectory, ['config', 'user.email', 'aw-test@example.invalid']);
  await git(gitDirectory, ['add', '.']);
  await git(gitDirectory, ['commit', '-qm', 'fixture']);
  const bundlePath = path.join(gitDirectory, 'bundle.json');
  const bundle = {
    schemaVersion: 4,
    target: {
      kind: 'aw-plugin',
      name: 'fixture',
      profile: null,
      sourceDigest: cleanSubject.sourceDigest,
      currentness: 'current',
    },
    artifacts: cleanSubject.artifacts,
    environment: cleanSubject.environment,
    orchestration: { stageOwner: 'caller', providedStages: [] },
    evalAudit: null,
    evalResults: [],
  };
  await writeFile(bundlePath, JSON.stringify(bundle));
  assert.equal(
    JSON.parse(
      (await run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']))
        .stdout,
    ).valid,
    true,
  );

  const manifestPath = path.join(gitDirectory, 'plugins/fixture/.agents-plugin/plugin.json');
  const dirtyContent = `${JSON.stringify({ name: 'fixture', version: '1.0.1' })}\n`;
  await writeFile(manifestPath, dirtyContent);
  bundle.artifacts[0].digest = sha(dirtyContent);
  bundle.target.sourceDigest = productionDigest(
    [{ relative: '.agents-plugin/plugin.json', content: dirtyContent, mode: '100644' }],
    'fixture',
  );
  await writeFile(bundlePath, JSON.stringify(bundle));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']),
    /Command failed/u,
  );

  bundle.artifacts[0].currentness = 'dirty';
  bundle.artifacts[0].currentnessReason = 'modified project-profile file';
  bundle.target.currentness = 'dirty';
  bundle.target.dirtyReasons = [`modified production source file: ${manifestPath}`];
  await writeFile(bundlePath, JSON.stringify(bundle));
  assert.equal(
    JSON.parse(
      (await run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']))
        .stdout,
    ).valid,
    true,
  );

  const wrongReasons = structuredClone(bundle);
  wrongReasons.artifacts[0].currentnessReason = 'modified source file';
  wrongReasons.target.dirtyReasons = ['forged'];
  await writeFile(bundlePath, JSON.stringify(wrongReasons));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']),
    /Command failed/u,
  );

  const missingCurrentness = structuredClone(bundle);
  delete missingCurrentness.target.currentness;
  await writeFile(bundlePath, JSON.stringify(missingCurrentness));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']),
    /Command failed/u,
  );
});

test('ReviewInputBundle applies target-specific production roles and excludes author evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-production-kinds-'));
  temps.push(directory);
  const bundlePath = path.join(directory, 'bundle.json');

  const plugin = await createPluginReviewSubject(directory, { owner: 'demo' });
  const pluginBundle = {
    schemaVersion: 4,
    target: {
      kind: 'aw-plugin',
      name: 'demo',
      profile: null,
      sourceDigest: plugin.sourceDigest,
      currentness: 'unknown',
    },
    artifacts: plugin.artifacts,
    environment: plugin.environment,
    orchestration: { stageOwner: 'caller', providedStages: [] },
    evalAudit: null,
    evalResults: [],
  };
  await writeFile(bundlePath, JSON.stringify(pluginBundle));
  assert.equal(
    JSON.parse(
      (await run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']))
        .stdout,
    ).valid,
    true,
  );

  const omittedPluginFile = path.join(directory, 'plugins/demo/omitted.md');
  await writeFile(omittedPluginFile, 'omitted plugin production file\n');
  await writeFile(bundlePath, JSON.stringify(pluginBundle));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']),
    /Command failed/u,
  );
  await rm(omittedPluginFile);

  const materialized = await createSkillReviewSubject(directory, {
    subjectRelative: 'materialized/fixture',
    role: 'final',
  });
  const materializedBundle = {
    ...pluginBundle,
    target: {
      kind: 'materialized-skill',
      name: 'fixture',
      profile: 'codex-project',
      sourceDigest: materialized.sourceDigest,
      currentness: 'unknown',
    },
    artifacts: materialized.artifacts,
  };
  await writeFile(bundlePath, JSON.stringify(materializedBundle));
  assert.equal(
    JSON.parse(
      (await run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']))
        .stdout,
    ).valid,
    true,
  );

  const evidenceContent = '{"case":"author-only"}\n';
  const evidencePath = path.join(directory, 'skills/fixture/evals/case.json');
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, evidenceContent);
  const source = await createSkillReviewSubject(directory);
  const skillBundle = {
    ...pluginBundle,
    target: {
      kind: 'aw-plugin-skill',
      name: 'fixture',
      profile: null,
      sourceDigest: source.sourceDigest,
      currentness: 'unknown',
    },
    artifacts: [
      ...source.artifacts,
      {
        role: 'evidence',
        path: 'skills/fixture/evals/case.json',
        profile: null,
        digest: sha(evidenceContent),
        mode: '100644',
        owner: 'fixture',
        currentness: 'historical',
      },
    ],
  };
  await writeFile(bundlePath, JSON.stringify(skillBundle));
  assert.equal(
    JSON.parse(
      (await run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']))
        .stdout,
    ).valid,
    true,
  );

  skillBundle.artifacts.at(-1).role = 'source';
  await writeFile(bundlePath, JSON.stringify(skillBundle));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--format', 'json']),
    /Command failed/u,
  );
});

async function reviewStageFixture(directory, fileName, profile, name) {
  const value = JSON.parse(
    await readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ),
  );
  value.target = {
    kind: 'materialized-skill',
    name,
    profile,
    digest: 'sha256:' + '4'.repeat(64),
  };
  const raw = JSON.stringify(value);
  await writeFile(path.join(directory, fileName), raw);
  return {
    id: 'materialized-profile-review',
    producer: 'review-agent-skill',
    independentContext: true,
    subjectDigest: value.target.digest,
    resultPath: fileName,
    resultDigest: sha(raw),
    schema: 'ReviewResult',
    profile,
  };
}

async function reviewBundle(stages, directory) {
  const subject = await createPluginReviewSubject(directory);
  return {
    schemaVersion: 4,
    target: {
      kind: 'aw-plugin',
      name: 'fixture',
      profile: null,
      sourceDigest: subject.sourceDigest,
      currentness: 'unknown',
    },
    artifacts: subject.artifacts,
    environment: subject.environment,
    orchestration: { stageOwner: 'caller', providedStages: stages },
    evalAudit: null,
    evalResults: [],
  };
}

test('ReviewInputBundle rejects conflicting results for one semantic stage slot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-slot-'));
  temps.push(directory);
  const stages = await Promise.all([
    reviewStageFixture(directory, 'first.json', 'project-default', 'first'),
    reviewStageFixture(directory, 'second.json', 'project-default', 'second'),
  ]);
  const bundlePath = path.join(directory, 'bundle.json');
  await writeFile(bundlePath, JSON.stringify(await reviewBundle(stages, directory)));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [
      bundlePath,
      '--handoff-root',
      directory,
    ]),
    /Command failed/u,
  );
});

test('ReviewInputBundle accepts materialized reviews for different profiles', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-profiles-'));
  temps.push(directory);
  const stages = await Promise.all([
    reviewStageFixture(directory, 'project.json', 'project-default', 'project'),
    reviewStageFixture(directory, 'user.json', 'user-default', 'user'),
  ]);
  const bundlePath = path.join(directory, 'bundle.json');
  await writeFile(bundlePath, JSON.stringify(await reviewBundle(stages, directory)));
  const result = JSON.parse(
    (
      await run('scripts/validate-review-input-bundle.mjs', [
        bundlePath,
        '--handoff-root',
        directory,
        '--format',
        'json',
      ])
    ).stdout,
  );
  assert.equal(result.valid, true);
});

function evalRunBundle() {
  const run = (configuration, skillMode) => ({
    caseId: 'case-1',
    configuration,
    comparisonId: 'quality',
    skillMode,
    skillDigest: skillMode === 'with-skill' ? 'sha256:' + '1'.repeat(64) : null,
    runIndex: 1,
    status: 'completed',
    exitCode: 0,
    durationMs: 1,
    stdoutPath: `${configuration}/stdout.txt`,
    stdoutDigest: sha(`stdout:${configuration}`),
    stderrPath: `${configuration}/stderr.txt`,
    stderrDigest: sha(`stderr:${configuration}`),
    usage: null,
    grading: { grader: { id: 'fixture', version: '1' }, result: { passed: true } },
    artifacts: [
      {
        role: 'trace',
        path: `${configuration}/trace.json`,
        digest: sha(`trace:${configuration}`),
      },
    ],
  });
  return {
    schemaVersion: 2,
    producer: 'run-agent-skill-evals',
    independentContext: true,
    provider: { id: 'fixture', version: '1' },
    planDigest: 'sha256:' + '4'.repeat(64),
    targetSkillDigest: 'sha256:' + '1'.repeat(64),
    caseCorpusDigest: 'sha256:' + '5'.repeat(64),
    preflightAuditDigest: 'sha256:' + '6'.repeat(64),
    comparisonPlanned: true,
    evidenceLevel: 'comparative',
    runs: [run('with', 'with-skill'), run('baseline', 'without-skill')],
    aggregate: {
      cases: 1,
      configurations: 2,
      runs: 2,
      completed: 2,
      processFailed: 0,
      timedOut: 0,
      comparisons: [
        {
          comparisonId: 'quality',
          caseId: 'case-1',
          runIndex: 1,
          paired: true,
          comparable: true,
        },
      ],
    },
    limitations: [],
  };
}

async function createEvalRunFixture(value = evalRunBundle(), requestedDirectory = null) {
  const directory = requestedDirectory ?? await mkdtemp(path.join(tmpdir(), 'eval-run-bundle-'));
  if (requestedDirectory) await mkdir(directory, { recursive: true });
  else temps.push(directory);
  const valuePath = path.join(directory, 'bundle.json');
  for (const runValue of value.runs) {
    const evidence = [
      [runValue.stdoutPath, `stdout:${runValue.configuration}`],
      [runValue.stderrPath, `stderr:${runValue.configuration}`],
      ...runValue.artifacts.map((artifact) => [
        artifact.path,
        artifact.path === runValue.stdoutPath
          ? `stdout:${runValue.configuration}`
          : artifact.path === runValue.stderrPath
            ? `stderr:${runValue.configuration}`
            : `trace:${runValue.configuration}`,
      ]),
    ];
    for (const [relative, content] of evidence) {
      if (
        relative.includes('\\') ||
        path.isAbsolute(relative) ||
        relative.split('/').some((segment) => segment === '.' || segment === '..')
      )
        continue;
      const evidencePath = path.join(directory, relative);
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, content);
    }
  }
  await writeFile(valuePath, JSON.stringify(value));
  return { directory, value, valuePath };
}

async function validateEvalRunBundle(value) {
  const { valuePath } = await createEvalRunFixture(value);
  return run('scripts/validate-eval-run-bundle.mjs', [valuePath, '--format', 'json']);
}

test('ReviewInputBundle accepts every canonical stage and rejects slot metadata substitution', async () => {
  const fixture = await createEvalRunFixture();
  const subjectDigest = fixture.value.targetSkillDigest;
  const stages = [];
  async function addStage(id, producer, schema, profile, result, additional = {}) {
    const fileName = `${id}.json`;
    const raw = JSON.stringify(result);
    await writeFile(path.join(fixture.directory, fileName), raw);
    stages.push({
      id,
      producer,
      independentContext: result.independentContext,
      subjectDigest,
      resultPath: fileName,
      resultDigest: sha(raw),
      schema,
      profile,
      ...additional,
    });
  }
  const audit = {
    schemaVersion: 2,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'preflight',
    mode: 'preflight',
    targetSkillDigest: subjectDigest,
    caseCorpusDigest: fixture.value.caseCorpusDigest,
    validity: 'unknown',
    optimizationPolicy: 'balanced',
    cases: [],
    blockedCases: [],
    releaseEligible: false,
    failureTriage: [],
    recommendedAction: 'collect-more-data',
  };
  await addStage('eval-audit', 'audit-agent-skill-evals', 'EvalAuditResult', null, audit);
  fixture.value.preflightAuditDigest = stages[0].resultDigest;
  await addStage('reference-audit', 'review-agent-content', 'ReferenceAuditResult', null, {
    schemaVersion: 2,
    producer: 'review-agent-content',
    independentContext: true,
    target: { path: 'references', digest: subjectDigest },
    activePaths: [],
    references: [],
    findings: [],
    unknowns: [],
  });
  const reviewTemplate = JSON.parse(
    await readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ),
  );
  await addStage('source-skill-review', 'review-agent-skill', 'ReviewResult', null, {
    ...reviewTemplate,
    target: {
      kind: 'aw-plugin-skill',
      name: 'source',
      profile: null,
      digest: subjectDigest,
    },
  });
  await addStage(
    'materialized-profile-review',
    'review-agent-skill',
    'ReviewResult',
    'codex-project',
    {
      ...reviewTemplate,
      target: {
        kind: 'materialized-skill',
        name: 'materialized',
        profile: 'codex-project',
        digest: subjectDigest,
      },
    },
  );
  await addStage(
    'eval-execution',
    'run-agent-skill-evals',
    'EvalRunBundle',
    null,
    fixture.value,
  );
  const executionStage = stages.at(-1);
  await addStage(
    'eval-result-triage',
    'audit-agent-skill-evals',
    'EvalAuditResult',
    null,
    { ...audit, auditId: 'triage', mode: 'result-triage' },
    {
      evalExecution: {
        targetSkillDigest: fixture.value.targetSkillDigest,
        caseCorpusDigest: fixture.value.caseCorpusDigest,
        preflightAuditDigest: fixture.value.preflightAuditDigest,
        planDigest: fixture.value.planDigest,
        resultDigest: executionStage.resultDigest,
      },
    },
  );

  const bundle = await reviewBundle(stages, fixture.directory);
  const bundlePath = path.join(fixture.directory, 'all-stages.json');
  await writeFile(bundlePath, JSON.stringify(bundle));
  const valid = await run('scripts/validate-review-input-bundle.mjs', [
    bundlePath,
    '--handoff-root',
    fixture.directory,
    '--format',
    'json',
  ]);
  assert.equal(JSON.parse(valid.stdout).valid, true);

  const substituted = structuredClone(bundle);
  substituted.orchestration.providedStages[0].schema = 'ReviewResult';
  await writeFile(bundlePath, JSON.stringify(substituted));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--handoff-root', fixture.directory]),
    /Command failed/u,
  );

  const profiledAudit = structuredClone(bundle);
  profiledAudit.orchestration.providedStages[0].profile = 'codex-project';
  await writeFile(bundlePath, JSON.stringify(profiledAudit));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--handoff-root', fixture.directory]),
    /Command failed/u,
  );

  const orphanTriage = structuredClone(bundle);
  orphanTriage.orchestration.providedStages = orphanTriage.orchestration.providedStages.filter(
    (stage) => stage.id !== 'eval-execution',
  );
  await writeFile(bundlePath, JSON.stringify(orphanTriage));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--handoff-root', fixture.directory]),
    /Command failed/u,
  );

  const staleTriage = structuredClone(bundle);
  staleTriage.orchestration.providedStages.find(
    (stage) => stage.id === 'eval-result-triage',
  ).evalExecution.planDigest = `sha256:${'9'.repeat(64)}`;
  await writeFile(bundlePath, JSON.stringify(staleTriage));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--handoff-root', fixture.directory]),
    /Command failed/u,
  );
});

test('ReviewInputBundle binds each inline Eval result to the complete canonical stage result', async () => {
  const handoffRoot = await mkdtemp(path.join(tmpdir(), 'review-eval-binding-'));
  temps.push(handoffRoot);
  const stageRoot = path.join(handoffRoot, 'execution');
  const fixture = await createEvalRunFixture(evalRunBundle(), stageRoot);
  const stageRaw = await readFile(fixture.valuePath, 'utf8');
  const bundle = await reviewBundle([{
    id: 'eval-execution',
    producer: 'run-agent-skill-evals',
    independentContext: true,
    subjectDigest: fixture.value.targetSkillDigest,
    resultPath: 'execution/bundle.json',
    resultDigest: sha(stageRaw),
    schema: 'EvalRunBundle',
    profile: null,
  }], handoffRoot);
  bundle.evalResults = [structuredClone(fixture.value)];
  const bundlePath = path.join(handoffRoot, 'review-input.json');

  async function assertRejected(mutator) {
    const candidate = structuredClone(bundle);
    mutator(candidate.evalResults[0]);
    await writeFile(bundlePath, JSON.stringify(candidate));
    await assert.rejects(
      run('scripts/validate-review-input-bundle.mjs', [
        bundlePath,
        '--handoff-root',
        handoffRoot,
      ]),
      /Command failed/u,
    );
  }

  await writeFile(bundlePath, JSON.stringify(bundle));
  assert.equal(
    JSON.parse(
      (
        await run('scripts/validate-review-input-bundle.mjs', [
          bundlePath,
          '--handoff-root',
          handoffRoot,
          '--format',
          'json',
        ])
      ).stdout,
    ).valid,
    true,
  );

  await assertRejected((value) => { value.provider.id = 'replacement'; });
  await assertRejected((value) => { value.runs[0].durationMs = 2; });
  await assertRejected((value) => { value.runs[0].grading.result.passed = false; });
  await assertRejected((value) => { value.limitations = ['replacement']; });
  await assertRejected((value) => {
    value.runs[1].grading.grader.version = '2';
    value.aggregate.comparisons[0].comparable = false;
    value.evidenceLevel = 'executed';
    value.limitations = ['replacement'];
  });

  const duplicateInline = structuredClone(bundle);
  duplicateInline.evalResults.push(structuredClone(fixture.value));
  await writeFile(bundlePath, JSON.stringify(duplicateInline));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--handoff-root', handoffRoot]),
    /Command failed/u,
  );

  const missingStage = structuredClone(bundle);
  missingStage.orchestration.providedStages = [];
  await writeFile(bundlePath, JSON.stringify(missingStage));
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [bundlePath, '--handoff-root', handoffRoot]),
    /Command failed/u,
  );
});

test('source Skill review identity is exact for Skill bundles and unambiguous for plugin bundles', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-source-identity-'));
  temps.push(directory);
  const skillSubject = await createSkillReviewSubject(directory, {
    subjectRelative: 'skills/one',
    owner: 'one',
  });
  const pluginSubject = await createPluginReviewSubject(directory, { owner: 'demo' });
  const template = JSON.parse(
    await readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ),
  );
  const digest = skillSubject.sourceDigest;
  const result = {
    ...template,
    target: { kind: 'aw-plugin-skill', name: 'one', profile: null, digest },
  };
  const resultPath = path.join(directory, 'source-review.json');
  const bundlePath = path.join(directory, 'review-input.json');

  async function validateBundle(target, resultTarget = result.target) {
    const subject = target.kind === 'aw-plugin' ? pluginSubject : skillSubject;
    const actual = { ...result, target: resultTarget };
    const raw = JSON.stringify(actual);
    await writeFile(resultPath, raw);
    await writeFile(bundlePath, JSON.stringify({
      schemaVersion: 4,
      target,
      artifacts: subject.artifacts,
      environment: subject.environment,
      orchestration: {
        stageOwner: 'caller',
        providedStages: [{
          id: 'source-skill-review',
          producer: 'review-agent-skill',
          independentContext: true,
          subjectDigest: resultTarget.digest,
          resultPath: 'source-review.json',
          resultDigest: sha(raw),
          schema: 'ReviewResult',
          profile: null,
        }],
      },
      evalAudit: null,
      evalResults: [],
    }));
    return run('scripts/validate-review-input-bundle.mjs', [
      bundlePath,
      '--handoff-root',
      directory,
      '--format',
      'json',
    ]);
  }

  const skillTarget = {
    kind: 'aw-plugin-skill',
    name: 'one',
    profile: null,
    sourceDigest: digest,
    currentness: 'unknown',
  };
  assert.equal(JSON.parse((await validateBundle(skillTarget)).stdout).valid, true);
  for (const replacement of [
    { kind: 'agent-skill' },
    { name: 'two' },
    { profile: 'codex-project' },
    { digest: `sha256:${'8'.repeat(64)}` },
  ]) {
    await assert.rejects(
      validateBundle(skillTarget, { ...result.target, ...replacement }),
      /Command failed/u,
    );
  }

  const pluginTarget = {
    kind: 'aw-plugin',
    name: 'demo',
    profile: null,
    sourceDigest: pluginSubject.sourceDigest,
    currentness: 'unknown',
  };
  assert.equal(JSON.parse((await validateBundle(pluginTarget)).stdout).valid, true);
  await assert.rejects(
    validateBundle(pluginTarget, { ...result.target, kind: 'agent-skill' }),
    /Command failed/u,
  );
});

test('EvalRunBundle validator rejects old, empty, inconsistent, and duplicate evidence', async () => {
  const old = evalRunBundle();
  old.schemaVersion = 1;
  await assert.rejects(validateEvalRunBundle(old), /Command failed/u);

  const empty = evalRunBundle();
  empty.runs = [];
  empty.aggregate = {
    cases: 0,
    configurations: 0,
    runs: 0,
    completed: 0,
    processFailed: 0,
    timedOut: 0,
    comparisons: [],
  };
  await assert.rejects(validateEvalRunBundle(empty), /Command failed/u);

  const inconsistent = evalRunBundle();
  inconsistent.aggregate.completed = 1;
  await assert.rejects(validateEvalRunBundle(inconsistent), /Command failed/u);

  const duplicate = evalRunBundle();
  duplicate.runs.push({ ...duplicate.runs[0] });
  duplicate.aggregate.runs = 3;
  duplicate.aggregate.completed = 3;
  await assert.rejects(validateEvalRunBundle(duplicate), /Command failed/u);
});

test('EvalRunBundle validator requires real comparable grading for comparative evidence', async () => {
  const value = evalRunBundle();
  value.runs[1].grading.grader.version = '2';
  value.aggregate.comparisons[0].comparable = false;
  await assert.rejects(validateEvalRunBundle(value), /Command failed/u);

  value.evidenceLevel = 'executed';
  value.limitations.push('The planned quality comparison is not comparable.');
  assert.equal(JSON.parse((await validateEvalRunBundle(value)).stdout).valid, true);
});

test('EvalRunBundle validator rejects missing and modified evidence files', async () => {
  const missing = await createEvalRunFixture();
  await rm(path.join(missing.directory, missing.value.runs[0].stdoutPath));
  await assert.rejects(
    run('scripts/validate-eval-run-bundle.mjs', [missing.valuePath]),
    /Command failed/u,
  );

  const modified = await createEvalRunFixture();
  await writeFile(path.join(modified.directory, modified.value.runs[0].stderrPath), 'modified');
  await assert.rejects(
    run('scripts/validate-eval-run-bundle.mjs', [modified.valuePath]),
    /Command failed/u,
  );
});

test('EvalRunBundle validator rejects unsafe evidence paths', async () => {
  for (const unsafePath of [
    '/absolute/evidence.txt',
    '../outside.txt',
    './with/stdout.txt',
    'with\\stdout.txt',
  ]) {
    const fixture = await createEvalRunFixture();
    fixture.value.runs[0].stdoutPath = unsafePath;
    await writeFile(fixture.valuePath, JSON.stringify(fixture.value));
    await assert.rejects(
      run('scripts/validate-eval-run-bundle.mjs', [fixture.valuePath]),
      /Command failed/u,
    );
  }
});

test('EvalRunBundle validator rejects symlink evidence', async () => {
  const fixture = await createEvalRunFixture();
  const linkedPath = path.join(fixture.directory, fixture.value.runs[0].artifacts[0].path);
  const targetPath = path.join(fixture.directory, fixture.value.runs[1].artifacts[0].path);
  await rm(linkedPath);
  await symlink(targetPath, linkedPath);
  await assert.rejects(
    run('scripts/validate-eval-run-bundle.mjs', [fixture.valuePath]),
    /Command failed/u,
  );

  const nonRegular = await createEvalRunFixture();
  const directoryPath = path.join(
    nonRegular.directory,
    nonRegular.value.runs[0].artifacts[0].path,
  );
  await rm(directoryPath);
  await mkdir(directoryPath);
  await assert.rejects(
    run('scripts/validate-eval-run-bundle.mjs', [nonRegular.valuePath]),
    /Command failed/u,
  );
});

test('EvalRunBundle validator rejects evidence that resolves outside its root', async () => {
  const fixture = await createEvalRunFixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'eval-run-outside-'));
  temps.push(outside);
  await writeFile(path.join(outside, 'stdout.txt'), 'stdout:with');
  await symlink(outside, path.join(fixture.directory, 'linked'));
  fixture.value.runs[0].stdoutPath = 'linked/stdout.txt';
  await writeFile(fixture.valuePath, JSON.stringify(fixture.value));
  await assert.rejects(
    run('scripts/validate-eval-run-bundle.mjs', [fixture.valuePath]),
    /Command failed/u,
  );
});

test('EvalRunBundle allows repeated file references but checks each declared digest', async () => {
  const repeated = evalRunBundle();
  repeated.runs[0].artifacts.push({
    role: 'output',
    path: repeated.runs[0].stdoutPath,
    digest: repeated.runs[0].stdoutDigest,
  });
  assert.equal(JSON.parse((await validateEvalRunBundle(repeated)).stdout).valid, true);

  repeated.runs[0].artifacts[1].digest = 'sha256:' + '0'.repeat(64);
  await assert.rejects(validateEvalRunBundle(repeated), /Command failed/u);
});

test('AW ReviewInputBundle rejects damaged Eval evidence', async () => {
  const fixture = await createEvalRunFixture();
  const raw = await readFile(fixture.valuePath, 'utf8');
  const stage = {
    id: 'eval-execution',
    producer: 'run-agent-skill-evals',
    independentContext: true,
    subjectDigest: fixture.value.targetSkillDigest,
    resultPath: path.basename(fixture.valuePath),
    resultDigest: sha(raw),
    schema: 'EvalRunBundle',
    profile: null,
  };
  const handoff = await reviewBundle([stage], fixture.directory);
  handoff.evalResults = [fixture.value];
  const handoffPath = path.join(fixture.directory, 'review-input.json');
  await writeFile(handoffPath, JSON.stringify(handoff));
  assert.equal(
    JSON.parse(
      (
        await run('scripts/validate-review-input-bundle.mjs', [
          handoffPath,
          '--handoff-root',
          fixture.directory,
          '--format',
          'json',
        ])
      ).stdout,
    ).valid,
    true,
  );

  await writeFile(
    path.join(fixture.directory, fixture.value.runs[0].artifacts[0].path),
    'damaged',
  );
  await assert.rejects(
    run('scripts/validate-review-input-bundle.mjs', [
      handoffPath,
      '--handoff-root',
      fixture.directory,
    ]),
    /Command failed/u,
  );
});
function finding(id, severity, evidenceTypes) {
  const strong = ['P0', 'P1'].includes(severity);
  return {
    id,
    severity,
    evidenceTypes,
    evidence: ['fixture'],
    location: 'SKILL.md:1',
    claim: 'fixture claim',
    premises: strong
      ? [{ claim: 'p', source: 'fixture', evidence: 'fixture', status: 'supported' }]
      : [],
    reachability: {
      kind: 'entry-gate',
      status: strong ? 'supported' : 'unknown',
      path: 'fixture',
      evidence: 'fixture',
    },
    impact: 'impact',
    counterevidence: strong ? ['checked'] : [],
    owner: 'Skill',
    action: 'action',
    validation: 'validation',
    dimension: 'scope_composition',
  };
}
async function reviewValue(item, design, release) {
  const v = JSON.parse(
    await readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ),
  );
  v.composition = 'overloaded';
  v.compositionFindingIds = [item.id];
  v.findings = [item];
  v.design = design;
  v.releaseReadiness = release;
  return v;
}
async function validate(v) {
  const t = await mkdtemp(path.join(tmpdir(), 'review-result-'));
  temps.push(t);
  const p = path.join(t, 'result.json');
  await writeFile(p, JSON.stringify(v));
  return run('scripts/validate-review-result.mjs', [p, '--format', 'json']);
}
test('P2-only overload is needs-fixes while P1 overload is redesign', async () => {
  assert.equal(
    JSON.parse(
      (
        await validate(
          await reviewValue(
            finding('p2', 'P2', ['official-guidance']),
            'needs-fixes',
            'not-assessed',
          ),
        )
      ).stdout,
    ).valid,
    true,
  );
  assert.equal(
    JSON.parse(
      (
        await validate(
          await reviewValue(finding('p1', 'P1', ['structural']), 'redesign', 'blocked'),
        )
      ).stdout,
    ).valid,
    true,
  );
});
test('official guidance alone cannot support P1', async () => {
  await assert.rejects(
    validate(await reviewValue(finding('bad', 'P1', ['official-guidance']), 'redesign', 'blocked')),
    /Command failed/u,
  );
});
test('unlinked heuristic composition cannot force redesign', async () => {
  const value = JSON.parse(
    await readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ),
  );
  value.composition = 'overloaded';
  value.design = 'redesign';
  await assert.rejects(validate(value), /Command failed/u);
});
test('full result uses every canonical dimension and preserves eval evidence level', async () => {
  const [value, rules] = await Promise.all([
    readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ).then(JSON.parse),
    readFile(
      path.join(root, 'skills/review-agent-skill/assets/review-result-rules.generated.json'),
      'utf8',
    ).then(JSON.parse),
  ]);
  value.mode = 'full';
  value.design = 'pass';
  value.releaseReadiness = 'provisional';
  value.complexity = 'proportionate';
  value.composition = 'coherent';
  value.reducibility = 'minor';
  value.evalEvidenceLevel = 'structural';
  value.compositionFindingIds = [];
  value.complexityFindingIds = [];
  value.dimensions = rules.dimensions.map((d) => ({
    id: d.id,
    weight: d.weight,
    score: 5,
    confidence: 'high',
    findingIds: [],
    unknownIds: [],
  }));
  value.weightedScore = 100;
  value.coverage = 100;
  value.confidence = 'high';
  assert.equal(JSON.parse((await validate(value)).stdout).valid, true);
});
test('inspector still detects invalid frontmatter, missing resources and large references', async () => {
  const t = await mkdtemp(path.join(tmpdir(), 'skill-inspector-'));
  temps.push(t);
  const skill = path.join(t, 'fixture-skill');
  await mkdir(path.join(skill, 'references'), { recursive: true });
  await writeFile(
    path.join(skill, 'SKILL.md'),
    '---\nname: wrong-name\ndescription: fixture\n---\n# Fixture\nRead `references/missing.md`.\n',
  );
  await writeFile(path.join(skill, 'references', 'large.md'), '# Large\n' + 'text\n'.repeat(350));
  const result = JSON.parse(
    (
      await run('scripts/inspect-agent-skill.mjs', [skill, '--format', 'json']).catch((e) => ({
        stdout: e.stdout,
      }))
    ).stdout,
  );
  assert.ok(result.issues.some((i) => i.code === 'name-directory-mismatch'));
  assert.ok(result.issues.some((i) => i.code === 'missing-resource'));
  assert.equal(result.references[0].requiresSemanticAudit, true);
});
