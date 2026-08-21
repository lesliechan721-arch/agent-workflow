import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUSES = new Set(['parallel', 'ready-for-cutover', 'retired']);
const execFileAsync = promisify(execFile);
const modelEvidence = (plugin, skill) => ({ plugin, skill, evidencePath: null, evidenceDigest: null });
const suite = (manifest, id) => ({ manifest, suite: id });

const LEGACY_ROUTES = [
  { path: 'AGENTS.md', contains: '[create-aw-plugin](.agents/skills/create-aw-plugin/SKILL.md)' },
  { path: 'AGENTS.md', contains: '[skill-review](.agents/skills/skill-review/SKILL.md)' },
];
const REPLACEMENT_ROUTES = [
  { path: 'AGENTS.md', contains: 'plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md' },
  { path: 'AGENTS.md', contains: 'plugins/aw-plugin-development/skills/review-aw-plugin/SKILL.md' },
];
const LEGACY_ENTRYPOINTS = [
  '.agents/skills/create-aw-plugin/SKILL.md',
  '.agents/skills/create-aw-plugin/scripts/add_skill.mjs',
  '.agents/skills/create-aw-plugin/scripts/check_plugin_versions.mjs',
  '.agents/skills/create-aw-plugin/scripts/generate_skill_frontmatter_reference.mjs',
  '.agents/skills/create-aw-plugin/scripts/init_plugin.mjs',
  '.agents/skills/create-aw-plugin/scripts/run-aw-plugin-command.mjs',
  '.agents/skills/create-aw-plugin/scripts/validate_plugin.mjs',
  '.agents/skills/skill-review/SKILL.md',
  '.agents/skills/skill-review/scripts/inspect_skill_target.mjs',
  '.agents/skills/skill-review/scripts/run_static_skill_evals.mjs',
  '.agents/skills/skill-review/scripts/validate_eval_cases.mjs',
  '.agents/skills/skill-review/scripts/validate_scorecard.mjs',
];
const REPLACEMENT_ENTRYPOINTS = [
  'plugins/agent-content-toolkit/.agents-plugin/plugin.json',
  'plugins/agent-content-toolkit/skills/write-agent-content/SKILL.md',
  'plugins/agent-content-toolkit/skills/review-agent-content/SKILL.md',
  'plugins/agent-skill-toolkit/.agents-plugin/plugin.json',
  'plugins/agent-skill-toolkit/skills/author-agent-skill/SKILL.md',
  'plugins/agent-skill-toolkit/skills/review-agent-skill/SKILL.md',
  'plugins/agent-skill-toolkit/skills/design-agent-skill-evals/SKILL.md',
  'plugins/agent-skill-toolkit/skills/audit-agent-skill-evals/SKILL.md',
  'plugins/agent-skill-eval-runner/.agents-plugin/plugin.json',
  'plugins/agent-skill-eval-runner/skills/run-agent-skill-evals/SKILL.md',
  'plugins/aw-plugin-development/.agents-plugin/plugin.json',
  'plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md',
  'plugins/aw-plugin-development/skills/review-aw-plugin/SKILL.md',
];
const CAPABILITY_MATRIX = [
  ['agent-content-authoring', 'migrated', 'plugins/agent-content-toolkit/skills/write-agent-content/SKILL.md'],
  ['agent-content-review', 'migrated', 'plugins/agent-content-toolkit/skills/review-agent-content/SKILL.md'],
  ['agent-skill-authoring', 'migrated', 'plugins/agent-skill-toolkit/skills/author-agent-skill/SKILL.md'],
  ['agent-skill-review', 'migrated', 'plugins/agent-skill-toolkit/skills/review-agent-skill/SKILL.md'],
  ['agent-skill-eval-design', 'migrated', 'plugins/agent-skill-toolkit/skills/design-agent-skill-evals/SKILL.md'],
  ['agent-skill-eval-audit', 'migrated', 'plugins/agent-skill-toolkit/skills/audit-agent-skill-evals/SKILL.md'],
  ['agent-skill-eval-execution', 'migrated', 'plugins/agent-skill-eval-runner/skills/run-agent-skill-evals/SKILL.md'],
  ['aw-plugin-authoring', 'migrated', 'plugins/aw-plugin-development/skills/author-aw-plugin/SKILL.md'],
  ['aw-plugin-review', 'migrated', 'plugins/aw-plugin-development/skills/review-aw-plugin/SKILL.md'],
  ['repo-static-skill-batch-execution', 'legacy-retained', '.agents/skills/skill-review/SKILL.md'],
  ['repo-static-skill-evidence-currentness', 'legacy-retained', '.agents/skills/skill-review/SKILL.md'],
  ['repo-static-skill-report-publication', 'legacy-retained', '.agents/skills/skill-review/SKILL.md'],
].map(([id, disposition, owner]) => ({ id, disposition, owner }));

