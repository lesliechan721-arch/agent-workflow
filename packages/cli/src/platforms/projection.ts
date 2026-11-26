import path from 'node:path';
import fs from 'fs-extra';
import YAML from 'yaml';
import {
  assertPlatformCapabilities, assertPluginComponent, getComponentFeatureRequirements, getMissingDeliveryRequirements, isSkillInvocationFeature,
  validatePortableSkillName,
  getHookHandlerContract,
  renderHookDefinitionGroup, resolveProjectedAgentName,
  type AgentContent, type PluginComponent,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { Diagnostic } from '../output/public-result.js';
import type { DeploymentBinding, HostContribution, ProjectionInput, ProjectionResult, StageContext } from './contracts.js';
import { getDeploymentLayout, getDeploymentResourceKey, getInvocationPolicyPath, getNativePackageName, scopedPermissionPath } from './layout.js';
import { ProjectionFiles, agentNamingForBinding, nativeComponentName, prepareProjectionRoot, resourceBytes, safeProjectionPath, type ProjectedFile } from './projection-files.js';
import { projectCodeExtension } from './projection-code-extension.js';
import { bindPlatformCommandResources } from './projection-command-resources.js';
import { generateCodexPermissionArtifacts, mergeClaudePermissions, renderClaudeBashRule, hostPermissionClaims, selectPlatformInvocationPolicy } from '../generators/permissions.js';
import { grokProjectPermissionsAuthorized } from './grok-permission-config.js';
import { resolvePlatformConfigRoot } from './discovery.js';
import { supportsAntigravityGlobalPermissions } from './antigravity-permissions.js';
import { hostPermissionDiagnostics, hostPermissionImpactDiagnostics, isPermissionHost } from './host-permission-policy.js';
import { previewHostPermissions } from './permission-ownership.js';
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
  if (component.kind === 'agent') return resolveProjectedAgentName(agentNamingForBinding(input.binding), component.name);
  const name = nativeComponentName(component.name);
  if (input.binding.platform === 'pi' && component.kind === 'mcp') return name.replace(/-/gu, '_');
  return input.binding.platform === 'generic' && component.kind === 'skill'
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
  if (content.promptMode && content.promptMode !== 'host-default' && !(platform === 'claude' && content.promptMode === 'replace')) {
    throw new Error('platformProjectionPromptModeUnsupported');
  }
  const metadata: Record<string, unknown> = { name: nameFor(input, agent), description: content.description,
    model: content.model, tools: content.tools };
  if (platform === 'antigravity') metadata.inheritCustomizations = true;
  const prompt = ['copilot', 'grok'].includes(platform) ? composedAgentPrompt(agent, instructions) : content.prompt;
  return markdown(metadata, prompt);
}

