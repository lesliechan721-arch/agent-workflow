import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const BUILDER_ROLE = 'prototype-builder';
const BUILDER_CONFIG = '.codex/agents/prototype-builder.toml';
const WRITE_TOOLS = new Set(['apply_patch', 'write_file']);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return value;
}

function matchesSchemaType(value, expected) {
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === expected;
}

function validateSchema(value, schema, location, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${location} must be one of the allowed values`);
    return;
  }
  if (schema.type && !matchesSchemaType(value, schema.type)) {
    errors.push(`${location} must be ${schema.type}`);
    return;
  }
  if (schema.type === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${location} is too short`);
  }
  if ((schema.type === 'integer' || schema.type === 'number') && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${location} is below the minimum`);
  }
  if ((schema.type === 'integer' || schema.type === 'number') && schema.maximum !== undefined && value > schema.maximum) {
    errors.push(`${location} is above the maximum`);
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location} has too few items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${location} has too many items`);
    }
    if (schema.uniqueItems) {
      const serialized = value.map((entry) => JSON.stringify(entry));
      if (new Set(serialized).size !== serialized.length) errors.push(`${location} must contain unique items`);
    }
    if (schema.items) {
      value.forEach((entry, index) => validateSchema(entry, schema.items, `${location}[${index}]`, errors));
    }
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${location}.${key} is required`);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (properties[key]) validateSchema(entry, properties[key], `${location}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${location}.${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateSchema(entry, schema.additionalProperties, `${location}.${key}`, errors);
      }
    }
  }
}

function safeRelativePath(value, label) {
  const result = nonEmptyString(value, label);
  if (
    result.includes('\\')
    || result.includes('\0')
    || path.posix.isAbsolute(result)
    || path.posix.normalize(result) !== result
    || result.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) throw new Error(`${label} must be a normalized relative POSIX path.`);
  return result;
}

function parseInput(source) {
  const input = record(JSON.parse(source), 'CodexWorkflowAdapterInput');
  if (input.version !== 1 || !['prepare', 'grade'].includes(input.phase)) {
    throw new Error('CodexWorkflowAdapterInput version or phase is invalid.');
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error('CodexWorkflowAdapterInput.attempt must be a positive integer.');
  }
  if (!['current', 'without-skill', 'previous-version'].includes(input.variant)) {
    throw new Error('CodexWorkflowAdapterInput.variant is invalid.');
  }
  record(input.case, 'CodexWorkflowAdapterInput.case');
  const paths = record(input.paths, 'CodexWorkflowAdapterInput.paths');
  for (const key of ['workspace', 'fixtures', 'output']) {
    if (typeof paths[key] !== 'string' || !path.isAbsolute(paths[key])) {
      throw new Error(`CodexWorkflowAdapterInput.paths.${key} must be absolute.`);
    }
  }
  if (input.phase === 'grade') {
    for (const key of ['evidence', 'modelOutput']) {
      if (typeof paths[key] !== 'string' || !path.isAbsolute(paths[key])) {
        throw new Error(`CodexWorkflowAdapterInput.paths.${key} must be absolute.`);
      }
    }
  }
  return input;
}