const triggerTargets = [
  ['agent-content-toolkit', 'write-agent-content'],
  ['agent-content-toolkit', 'review-agent-content'],
  ['agent-skill-toolkit', 'author-agent-skill'],
  ['agent-skill-toolkit', 'review-agent-skill'],
  ['agent-skill-toolkit', 'design-agent-skill-evals'],
  ['agent-skill-toolkit', 'audit-agent-skill-evals'],
  ['agent-skill-eval-runner', 'run-agent-skill-evals'],
  ['aw-plugin-development', 'author-aw-plugin'],
  ['aw-plugin-development', 'review-aw-plugin'],
];
const manifestFor = (plugin, skill) => `plugins/${plugin}/skills/${skill}/evals/manifest.json`;
const CUTOVER_GATES = [
  {
    id: 'legacy-p1-closure',
    owner: 'plugin-development-migration',
    implementationEvidence: [
      { finding: 'create-aw-plugin-P1', paths: ['plugins/aw-plugin-development/scripts/contract.test.mjs'] },
      { finding: 'skill-review-F-001', paths: ['plugins/agent-skill-toolkit/scripts/contract.test.mjs'] },
      { finding: 'skill-review-F-002', paths: ['plugins/agent-skill-toolkit/scripts/contract.test.mjs', 'plugins/agent-skill-eval-runner/scripts/contract.test.mjs'] },
      { finding: 'skill-review-F-003', paths: ['plugins/agent-skill-toolkit/scripts/contract.test.mjs'] },
    ],
  },
  {
    id: 'runtime-closure',
    owner: 'cli-runtime-closure',
    implementationEvidence: [{ finding: 'materialized-skill-runtime-closure', paths: [
      'packages/cli/src/utils/runtime-skill-closure.ts',
      'packages/cli/tests/unit/bundle-layout.test.ts',
    ] }],
  },
  {
    id: 'reviewer-behavior',
    owner: 'agent-skill-toolkit+aw-plugin-development',
    requiredSuites: [
      suite(manifestFor('agent-skill-toolkit', 'review-agent-skill'), 'behavior'),
      suite(manifestFor('aw-plugin-development', 'review-aw-plugin'), 'behavior'),
    ],
    modelEvidence: [
      modelEvidence('agent-skill-toolkit', 'review-agent-skill'),
      modelEvidence('aw-plugin-development', 'review-aw-plugin'),
    ],
  },
  {
    id: 'four-layer-trigger',
    owner: 'four-layer-plugin-development',
    requiredSuites: triggerTargets.map(([plugin, skill]) => suite(manifestFor(plugin, skill), 'trigger')),
    modelEvidence: triggerTargets.map(([plugin, skill]) => modelEvidence(plugin, skill)),
  },
  {
    id: 'aw-behavior',
    owner: 'aw-plugin-development',
    requiredSuites: [
      suite(manifestFor('aw-plugin-development', 'author-aw-plugin'), 'behavior'),
      suite(manifestFor('aw-plugin-development', 'review-aw-plugin'), 'behavior'),
    ],
    modelEvidence: [
      modelEvidence('aw-plugin-development', 'author-aw-plugin'),
      modelEvidence('aw-plugin-development', 'review-aw-plugin'),
    ],
  },
  {
    id: 'eval-audit-run-triage-e2e',
    owner: 'agent-skill-eval-runner',
    requiredSuites: [suite(manifestFor('agent-skill-eval-runner', 'run-agent-skill-evals'), 'behavior')],
    modelEvidence: [modelEvidence('agent-skill-eval-runner', 'run-agent-skill-evals')],
  },
  {
    id: 'legacy-static-lifecycle-decision',
    owner: '.agents/skills/skill-review/SKILL.md',
    decision: 'retain',
    capabilities: [
      'repo-static-skill-batch-execution',
      'repo-static-skill-evidence-currentness',
      'repo-static-skill-report-publication',
    ],
  },
];
const CANONICAL_SECTIONS = {
  legacyRoutes: LEGACY_ROUTES,
  replacementRoutes: REPLACEMENT_ROUTES,
  legacyEntrypoints: LEGACY_ENTRYPOINTS,
  replacementEntrypoints: REPLACEMENT_ENTRYPOINTS,
  capabilityMatrix: CAPABILITY_MATRIX,
  cutoverGates: CUTOVER_GATES,
};

