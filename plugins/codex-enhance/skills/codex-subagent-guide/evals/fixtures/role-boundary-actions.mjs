import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureAssetURL as selectionAssetURL } from './selection-observations.mjs';

// Eval control only. This script never supplies a business verdict or a model answer.
const KEYS = ['simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile',
  'quickProfile', 'standardProfile', 'deepProfile', 'advisorProfile', 'advisorDesignProfile', 'advisorDebugProfile', 'advisorReviewProfile', 'subagentCommands'];
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
  const chunks = []; const errors = []; let size = 0;
  const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 60000);
  child.stdout.on('data', (bytes) => { size += bytes.length; if (size > 4 * 1024 * 1024) child.kill('SIGTERM'); else chunks.push(bytes); });
  child.stderr.on('data', (bytes) => { if (errors.reduce((total, item) => total + item.length, 0) < 256 * 1024) errors.push(bytes); });
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') };
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
  const required = ['aw.installed-runtime-config.v2', 'aw.dynamic-artifacts.v2', 'aw.plugin-config.v3', 'aw.plugin-config-unique-by.v1', 'aw.plugin-config-value-ref.v1'];
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
async function guide(workspace, args, { root, env = process.env, allowFailure = false }) {
  const entry = await file(root, 'scripts/subagent.mjs');
  const result = await processResult(process.execPath, [entry, ...args], { cwd: workspace, env });
  let value;
  try { value = JSON.parse(result.stdout || result.stderr); } catch { value = { code: 'nonJsonGuideResult' }; }
  if (result.code !== 0 && !allowFailure) throw new Error(`fixtureGuideFailed:${value.error?.code ?? value.code ?? 'failed'}`);
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
async function readInstalled(workspace, root) {
  return observeInstalledRuntimeConfig({ workspace, resourceRoot: root, keys: KEYS });
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
 files['SKILL.md']=files['SKILL.md'].split('\\n').map(line=>{
  const key=data.keys.find(key=>line.startsWith('|') && line.includes(key));
  if(!key || !values[key]?.model)return line;
  const columns=line.split('|');
  if(columns.length!==8)throw new Error('fixture profile table shape changed');
  const cell=value=>String.fromCharCode(96)+JSON.stringify(value)+String.fromCharCode(96);
  columns[4]=' '+cell(values[key].executor ?? 'native')+' '; columns[5]=' '+cell(values[key].model)+' '; columns[6]=' '+cell(values[key].reasoningEffort)+' ';
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
    fields[key] = { type: 'object', properties: {
      executor: { type: 'string' }, model: { type: 'string', required: true },
      reasoningEffort: { type: 'string', required: true } }, additionalProperties: false,
      ...(Object.hasOwn(values, key) ? { default: values[key] } : {}) };
  }
  const properties = Object.fromEntries(['key', 'title', 'mode', 'command', 'entrypoint'].map((key) => [key, { type: 'string' }]));
  for (const key of ['supportsSystemInstructions', 'supportsReadOnly', 'supportsWorkspaceWrite', 'supportsModel', 'supportsReasoningEffort']) properties[key] = { type: 'boolean' };
  fields.subagentCommands = { type: 'array', items: { type: 'object', properties, additionalProperties: false }, default: values.subagentCommands };
  return { schemaVersion: 3, fields };
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
  const values = structuredClone(original.effectiveValues);
  const files = await tree(sourceGuide);
  delete files['scripts/aw-runtime-config.mjs']; delete files['aw-plugin-requirements.json'];
  const commands = values.subagentCommands ?? [];
  if (['single-write-disconnect', 'unsupported-channel'].includes(operation)) {
    const entrypoint = await file(fixtures, 'fixtures/single-write-disconnect.mjs');
    commands.push({ key: 'fixture-control', title: 'Explicit local failure control', mode: 'workspace', command: process.execPath,
      entrypoint, supportsSystemInstructions: operation !== 'unsupported-channel', supportsReadOnly: true, supportsWorkspaceWrite: true });
    values.generalTaskProfile = { executor: 'fixture-control', model: values.generalTaskProfile.model, reasoningEffort: 'high' };
  } else {
    const profile = values.advisorProfile;
    if (!commands.some((item) => item.key === profile?.executor && item.supportsSystemInstructions && item.supportsReadOnly)) throw new Error('fixtureEnvironmentUnsupported: real external advisorProfile required');
    if (operation === 'custom-instructions-install') values.generalTaskProfile = structuredClone(profile);
  }
  values.subagentCommands = commands;
  const unrelatedFiles = operation === 'instruction-update-install' ? { 'SKILL.md': '---\nname: fixture-unrelated\ndescription: Unrelated fixture Skill, only used to observe independent source changes.\n---\n\nReturn the requested local fact.\n', 'README.md': '# Unrelated fixture Skill\n' } : null;
  const data = { keys: KEYS, files, values, unrelatedFiles };
  await jsonCommand('aw', ['catalog', 'init', '--workspace-root', catalog, '--owner-name', 'Foreground Eval', '--owner-url', 'https://example.invalid/foreground-eval', '--display-name', 'Isolated Foreground Eval', '--json'], { env, cwd: project });
  await successfulCommand('aw', ['plugin', 'init', 'role-boundary-lab', '--workspace-root', catalog, '--description', 'Explicit isolated Eval fixture', '--no-skills'], { env, cwd: project });
  const plugin = path.join(catalog, 'plugins', 'role-boundary-lab');
  const scaffold = JSON.parse(await readFile(await file(plugin, '.agents-plugin/plugin.json'), 'utf8'));
  await put(plugin, 'fixture-data.json', JSON.stringify(data)); await put(plugin, 'scripts/render.mjs', fixtureRendererSource);
  for (const [relative, text] of Object.entries(files)) await put(plugin, `skills/codex-subagent-guide/${relative}`, text);
  const manifest = { schemaVersion: 3, name: 'role-boundary-lab', version: '0.1.0', description: 'Explicit isolated Eval fixture',
    marketplace: scaffold.marketplace, ...(scaffold.interface ? { interface: scaffold.interface } : {}),
    requires: { aw: { capabilities: ['aw.installed-runtime-config.v2'] } }, config: fixtureConfig(values),
    buildConfig: { fileRules: { codex: { include: ['fixture-data.json'], exclude: [] } } },
    scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
    artifacts: { targets: [{ id: 'codex-subagent-guide-skill', platform: 'codex', scopes: ['project'], target: 'codex.skill',
      delivery: { mode: 'aw-extension' }, projectManagedKind: 'skill', states: ['present'], refreshKeys: KEYS,
      skillKey: 'codex-subagent-guide', sourceDirs: ['./skills/codex-subagent-guide'], runtimeConfig: { keys: KEYS } }] } };
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
    installedIdentity: active.installedIdentity, effectiveValues: active.effectiveValues, originalInstructions: instructions,
    unrelatedSkillRoot: unrelatedFiles ? path.join(project, '.agents', 'skills', 'fixture-unrelated') : null,
    publicAwCapabilityDigest: capability.capabilitySetDigest };
  await put(workspace, `${LAB}/state.json`, JSON.stringify(state, null, 2));
  return { state, env };
}
async function stateOf(workspace) { return JSON.parse(await readFile(await file(workspace, `${LAB}/state.json`), 'utf8')); }
async function applyChange(workspace, instructions = false) {
  const state = await stateOf(workspace), env = labEnvironment(workspace);
  const before = await readInstalled(state.project, state.guideRoot);
  const commands = structuredClone(before.effectiveValues.subagentCommands).map((item) => ({ ...item, title: item.title + ' (updated)' }));
  await jsonCommand('aw', ['config', 'set', state.pluginId, 'subagentCommands', '--scope', 'project', '--value-json', JSON.stringify(commands), '--yes', '--json'], { env, cwd: state.project });
  const saved = await readInstalled(state.project, state.guideRoot);
  if (JSON.stringify(saved.effectiveValues) !== JSON.stringify(before.effectiveValues)) throw new Error('fixtureSaveUnexpectedlyApplied');
  await jsonCommand('aw', ['config', 'set', state.pluginId, 'subagentCommands', '--scope', 'project', '--value-json', JSON.stringify(commands), '--apply', '--yes', '--json'], { env, cwd: state.project });
  const after = await readInstalled(state.project, state.guideRoot);
  if (JSON.stringify(after.effectiveValues.subagentCommands) !== JSON.stringify(commands)) throw new Error('fixtureApplyDidNotUpdateValues');
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
    for (const name of ['original', 'new']) evidence.results[name] = JSON.parse(await readFile(await file(workspace, `provided/${name}-result.json`), 'utf8'));
    evidence.observation = 'captured';
    evidence.observationScope = 'Recorded result objects only; service support, active-session continuity, instruction input and generation count require actual trace. No background recovery is attempted.';
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
  if (!['custom-instructions-install', 'foreground-install', 'instruction-update-install', 'single-write-disconnect', 'unsupported-channel'].includes(input.operation)) throw new Error('fixtureOperationUnsupported');
  const { state, env } = await installLab(workspace, fixtures, input.operation);
  const evidence = { operation: input.operation, installedIdentity: state.installedIdentity, guideRoot: state.guideRoot,
    instructionsFile: state.instructionsFile, promptFile: state.promptFile, publicAwCapabilityDigest: state.publicAwCapabilityDigest };
  const artifacts = [];
  if (input.operation === 'unsupported-channel') {
    const rejected = await guide(state.project, ['run', '--profile', 'generalTaskProfile', '--instructions-file', state.instructionsFile,
      '--prompt-file', state.promptFile], { root: state.guideRoot, env, allowFailure: true });
    if (rejected.exitCode === 0 || (rejected.value.code ?? rejected.value.error?.code) !== 'instructionChannelUnsupported') throw new Error('fixtureChannelRejectionMissing');
    evidence.preflight = rejected.value;
    evidence.adapterExecutionCounter = await readFile(path.join(state.project, LAB, 'counter.json'), 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (evidence.adapterExecutionCounter !== null) throw new Error('fixtureUnsupportedChannelExecuted');
  }
  if (input.operation === 'single-write-disconnect') {
    const initial = input.initialRun;
    if (initial?.access !== 'workspace-write' || initial.allowedWorkspaceChanges?.join(',') !== 'probe/once.txt'
      || initial.operation !== input.task || typeof initial.counterOwner !== 'string') throw new Error('fixtureInitialRunInvalid');
    await writeFile(state.promptFile, input.task);
    const run = await guide(workspace, ['run', '--profile', 'generalTaskProfile', '--instructions-file', state.instructionsFile,
      '--prompt-file', state.promptFile, '--access', 'workspace-write', '--workspace', workspace,
      ...(input.materials ?? []).flatMap((relative) => ['--file', rel(relative)])], { root: state.guideRoot, env, allowFailure: true });
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
