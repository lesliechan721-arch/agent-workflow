import { lstat, readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUSES = new Set(['parallel', 'ready-for-cutover', 'retired']);
const CUTOVER_UNAVAILABLE = 'cutover verification unavailable; status must remain parallel';
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
    if (!isDeepStrictEqual(contract[name], expected)) {
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

export async function verifyPluginDevelopmentMigration(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return { schemaVersion: 1, ok: false, status: null, cutoverReady: false, errors: ['migration root is missing or unsafe'] };
  }
  const contractResult = await readStrictJson(root, canonicalRoot, options.contractPath ?? 'docs/plugin-development-migration.json');
  const errors = contractResult.error ? [contractResult.error] : [];
  const contract = contractResult.value;
  if (!contract) return { schemaVersion: 1, ok: false, status: null, cutoverReady: false, errors };

  if (contract.schemaVersion !== 1) errors.push('migration contract schemaVersion must be 1');
  if (!STATUSES.has(contract.status)) errors.push(`invalid migration status: ${String(contract.status)}`);
  verifyCanonicalContract(contract, errors);
  if (contract.status !== 'parallel') errors.push(CUTOVER_UNAVAILABLE);

  for (const route of LEGACY_ROUTES) await verifyRoute(root, canonicalRoot, route, errors);
  if (contract.status === 'parallel') {
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

  return {
    schemaVersion: 1,
    ok: errors.length === 0,
    status: contract.status,
    cutoverReady: false,
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
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, status: null, cutoverReady: false, errors: [error.message] })}\n`);
    process.exitCode = 1;
  }
}