function insideRoot(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative)) return null;
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function resolveStrictFile(root, canonicalRoot, relative) {
  const resolved = insideRoot(root, relative);
  if (!resolved) return null;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch {
      return null;
    }
    if (entry.isSymbolicLink()) return null;
    if (current === resolved ? !entry.isFile() : !entry.isDirectory()) return null;
  }
  let canonicalFile;
  try {
    canonicalFile = await realpath(resolved);
  } catch {
    return null;
  }
  return canonicalFile.startsWith(`${canonicalRoot}${path.sep}`) ? resolved : null;
}

async function readStrictJson(root, canonicalRoot, relative) {
  const resolved = await resolveStrictFile(root, canonicalRoot, relative);
  if (!resolved) return { error: 'migration contract is missing or unsafe' };
  try {
    return { value: JSON.parse(await readFile(resolved, 'utf8')) };
  } catch (error) {
    return { error: `migration contract is invalid JSON: ${error.message}` };
  }
}

function verifyCanonicalContract(contract, errors) {
  const expectedKeys = ['schemaVersion', 'status', ...Object.keys(CANONICAL_SECTIONS)].sort();
  if (!isDeepStrictEqual(Object.keys(contract).sort(), expectedKeys)) {
    errors.push('migration contract top-level fields must exactly match the canonical contract');
  }
  for (const [name, expected] of Object.entries(CANONICAL_SECTIONS)) {
    const actual = name === 'cutoverGates' && contract.status !== 'parallel'
      ? contract[name]?.map((gate) => ({
          ...gate,
          ...(gate.modelEvidence ? {
            modelEvidence: gate.modelEvidence.map((evidence) => ({
              ...evidence,
              evidencePath: null,
              evidenceDigest: null,
            })),
          } : {}),
        }))
      : contract[name];
    if (!isDeepStrictEqual(actual, expected)) {
      errors.push(`${name} must exactly match the canonical migration contract`);
    }
  }
}

async function verifyFile(root, canonicalRoot, relative, errors, label) {
  if (!(await resolveStrictFile(root, canonicalRoot, relative))) {
    errors.push(`${label} is missing or unsafe: ${String(relative)}`);
  }
}

function markdownProse(content) {
  const uncommented = content
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const proseLines = [];
  let fence = null;

  for (const line of uncommented.split(/\r?\n/)) {
    let markdownLine = line;
    while (/^ {0,3}>[ \t]?/.test(markdownLine)) {
      markdownLine = markdownLine.replace(/^ {0,3}>[ \t]?/, '');
    }
    const marker = markdownLine.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (
        marker
        && marker[1][0] === fence.character
        && marker[1].length >= fence.length
        && markdownLine.slice(marker[0].length).trim() === ''
      ) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) continue;
    proseLines.push(line);
  }

  const prose = proseLines.join('\n');
  let withoutInlineCode = '';
  let cursor = 0;
  while (cursor < prose.length) {
    const opening = prose.indexOf('`', cursor);
    if (opening === -1) return withoutInlineCode + prose.slice(cursor);
    withoutInlineCode += prose.slice(cursor, opening);
    let end = opening + 1;
    while (prose[end] === '`') end += 1;
    const delimiter = prose.slice(opening, end);
    const closing = prose.indexOf(delimiter, end);
    if (closing === -1) return withoutInlineCode;
    cursor = closing + delimiter.length;
  }
  return withoutInlineCode;
}

function hasActiveMarkdownLink(content, needle) {
  const prose = markdownProse(content);
  if (needle.startsWith('[')) return prose.includes(needle);
  return [...prose.matchAll(/(?<!!)\[[^\]\r\n]+\]\(([^)\s]+)\)/g)]
    .some((match) => match[1] === needle);
}

