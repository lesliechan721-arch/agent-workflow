import assert from 'node:assert/strict'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const version = revision => `1.0.${revision}`
const description = revision => `AW qualification revision ${revision}`
const pluginId = ctx => `${ctx.pluginName}@${ctx.marketplaceName}`
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

function fixturePath(ctx, filename) {
  const relative = path.relative(ctx.root, filename)
  assert(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
    'Qualification fixture writes must stay inside the isolated root.')
  return filename
}

async function writeFixture(ctx, filename, content) {
  fixturePath(ctx, filename)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, content, 'utf8')
}

async function jsonCommand(ctx, args, cwd = ctx.project) {
  const result = await ctx.command(args, cwd)
  return JSON.parse(result.stdout)
}

function array(value, label) {
  assert(Array.isArray(value), `${label} must be an array.`)
  return value
}

function one(items, predicate, label) {
  const matches = items.filter(predicate)
  assert.equal(matches.length, 1, `Expected one ${label}; found ${matches.length}.`)
  return matches[0]
}

function samePath(actual, expected, label) {
  assert.equal(typeof actual, 'string', `${label} must be a path.`)
  assert.equal(path.resolve(actual), path.resolve(expected), label)
}

async function codexActivation(ctx) {
  const id = pluginId(ctx)
  const configPath = fixturePath(ctx, path.join(ctx.env.CODEX_HOME, 'config.toml'))
  let config = await readFile(configPath, 'utf8')
  // The native add command writes this public activation entry in the isolated home.
  const section = new RegExp(`(^\\[plugins\\.${escapeRegExp(JSON.stringify(id))}\\]\\r?\\n)enabled = (?:true|false)(?=\\r?$)`, 'mu')
  assert(section.test(config), 'Codex add did not create the expected activation entry.')
  config = config.replace(section, `$1enabled = ${ctx.scope === 'user'}`)
  const trustHeader = `[projects.${JSON.stringify(ctx.project)}]`
  if (!config.includes(trustHeader)) config += `\n${trustHeader}\ntrust_level = "trusted"\n`
  await writeFixture(ctx, configPath, config)
  if (ctx.scope === 'project') {
    await writeFixture(ctx, path.join(ctx.project, '.codex', 'config.toml'),
      `[plugins.${JSON.stringify(id)}]\nenabled = true\n`)
  }
}

async function codexSkills(ctx, cwd) {
  const result = await ctx.rpc(cwd)
  const entry = one(array(result.data, 'Codex skills/list data'),
    item => typeof item.cwd === 'string' && path.resolve(item.cwd) === path.resolve(cwd),
    'Codex skills/list cwd')
  assert.deepEqual(entry.errors, [], 'Codex Skill discovery returned errors.')
  return array(entry.skills, 'Codex skills/list skills').filter(item => item.pluginId === pluginId(ctx))
}

function assertCodexSkill(ctx, skills, revision) {
  const skill = one(skills, item => item.name === `${ctx.pluginName}:${ctx.skillName}`, 'Codex fixture Skill')
  assert.equal(skill.description, description(revision))
  assert.equal(skill.enabled, true)
  return { level: 'skill-discovery', name: skill.name, description: skill.description, enabled: skill.enabled }
}

async function codexInventory(ctx, revision) {
  const list = await jsonCommand(ctx, ['plugin', 'list', '--marketplace', ctx.marketplaceName, '--json'])
  const entry = one(array(list.installed, 'Codex installed plugins'), item => item.pluginId === pluginId(ctx), 'Codex plugin')
  assert.equal(entry.installed, true)
  assert.equal(entry.version, version(revision))
  return { level: 'plugin-inventory', pluginId: entry.pluginId, version: entry.version }
}

