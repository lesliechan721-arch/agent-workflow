import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureAssetURL as selectionAssetURL } from './selection-observations.mjs';

// Eval control only. This script never supplies a business verdict or a model answer.
const KEYS = ['simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile',
  'quickProfile', 'standardProfile', 'deepProfile', 'advisorProfile', 'advisorPolicy', 'subagentCommands'];
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
  const required = ['aw.installed-runtime-config.v1', 'aw.dynamic-artifacts.v2', 'aw.plugin-config.v3', 'aw.plugin-config-unique-by.v1', 'aw.plugin-config-value-ref.v1'];
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
async function guide(workspace, args, { root = path.join(workspace, '.agents', 'skills', 'codex-subagent-guide'), env = process.env, allowFailure = false } = {}) {
  const entry = await file(root, 'scripts/subagent.mjs');
  const result = await processResult(process.execPath, [entry, ...args], { cwd: workspace, env });
  let value;
  try { value = JSON.parse(result.code === 0 ? result.stdout : result.stderr); } catch { value = { code: 'nonJsonGuideResult' }; }
  if (result.code !== 0 && !allowFailure) throw new Error(`fixtureGuideFailed:${value.error?.code ?? value.code ?? 'failed'}`);
  return { exitCode: result.code, value, stdout: result.stdout };
}
async function readInstalled(workspace, root) {
  const proof = await guide(workspace, ['resolve', '--profile', 'advisorProfile'], { root });
  if (!proof.value.ok || !proof.value.plan) throw new Error('fixtureInstalledProofMissing');
  const binding = JSON.parse(await readFile(await file(root, '.aw-runtime-config.json'), 'utf8'));
  if (binding.revision !== proof.value.plan.configRevision || binding.installedIdentity.pluginId !== proof.value.plan.installedIdentity.pluginId) throw new Error('fixtureInstalledRevisionChanged');
  return binding;
}

const renderer = `import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
try {
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let dataBytes; try { dataBytes=await readFile(path.join(root,'fixture-data.json'),'utf8'); } catch(error) { if(error.code!=='ENOENT')throw error; dataBytes=await readFile(path.join(root,'codex','fixture-data.json'),'utf8'); }
const data=JSON.parse(dataBytes);
const context=JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT,'utf8'));
const values=context.config?.values ?? context.renderConfig?.values ?? context.configValues ?? data.values;
const binding=JSON.parse(data.skills['codex-subagent-guide-skill'].files['runtime/worker-bindings.json']);
const cell=value=>String.fromCharCode(96)+JSON.stringify(value).replaceAll('|',String.fromCharCode(92)+'u007c').replaceAll(String.fromCharCode(96),String.fromCharCode(92)+'u0060')+String.fromCharCode(96);
const artifacts=context.requestedArtifactIds.map(id=>{ const item=data.skills[id]; if(!item)throw new Error('unknown fixture target'); const files={...item.files}; files['SKILL.md']=files['SKILL.md'].replaceAll(data.oldRevision,context.runtimeConfig[id].revision).split('\\n').map(line=>{ const key=data.keys.find(key=>line.includes(cell(key)) && line.startsWith('|')); if(!key || !values[key]?.model)return line; const columns=line.split('|'); columns[4]=' '+cell(binding.profiles[key]?.workerKey ?? binding.defaultWorker)+' '; columns[5]=' '+cell(values[key].executor ?? 'native')+' '; columns[6]=' '+cell(values[key].model)+' '; columns[7]=' '+cell(values[key].reasoningEffort)+' '; return columns.join('|'); }).join('\\n'); return {id,kind:'skill',platform:'codex',target:'codex.skill',state:'present',skillKey:item.key,refreshKeys:data.keys,content:{files}}; });
process.stdout.write(JSON.stringify({version:2,artifacts})+'\\n');
} catch(error) { process.stderr.write(JSON.stringify({code:'fixtureRenderFailed',message:error.message})+'\\n'); process.exitCode=1; }
`;