function parseCase(selectedCase) {
  const input = record(selectedCase.input, `${selectedCase.id}.input`);
  const expected = record(selectedCase.expected, `${selectedCase.id}.expected`);
  const criteria = record(expected.criteria, `${selectedCase.id}.expected.criteria`);
  const spawnCalls = record(criteria.spawnCalls, `${selectedCase.id}.expected.criteria.spawnCalls`);
  if (
    !Number.isSafeInteger(spawnCalls.min)
    || !Number.isSafeInteger(spawnCalls.max)
    || spawnCalls.min < 0
    || spawnCalls.max < spawnCalls.min
  ) throw new Error(`${selectedCase.id}.expected.criteria.spawnCalls is invalid.`);
  const result = {
    id: nonEmptyString(selectedCase.id, 'case.id'),
    prompt: nonEmptyString(input.prompt, `${selectedCase.id}.input.prompt`),
    spawnCalls,
    workspaceUnchanged: criteria.workspaceUnchanged === true,
    rootOwnedFiles: (criteria.rootOwnedFiles ?? []).map((entry, index) => safeRelativePath(
      entry,
      `${selectedCase.id}.expected.criteria.rootOwnedFiles[${index}]`,
    )),
    builderOwnedFiles: (criteria.builderOwnedFiles ?? []).map((entry, index) => safeRelativePath(
      entry,
      `${selectedCase.id}.expected.criteria.builderOwnedFiles[${index}]`,
    )),
    builderGeneratedFiles: (criteria.builderGeneratedFiles ?? []).map((entry, index) => safeRelativePath(
      entry,
      `${selectedCase.id}.expected.criteria.builderGeneratedFiles[${index}]`,
    )),
    builderCommandContains: stringArray(
      criteria.builderCommandContains ?? [],
      `${selectedCase.id}.expected.criteria.builderCommandContains`,
    ),
    forbiddenFiles: (criteria.forbiddenFiles ?? []).map((entry, index) => safeRelativePath(
      entry,
      `${selectedCase.id}.expected.criteria.forbiddenFiles[${index}]`,
    )),
    modelOutputContains: stringArray(
      criteria.modelOutputContains ?? [],
      `${selectedCase.id}.expected.criteria.modelOutputContains`,
    ),
    requiredContent: record(
      criteria.requiredContent ?? {},
      `${selectedCase.id}.expected.criteria.requiredContent`,
    ),
    prototypeIdentity: criteria.prototypeIdentity === undefined
      ? null
      : record(criteria.prototypeIdentity, `${selectedCase.id}.expected.criteria.prototypeIdentity`),
    technicalEvidenceFile: criteria.technicalEvidenceFile === undefined
      ? null
      : safeRelativePath(
        criteria.technicalEvidenceFile,
        `${selectedCase.id}.expected.criteria.technicalEvidenceFile`,
      ),
  };
  for (const [file, needles] of Object.entries(result.requiredContent)) {
    safeRelativePath(file, `${selectedCase.id}.expected.criteria.requiredContent path`);
    stringArray(needles, `${selectedCase.id}.expected.criteria.requiredContent.${file}`);
  }
  return result;
}

async function materializeBuilderRole(workspace) {
  const target = path.join(workspace, BUILDER_CONFIG);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, [
    `name = ${JSON.stringify(BUILDER_ROLE)}`,
    `description = ${JSON.stringify('构建父代理指定的轻量 Prototype Artifact，只修改 artifact/**。')}`,
    `developer_instructions = ${JSON.stringify('只完成父代理委派的 Artifact 构建。只创建或修改指定 Prototype 的 artifact/**；不要写 brief.md、prototype.json、feedback.json 或 verdict.md；不要替用户决定。完成后返回路径、查看方式、摘要和限制。')}`,
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "medium"',
    '',
  ].join('\n'), { flag: 'wx' });
}

export async function prepareBuilderWorkflow(input) {
  const evalCase = parseCase(input.case);
  await materializeBuilderRole(input.paths.workspace);
  return {
    version: 1,
    prompt: evalCase.prompt,
    sandbox: 'workspace-write',
    model: 'gpt-5.6-luna',
    developerInstructions: [
      'Follow the user request and applicable skills.',
      'Delegation is authorized only when the applicable Skill requires it.',
      'Use apply_patch for all file creation so thread ownership remains observable.',
      'This evaluation has no interactive user reply; do not call a user-input tool.',
      'Keep any unresolved decision open in the final response.',
    ].join(' '),
    roles: [{
      name: BUILDER_ROLE,
      description: '构建父代理指定的轻量 Prototype Artifact，只修改 artifact/**。',
      configFile: BUILDER_CONFIG,
    }],
    multiAgent: {
      protocol: 'v2',
      maxDepth: 1,
      hideSpawnAgentMetadata: true,
      exposeSpawnAgentModelOverrides: true,
    },
  };
}

