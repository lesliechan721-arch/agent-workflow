import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const claudeVersion = '2.1.317';
const claudeArgs = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
  '--verbose', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'user,project,local'];
const claudeRequests = [
  ['aw-init', { subtype: 'initialize' }],
  // Summary calculates locally. Full context usage can issue token-count API requests.
  ['aw-context', { subtype: 'get_context_usage', detail: 'summary' }],
];
const claudeInput = claudeRequests.map(([request_id, request]) =>
  JSON.stringify({ type: 'control_request', request_id, request })).join('\n') + '\n';

async function readClaudeManualSkill(ctx, cwd, visible) {
  const result = await ctx.command(claudeArgs, cwd, { input: claudeInput });
  const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, claudeRequests.length, 'Expected only Claude SDK control responses.');
  const payload = (id) => {
    const replies = messages.filter(item => item.type === 'control_response' && item.response?.request_id === id);
    assert.equal(replies.length, 1, 'Claude SDK control response missing or duplicated.');
    assert.equal(replies[0].response.subtype, 'success', 'Claude SDK control request failed.');
    return replies[0].response.response;
  };
  const initialization = payload('aw-init');
  assert.equal(initialization.claude_code_version, claudeVersion);
  assert(Array.isArray(initialization.commands), 'Claude command inventory missing.');
  const command = `${ctx.pluginName}:${ctx.skillName}`;
  assert.equal(initialization.commands.filter(item => item.name === command).length, visible ? 1 : 0,
    'Unexpected Claude manual command visibility.');
  const context = payload('aw-context');
  assert.equal(context.apiUsage, null, 'Claude SDK probe must have no model usage.');
  const skills = context.skills;
  assert(Array.isArray(skills?.skillFrontmatter) && skills.skillFrontmatter.length > 0,
    'Claude context Skill listing missing or empty.');
  assert.equal(skills.totalSkills, skills.includedSkills, 'Claude context Skill listing was limited.');
  assert.equal(skills.skillFrontmatter.length, skills.includedSkills, 'Claude context Skill listing was incomplete.');
  const names = new Set(skills.skillFrontmatter.map(item => item.name));
  assert(!names.has(command), 'The manual Skill appeared in the model-facing Claude context.');
  const controls = visible ? ctx.publicAutomaticSkillNames ?? [] : [];
  for (const name of controls) {
    assert(names.has(`${ctx.pluginName}:${name}`), 'The automatic sibling was absent from the model-facing Claude context.');
  }
  return { command: `/${command}`, visible, automaticCandidate: false, contextSkills: skills.includedSkills,
    automaticControls: controls };
}

async function readAntigravityComponent(ctx, cwd, expected) {
  const result = await ctx.command(['plugin', 'list', '--json'], cwd);
  const rows = JSON.parse(result.stdout);
  assert(Array.isArray(rows), 'Expected an Antigravity plugin inventory.');
  const matches = rows.filter(row => row.name === ctx.pluginName);
  assert.equal(matches.length, 1, 'Expected one installed Antigravity plugin.');
  const plugin = matches[0];
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.source, 'antigravity');
  const consumerRoot = path.join(ctx.env.HOME, '.gemini', 'config', 'plugins', ctx.pluginName);
  assert.equal(path.normalize(plugin.path), consumerRoot, 'Unexpected Antigravity consumer directory.');
  assert(Array.isArray(plugin.skills), 'Antigravity component inventory missing.');
  assert.equal(plugin.skills.filter(name => name === ctx.skillName).length, 1,
    'The manual Skill was missing or duplicated in Antigravity component inventory.');
  for (const name of ctx.publicAutomaticSkillNames ?? []) {
    assert.equal(plugin.skills.filter(item => item === name).length, 1, 'An automatic sibling was missing or duplicated.');
  }
  const file = path.join(consumerRoot, 'skills', ctx.skillName, 'SKILL.md');
  assert.equal(await fs.realpath(file), file, 'Unexpected Antigravity Skill path.');
  assert((await fs.readFile(file)).equals(expected), 'Antigravity installed Skill bytes differ from the projection.');
  return { version: plugin.version, skills: [...plugin.skills].sort() };
}

async function probeAntigravityPolicyParser(ctx) {
  const root = await fs.mkdtemp(path.join(ctx.root, 'antigravity-skill-policy-'));
  try {
    const manifest = path.join(root, '.antigravity-plugin', 'plugin.json');
    await fs.mkdir(path.dirname(manifest));
    await fs.writeFile(manifest, JSON.stringify({ name: 'aw-policy-parser-probe', version: '1.0.0',
      description: 'Offline qualification of Antigravity Skill policy parsing.' }));
    const writeSkill = async (name, field) => {
      const dir = path.join(root, 'skills', name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Offline policy parser fixture.\n${field}\n---\nInert fixture.\n`);
    };
    const processed = async () => {
      const result = await ctx.command(['plugin', 'validate', root], ctx.project);
      const count = /\bskills\s*:\s*(\d+) processed\b/u.exec(`${result.stdout}\n${result.stderr}`);
      assert(count, 'Antigravity validation did not report a Skill count.');
      return Number(count[1]);
    };
    // A plain unknown key is intentionally accepted. Only the typed key can make
    // validation drop one Skill even though this version returns exit code zero.
    await writeSkill('unknown-field-control', 'aw-unknown-policy: invalid');
    await writeSkill('manual-policy', 'disable-model-invocation: true');
    assert.equal(await processed(), 2, 'Antigravity did not accept the Boolean policy and its control.');
    await writeSkill('manual-policy', 'disable-model-invocation: invalid');
    assert.equal(await processed(), 1, 'Antigravity did not distinguish the Boolean policy from an unknown key.');
    return { booleanAccepted: true, stringRejected: true };
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
}

/** Read the existing isolated public installation. Only inert data goes to the native validator. */
export async function readPublicManualSkill(ctx) {
  if (ctx.platform === 'claude') {
    const target = await readClaudeManualSkill(ctx, ctx.project, true);
    const neutral = await readClaudeManualSkill(ctx, ctx.neutral, ctx.scope === 'user');
    return { level: 'session-command-and-model-context', target, neutral, skillInvoked: false, modelTurns: 0 };
  }
  assert.equal(ctx.platform, 'antigravity');
  assert.equal(ctx.scope, 'user');
  const expected = ctx.publicConsumedSkill ?? await fs.readFile(ctx.publicSkillFile);
  const target = await readAntigravityComponent(ctx, ctx.project, expected);
  const neutral = await readAntigravityComponent(ctx, ctx.neutral, expected);
  assert.deepEqual(neutral, target, 'Antigravity User inventory must match across the isolated directories.');
  const parser = await probeAntigravityPolicyParser(ctx);
  return { level: 'native-component-inventory-and-policy-parser', target, neutral, parser,
    manualCommandVisibility: 'unverified', automaticCandidate: 'unverified', skillInvoked: false, modelTurns: 0 };
}