/** AW creates all installation ownership and runtime bindings for this legal synthetic plugin. */
async function installLab(workspace, fixtures, operation) {
  const lab = path.join(workspace, LAB);
  const catalog = path.join(lab, 'catalog');
  const project = path.join(lab, 'project');
  const env = labEnvironment(workspace);
  await Promise.all([mkdir(project, { recursive: true }), mkdir(catalog, { recursive: true })]);
  const capability = await awAvailable(env, project);
  // A real nested repository prevents project-scope writes from selecting the subject's parent root.
  await successfulCommand('git', ['init', '--quiet', project], { env, cwd: project });
  const sourceGuide = path.join(workspace, '.agents', 'skills', 'codex-subagent-guide');
  const original = await readInstalled(workspace, sourceGuide);
  const config = structuredClone(original.definition);
  for (const key of KEYS) config.fields[key].default = structuredClone(original.effectiveValues[key]);
  const binding = JSON.parse(await readFile(await file(sourceGuide, 'runtime/worker-bindings.json'), 'utf8'));
  const installed = {};
  const onlyGuide = ['opaque-install', 'single-write-disconnect', 'unsupported-channel'].includes(operation);
  const skillKeys = onlyGuide ? ['codex-subagent-guide'] : ['codex-subagent-guide', 'codex-explore', 'codex-advisor'];
  for (const key of skillKeys) {
    const files = await tree(path.join(workspace, '.agents', 'skills', key));
    delete files['scripts/aw-runtime-config.mjs']; // AW injects its current reader for every member.
    delete files['aw-plugin-requirements.json']; // Installation metadata belongs to the new AW materialization.
    installed[`${key}-skill`] = { key, files };
  }
  const guideFiles = installed['codex-subagent-guide-skill'].files;
  if (operation === 'opaque-install') {
    const instructions = 'Read README.md and return its two declared facts with source lines. Stay read-only. Do not delegate or load any coordinator Skill.\n';
    binding.workers.push({ key: 'fixture-opaque-reader', nativeRole: 'fixture-opaque-reader', instructionsFile: 'runtime/workers/opaque.md',
      instructionRevision: sha(instructions), maximumAccess: 'read-only', allowDelegation: false });
    binding.profiles.generalTaskProfile = { workerKey: 'fixture-opaque-reader', allowedWorkerKeys: ['fixture-opaque-reader'] };
    guideFiles['runtime/workers/opaque.md'] = instructions;
  }
  const commands = structuredClone(original.effectiveValues.subagentCommands);
  if (['single-write-disconnect', 'unsupported-channel'].includes(operation)) {
    const entrypoint = await file(fixtures, 'fixtures/single-write-disconnect.mjs');
    commands.push({ key: 'fixture-control', title: 'Explicit local failure control', mode: 'workspace', command: process.execPath, entrypoint,
      supportsSystemInstructions: operation !== 'unsupported-channel', supportsReadOnly: true, supportsWorkspaceWrite: true });
    config.fields.subagentCommands.default = commands;
    config.fields.generalTaskProfile.default = { executor: 'fixture-control', model: original.effectiveValues.generalTaskProfile.model, reasoningEffort: 'high' };
  } else {
    const profile = original.effectiveValues.advisorProfile;
    const executor = commands.find((item) => item.key === profile.executor && item.supportsSystemInstructions === true && item.supportsReadOnly === true);
    if (!executor) throw new Error('fixtureEnvironmentUnsupported: configure a real external advisorProfile before this installation scenario');
    if (operation === 'opaque-install') config.fields.generalTaskProfile.default = structuredClone(profile);
  }
  guideFiles['runtime/worker-bindings.json'] = JSON.stringify(binding, null, 2) + '\n';
  const data = { version: 1, keys: KEYS, oldRevision: original.revision, skills: installed, values: Object.fromEntries(KEYS.map((key) => [key, config.fields[key].default])) };
  await jsonCommand('aw', ['catalog', 'init', '--workspace-root', catalog, '--owner-name', 'Role Boundary Eval', '--owner-url', 'https://example.invalid/role-boundary-eval', '--display-name', 'Isolated Role Boundary Eval', '--json'], { env, cwd: project });
  await successfulCommand('aw', ['plugin', 'init', 'role-boundary-lab', '--workspace-root', catalog, '--description', 'Explicit isolated Eval fixture', '--no-skills'], { env, cwd: project });
  const plugin = path.join(catalog, 'plugins', 'role-boundary-lab');
  const scaffold = JSON.parse(await readFile(await file(plugin, '.agents-plugin/plugin.json'), 'utf8'));
  await put(plugin, 'fixture-data.json', JSON.stringify(data));
  await put(plugin, 'scripts/render.mjs', renderer);
  for (const { key, files } of Object.values(installed)) for (const [relative, text] of Object.entries(files)) await put(plugin, `skills/${key}/${relative}`, text);
  const ids = Object.keys(installed);
  const resourceVersion = sha(JSON.stringify(data));
  const manifest = { schemaVersion: 3, name: 'role-boundary-lab', version: '0.1.0', description: 'Explicit isolated Eval fixture',
    marketplace: scaffold.marketplace, ...(scaffold.interface ? { interface: scaffold.interface } : {}),
    config, buildConfig: { fileRules: { codex: { include: ['fixture-data.json'], exclude: [] } } },
    scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
    artifacts: { targets: ids.map((id) => ({ id, platform: 'codex', scopes: ['project'], target: 'codex.skill',
      delivery: { mode: 'aw-extension' }, projectManagedKind: 'skill', states: ['present'], refreshKeys: KEYS,
      skillKey: installed[id].key, sourceDirs: [`./skills/${installed[id].key}`], runtimeConfig: { keys: KEYS, resourceVersion, artifactIds: ids } })) } };
  await put(plugin, '.agents-plugin/plugin.json', JSON.stringify(manifest, null, 2));
  await jsonCommand('aw', ['plugin', 'validate', plugin, '--json'], { env, cwd: project });
  const snapshot = path.join(catalog, 'snapshot');
  await jsonCommand('aw', ['catalog', 'build', '--workspace-root', catalog, '--out', snapshot, '--force', '--json'], { env, cwd: project });
  await jsonCommand('aw', ['catalog', 'source', 'add', 'role-boundary-eval', '--path', snapshot, '--primary', '--no-auto-check', '--yes', '--json'], { env, cwd: project });
  await jsonCommand('aw', ['catalog', 'source', 'sync', 'role-boundary-eval', '--yes', '--json'], { env, cwd: project });
  await jsonCommand('aw', ['install', 'role-boundary-eval/role-boundary-lab', '--scope', 'project', '--platform', 'codex', '--yes', '--json'], { env, cwd: project });
  const guideRoot = path.join(project, '.agents', 'skills', 'codex-subagent-guide');
  const active = await readInstalled(project, guideRoot);
  if (operation === 'single-write-disconnect') {
    const plan = await guide(project, ['resolve', '--profile', 'generalTaskProfile', '--worker', 'task', '--access', 'workspace-write'], { root: guideRoot, env });
    if (plan.value.plan.executor.entrypoint !== await file(fixtures, 'fixtures/single-write-disconnect.mjs') || plan.value.plan.reasoningEffort !== 'high') throw new Error('fixtureFaultBindingInvalid');
  }
  const state = { version: 1, operation, project, catalog, plugin, snapshot, guideRoot,
    sourceId: 'role-boundary-eval', pluginId: 'role-boundary-eval/role-boundary-lab', revision: active.revision,
    resourceVersion: active.resourceVersion, workerInstructionRevision: binding.workers.find((item) => item.key === 'advisor')?.instructionRevision,
    originalRevision: original.revision, originalGuideMethodDigest: sha(installed['codex-subagent-guide-skill'].files['SKILL.md']), capabilitySetDigest: capability.capabilitySetDigest };
  await put(workspace, `${LAB}/state.json`, JSON.stringify(state, null, 2));
  return { state, env, data, manifest };
}
async function stateOf(workspace) { return JSON.parse(await readFile(await file(workspace, `${LAB}/state.json`), 'utf8')); }
async function saveState(workspace, state) { await put(workspace, `${LAB}/state.json`, JSON.stringify(state, null, 2)); }

