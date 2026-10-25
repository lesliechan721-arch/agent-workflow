import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fixtureAssetURL as selectionAssetURL } from './selection-observations.mjs';

// Eval control only. This script never supplies a business verdict or a model answer.
const KEYS = ['simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile',
  'quickProfile', 'standardProfile', 'deepProfile', 'advisorGeneralProfile', 'advisorAdvancedProfile', 'advisorExpertProfile', 'subagentCommands'];
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
  try { value = JSON.parse(result.stdout); } catch { throw new Error(`fixtureCommandFailed: ${command} ${args.slice(0, 2).join(' ')}: exit=${result.code}, diagnostic=${result.stderr.slice(0, 2048)}`); }
  if (result.code !== 0 || value.ok === false || value.status === 'failed') throw new Error(`fixtureCommandFailed: ${command} ${args.slice(0, 2).join(' ')}: exit=${result.code}, code=${value.code ?? value.status ?? 'failed'}, diagnostic=${JSON.stringify(value.error ?? (value.errors?.length ? value.errors : value.message ?? value)).slice(0, 2048)}`);
  return value;
}
async function successfulCommand(command, args, options) {
  const result = await processResult(command, args, options);
  if (result.code !== 0) throw new Error(`fixtureCommandFailed: ${command} ${args.slice(0, 2).join(' ')}: exit=${result.code}, diagnostic=${result.stderr.slice(0, 2048)}`);
  return result;
}
function labEnvironment(workspace) {
  const root = path.join(workspace, LAB);
  return { ...process.env, AW_HOME: path.join(root, 'home', 'aw'), AW_CODEX_HOME: path.join(root, 'home', 'codex'),
    AW_CLAUDE_HOME: path.join(root, 'home', 'claude'), HOME: path.join(root, 'home'), CI: '1', GIT_TERMINAL_PROMPT: '0' };
}
async function awAvailable(env, cwd) {
  const describe = await jsonCommand('aw', ['self', 'describe', '--json'], { env, cwd });
  const required = ['aw.installed-runtime-config.v2', 'aw.dynamic-artifacts.v2', 'aw.plugin-config.v4', 'aw.plugin-config-unique-by.v1', 'aw.plugin-config-value-ref.v1'];
  const missing = required.filter((item) => !describe.capabilities?.includes(item));
  if (missing.length) throw new Error(`fixtureEnvironmentUnsupported: PATH aw lacks ${missing.join(', ')}`);
  return describe;
}
async function tree(root, prefix = '') {
  const result = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name === 'evals' || entry.name.startsWith('.aw-') || entry.name === '.agent-workflows-owner.json') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('fixtureSourceSymlink');
    if (entry.isDirectory()) Object.assign(result, await tree(root, relative));
    else if (entry.isFile()) result[relative] = await readFile(await file(root, relative), 'utf8');
    else throw new Error('fixtureSourceUnsafe');
  }
  return result;
}
/** Public text observations are not backend terminal or process-containment evidence. */
function controlLines(text) {
  const controls = [];
  let boundary;
  for (const line of text.split('\n')) {
    if (boundary) {
      if (line === boundary) boundary = undefined;
      continue;
    }
    const begin = line.match(/^BEGIN_(MESSAGE|INPUT|FINAL|DIAGNOSTIC):([a-f0-9]{8})$/);
    if (begin) boundary = `END_${begin[1]}:${begin[2]}`;
    else controls.push(line);
  }
  return controls;
}
export function parseGuideObservation(stdout, stderr = '', exitCode = null) {
  const lines = controlLines(stdout);
  const recognized = /^(start|wait|result|stop): (ready|notReady|error|changed|settled|read|stopped|stopping)$/.test(lines[0] ?? '');
  const reported = recognized ? lines.find((line) => /^state: (starting|running|closing|completed|failed|cancelled|unknown)$/.test(line))?.slice(7) : undefined;
  const code = [...controlLines(stderr), ...lines].find((line) => /^code: [A-Za-z][A-Za-z0-9]*$/.test(line))?.slice(6);
  const state = reported === 'completed' && exitCode !== null && exitCode !== 0 ? 'unknown'
    : reported ?? (exitCode === 2 && code ? 'failed' : 'unknown');
  return { state, exitCode, stdout, stderr,
    ...(code ? { code } : !recognized ? { code: 'guideOutputUnrecognized' } : {}) };
}
export async function guide(workspace, args, { root, env = process.env, allowFailure = false, input }) {
  const entry = await file(root, 'scripts/subagent.mjs');
  let result = await processResult(process.execPath, [entry, ...args], { cwd: workspace, env, input });
  const handle = args[0] === 'start' ? controlLines(result.stdout).find((line) => line.startsWith('run: '))?.slice(5) : undefined;
  if (handle) {
    let observed = parseGuideObservation(result.stdout, result.stderr, result.code);
    while (['starting', 'running', 'closing'].includes(observed.state)) {
      result = await processResult(process.execPath, [entry, 'wait', '--run', handle], { cwd: workspace, env, timeout: 610000 });
      observed = parseGuideObservation(result.stdout, result.stderr, result.code);
      if (result.outputOverflow || result.code !== 0) break;
      if (result.stdout === 'wait: timeout\n') observed.state = 'running';
    }
    result = await processResult(process.execPath, [entry, 'result', '--run', handle], { cwd: workspace, env });
  }
  const value = parseGuideObservation(result.stdout, result.stderr, result.code);
  if (result.outputOverflow) { value.state = 'unknown'; value.code = 'guideOutputTooLarge'; }
  if (result.code !== 0 && !allowFailure) throw new Error(`fixtureGuideFailed:${value.code ?? 'failed'}`);
  return { exitCode: result.code, value };
}
/** Eval-only data observation. The product reader validates provenance before every real run. */
export async function observeInstalledRuntimeConfig({ workspace, resourceRoot, keys }) {
  const relativeRoot = path.relative(workspace, resourceRoot).split(path.sep).join('/');
  const snapshotFile = await file(workspace, `${rel(relativeRoot)}/.aw-runtime-config.json`);
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
  if (snapshot?.schemaVersion !== 2 || snapshot.kind !== 'aw-runtime-config'
    || !snapshot.installedIdentity || typeof snapshot.installedIdentity !== 'object' || Array.isArray(snapshot.installedIdentity)
    || !snapshot.effectiveValues || typeof snapshot.effectiveValues !== 'object' || Array.isArray(snapshot.effectiveValues)
    || !Array.isArray(snapshot.allowedKeys) || keys.some((key) => !snapshot.allowedKeys.includes(key))) {
    throw new Error('fixtureRuntimeProjectionUnavailable');
  }
  return { installedIdentity: structuredClone(snapshot.installedIdentity), resourceRoot,
    effectiveValues: Object.fromEntries(keys.filter((key) => Object.hasOwn(snapshot.effectiveValues, key))
      .map((key) => [key, structuredClone(snapshot.effectiveValues[key])])) };
}
// Read only the published tables for caller-side selection. Profiles are not runtime config.
export const PROFILE_ROWS = {
  'codex-subagent-guide/references/execution-profiles.md': { simple: 'simpleTaskProfile', general: 'generalTaskProfile', complex: 'complexTaskProfile', advanced: 'advancedTaskProfile' },
  'codex-explore/SKILL.md': { quick: 'quickProfile', standard: 'standardProfile', deep: 'deepProfile' },
  'codex-advisor/SKILL.md': { '通用': 'advisorGeneralProfile', '进阶': 'advisorAdvancedProfile', '专业': 'advisorExpertProfile' },
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
    const source = await readFile(await file(workspace, `.agents/skills/${relative}`), 'utf8');
    for (const line of source.split('\n')) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      const key = labels[cells[0]];
      if (!key) continue;
      if (cells.length !== 5 || Object.hasOwn(values, key)) throw new Error('fixtureProfileTableInvalid');
      const profile = {};
      for (const [index, field] of ['executor', 'model', 'reasoningEffort'].entries()) {
        const cell = cells[index + 2];
        if (cell === '后端默认' && field !== 'executor') continue;
        if (!cell.startsWith('`') || !cell.endsWith('`')) throw new Error('fixtureProfileTableInvalid');
        const value = JSON.parse(cell.slice(1, -1));
        if (typeof value !== 'string' || !value.trim()) throw new Error('fixtureProfileTableInvalid');
        profile[field] = value;
      }
      values[key] = profile;
    }
  }
  return values;
}
async function readInstalled(workspace, root) {
  return observeInstalledRuntimeConfig({ workspace, resourceRoot: root, keys: ['subagentCommands'] });
}
export const fixtureRendererSource = `import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let dataBytes; try { dataBytes=await readFile(path.join(root,'fixture-data.json'),'utf8'); } catch(error) { if(error.code!=='ENOENT')throw error; dataBytes=await readFile(path.join(root,'codex','fixture-data.json'),'utf8'); }
const data=JSON.parse(dataBytes);
const context=JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT,'utf8'));
const values=context.config?.values ?? context.renderConfig?.values ?? context.configValues ?? data.values;
const artifacts=context.requestedArtifactIds.map(id=>{
 if(id==='fixture-unrelated-skill' && data.unrelatedFiles)return {id,kind:'skill',platform:'codex',target:'codex.skill',state:'present',skillKey:'fixture-unrelated',refreshKeys:[],content:{files:data.unrelatedFiles}};
 if(id!=='codex-subagent-guide-skill')throw new Error('unknown fixture target');
 const files={...data.files};
 files['references/execution-profiles.md']=files['references/execution-profiles.md'].split('\\n').map(line=>{
  const labels={simple:'simpleTaskProfile',general:'generalTaskProfile',complex:'complexTaskProfile',advanced:'advancedTaskProfile'};
  const key=labels[line.split('|')[1]?.trim()];
  if(!key || !values[key])return line;
  const columns=line.split('|');
  if(columns.length!==7)throw new Error('fixture profile table shape changed');
  const cell=value=>value===undefined?'后端默认':String.fromCharCode(96)+JSON.stringify(value).replaceAll('|','\\\\u007c').replaceAll(String.fromCharCode(96),'\\\\u0060')+String.fromCharCode(96);
  columns[3]=' '+cell(values[key].executor ?? 'native')+' '; columns[4]=' '+cell(values[key].model)+' '; columns[5]=' '+cell(values[key].reasoningEffort)+' ';
  return columns.join('|');
 }).join('\\n');
 return {id,kind:'skill',platform:'codex',target:'codex.skill',state:'present',skillKey:'codex-subagent-guide',refreshKeys:data.keys,content:{files}};
});
process.stdout.write(JSON.stringify({version:2,artifacts})+'\\n');
`;
function fixtureConfig(values) {
  const fields = {};
  for (const key of KEYS) {
    if (key === 'subagentCommands') continue;
    fields[key] = { type: 'object', properties: { executor: { type: 'string' } }, additionalProperties: false,
      variants: { discriminator: 'executor', missing: 'native', cases: { native: { properties: {
        model: { type: 'string', required: true }, reasoningEffort: { type: 'string', required: true } } } },
      otherwise: { properties: { model: { type: 'string' }, reasoningEffort: { type: 'string' } } } },
      ...(Object.hasOwn(values, key) ? { default: values[key] } : {}) };
  }
  const string = { type: 'string' };
  const properties = { key: { ...string, required: true },
    adapter: { ...string, required: true, choices: { allowCustom: false, presets: ['codex', 'claude-code', 'oracle', 'custom'].map((value) => ({ id: value, title: value, value })) } },
    args: { type: 'array', items: string }, env: { type: 'object', additionalProperties: string }, envFrom: { type: 'object', additionalProperties: string } };
  const cases = Object.fromEntries([['codex', 'workspace'], ['claude-code', 'workspace'], ['oracle', 'bundle']].map(([adapter, mode]) => [adapter, { properties: { mode: { ...string, const: mode } } }]));
  cases.custom = { properties: { mode: { ...string, required: true }, command: { ...string, required: true }, entrypoint: string } };
  fields.subagentCommands = { type: 'array', items: { type: 'object', properties, variants: { discriminator: 'adapter', cases }, additionalProperties: false }, default: values.subagentCommands };
  return { schemaVersion: 4, fields };
}
/** A public synthetic installation proves source/apply behavior, never model support. */
async function installLab(workspace, fixtures, operation) {
  const lab = path.join(workspace, LAB), catalog = path.join(lab, 'catalog'), project = path.join(lab, 'project');
  const env = labEnvironment(workspace);
  await Promise.all([mkdir(project, { recursive: true }), mkdir(catalog, { recursive: true })]);
  const capability = await awAvailable(env, project);
  await successfulCommand('git', ['init', '--quiet', project], { env, cwd: project });
  const sourceGuide = path.join(workspace, '.agents', 'skills', 'codex-subagent-guide');
  const original = await readInstalled(workspace, sourceGuide);
  const values = { ...await observeInstalledProfiles(workspace), ...structuredClone(original.effectiveValues) };
  const files = await tree(sourceGuide);
  delete files['scripts/aw-runtime-config.mjs']; delete files['aw-plugin-requirements.json'];
  const commands = values.subagentCommands ?? [];
  if (['single-write-disconnect', 'invalid-workspace-files'].includes(operation)) {
    const entrypoint = await file(fixtures, 'fixtures/single-write-disconnect.mjs');
    commands.push({ key: 'fixture-control', adapter: 'custom', mode: 'workspace', command: process.execPath, entrypoint });
    values.generalTaskProfile = { executor: 'fixture-control', model: values.generalTaskProfile.model, reasoningEffort: 'high' };
  } else {
    const profile = values.advisorGeneralProfile;
    if (!commands.some((item) => item.key === profile?.executor && ['codex', 'claude-code', 'oracle', 'custom'].includes(item.adapter))) throw new Error('fixtureEnvironmentUnsupported: real external advisorGeneralProfile required');
    if (operation === 'custom-instructions-install') values.generalTaskProfile = structuredClone(profile);
  }
  values.subagentCommands = commands;
  const unrelatedFiles = operation === 'instruction-update-install' ? {
    'SKILL.md': '---\nname: fixture-unrelated\ndescription: Unrelated fixture Skill, only used to observe independent source changes.\n---\n\nReturn the requested local fact.\n',
    'README.md': '# Unrelated fixture Skill\n',
    'agents/openai.yaml': 'interface:\n  display_name: "Unrelated fixture"\n  short_description: "Observe one independent local fixture source change."\n  default_prompt: "Use $fixture-unrelated to observe this local source only."\npolicy:\n  allow_implicit_invocation: false\n',
  } : null;
  const data = { keys: KEYS, files, values, unrelatedFiles };
  await jsonCommand('aw', ['catalog', 'init', '--workspace-root', catalog, '--owner-name', 'Foreground Eval', '--owner-url', 'https://example.invalid/foreground-eval', '--display-name', 'Isolated Foreground Eval', '--json'], { env, cwd: project });
  await successfulCommand('aw', ['plugin', 'init', 'role-boundary-lab', '--workspace-root', catalog, '--description', 'Explicit isolated Eval fixture', '--no-skills'], { env, cwd: project });
  const plugin = path.join(catalog, 'plugins', 'role-boundary-lab');
  const scaffold = JSON.parse(await readFile(await file(plugin, '.agents-plugin/plugin.json'), 'utf8'));
  await put(plugin, 'fixture-data.json', JSON.stringify(data)); await put(plugin, 'scripts/render.mjs', fixtureRendererSource);
  for (const [relative, text] of Object.entries(files)) await put(plugin, `skills/codex-subagent-guide/${relative}`, text);
  const manifest = { schemaVersion: 3, name: 'role-boundary-lab', version: '0.1.0', description: 'Explicit isolated Eval fixture',
    marketplace: scaffold.marketplace, ...(scaffold.interface ? { interface: scaffold.interface } : {}),
    requires: { aw: { capabilities: ['aw.installed-runtime-config.v2', 'aw.plugin-config.v4'] } }, config: fixtureConfig(values),
    buildConfig: { fileRules: { codex: { include: ['fixture-data.json'], exclude: [] } } },
    scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
    artifacts: { targets: [{ id: 'codex-subagent-guide-skill', platform: 'codex', scopes: ['project'], target: 'codex.skill',
      delivery: { mode: 'aw-extension' }, projectManagedKind: 'skill', states: ['present'], refreshKeys: KEYS,
      skillKey: 'codex-subagent-guide', sourceDirs: ['./skills/codex-subagent-guide'], runtimeConfig: { keys: ['subagentCommands'] } }] } };
  if (unrelatedFiles) {
    for (const [relative, content] of Object.entries(unrelatedFiles)) await put(plugin, `skills/fixture-unrelated/${relative}`, content);
    manifest.artifacts.targets.push({ id: 'fixture-unrelated-skill', platform: 'codex', scopes: ['project'], target: 'codex.skill', delivery: { mode: 'aw-extension' }, projectManagedKind: 'skill', states: ['present'], refreshKeys: [], skillKey: 'fixture-unrelated', sourceDirs: ['./skills/fixture-unrelated'] });
  }
  await put(plugin, '.agents-plugin/plugin.json', JSON.stringify(manifest, null, 2));
  await jsonCommand('aw', ['plugin', 'validate', plugin, '--json'], { env, cwd: project });
  const snapshot = path.join(catalog, 'snapshot');
  await jsonCommand('aw', ['catalog', 'build', '--workspace-root', catalog, '--out', snapshot, '--force', '--json'], { env, cwd: project });
  await jsonCommand('aw', ['catalog', 'source', 'add', 'role-boundary-eval', '--path', snapshot, '--primary', '--no-auto-check', '--yes', '--json'], { env, cwd: project });
  await jsonCommand('aw', ['catalog', 'source', 'sync', 'role-boundary-eval', '--yes', '--json'], { env, cwd: project });
  await jsonCommand('aw', ['install', 'role-boundary-eval/role-boundary-lab', '--scope', 'project', '--platform', 'codex', '--yes', '--json'], { env, cwd: project });
  const guideRoot = path.join(project, '.agents', 'skills', 'codex-subagent-guide');
  const active = await readInstalled(project, guideRoot);
  const instructionsFile = path.join(lab, 'instructions.md'), promptFile = path.join(lab, 'task.md');
  const instructions = operation === 'custom-instructions-install'
    ? 'Read README.md and return its two facts with original source lines. Stay read-only. Do not delegate or load coordinator Skills.\n'
    : await readFile(await file(path.join(workspace, '.agents', 'skills', operation === 'single-write-disconnect' ? 'codex-subagent-guide' : 'codex-advisor'), operation === 'single-write-disconnect' ? 'assets/task-instructions.md' : 'assets/advisor-instructions.md'), 'utf8');
  await writeFile(instructionsFile, instructions);
  await writeFile(promptFile, 'Read README.md and src/select.js. Give a bounded second opinion. Stay read-only.\n');
  const state = { version: 1, operation, project, catalog, plugin, snapshot, guideRoot, instructionsFile, promptFile,
    sourceId: 'role-boundary-eval', pluginId: 'role-boundary-eval/role-boundary-lab',
    installedIdentity: active.installedIdentity, effectiveValues: active.effectiveValues, execution: values[operation === 'custom-instructions-install' || operation === 'single-write-disconnect' || operation === 'invalid-workspace-files' ? 'generalTaskProfile' : 'advisorGeneralProfile'], originalInstructions: instructions,
    unrelatedSkillRoot: unrelatedFiles ? path.join(project, '.agents', 'skills', 'fixture-unrelated') : null,
    publicAwCapabilityDigest: capability.capabilitySetDigest };
  await put(workspace, `${LAB}/state.json`, JSON.stringify(state, null, 2));
  return { state, env };
}
async function stateOf(workspace) { return JSON.parse(await readFile(await file(workspace, `${LAB}/state.json`), 'utf8')); }
async function applyChange(workspace, instructions = false) {
  const state = await stateOf(workspace), env = labEnvironment(workspace);
  const before = await readInstalled(state.project, state.guideRoot);
  const commands = structuredClone(before.effectiveValues.subagentCommands).map((item) => ({ ...item, env: { ...(item.env ?? {}), FIXTURE_REVISION: 'updated' } }));
  await jsonCommand('aw', ['config', 'set', state.pluginId, 'subagentCommands', '--scope', 'project', '--value-json', JSON.stringify(commands), '--yes', '--json'], { env, cwd: state.project });
  const saved = await readInstalled(state.project, state.guideRoot);
  if (!isDeepStrictEqual(saved.effectiveValues, before.effectiveValues)) throw new Error('fixtureSaveUnexpectedlyApplied');
  // Repeating the same config set --apply has no store change and does not
  // refresh outputs. Public sync applies this already saved configuration.
  await jsonCommand('aw', ['sync', state.pluginId, '--scope', 'project', '--platform', 'codex', '--yes', '--json'], { env, cwd: state.project });
  const after = await readInstalled(state.project, state.guideRoot);
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
    instructionsFile: state.instructionsFile, promptFile: state.promptFile, execution: state.execution, publicAwCapabilityDigest: state.publicAwCapabilityDigest };
  const artifacts = [];
  if (input.operation === 'invalid-workspace-files') {
    const prompt = await readFile(state.promptFile, 'utf8');
    const rejected = await guide(state.project, ['start', '--executor', 'fixture-control', '--instructions-file', state.instructionsFile,
      '--prompt', '-', '--file', ''], { root: state.guideRoot, env, allowFailure: true, input: prompt });
    if (rejected.exitCode !== 2 || rejected.value.code !== 'filesNotAllowedInWorkspace') throw new Error('fixtureInputRejectionMissing');
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
      '--prompt', '-', '--workspace', workspace], { root: state.guideRoot, env, allowFailure: true, input: input.task });
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
