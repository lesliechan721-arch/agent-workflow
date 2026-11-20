import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { executePublicAw } from './native-platform-public-process.mjs';
import { assertCommand, execute, fixedClientVersion } from './native-platform-runtime.mjs';

const token = 'aw-local-qualification-fixture';
const control = 'aw-implicit-skill-control';
const ordinaryPrompt = 'AW_NATIVE_QUALIFICATION_ORDINARY_TURN';
const explicitPrompt = 'AW_NATIVE_QUALIFICATION_EXPLICIT_TURN';
const sentinel = 'AW_NATIVE_QUALIFICATION_COMPLETE';
const model = 'gpt-4.1';
const maxBytes = 2 * 1024 * 1024;

function messageContent(request, role) {
  return request.messages.filter(message => role === undefined || message.role === role)
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n').replaceAll('\r\n', '\n');
}

export function assertManualSkillTurns(requests, { platform, name, description, body, modelLookupName = name }) {
  const ordinary = requests.filter(request => messageContent(request, 'user').includes(ordinaryPrompt));
  const explicit = requests.filter(request => messageContent(request, 'user').includes(explicitPrompt));
  const markers = platform === 'copilot' ? ['<available_skills>', '</available_skills>']
    : ['The following skills are available for use:', '</system-reminder>'];
  const inventory = new RegExp(`${markers[0]}([\\s\\S]*?)${markers[1]}`, 'gu');
  const modelInventory = ordinary.find(request => request.model === model && [...messageContent(request).matchAll(inventory)]
    .some(match => match[1].includes(control)));
  assert(modelInventory, 'The ordinary turn must advertise the implicit control Skill.');
  for (const request of ordinary) {
    const definitions = JSON.stringify(request.tools ?? []);
    const input = `${messageContent(request)}\n${definitions}`;
    assert(!input.includes(body) && !input.includes(description), 'The manual Skill leaked into ordinary model input.');
    const automaticInput = messageContent({ messages: request.messages.filter(message => !['assistant', 'tool'].includes(message.role)) });
    assert(!automaticInput.includes(name) && !definitions.includes(name),
      'The host exposed the manual Skill in ordinary input or tool definitions.');
  }
  assert(explicit.some(request => request.model === model && messageContent(request, 'user').includes(body)),
    'The explicit selection must load the installed Skill body.');
  if (platform === 'copilot') {
    assert(ordinary.some(request => messageContent(request, 'tool').includes(`Skill "${modelLookupName}" not found.`)),
      'Copilot must refuse a direct model tool request for the manual Skill.');
  }
}

