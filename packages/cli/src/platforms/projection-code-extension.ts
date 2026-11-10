import YAML from 'yaml';
import { getHookHandlerContract, type PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';
import type { ProjectionInput } from './contracts.js';
import { ProjectionFiles, nativeComponentName } from './projection-files.js';
import { getDeploymentResourceKey } from './layout.js';
import { COMMAND_RESOURCE_SHELL_HELPER, commandResourceExpression } from './projection-command-resources.js';

/** Code adapters use fixed native APIs, never an author-supplied installer. */
export function projectCodeExtension(input: ProjectionInput, files: ProjectionFiles, components: PluginComponent[], metadata: { name: string; version: string }, servers: Record<string, unknown>): void {
  if (input.binding.platform === 'pi') projectPi(input, files, components, metadata, servers);
  else projectOpenCode(input, files, components, metadata, servers);
}

function projectPi(input: ProjectionInput, files: ProjectionFiles, components: PluginComponent[], metadata: { name: string; version: string }, servers: Record<string, unknown>): void {
  const pi: Record<string, unknown> = {};
  if (components.some((component) => component.kind === 'skill')) pi.skills = ['./skills'];
  if (components.some((component) => component.kind === 'agent')) pi.subagents = { agents: ['./agents'] };
  const extensionComponents = components.filter((component) => ['mcp', 'hook', 'instruction'].includes(component.kind));
  if (extensionComponents.length) {
    pi.extensions = ['./index.mjs'];
    const lines = [
      "import { exec } from 'node:child_process';",
      "import { fileURLToPath } from 'node:url';",
      COMMAND_RESOURCE_SHELL_HELPER,
      `const servers = ${JSON.stringify(servers)};`,
    ];
    for (const component of components.filter((entry) => entry.kind === 'mcp' && entry.content.type === 'stdio')) {
      if (component.kind !== 'mcp' || component.content.type !== 'stdio') continue;
      const server = `servers[${JSON.stringify(nativeComponentName(component.name).replace(/-/gu, '_'))}]`;
      lines.push(`${server}.command = ${commandResourceExpression(input, component.id, component.content.command, 'command')};`);
      if (component.content.args) lines.push(`${server}.args = [${component.content.args.map((value, index) => commandResourceExpression(input, component.id, value, 'args', index)).join(', ')}];`);
    }
    lines.push('export default function register(pi) {',
      '  for (const [name, server] of Object.entries(servers)) pi.registerMcpServer(name, server);');
    const instructions = components.filter((component) => component.kind === 'instruction');
    if (instructions.length) {
      if (instructions.some((component) => component.content.paths?.length)) throw new Error('platformProjectionInstructionPathsUnsupported');
      const text = instructions.map((component) => component.content.content).join('\n\n');
      lines.push(`  pi.on('before_agent_start', (event) => {`,
        `    if (typeof event.systemPrompt !== 'string') throw new Error('Unsupported Pi system prompt contract');`,
        `    return { systemPrompt: event.systemPrompt + '\\n\\n' + ${JSON.stringify(text)} };`, '  });');
    }
    for (const hook of components.filter((component) => component.kind === 'hook')) {
      if (hook.content.feedback !== 'notify' || hook.content.matcher) throw new Error('platformProjectionHookFeedbackUnsupported');
      const contract = getHookHandlerContract('pi', hook.content.dialect, hook.content.event);
      const event = contract.nativeEvent;
      if (!event || contract.api !== 'pi.on') throw new Error('platformProjectionHookEventUnsupported');
      lines.push(`  pi.on(${JSON.stringify(event)}, async (event) => {`,
        `    await new Promise((resolve) => {`,
        `      const child = exec(${commandResourceExpression(input, hook.id, hook.content.command, 'command', undefined, true)}, { timeout: 10000, maxBuffer: 65536 }, (error) => { if (error) console.error('AW Hook command failed.'); resolve(); });`,
        `      child.stdin.end(JSON.stringify(event));`, '    });', '  });');
    }
    lines.push('}', '');
    files.add('index.mjs', lines.join('\n'), extensionComponents.map((component) => component.id));
  }
  files.json('package.json', { ...metadata, type: 'module', pi });
}

function projectOpenCode(input: ProjectionInput, files: ProjectionFiles, components: PluginComponent[], metadata: { name: string; version: string }, servers: Record<string, unknown>): void {
  // The published V2 AgentEditor exposes update/remove, but no add operation.
  // Do not claim new independent roles by updating a user-owned role.
  if (components.some((component) => component.kind === 'agent')) throw new Error('platformProjectionAgentRegistrationUnsupported');
  const lines = [
    "import { Plugin } from '@opencode/plugin';",
    "import { fileURLToPath } from 'node:url';",
    "import path from 'node:path';",
    "import { exec } from 'node:child_process';",
    COMMAND_RESOURCE_SHELL_HELPER,
    `export default Plugin.define({ id: ${JSON.stringify(getDeploymentResourceKey(input.binding.plugin))}, async setup(ctx) {`,
    '  const registrations = [];',
  ];
  if (input.renderUnit.renderScope.kind === 'project') {
    lines.push('  const inScope = async (event) => {',
      '    const session = await ctx.session.get({ sessionID: event.sessionID });',
      `    const root = ${JSON.stringify(input.renderUnit.renderScope.projectRoot)};`,
      '    const relative = path.relative(root, session.directory);',
      "    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);", '  };');
  }
  for (const component of components.filter((entry) => entry.kind === 'skill')) {
    const name = nativeComponentName(component.name);
    const skill = files.files.get(`skills/${name}/SKILL.md`)!.bytes.toString('utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(skill)!;
    const frontmatter = YAML.parse(match[1]!) as Record<string, unknown>;
    if (Object.keys(frontmatter).some((field) => !['name', 'description', 'license', 'compatibility', 'metadata'].includes(field))) throw new Error('platformProjectionSkillMetadataUnsupported');
    const definition = { id: name, name, description: frontmatter.description, content: skill.slice(match[0].length) };
    lines.push(`  registrations.push(await ctx.skill.transform((editor) => {`,
      `    if (editor.get(${JSON.stringify(name)})) throw new Error('Native skill name conflict');`,
      `    editor.add({ ...${JSON.stringify(definition)}, path: fileURLToPath(new URL(${JSON.stringify(`./skills/${name}/SKILL.md`)}, import.meta.url)) });`, '  }));');
  }
  for (const [name, server] of Object.entries(servers)) {
    const typed = server as Extract<PluginComponent, { kind: 'mcp' }>['content'];
    const component = components.find((entry) => entry.kind === 'mcp' && nativeComponentName(entry.name) === name)!;
    const config = typed.type === 'stdio'
      ? `{ type: 'local', command: [${[commandResourceExpression(input, component.id, typed.command, 'command'),
        ...(typed.args ?? []).map((value, index) => commandResourceExpression(input, component.id, value, 'args', index))].join(', ')}]${typed.env ? `, environment: ${JSON.stringify(typed.env)}` : ''} }`
      : JSON.stringify({ type: 'remote', url: typed.url, ...(typed.headers ? { headers: typed.headers } : {}) });
    lines.push('  registrations.push(await ctx.mcp.transform((editor) => {',
      `    if (editor.get(${JSON.stringify(name)})) throw new Error('Native MCP name conflict');`,
      `    editor.set(${JSON.stringify(name)}, ${config});`, '  }));');
  }
  const instructions = components.filter((component) => component.kind === 'instruction');
  if (instructions.length) {
    if (instructions.some((component) => component.content.paths?.length)) throw new Error('platformProjectionInstructionScopeUnsupported');
    const text = instructions.map((component) => component.content.content).join('\n\n');
    lines.push("  registrations.push(await ctx.session.hook('context', async (event) => {");
    if (input.renderUnit.renderScope.kind === 'project') {
      lines.push('    if (!await inScope(event)) return;');
    }
    lines.push(`    if (!Array.isArray(event.system)) throw new Error('Unsupported OpenCode context contract');`,
      `    event.system.push({ type: 'text', text: ${JSON.stringify(text)} });`, '  }));');
  }
  for (const hook of components.filter((component) => component.kind === 'hook')) {
    if (hook.content.feedback !== 'notify' || hook.content.matcher) throw new Error('platformProjectionHookFeedbackUnsupported');
    const contract = getHookHandlerContract('opencode', hook.content.dialect, hook.content.event);
    const event = contract.nativeEvent;
    if ((event !== 'before' && event !== 'after') || contract.api !== 'ctx.tool.hook') throw new Error('platformProjectionHookEventUnsupported');
    lines.push(`  registrations.push(await ctx.tool.hook(${JSON.stringify(event)}, async (event) => {`);
    if (input.renderUnit.renderScope.kind === 'project') lines.push('    if (!await inScope(event)) return;');
    lines.push(`    await new Promise((resolve) => {`,
      `      const child = exec(${commandResourceExpression(input, hook.id, hook.content.command, 'command', undefined, true)}, { timeout: 10000, maxBuffer: 65536 }, (error) => { if (error) console.error('AW Hook command failed.'); resolve(); });`,
      `      child.stdin.end(JSON.stringify(event));`, '    });', '  }));');
  }
  lines.push('  return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };', '} });', '');
  files.add('index.mjs', lines.join('\n'), components.map((component) => component.id));
  files.json('package.json', { ...metadata, type: 'module', exports: { '.': './index.mjs' }, dependencies: { '@opencode/plugin': '^2.0.0' } });
}