function projectSkillInvocation(platform: DeploymentBinding['platform'], component: PluginComponent, original: string,
  metadata: Record<string, unknown>, files: Map<string, ProjectedFile>): boolean {
  if (platform === 'codex' && Object.keys(metadata).some((field) =>
    !['name', 'description', 'license', 'compatibility', 'metadata', 'user-invocable', 'disable-model-invocation'].includes(field))) {
    throw new Error('platformProjectionSkillMetadataUnsupported');
  }
  const hasFields = Object.hasOwn(metadata, 'user-invocable') || Object.hasOwn(metadata, 'disable-model-invocation');
  if (platform === 'generic') {
    if (!hasFields && !component.requires?.some(({ feature }) => isSkillInvocationFeature(feature))) return false;
    const preferences = getComponentFeatureRequirements(component, { skillText: original }).filter(({ feature }) => isSkillInvocationFeature(feature));
    metadata.metadata = { ...(metadata.metadata as Record<string, unknown> | undefined),
      ...Object.fromEntries(preferences.map(({ feature, values }) => [feature, [...(values ?? [])].sort().join(',')])) };
    delete metadata['user-invocable'];
    delete metadata['disable-model-invocation'];
    return true;
  }
  if (!hasFields) return false;
  const invocation = getComponentFeatureRequirements({ ...component, requires: [] }, { skillText: original });
  const manual = invocation.find((requirement) => requirement.feature === 'skill.invocation.manual');
  const model = invocation.find((requirement) => requirement.feature === 'skill.invocation.model');
  const manualField = platform === 'claude' || platform === 'copilot' || platform === 'grok';
  let changed = false;
  if (manual) {
    const visible = manual.values?.includes('true') === true;
    if (manualField) {
      changed = metadata['user-invocable'] !== visible;
      metadata['user-invocable'] = visible;
    } else {
      if (!visible) metadata.metadata = { ...(metadata.metadata as Record<string, unknown> | undefined),
        'skill.invocation.manual': 'false', 'skill.visibility': 'hidden' };
      delete metadata['user-invocable'];
      changed = true;
    }
  }
  if (!model) return changed;
  const implicit = model.values?.includes('true') === true;
  if (platform === 'codex') {
    const yamlFile = files.get('agents/openai.yaml');
    const definition = yamlFile ? YAML.parse(yamlFile.bytes.toString('utf8')) as Record<string, unknown> : {};
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('platformProjectionSkillPolicyInvalid');
    const policy = (definition.policy ?? {}) as Record<string, unknown>;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('platformProjectionSkillPolicyInvalid');
    if (Object.hasOwn(policy, 'allow_implicit_invocation') && policy.allow_implicit_invocation !== implicit) throw new Error('platformProjectionSkillPolicyConflict');
    definition.policy = { ...policy, allow_implicit_invocation: implicit };
    files.set('agents/openai.yaml', { bytes: Buffer.from(YAML.stringify(definition)), mode: 0o644 });
  } else if (platform === 'opencode') {
    const native = (metadata.metadata ?? {}) as Record<string, unknown>;
    const key = 'opencode/autoinvoke';
    if (Object.hasOwn(native, key) && String(native[key]).trim().toLowerCase() !== String(implicit)) throw new Error('platformProjectionSkillPolicyConflict');
    metadata.metadata = { ...native, [key]: String(implicit) };
  } else {
    if (metadata['disable-model-invocation'] !== !implicit) changed = true;
    metadata['disable-model-invocation'] = !implicit;
    return changed;
  }
  delete metadata['disable-model-invocation'];
  return true;
}