async function readEvidence(file) {
  const evidence = record(JSON.parse(await readFile(file, 'utf8')), 'workflow evidence');
  if (evidence.version !== 1 || typeof evidence.rootThreadId !== 'string') {
    throw new Error('workflow evidence identity is invalid.');
  }
  const completion = record(evidence.completion, 'workflow evidence.completion');
  const termination = record(evidence.termination, 'workflow evidence.termination');
  const cleanup = record(evidence.cleanup, 'workflow evidence.cleanup');
  const diff = record(evidence.workspaceDiff, 'workflow evidence.workspaceDiff');
  if (
    completion.status !== 'completed'
    || termination.reason !== 'completed'
    || termination.appServerProcessTreeCleanupConfirmed !== true
    || cleanup.isolatedCodexHomeRemoved !== true
  ) throw new Error('workflow evidence does not show clean completion.');
  for (const key of ['added', 'removed', 'modified']) stringArray(diff[key], `workspaceDiff.${key}`);
  for (const key of ['skillLoads', 'threadGraph', 'collaborationCalls']) {
    if (!Array.isArray(evidence[key])) throw new Error(`workflow evidence.${key} must be an array.`);
  }
  return evidence;
}

function add(assertions, name, passed, evidence) {
  assertions.push({ name, passed, evidence });
}

function callMentions(call, file) {
  return JSON.stringify(call.arguments ?? null).replaceAll('\\', '/').includes(file);
}

