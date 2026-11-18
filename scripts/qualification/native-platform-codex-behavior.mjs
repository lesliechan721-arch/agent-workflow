import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertCommand, execute, repoRoot, sha256 } from './native-platform-runtime.mjs';
import { waitForRpcGroupExit } from './native-platform-rpc.mjs';

const fixtureToken = 'aw-native-qualification-fixture-credential';
const controlSkill = 'aw-qualification-implicit-control';
const roles = [
  { plugin: 'agent-subagent', skill: 'spawn-subagent', role: 'subagent' },
  { plugin: 'codex-enhance', skill: 'codex-advisor', role: 'codex-advisor' },
  { plugin: 'codex-enhance', skill: 'codex-explore', role: 'codex-explore' },
];

function responseInput(body, role) {
  return (body.input ?? []).filter(item => item.role === role)
    .flatMap(item => (item.content ?? []).map(part => part.text ?? ''))
    .join('\n').replaceAll('\r\n', '\n');
}

function writeResponse(res, body, sequence, call) {
  const item = call ?? { type: 'message', role: 'assistant', id: `msg_aw_${sequence}`, status: 'completed',
    content: [{ type: 'output_text', text: 'offline fixture complete', annotations: [] }] };
  const response = { id: `resp_aw_${sequence}`, object: 'response', created_at: 1, status: 'completed',
    model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  emit('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  emit('response.output_item.added', { output_index: 0,
    item: { ...item, status: 'in_progress', ...(call ? { arguments: '' } : { content: [] }) } });
  if (!call) emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response });
  res.end();
}

export function assertManualSkillRequests(ordinary, explicit, { name, description, body }) {
  const ordinaryDeveloper = responseInput(ordinary, 'developer');
  assert(ordinaryDeveloper.includes(controlSkill), 'The ordinary turn must supply an implicit Skill inventory.');
  const ordinaryPrompt = `${ordinaryDeveloper}\n${responseInput(ordinary, 'user')}`;
  assert(!ordinaryPrompt.includes(name) && (!description || !ordinaryPrompt.includes(description)),
    'The manual Skill appeared in the ordinary inventory.');
  assert(!ordinaryPrompt.includes(body), 'The manual Skill body appeared in the ordinary prompt.');
  assert(`${responseInput(explicit, 'developer')}\n${responseInput(explicit, 'user')}`.includes(body),
    'The explicit Skill selection must load the projected body into the model input.');
}

export function createRoleScenario(role, sequence) {
  const parentPrompt = `AW_NATIVE_QUALIFICATION_PARENT_${sequence}`;
  const childPrompt = `AW_NATIVE_QUALIFICATION_CHILD_${sequence}`;
  const callId = `call_aw_${sequence}`;
  const taskName = `aw_role_${sequence}`;
  const hasChildInput = body => body.input?.some(item => item.type === 'agent_message' && JSON.stringify(item).includes(childPrompt));
  let advertised = false;
  let parentAccepted = false;
  let childReceived = false;
  let resolveChild;
  const childReady = new Promise(resolve => { resolveChild = resolve; });
  return {
    prompt: parentPrompt,
    matches(body) { return responseInput(body, 'user').includes(parentPrompt) || hasChildInput(body); },
    async respond(body, res, requestSequence) {
      const userInput = responseInput(body, 'user');
      const developerInput = responseInput(body, 'developer');
      if (hasChildInput(body)) {
        assert(advertised && !userInput.includes(parentPrompt), 'The role must execute in an isolated child turn.');
        assert(developerInput.includes(role.instructions), 'The child turn did not receive the installed role instructions.');
        childReceived = true;
        resolveChild();
        writeResponse(res, body, requestSequence);
      } else if (!advertised) {
        assert(!developerInput.includes(role.instructions), 'The parent turn unexpectedly received the role instructions.');
        const namespace = body.tools?.find(tool => tool.type === 'namespace' && tool.name === 'collaboration');
        const spawnTool = namespace?.tools?.find(tool => tool.name === 'spawn_agent');
        assert(spawnTool, 'The host did not provide the V2 native spawn tool.');
        const description = spawnTool?.parameters?.properties?.agent_type?.description;
        assert(description?.split('\n').some(line => line.startsWith(`${role.name}: {`)),
          'The host did not advertise the installed role name in its native spawn tool.');
        advertised = true;
        writeResponse(res, body, requestSequence, {
          type: 'function_call', id: `fc_aw_${sequence}`, call_id: callId, namespace: namespace.name,
          name: 'spawn_agent', status: 'completed', arguments: JSON.stringify({ agent_type: role.name,
            message: childPrompt, fork_turns: 'none', task_name: taskName }),
        });
      } else {
        const output = body.input?.find(item => item.type === 'function_call_output' && item.call_id === callId)?.output;
        assert(typeof output === 'string' && JSON.parse(output)?.task_name === `/root/${taskName}`,
          'The native spawn call did not return its requested child task.');
        parentAccepted = true;
        // The parent can ask for a follow-up before the child has started.
        await childReady;
        if (!res.destroyed) writeResponse(res, body, requestSequence);
      }
    },
    evidence() {
      assert(advertised && parentAccepted && childReceived, 'Codex must start a native child with the advertised role.');
      return { role: role.name, nativeSpawnTool: 'collaboration.spawn_agent', advertisedByHost: true,
        installedInstructionsLoadedInChild: true };
    },
  };
}

