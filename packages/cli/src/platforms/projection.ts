import path from 'node:path';
import fs from 'fs-extra';
import YAML from 'yaml';
import {
  assertPlatformCapabilities, assertPluginComponent, getComponentFeatureRequirements, getUnmetFeatureRequirements,
  validatePortableSkillName,
  getHookHandlerContract,
  renderHookDefinitionGroup,
  type AgentContent, type PluginComponent,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { DeploymentBinding, HostContribution, ProjectionInput, ProjectionResult, StageContext } from './contracts.js';
import { getDeploymentLayout, getDeploymentResourceKey, getNativePackageName } from './layout.js';
import { ProjectionFiles, nativeComponentName, prepareProjectionRoot, resourceBytes, safeProjectionPath } from './projection-files.js';
import { projectCodeExtension } from './projection-code-extension.js';
import { bindPlatformCommandResources } from './projection-command-resources.js';
import { generateCodexPermissionArtifacts, mergeClaudePermissions } from '../generators/permissions.js';
import { supplementRelativePath } from './supplement-layout.js';

type Agent = Extract<PluginComponent, { kind: 'agent' }>;
type Instruction = Extract<PluginComponent, { kind: 'instruction' }>;
type Hook = Extract<PluginComponent, { kind: 'hook' }>;
type Mcp = Extract<PluginComponent, { kind: 'mcp' }>;

function quoteHostArgument(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    if (/[%!"\r\n]/u.test(value)) throw new Error('platformProjectionShellArgumentUnsupported');
    return `"${value}"`;
  }
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

export function cursorWorkspaceOpenCommand(binding: DeploymentBinding, platform: NodeJS.Platform = process.platform): string {
  const scope = binding.scope;
  const quote = (value: string): string => quoteHostArgument(value, platform);
  return `aw internal cursor-workspace-open --scope ${scope.kind}${scope.kind === 'project' ? ` --project-root ${quote(scope.projectRoot)}` : ''} --plugin-id ${quote(binding.plugin.pluginId)}`;
}

function markdown(metadata: Record<string, unknown>, body: string): string {
  return `---\n${Object.entries(metadata).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body}\n`;
}

function nameFor(input: ProjectionInput, component: PluginComponent): string {
  const name = nativeComponentName(component.name);
  if (input.binding.platform === 'pi' && component.kind === 'mcp') return name.replace(/-/gu, '_');
  return (input.binding.platform === 'pi' && component.kind === 'agent') || (input.binding.platform === 'generic' && component.kind === 'skill')
    ? `${getDeploymentResourceKey(input.binding.plugin)}-${name}` : name;
}

function composedAgentPrompt(agent: Agent, instructions: Instruction[]): string {
  const context = instructions.filter((instruction) => instruction.content.coverage.includes('plugin-agents'));
  // Path rules require a runtime match. Embedding them as unconditional text
  // would silently widen their effect in an Agent definition.
  if (context.some((instruction) => instruction.content.paths?.length)) throw new Error('platformProjectionConditionalAgentInstructionUnsupported');
  return [agent.content.prompt, ...context.map((instruction) => instruction.content.content)].join('\n\n');
}

function agentMarkdown(input: ProjectionInput, agent: Agent, instructions: Instruction[]): string {
  const platform = input.binding.platform;
  const content: AgentContent = agent.content;
  if (content.promptMode && content.promptMode !== 'host-default') throw new Error('platformProjectionPromptModeUnsupported');
  const metadata: Record<string, unknown> = { name: nameFor(input, agent), description: content.description,
    model: content.model, tools: content.tools };
  if (platform === 'antigravity') metadata.inheritCustomizations = true;
  const prompt = ['gemini', 'copilot', 'grok'].includes(platform) ? composedAgentPrompt(agent, instructions) : content.prompt;
  return markdown(metadata, prompt);
}

function projectSkills(input: ProjectionInput, files: ProjectionFiles, components: PluginComponent[]): void {
  for (const component of components) {
    if (component.kind !== 'skill') continue;
    const name = nameFor(input, component);
    validatePortableSkillName(name, 'projected Skill name');
    const root = input.renderUnit.output === 'generic' ? name : `skills/${name}`;
    const skillFiles = new Map(Object.entries(component.content.files).map(([relative, resource]) => [relative, resourceBytes(input, component.id, relative, resource)]));
    const skillFile = skillFiles.get('SKILL.md')!;
    const original = skillFile.bytes.toString('utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(original)!;
    const metadata = YAML.parse(match[1]!) as Record<string, unknown>;
    let changed = metadata.name !== name;
    metadata.name = name;
    if (input.binding.platform === 'codex') {
      if (Object.keys(metadata).some((field) => !['name', 'description', 'license', 'compatibility', 'metadata', 'user-invocable', 'disable-model-invocation'].includes(field))) throw new Error('platformProjectionSkillMetadataUnsupported');
      const invocation = getComponentFeatureRequirements({ ...component, requires: [] }, { skillText: original });
      if (Object.hasOwn(metadata, 'user-invocable')) {
        if (!invocation.find((requirement) => requirement.feature === 'skill.invocation.manual')?.values?.includes('true')) throw new Error('platformProjectionSkillVisibilityUnsupported');
        delete metadata['user-invocable'];
        changed = true;
      }
      if (Object.hasOwn(metadata, 'disable-model-invocation')) {
        const implicit = invocation.find((requirement) => requirement.feature === 'skill.invocation.model')?.values?.includes('true') ?? false;
        const yamlFile = skillFiles.get('agents/openai.yaml');
        const definition = yamlFile ? YAML.parse(yamlFile.bytes.toString('utf8')) as Record<string, unknown> : {};
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('platformProjectionSkillPolicyInvalid');
        const policy = (definition.policy ?? {}) as Record<string, unknown>;
        if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('platformProjectionSkillPolicyInvalid');
        if (Object.hasOwn(policy, 'allow_implicit_invocation') && policy.allow_implicit_invocation !== implicit) throw new Error('platformProjectionSkillPolicyConflict');
        definition.policy = { ...policy, allow_implicit_invocation: implicit };
        skillFiles.set('agents/openai.yaml', { bytes: Buffer.from(YAML.stringify(definition)), mode: 0o644 });
        delete metadata['disable-model-invocation'];
        changed = true;
      }
    }
    if (changed) skillFiles.set('SKILL.md', { ...skillFile, bytes: Buffer.from(`---\n${YAML.stringify(metadata)}---\n${original.slice(match[0].length)}`) });
    for (const [relative, file] of [...skillFiles].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      files.add(`${root}/${relative}`, file.bytes, [component.id], file.mode);
    }
    // The public preparation pipeline can add verified runtime files after
    // parsing the component, before the native package is frozen.
    for (const file of input.resources.files.filter((entry) => entry.componentId === component.id)) {
      safeProjectionPath(file.path);
      if (skillFiles.has(file.path)) continue;
      files.add(`${root}/${file.path}`, file.bytes, [component.id], file.mode);
    }
  }
}

function commonHookEvent(platform: ProjectionInput['binding']['platform'], hook: Hook): string {
  const contract = getHookHandlerContract(platform, hook.content.dialect, hook.content.event);
  if (!contract.nativeEvent || contract.api !== 'command') throw new Error('platformProjectionHookEventUnsupported');
  if (hook.content.matcher && contract.matcherAllowed !== true) throw new Error('platformProjectionHookMatcherUnsupported');
  if (hook.content.feedback !== 'notify' && !contract.protocol?.responses[hook.content.feedback]) throw new Error('platformProjectionHookFeedbackUnsupported');
  return contract.nativeEvent;
}

function projectHooks(input: ProjectionInput, files: ProjectionFiles, hooks: Hook[], instructions: Instruction[]): void {
  const platform = input.binding.platform;
  if (platform === 'antigravity') {
    if (!hooks.length) return;
    const groups = Object.fromEntries(hooks.map((hook) => {
      const event = commonHookEvent(platform, hook);
      const command = { type: 'command', command: hook.content.command };
      const handlers = ['PreToolUse', 'PostToolUse'].includes(event)
        ? [{ matcher: hook.content.matcher ?? '.*', hooks: [command] }]
        : [command];
      if (hook.content.matcher && !['PreToolUse', 'PostToolUse'].includes(event)) throw new Error('platformProjectionHookMatcherUnsupported');
      return [nameFor(input, hook), { enabled: true, [event]: handlers }];
    }));
    files.json('hooks.json', groups, hooks.map((hook) => hook.id));
    return;
  }
  const eventMap: Record<string, Array<Record<string, unknown>>> = {};
  const add = (event: string, handler: Record<string, unknown>): void => { (eventMap[event] ??= []).push(handler); };
  for (const hook of hooks) {
    const event = commonHookEvent(platform, hook);
    if (platform === 'codex' || platform === 'claude') {
      const { event: mappedEvent, ...handler } = renderHookDefinitionGroup(hook.content.dialect === 'common'
        ? { kind: 'public', event: hook.content.event, matcher: hook.content.matcher, command: hook.content.command }
        : { kind: 'native', event: hook.content.event, matcher: hook.content.matcher, command: hook.content.command }, platform);
      add(mappedEvent, handler);
    } else if (platform === 'copilot') {
      add(event, { type: 'command', bash: hook.content.command, powershell: hook.content.command });
    } else if (platform === 'cursor') {
      add(event, { command: hook.content.command, ...(hook.content.matcher ? { matcher: hook.content.matcher } : {}) });
    } else {
      add(event, { ...(hook.content.matcher ? { matcher: hook.content.matcher } : {}), hooks: [{ type: 'command', command: hook.content.command }] });
    }
  }
  const ids = hooks.map((hook) => hook.id);
  if (['codex', 'claude'].includes(platform) && instructions.length) {
    for (const instruction of instructions) if (instruction.content.paths?.length) throw new Error('platformProjectionInstructionPathsUnsupported');
    const rootVariable = platform === 'codex' ? '${CODEX_PLUGIN_ROOT}' : '${CLAUDE_PLUGIN_ROOT}';
    const contexts: Record<string, string> = {};
    const main = instructions.filter((instruction) => instruction.content.coverage.includes('main'));
    const children = instructions.filter((instruction) => instruction.content.coverage.some((audience) => audience !== 'main'));
    for (const [event, selected] of [['SessionStart', main], ['SubagentStart', children]] as const) {
      if (!selected.length) continue;
      const text = selected.map((instruction) => instruction.content.content).join('\n\n');
      const maxBytes = input.capabilities.features['instruction.coverage']?.maxBytes;
      if (maxBytes !== undefined && Buffer.byteLength(text) > maxBytes) throw new Error('platformProjectionInstructionTooLarge');
      contexts[event] = text;
      add(event, { hooks: [{ type: 'command', command: `node "${rootVariable}/scripts/aw-instructions.mjs" ${event}` }] });
    }
    files.add('scripts/aw-instructions.mjs', `const contexts = ${JSON.stringify(contexts)};\nconst event = process.argv[2];\nif (!Object.hasOwn(contexts, event)) throw new Error('Unsupported instruction event');\nprocess.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:contexts[event]}}));\n`, instructions.map((instruction) => instruction.id));
    ids.push(...instructions.map((instruction) => instruction.id));
  }
  if (!Object.keys(eventMap).length) return;
  const relative = platform === 'copilot' ? 'com.github.copilot/hooks/hooks.json' : 'hooks/hooks.json';
  files.json(relative, { ...(platform === 'cursor' || platform === 'copilot' ? { version: 1 } : {}), hooks: eventMap }, ids);
}

function projectRules(input: ProjectionInput, files: ProjectionFiles, instructions: Instruction[]): void {
  const platform = input.binding.platform;
  if (platform === 'codex' || platform === 'claude' || platform === 'grok') return;
  if (platform === 'gemini') {
    if (instructions.some((instruction) => instruction.content.paths?.length)) throw new Error('platformProjectionInstructionPathsUnsupported');
    const main = instructions.filter((instruction) => instruction.content.coverage.includes('main'));
    if (main.length) files.add('AW_CONTEXT.md', main.map((instruction) => instruction.content.content).join('\n\n'), main.map((instruction) => instruction.id));
    return;
  }
  for (const instruction of instructions) {
    const name = nameFor(input, instruction);
    if (platform === 'cursor') {
      files.add(`rules/${name}.mdc`, markdown({ description: instruction.content.title,
        ...(instruction.content.paths?.length ? { globs: instruction.content.paths, alwaysApply: false } : { alwaysApply: true }) }, instruction.content.content), [instruction.id]);
    } else if (platform === 'antigravity') {
      if (instruction.content.paths?.length) files.add(`rules/${name}.md`, markdown({ trigger: 'glob', globs: instruction.content.paths.join(', ') }, instruction.content.content), [instruction.id]);
    } else if (platform === 'copilot') {
      if (instruction.content.paths?.length) throw new Error('platformProjectionInstructionPathsUnsupported');
      files.add(`com.github.copilot/rules/${name}.md`, instruction.content.content, [instruction.id]);
    }
  }
  const alwaysOn = instructions.filter((instruction) => !instruction.content.paths?.length);
  if (platform === 'antigravity' && alwaysOn.length) files.add('rules/AGENTS.md', alwaysOn.map((instruction) => instruction.content.content).join('\n\n'), alwaysOn.map((instruction) => instruction.id));
}

function projectMcp(input: ProjectionInput, files: ProjectionFiles, mcps: Mcp[]): Record<string, unknown> {
  const platform = input.binding.platform;
  const servers = Object.fromEntries(mcps.map((component) => {
    const content = component.content;
    if ((platform === 'antigravity' || platform === 'pi') && content.type === 'sse') throw new Error('platformProjectionMcpTransportUnsupported');
    let server: unknown = structuredClone(content);
    if (platform === 'gemini' || platform === 'antigravity') {
      server = content.type === 'stdio'
        ? { command: content.command, ...(content.args ? { args: [...content.args] } : {}), ...(content.env ? { env: { ...content.env } } : {}) }
        : { [platform === 'antigravity' ? 'serverUrl' : content.type === 'http' ? 'httpUrl' : 'url']: content.url,
          ...(content.headers ? { headers: { ...content.headers } } : {}) };
    }
    return [nameFor(input, component), server];
  }));
  if (!mcps.length || ['pi', 'opencode', 'gemini'].includes(platform)) return servers;
  const relative = platform === 'cursor' || platform === 'copilot' ? 'mcp.json'
    : platform === 'antigravity' ? 'mcp_config.json' : '.mcp.json';
  files.json(relative, { mcpServers: servers }, mcps.map((component) => component.id));
  return servers;
}

function projectManifest(input: ProjectionInput, files: ProjectionFiles, selected: PluginComponent[], servers: Record<string, unknown>): void {
  const platform = input.binding.platform;
  const metadata = { name: getNativePackageName(input.binding.plugin), version: input.binding.plugin.version };
  if (platform === 'generic') return;
  if (platform === 'pi' || platform === 'opencode') {
    projectCodeExtension(input, files, selected, metadata, servers);
    return;
  }
  const has = (kind: PluginComponent['kind']): boolean => selected.some((component) => component.kind === kind);
  if (platform === 'gemini') {
    files.json('gemini-extension.json', { ...metadata, ...(has('mcp') ? { mcpServers: servers } : {}),
      ...(files.files.has('AW_CONTEXT.md') ? { contextFileName: 'AW_CONTEXT.md' } : {}) });
    return;
  }
  if (platform === 'copilot') {
    files.json('plugin.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', ...metadata });
    return;
  }
  if (platform === 'antigravity') {
    files.json('.antigravity-plugin/plugin.json', { $schema: 'https://antigravity.google/schemas/v1/plugin.json', ...metadata });
    return;
  }
  const manifest: Record<string, unknown> = { ...metadata };
  if (has('skill')) manifest.skills = './skills/';
  if (has('agent')) manifest.agents = './agents/';
  if (has('mcp')) manifest.mcpServers = platform === 'cursor' ? './mcp.json' : './.mcp.json';
  if (files.files.has('hooks/hooks.json')) manifest.hooks = './hooks/hooks.json';
  if (has('instruction') && platform === 'cursor') manifest.rules = './rules/';
  files.json(`.${platform}-plugin/plugin.json`, manifest);
}

/** The writer and read-only static inspection use the same host file format. */
export function projectSupplementFile(binding: DeploymentBinding, component: PluginComponent): { relativePath: string; content: string } {
  const relativePath = supplementRelativePath(binding, component);
  const name = path.basename(relativePath, path.extname(relativePath));
  if (binding.platform === 'codex' && component.kind === 'agent') {
    if (component.content.tools !== undefined || (component.content.promptMode && component.content.promptMode !== 'host-default')) throw new Error('platformProjectionAgentFieldsUnsupported');
    const values = { name, description: component.content.description, developer_instructions: component.content.prompt, model: component.content.model };
    return { relativePath, content: Object.entries(values).filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\n' };
  }
  if (binding.platform === 'grok' && component.kind === 'instruction') {
    if (component.content.paths?.length) throw new Error('platformProjectionInstructionPathsUnsupported');
    return { relativePath, content: component.content.content };
  }
  throw new Error('platformProjectionSupplementKindUnsupported');
}

async function supplementContributions(ctx: StageContext, input: ProjectionInput, files: ProjectionFiles, selected: PluginComponent[]): Promise<HostContribution[]> {
  const layout = await getDeploymentLayout(ctx, input.binding);
  if (input.renderUnit.output === 'generic') return selected.map((component) => {
    if (component.kind !== 'skill') throw new Error('platformProjectionGenericKindUnsupported');
    const name = nameFor(input, component);
    return { id: component.id, componentIds: [component.id], kind: 'owned-directory',
      destination: path.join(layout.packageRoot, name),
      contentDigest: files.digest(name), stagingPath: name };
  });
  if (!layout.supplementRoot) throw new Error('platformProjectionSupplementUnsupported');
  return selected.map((component) => {
    const { relativePath: relative, content } = projectSupplementFile(input.binding, component);
    files.add(relative, content, [component.id]);
    return { id: component.id, componentIds: [component.id], kind: 'owned-file', destination: path.join(layout.supplementRoot!, relative),
      contentDigest: files.digest(relative), stagingPath: relative };
  });
}

async function policyContributions(ctx: StageContext, input: ProjectionInput, files: ProjectionFiles, componentIds: string[]): Promise<HostContribution[]> {
  if (!input.policy.permissions.length || input.renderUnit.output !== 'package') return [];
  const platform = input.binding.platform;
  const layout = await getDeploymentLayout(ctx, input.binding);
  const resourceKey = getDeploymentResourceKey(input.binding.plugin);
  if (platform === 'codex') {
    if (input.policy.permissions.some((permission) => permission.sandbox?.excludedCommands.length)) throw new Error('platformProjectionInvocationPolicyUnsupported');
    return generateCodexPermissionArtifacts(`${input.binding.plugin.sourceId}-${getNativePackageName(input.binding.plugin)}`, input.policy.permissions, ctx.commandResolver).map((artifact) => {
      const relative = `permissions/${path.posix.basename(artifact.relativePath)}`;
      files.add(relative, artifact.content);
      return { id: `policy:${artifact.artifactKey}`, componentIds, kind: 'owned-file', destination: path.join(layout.activationPath, artifact.relativePath),
        stagingPath: `host/${relative}`, contentDigest: files.digest(relative) };
    });
  }
  if (platform === 'claude') {
    const mutation = { kind: 'claude-permissions', permissions: mergeClaudePermissions(input.policy.permissions, ctx.commandResolver) };
    const relative = 'claude-permissions.json';
    files.json(relative, mutation);
    return [{ id: 'policy:claude-permissions', componentIds, kind: 'config-entry', destination: path.join(layout.activationPath, input.binding.scope.kind === 'project' ? 'settings.local.json' : 'settings.json'),
      stagingPath: `host/${relative}`, contentDigest: files.digest(relative), mergeKey: `claude-permissions:${resourceKey}` }];
  }
  throw new Error('platformProjectionInvocationPolicyUnsupported');
}

/** Builds only private staging artifacts. Native registration belongs to execute. */
export async function projectPlatform(ctx: StageContext, input: ProjectionInput): Promise<ProjectionResult> {
  ctx.signal?.throwIfAborted();
  assertPlatformCapabilities(input.capabilities);
  if (input.capabilities.platform !== input.binding.platform || input.capabilities.scope !== input.renderUnit.renderScope.kind
    || input.policy.platform !== input.binding.platform) throw new Error('platformProjectionInputMismatch');
  if (input.policy.permissions.length && !['codex', 'claude'].includes(input.binding.platform)) throw new Error('platformProjectionInvocationPolicyUnsupported');
  const platform = input.binding.platform;
  const unit = input.renderUnit;
  if ((platform === 'generic') !== (unit.output === 'generic')
    || (unit.output === 'supplement' && !['codex', 'grok'].includes(platform))
    || (platform === 'codex' && unit.kinds.some((kind) => unit.output === 'supplement' ? kind !== 'agent' : kind === 'agent'))
    || (platform === 'grok' && unit.kinds.some((kind) => unit.output === 'supplement' ? kind !== 'instruction' : kind === 'instruction'))
    || (platform === 'generic' && unit.kinds.some((kind) => kind !== 'skill'))) throw new Error('platformProjectionRenderUnitInvalid');
  const ids = new Set<string>();
  const files = new ProjectionFiles();
  const hostFiles = new ProjectionFiles();
  let selected = input.components.filter((component) => input.renderUnit.kinds.includes(component.kind));
  for (const component of input.components) {
    assertPluginComponent(component, { platform: input.binding.platform });
    if (ids.has(component.id)) throw new Error('platformProjectionIdentityConflict');
    ids.add(component.id);
    let skillText: string | undefined;
    if (component.kind === 'skill') skillText = resourceBytes(input, component.id, 'SKILL.md', component.content.files['SKILL.md']!).bytes.toString('utf8');
    const requirements = getComponentFeatureRequirements(component, { skillText });
    if (input.capabilities.kinds[component.kind].status !== 'supported' || getUnmetFeatureRequirements(requirements, input.capabilities).length) {
      throw new Error('platformProjectionCapabilityUnsupported');
    }
    // Validate native names for the whole same-scope set, even when the current
    // unit only consumes another component's text.
    if (selected.includes(component)) files.component(component, nameFor(input, component));
  }
  if (platform !== 'pi' && platform !== 'opencode') {
    const packageRoot = input.resources.commandResources?.length ? (await getDeploymentLayout(ctx, input.binding)).packageRoot : '';
    input = { ...input, components: bindPlatformCommandResources(input, packageRoot, ctx.platform ?? process.platform) };
    selected = input.components.filter((component) => input.renderUnit.kinds.includes(component.kind));
  }
  if (!selected.length && (!input.policy.permissions.length || input.renderUnit.output !== 'package')) {
    return { renderUnitId: input.renderUnit.id, bundle: null, supplements: [], components: [], diagnostics: [] };
  }
  if (input.binding.platform === 'generic' && selected.some((component) => component.kind !== 'skill')) throw new Error('platformProjectionGenericKindUnsupported');
  const instructions = input.components.filter((component): component is Instruction => component.kind === 'instruction');
  let supplements: HostContribution[] = [];
  if (input.renderUnit.output === 'supplement') {
    supplements = await supplementContributions(ctx, input, files, selected);
  } else {
    projectSkills(input, files, selected);
    if (input.renderUnit.output === 'generic') supplements = await supplementContributions(ctx, input, files, selected);
    else {
      for (const file of input.resources.bundleFiles) files.add(file.path, file.bytes, file.componentIds ?? [], file.mode);
      for (const agent of selected.filter((component): component is Agent => component.kind === 'agent')) {
        if (input.binding.platform === 'codex') throw new Error('platformProjectionAgentRequiresSupplement');
        if (input.binding.platform === 'opencode') continue;
        const name = nameFor(input, agent);
        const relative = input.binding.platform === 'copilot' ? `com.github.copilot/agents/${name}.agent.md` : `agents/${name}.md`;
        files.add(relative, agentMarkdown(input, agent, instructions), [agent.id,
          ...(['gemini', 'copilot'].includes(input.binding.platform) ? instructions.filter((instruction) => instruction.content.coverage.includes('plugin-agents')).map((instruction) => instruction.id) : [])]);
      }
      const servers = projectMcp(input, files, selected.filter((component): component is Mcp => component.kind === 'mcp'));
      if (!['pi', 'opencode'].includes(input.binding.platform)) {
        projectRules(input, files, selected.filter((component): component is Instruction => component.kind === 'instruction'));
        projectHooks(input, files, selected.filter((component): component is Hook => component.kind === 'hook'), selected.filter((component): component is Instruction => component.kind === 'instruction'));
      }
      if (selected.length) projectManifest(input, files, selected, servers);
      supplements.push(...await policyContributions(ctx, input, hostFiles, input.components.map((component) => component.id)));
      if (input.binding.platform === 'cursor') {
        const layout = await getDeploymentLayout(ctx, input.binding);
        const command = cursorWorkspaceOpenCommand(input.binding, ctx.platform);
        hostFiles.json('cursor-workspace-open.json', { version: 1, hooks: { workspaceOpen: [{ command }] } });
        supplements.push({ id: 'cursor-workspace-open', componentIds: selected.map((component) => component.id), kind: 'config-entry',
          destination: layout.activationPath, contentDigest: hostFiles.digest('cursor-workspace-open.json'), stagingPath: 'host/cursor-workspace-open.json',
          mergeKey: `workspaceOpen:${getDeploymentResourceKey(input.binding.plugin)}` });
      }
    }
  }
  ctx.signal?.throwIfAborted();
  const stagingRoot = await prepareProjectionRoot(ctx.stagingRoot);
  try {
    const outputRoot = path.join(stagingRoot, 'output');
    await files.write(outputRoot, ctx.signal);
    if (hostFiles.files.size) await hostFiles.write(path.join(stagingRoot, 'host'), ctx.signal);
    supplements = supplements.map((contribution) => ({ ...contribution, stagingPath: contribution.stagingPath.startsWith('host/')
      ? path.join(stagingRoot, contribution.stagingPath) : path.join(outputRoot, contribution.stagingPath) }));
    for (const component of files.components) component.relativeOutputs.sort();
    return { renderUnitId: input.renderUnit.id,
      bundle: input.renderUnit.output === 'package' && files.files.size > 0 ? { stagingRoot: outputRoot, contentDigest: files.digest() } : null,
      supplements, components: files.components, diagnostics: [] };
  } catch (error) {
    await fs.remove(stagingRoot);
    throw error;
  }
}