function patchTargets(call) {
  let source = null;
  if (call.tool === 'apply_patch' && typeof call.arguments?.patch === 'string') {
    source = call.arguments.patch;
  } else if (
    call.tool === 'exec'
    && typeof call.arguments?.input === 'string'
    && /tools\.apply_patch\s*\(/u.test(call.arguments.input)
  ) {
    source = call.arguments.input;
  }
  if (source === null) return [];
  return [...source.matchAll(
    /\*\*\* (?:Add|Update|Delete) File:\s+(.+?)(?=\\n|\\r|\r|\n|"|$)/gu,
  )].map((match) => match[1].replaceAll('\\', '/'));
}

function redirectedTargets(call) {
  if (call.tool !== 'exec_command' || typeof call.arguments?.cmd !== 'string') return [];
  const targets = [];
  const pattern = />{1,2}\s*(['"]?)([^\s'";&|]+)\1/gu;
  for (const match of call.arguments.cmd.replaceAll('\\', '/').matchAll(pattern)) {
    targets.push(match[2]);
  }
  return targets;
}

function callWritesFile(call, file) {
  if (call.tool === 'write_file') {
    return Object.values(call.arguments ?? {}).some((value) => (
      typeof value === 'string' && (value === file || value.replaceAll('\\', '/').endsWith(`/${file}`))
    ));
  }
  if (WRITE_TOOLS.has(call.tool) || call.tool === 'exec') {
    if (patchTargets(call).some((target) => target === file || target.endsWith(`/${file}`))) return true;
  }
  return redirectedTargets(call).some((target) => target === file || target.endsWith(`/${file}`));
}

async function regularFile(root, relative) {
  const target = path.join(root, relative);
  const info = await lstat(target).catch(() => null);
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

function terminalResultObserved(calls, descendants) {
  return calls.some((call) => (
    call.tool === 'agent_message'
    && descendants.has(call.linkedThreadId)
    && call.output?.messageType === 'FINAL_ANSWER'
  ) || (
    call.tool === 'wait_agent'
    && descendants.has(call.linkedThreadId)
    && JSON.stringify(call.output ?? null).includes('completed')
  ));
}

function technicalEvidence(content) {
  const fixedGlobal = content.includes('globalThis.crypto.present=true');
  const fixedSubtle = content.includes('crypto.subtle.present=true');
  const fixedDigest = content.includes('subtle.digest.call=ok')
    && /^subtle\.digest\.sha256=[0-9a-f]{64}$/imu.test(content);
  const labeled = new Map();
  for (const line of content.split('\n')) {
    const match = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/u.exec(line);
    if (match) labeled.set(match[1], match[2]);
  }
  const labeledGlobal = labeled.get('globalThis.crypto')?.toLowerCase() === 'present';
  const labeledSubtle = labeled.get('crypto.subtle')?.toLowerCase() === 'present';
  const labeledDigest = labeled.get('digest_sha256_status')?.toLowerCase() === 'ok'
    && /^[0-9a-f]{64}$/iu.test(labeled.get('digest_sha256_hex') ?? '');
  const jsonStart = content.indexOf('{');
  const report = jsonStart === -1
    ? null
    : (() => {
      try {
        return JSON.parse(content.slice(jsonStart));
      } catch {
        return null;
      }
    })();
  const jsonDigest = typeof report?.sha256Probe === 'string'
    && /^[0-9a-f]{64}$/iu.test(report.sha256Probe);
  const nestedDigest = report?.probe?.success === true
    && typeof report.probe.sha256Hex === 'string'
    && /^[0-9a-f]{64}$/iu.test(report.probe.sha256Hex);
  return {
    globalPresent: fixedGlobal || labeledGlobal || report?.globalThisCrypto === true
      || report?.checks?.globalThisCrypto?.present === true,
    subtlePresent: fixedSubtle || labeledSubtle || report?.globalThisCryptoSubtle === true
      || report?.checks?.globalThisCrypto?.hasSubtle === true,
    digestSucceeded: fixedDigest || labeledDigest || jsonDigest || nestedDigest,
  };
}

export async function gradeBuilderWorkflow(input) {
  const evalCase = parseCase(input.case);
  const [evidence, modelOutput] = await Promise.all([
    readEvidence(input.paths.evidence),
    readFile(input.paths.modelOutput, 'utf8'),
  ]);
  const assertions = [];
  const childThreads = evidence.threadGraph.filter(
    (thread) => thread.parentThreadId === evidence.rootThreadId,
  );
  const builderThreads = new Set(childThreads.map((thread) => thread.threadId));
  const rootCalls = evidence.collaborationCalls.filter(
    (call) => call.threadId === evidence.rootThreadId,
  );
  const builderCalls = evidence.collaborationCalls.filter(
    (call) => builderThreads.has(call.threadId),
  );
  const spawnCalls = rootCalls.filter((call) => call.tool === 'spawn_agent');
  add(
    assertions,
    'skill_load',
    evidence.skillLoads.some((load) => (
      load.threadId === evidence.rootThreadId && load.skill === 'decision-prototype'
    )),
    `root_loads=${evidence.skillLoads.filter((load) => load.threadId === evidence.rootThreadId).length}`,
  );
  add(
    assertions,
    'spawn_count',
    spawnCalls.length >= evalCase.spawnCalls.min && spawnCalls.length <= evalCase.spawnCalls.max,
    `expected=${evalCase.spawnCalls.min}..${evalCase.spawnCalls.max} actual=${spawnCalls.length}`,
  );
  if (evalCase.spawnCalls.min > 0) {
    add(
      assertions,
      'builder_delegation',
      builderThreads.size === spawnCalls.length,
      `spawn_count=${spawnCalls.length} direct_children=${builderThreads.size}`,
    );
    add(
      assertions,
      'builder_terminal_result',
      terminalResultObserved(rootCalls, builderThreads),
      `builders=${builderThreads.size}`,
    );
  }
  const builderCommands = builderCalls.filter((call) => call.tool === 'exec_command');
  for (const file of evalCase.rootOwnedFiles) {
    const rootWrites = rootCalls.filter((call) => callWritesFile(call, file));
    const builderWrites = builderCalls.filter((call) => callWritesFile(call, file));
    add(
      assertions,
      `root_owns:${file}`,
      rootWrites.length > 0 && builderWrites.length === 0,
      `root_writes=${rootWrites.length} builder_writes=${builderWrites.length}`,
    );
  }
  for (const file of evalCase.builderOwnedFiles) {
    const rootWrites = rootCalls.filter((call) => callWritesFile(call, file));
    const builderWrites = builderCalls.filter((call) => callWritesFile(call, file));
    add(
      assertions,
      `builder_owns:${file}`,
      builderWrites.length > 0 && rootWrites.length === 0,
      `root_writes=${rootWrites.length} builder_writes=${builderWrites.length}`,
    );
  }
  for (const file of evalCase.builderGeneratedFiles) {
    const rootWrites = rootCalls.filter((call) => callWritesFile(call, file));
    const builderWrites = builderCalls.filter((call) => callWritesFile(call, file));
    add(
      assertions,
      `builder_generates:${file}`,
      builderWrites.length > 0 && rootWrites.length === 0,
      `root_writes=${rootWrites.length} builder_writes=${builderWrites.length}`,
    );
  }
  if (evalCase.builderCommandContains.length > 0) {
    add(
      assertions,
      'builder_execution',
      builderCommands.some((call) => evalCase.builderCommandContains.every(
        (needle) => JSON.stringify(call.arguments ?? null).includes(needle),
      )),
      `required=${JSON.stringify(evalCase.builderCommandContains)}`,
    );
  }
  const requiredFiles = [
    ...evalCase.rootOwnedFiles,
    ...evalCase.builderOwnedFiles,
    ...evalCase.builderGeneratedFiles,
  ];
  for (const file of requiredFiles) {
    add(assertions, `file_exists:${file}`, await regularFile(input.paths.workspace, file), file);
  }
  for (const file of evalCase.forbiddenFiles) {
    add(assertions, `file_absent:${file}`, !(await regularFile(input.paths.workspace, file)), file);
  }
  for (const [file, needles] of Object.entries(evalCase.requiredContent)) {
    const content = await readFile(path.join(input.paths.workspace, file), 'utf8').catch(() => '');
    add(
      assertions,
      `content:${file}`,
      needles.every((needle) => content.includes(needle)),
      `required=${needles.length}`,
    );
  }
  if (evalCase.technicalEvidenceFile) {
    const content = await readFile(
      path.join(input.paths.workspace, evalCase.technicalEvidenceFile),
      'utf8',
    ).catch(() => '');
    const observed = technicalEvidence(content);
    add(
      assertions,
      'technical_runtime_evidence',
      observed.globalPresent && observed.subtlePresent && observed.digestSucceeded,
      JSON.stringify(observed),
    );
  }
  if (evalCase.prototypeIdentity) {
    const prototypePath = evalCase.rootOwnedFiles.find((file) => file.endsWith('/prototype.json'));
    const [prototype, prototypeSchema] = await Promise.all([
      readFile(path.join(input.paths.workspace, prototypePath ?? ''), 'utf8')
        .then((source) => JSON.parse(source)).catch(() => null),
      readFile(path.join(
        input.paths.workspace,
        '.agents',
        'skills',
        'decision-prototype',
        'assets',
        'prototype.schema.json',
      ), 'utf8').then((source) => JSON.parse(source)).catch(() => null),
    ]);
    const schemaErrors = [];
    if (prototype === null) schemaErrors.push('prototype.json is not valid JSON');
    if (prototypeSchema === null) schemaErrors.push('prototype.schema.json is unavailable');
    if (prototype !== null && prototypeSchema !== null) {
      validateSchema(prototype, prototypeSchema, 'prototype', schemaErrors);
    }
    add(
      assertions,
      'prototype_schema',
      schemaErrors.length === 0,
      schemaErrors.length === 0 ? 'valid=true' : schemaErrors.join('; '),
    );
    add(
      assertions,
      'prototype_identity',
      prototypePath !== undefined
        && Object.entries(evalCase.prototypeIdentity).every(([key, value]) => prototype?.[key] === value),
      `schemaVersion=${prototype?.schemaVersion ?? 'missing'} id=${prototype?.id ?? 'missing'} revision=${prototype?.revision ?? 'missing'}`,
    );
  }
  const changedFiles = [
    ...evidence.workspaceDiff.added,
    ...evidence.workspaceDiff.modified,
    ...evidence.workspaceDiff.removed,
  ].filter((entry) => !entry.endsWith('/'));
  if (evalCase.workspaceUnchanged) {
    add(assertions, 'workspace_unchanged', changedFiles.length === 0, `changes=${changedFiles.length}`);
  } else {
    const allowed = new Set(requiredFiles);
    add(
      assertions,
      'workspace_change_boundary',
      changedFiles.every((entry) => allowed.has(entry)),
      `changes=${JSON.stringify(changedFiles)}`,
    );
  }
  for (const needle of evalCase.modelOutputContains) {
    add(assertions, `model_output:${needle}`, modelOutput.includes(needle), `contains=${needle}`);
  }
  add(
    assertions,
    'engine_cleanup',
    evidence.termination.appServerProcessTreeCleanupConfirmed === true
      && evidence.cleanup.isolatedCodexHomeRemoved === true,
    'confirmed=true',
  );
  const passed = assertions.every((assertion) => assertion.passed === true);
  return {
    passed,
    score: passed ? 1 : 0,
    details: {
      caseId: evalCase.id,
      variant: input.variant,
      complete: true,
      assertions,
    },
  };
}

async function stdin() {
  process.stdin.setEncoding('utf8');
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  return source;
}

async function main() {
  try {
    const input = parseInput(await stdin());
    const result = input.phase === 'prepare'
      ? await prepareBuilderWorkflow(input)
      : await gradeBuilderWorkflow(input);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