async function qualifyCodex(ctx) {
  const id = pluginId(ctx)
  await ctx.check('marketplace-register', async () => {
    const result = await jsonCommand(ctx, ['plugin', 'marketplace', 'add', ctx.marketplace, '--json'])
    assert.equal(result.marketplaceName, ctx.marketplaceName)
    return { level: 'marketplace-inventory', marketplace: result.marketplaceName }
  })
  await ctx.check('install', async () => {
    const result = await jsonCommand(ctx, ['plugin', 'add', id, '--json'])
    assert.equal(result.pluginId, id)
    assert.equal(result.version, version(1))
    await codexActivation(ctx)
    return codexInventory(ctx, 1)
  })
  await ctx.check('skill-discovery', async () => assertCodexSkill(ctx, await codexSkills(ctx, ctx.project), 1))
  await ctx.check('neutral-scope', async () => {
    const skills = await codexSkills(ctx, ctx.neutral)
    if (ctx.scope === 'user') return assertCodexSkill(ctx, skills, 1)
    assert.equal(skills.length, 0, 'A project Codex Skill must not be discovered in neutral cwd.')
    return { level: 'skill-discovery', present: false }
  })
  await ctx.render(2)
  await ctx.check('refresh', async () => {
    const removed = await jsonCommand(ctx, ['plugin', 'remove', id, '--json'])
    assert.equal(removed.pluginId, id)
    const installed = await jsonCommand(ctx, ['plugin', 'add', id, '--json'])
    assert.equal(installed.pluginId, id)
    assert.equal(installed.version, version(2))
    await codexActivation(ctx)
    await codexInventory(ctx, 2)
    return assertCodexSkill(ctx, await codexSkills(ctx, ctx.project), 2)
  })
  await ctx.check('remove', async () => {
    const result = await jsonCommand(ctx, ['plugin', 'remove', id, '--json'])
    assert.equal(result.pluginId, id)
    const list = await jsonCommand(ctx, ['plugin', 'list', '--marketplace', ctx.marketplaceName, '--json'])
    assert(!array(list.installed, 'Codex installed plugins').some(item => item.pluginId === id))
    for (const cwd of [ctx.project, ctx.neutral]) assert.equal((await codexSkills(ctx, cwd)).length, 0)
    return { level: 'skill-discovery', installed: false, present: false }
  })
}

async function piSkills(ctx, cwd) {
  const result = await ctx.rpc(cwd)
  assert.equal(result.state.messageCount, 0, 'Pi RPC must not send a model prompt.')
  assert.equal(result.state.pendingMessageCount, 0)
  assert.equal(result.state.isStreaming, false)
  assert.equal(result.state.isCompacting, false)
  return array(result.commands.commands, 'Pi get_commands commands').filter(item => item.name === `skill:${ctx.skillName}`)
}

function assertPiSkill(ctx, skills, revision) {
  const skill = one(skills, item => item.source === 'skill', 'Pi fixture Skill')
  assert.equal(skill.description, description(revision))
  assert.equal(skill.sourceInfo.scope, ctx.scope)
  assert.equal(skill.sourceInfo.origin, 'package')
  samePath(skill.sourceInfo.baseDir, ctx.bundle, 'Pi package source')
  return { level: 'skill-discovery', name: skill.name, description: skill.description, scope: skill.sourceInfo.scope }
}

async function qualifyPi(ctx) {
  const flags = ctx.scope === 'project' ? ['--local', '--approve'] : []
  await ctx.check('install', async () => {
    await ctx.command(['install', ctx.bundle, ...flags])
    const result = await ctx.command(['list', '--approve'])
    assert(result.stdout.includes(ctx.scope === 'project' ? 'Project packages:' : 'User packages:'))
    assert(result.stdout.includes(ctx.bundle), 'Pi list must include the local fixture source.')
    return { level: 'package-inventory', scope: ctx.scope }
  })
  await ctx.check('skill-discovery', async () => assertPiSkill(ctx, await piSkills(ctx, ctx.project), 1))
  await ctx.check('neutral-scope', async () => {
    const skills = await piSkills(ctx, ctx.neutral)
    if (ctx.scope === 'user') return assertPiSkill(ctx, skills, 1)
    assert.equal(skills.length, 0, 'A project Pi Skill must not be discovered in neutral cwd.')
    return { level: 'skill-discovery', present: false }
  })
  await ctx.render(2)
  await ctx.check('refresh', async () => {
    // An exact source updates a package. Bare `pi update` updates Pi itself.
    await ctx.command(['update', ctx.bundle, '--approve'])
    return assertPiSkill(ctx, await piSkills(ctx, ctx.project), 2)
  })
  await ctx.check('remove', async () => {
    await ctx.command(['remove', ctx.bundle, ...flags])
    const list = await ctx.command(['list', '--approve'])
    assert(!list.stdout.includes(ctx.bundle), 'Pi remove must clear the local package registration.')
    for (const cwd of [ctx.project, ctx.neutral]) assert.equal((await piSkills(ctx, cwd)).length, 0)
    return { level: 'skill-discovery', installed: false, present: false }
  })
}

