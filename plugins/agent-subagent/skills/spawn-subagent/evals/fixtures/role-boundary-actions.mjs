import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fixtureAssetURL as selectionAssetURL } from './selection-observations.mjs';

// Eval control only. This script never supplies a business verdict or a model answer.
const LAB = '.role-boundary-fixture';
export const fixtureAssetURL = import.meta.url;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function rel(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('fixturePathUnsafe');
  return value;
}
async function file(root, relative, missing = false) {
  let cursor = root;
  const parts = rel(relative).split('/');
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    const stat = await lstat(cursor).catch((error) => {
      if (missing && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))) throw new Error('fixturePathUnsafe');
  }
  return cursor;
}
async function put(root, relative, bytes) {
  const target = await file(root, relative, true);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return relative;
}
async function processResult(command, args, options = {}) {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (options.input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(options.input); }
  const chunks = []; const errors = []; let size = 0; let outputOverflow = false;
  const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 60000);
  child.stdout.on('data', (bytes) => { size += bytes.length; if (size > 4 * 1024 * 1024 + 65536) { outputOverflow = true; child.kill('SIGTERM'); } else chunks.push(bytes); });
  child.stderr.on('data', (bytes) => { if (errors.reduce((total, item) => total + item.length, 0) < 256 * 1024) errors.push(bytes); });
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), outputOverflow };
  } finally { clearTimeout(timer); }
}
async function jsonCommand(command, args, options) {
  const result = await processResult(command, args, options);
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error(`fixtureCommandFailed: ${command} ${args.slice(0, 3).join(' ')}: exit=${result.code}, diagnostic=${result.stderr.slice(0, 2048)}`); }
  if (result.code !== 0 || value?.schemaVersion !== 2 || value.status !== 'success' || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) {
    throw new Error(`fixtureCommandFailed: ${command} ${args.slice(0, 3).join(' ')}: exit=${result.code}, status=${value?.status ?? 'failed'}, diagnostic=${JSON.stringify(value?.diagnostics ?? []).slice(0, 2048)}`);
  }
  return value.data;
}
async function successfulCommand(command, args, options) {
  const result = await processResult(command, args, options);
  if (result.code !== 0) throw new Error(`fixtureCommandFailed: ${command} ${args.slice(0, 2).join(' ')}: exit=${result.code}, diagnostic=${result.stderr.slice(0, 2048)}`);
  return result;
}
function labEnvironment(workspace) {
  const home = path.join(workspace, LAB, 'home'), codex = path.join(home, 'codex'), claude = path.join(home, 'claude');
  return { ...process.env, AW_HOME: path.join(home, 'aw'), AW_CODEX_HOME: codex, CODEX_HOME: codex,
    AW_CLAUDE_HOME: claude, CLAUDE_CONFIG_DIR: claude, HOME: home, USERPROFILE: home, CI: '1', GIT_TERMINAL_PROMPT: '0' };
}
async function awAvailable(env, cwd) {
  const describe = await jsonCommand('aw', ['self', 'describe', '--json'], { env, cwd });
  const required = ['aw.cli-output.v2', 'aw.self-check.v2', 'aw.plugin-authoring.v2', 'aw.catalog-authoring.v2', 'aw.catalog-source.v3', 'aw.plugin-recovery.v2', 'aw.plugin-manifest.v4', 'aw.platform-components.v3', 'aw.plugin-config.v5', 'aw.managed-commands.v2', 'aw.native-tools.v3'];
  const missing = required.filter((item) => !describe.capabilities?.includes(item));
  if (missing.length) throw new Error(`fixtureEnvironmentUnsupported: PATH aw lacks ${missing.join(', ')}`);
  return describe;
}
/** Public text observations are not backend terminal or process-containment evidence. */
function guideOutput(text) {
  const controls = [];
  const blocks = [];
  let boundary;
  for (const line of text.split('\n')) {
    if (boundary) {
      if (line === `</${boundary.tag}>`) { blocks.push(boundary); boundary = undefined; }
      continue;
    }
    const begin = line.match(/^<((message|input|result|diagnostic)(?:_[0-9]+)?)((?: [a-z_]+="[^"\n]*")*)>$/);
    if (begin) boundary = { tag: begin[1], kind: begin[2], attrs: Object.fromEntries([...begin[3].matchAll(/ ([a-z_]+)="([^"]*)"/g)].map(([, name, value]) => [name, value])) };
    else controls.push(line);
  }
  return { controls, blocks };
}
export function parseGuideObservation(stdout, stderr = '', exitCode = null) {
  const { controls, blocks } = guideOutput(stdout);
  const { blocks: errors } = guideOutput(stderr);
  const controlsWithHandle = /^(started|starting|start_failed|ready|deferred|stopped|stopping) (aw6-[A-Za-z0-9_-]{11}-[A-Za-z0-9_-]{22})(?= |$)(.*)$/;
  const control = controls.map((line) => line.match(controlsWithHandle)).find(Boolean);
  const terminal = /^(completed|failed|cancelled|unknown)$/;
  const results = blocks.filter(({ kind, attrs }) => kind === 'result' && terminal.test(attrs.state ?? '')
    && /^aw6-[A-Za-z0-9_-]{11}-[A-Za-z0-9_-]{22}$/.test(attrs.run ?? ''));
  const result = results.length === 1 ? results[0].attrs : undefined;
  const reported = result?.state ?? ({ started: 'running', starting: 'starting', ready: 'running' }[control?.[1]])
    ?? (control?.[1] === 'start_failed' ? control[3].match(/\bstate=(failed|cancelled|unknown)(?= |$)/)?.[1] : undefined);
  const code = [...errors, ...blocks].filter(({ kind }) => kind === 'diagnostic' || kind === 'result')
    .map(({ attrs }) => attrs.code).find((value) => /^[A-Za-z][A-Za-z0-9]*$/.test(value ?? ''))
    ?? control?.[3].match(/\bcode=([A-Za-z][A-Za-z0-9]*)(?= |$)/)?.[1];
  const recognized = Boolean(control || blocks.length || errors.length || controls.some((line) => ['timeout', 'settled', 'more=true'].includes(line)));
  const state = reported === 'completed' && exitCode !== null && exitCode !== 0 ? 'unknown'
    : reported ?? (exitCode === 2 && code ? 'failed' : 'unknown');
  return { state, exitCode, stdout, stderr,
    ...(result?.run || control?.[2] ? { run: result?.run ?? control[2] } : {}),
    ...(control ? { event: control[1] } : {}),
    ...(code ? { code } : !recognized ? { code: 'guideOutputUnrecognized' } : {}) };
}
export async function guide(workspace, args, { selector, env = process.env, allowFailure = false, follow = true }) {
  const invocation = ['command', 'run', selector + '/codex', '--'];
  const [action] = args;
  let result = await processResult('aw', [...invocation, ...args], { cwd: workspace, env });
  const start = parseGuideObservation(result.stdout, result.stderr, result.code);
  const handle = follow && action === 'start' && start.run;
  if (handle && !result.outputOverflow) {
    const deadline = Date.now() + 60000;
    let event = start.event;
    while (['started', 'starting', 'ready', undefined].includes(event)) {
      if (Date.now() >= deadline) throw new Error('fixtureGuideWaitTimedOut');
      result = await processResult('aw', [...invocation, 'wait', '--run', handle, '--timeout-ms', '1000'], { cwd: workspace, env });
      const waited = parseGuideObservation(result.stdout, result.stderr, result.code);
      if (result.outputOverflow || result.code !== 0 || guideOutput(result.stdout).blocks.some(({ kind }) => kind === 'result') || result.stdout === 'settled\n') break;
      event = waited.event;
    }
    result = await processResult('aw', [...invocation, 'result', '--run', handle], { cwd: workspace, env });
  }
  const value = parseGuideObservation(result.stdout, result.stderr, result.code);
  if (result.outputOverflow) { value.state = 'unknown'; value.code = 'guideOutputTooLarge'; }
  if (result.code !== 0 && !allowFailure) throw new Error(`fixtureGuideFailed:${value.code ?? 'failed'}`);
  return { exitCode: result.code, value };
}
/** Eval-only data observation. The product reader validates provenance before every real run. */
export async function inspectGuideCommand(workspace, selector, env = process.env) {
  const data = await jsonCommand('aw', ['command', 'show', selector, '--json'], { cwd: workspace, env });
  return data.commands?.length === 1 ? data.commands[0] : undefined;
}
export async function observeGuideProjection(workspace) {
  const root = '.agents/skills/spawn-subagent/references/';
  const read = async (name) => readFile(await file(workspace, root + name, true), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const source = await read('external-execution.md');
  const modes = new Map();
  if (!source) return { selector: null, modes };
  const selectors = [...source.matchAll(/^aw command run ([a-z][a-z0-9-]{0,31}\/agent-subagent)\/codex -- start(?: |$)/gm)];
  if (selectors.length !== 1) throw new Error('fixtureRuntimeProjectionUnavailable');
  const selection = await read('executor-selection.md');
  for (const [, key] of selection.matchAll(/^\| `([A-Za-z0-9][A-Za-z0-9._-]*)` \| `(?:codex|claude-code|antigravity|custom|custom-managed)` \|/gm)) {
    if (modes.has(key)) throw new Error('fixtureExecutorTableInvalid');
    modes.set(key, 'workspace');
  }
  if (!modes.size) throw new Error('fixtureExecutorTableInvalid');
  return { selector: selectors[0][1], modes };
}
export async function observeInstalledRuntimeConfig({ packageView, selector, keys, env = process.env }) {
  const resourceRoot = packageView?.resourceRoot;
  const producer = packageView?.owner?.producer;
  if (packageView?.owner?.kind !== 'plugin' || packageView.selector !== selector
    || packageView.availability !== 'ready' || !packageView.runtimeConfigPlatforms?.includes('codex')
    || !producer || `${producer.sourceId}/${producer.pluginName}` !== selector
    || !path.isAbsolute(resourceRoot ?? '')) throw new Error('fixtureRuntimeProjectionUnavailable');
  const awHome = await realpath(env.AW_HOME || path.join(os.homedir(), '.aw'));
  const relativeRoot = path.relative(awHome, resourceRoot).split(path.sep).join('/');
  const snapshotFile = await file(awHome, `${rel(relativeRoot)}/.aw/runtime-config/codex.json`);
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  if (snapshot?.schemaVersion !== 1 || snapshot.kind !== 'aw-command-runtime-config' || snapshot.platform !== 'codex'
    || !isDeepStrictEqual(snapshot.producer, producer) || snapshot.pluginVersion !== packageView.pluginVersion
    || snapshot.sourceContentDigest !== packageView.sourceContentDigest
    || !snapshot.effectiveValues || typeof snapshot.effectiveValues !== 'object' || Array.isArray(snapshot.effectiveValues)
    || !Array.isArray(snapshot.allowedKeys) || keys.some((key) => !snapshot.allowedKeys.includes(key))) {
    throw new Error('fixtureRuntimeProjectionUnavailable');
  }
  return { installedIdentity: { ...producer, pluginId: selector, pluginVersion: snapshot.pluginVersion,
    sourceContentDigest: snapshot.sourceContentDigest, platform: snapshot.platform }, resourceRoot,
    effectiveValues: Object.fromEntries(keys.filter((key) => Object.hasOwn(snapshot.effectiveValues, key))
      .map((key) => [key, structuredClone(snapshot.effectiveValues[key])])) };
}
// Read only the published tables for caller-side selection. Profiles are not runtime config.
export const PROFILE_ROWS = {
  'spawn-subagent/references/executor-selection.md': { simple: 'simpleTaskProfile', general: 'generalTaskProfile', complex: 'complexTaskProfile', advanced: 'advancedTaskProfile' },
  'codex-explore/SKILL.md': { quick: 'quickProfile', standard: 'standardProfile', deep: 'deepProfile' },
  'codex-advisor/SKILL.md': { general: 'advisorGeneralProfile', advanced: 'advisorAdvancedProfile', expert: 'advisorExpertProfile' },
};
/** Synthetic source tables for provider and public CLI fixtures; no backend claims. */
export function fixtureProfileSources(values) {
  const cell = (value) => value === undefined ? '后端默认' : '`' + JSON.stringify(value).replaceAll('|', '\\u007c').replaceAll('`', '\\u0060') + '`';
  return Object.fromEntries(Object.entries(PROFILE_ROWS).map(([file, labels]) => [file,
    '| 档位 | 适用范围 | executor | model | reasoningEffort |\n| --- | --- | --- | --- | --- |\n' +
    Object.entries(labels).filter(([, key]) => values[key]).map(([label, key]) => {
      const profile = values[key];
      return `| ${label} | Explicit fixture | ${cell(profile.executor ?? 'native')} | ${cell(profile.model)} | ${cell(profile.reasoningEffort)} |`;
    }).join('\n') + '\n']));
}
export async function observeInstalledProfiles(workspace) {
  const values = {};
  for (const [relative, labels] of Object.entries(PROFILE_ROWS)) {
    const source = await readFile(await file(workspace, `.agents/skills/${relative}`, true), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    for (const line of source.split('\n')) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      const key = labels[cells[0]];
      if (!key) continue;
      if (cells.length !== 5 || Object.hasOwn(values, key)) throw new Error('fixtureProfileTableInvalid');
      const profile = {};
      for (const [index, field] of ['executor', 'model', 'reasoningEffort'].entries()) {
        const cell = cells[index + 2];
        if (['后端默认', '后端默认（按需 inspect 选型）', '宿主默认'].includes(cell) && field !== 'executor') continue;
        if (!cell.startsWith('`') || !cell.endsWith('`')) throw new Error('fixtureProfileTableInvalid');
        const value = JSON.parse(cell.slice(1, -1));
        if (typeof value !== 'string' || !value.trim()) throw new Error('fixtureProfileTableInvalid');
        profile[field] = value;
      }
      values[key] = profile;
    }
  }
  for (const key of Object.values(PROFILE_ROWS['spawn-subagent/references/executor-selection.md'])) {
    values[key] ??= { executor: 'native' };
  }
  return values;
}
async function readInstalled(workspace, selector, env) {
  const packageView = await inspectGuideCommand(workspace, selector, env);
  return observeInstalledRuntimeConfig({ packageView, selector, env, keys: ['subagentCommands', 'subagentRetentionHours'] });
}
/** A public synthetic installation proves source/apply behavior, never model support. */
async function installLab(workspace, fixtures, operation) {
  const lab = path.join(workspace, LAB), catalog = path.join(lab, 'catalog'), project = path.join(lab, 'project');
  const env = labEnvironment(workspace);
  await Promise.all([mkdir(project, { recursive: true }), mkdir(catalog, { recursive: true })]);
  const capability = await awAvailable(env, project);
  await successfulCommand('git', ['init', '--quiet', project], { env, cwd: project });
  const sourceGuide = path.join(workspace, '.agents', 'skills', 'spawn-subagent');
  const projection = await observeGuideProjection(workspace);
  const values = await observeInstalledProfiles(workspace);
  const prepared = JSON.parse(await readFile(await file(fixtures, '.aw-command-fixture/command.json'), 'utf8'));
  if (prepared?.schemaVersion !== 1 || prepared.platform !== 'codex' || prepared.command?.mode !== 'static'
    || !isDeepStrictEqual(prepared.command.runtimeConfig?.keys, ['subagentCommands', 'subagentRetentionHours'])
    || !Array.isArray(prepared.effectiveValues?.subagentCommands)) throw new Error('fixtureCommandSourceUnavailable');
  const localControl = ['single-write-disconnect', 'invalid-workspace-files'].includes(operation);
  const profileKey = localControl || operation === 'custom-instructions-install' ? 'generalTaskProfile' : 'advisorGeneralProfile';
  const execution = localControl ? { executor: 'fixture-control' } : values[profileKey];
  const commands = localControl
    ? [{ key: execution.executor, adapter: 'custom', command: process.execPath, entrypoint: await file(fixtures, 'fixtures/single-write-disconnect.mjs') }]
    : prepared.effectiveValues.subagentCommands;
  const executor = commands.find((item) => item.key === execution?.executor);
  const mode = localControl ? 'workspace' : projection.modes.get(execution?.executor);
  if (!mode || !executor || !['codex', 'claude-code', 'antigravity', 'custom'].includes(executor.adapter)) {
    throw new Error(`fixtureEnvironmentUnsupported: configured external ${profileKey} required`);
  }
  await jsonCommand('aw', ['dev', 'catalog', 'create', '--workspace-root', catalog, '--owner-name', 'Foreground Eval', '--owner-url', 'https://example.invalid/foreground-eval', '--display-name', 'Isolated Foreground Eval', '--json'], { env, cwd: project });
  await successfulCommand('aw', ['dev', 'plugin', 'create', 'role-boundary-lab', '--workspace-root', catalog, '--description', 'Explicit isolated Eval fixture', '--no-skills'], { env, cwd: project });
  const plugin = path.join(catalog, 'plugins', 'role-boundary-lab');
  const scaffold = JSON.parse(await readFile(await file(plugin, '.agents-plugin/plugin.json'), 'utf8'));
  const fields = Object.fromEntries(prepared.command.runtimeConfig.keys.map((key) => [key, {
    ...prepared.fields[key], default: key === 'subagentCommands' ? commands : prepared.effectiveValues[key],
  }]));
  const command = { ...prepared.command, sourceDir: './commands', platforms: ['codex'] };
  await cp(path.join(fixtures, '.aw-command-fixture', 'command'), path.join(plugin, 'commands'), { recursive: true });
  const unrelated = operation === 'instruction-update-install';
  if (unrelated) {
    await put(workspace, '.agents/skills/fixture-unrelated/SKILL.md', '---\nname: fixture-unrelated\ndescription: Unrelated fixture Skill, only used to observe independent changes.\n---\n\nReturn the requested local fact.\n');
  }
  const capabilities = ['aw.plugin-config.v5', 'aw.plugin-config-unique-by.v1', 'aw.managed-commands.v2'];
  if (prepared.nativeTools) capabilities.push('aw.native-tools.v3');
  const manifest = { schemaVersion: 4, name: 'role-boundary-lab', version: '0.1.0', description: 'Explicit isolated Eval fixture',
    platforms: ['codex'], marketplace: scaffold.marketplace,
    ...(scaffold.interface ? { interface: scaffold.interface } : {}),
    requires: { aw: { capabilities } }, config: { schemaVersion: 5, fields }, command,
    ...(prepared.nativeTools ? { nativeTools: prepared.nativeTools } : {}) };
  await put(plugin, '.agents-plugin/plugin.json', JSON.stringify(manifest, null, 2));
  await jsonCommand('aw', ['dev', 'plugin', 'validate', plugin, '--json'], { env, cwd: project });
  const snapshot = path.join(catalog, 'snapshot');
  await jsonCommand('aw', ['dev', 'catalog', 'build', '--workspace-root', catalog, '--out', snapshot, '--json'], { env, cwd: project });
  await jsonCommand('aw', ['source', 'add', 'role-boundary-eval', '--path', snapshot, '--primary', '--no-auto-check', '--yes', '--json'], { env, cwd: project });
  await jsonCommand('aw', ['source', 'sync', 'role-boundary-eval', '--yes', '--json'], { env, cwd: project });
  const selector = 'role-boundary-eval/role-boundary-lab';
  await jsonCommand('aw', ['command', 'package', 'sync', selector, '--yes', '--json'], { env, cwd: project });
  const active = await readInstalled(project, selector, env);
  const instructionsFile = path.join(lab, 'instructions.md'), promptFile = path.join(lab, 'task.md');
  const instructions = operation === 'custom-instructions-install'
    ? 'Read README.md and return its two facts with original source lines. Stay read-only. Do not delegate or load coordinator Skills.\n'
    : await readFile(await file(path.join(workspace, '.agents', 'skills'), localControl
      ? 'spawn-subagent/assets/task-instructions.md' : 'codex-advisor/assets/advisor-instructions.md'), 'utf8');
  await writeFile(instructionsFile, instructions);
  await writeFile(promptFile, operation === 'custom-instructions-install'
    ? 'Read README.md and return its two facts with original line numbers. Stay read-only.\n'
    : 'Read README.md and src/select.js. Give a bounded second opinion. Stay read-only.\n');
  const state = { version: 1, operation, project, catalog, plugin, snapshot, guideRoot: sourceGuide, instructionsFile, promptFile,
    sourceId: 'role-boundary-eval', pluginId: selector,
    installedIdentity: active.installedIdentity, execution, mode, originalInstructions: instructions,
    unrelatedSkillRoot: unrelated ? path.join(workspace, '.agents', 'skills', 'fixture-unrelated') : null,
    publicAwCapabilityDigest: capability.capabilitySetDigest };
  await put(workspace, `${LAB}/state.json`, JSON.stringify(state, null, 2));
  return { state, env };
}
async function stateOf(workspace) { return JSON.parse(await readFile(await file(workspace, `${LAB}/state.json`), 'utf8')); }
async function applyChange(workspace, instructions = false) {
  const state = await stateOf(workspace), env = labEnvironment(workspace);
  const before = await readInstalled(state.project, state.pluginId, env);
  const commands = structuredClone(before.effectiveValues.subagentCommands).map((item) => ({ ...item, env: { ...(item.env ?? {}), FIXTURE_REVISION: 'updated' } }));
  await jsonCommand('aw', ['plugin', 'config', 'set', state.pluginId, 'subagentCommands', '--context', 'project', '--platform', 'codex', '--value-json', JSON.stringify(commands), '--yes', '--json'], { env, cwd: state.project });
  const saved = await readInstalled(state.project, state.pluginId, env);
  if (!isDeepStrictEqual(saved.effectiveValues, before.effectiveValues)) throw new Error('fixtureSaveUnexpectedlyApplied');
  await jsonCommand('aw', ['plugin', 'config', 'apply', state.pluginId, '--context', 'project', '--platform', 'codex', '--yes', '--json'], { env, cwd: state.project });
  const after = await readInstalled(state.project, state.pluginId, env);
  if (!isDeepStrictEqual(after.effectiveValues.subagentCommands, commands)) throw new Error('fixtureApplyDidNotUpdateValues');
  if (instructions) {
    await writeFile(state.instructionsFile, state.originalInstructions + '\nSeparate facts from assumptions. Include the still missing validation.\n');
    // This unrelated source is deliberately changed; there is no peer digest gate.
    const unrelatedSource = await file(state.unrelatedSkillRoot, 'SKILL.md');
    await writeFile(unrelatedSource, await readFile(unrelatedSource, 'utf8') + '\nAn unrelated Skill source changed during the active call.\n');
  }
  const transition = { operation: instructions ? 'apply-instructions' : 'apply-configuration', installedIdentity: after.installedIdentity,
    before: before.effectiveValues, saved: saved.effectiveValues, after: after.effectiveValues,
    instructionsBefore: state.originalInstructions, instructionsAfter: await readFile(state.instructionsFile, 'utf8'),
    observationScope: 'Public save/apply and source file observations only. A live original session, consumed instructions and generation count require actual host/adapter trace.' };
  state.transition = transition;
  await put(workspace, `${LAB}/state.json`, JSON.stringify(state, null, 2));
  return { artifacts: [await put(workspace, 'provided/input-transition.json', JSON.stringify(transition, null, 2))], evidence: transition };
}
async function foregroundObservations(workspace) {
  const evidence = { operation: 'verify-foreground', observation: 'unavailable' };
  try {
    const state = await stateOf(workspace);
    evidence.transition = state.transition ?? null;
    evidence.results = {};
    for (const name of ['original', 'new']) evidence.results[name] = parseGuideObservation(await readFile(await file(workspace, `provided/${name}-result.txt`), 'utf8'));
    evidence.observation = 'captured';
    evidence.observationScope = 'Recorded public text only; service support, active-session continuity, instruction input and generation count require actual trace. No background recovery is attempted.';
  } catch (error) { evidence.diagnostic = String(error.message).slice(0, 2048); }
  return { version: 1, completed: true, artifacts: [await put(workspace, 'provided/foreground-observations.json', JSON.stringify(evidence, null, 2))], evidence };
}

export async function executeFixtureAction(payload) {
  if (payload?.version !== 1 || !path.isAbsolute(payload.paths?.workspace ?? '') || !path.isAbsolute(payload.paths?.fixtures ?? '')) throw new Error('fixtureInputInvalid');
  const workspace = await realpath(payload.paths.workspace);
  const fixtures = await realpath(payload.paths.fixtures);
  const input = payload.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('fixtureInputInvalid');
  if (input.operation === 'release-files') {
    const artifacts = [];
    for (const [relative, content] of Object.entries(input.files ?? {})) {
      if (typeof content !== 'string' || ['.agents/', '.codex/', '.git/'].some((prefix) => relative.startsWith(prefix))) throw new Error('fixtureSourceInvalid');
      artifacts.push(await put(workspace, relative, content));
    }
    return { version: 1, completed: true, artifacts, evidence: { operation: input.operation,
      files: Object.fromEntries(await Promise.all(artifacts.map(async (relative) => [relative, sha(await readFile(await file(workspace, relative)))]))) } };
  }
  if (input.operation === 'verify-selection') {
    const result = await processResult(process.execPath, ['--experimental-vm-modules', '--max-old-space-size=128', fileURLToPath(selectionAssetURL)],
      { cwd: workspace, env: process.env, timeout: 5000, input: JSON.stringify({ workspace }) });
    let evidence;
    try { evidence = JSON.parse(result.stdout); } catch { evidence = { source: 'src/select.js', observation: 'unavailable', diagnostic: 'selection execution did not produce bounded observations' }; }
    const artifact = await put(workspace, 'provided/selection-observations.json', JSON.stringify(evidence, null, 2));
    return { version: 1, completed: true, artifacts: [artifact], evidence: { ...evidence, operation: input.operation, exitCode: result.code } };
  }
  if (input.operation === 'verify-foreground') return foregroundObservations(workspace);
  if (['apply-configuration', 'apply-instructions'].includes(input.operation)) return { version: 1, completed: true, ...await applyChange(workspace, input.operation === 'apply-instructions') };
  if (!['custom-instructions-install', 'foreground-install', 'instruction-update-install', 'single-write-disconnect', 'invalid-workspace-files'].includes(input.operation)) throw new Error('fixtureOperationUnsupported');
  const { state, env } = await installLab(workspace, fixtures, input.operation);
  const evidence = { operation: input.operation, installedIdentity: state.installedIdentity, guideRoot: state.guideRoot,
    instructionsFile: state.instructionsFile, promptFile: state.promptFile, execution: state.execution, mode: state.mode,
    commandSelector: state.pluginId, commandEnvironment: { AW_HOME: env.AW_HOME, HOME: env.HOME },
    publicAwCapabilityDigest: state.publicAwCapabilityDigest };
  const artifacts = [];
  if (input.operation === 'invalid-workspace-files') {
    const rejected = await guide(state.project, ['start', '--executor', 'fixture-control', '--instructions-file', state.instructionsFile,
      '--prompt-file', state.promptFile, '--file', ''], { selector: state.pluginId, env, allowFailure: true });
    if (rejected.exitCode !== 2 || rejected.value.code !== 'argumentsInvalid') throw new Error('fixtureInputRejectionMissing');
    evidence.preflight = rejected.value;
    evidence.adapterExecutionCounter = await readFile(path.join(state.project, LAB, 'counter.json'), 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (evidence.adapterExecutionCounter !== null) throw new Error('fixtureRejectedInputExecuted');
  }
  if (input.operation === 'single-write-disconnect') {
    const initial = input.initialRun;
    if (initial?.access !== 'workspace-write' || initial.allowedWorkspaceChanges?.join(',') !== 'probe/once.txt'
      || initial.operation !== input.task || typeof initial.counterOwner !== 'string') throw new Error('fixtureInitialRunInvalid');
    await writeFile(state.promptFile, input.task);
    const run = await guide(workspace, ['start', '--executor', 'fixture-control', '--instructions-file', state.instructionsFile,
      '--prompt-file', state.promptFile, '--workspace', workspace], { selector: state.pluginId, env, allowFailure: true });
    if (run.value.state !== 'unknown') throw new Error('fixtureFaultDidNotProduceUnknown');
    const counter = JSON.parse(await readFile(await file(workspace, `${LAB}/counter.json`), 'utf8'));
    if (counter.submissions !== 1 || counter.writes !== 1) throw new Error('fixtureFaultCountInvalid');
    evidence.result = run.value; evidence.counter = counter;
    artifacts.push('probe/once.txt', `${LAB}/counter.json`, await put(workspace, 'provided/original-result.json', JSON.stringify(run.value, null, 2)));
  }
  artifacts.push(await put(workspace, 'provided/fixture-state.json', JSON.stringify({ ...evidence, project: state.project }, null, 2)));
  return { version: 1, completed: true, artifacts, evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  executeFixtureAction(JSON.parse(Buffer.concat(chunks).toString('utf8'))).then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch((error) => { process.stderr.write(JSON.stringify({ version: 1, code: error.message }) + '\n'); process.exitCode = 1; });
}