/** Translate the author's invocation fields while preserving the complete document body. */
export function projectSkillDocument(platform: DeploymentBinding['platform'], component: PluginComponent, name: string,
  bytes: Buffer, files: Map<string, ProjectedFile> = new Map()): Buffer {
  const original = bytes.toString('utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(original)!;
  const metadata = YAML.parse(match[1]!) as Record<string, unknown>;
  const rename = metadata.name !== name;
  metadata.name = name;
  const preserveVersion = (platform === 'codex' || platform === 'opencode') && Object.hasOwn(metadata, 'version');
  if (preserveVersion) {
    const extensions = metadata.metadata as Record<string, unknown> | undefined;
    const version = String(metadata.version);
    if (extensions?.version !== undefined && extensions.version !== version) throw new Error('platformProjectionSkillMetadataConflict');
    metadata.metadata = { ...extensions, version };
    delete metadata.version;
  }
  const changed = projectSkillInvocation(platform, component, original, metadata, files);
  return changed || rename || preserveVersion ? Buffer.from(`---\n${YAML.stringify(metadata)}---\n${original.slice(match[0].length)}`) : bytes;
}

function projectSkills(input: ProjectionInput, files: ProjectionFiles, components: PluginComponent[]): void {
  for (const component of components) {
    if (component.kind !== 'skill') continue;
    const name = nameFor(input, component);
    validatePortableSkillName(name, 'projected Skill name');
    const root = input.renderUnit.output === 'generic' ? name : `skills/${name}`;
    const skillFiles = new Map(Object.entries(component.content.files).map(([relative, resource]) => [relative, resourceBytes(input, component.id, relative, resource)]));
    const skillFile = skillFiles.get('SKILL.md')!;
    skillFiles.set('SKILL.md', { ...skillFile, bytes: projectSkillDocument(input.binding.platform, component, name, skillFile.bytes, skillFiles) });
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
    for (const [audience, key] of [['main', 'SessionStart'], ['plugin-agents', 'plugin'], ['other-agents', 'other']] as const) {
      const selected = instructions.filter((instruction) => instruction.content.coverage.includes(audience));
      if (!selected.length) continue;
      const text = selected.map((instruction) => instruction.content.content).join('\n\n');
      const maxBytes = input.capabilities.features['instruction.coverage']?.maxBytes;
      if (maxBytes !== undefined && Buffer.byteLength(text) > maxBytes) throw new Error('platformProjectionInstructionTooLarge');
      contexts[key] = text;
    }
    if (platform === 'codex' && contexts.plugin !== contexts.other) throw new Error('platformProjectionInstructionCoverageUnsupported');
    for (const event of ['SessionStart', 'SubagentStart']) {
      if (event === 'SessionStart' ? !contexts.SessionStart : !contexts.plugin && !contexts.other) continue;
      add(event, { hooks: [{ type: 'command', command: `node "${rootVariable}/scripts/aw-instructions.mjs" ${event}` }] });
    }
    const lines = [
      "import { readFileSync } from 'node:fs';",
      `const contexts = ${JSON.stringify(contexts)};`,
      'const event = process.argv[2];',
      'let text = contexts.SessionStart;',
      "if (event === 'SubagentStart') {",
    ];
    if (platform === 'claude' && contexts.plugin !== contexts.other) {
      // Claude reports the authoritative plugin-scoped role identifier on this hook.
      lines.push("  const { agent_type } = JSON.parse(readFileSync(0, 'utf8'));",
        "  if (typeof agent_type !== 'string') throw new Error('Missing subagent type');",
        `  text = agent_type.startsWith(${JSON.stringify(agentNamingForBinding(input.binding).invocationPrefix)}) ? contexts.plugin : contexts.other;`);
    } else lines.push('  text = contexts.plugin ?? contexts.other;');
    lines.push("} else if (event !== 'SessionStart') throw new Error('Unsupported instruction event');",
      'if (text) process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:text}}));', '');
    files.add('scripts/aw-instructions.mjs', lines.join('\n'), instructions.map((instruction) => instruction.id));
    ids.push(...instructions.map((instruction) => instruction.id));
  }
  if (!Object.keys(eventMap).length) return;
  const relative = platform === 'copilot' ? 'com.github.copilot/hooks/hooks.json' : 'hooks/hooks.json';
  files.json(relative, { ...(platform === 'cursor' || platform === 'copilot' ? { version: 1 } : {}), hooks: eventMap }, ids);
}

function projectRules(input: ProjectionInput, files: ProjectionFiles, instructions: Instruction[]): void {
  const platform = input.binding.platform;
  if (platform === 'codex' || platform === 'claude' || platform === 'grok') return;
  for (const instruction of instructions) {
    const name = nameFor(input, instruction);
    if (platform === 'cursor') {
      files.add(`rules/${name}.mdc`, markdown({ description: instruction.content.title,
        ...(instruction.content.paths?.length ? { globs: instruction.content.paths, alwaysApply: false } : { alwaysApply: true }) }, instruction.content.content), [instruction.id]);
    } else if (platform === 'antigravity') {
      if (instruction.content.paths?.length) files.add(`rules/${name}.md`, markdown({ trigger: 'glob', globs: instruction.content.paths.join(', ') }, instruction.content.content), [instruction.id]);
    } else if (platform === 'copilot') {
      if (instruction.content.paths?.length) throw new Error('platformProjectionInstructionPathsUnsupported');
      if (instruction.content.coverage.includes('main')) {
        files.add(`com.github.copilot/rules/${name}.md`, instruction.content.content, [instruction.id]);
      }
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
    if (platform === 'antigravity') {
      server = content.type === 'stdio'
        ? { command: content.command, ...(content.args ? { args: [...content.args] } : {}), ...(content.env ? { env: { ...content.env } } : {}) }
        : { serverUrl: content.url,
          ...(content.headers ? { headers: { ...content.headers } } : {}) };
    }
    return [nameFor(input, component), server];
  }));
  if (!mcps.length || ['pi', 'opencode'].includes(platform)) return servers;
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
  // Claude's agents field accepts Markdown files. Omit it to scan the default agents/ directory.
  if (platform !== 'claude' && has('agent')) manifest.agents = './agents/';
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
    if (!component.content.coverage.includes('main')) throw new Error('platformProjectionInstructionAudienceUnsupported');
    return { relativePath, content: component.content.content.replace(/\r\n/gu, '\n') };
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

async function policyContributions(ctx: StageContext, input: ProjectionInput, files: ProjectionFiles, componentIds: string[], diagnostics: Diagnostic[]): Promise<HostContribution[]> {
  if (!input.policy.permissions.length || input.renderUnit.output !== 'package') return [];
  const platform = input.binding.platform;
  const resourceKey = getDeploymentResourceKey(input.binding.plugin);
  const selector = input.policy.invocationSelector;
  if (platform === 'codex') {
    const layout = await getDeploymentLayout(ctx, input.binding);
    if (input.policy.permissions.some((permission) => permission.sandbox?.excludedCommands.length)) throw new Error('platformProjectionInvocationPolicyUnsupported');
    return generateCodexPermissionArtifacts(`${input.binding.plugin.sourceId}-${getNativePackageName(input.binding.plugin)}`, input.policy.permissions, selector).map((artifact) => {
      const relative = `permissions/${path.posix.basename(artifact.relativePath)}`;
      files.add(relative, artifact.content);
      return { id: `policy:${artifact.artifactKey}`, componentIds, kind: 'owned-file', destination: path.join(layout.activationPath, artifact.relativePath),
        stagingPath: `host/${relative}`, contentDigest: files.digest(relative) };
    });
  }
  if (isPermissionHost(platform)) {
    const permissions = hostPermissionClaims(input.policy.permissions, selector);
    if (platform === 'antigravity' && !supportsAntigravityGlobalPermissions(input.binding)) {
      diagnostics.push(...hostPermissionDiagnostics({ skipped: permissions.map((claim) => ({ ...claim, reasonCode: 'antigravity-cli-global-only' })),
        ownershipDegraded: false }, input.binding, ''));
      return [];
    }
    const entry = input.binding.consumers[0]?.entry;
    const hostRoot = entry && entry.kind !== 'generic' ? entry.configRoot : undefined;
    if (platform === 'grok' && input.binding.scope.kind === 'project'
      && (input.grokScopeAuthorization === 'denied' || input.grokScopeAuthorization === 'unknown'
        || !await grokProjectPermissionsAuthorized(ctx, hostRoot ?? resolvePlatformConfigRoot('grok', ctx), input.binding.scope.projectRoot))) {
      diagnostics.push(...hostPermissionDiagnostics({ skipped: permissions.map((claim) => ({ ...claim, reasonCode: 'grok-project-trust-required' })),
        ownershipDegraded: false }, input.binding, ''));
      return [];
    }
    const destination = await scopedPermissionPath(ctx, platform, input.binding.scope, hostRoot);
    if (!destination) {
      diagnostics.push(...hostPermissionDiagnostics({ skipped: permissions.map((claim) => ({ ...claim, reasonCode:
        platform === 'antigravity' ? 'antigravity-config-path-unconfirmed' : 'permission-config-path-unconfirmed' })),
        ownershipDegraded: false }, input.binding, platform === 'opencode' ? 'OPENCODE_CONFIG_DIR' : 'HOME'));
      return [];
    }
    const preview = await previewHostPermissions(ctx, input.binding, destination, permissions);
    diagnostics.push(...hostPermissionDiagnostics(preview, input.binding, destination));
    const kind = `${platform}-permissions`;
    const relative = kind + '.json';
    files.json(relative, { kind, permissions, effective: preview.effective, reviewDigest: preview.reviewDigest,
      ...(preview.affected.length ? { affected: preview.affected } : {}) });
    return [{ id: 'policy:' + kind, componentIds, kind: 'config-entry', destination,
      stagingPath: `host/${relative}`, contentDigest: files.digest(relative), mergeKey: `${kind}:${resourceKey}` }];
  }
  if (platform === 'claude') {
    const destination = await getInvocationPolicyPath(ctx, input.binding);
    const adjusted = hostPermissionClaims(input.policy.permissions, selector).map((claim) => {
      const resource = renderClaudeBashRule(claim.tokens);
      const extra = claim.effect === 'allow' ? 'It also matches after known-safe environment assignments.'
        : 'It also matches after any leading environment assignment or within a compound command.';
      const program = path.posix.basename(claim.tokens[0] ?? '');
      const safetyCheck = claim.effect !== 'allow' ? ''
        : program === 'find' ? ' Claude Code can still require approval for find actions such as -exec and -delete.'
          : ['watch', 'setsid', 'ionice', 'flock'].includes(program) ? ` Claude Code can still require approval for commands run through ${program}.` : '';
      return { ...claim, pluginId: input.binding.plugin.pluginId, resource, reasonCode: 'claude-bash-wrapper-matching',
        message: 'Claude Code matches this written prefix with or without additional arguments and inside recognized shell wrappers such as timeout and time. ' + extra + safetyCheck };
    });
    diagnostics.push(...hostPermissionImpactDiagnostics(adjusted, platform, input.binding.scope.kind, destination));
    const mutation = { kind: 'claude-permissions', permissions: mergeClaudePermissions(input.policy.permissions, selector) };
    const relative = 'claude-permissions.json';
    files.json(relative, mutation);
    return [{ id: 'policy:claude-permissions', componentIds, kind: 'config-entry', destination,
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
  const diagnostics: Diagnostic[] = [];
  if (input.renderUnit.output !== 'supplement') {
    const selection = selectPlatformInvocationPolicy(input.policy, {
      pluginId: input.binding.plugin.pluginId, target: input.binding.platform, scope: input.binding.scope.kind,
    });
    diagnostics.push(...selection.diagnostics);
    input = { ...input, policy: selection.policy };
  }
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
  const selectedForUnit = (component: PluginComponent): boolean => {
    if (platform === 'grok' && component.kind === 'instruction') {
      return component.content.coverage.includes('main') ? unit.kinds.includes('instruction') : unit.kinds.includes('agent');
    }
    return unit.kinds.includes(component.kind);
  };
  let selected = input.components.filter(selectedForUnit);
  const hasInstructionAgentRecipients = (unit.kinds.includes('agent') || platform === 'grok' && unit.output === 'supplement')
    && input.components.some((component) => component.kind === 'agent');
  for (const component of input.components) {
    assertPluginComponent(component, { platform: input.binding.platform });
    if (ids.has(component.id)) throw new Error('platformProjectionIdentityConflict');
    ids.add(component.id);
    let skillText: string | undefined;
    if (component.kind === 'skill') skillText = resourceBytes(input, component.id, 'SKILL.md', component.content.files['SKILL.md']!).bytes.toString('utf8');
    if (getMissingDeliveryRequirements(component, input.capabilities, skillText, hasInstructionAgentRecipients).length) {
      throw new Error('platformProjectionCapabilityUnsupported');
    }
    // Validate native names for the whole same-scope set, even when the current
    // unit only consumes another component's text.
    if (selected.includes(component)) files.component(component, nameFor(input, component));
  }
  if (platform !== 'pi' && platform !== 'opencode') {
    const packageRoot = input.resources.commandResources?.length ? (await getDeploymentLayout(ctx, input.binding)).packageRoot : '';
    input = { ...input, components: bindPlatformCommandResources(input, packageRoot, ctx.platform ?? process.platform) };
    selected = input.components.filter(selectedForUnit);
  }
  if (!selected.length && (!input.policy.permissions.length || input.renderUnit.output !== 'package')) {
    return { renderUnitId: input.renderUnit.id, bundle: null, supplements: [], components: [], diagnostics };
  }
  if (input.binding.platform === 'generic' && selected.some((component) => component.kind !== 'skill')) throw new Error('platformProjectionGenericKindUnsupported');
  const instructions = input.components.filter((component): component is Instruction => component.kind === 'instruction');
  const roleInstructionIds = ['copilot', 'grok'].includes(platform) ? selected.filter((component) =>
    component.kind === 'instruction' && component.content.coverage.includes('plugin-agents')).map((component) => component.id) : [];
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
        files.add(relative, agentMarkdown(input, agent, instructions), [agent.id, ...roleInstructionIds]);
      }
      const servers = projectMcp(input, files, selected.filter((component): component is Mcp => component.kind === 'mcp'));
      if (!['pi', 'opencode'].includes(input.binding.platform)) {
        projectRules(input, files, selected.filter((component): component is Instruction => component.kind === 'instruction'));
        projectHooks(input, files, selected.filter((component): component is Hook => component.kind === 'hook'), selected.filter((component): component is Instruction => component.kind === 'instruction'));
      }
      if (selected.length) projectManifest(input, files, selected, servers);
      supplements.push(...await policyContributions(ctx, input, hostFiles, input.components.map((component) => component.id), diagnostics));
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
      bundle: input.renderUnit.output === 'package' && files.files.size > 0 ? { stagingRoot: outputRoot, contentDigest: files.digest(),
        ...(platform === 'pi' && files.files.has('index.mjs') ? { piExtensionDigest: files.digest('index.mjs') } : {}) } : null,
      supplements, components: files.components, diagnostics };
  } catch (error) {
    await fs.remove(stagingRoot);
    throw error;
  }
}