async function claudeInventory(ctx, cwd, revision, enabled) {
  const items = array(await jsonCommand(ctx, ['plugin', 'list', '--json'], cwd), 'Claude plugins')
  const item = one(items, entry => entry.id === pluginId(ctx), 'Claude fixture plugin')
  assert.equal(item.version, version(revision))
  assert.equal(item.scope, ctx.scope === 'user' ? 'user' : 'local')
  assert.equal(item.enabled, enabled)
  if (ctx.scope === 'project') samePath(item.projectPath, ctx.project, 'Claude local project')
  return { level: 'activation-inventory', id: item.id, version: item.version, scope: item.scope, enabled: item.enabled }
}

async function claudeDetails(ctx, revision) {
  const result = await ctx.command(['plugin', 'details', pluginId(ctx)])
  assert.match(result.stdout, new RegExp(`^${escapeRegExp(ctx.pluginName)} ${escapeRegExp(version(revision))}\\r?$`, 'mu'))
  assert.match(result.stdout, new RegExp(`^\\s*Skills \\(1\\)\\s+${escapeRegExp(ctx.skillName)}\\s*$`, 'mu'))
  return { level: 'component-inventory', skill: ctx.skillName, version: version(revision) }
}

async function qualifyClaude(ctx) {
  const id = pluginId(ctx)
  const scope = ctx.scope === 'user' ? 'user' : 'local'
  await ctx.check('marketplace-register', async () => {
    const result = await jsonCommand(ctx, ['plugin', 'marketplace', 'add', ctx.marketplace, '--json'])
    assert.equal(result.outcome, 'ok')
    assert.equal(result.marketplace, ctx.marketplaceName)
    return { level: 'marketplace-inventory', marketplace: ctx.marketplaceName }
  })
  await ctx.check('install', async () => {
    const result = await jsonCommand(ctx, ['plugin', 'install', id, '--scope', scope, '--json'])
    assert.equal(result.outcome, 'ok')
    assert.equal(result.pluginId, id)
    assert.equal(result.scope, scope)
    return claudeInventory(ctx, ctx.project, 1, true)
  })
  await ctx.check('component-inventory', async () => claudeDetails(ctx, 1))
  await ctx.check('neutral-scope', async () => claudeInventory(ctx, ctx.neutral, 1, ctx.scope === 'user'))
  await ctx.render(2)
  await ctx.check('refresh', async () => {
    await ctx.command(['plugin', 'marketplace', 'update', ctx.marketplaceName])
    const result = await jsonCommand(ctx, ['plugin', 'update', id, '--scope', scope, '--json'])
    assert.equal(result.outcome, 'ok')
    assert.equal(result.updateOutcome, 'updated')
    assert.equal(result.oldVersion, version(1))
    assert.equal(result.newVersion, version(2))
    await claudeInventory(ctx, ctx.project, 2, true)
    return claudeDetails(ctx, 2)
  })
  await ctx.check('remove', async () => {
    const result = await jsonCommand(ctx, ['plugin', 'uninstall', id, '--scope', scope, '--json'])
    assert.equal(result.outcome, 'ok')
    assert.equal(result.pluginId, id)
    for (const cwd of [ctx.project, ctx.neutral]) {
      const list = array(await jsonCommand(ctx, ['plugin', 'list', '--json'], cwd), 'Claude plugins')
      assert(!list.some(item => item.id === id))
    }
    const details = await ctx.command(['plugin', 'details', id], ctx.project, { allowFailure: true })
    assert.notEqual(details.exitCode, 0)
    assert((details.stdout + details.stderr).includes('not found'), 'Claude details must report the removed plugin absent.')
    return { level: 'component-inventory', installed: false, present: false }
  })
}

function output(result) {
  // Gemini writes extension inventory to stderr and Skill discovery to stdout.
  return `${result.stdout}\n${result.stderr}`
}