async function withLocalResponses(respond, run) {
  let requestCount = 0;
  let failure;
  const server = http.createServer(async (req, res) => {
    try {
      assert(req.method === 'POST' && req.url === '/v1/responses'
        && req.headers.authorization === `Bearer ${fixtureToken}`, 'Unexpected local Responses request.');
      const sequence = ++requestCount;
      assert(sequence <= 20, 'Local Responses request limit exceeded.');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        assert(bytes <= 1024 * 1024, 'Local Responses body limit exceeded.');
        chunks.push(chunk);
      }
      await respond(JSON.parse(Buffer.concat(chunks)), res, sequence);
    } catch (error) {
      failure ??= error;
      res.writeHead(400).end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const result = await run(`http://127.0.0.1:${server.address().port}/v1`).catch(error => { throw failure ?? error; });
    if (failure) throw failure;
    return result;
  } finally {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

export async function withoutCuratedMarketplaceSync(ctx, run) {
  const home = await fs.realpath(ctx.env.CODEX_HOME);
  assert.equal(path.relative(await fs.realpath(ctx.root), home), 'codex',
    'The curated sync fixture must stay inside the qualification Codex home.');
  const scratch = path.join(home, '.tmp');
  await fs.mkdir(scratch, { recursive: true });
  assert.equal(path.relative(home, await fs.realpath(scratch)), '.tmp',
    'The curated sync fixture must stay inside the qualification Codex home.');
  // Codex 0.167.0 opens this file before starting the built-in remote marketplace sync.
  // A directory at this path stops that sync while keeping the local plugin cache enabled.
  const lock = path.join(scratch, 'plugins.sync.lock');
  const backup = await fs.mkdtemp(path.join(scratch, 'aw-responses-fixture-'));
  const saved = path.join(backup, 'original-lock');
  let moved = false;
  let blocked = false;
  try {
    try { await fs.rename(lock, saved); moved = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(lock);
    blocked = true;
    return await run();
  } finally {
    if (blocked) await fs.rmdir(lock);
    if (moved) await fs.rename(saved, lock);
    await fs.rmdir(backup);
  }
}

async function runAppServer(ctx, baseUrl, turns) {
  const settings = {
    model: '"gpt-5.4"', model_provider: '"aw_qualification"', approval_policy: '"never"', sandbox_mode: '"read-only"',
    'model_providers.aw_qualification.name': '"AW Local Qualification"',
    'model_providers.aw_qualification.base_url': JSON.stringify(baseUrl),
    'model_providers.aw_qualification.wire_api': '"responses"',
    'model_providers.aw_qualification.env_key': '"AW_QUALIFICATION_MODEL_KEY"',
    'model_providers.aw_qualification.request_max_retries': '0',
    'model_providers.aw_qualification.stream_max_retries': '0',
    // Shell snapshots start a separate POSIX process group. These turns only exercise Skill and role selection.
    'features.shell_snapshot': 'false',
    'features.multi_agent': 'true', 'features.multi_agent_v2.enabled': 'true',
    'features.multi_agent_v2.hide_spawn_agent_metadata': 'false',
  };
  const args = Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
  const env = { ...ctx.env, AW_QUALIFICATION_MODEL_KEY: fixtureToken, OPENAI_API_KEY: fixtureToken, OPENAI_BASE_URL: baseUrl,
    NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  const rpc = ['initialize', 'thread/start', 'turn/start', 'turn/completed'];
  const result = await execute({ executable: process.execPath, prefix: [fileURLToPath(import.meta.url)] }, [], {
    cwd: ctx.project, env, timeoutMs: 50_000, nativeClient: 'codex',
    stdin: JSON.stringify({ launcher: ctx.launcher, cwd: ctx.project, args, turns }),
  }).catch(error => {
    ctx.recordCommand({ rpc, processFailure: error?.message, processDiagnostics: error?.processTreeDiagnostics ?? [] });
    throw error;
  });
  ctx.recordCommand({ rpc, exitCode: result.exitCode,
    timedOut: result.timedOut, maxBufferExceeded: result.maxBufferExceeded, cancelled: result.cancelled,
    terminationReason: result.terminationReason, stderr: result.stderr,
    processManagement: { mode: result.containmentMode, gradingEvidenceAccepted: result.gradingEvidenceAccepted,
      descendantCleanupGuaranteed: result.descendantCleanupGuaranteed } });
  assertCommand(result);
  assert(!result.cancelled && result.terminationReason === 'complete', 'The Codex behavior app-server did not complete normally.');
  assert.equal(result.gradingEvidenceAccepted, true, 'The Codex behavior app-server must pass the suite process audit.');
}

async function driveAppServer({ launcher, cwd, args, turns }) {
  const child = spawn(launcher.executable, [...launcher.prefix, ...args, 'app-server', '--stdio'], {
    cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close').catch(() => []);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let bytes = 0;
  const count = chunk => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) child.stdout.destroy(new Error('codex-behavior-rpc-output-limit'));
  };
  child.stdout.on('data', count);
  child.stderr.on('data', count);
  child.stdin.on('error', () => child.stdout.destroy(new Error('codex-behavior-rpc-input-failed')));
  const messages = lines[Symbol.asyncIterator]();
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  let id = 0;
  async function readUntil(predicate) {
    while (true) {
      const { value, done } = await messages.next();
      if (done) throw new Error('codex-behavior-rpc-ended-early');
      const message = JSON.parse(value);
      if ((Object.hasOwn(message, 'id') && message.error) || message.method === 'error') {
        throw new Error('codex-behavior-rpc-rejected');
      }
      if (predicate(message)) return message;
    }
  }
  async function rpc(method, params) {
    const requestId = ++id;
    send({ id: requestId, method, params });
    const response = await readUntil(message => message.id === requestId);
    return response.result;
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'aw_native_qualification', version: '1.0.0' },
      capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    for (const { prompt, skill } of turns) {
      const { thread } = await rpc('thread/start', { cwd, ephemeral: true });
      await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt, text_elements: [] },
        ...(skill ? [{ type: 'skill', path: skill.path, name: skill.name }] : [])] });
      const completed = await readUntil(message => message.method === 'turn/completed' && message.params.threadId === thread.id);
      if (completed.params.turn.status !== 'completed') throw new Error('codex-behavior-rpc-turn-failed');
    }
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    const stop = setTimeout(() => child.kill('SIGKILL'), 500);
    await closed;
    clearTimeout(stop);
    lines.close();
  }
}