async function runStoreFacts(workspace, directory) {
  const expectedRoot = path.join(workspace, LAB);
  if (![path.join(expectedRoot, 'runs'), path.join(expectedRoot, 'new-runs')].includes(directory)) throw new Error('fixtureRunStoreBindingInvalid');
  const facts = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(entry.name)) throw new Error('fixtureRunStoreInvalid');
    const relative = path.relative(workspace, path.join(directory, entry.name)).split(path.sep).join('/');
    const requestBytes = await readFile(await file(workspace, `${relative}/request.json`));
    const record = JSON.parse(await readFile(await file(workspace, `${relative}/record.json`), 'utf8'));
    const request = JSON.parse(requestBytes.toString('utf8'));
    if (record.id !== entry.name || request.run?.id !== entry.name) throw new Error('fixtureRunIdentityInvalid');
    facts.push({ id: record.id, state: record.state, requestFileSha256: sha(requestBytes), requestDigest: record.requestDigest,
      actualRequestDigest: sha(JSON.stringify(request)), recordConfigRevision: record.plan?.configRevision,
      recordInstructionRevision: record.plan?.worker?.instructionRevision,
      configRevision: request.run.configRevision, workerKey: request.instructions?.workerKey,
      instructionRevision: request.instructions?.revision, actualInstructionSha256: sha(request.instructions?.text ?? ''),
      executable: { path: record.executable?.path, sha256: record.executable?.sha256,
        entrypoint: record.executable?.entrypoint ? { path: record.executable.entrypoint.path, sha256: record.executable.entrypoint.sha256 } : null },
      providerSessionId: record.receipt?.providerSessionId ?? null, receipt: record.receipt ?? null,
      generationMayHaveStarted: record.generationMayHaveStarted });
  }
  return facts.sort((a, b) => a.id.localeCompare(b.id));
}