async function verifyRoute(root, canonicalRoot, route, errors) {
  const resolved = await resolveStrictFile(root, canonicalRoot, route.path);
  if (!resolved) {
    errors.push(`legacy route file is missing or unsafe: ${route.path}`);
    return;
  }
  if (!hasActiveMarkdownLink(await readFile(resolved, 'utf8'), route.contains)) {
    errors.push(`legacy route must be present: ${route.path}`);
  }
}

async function verifyInactiveReplacementRoute(root, canonicalRoot, route, errors) {
  const resolved = await resolveStrictFile(root, canonicalRoot, route.path);
  if (!resolved) {
    errors.push(`replacement route file is missing or unsafe: ${route.path}`);
    return;
  }
  if (hasActiveMarkdownLink(await readFile(resolved, 'utf8'), route.contains)) {
    errors.push(`replacement route must not be active while status is parallel: ${route.path}`);
  }
}

async function verifyInactiveRoute(root, canonicalRoot, route, errors, label) {
  const resolved = await resolveStrictFile(root, canonicalRoot, route.path);
  if (!resolved) {
    errors.push(`${label} route file is missing or unsafe: ${route.path}`);
    return;
  }
  if (hasActiveMarkdownLink(await readFile(resolved, 'utf8'), route.contains)) {
    errors.push(`${label} route must not be active: ${route.path}`);
  }
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function listProductionFiles(root) {
  const files = [];
  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const isSkillRoot = entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md');
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
      if (
        (prefix === '' && entry.name === 'reports')
        || (isSkillRoot && entry.isDirectory() && ['evals', 'reports'].includes(entry.name))
      ) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`source contains a symlink: ${relative}`);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push({ absolute, relative });
    }
  }
  await visit(root);
  return files;
}

export async function computeMigrationSourceDigest(root, pluginNames) {
  const records = [];
  for (const plugin of [...pluginNames].sort()) {
    const pluginRoot = path.join(root, 'plugins', plugin);
    for (const file of await listProductionFiles(pluginRoot)) {
      const info = await stat(file.absolute);
      records.push({
        path: `${plugin}/${file.relative}`,
        mode: process.platform !== 'win32' && (info.mode & 0o111) !== 0 ? '100755' : '100644',
        content: await readFile(file.absolute),
      });
    }
  }
  const hash = createHash('sha256');
  const update = (value) => {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };
  update('aw-production-records-v1');
  for (const record of records.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    update(record.path);
    update(record.mode);
    update(createHash('sha256').update(record.content).digest());
  }
  return `sha256:${hash.digest('hex')}`;
}