function writeCompletion(res, sequence, requestedModel, toolCall) {
  const delta = toolCall ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_aw_manual_skill', type: 'function',
    function: { name: 'skill', arguments: JSON.stringify({ skill: toolCall }) } }] } : { role: 'assistant', content: sentinel };
  const chunk = { id: `chatcmpl-aw-${sequence}`, object: 'chat.completion.chunk', created: 1, model: requestedModel };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function withLoopback(ctx, skill, run) {
  const requests = [];
  let failure;
  let attemptedTool = false;
  const server = http.createServer(async (req, res) => {
    try {
      if (ctx.platform === 'grok' && req.method === 'GET' && req.url === '/') {
        // Grok 1.0.77 checks the local endpoint before sending each prompt.
        res.writeHead(200).end();
        return;
      }
      assert(req.method === 'POST' && req.url === '/v1/chat/completions'
        && req.headers.authorization === `Bearer ${token}`, 'Unexpected loopback provider request.');
      assert(requests.length < 12, 'Loopback provider request limit exceeded.');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert(size <= maxBytes, 'Loopback provider request body is too large.');
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks));
      // Grok 1.0.77 sends an auxiliary grok-4.6 request to this same endpoint.
      assert(request.model === model || (ctx.platform === 'grok' && request.model === 'grok-4.6'),
        'Unexpected loopback provider model.');
      assert(Array.isArray(request.messages), 'Expected a chat completion message array.');
      const user = messageContent(request, 'user');
      assert(user.includes(ordinaryPrompt) || user.includes(explicitPrompt), 'Unexpected loopback provider prompt.');
      requests.push(request);
      let toolCall;
      if (ctx.platform === 'copilot' && !attemptedTool && user.includes(ordinaryPrompt)) {
        assert(request.tools?.some(tool => tool.function?.name === 'skill'), 'Copilot must advertise its model Skill tool.');
        attemptedTool = true;
        toolCall = skill.modelLookupName;
      }
      writeCompletion(res, requests.length, request.model, toolCall);
    } catch (error) {
      failure ??= error;
      res.writeHead(400).end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const output = await run(`http://127.0.0.1:${server.address().port}/v1`).catch(error => { throw failure ?? error; });
    if (failure) throw failure;
    return { requests, output };
  } finally {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

async function observeCommand(ctx, launcher, args, env, input) {
  const record = { ...(input ? { rpc: ['initialize', 'session/new', 'session/prompt'] } : { args }),
    cwd: ctx.neutral, nativeClient: ctx.platform };
  const ordinaryObservation = process.platform !== 'win32' && (ctx.platform === 'grok' || process.platform === 'darwin');
  let result;
  try {
    const runner = ordinaryObservation ? executePublicAw : execute;
    result = await runner(launcher, args, { cwd: ctx.neutral, env, nativeClient: ctx.platform,
      timeoutMs: 30_000, ...(input ? { stdin: JSON.stringify(input) } : {}) });
  } catch (error) {
    ctx.recordCommand({ ...record, failed: true,
      processDiagnostics: error?.publicAwProcessDiagnostics ?? error?.processTreeDiagnostics ?? [] });
    throw error;
  }
  ctx.recordCommand({ ...record, exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled,
    maxBufferExceeded: result.maxBufferExceeded, terminationReason: result.terminationReason,
    ...(result.exitCode !== 0 && input ? { rpcFailure: result.stderr.split('\n').find(line => line.includes('Error [ERR_ASSERTION]')) } : {}),
    processManagement: { mode: result.containmentMode, gradingEvidenceAccepted: result.gradingEvidenceAccepted,
      descendantCleanupGuaranteed: result.descendantCleanupGuaranteed } });
  assertCommand(result);
  assert(!result.cancelled && result.terminationReason === 'complete', 'The manual Skill probe requires complete process evidence.');
  assert.equal(result.gradingEvidenceAccepted, !ordinaryObservation);
  if (ordinaryObservation) assert.equal(result.containmentMode, 'observed');
  return result.stdout;
}

async function withinRoot(root, file) {
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(file);
  const relative = path.relative(realRoot, realFile);
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'The native Skill path must stay inside the isolated qualification root.');
  return realFile;
}

async function installedSkill(ctx) {
  if (ctx.platform === 'copilot') {
    const result = await ctx.command(['skill', 'list', '--json'], ctx.neutral);
    const items = JSON.parse(result.stdout);
    const row = items.filter(skill => skill.enabled && skill.source === 'plugin'
      && [ctx.skillName, `${ctx.pluginName}/${ctx.skillName}`].includes(skill.name));
    assert.equal(row.length, 1, 'Copilot must discover exactly one enabled plugin Skill.');
    return { name: row[0].name, description: row[0].description, modelLookupName: `${ctx.pluginName}:${ctx.skillName}`,
      file: await withinRoot(ctx.root, path.join(row[0].path, 'SKILL.md')) };
  }
  const result = await ctx.command(['inspect', '--json'], ctx.neutral);
  const inventory = JSON.parse(result.stdout);
  assert.equal(inventory.grokVersion, fixedClientVersion('grok'));
  const plugins = inventory.plugins.filter(plugin => plugin.name === ctx.pluginName && plugin.scope === 'user' && plugin.enabled);
  const skills = inventory.skills.filter(skill => skill.name === ctx.skillName && skill.source?.type === 'plugin'
    && skill.source.plugin_name === ctx.pluginName);
  assert.equal(plugins.length, 1, 'Grok must report one enabled User plugin.');
  assert.equal(skills.length, 1, 'Grok must discover exactly one installed plugin Skill.');
  assert.equal(skills[0].userInvocable, true, 'Grok must parse the installed Skill as user invocable.');
  const file = await withinRoot(path.join(ctx.env.GROK_HOME, 'installed-plugins'), skills[0].source.path);
  assert.equal(file, await fs.realpath(path.join(plugins[0].path, 'skills', ctx.skillName, 'SKILL.md')));
  return { name: skills[0].name, description: skills[0].description, file };
}

async function grokTurns(ctx, env, baseUrl, skill) {
  const config = path.join(ctx.env.GROK_HOME, 'config.toml');
  const original = await fs.readFile(config).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await fs.writeFile(config, `${original ?? ''}\n[model.aw-local-qualification]\nmodel = ${JSON.stringify(model)}\n`
    + `base_url = ${JSON.stringify(baseUrl)}\nenv_key = "AW_QUALIFICATION_MODEL_KEY"\n`
    + 'api_backend = "chat_completions"\nsupports_backend_search = false\n');
  const settings = { ...env, AW_QUALIFICATION_MODEL_KEY: token, GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: 'false' };
  const args = ['--model', 'aw-local-qualification', '--disable-web-search', '--no-subagents', '--no-plan', '--max-turns', '1'];
  try {
    for (const prompt of [ordinaryPrompt, `/${skill.name} ${explicitPrompt}`]) {
      const output = await observeCommand(ctx, ctx.launcher, [...args, '-p', prompt], settings);
      assert(output.includes(sentinel), 'Grok must complete the loopback fixture turn.');
    }
  } finally {
    if (original) await fs.writeFile(config, original);
    else await fs.rm(config, { force: true });
  }
  return { slashCommand: skill.name };
}

async function copilotTurns(ctx, env, baseUrl, skill) {
  // ACP in the pinned offline/BYOK fixture does not load marketplace Skills automatically.
  const pluginDirectory = path.dirname(path.dirname(path.dirname(skill.file)));
  const args = ['--acp', '--stdio', '--disable-builtin-mcps', '--available-tools=skill', '--plugin-dir', pluginDirectory];
  const settings = { ...env, COPILOT_MODEL: model, COPILOT_PROVIDER_BASE_URL: baseUrl,
    COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: token, COPILOT_PROVIDER_WIRE_API: 'completions' };
  const output = await observeCommand(ctx, { executable: process.execPath, prefix: [fileURLToPath(import.meta.url)] }, [], settings,
    { launcher: ctx.launcher, cwd: ctx.neutral, args, names: [skill.name, `${ctx.pluginName}/${ctx.skillName}`, `${ctx.pluginName}:${ctx.skillName}`],
      description: skill.description, version: fixedClientVersion('copilot') });
  return JSON.parse(output);
}

export async function readPublicManualSkill(ctx) {
  assert.equal(ctx.scope, 'user');
  assert(['copilot', 'grok'].includes(ctx.platform));
  assert.equal(ctx.env.COPILOT_OFFLINE, 'true');
  const home = ctx.env[ctx.platform === 'copilot' ? 'COPILOT_HOME' : 'GROK_HOME'];
  await withinRoot(ctx.root, home);
  const skill = await installedSkill(ctx);
  const installed = await fs.readFile(skill.file);
  assert.deepEqual(installed, ctx.publicConsumedSkill, 'The native Skill must contain the projected consumer bytes.');
  const frontmatter = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/u.exec(installed.toString('utf8').replaceAll('\r\n', '\n'));
  assert(frontmatter?.[2].trim() && skill.description, 'The installed Skill must contain frontmatter and a body.');
  assert.match(frontmatter[1], /^user-invocable: true$/mu);
  assert.match(frontmatter[1], /^disable-model-invocation: true$/mu);
  const directory = path.join(home, 'skills', control);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory);
  try {
    await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${control}\ndescription: Implicit Skill inventory control\n`
      + 'user-invocable: true\ndisable-model-invocation: false\n---\nIsolated qualification fixture.\n');
    const env = { ...ctx.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
    const { requests, output } = await withLoopback(ctx, skill, baseUrl => ctx.platform === 'copilot'
      ? copilotTurns(ctx, env, baseUrl, skill) : grokTurns(ctx, env, baseUrl, skill));
    assertManualSkillTurns(requests, { ...skill, platform: ctx.platform, body: frontmatter[2].trim() });
    return { level: 'loopback-session-behavior', scope: ctx.scope, slashCommand: `/${output.slashCommand}`,
      explicitSelectionLoadedInstalledBody: true, ordinaryModelInventoryOmittedSkill: true, ordinaryInventoryControlPresent: true,
      ...(ctx.platform === 'copilot' ? { directModelSkillToolDenied: true,
        sessionPluginLoading: 'explicit-native-plugin-dir-from-marketplace-inventory', ambientOfflineAcpActivation: 'unverified' }
        : { sessionPluginLoading: 'installed-user-plugin', directModelSkillTool: 'unverified' }),
      provider: 'loopback-fixture', desktopAndProjectScope: 'unverified' };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function driveCopilot({ launcher, cwd, args, names, description, version }) {
  const child = spawn(launcher.executable, [...launcher.prefix, ...args], {
    cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = lines[Symbol.asyncIterator]();
  let bytes = 0;
  const count = chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) child.stdout.destroy(new Error('copilot-acp-output-limit'));
  };
  child.stdout.on('data', count);
  child.stderr.on('data', count);
  child.stdin.on('error', () => child.stdout.destroy(new Error('copilot-acp-input-failed')));
  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const commands = new Map();
  let id = 0;
  async function rpc(method, params) {
    const current = ++id;
    send({ id: current, method, params });
    for (;;) {
      const { value, done } = await messages.next();
      assert(!done, 'Copilot ended its ACP session early.');
      const message = JSON.parse(value);
      if (message.method === 'session/update' && message.params?.update?.sessionUpdate === 'available_commands_update') {
        commands.set(message.params.sessionId, message.params.update.availableCommands);
      }
      if (message.method && Object.hasOwn(message, 'id')) {
        // No filesystem or tool action is authorized through ACP.
        send({ id: message.id, error: { code: -32601, message: 'Unsupported by fixture' } });
      } else if (message.id === current) {
        assert(!message.error, `Copilot rejected the ${method} request.`);
        return message.result;
      }
    }
  }
  try {
    const identity = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} });
    assert.equal(identity.agentInfo?.version, version);
    const ordinary = await rpc('session/new', { cwd, mcpServers: [] });
    const ordinaryResult = await rpc('session/prompt', { sessionId: ordinary.sessionId,
      prompt: [{ type: 'text', text: ordinaryPrompt }] });
    assert.equal(ordinaryResult.stopReason, 'end_turn');
    const explicit = await rpc('session/new', { cwd, mcpServers: [] });
    const available = commands.get(explicit.sessionId) ?? commands.get(ordinary.sessionId) ?? [];
    assert(available.some(command => command.name === control), 'Copilot must advertise the explicit control command.');
    const command = available.find(candidate => names.includes(candidate.name) && candidate.description === description);
    assert(command, 'Copilot must advertise the installed manual Skill command.');
    const explicitResult = await rpc('session/prompt', { sessionId: explicit.sessionId,
      prompt: [{ type: 'text', text: `/${command.name} ${explicitPrompt}` }] });
    assert.equal(explicitResult.stopReason, 'end_turn');
    process.stdout.write(JSON.stringify({ slashCommand: command.name }));
  } finally {
    child.stdin.end();
    try { assert.deepEqual(await closed, [0, null], 'Copilot ACP must exit cleanly after EOF.'); }
    finally { lines.close(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = [];
  for await (const chunk of process.stdin) input.push(chunk);
  await driveCopilot(JSON.parse(Buffer.concat(input)));
}
