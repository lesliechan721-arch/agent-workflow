import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FIXTURE_FILES = {
  'src/simple.ts': 'export const retryLimit = 3;\n',
  'scripts/delayed-simple.mjs': [
    "import { readFile } from 'node:fs/promises';",
    'await new Promise((resolve) => setTimeout(resolve, 75_000));',
    "const source = await readFile(new URL('../src/simple.ts', import.meta.url), 'utf8');",
    "const match = source.match(/retryLimit\\s*=\\s*(\\d+)/u);",
    "if (!match) throw new Error('retryLimit was not found.');",
    "process.stdout.write(`retryLimit=${match[1]}\\n`);",
    '',
  ].join('\n'),
  'src/general.ts': 'export function formatResult(value) { return String(value); }\n',
  'src/complex/a.ts': 'export async function acquire(lock) { return lock.acquire(); }\n',
  'src/complex/b.ts': 'export async function release(lock) { return lock.release(); }\n',
  'docs/architecture.md': '# Architecture\nRequests flow through gateway, queue, and worker.\n',
  'changes/review.diff': 'diff --git a/src/simple.ts b/src/simple.ts\n-export const retryLimit = 3;\n+export const retryLimit = -1;\n',
};

const LIFECYCLE_FILES = {
  recovery: {
    'scripts/recoverable.mjs': [
      "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
      "const file = new URL('../results/progress.json', import.meta.url);",
      "await mkdir(new URL('../results/', import.meta.url), { recursive: true });",
      "const state = await readFile(file, 'utf8').then(JSON.parse).catch((error) => {",
      "  if (error.code !== 'ENOENT') throw error;",
      '  return { applied: 0, finished: false };',
      '});',
      "if (process.argv[2] === 'start') {",
      '  state.applied += 1;',
      '  await writeFile(file, JSON.stringify(state));',
      "  throw new Error('Temporary service failure after the operation was saved; continue with finish.');",
      '}',
      "if (process.argv[2] !== 'finish' || state.applied !== 1) throw new Error('Invalid progress');",
      'state.finished = true;',
      'await writeFile(file, JSON.stringify(state));',
      'console.log(JSON.stringify(state));',
    ].join('\n'),
  },
  review: {
    'docs/publication-contract.md': [
      '# Publication contract',
      'A prepared or uncertain version owns its immutable version number.',
      'If its saved isolated repo is missing, stop and require a new version; do not rebuild it.',
      'An uncertain CLI attempt requires a new version; ordinary retry cannot repeat the candidate.',
      'A remote immutable tag occupies the version even when the local published journal is missing.',
    ].join('\n'),
    'src/publish-v1.mjs': [
      'export async function publish(version, state, io) {',
      '  if (!state.repoExists) await io.rebuildRepo(version);',
      '  if (state.status === "uncertain") throw new Error("Use a new version");',
      '  if (await io.remoteTagExists(version)) throw new Error("Version occupied");',
      '  return io.publish(version);',
      '}',
    ].join('\n'),
    'src/publish-v2.mjs': [
      'export async function publish(version, state, io) {',
      '  if (!state.repoExists) throw new Error("Use a new version");',
      '  if (state.status === "uncertain") return io.publish(version);',
      '  if (state.journalExists && await io.remoteTagExists(version)) {',
      '    throw new Error("Version occupied");',
      '  }',
      '  return io.publish(version);',
      '}',
    ].join('\n'),
  },
  'new-delivery': {
    'src/new-task.ts': 'export const maxRetries = 7;\n',
  },
};

export const TRIGGER_WORKSPACE_FIXTURES = new Set([
  'default',
  'project_authorization',
  'authorization_skill',
  'lifecycle_skill',
  'partial_requirement_skills',
  'active_lifecycle_skill',
  'explore_route',
]);