async function recoveryObservations(workspace, requireNewContext) {
  const artifacts = [];
  const evidence = { operation: 'verify-recovery', observation: 'unavailable' };
  try {
    const state = await stateOf(workspace);
    const original = state.originalRun;
    const originalRuns = path.join(workspace, LAB, 'runs');
    if (original?.runsDirectory !== originalRuns || typeof original.id !== 'string') throw new Error('fixtureOriginalRunMissing');
    const env = labEnvironment(workspace);
    const before = await runStoreFacts(workspace, originalRuns);
    const status = await guide(workspace, ['status', '--run', original.id, '--runs-dir', originalRuns], { root: state.guideRoot, env, allowFailure: true });
    const collected = await guide(workspace, ['collect', '--run', original.id, '--runs-dir', originalRuns], { root: state.guideRoot, env, allowFailure: true });
    const after = await runStoreFacts(workspace, originalRuns);
    evidence.observation = 'captured';
    evidence.original = { id: original.id, runsDirectory: originalRuns,
      activeAtApply: state.transition?.activeAtApply ?? null,
      atApply: state.originalRunStoreAtApply ?? null,
      expectedConfigRevision: state.transition?.originalRevision ?? state.revision,
      originalInstructionRevision: state.workerInstructionRevision,
      before, status: { exitCode: status.exitCode, value: status.value },
      collect: { exitCode: collected.exitCode, diagnostic: collected.exitCode ? collected.value : null,
        outputSha256: collected.exitCode ? null : sha(collected.stdout), outputBytes: collected.exitCode ? 0 : Buffer.byteLength(collected.stdout) }, after,
      observationScope: 'The before/after run-store snapshots cover only these independent status/collect commands. Parent recovery and extra generation require actual tool events and the full original run-store history.' };
    if (requireNewContext) {
      const current = await readInstalled(state.project, state.guideRoot);
      const fresh = JSON.parse(await readFile(await file(workspace, 'provided/new-run.json'), 'utf8'));
      const newRuns = path.join(workspace, LAB, 'new-runs');
      if (fresh.runsDirectory !== newRuns || typeof fresh.id !== 'string' || fresh.id === original.id) throw new Error('fixtureNewRunBindingInvalid');
      const newBefore = await runStoreFacts(workspace, newRuns);
      const newStatus = await guide(workspace, ['status', '--run', fresh.id, '--runs-dir', newRuns], { root: state.guideRoot, env, allowFailure: true });
      const newCollect = await guide(workspace, ['collect', '--run', fresh.id, '--runs-dir', newRuns], { root: state.guideRoot, env, allowFailure: true });
      const binding = JSON.parse(await readFile(await file(state.guideRoot, 'runtime/worker-bindings.json'), 'utf8'));
      const worker = binding.workers.find((item) => item.key === 'advisor');
      const newAfter = await runStoreFacts(workspace, newRuns);
      evidence.newContext = { id: fresh.id, runsDirectory: newRuns, expectedConfigRevision: current.revision,
        expectedInstructionRevision: worker?.instructionRevision ?? null, before: newBefore,
        status: { exitCode: newStatus.exitCode, value: newStatus.value },
        collect: { exitCode: newCollect.exitCode, diagnostic: newCollect.exitCode ? newCollect.value : null,
          outputSha256: newCollect.exitCode ? null : sha(newCollect.stdout), outputBytes: newCollect.exitCode ? 0 : Buffer.byteLength(newCollect.stdout) }, after: newAfter,
        observationScope: 'The program request and receipt establish the persisted new run binding. Missing provider session/fresh-context trace does not establish actual host history isolation.' };
    }
  } catch (error) { evidence.diagnostic = String(error.message).slice(0, 2048); }
  artifacts.push(await put(workspace, 'provided/recovery-observations.json', JSON.stringify(evidence, null, 2)));
  return { version: 1, completed: true, artifacts, evidence };
}