async function geminiInventory(ctx, cwd, revision) {
  const text = output(await ctx.command(['extensions', 'list'], cwd))
  assert.match(text, new RegExp(`^[✓✗] ${escapeRegExp(ctx.pluginName)} \\(${escapeRegExp(version(revision))}\\)\\r?$`, 'mu'))
  return { level: 'extension-inventory', name: ctx.pluginName, version: version(revision) }
}

async function geminiSkills(ctx, cwd, revision, present) {
  const result = await ctx.command(['skills', 'list'], cwd)
  const skill = new RegExp(`^${escapeRegExp(ctx.skillName)} \\[Enabled\\]\\r?$`, 'mu')
  assert.equal(skill.test(result.stdout), present,
    present ? 'Gemini must discover the enabled fixture Skill.' : 'A project Gemini Skill must not be discovered in neutral cwd.')
  if (present) assert.match(result.stdout, new RegExp(`^\\s*Description: ${escapeRegExp(description(revision))}\\r?$`, 'mu'))
  else assert(!new RegExp(`^${escapeRegExp(ctx.skillName)} \\[`, 'mu').test(result.stdout), 'Gemini must not retain the fixture in Skill discovery.')
  return { level: 'skill-discovery', name: ctx.skillName, present, ...(present ? { description: description(revision) } : {}) }
}

async function qualifyGemini(ctx) {
  await ctx.check('fixture-trust', async () => {
    const home = ctx.env.GEMINI_CLI_HOME
    assert.equal(typeof home, 'string')
    await writeFixture(ctx, path.join(home, '.gemini', 'trustedFolders.json'),
      `${JSON.stringify(Object.fromEntries([ctx.bundle, ctx.project, ctx.neutral].map(directory => [directory, 'TRUST_FOLDER'])), null, 2)}\n`)
    return { level: 'fixture-config', trusted: 'isolated source and working directories' }
  })
  await ctx.check('install', async () => {
    await ctx.command(['extensions', 'install', ctx.bundle, '--consent', '--skip-settings'])
    if (ctx.scope === 'project') {
      await ctx.command(['extensions', 'disable', ctx.pluginName, '--scope', 'User'])
      await ctx.command(['extensions', 'enable', ctx.pluginName, '--scope', 'Workspace'])
    }
    return geminiInventory(ctx, ctx.project, 1)
  })
  if (ctx.scope === 'project') await ctx.check('fixture-project-activation', async () => {
    // User disable covers the home only. The fixed client's native rule makes
    // this extension disabled by default; its later Workspace rule stays intact.
    const filename = fixturePath(ctx, path.join(ctx.env.GEMINI_CLI_HOME, '.gemini', 'extensions', 'extension-enablement.json'))
    const config = JSON.parse(await readFile(filename, 'utf8'))
    assert(config && typeof config === 'object' && !Array.isArray(config), 'Gemini activation config must be an object.')
    const entry = config[ctx.pluginName]
    assert(entry && typeof entry === 'object' && !Array.isArray(entry), 'Gemini did not create the expected activation entry.')
    const overrides = array(entry.overrides, 'Gemini activation overrides')
    assert(overrides.length > 0 && overrides.every(rule => typeof rule === 'string'), 'Gemini activation rules must be nonempty strings.')
    const before = [...overrides]
    assert(!overrides.includes('!*') || overrides[0] === '!*' && overrides.filter(rule => rule === '!*').length === 1,
      'Gemini has an unexpected global activation rule. Check the fixed client configuration.')
    if (overrides[0] !== '!*') overrides.unshift('!*')
    await writeFixture(ctx, filename, `${JSON.stringify(config, null, 2)}\n`)
    return { level: 'fixture-native-extension-enablement', name: ctx.pluginName, before, overrides: [...overrides] }
  })
  await ctx.check('skill-discovery', async () => geminiSkills(ctx, ctx.project, 1, true))
  await ctx.check('neutral-scope', async () => {
    // Keep neutral outside GEMINI_CLI_HOME: 0.67.0 leaked project activation there.
    const relative = path.relative(ctx.env.GEMINI_CLI_HOME, ctx.neutral)
    assert(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
      'Gemini neutral cwd must be outside its effective home to test the known scope leak.')
    await geminiInventory(ctx, ctx.neutral, 1)
    return geminiSkills(ctx, ctx.neutral, 1, ctx.scope === 'user')
  })
  await ctx.render(2)
  await ctx.check('refresh', async () => {
    await ctx.command(['extensions', 'update', ctx.pluginName], ctx.project, { input: 'y\n' })
    await geminiInventory(ctx, ctx.project, 2)
    const discovery = await geminiSkills(ctx, ctx.project, 2, true)
    await geminiInventory(ctx, ctx.neutral, 2)
    await geminiSkills(ctx, ctx.neutral, 2, ctx.scope === 'user')
    return discovery
  })
  await ctx.check('remove', async () => {
    await ctx.command(['extensions', 'uninstall', ctx.pluginName])
    for (const cwd of [ctx.project, ctx.neutral]) {
      const inventory = output(await ctx.command(['extensions', 'list'], cwd))
      assert(!new RegExp(`^[✓✗] ${escapeRegExp(ctx.pluginName)} \\(`, 'mu').test(inventory))
      await geminiSkills(ctx, cwd, 2, false)
    }
    return { level: 'skill-discovery', installed: false, present: false }
  })
}