async function writeSkill(root, name, lines) {
  const skillPath = path.join(root, '.agents', 'skills', name, 'SKILL.md');
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeCaseFixture(root, fixture) {
  if (!fixture || fixture === 'default') return;
  if (fixture === 'project_authorization') {
    await writeFile(
      path.join(root, 'AGENTS.md'),
      [
        '# Evaluation Instructions',
        '',
        'Delegation is authorized and required for the user task in this workspace.',
        'This rule does not choose an agent type, spawn parameters, context inheritance, waiting, recovery, or cleanup.',
        'Load applicable skills before managing the delegated work.',
        '',
      ].join('\n'),
      'utf8',
    );
    return;
  }
  if (fixture === 'authorization_skill') {
    await writeSkill(root, 'delegation-authorizer', [
      '---',
      'name: delegation-authorizer',
      'description: Use when explicitly invoked to authorize subagent delegation for the current task without defining how delegation is managed.',
      '---',
      '',
      '# Delegation Authorizer',
      '',
      'Delegation is authorized and required for the current user task.',
      'This skill does not choose an agent type, spawn parameters, context inheritance, waiting, recovery, or cleanup.',
    ]);
    return;
  }
  if (fixture === 'lifecycle_skill') {
    await writeSkill(root, 'delegation-lifecycle-owner', [
      '---',
      'name: delegation-lifecycle-owner',
      'description: Use when explicitly invoked to continue a specialized delegation workflow that already owns role selection, spawning, waiting, recovery, and cleanup.',
      '---',
      '',
      '# Delegation Lifecycle Owner',
      '',
      'Continue the already-running specialized delegation workflow.',
      'This skill fully owns role selection, spawn parameters, waiting, recovery, and cleanup.',
      'Do not load a general subagent-management skill and do not spawn a duplicate agent.',
    ]);
    return;
  }
  if (fixture === 'partial_requirement_skills') {
    await Promise.all([
      writeSkill(root, 'delegation-model-requirement', [
        '---',
        'name: delegation-model-requirement',
        'description: Use when explicitly invoked to delegate the current task with a required model but without defining the remaining delegation lifecycle.',
        '---',
        '',
        '# Delegation Model Requirement',
        '',
        'Delegation is authorized and required for the current user task.',
        'Use model gpt-6-astra for the delegated task.',
        'This skill does not choose the remaining spawn parameters, context, waiting, recovery, or cleanup.',
        'Load an applicable general dispatch skill to fill the unspecified choices.',
      ]),
      writeSkill(root, 'delegation-context-requirement', [
        '---',
        'name: delegation-context-requirement',
        'description: Use when explicitly invoked to delegate the current task with required context inheritance but without defining the remaining delegation lifecycle.',
        '---',
        '',
        '# Delegation Context Requirement',
        '',
        'Delegation is authorized and required for the current user task.',
        'The delegated task must inherit the most recent two turns.',
        'This skill does not choose the role, model, remaining spawn parameters, waiting, recovery, or cleanup.',
        'Load an applicable general dispatch skill to fill the unspecified choices.',
      ]),
    ]);
    return;
  }
  if (fixture === 'active_lifecycle_skill') {
    await writeSkill(root, 'delegation-active-lifecycle-owner', [
      '---',
      'name: delegation-active-lifecycle-owner',
      'description: Use when explicitly invoked to perform a specialized delegation workflow that fully owns role selection, spawning, waiting, recovery, and cleanup.',
      '---',
      '',
      '# Delegation Active Lifecycle Owner',
      '',
      'Delegation is authorized and required for the current user task.',
      'Start exactly one codex-subagent agent with a clean context for the requested work.',
      'Wait for its terminal result and use it in the final answer.',
      'Clean up only after the result is retained and only when the current tools support cleanup.',
      'This skill fully owns the current delegation lifecycle. Do not load a general subagent-management skill.',
    ]);
    return;
  }
  if (fixture === 'explore_route') {
    const routeFiles = {
      'repo/gateway/checkout.ts': 'export const checkoutFlag = regionalCheckout;\n',
      'repo/settlement/checkout.ts': 'export function settle(input) { return input.regionalCheckout; }\n',
      'repo/tasks/checkout.ts': 'export function enqueue(input) { return input.regionalCheckout; }\n',
      'repo/shared/config.ts': 'export const regionalCheckout = true;\n',
      ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [
        `repo/modules/module-${String(index + 1).padStart(2, '0')}/handler.ts`,
        `export const unrelatedFeature${index + 1} = true;\n`,
      ])),
    };
    await Promise.all(Object.entries(routeFiles).map(async ([relativePath, content]) => {
      const target = path.join(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }));
    return;
  }
  throw new Error(`Unsupported trigger workspace fixture: ${fixture}`);
}

export async function setupTriggerWorkspace({ workspaceRoot, evalCase }) {
  const fixture = evalCase.workspace_fixture ?? 'default';
  if (!TRIGGER_WORKSPACE_FIXTURES.has(fixture)) {
    throw new Error(`Unsupported trigger workspace fixture: ${fixture}`);
  }
  const lifecycle = evalCase.lifecycle_fixture;
  if (lifecycle && !Object.hasOwn(LIFECYCLE_FILES, lifecycle)) {
    throw new Error(`Unsupported lifecycle fixture: ${lifecycle}`);
  }
  await Promise.all(Object.entries({ ...FIXTURE_FILES, ...LIFECYCLE_FILES[lifecycle] }).map(async ([relativePath, content]) => {
    const target = path.join(workspaceRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }));
  await writeCaseFixture(workspaceRoot, fixture);
}