async function startOriginal(workspace, state, task, materials, access = 'read-only', profile = 'advisorProfile', worker = 'advisor') {
  const taskFile = path.join(workspace, LAB, 'original-task.md');
  await writeFile(taskFile, task);
  const runs = path.join(workspace, LAB, 'runs');
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const result = await guide(workspace, ['run', '--profile', profile, '--worker', worker, '--access', access,
    '--expected-revision', state.revision, '--workspace', workspace, '--prompt-file', taskFile,
    ...materials.flatMap((relative) => ['--file', relative]), '--runs-dir', runs, '--allow-material-transfer', '--allow-model-cost'],
  { root: state.guideRoot, env: labEnvironment(workspace) });
  if (!result.value.id) throw new Error('fixtureOriginalRunMissing');
  state.originalRun = { ...result.value, runsDirectory: runs };
  await saveState(workspace, state);
  return result.value;
}
async function applyChange(workspace, instruction = false) {
  const state = await stateOf(workspace);
  const env = labEnvironment(workspace);
  const before = await readInstalled(state.project, state.guideRoot);
  const submitted = JSON.parse(await readFile(await file(workspace, 'provided/original-run.json'), 'utf8'));
  const runsDirectory = path.join(workspace, LAB, 'runs');
  if (submitted.runsDirectory !== runsDirectory || typeof submitted.id !== 'string') throw new Error('fixtureOriginalRunBindingInvalid');
  const originalProof = await guide(workspace, ['status', '--run', submitted.id, '--runs-dir', runsDirectory], { root: state.guideRoot, env });
  if (originalProof.value.configRevision !== before.revision || originalProof.value.workerKey !== 'advisor') throw new Error('fixtureOriginalRunRevisionInvalid');
  if (originalProof.value.state !== 'running') throw new Error(`fixturePreconditionUnsupported: original run is ${originalProof.value.state}; an active transition was not observed`);
  state.originalRun = originalProof.value;
  state.originalRunStoreAtApply = await runStoreFacts(workspace, runsDirectory);
  const savedCommands = structuredClone(before.effectiveValues.subagentCommands).map((item) => ({ ...item, title: item.title + ' (applied revision)' }));
  await jsonCommand('aw', ['config', 'set', state.pluginId, 'subagentCommands', '--scope', 'project', '--value-json', JSON.stringify(savedCommands), '--yes', '--json'], { env, cwd: state.project });
  const saved = await readInstalled(state.project, state.guideRoot);
  if (saved.revision !== before.revision) throw new Error('fixtureSaveUnexpectedlyApplied');
  const requireActive = async () => {
    const status = await guide(workspace, ['status', '--run', state.originalRun.id, '--runs-dir', state.originalRun.runsDirectory], { root: state.guideRoot, env });
    if (status.value.state !== 'running') throw new Error(`fixturePreconditionUnsupported: original run is ${status.value.state} before apply`);
    state.activeAtApply = status.value;
  };
  if (instruction) {
    const source = path.join(state.plugin, 'fixture-data.json');
    const data = JSON.parse(await readFile(source, 'utf8'));
    const files = data.skills['codex-subagent-guide-skill'].files;
    state.oldAdvisorInstructions = files['runtime/workers/advisor.md'];
    files['runtime/workers/advisor.md'] += '\nFor this explicit Eval revision, preserve the same read-only leaf limits and distinguish evidence from assumptions.\n';
    const binding = JSON.parse(files['runtime/worker-bindings.json']);
    binding.workers.find((item) => item.key === 'advisor').instructionRevision = sha(files['runtime/workers/advisor.md']);
    files['runtime/worker-bindings.json'] = JSON.stringify(binding, null, 2) + '\n';
    await writeFile(source, JSON.stringify(data));
    await put(state.plugin, 'skills/codex-subagent-guide/runtime/workers/advisor.md', files['runtime/workers/advisor.md']);
    await put(state.plugin, 'skills/codex-subagent-guide/runtime/worker-bindings.json', files['runtime/worker-bindings.json']);
    const manifestPath = path.join(state.plugin, '.agents-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = '0.1.1';
    for (const target of manifest.artifacts.targets) target.runtimeConfig.resourceVersion = sha(JSON.stringify(data));
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await jsonCommand('aw', ['plugin', 'validate', state.plugin, '--json'], { env, cwd: state.project });
    await jsonCommand('aw', ['catalog', 'build', '--workspace-root', state.catalog, '--out', state.snapshot, '--force', '--json'], { env, cwd: state.project });
    await jsonCommand('aw', ['catalog', 'source', 'sync', state.sourceId, '--yes', '--json'], { env, cwd: state.project });
    await requireActive();
    await jsonCommand('aw', ['reinstall', state.pluginId, '--scope', 'project', '--platform', 'codex', '--yes', '--json'], { env, cwd: state.project });
  } else {
    await requireActive();
    await jsonCommand('aw', ['config', 'set', state.pluginId, 'subagentCommands', '--scope', 'project', '--value-json', JSON.stringify(savedCommands), '--apply', '--yes', '--json'], { env, cwd: state.project });
  }
  const after = await readInstalled(state.project, state.guideRoot);
  if (after.revision === before.revision) throw new Error('fixtureApplyDidNotChangeRevision');
  const stale = await guide(state.project, ['resolve', '--profile', 'advisorProfile', '--expected-revision', before.revision], { root: state.guideRoot, env, allowFailure: true });
  if (!stale.exitCode) throw new Error('fixtureOldRevisionUnexpectedlyAccepted');
  const original = state.originalRun ? await guide(workspace, ['status', '--run', state.originalRun.id, '--runs-dir', state.originalRun.runsDirectory], { root: state.guideRoot, env }) : null;
  let mixed = null;
  if (instruction) {
    // Deliberate fixture corruption. Leave AW's new receipt untouched and verify its rejection.
    const mixedProject = path.join(workspace, LAB, 'mixed-project');
    await cp(path.join(state.project, '.agents'), path.join(mixedProject, '.agents'), { recursive: true, errorOnExist: true });
    state.mixedGuideRoot = path.join(mixedProject, '.agents', 'skills', 'codex-subagent-guide');
    await writeFile(path.join(state.mixedGuideRoot, 'runtime', 'workers', 'advisor.md'), state.oldAdvisorInstructions);
    mixed = await guide(mixedProject, ['resolve', '--profile', 'advisorProfile'], { root: state.mixedGuideRoot, env, allowFailure: true });
    if (!mixed.exitCode) throw new Error('fixtureMixedInstallationUnexpectedlyAccepted');
  }
  state.transition = { savedRevision: saved.revision, appliedRevision: after.revision,
    originalRevision: before.revision, staleDiagnostic: stale.value, mixedDiagnostic: mixed?.value ?? null,
    originalRunBeforeApply: originalProof.value, originalRunAfterApply: original?.value ?? null,
    originalRunStoreAtApply: state.originalRunStoreAtApply,
    activeAtApply: state.activeAtApply, currentGuideRoot: state.guideRoot, mixedGuideRoot: state.mixedGuideRoot ?? null };
  await saveState(workspace, state);
  const artifact = await put(workspace, 'provided/revision-transition.json', JSON.stringify(state.transition, null, 2));
  return { artifacts: [artifact], evidence: state.transition };
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
  if (input.operation === 'verify-recovery') return recoveryObservations(workspace, input.requireNewContext === true);
  if (['apply-configuration', 'apply-instructions'].includes(input.operation)) return { version: 1, completed: true, ...await applyChange(workspace, input.operation === 'apply-instructions') };
  if (!['opaque-install', 'revision-install', 'instruction-revision-install', 'single-write-disconnect', 'unsupported-channel'].includes(input.operation)) throw new Error('fixtureOperationUnsupported');
  const { state } = await installLab(workspace, fixtures, input.operation);
  const evidence = { operation: input.operation, installedIdentity: state.pluginId, revision: state.revision, resourceVersion: state.resourceVersion,
    guideRoot: state.guideRoot, publicAwCapabilityDigest: state.capabilitySetDigest };
  if (input.configuration) {
    const active = await readInstalled(state.project, state.guideRoot);
    evidence.resolvedConfiguration = {};
    for (const [key, expected] of Object.entries(input.configuration)) {
      const actual = active.effectiveValues[key];
      if (!actual) throw new Error('fixtureConfigurationMissing');
      const executor = active.effectiveValues.subagentCommands.find((entry) => entry.key === actual.executor);
      if ((expected.executor === 'lab-workspace' && executor?.mode !== 'workspace')
        || (expected.executor === 'lab-bundle' && executor?.mode !== 'bundle')
        || (expected.reasoningEffort && expected.reasoningEffort !== actual.reasoningEffort)
        || (expected.model && !expected.model.startsWith('fixture-') && expected.model !== actual.model)) throw new Error('fixtureConfigurationMismatch');
      evidence.resolvedConfiguration[key] = actual;
    }
  }
  const artifacts = [];
  if (input.operation === 'unsupported-channel') {
    const rejected = await guide(state.project, ['resolve', '--profile', 'generalTaskProfile'], { root: state.guideRoot, env: labEnvironment(workspace), allowFailure: true });
    if (!rejected.exitCode || (rejected.value.code ?? rejected.value.error?.code) !== 'instructionChannelUnsupported') throw new Error('fixtureChannelRejectionMissing');
    evidence.preflight = rejected.value; evidence.adapterExecutions = 0;
  }
  if (input.operation === 'single-write-disconnect') {
    const initial = input.initialRun;
    if (initial?.workerKey !== 'task' || initial.access !== 'workspace-write'
      || initial.allowedWorkspaceChanges?.join(',') !== 'probe/once.txt'
      || initial.operation !== input.task || typeof initial.counterOwner !== 'string') throw new Error('fixtureInitialRunInvalid');
    if (typeof input.task !== 'string' || !input.task.trim() || !Array.isArray(input.materials)) throw new Error('fixtureOriginalTaskMissing');
    for (const relative of input.materials) await file(workspace, relative);
    const fault = true;
    const run = await startOriginal(workspace, state, input.task, input.materials, 'workspace-write', 'generalTaskProfile', 'task');
    evidence.originalRun = run;
    evidence.allowedWorkspaceChanges = initial.allowedWorkspaceChanges; evidence.counterOwner = initial.counterOwner;
    if (fault) {
      const until = Date.now() + 10000;
      let status;
      do {
        status = await guide(workspace, ['status', '--run', run.id, '--runs-dir', state.originalRun.runsDirectory], { root: state.guideRoot, env: labEnvironment(workspace) });
        if (status.value.state !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      } while (Date.now() < until);
      if (status.value.state !== 'unknown') throw new Error('fixtureFaultDidNotProduceUnknown');
      const count = JSON.parse(await readFile(await file(workspace, `${LAB}/counter.json`), 'utf8'));
      evidence.status = status.value; evidence.counter = count;
      artifacts.push('probe/once.txt', `${LAB}/counter.json`);
    }
  }
  artifacts.push(await put(workspace, 'provided/fixture-state.json', JSON.stringify({ ...evidence, project: state.project,
    runsDirectory: state.originalRun?.runsDirectory ?? null, originalRun: state.originalRun ?? null }, null, 2)));
  return { version: 1, completed: true, artifacts, evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  executeFixtureAction(JSON.parse(Buffer.concat(chunks).toString('utf8'))).then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch((error) => { process.stderr.write(JSON.stringify({ version: 1, code: error.message }) + '\n'); process.exitCode = 1; });
}