async function grokInspect(ctx, cwd = ctx.project) {
  const result = await jsonCommand(ctx, ['inspect', '--json'], cwd)
  return {
    plugins: array(result.plugins, 'Grok plugins').filter(item => item.name === ctx.pluginName),
    skills: array(result.skills, 'Grok skills').filter(item => item.name === ctx.skillName && item.source?.plugin_name === ctx.pluginName),
  }
}

function assertGrokSkill(ctx, observation, revision) {
  one(observation.plugins, item => item.scope === ctx.scope, 'Grok fixture plugin')
  const skill = one(observation.skills, item => item.source?.type === 'plugin', 'Grok fixture Skill')
  assert.equal(skill.description, description(revision), 'Grok must discover the new local-source Skill revision.')
  return { level: 'skill-discovery', name: skill.name, description: skill.description, scope: ctx.scope }
}

async function grokInventory(ctx, revision) {
  const list = array(await jsonCommand(ctx, ['plugin', 'list', '--json']), 'Grok plugin list')
  const item = one(list, entry => entry.name === ctx.pluginName, 'Grok installed fixture')
  assert.equal(item.status, 'installed')
  assert.equal(item.version, version(revision))
  samePath(item.source, ctx.bundle, 'Grok local source')
  assert.equal(typeof item.repo_key, 'string', 'Grok must identify the installed repository.')
  assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(item.repo_key), 'Grok must identify one repository directory.')
  samePath(item.path, path.join(ctx.env.GROK_HOME, 'installed-plugins', item.repo_key), 'Grok installed copy')
  for (const relative of ['.grok-plugin/plugin.json', `skills/${ctx.skillName}/SKILL.md`]) {
    assert.equal(await readFile(path.join(item.path, relative), 'utf8'), await readFile(path.join(ctx.bundle, relative), 'utf8'),
      'Grok must install the current source bytes.')
  }
  return { level: 'plugin-inventory', name: item.name, version: item.version }
}