async function nativeSkill(ctx, list, name) {
  const rows = list.data.filter(row => path.resolve(row.cwd) === path.resolve(ctx.project));
  assert.equal(rows.length, 1, 'The host must return a Skill row for the isolated project.');
  assert.deepEqual(rows[0].errors, []);
  const matches = rows[0].skills.filter(skill => skill.name === name);
  assert.equal(matches.length, 1, `Codex must list the installed Skill ${name}.`);
  const skill = matches[0];
  assert.equal(skill.enabled, true, 'The listed Skill must be enabled.');
  const installedPath = await fs.realpath(skill.path);
  const relative = path.relative(await fs.realpath(ctx.env.CODEX_HOME), installedPath);
  assert(relative && relative !== '..' && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`),
    'The listed Skill must point to this qualification Codex home.');
  return { name, path: installedPath, description: skill.description };
}

function skillBody(text) {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]+)$/u.exec(text.replaceAll('\r\n', '\n'));
  assert(match?.[1].trim(), 'The qualification Skill must have a body.');
  return match[1].trim();
}

export async function qualifyPublicCodexManualSkill(ctx) {
  return ctx.check('public-codex-manual-skill', () => withoutCuratedMarketplaceSync(ctx, async () => {
    const control = path.join(ctx.env.HOME, '.agents/skills', controlSkill);
    await fs.mkdir(control, { recursive: true });
    try {
      await fs.writeFile(path.join(control, 'SKILL.md'),
        `---\nname: ${controlSkill}\ndescription: Implicit Skill inventory control\n---\nThis is an isolated qualification Skill.\n`);
      const name = `${ctx.pluginName}:${ctx.skillName}`;
      const skill = await nativeSkill(ctx, await ctx.rpc(), name);
      const body = skillBody(await fs.readFile(ctx.publicSkillFile, 'utf8'));
      assert.equal(skillBody(await fs.readFile(skill.path, 'utf8')), body, 'The listed file must contain the current fixture body.');
      const ordinary = 'AW_NATIVE_QUALIFICATION_ORDINARY_TURN';
      const explicit = 'AW_NATIVE_QUALIFICATION_EXPLICIT_SKILL_TURN';
      const requests = new Map();
      await withLocalResponses((request, res, sequence) => {
        const prompt = responseInput(request, 'user');
        const kind = [ordinary, explicit].find(value => prompt.includes(value));
        assert(kind && !requests.has(kind), 'The local server must receive one request per manual Skill turn.');
        requests.set(kind, request);
        writeResponse(res, request, sequence);
      }, url => runAppServer(ctx, url, [{ prompt: ordinary }, { prompt: explicit, skill }]));
      assert.equal(requests.size, 2, 'Both manual Skill turns must reach the loopback Responses fixture.');
      assertManualSkillRequests(requests.get(ordinary), requests.get(explicit), { name, description: skill.description, body });
      return { skill: name, listed: true, ordinaryInventoryContainsSkill: false, explicitSelectionLoadedBody: true,
        responsesEndpoint: 'loopback-fixture' };
    } finally { await fs.rm(control, { recursive: true, force: true }); }
  }));
}

async function installedRole(ctx, listed, source, { plugin, skill, role }) {
  const name = `aw-${source}-${plugin}-${role}`;
  const skillFile = await nativeSkill(ctx, listed, `${plugin}:${skill}`);
  const skillText = await fs.readFile(skillFile.path, 'utf8');
  const references = [...skillText.matchAll(/`(aw-[a-z0-9-]+)`/gu)]
    .map(match => match[1]).filter(reference => reference.endsWith(`-${plugin}-${role}`));
  assert.deepEqual([...new Set(references)], [name], 'The materialized Skill must reference its source-qualified role.');
  const require = createRequire(path.join(repoRoot, 'packages/cli/package.json'));
  const { parseTOML } = require('toml-eslint-parser');
  const file = await fs.readFile(path.join(ctx.env.CODEX_HOME, 'agents', `${name}.toml`), 'utf8');
  const entries = parseTOML(file).body[0].body.filter(entry => entry.type === 'TOMLKeyValue' && entry.key.keys.length === 1);
  const entriesByName = new Map(entries.map(entry => [entry.key.keys[0].name, entry.value.value]));
  assert.equal(entriesByName.get('name'), name, 'The installed role TOML must declare the referenced name.');
  const instructions = entriesByName.get('developer_instructions');
  assert(typeof instructions === 'string' && instructions.trim(), 'The installed role must declare developer instructions.');
  return { name: references[0], instructions: instructions.replaceAll('\r\n', '\n').trim() };
}

export async function qualifyPublicCodexBehavior(ctx) {
  const source = 'qualification-official';
  const installed = await ctx.check('public-codex-official-role-materialization', async () => {
    const catalog = path.join(ctx.root, 'official-candidate');
    await fs.cp(path.join(repoRoot, 'packages/cli/plugins-dist'), catalog, { recursive: true });
    const identity = `sha256:${sha256('aw-native-qualification-official-candidate')}`;
    await fs.writeFile(path.join(catalog, '.aw-generated.json'), JSON.stringify({ schemaVersion: 1, kind: 'catalog',
      workspaceIdentity: identity, sourceIdentity: identity }), { flag: 'wx' });
    await ctx.aw(['source', 'add', source, '--path', catalog, '--no-auto-check', '--yes']);
    await ctx.aw(['source', 'sync', source, '--yes']);
    // This public operation installs two renderers and verifies both native deployments.
    await ctx.aw(['plugin', 'install', `${source}/codex-enhance`, '--scope', 'user', '--target', 'codex', '--yes'],
      ctx.project, { timeoutMs: 180_000 });
    return { source, plugins: ['agent-subagent', 'codex-enhance'] };
  });
  return ctx.check('public-codex-official-role-host-resolution', () => withoutCuratedMarketplaceSync(ctx, async () => {
    const listed = await ctx.rpc();
    const projected = await Promise.all(roles.map(role => installedRole(ctx, listed, installed.source, role)));
    const scenarios = projected.map((role, index) => createRoleScenario(role, index + 1));
    await withLocalResponses((request, res, sequence) => {
      const scenario = scenarios.find(item => item.matches(request));
      assert(scenario, 'Unexpected turn reached the role fixture.');
      return scenario.respond(request, res, sequence);
    }, url => runAppServer(ctx, url, scenarios.map(({ prompt }) => ({ prompt }))));
    return { roles: scenarios.map(scenario => scenario.evidence()), responsesEndpoint: 'loopback-fixture' };
  }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const deadline = performance.now() + 48_000;
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 16 * 1024) throw new Error('codex-behavior-rpc-input-limit');
    }
    await driveAppServer(JSON.parse(input));
    if (process.platform !== 'win32') await waitForRpcGroupExit(deadline);
  } catch (error) {
    process.stderr.write(`${/^codex-behavior-rpc-[a-z-]+$/u.test(error?.message) ? error.message : 'codex-behavior-rpc-failed'}\n`);
    process.exitCode = 1;
  }
}