async function gitOutput(root, args) {
  try {
    return (await execFileAsync('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
  } catch {
    return null;
  }
}

async function gitBytes(root, args) {
  try {
    return (await execFileAsync('git', args, { cwd: root, encoding: null })).stdout;
  } catch {
    return null;
  }
}

async function gitSucceeds(root, args) {
  try {
    await execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function releaseTargets(manifest) {
  const targets = [];
  for (const profile of manifest.profiles.filter((entry) => entry.requiredForRelease)) {
    targets.push(`materialization/${profile.id}`);
  }
  for (const suiteEntry of manifest.suites.filter((entry) => entry.requiredForRelease)) {
    for (const profile of suiteEntry.profiles) {
      for (const split of suiteEntry.releaseSplits.length > 0
        ? suiteEntry.releaseSplits
        : ['all']) {
        targets.push(`${suiteEntry.kind}/${suiteEntry.id}/${profile}/${split}/all`);
      }
    }
  }
  return [...new Set(targets)].sort();
}

async function readArchiveJson(root, canonicalRoot, relative, label, errors) {
  const filePath = await resolveStrictFile(root, canonicalRoot, relative);
  if (!filePath) {
    errors.push(`${label} is missing or unsafe`);
    return null;
  }
  const [raw, committed] = await Promise.all([
    readFile(filePath),
    gitBytes(root, ['show', `HEAD:${relative}`]),
  ]);
  if (committed === null || !raw.equals(committed)) {
    errors.push(`${label} must match evidence committed at HEAD`);
    return null;
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    errors.push(`${label} is invalid JSON`);
    return null;
  }
}

function safeTargetPath(target) {
  return typeof target === 'string' && target.split('/').every((segment) =>
    segment.length > 0 && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/u.test(segment));
}

async function verifyArchivedEvaluation(
  root,
  canonicalRoot,
  archiveRelative,
  evaluation,
  manifest,
  label,
  errors,
) {
  const [batch, summary] = await Promise.all([
    readArchiveJson(root, canonicalRoot, `${archiveRelative}/batch.json`, `${label} batch`, errors),
    readArchiveJson(root, canonicalRoot, `${archiveRelative}/summary.json`, `${label} summary`, errors),
  ]);
  if (!batch || !summary) return;
  if (
    batch.schemaVersion !== 1
    || batch.status !== 'sealed'
    || batch.batchId !== evaluation.batchId
    || !isDeepStrictEqual(batch.owner, evaluation.owner)
    || !isDeepStrictEqual(batch.source, evaluation.source)
  ) {
    errors.push(`${label} batch identity is not a sealed canonical batch`);
  }
  const requiredTargets = releaseTargets(manifest);
  if (!isDeepStrictEqual(batch.requiredTargets, requiredTargets)) {
    errors.push(`${label} batch required target contract does not match the manifest`);
  }
  if (
    summary.schemaVersion !== 1
    || summary.status !== 'sealed'
    || summary.batchId !== evaluation.batchId
    || !isDeepStrictEqual(summary.owner, evaluation.owner)
    || !isDeepStrictEqual(summary.source, evaluation.source)
    || summary.eval?.releaseOutcome !== 'passed'
    || summary.eval?.complete !== true
    || summary.eval?.mechanicalPassed !== true
    || !isDeepStrictEqual(summary.eval?.targets, evaluation.targets)
    || !isDeepStrictEqual(summary.eval?.targetAttempts, evaluation.targetAttempts)
  ) {
    errors.push(`${label} does not match its canonical sealed batch summary`);
  }
  if (!Array.isArray(summary.eval?.runs) || summary.eval.runs.length === 0) {
    errors.push(`${label} canonical batch has no completed eval run`);
    return;
  }
  const runIds = new Set(summary.eval.runs.map((run) => run.runId));
  for (const target of evaluation.targets ?? []) {
    if (!safeTargetPath(target.target) || !runIds.has(target.runId)) {
      errors.push(`${label} target is not bound to a canonical eval run`);
      continue;
    }
    const targetSummary = await readArchiveJson(
      root,
      canonicalRoot,
      `${archiveRelative}/evals/${target.target}/${target.runId}/summary.json`,
      `${label} target ${target.target}`,
      errors,
    );
    if (targetSummary && !isDeepStrictEqual(targetSummary, target)) {
      errors.push(`${label} target ${target.target} differs from its archived target summary`);
    }
  }
  for (const run of summary.eval.runs) {
    const [runState, runSummary] = await Promise.all([
      readArchiveJson(
        root,
        canonicalRoot,
        `${archiveRelative}/evals/runs/${run.runId}/run.json`,
        `${label} run ${run.runId}`,
        errors,
      ),
      readArchiveJson(
        root,
        canonicalRoot,
        `${archiveRelative}/evals/runs/${run.runId}/summary.json`,
        `${label} run summary ${run.runId}`,
        errors,
      ),
    ]);
    if (
      !runState
      || runState.schemaVersion !== 1
      || runState.runId !== run.runId
      || runState.status !== 'completed'
      || !runSummary
      || runSummary.outcome !== 'passed'
      || runSummary.complete !== true
      || runSummary.mechanicalPassed !== true
    ) {
      errors.push(`${label} run ${run.runId} is not complete canonical evidence`);
    }
  }
}

async function verifyModelEvidence(root, canonicalRoot, gate, currentHead, errors) {
  for (const evidence of gate.modelEvidence ?? []) {
    const label = `${gate.id} model evidence for ${evidence.plugin}/${evidence.skill}`;
    if (
      typeof evidence.evidencePath !== 'string'
      || typeof evidence.evidenceDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/u.test(evidence.evidenceDigest)
    ) {
      errors.push(`${label} is required for cutover`);
      continue;
    }
    const persistentPrefix = `docs/plugin-development-evidence/${evidence.plugin}/${evidence.skill}/`;
    const archiveSuffix = evidence.evidencePath.startsWith(persistentPrefix)
      ? evidence.evidencePath.slice(persistentPrefix.length)
      : '';
    const archiveMatch = archiveSuffix.match(/^([^/]+)\/evals\/evaluation\.json$/u);
    if (!archiveMatch) {
      errors.push(`${label} must use a persistent migration evidence path`);
      continue;
    }
    const archiveRelative = `${persistentPrefix}${archiveMatch[1]}`;
    const evidencePath = await resolveStrictFile(
      root,
      canonicalRoot,
      evidence.evidencePath,
    );
    if (!evidencePath) {
      errors.push(`${label} is missing or unsafe`);
      continue;
    }
    const raw = await readFile(evidencePath);
    if (sha256(raw) !== evidence.evidenceDigest) {
      errors.push(`${label} digest does not match`);
      continue;
    }
    const committedEvidence = await gitBytes(root, ['show', `HEAD:${evidence.evidencePath}`]);
    if (committedEvidence === null || sha256(committedEvidence) !== evidence.evidenceDigest) {
      errors.push(`${label} must match evidence committed at HEAD`);
      continue;
    }
    let evaluation;
    try {
      evaluation = JSON.parse(raw.toString('utf8'));
    } catch {
      errors.push(`${label} is invalid JSON`);
      continue;
    }
    if (
      evaluation.schemaVersion !== 1
      || evaluation.batchId !== archiveMatch[1]
      || evaluation.owner?.kind !== 'plugin-skill'
      || evaluation.owner?.plugin !== evidence.plugin
      || evaluation.owner?.skill !== evidence.skill
    ) {
      errors.push(`${label} owner or schema does not match`);
      continue;
    }
    if (
      evaluation.outcome !== 'passed'
      || evaluation.complete !== true
      || evaluation.mechanicalPassed !== true
    ) {
      errors.push(`${label} is not complete and passed`);
    }
    if (
      evaluation.source?.inScopeDirty !== false
      || typeof evaluation.source?.gitHead !== 'string'
    ) {
      errors.push(`${label} does not identify a clean source revision`);
    } else if (!(await gitSucceeds(root, [
      'merge-base',
      '--is-ancestor',
      evaluation.source.gitHead,
      currentHead,
    ]))) {
      errors.push(`${label} source revision is not an ancestor of repository HEAD`);
    }
    const manifestRelative = manifestFor(evidence.plugin, evidence.skill);
    const manifestPath = await resolveStrictFile(root, canonicalRoot, manifestRelative);
    if (!manifestPath) {
      errors.push(`${label} manifest is missing or unsafe`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      errors.push(`${label} manifest is invalid JSON`);
      continue;
    }
    const declaredSuites = new Map(manifest.suites.map((entry) => [entry.id, entry]));
    for (const requirement of gate.requiredSuites ?? []) {
      if (requirement.manifest !== manifestRelative) continue;
      const requiredSuite = declaredSuites.get(requirement.suite);
      if (!requiredSuite || requiredSuite.requiredForRelease !== true) {
        errors.push(`${label} suite ${requirement.suite} is not release-required`);
      }
    }
    for (const profile of manifest.profiles) {
      if (
        manifest.suites.some((entry) => entry.requiredForRelease && entry.profiles.includes(profile.id))
        && (profile.runModel !== true || profile.requiredForRelease !== true)
      ) {
        errors.push(`${label} profile ${profile.id} is not a release-required model profile`);
      }
    }
    const targetById = new Map((evaluation.targets ?? []).map((target) => [target.target, target]));
    for (const targetId of releaseTargets(manifest)) {
      const target = targetById.get(targetId);
      if (
        !target
        || target.requiredForRelease !== true
        || target.outcome !== 'passed'
        || target.complete !== true
        || target.mechanicalPassed !== true
      ) {
        errors.push(`${label} is missing passed release target ${targetId}`);
      }
    }
    await verifyArchivedEvaluation(
      root,
      canonicalRoot,
      archiveRelative,
      evaluation,
      manifest,
      label,
      errors,
    );
    const pluginNames = [...new Set(manifest.profiles.flatMap((profile) =>
      profile.plugins.map((plugin) => plugin.name)))];
    let currentSourceDigest = null;
    try {
      currentSourceDigest = await computeMigrationSourceDigest(root, pluginNames);
    } catch {
      errors.push(`${label} source production digest cannot be computed`);
    }
    if (currentSourceDigest !== evaluation.source?.digest) {
      errors.push(`${label} source digest does not match current production sources`);
    }
    const dirty = await gitOutput(root, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      ...pluginNames.map((plugin) => `plugins/${plugin}`),
    ]);
    if (dirty === null || dirty !== '') {
      errors.push(`${label} source plugin set is dirty or cannot be verified`);
    }
    const ignored = await gitOutput(root, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ...pluginNames.map((plugin) => `plugins/${plugin}`),
    ]);
    if (ignored === null || ignored !== '') {
      errors.push(`${label} source plugin set contains ignored production files`);
    }
  }
}

export async function verifyPluginDevelopmentMigration(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return { schemaVersion: 2, ok: false, status: null, cutoverReady: false, errors: ['migration root is missing or unsafe'] };
  }
  const contractResult = await readStrictJson(root, canonicalRoot, options.contractPath ?? 'docs/plugin-development-migration.json');
  const errors = contractResult.error ? [contractResult.error] : [];
  const contract = contractResult.value;
  if (!contract) return { schemaVersion: 2, ok: false, status: null, cutoverReady: false, errors };

  if (contract.schemaVersion !== 2) errors.push('migration contract schemaVersion must be 2');
  if (!STATUSES.has(contract.status)) errors.push(`invalid migration status: ${String(contract.status)}`);
  verifyCanonicalContract(contract, errors);

  if (contract.status === 'retired') {
    await verifyInactiveRoute(root, canonicalRoot, LEGACY_ROUTES[0], errors, 'legacy');
    await verifyRoute(root, canonicalRoot, LEGACY_ROUTES[1], errors);
    for (const route of REPLACEMENT_ROUTES) await verifyRoute(root, canonicalRoot, route, errors);
  } else {
    for (const route of LEGACY_ROUTES) await verifyRoute(root, canonicalRoot, route, errors);
    for (const route of REPLACEMENT_ROUTES) {
      await verifyInactiveReplacementRoute(root, canonicalRoot, route, errors);
    }
  }
  for (const relative of LEGACY_ENTRYPOINTS) await verifyFile(root, canonicalRoot, relative, errors, 'legacy entrypoint');
  for (const relative of REPLACEMENT_ENTRYPOINTS) await verifyFile(root, canonicalRoot, relative, errors, 'replacement entrypoint');
  for (const capability of CAPABILITY_MATRIX) {
    await verifyFile(root, canonicalRoot, capability.owner, errors, `capability owner for ${capability.id}`);
  }
  for (const gate of CUTOVER_GATES) {
    for (const item of gate.implementationEvidence ?? []) {
      for (const relative of item.paths) await verifyFile(root, canonicalRoot, relative, errors, `${gate.id} implementation evidence`);
    }
    for (const target of gate.requiredSuites ?? []) {
      await verifyFile(root, canonicalRoot, target.manifest, errors, `${gate.id} suite manifest`);
    }
  }
  if (contract.status !== 'parallel') {
    const currentHead = await gitOutput(root, ['rev-parse', 'HEAD']);
    if (!currentHead) errors.push('repository HEAD is required for cutover evidence currentness');
    for (const gate of contract.cutoverGates) {
      await verifyModelEvidence(root, canonicalRoot, gate, currentHead, errors);
    }
  }

  return {
    schemaVersion: 2,
    ok: errors.length === 0,
    status: contract.status,
    cutoverReady: contract.status !== 'parallel' && errors.length === 0,
    capabilityCounts: {
      migrated: CAPABILITY_MATRIX.filter((entry) => entry.disposition === 'migrated').length,
      legacyRetained: CAPABILITY_MATRIX.filter((entry) => entry.disposition === 'legacy-retained').length,
    },
    gateCount: CUTOVER_GATES.length,
    errors,
  };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') options.root = args[++index];
    else if (args[index] === '--contract') options.contractPath = args[++index];
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  return options;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await verifyPluginDevelopmentMigration(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 2, ok: false, status: null, cutoverReady: false, errors: [error.message] })}\n`);
    process.exitCode = 1;
  }
}