async function qualifyGrok(ctx) {
  if (ctx.scope === 'project') {
    const directory = fixturePath(ctx, path.join(ctx.project, '.grok', 'plugins', ctx.pluginName))
    await ctx.check('project-directory-inventory', async () => {
      await mkdir(path.dirname(directory), { recursive: true })
      await cp(ctx.bundle, directory, { recursive: true, errorOnExist: true, force: false })
      const result = await grokInspect(ctx)
      const plugin = one(result.plugins, item => item.scope === 'project', 'Grok project fixture')
      samePath(plugin.path, directory, 'Grok project plugin path')
      return { level: 'plugin-inventory', scope: plugin.scope, enabled: plugin.enabled, skillPresent: result.skills.length > 0 }
    })
    await ctx.check('neutral-scope', async () => {
      const result = await grokInspect(ctx, ctx.neutral)
      assert.equal(result.plugins.length, 0)
      assert.equal(result.skills.length, 0)
      return { level: 'plugin-inventory', present: false }
    })
    await ctx.check('remove-project-directory', async () => {
      await rm(directory, { recursive: true })
      const result = await grokInspect(ctx)
      assert.equal(result.plugins.length, 0)
      assert.equal(result.skills.length, 0)
      return { level: 'plugin-inventory', installed: false, present: false }
    })
    await ctx.defer('Grok project directory discovery is observed. No verified noninteractive public project enable/trust interface is available; project Skill loading and refresh remain unverified.')
    return
  }
  await ctx.check('install', async () => {
    await ctx.command(['plugin', 'install', ctx.bundle, '--trust'])
    return grokInventory(ctx, 1)
  })
  await ctx.check('skill-discovery', async () => assertGrokSkill(ctx, await grokInspect(ctx), 1))
  await ctx.check('neutral-scope', async () => assertGrokSkill(ctx, await grokInspect(ctx, ctx.neutral), 1))
  await ctx.render(2)
  await ctx.check('refresh', async () => {
    const before = array(await jsonCommand(ctx, ['plugin', 'list', '--json']), 'Grok plugin list')
    const previous = one(before, entry => entry.name === ctx.pluginName, 'Grok installed fixture')
    samePath(previous.source, ctx.bundle, 'Grok replacement source')
    assert(!before.some(item => item !== previous && (item.repo_key === previous.repo_key || item.path === previous.path || item.source === previous.source)),
      'Grok replacement must not uninstall a shared repository.')
    await ctx.command(['plugin', 'uninstall', ctx.pluginName, '--confirm'])
    const removed = array(await jsonCommand(ctx, ['plugin', 'list', '--json']), 'Grok plugin list')
    assert(!removed.some(item => item.name === ctx.pluginName), 'Grok uninstall must clear the old registration before reinstall.')
    await ctx.command(['plugin', 'install', ctx.bundle, '--trust'])
    await grokInventory(ctx, 2)
    const observation = await grokInspect(ctx)
    const skill = assertGrokSkill(ctx, observation, 2)
    assertGrokSkill(ctx, await grokInspect(ctx, ctx.neutral), 2)
    return { ...skill, registryVersion: version(2), strategy: 'native-uninstall-install' }
  })
  await ctx.check('remove', async () => {
    await ctx.command(['plugin', 'uninstall', ctx.pluginName, '--confirm'])
    const list = array(await jsonCommand(ctx, ['plugin', 'list', '--json']), 'Grok plugin list')
    assert(!list.some(item => item.name === ctx.pluginName))
    for (const cwd of [ctx.project, ctx.neutral]) {
      const result = await grokInspect(ctx, cwd)
      assert.equal(result.plugins.length, 0)
      assert.equal(result.skills.length, 0)
    }
    return { level: 'skill-discovery', installed: false, present: false }
  })
}

async function copilotInventory(ctx, cwd, revision, enabled) {
  // Official row contract: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference
  const items = array(await jsonCommand(ctx, ['plugin', 'list', '--json'], cwd), 'Copilot plugins')
  const item = one(items, entry => entry.name === ctx.pluginName && entry.marketplace === ctx.marketplaceName, 'Copilot fixture plugin')
  assert.equal(item.version, version(revision))
  assert.equal(item.enabled, enabled)
  return { level: 'activation-inventory', name: item.name, marketplace: item.marketplace, version: item.version, enabled: item.enabled }
}

async function copilotSkills(ctx, cwd, revision, present) {
  // This public command opens no chat session and sends no prompt.
  const items = array(await jsonCommand(ctx, ['skill', 'list', '--json'], cwd), 'Copilot skills')
  const matches = items.filter(item => item.name === ctx.skillName || item.name === `${ctx.pluginName}/${ctx.skillName}`)
  if (!present) {
    assert(!matches.some(item => item.enabled === true), 'A project Copilot Skill must not be enabled in neutral cwd.')
    return { level: 'skill-discovery', enabled: false, present: matches.length > 0 }
  }
  const skill = one(matches, item => item.enabled === true, 'Copilot enabled fixture Skill')
  assert.equal(skill.description, description(revision))
  assert.equal(typeof skill.path, 'string')
  return { level: 'skill-discovery', name: skill.name, description: skill.description, enabled: skill.enabled }
}

async function qualifyCopilot(ctx) {
  let activationId
  let nativeName
  if (ctx.scope === 'project') await ctx.check('fixture-trust', async () => {
    // Fixed 1.0.95 documents this explicit trust opt-in. These isolated
    // fixtures contain only a Skill; no chat, model or tool request is sent.
    ctx.env.COPILOT_ALLOW_ALL = 'true'
    return { level: 'fixture-environment', interface: 'COPILOT_ALLOW_ALL=true',
      directories: 'isolated project and neutral', sessionRequests: 'none' }
  })
  await ctx.check('marketplace-register', async () => {
    await ctx.command(['plugin', 'marketplace', 'add', ctx.marketplace])
    const items = array(await jsonCommand(ctx, ['plugin', 'marketplace', 'list', '--json']), 'Copilot marketplaces')
    one(items, item => item.name === ctx.marketplaceName, 'Copilot local marketplace')
    return { level: 'marketplace-inventory', marketplace: ctx.marketplaceName }
  })
  await ctx.check('install', async () => {
    await ctx.command(['plugin', 'install', pluginId(ctx)])
    const installed = await copilotInventory(ctx, ctx.project, 1, true)
    nativeName = installed.name
    activationId = `${installed.name}@${installed.marketplace}`
    if (ctx.scope === 'project') {
      // Only public settings are written. Installed-plugin state stays owned by Copilot.
      await ctx.command(['plugin', 'disable', nativeName])
      await writeFixture(ctx, path.join(ctx.project, '.github', 'copilot', 'settings.local.json'),
        `${JSON.stringify({ enabledPlugins: { [activationId]: true } }, null, 2)}\n`)
    }
    return copilotInventory(ctx, ctx.project, 1, true)
  })
  await ctx.check('skill-discovery', async () => copilotSkills(ctx, ctx.project, 1, true))
  await ctx.check('neutral-scope', async () => {
    await copilotInventory(ctx, ctx.neutral, 1, ctx.scope === 'user')
    return copilotSkills(ctx, ctx.neutral, 1, ctx.scope === 'user')
  })
  await ctx.render(2)
  await ctx.check('refresh', async () => {
    // Directory marketplace sources load live. A fresh public command must see new bytes.
    return copilotSkills(ctx, ctx.project, 2, true)
  })
  await ctx.check('remove', async () => {
    if (ctx.scope === 'project') {
      await writeFixture(ctx, path.join(ctx.project, '.github', 'copilot', 'settings.local.json'),
        `${JSON.stringify({ enabledPlugins: { [activationId]: false } }, null, 2)}\n`)
    }
    await ctx.command(['plugin', 'uninstall', nativeName])
    const disabled = await copilotInventory(ctx, ctx.project, 2, false)
    await copilotSkills(ctx, ctx.project, 2, false)
    // A live directory source remains discoverable after uninstall disables it.
    // This marketplace belongs only to this isolated fixture, so remove it too.
    await ctx.command(['plugin', 'marketplace', 'remove', ctx.marketplaceName, '--force'])
    for (const cwd of [ctx.project, ctx.neutral]) {
      const list = array(await jsonCommand(ctx, ['plugin', 'list', '--json'], cwd), 'Copilot plugins')
      assert(!list.some(item => item.name === ctx.pluginName && item.marketplace === ctx.marketplaceName))
      assert.equal((await copilotSkills(ctx, cwd, 2, false)).present, false, 'Copilot must not discover the removed fixture Skill.')
    }
    return { level: 'skill-discovery', nativeUninstall: disabled, marketplaceRemoved: true, installed: false, enabled: false }
  })
}

export async function qualifyClient(ctx) {
  assert(['user', 'project'].includes(ctx.scope), 'Unknown qualification scope.')
  const clients = {
    codex: qualifyCodex,
    pi: qualifyPi,
    claude: qualifyClaude,
    gemini: qualifyGemini,
    grok: qualifyGrok,
    copilot: qualifyCopilot,
  }
  const qualify = clients[ctx.platform]
  if (!qualify) {
    await ctx.defer(`No unauthenticated Native client protocol is defined for ${ctx.platform}.`)
    return
  }
  await qualify(ctx)
}
