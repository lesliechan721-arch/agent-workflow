import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import fs from 'fs-extra';
import YAML from 'yaml';

import manifestSchema from '../schemas/plugin-manifest-v4.json' with { type: 'json' };
import componentSchema from '../schemas/platform-components.json' with { type: 'json' };
import { getHookHandlerContract } from './hook-handlers.js';
import { assertHookMatcherAllowed, assertNoDuplicateHookHandlers } from './hooks-contract.js';
import { compilePluginConfigDefinition, getPluginConfigDependencyKeys } from './plugin-config.js';
import { applyPlatformOverride } from './platform-entries.js';
import { supportsPlatform } from './platform-support.js';
import { assertManagedCommandPlatform, normalizeCommandSelector, normalizeCommandRelativeFile, parseManagedCommandPlaceholders, type PermissionCommand, type ManagedCommandPermission } from './managed-commands.js';
import { resolveCanonicalRuntimeSourceIdentity } from './runtime-export-source.js';
import { isSkillAuthorOnlyPath, isAuthorOnlySkillDirectory } from './skill-authoring.js';
import { scanSkillAgentReferences, parseAgentNamePlaceholders, assertSkillAgentReferencesInFrontmatter, SKILL_AGENT_PLACEHOLDER_CAPABILITY } from './agent-placeholders.js';
import { applyStaticSkillAgentUnmet, readSkillAgentReferenceNames } from './skill-agent-registry.js';
import { validatePortableSkillName } from './portable-skill-validation.js';
import { resolvePlatformAgentNaming, resolvePlatformAgentNamingMode, type PlatformAgentNaming, type PlatformAgentNamingMode } from './platform-agent-naming.js';
import { validateSkillFrontmatterCapabilities } from './skill-frontmatter-capabilities.js';
import type { NormalizedPluginManifest, PlatformId, PluginConfigDefinition, PluginConfigValidationIssue, PluginConfigValue, Scope } from './types.js';

export const COMPONENT_KINDS = ['skill', 'mcp', 'agent', 'hook', 'instruction'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];
export type InstructionAudience = 'main' | 'plugin-agents' | 'other-agents';
export type HookFeedback = 'notify' | 'context' | 'block';
export type SupportV3 = 'supported' | 'unsupported';
export type Support = SupportV3;
export type SourceRef = { kind: 'bundle'; path: string } | { kind: 'runtime-import'; name: string; path: string };
export type ResourceFile = { text: string } | { source: SourceRef };
export interface FeatureRequirement { feature: string; values?: string[] }
export interface AgentContent {
  description: string; prompt: string; model?: string; tools?: string[];
  promptMode?: 'host-default' | 'append' | 'replace';
}
export interface InstructionContent { title: string; content: string; paths?: string[]; coverage: InstructionAudience[] }
export type HookContent =
  | { dialect: 'common'; event: 'before_tool' | 'after_tool' | 'session_start'; feedback: HookFeedback; matcher?: string; command: string }
  | { dialect: 'native'; event: string; feedback: HookFeedback; matcher?: string; command: string };
export type McpServerDefinition =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
export interface ComponentBase { id: string; name: string; requires?: FeatureRequirement[] }
export type PluginComponent = ComponentBase & (
  | { kind: 'skill'; content: { files: Record<string, ResourceFile> }; runtimeConfig?: { keys: string[] } }
  | { kind: 'mcp'; content: McpServerDefinition }
  | { kind: 'agent'; content: AgentContent }
  | { kind: 'hook'; content: HookContent }
  | { kind: 'instruction'; content: InstructionContent }
);
export interface ComponentOmission { id: string; name?: string; kind: ComponentKind; reason: 'not-offered' | 'config-disabled' }
export interface ComponentUnmet {
  id: string; kind: ComponentKind; name?: string; componentId?: string;
  requiredFeatures: FeatureRequirement[]; reasonCode: string;
}
export interface PlatformComponentPlanV3 { version: 3; components: PluginComponent[]; omitted: ComponentOmission[]; unmet: ComponentUnmet[] }
export interface ExpectedComponentSet {
  components: PluginComponent[]; omitted: ComponentOmission[]; unmet: ComponentUnmet[];
  sources: Record<string, 'static' | 'dynamic'>;
  /** IDs for which the author actually supplied a body, including skipped definitions. */
  declaredComponentIds?: string[];
}
export interface ComponentGap extends ComponentUnmet { productIds: string[] }
export interface ResolvedPermissionDefinition {
  name: string; allow?: PermissionCommand[]; ask?: PermissionCommand[]; deny?: PermissionCommand[];
  sandbox?: { excludedCommands: ManagedCommandPermission[] };
}
export interface ResolvedInvocationPolicy {
  platform: PlatformId;
  permissions: ResolvedPermissionDefinition[];
  invocationSelector?: string;
}
export interface CapabilityFact { status: Support; reasonCodes: string[] }
export interface PlatformCapabilitiesV3 {
  schemaVersion: 3; platform: PlatformId; scope: Scope; basis: 'local' | 'profile';
  agentNamingMode: PlatformAgentNamingMode;
  kinds: Record<ComponentKind, CapabilityFact & { delivery: Array<'native-package' | 'native-extension' | 'managed-host-resource' | 'generic-files'> }>;
  features: Record<string, CapabilityFact & { values?: string[]; maxBytes?: number }>;
}
export interface PlatformRenderContextV3 {
  schemaVersion: 3; surface: 'agent-plugin'; platform: PlatformId; scope: Scope;
  plugin: { pluginId: string; name: string; version: string };
  config: {
    schema: PluginConfigDefinition; values: Record<string, PluginConfigValue>;
    sources: Record<string, 'default' | 'common' | 'platform' | 'missing'>; issues: PluginConfigValidationIssue[];
  };
  changedConfigKeys: string[]; allowedOutputKinds: ComponentKind[]; platformCapabilities: PlatformCapabilitiesV3;
  agentNaming: PlatformAgentNaming;
  resources: Array<{ kind: 'bundle' | 'runtime-import'; name: string; root: string; digest: string }>;
  previousComponents: Array<{ id: string; kind: ComponentKind; name: string }>;
}
export const CAPABILITY_REASON_CODES = [
  'client-missing', 'client-unknown', 'version-unsupported', 'interface-unsupported', 'scope-unsupported', 'delivery-unavailable',
] as const;
export const COMPONENT_DEPENDENCY_REASON_CODES = ['dependency-missing', 'dependency-unmet', 'config-missing', 'config-invalid'] as const;

export interface PlatformFeatureDefinition {
  id: string; values?: readonly string[]; defaultStatus: 'unsupported';
  evidence: string; separable: boolean; derivedFromKind?: ComponentKind;
}
interface RequirementSchema { properties: { feature: { const: string }; values?: { items: { enum: string[] } } } }
const requirementSchemas = manifestSchema.$defs.featureRequirement.oneOf as RequirementSchema[];
/** Feature IDs and their legal values come from the public schema, never from host observations. */
export const PLATFORM_FEATURE_REGISTRY: Readonly<Record<string, PlatformFeatureDefinition>> = Object.freeze(Object.fromEntries(
  requirementSchemas.map((entry) => {
    const id = entry.properties.feature.const;
    return [id, Object.freeze({ id,
      ...(entry.properties.values ? { values: Object.freeze([...entry.properties.values.items.enum]) } : {}),
      defaultStatus: 'unsupported' as const,
      ...(id.startsWith('component.kind.') ? { derivedFromKind: id.slice('component.kind.'.length) as ComponentKind } : {}),
      evidence: id === 'hook.matcher' ? 'Matcher mapping for each listed dialect.event.'
        : id.startsWith('hook.') ? 'Mapped host event with notify support; context and block require a registered wire protocol.'
        : id === 'agent.model' ? 'Model selection; when present, values constrain the exact model identifiers.'
        : 'Delivery capability for the selected platform and scope.',
      separable: id === 'instruction.coverage',
    })];
  }),
));
export function getPlatformFeatureRegistry(): Readonly<Record<string, PlatformFeatureDefinition>> { return PLATFORM_FEATURE_REGISTRY; }

// Compile only the contracts a caller uses, sharing referenced validators.
let componentAjv: Ajv2020 | undefined;
function getComponentAjv(): Ajv2020 {
  if (!componentAjv) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, inlineRefs: false });
    ajv.addSchema(manifestSchema);
    ajv.addSchema(componentSchema);
    componentAjv = ajv;
  }
  return componentAjv;
}
function lazyValidator<T>(ref: string): () => ValidateFunction<T> {
  let validator: ValidateFunction<T> | undefined;
  return () => validator ??= getComponentAjv().compile<T>({ $ref: ref });
}
const getComponentValidator = lazyValidator<PluginComponent>(`${componentSchema.$id}#/$defs/pluginComponent`);
const getPlanValidator = lazyValidator<PlatformComponentPlanV3>(`${componentSchema.$id}#/$defs/platformComponentPlanV3`);
const getCapabilitiesValidator = lazyValidator<PlatformCapabilitiesV3>(`${componentSchema.$id}#/$defs/platformCapabilitiesV3`);
const getContextValidator = lazyValidator<PlatformRenderContextV3>(`${componentSchema.$id}#/$defs/platformRenderContextV3`);
const getRequirementValidator = lazyValidator<FeatureRequirement>(`${manifestSchema.$id}#/$defs/featureRequirement`);
function assertSchema<T>(getValidator: () => ValidateFunction<T>, value: unknown, field: string): asserts value is T {
  const validator = getValidator();
  if (!validator(value)) throw new Error(`Invalid ${field}: ${getComponentAjv().errorsText(validator.errors)}.`);
}
function assertIdentity(id: string): void {
  if (id.trim() === '' || /[/\\\u0000-\u001f\u007f]/u.test(id) || id === 'command-routes') {
    throw new Error(`Invalid component ID ${JSON.stringify(id)}.`);
  }
}
function safeRelativePath(value: string, field: string): string {
  return normalizeCommandRelativeFile(value.replace(/^\.\//u, ''), field);
}
export function assertFeatureRequirement(value: unknown): asserts value is FeatureRequirement {
  assertSchema(getRequirementValidator, value, 'feature requirement');
}
export function assertPlatformCapabilities(value: unknown): asserts value is PlatformCapabilitiesV3 {
  assertSchema(getCapabilitiesValidator, value, 'platform capabilities');
  if (value.agentNamingMode !== resolvePlatformAgentNamingMode(value.platform)) throw new Error('Invalid platform capabilities: agentNamingMode mismatch.');
  for (const [feature, fact] of Object.entries(value.features)) {
    if (fact.status === 'supported' && feature === 'hook.matcher') {
      for (const key of fact.values ?? []) {
        const separator = key.indexOf('.');
        const dialect = key.slice(0, separator);
        if (dialect !== 'common' && dialect !== 'native') throw new Error('Invalid platform capabilities: unknown hook matcher dialect.');
        const handler = getHookHandlerContract(value.platform, dialect, key.slice(separator + 1));
        if (handler.matcherAllowed !== true || value.features[`hook.${key}`]?.status !== 'supported') {
          throw new Error(`Invalid platform capabilities: hook matcher is unsupported for ${key}.`);
        }
      }
    } else if (fact.status === 'supported' && feature.startsWith('hook.')) {
      const dialect = feature.startsWith('hook.native.') ? 'native' : 'common';
      const event = feature.slice(`hook.${dialect}.`.length);
      const handler = getHookHandlerContract(value.platform, dialect, event);
      if (handler.nativeEvent === null) throw new Error(`Invalid platform capabilities: no native event mapping for ${feature}.`);
      if (fact.values?.some((feedback) => feedback !== 'notify' && (!handler.protocol || !Object.hasOwn(handler.protocol.responses, feedback)))) {
        throw new Error(`Invalid platform capabilities: ${feature} feedback has no registered wire protocol.`);
      }
    }
    if (fact.status !== 'supported' && (fact.values?.length ?? 0) > 0) throw new Error(`Invalid platform capabilities: unsupported feature ${feature} cannot grant values.`);
  }
}
export function assertPlatformRenderContext(value: unknown): asserts value is PlatformRenderContextV3 {
  assertSchema(getContextValidator, value, 'platform render context');
  assertPlatformCapabilities(value.platformCapabilities);
  if (value.platform !== value.platformCapabilities.platform || value.scope !== value.platformCapabilities.scope) throw new Error('Invalid platform render context: capability platform/scope mismatch.');
  const naming = resolvePlatformAgentNaming(value.platform, value.plugin);
  if (!isDeepStrictEqual(value.agentNaming, naming) || value.agentNaming.mode !== value.platformCapabilities.agentNamingMode) {
    throw new Error('Invalid platform render context: agentNaming mismatch.');
  }
  const keys = new Set(Object.keys(value.config.schema.fields));
  for (const key of [...Object.keys(value.config.values), ...Object.keys(value.config.sources), ...value.changedConfigKeys]) {
    if (!keys.has(key)) throw new Error(`Invalid platform render context: config key ${key} is outside the batch whitelist.`);
  }
  if (Object.keys(value.config.sources).length !== keys.size) throw new Error('Invalid platform render context: every config key requires a source.');
  for (const key of keys) {
    const source = value.config.sources[key];
    if ((source === 'missing') === Object.hasOwn(value.config.values, key)) throw new Error('Invalid platform render context: missing config value/source mismatch.');
  }
  const skillBatch = value.allowedOutputKinds.includes('skill');
  if (skillBatch && value.allowedOutputKinds.length !== 1) throw new Error('Invalid platform render context: Skill and non-Skill batches must be separate.');
  if (skillBatch && Object.values(value.config.schema.fields).some((field) => field.sensitive === true)) throw new Error('Invalid platform render context: Skill batch contains sensitive config.');
  for (const issue of value.config.issues) if (!keys.has(issue.path.field)) throw new Error('Invalid platform render context: issue outside whitelist.');
  for (const previous of value.previousComponents) {
    assertIdentity(previous.id);
    if (!value.allowedOutputKinds.includes(previous.kind)) throw new Error('Invalid platform render context: previous component outside batch.');
  }
  for (const resource of value.resources) if (!path.isAbsolute(resource.root)) throw new Error('Invalid platform render context: resource root must be absolute.');
}
export function assertNativeComponentHookEvent(platform: PlatformId, event: string): void {
  getHookHandlerContract(platform, 'native', event);
}
function parseSkillFrontmatter(text: string): Record<string, unknown> {
  const normalized = text.replace(/\r\n/gu, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (!match) throw new Error('Invalid Skill: SKILL.md requires YAML frontmatter.');
  assertSkillAgentReferencesInFrontmatter(text);
  const frontmatter: unknown = YAML.parse(match[1]!);
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) throw new Error('Invalid Skill frontmatter.');
  const record = frontmatter as Record<string, unknown>;
  if (typeof record.name === 'string' && parseAgentNamePlaceholders(record.name).length) {
    throw new Error('agentReferenceInvalid: the SKILL.md frontmatter name cannot reference an Agent.');
  }
  const diagnostics = validateSkillFrontmatterCapabilities(record, 'claude-current');
  if (diagnostics.length) throw new Error(`Invalid Skill frontmatter: ${diagnostics.map((entry) => entry.message).join('; ')}.`);
  if (typeof record.name !== 'string') throw new Error('Invalid Skill frontmatter.name.');
  validatePortableSkillName(record.name, 'Skill frontmatter.name');
  return record;
}
function metadataBoolean(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === 'string' && ['true', 'yes', 'on', '1'].includes(value.trim().toLowerCase()));
}
export function isSkillInvocationFeature(feature: string): boolean {
  return feature === 'skill.invocation.manual' || feature === 'skill.invocation.model' || feature === 'skill.visibility';
}

export function getComponentFeatureRequirements(component: PluginComponent, options: { skillText?: string; deliveryOnly?: boolean } = {}): FeatureRequirement[] {
  const requirements: FeatureRequirement[] = [{ feature: `component.kind.${component.kind}` }, ...structuredClone(component.requires ?? [])];
  const require = (feature: string, values?: string[]): void => { requirements.push({ feature, ...(values ? { values } : {}) }); };
  switch (component.kind) {
    case 'mcp': require('mcp.transport', [component.content.type]); break;
    case 'agent':
      require('agent.execution', ['isolated-context']);
      require('agent.prompt-mode', [component.content.promptMode ?? 'host-default']);
      if (component.content.model !== undefined) require('agent.model');
      if (component.content.tools !== undefined) require('agent.tools', [component.content.tools.length === 0 ? 'none' : 'allowlist']);
      break;
    case 'hook':
      require(`hook.${component.content.dialect}.${component.content.event}`, [component.content.feedback]);
      if (component.content.matcher !== undefined) require('hook.matcher', [`${component.content.dialect}.${component.content.event}`]);
      break;
    case 'instruction':
      require('instruction.coverage', component.content.coverage);
      if (component.content.paths?.length) require('instruction.paths');
      break;
    case 'skill': {
      const skillFile = component.content.files['SKILL.md'];
      const text = options.skillText ?? (skillFile && 'text' in skillFile ? skillFile.text : undefined);
      if (text !== undefined) {
        const metadata = parseSkillFrontmatter(text);
        if (metadata.name !== component.name) {
          throw new Error(`Invalid SKILL.md frontmatter.name ${JSON.stringify(metadata.name)} for Skill component ${JSON.stringify(component.id)}. Expected ${JSON.stringify(component.name)}.`);
        }
        if (Object.hasOwn(metadata, 'user-invocable')) {
          const manual = metadataBoolean(metadata['user-invocable']);
          require('skill.invocation.manual', [String(manual)]);
          require('skill.visibility', [manual ? 'visible' : 'hidden']);
        }
        if (Object.hasOwn(metadata, 'disable-model-invocation')) require('skill.invocation.model', [String(!metadataBoolean(metadata['disable-model-invocation']))]);
        for (const field of ['allowed-tools', 'disallowed-tools'] as const) {
          if (Object.hasOwn(metadata, field)) {
            const tools = metadata[field];
            require('skill.tools', [field === 'disallowed-tools' ? 'denylist' : Array.isArray(tools) && tools.length === 0 ? 'none' : 'allowlist']);
          }
        }
        for (const [field, feature] of [['model', 'skill.model'], ['agent', 'skill.agent'], ['hooks', 'skill.hooks'], ['paths', 'skill.paths'], ['when_to_use', 'skill.invocation.hint'], ['arguments', 'skill.arguments'], ['argument-hint', 'skill.arguments']] as const) {
          if (Object.hasOwn(metadata, field)) require(feature);
        }
        if (Object.hasOwn(metadata, 'context')) require('skill.execution', ['isolated-context']);
        if (Object.hasOwn(metadata, 'background')) require('skill.background', [String(metadataBoolean(metadata.background))]);
        if (Object.hasOwn(metadata, 'effort')) require('skill.effort', [String(metadata.effort).toLowerCase()]);
        if (Object.hasOwn(metadata, 'shell')) require('skill.shell', [String(metadata.shell).toLowerCase()]);
      }
      if (component.runtimeConfig) require('skill.runtime-config', ['aw.installed-runtime-config.v2']);
      break;
    }
  }
  // Invocation preferences describe how a host should expose the Skill. They never withhold its files.
  return mergeFeatureRequirements(requirements).filter(({ feature }) =>
    !(options.deliveryOnly && component.kind === 'skill' && isSkillInvocationFeature(feature)));
}

export function mergeFeatureRequirements(requirements: readonly FeatureRequirement[]): FeatureRequirement[] {
  const merged = new Map<string, FeatureRequirement>();
  for (const requirement of requirements) {
    assertFeatureRequirement(requirement);
    const previous = merged.get(requirement.feature);
    if (previous?.values || requirement.values) merged.set(requirement.feature, { feature: requirement.feature, values: [...new Set([...(previous?.values ?? []), ...(requirement.values ?? [])])] });
    else merged.set(requirement.feature, { feature: requirement.feature });
  }
  return [...merged.values()];
}
export function getPlatformCapabilityFact(feature: string, capabilities: PlatformCapabilitiesV3): CapabilityFact & { values?: string[]; maxBytes?: number } {
  const entry = PLATFORM_FEATURE_REGISTRY[feature];
  if (!entry) throw new Error(`Unknown platform feature ${feature}.`);
  return entry.derivedFromKind ? capabilities.kinds[entry.derivedFromKind] : capabilities.features[feature] ?? { status: 'unsupported', reasonCodes: ['interface-unsupported'] };
}
export function getUnmetFeatureRequirements(requirements: readonly FeatureRequirement[], capabilities: PlatformCapabilitiesV3): FeatureRequirement[] {
  return requirements.flatMap((requirement): FeatureRequirement[] => {
    assertFeatureRequirement(requirement);
    const fact = getPlatformCapabilityFact(requirement.feature, capabilities);
    const kind = PLATFORM_FEATURE_REGISTRY[requirement.feature]?.derivedFromKind;
    if (fact.status !== 'supported' || (kind && !capabilities.kinds[kind].delivery.length)) return [structuredClone(requirement)];
    if (!requirement.values) return [];
    const missing = requirement.values.filter((value) => !fact.values?.includes(value));
    return missing.length ? [{ feature: requirement.feature, values: missing }] : [];
  });
}
const RESERVED_COMPONENT_FILES = new Set(['.agent-workflows-owner.json', '.aw-runtime-config.json', 'scripts/aw-runtime-config.mjs', '.aw-command-producer.json', '.agents-plugin/aw-codex-native-render.json', '.aw-runtime-native-receipt.json']);
export interface ComponentPlanValidationOptions {
  platform: PlatformId; scope?: Scope; allowedOutputKinds: readonly ComponentKind[];
  platformCapabilities: PlatformCapabilitiesV3;
  configKeys?: readonly string[]; nonSensitiveConfigKeys?: readonly string[]; requiredAwCapabilities?: readonly string[];
  resources?: PlatformRenderContextV3['resources']; sourceDirs?: readonly string[];
  staticComponents?: readonly PluginComponent[];
  hasInstructionAgentRecipients?: boolean;
}
export function assertPluginComponent(value: unknown, options: Pick<ComponentPlanValidationOptions, 'platform'> & { phase?: 'source' | 'target' }): asserts value is PluginComponent {
  assertSchema(getComponentValidator, value, 'plugin component');
  assertIdentity(value.id);
  if (value.name.trim() === '' || /[/\\\u0000-\u001f\u007f]/u.test(value.name)) throw new Error('Invalid component name.');
  if (value.kind === 'hook') {
    assertHookMatcherAllowed({ kind: value.content.dialect === 'common' ? 'public' : 'native', platform: options.platform, event: value.content.event, matcher: value.content.matcher, fieldName: `component ${value.id}.matcher`, phase: options.phase });
  }
  if (value.kind === 'skill') {
    const files = value.content.files;
    if (!Object.hasOwn(files, 'SKILL.md')) throw new Error('Invalid Skill component: missing SKILL.md.');
    for (const [file, resource] of Object.entries(files)) {
      if (safeRelativePath(file, 'Skill file') !== file || RESERVED_COMPONENT_FILES.has(file) || file.split('/').some((segment) => ['.git', 'node_modules', '.agents-plugin', '.codex-plugin', '.claude-plugin'].includes(segment)) || isSkillAuthorOnlyPath(file)) throw new Error(`Invalid or reserved Skill file ${JSON.stringify(file)}.`);
      if ('source' in resource) safeRelativePath(resource.source.path, 'resource source');
    }
    getComponentFeatureRequirements(value);
  }
}
function sourceIsAllowed(source: SourceRef, options: ComponentPlanValidationOptions): boolean {
  const relative = safeRelativePath(source.path, 'resource source');
  if (source.kind === 'runtime-import') return options.resources?.some((resource) => resource.kind === 'runtime-import' && resource.name === source.name) ?? false;
  return (options.sourceDirs ?? options.resources?.filter((resource) => resource.kind === 'bundle').map((resource) => resource.name) ?? []).some((directory) => {
    const root = safeRelativePath(directory, 'resource source directory');
    return relative.startsWith(`${root}/`);
  });
}
export function assertPlatformComponentPlan(value: unknown, options: ComponentPlanValidationOptions): asserts value is PlatformComponentPlanV3 {
  assertSchema(getPlanValidator, value, 'platform component plan');
  assertPlatformCapabilities(options.platformCapabilities);
  if (options.platform !== options.platformCapabilities.platform || (options.scope !== undefined && options.scope !== options.platformCapabilities.scope)) throw new Error('Invalid component plan: capability platform/scope mismatch.');
  assertNoDuplicateHookHandlers([...(options.staticComponents ?? []), ...value.components], options.platform);
  const identities = new Set<string>((options.staticComponents ?? []).map((component) => component.id));
  const names = new Set<string>((options.staticComponents ?? []).map((component) => `${component.kind}:${component.name}`));
  for (const entry of [...value.components, ...value.omitted, ...value.unmet]) {
    assertIdentity(entry.id);
    if (!options.allowedOutputKinds.includes(entry.kind)) throw new Error(`Invalid component plan: kind ${entry.kind} is outside allowedOutputKinds.`);
    if (identities.has(entry.id)) throw new Error(`Invalid component plan: duplicate component ID ${entry.id}.`);
    identities.add(entry.id);
  }
  for (const component of value.components) {
    assertPluginComponent(component, { ...options, phase: 'source' });
    const name = `${component.kind}:${component.name}`;
    if (names.has(name)) throw new Error(`Invalid component plan: duplicate component name ${component.name}.`);
    names.add(name);
    getComponentFeatureRequirements(component);
    if (component.kind === 'instruction') {
      const max = options.platformCapabilities.features['instruction.coverage']?.maxBytes;
      if (max !== undefined && Buffer.byteLength(component.content.content, 'utf8') > max) throw new Error('Invalid instruction: content exceeds capability maxBytes.');
    }
    if (component.kind === 'skill') {
      if (component.runtimeConfig && !options.requiredAwCapabilities?.includes('aw.installed-runtime-config.v2')) throw new Error('Invalid component plan: runtimeConfig requires aw.installed-runtime-config.v2.');
      for (const [file, resource] of Object.entries(component.content.files)) {
        if ('text' in resource && scanSkillAgentReferences(file, resource.text).length
          && !options.requiredAwCapabilities?.includes(SKILL_AGENT_PLACEHOLDER_CAPABILITY)) {
          throw new Error('agentReferenceInvalid: dynamic Skill Markdown requires ' + SKILL_AGENT_PLACEHOLDER_CAPABILITY);
        }
        if ('source' in resource && !sourceIsAllowed(resource.source, options)) throw new Error('Invalid component plan: resource source is outside declared inputs.');
      }
      for (const key of component.runtimeConfig?.keys ?? []) {
        if (!options.configKeys?.includes(key) || !options.nonSensitiveConfigKeys?.includes(key)) throw new Error('Invalid component plan: runtime config key outside non-sensitive renderer whitelist.');
      }
    }
  }
  const capabilities = options.platformCapabilities;
  const hasRecipients = options.hasInstructionAgentRecipients ?? hasDeliverableInstructionAgent(
    [...(options.staticComponents ?? []), ...value.components], capabilities);
  const linkedAudiences = new Map<Extract<PluginComponent, { kind: 'instruction' }>, Set<string>>();
  for (const unmet of value.unmet) {
    const dependencyReason = COMPONENT_DEPENDENCY_REASON_CODES.some((code) => code === unmet.reasonCode);
    if (!dependencyReason && !CAPABILITY_REASON_CODES.some((code) => code === unmet.reasonCode)) throw new Error('Invalid component plan: unknown unmet reason code.');
    if (unmet.componentId !== undefined) {
      const component = value.components.find((entry) => entry.id === unmet.componentId);
      const [requirement] = unmet.requiredFeatures;
      if (component?.kind !== 'instruction' || unmet.kind !== 'instruction' || unmet.requiredFeatures.length !== 1 || requirement?.feature !== 'instruction.coverage' || !requirement.values?.length) {
        throw new Error('Invalid component plan: only instruction coverage can be split.');
      }
      const audiences = linkedAudiences.get(component) ?? new Set<string>();
      for (const audience of requirement.values) {
        if (audiences.has(audience)) throw new Error('Invalid component plan: overlapping instruction coverage gaps.');
        audiences.add(audience);
      }
      linkedAudiences.set(component, audiences);
    } else {
      const coverage = unmet.kind === 'instruction'
        ? unmet.requiredFeatures.flatMap(({ feature, values }) => feature === 'instruction.coverage' ? values ?? [] : []) : [];
      if (coverage.length !== missingInstructionAudiences(coverage, coverage, capabilities, hasRecipients).length) {
        throw new Error('Invalid component plan: instruction coverage gap includes deliverable audiences.');
      }
      for (const requirement of unmet.requiredFeatures) {
        if (unmet.kind === 'instruction' && requirement.feature === 'instruction.coverage' && requirement.values) continue;
        const model = capabilities.features['agent.model'];
        if (unmet.kind === 'agent' && requirement.feature === 'agent.model' && model?.status === 'supported' && model.values !== undefined) continue;
        if (!isDeepStrictEqual(getUnmetFeatureRequirements([requirement], capabilities), [requirement])) {
          throw new Error('Invalid component plan: unmet requirements include supported values.');
        }
      }
    }
    if (!unmet.requiredFeatures.length) {
      if (!dependencyReason) throw new Error('Invalid component plan: capability gap requires concrete features.');
    } else if (unmet.reasonCode !== reasonForMissing(unmet.requiredFeatures, capabilities)) {
      throw new Error('Invalid component plan: unmet reason does not match the missing capability.');
    }
  }
  for (const [component, reported] of linkedAudiences) {
    const retained = getComponentFeatureRequirements(component).find(({ feature }) => feature === 'instruction.coverage')!.values!;
    if (retained.some((audience) => reported.has(audience))) throw new Error('Invalid component plan: instruction coverage gap overlaps retained audiences.');
    // Codex can reach the two agent audiences together. Check the complete request across all linked gaps.
    const missing = missingInstructionAudiences([...retained, ...reported], [...component.content.coverage, ...reported], capabilities, hasRecipients);
    if (!isDeepStrictEqual(new Set(missing), reported)) throw new Error('Invalid component plan: instruction coverage split does not match deliverable audiences.');
  }
}

function missingInstructionAudiences(requested: readonly string[], bodyCoverage: readonly string[], capabilities: PlatformCapabilitiesV3,
  hasAgentRecipients: boolean): string[] {
  const fact = capabilities.features['instruction.coverage'];
  let available = fact?.status === 'supported' ? fact.values ?? [] : [];
  if (capabilities.platform === 'codex') {
    // A shared package cannot distinguish plugin roles from independent project roles.
    if (!['plugin-agents', 'other-agents'].every((audience) => requested.includes(audience))) available = available.filter((audience) => audience === 'main');
  } else if (capabilities.platform === 'copilot' || capabilities.platform === 'grok') {
    if (!hasAgentRecipients) available = available.filter((audience) => audience !== 'plugin-agents');
  } else if (capabilities.platform !== 'claude' && !bodyCoverage.includes('main')) {
    // Other rule and extension entries reach the main session whenever enabled.
    available = [];
  }
  return requested.filter((audience) => !available.includes(audience));
}

export function hasDeliverableInstructionAgent(components: readonly PluginComponent[], capabilities: PlatformCapabilitiesV3): boolean {
  return ['copilot', 'grok'].includes(capabilities.platform) && components.some((component) =>
    component.kind === 'agent' && getMissingDeliveryRequirements(component, capabilities).length === 0);
}
/** Check the component representation and all declared prerequisites against the same capability facts. */
export function getMissingDeliveryRequirements(component: PluginComponent, capabilities: PlatformCapabilitiesV3, skillText?: string,
  hasInstructionAgentRecipients = false): FeatureRequirement[] {
  const requirements = getComponentFeatureRequirements(component, { deliveryOnly: true, skillText });
  // No representation of this kind is possible; its concrete fields need not be reported separately.
  const ownKind = getUnmetFeatureRequirements([{ feature: `component.kind.${component.kind}` }], capabilities);
  if (ownKind.length) return ownKind;
  return requirements.flatMap((requirement): FeatureRequirement[] => {
    const fact = capabilities.features[requirement.feature];
    if (component.kind === 'agent' && requirement.feature === 'agent.model' && component.content.model !== undefined
      && fact?.values !== undefined && !fact.values.includes(component.content.model)) {
      return [{ feature: 'agent.model' }];
    }
    if (component.kind === 'instruction' && requirement.feature === 'instruction.coverage' && requirement.values) {
      const missing = missingInstructionAudiences(requirement.values, component.content.coverage, capabilities, hasInstructionAgentRecipients);
      return missing.length ? [{ feature: requirement.feature, values: missing }] : [];
    }
    return getUnmetFeatureRequirements([requirement], capabilities);
  });
}
export function reasonForMissing(requirements: FeatureRequirement[], capabilities: PlatformCapabilitiesV3): string {
  const codes = requirements.flatMap(({ feature }) => getPlatformCapabilityFact(feature, capabilities).reasonCodes);
  return selectMissingReasonCode(codes);
}
export function selectMissingReasonCode(codes: readonly string[]): string {
  // Missing or unknown clients require action even when another consumer only lacks an interface or version.
  return codes.find((code) => code === 'client-missing' || code === 'client-unknown')
    ?? (codes.includes('interface-unsupported') ? 'interface-unsupported' : codes[0])
    ?? 'interface-unsupported';
}
/** A renderer may supply a complete declaration even when a host cannot express all of it. */
export function partitionPluginComponents(components: readonly PluginComponent[], capabilities: PlatformCapabilitiesV3,
  sources: 'static' | 'dynamic' | ExpectedComponentSet['sources'], skillTexts?: ReadonlyMap<string, string>,
  hasInstructionAgentRecipients?: boolean): ExpectedComponentSet {
  assertPlatformCapabilities(capabilities);
  const result: ExpectedComponentSet = { components: [], omitted: [], unmet: [], sources: Object.create(null), declaredComponentIds: components.map(({ id }) => id) };
  const identities = new Set<string>();
  const names = new Set<string>();
  assertNoDuplicateHookHandlers(components, capabilities.platform);
  hasInstructionAgentRecipients ??= hasDeliverableInstructionAgent(components, capabilities);
  for (const original of components) {
    assertPluginComponent(original, { platform: capabilities.platform, phase: 'source' });
    if (identities.has(original.id) || names.has(`${original.kind}:${original.name}`)) throw new Error('Invalid components: duplicate identity or name.');
    identities.add(original.id); names.add(`${original.kind}:${original.name}`);
    const source = typeof sources === 'string' ? sources : sources[original.id]!;
    result.sources[original.id] = source;
    const component = structuredClone(original);
    const missing = getMissingDeliveryRequirements(component, capabilities, skillTexts?.get(component.id), hasInstructionAgentRecipients);
    if (!missing.length) { result.components.push(component); continue; }
    let partial = false;
    if (component.kind === 'instruction' && missing.length === 1 && missing[0]?.feature === 'instruction.coverage') {
      const absent = missing[0].values ?? component.content.coverage;
      const coverage = component.content.coverage.filter((audience) => !absent.includes(audience));
      if (coverage.length) {
        component.content.coverage = coverage;
        component.requires = component.requires?.filter((requirement) => requirement.feature !== 'instruction.coverage');
        partial = true;
      }
    }
    if (component.kind === 'skill' && capabilities.platform === 'generic'
      && missing.every(({ feature }) => !feature.startsWith('skill.') && feature !== 'component.kind.skill')) {
      component.requires = component.requires?.filter(({ feature }) => !missing.some((entry) => entry.feature === feature));
      partial = true;
    }
    const id = partial ? `${component.id}:${component.kind === 'instruction' ? 'coverage' : 'runtime'}-gap` : component.id;
    if (partial) {
      if (components.some((entry) => entry.id === id)) throw new Error('Invalid component: gap ID conflict.');
      result.sources[id] = source;
      result.components.push(component);
    }
    result.unmet.push({ id, kind: component.kind, name: component.name, ...(partial ? { componentId: component.id } : {}),
      requiredFeatures: missing, reasonCode: reasonForMissing(missing, capabilities) });
  }
  return result;
}
export function partitionStaticPluginComponents(components: readonly PluginComponent[], capabilities: PlatformCapabilitiesV3,
  hasInstructionAgentRecipients?: boolean): ExpectedComponentSet {
  return partitionPluginComponents(components, capabilities, 'static', undefined, hasInstructionAgentRecipients);
}
async function staticSkillFiles(root: string, directory: string): Promise<Record<string, ResourceFile>> {
  const files: Record<string, ResourceFile> = {};
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, directory, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (isSkillAuthorOnlyPath(file)) continue;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Invalid static Skill: only ordinary files/directories are allowed.');
      if (entry.isDirectory()) await walk(file);
      else {
        const source = path.posix.join(directory, file);
        const identity = await resolveCanonicalRuntimeSourceIdentity(root, source, 'static Skill source');
        const bytes = await fs.readFile(identity.sourceRealPath);
        const text = bytes.toString('utf8');
        Object.defineProperty(files, file, { enumerable: true, configurable: true, writable: true,
          value: Buffer.from(text, 'utf8').equals(bytes) && ((await fs.stat(identity.sourceRealPath)).mode & 0o111) === 0 ? { text } : { source: { kind: 'bundle', path: source } } });
      }
    }
  };
  await walk('');
  return files;
}
export function resolveInvocationPolicy(manifest: NormalizedPluginManifest, platform: PlatformId, packageSelector?: string): ResolvedInvocationPolicy {
  const command = manifest.command;
  let invocationSelector: string | undefined;
  if (packageSelector !== undefined && platform !== 'generic' && command?.platforms.includes(platform)) {
    normalizeCommandSelector(packageSelector);
    invocationSelector = command.runtimeConfig ? `${packageSelector}/${platform}` : packageSelector;
  }
  return { platform, ...(invocationSelector === undefined ? {} : { invocationSelector }), permissions: (manifest.extensions?.permissions ?? []).flatMap((permission) => {
    const resolved = applyPlatformOverride(permission, platform);
    if (!resolved) return [];
    const { agentOverrides: _, ...entry } = resolved;
    if (command && platform === 'generic' && permission.agentOverrides?.generic === undefined) {
      const generic: ResolvedPermissionDefinition = { name: entry.name };
      for (const action of ['allow', 'ask', 'deny'] as const) {
        const rules = entry[action]?.filter((rule) => typeof rule === 'string');
        if (rules?.length) generic[action] = rules;
      }
      return generic.allow || generic.ask || generic.deny ? [generic] : [];
    }
    return [entry];
  }) };
}
export async function normalizeStaticPluginComponents(options: {
  pluginRoot: string; staticResourceRoot?: string; manifest: NormalizedPluginManifest; platform: PlatformId;
  capabilities: PlatformCapabilitiesV3; allowedOutputKinds?: readonly ComponentKind[]; deferPartition?: boolean;
  hasInstructionAgentRecipients?: boolean;
}): Promise<ExpectedComponentSet> {
  const { manifest, platform, pluginRoot } = options;
  const readSource = async (source: SourceRef): Promise<string> => {
    const identity = await resolveCanonicalRuntimeSourceIdentity(pluginRoot, source.path, 'static Skill Markdown');
    return fs.readFile(identity.sourceRealPath, 'utf8');
  };
  const staticRoot = options.staticResourceRoot ?? pluginRoot;
  const relativeRoot = path.relative(path.resolve(pluginRoot), path.resolve(staticRoot)).split(path.sep).join('/');
  if (relativeRoot === '..' || relativeRoot.startsWith('../') || path.isAbsolute(relativeRoot)) throw new Error('Invalid static resource root: outside bundle.');
  let verifiedRoot = pluginRoot;
  for (const segment of relativeRoot.split('/').filter(Boolean)) {
    verifiedRoot = path.join(verifiedRoot, segment);
    const stats = await fs.lstat(verifiedRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Invalid static resource root.');
  }
  if (options.capabilities.platform !== platform) throw new Error('Invalid static normalization: capability platform mismatch.');
  if (!supportsPlatform(manifest, platform)) throw new Error(`Plugin does not declare ${platform} support.`);
  const components: PluginComponent[] = [];
  const omitted: ComponentOmission[] = [];
  const allowed = (kind: ComponentKind): boolean => options.allowedOutputKinds?.includes(kind) ?? true;
  if (manifest.skills && allowed('skill')) {
    const directory = path.posix.join(relativeRoot, manifest.skills.replace(/^\.\//u, ''));
    const root = path.join(pluginRoot, directory);
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Invalid static Skills root.');
    for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid static Skills collection entry.');
      if (await isAuthorOnlySkillDirectory(path.join(root, entry.name))) continue;
      validatePortableSkillName(entry.name);
      const files = await staticSkillFiles(pluginRoot, path.posix.join(directory, entry.name));
      const skill: PluginComponent = { id: `skill:${entry.name}`, kind: 'skill', name: entry.name, content: { files } };
      const skillIdentity = await resolveCanonicalRuntimeSourceIdentity(pluginRoot, path.posix.join(directory, entry.name, 'SKILL.md'), 'static Skill frontmatter');
      const skillText = await fs.readFile(skillIdentity.sourceRealPath, 'utf8');
      // A missing Agent can withhold the entire Skill before its command needs a host binding.
      if (parseManagedCommandPlaceholders(skillText).length > 0
        && (!manifest.command || (await readSkillAgentReferenceNames(files, readSource)).size === 0)) {
        assertManagedCommandPlatform(manifest, platform, `Skill ${entry.name} {{aw.command}}`);
      }
      skill.requires = getComponentFeatureRequirements(skill, { skillText }).filter((requirement) => requirement.feature !== 'component.kind.skill');
      if (skill.requires.length === 0) delete skill.requires;
      components.push(skill);
    }
  }
  if (manifest.mcpServers && allowed('mcp')) {
    const identity = await resolveCanonicalRuntimeSourceIdentity(pluginRoot, path.posix.join(relativeRoot, manifest.mcpServers), 'mcpServers');
    const value: unknown = await fs.readJson(identity.sourceRealPath);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => key !== 'mcpServers')) throw new Error('Invalid static MCP document.');
    const servers = (value as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid static MCP servers.');
    for (const [name, content] of Object.entries(servers)) {
      const component = { id: `mcp:${name}`, name, kind: 'mcp', content };
      assertPluginComponent(component, { platform, phase: 'source' }); components.push(component);
    }
  }
  for (const kind of ['agent', 'instruction', 'hook'] as const) {
    if (!allowed(kind)) continue;
    const entries = kind === 'agent' ? manifest.extensions?.agents : kind === 'instruction' ? manifest.extensions?.instructions : manifest.extensions?.hooks;
    for (const entry of entries ?? []) {
      const key = 'id' in entry ? entry.id : entry.name;
      const id = `${kind}:${key}`;
      const resolved = applyPlatformOverride(entry, platform);
      if (!resolved) { omitted.push({ id, kind, reason: 'not-offered' }); continue; }
      const { agentOverrides: _, ...content } = resolved;
      let component: unknown;
      if (kind === 'hook' && 'event' in content) {
        const { id: _id, requires, ...hook } = content;
        component = { id, kind, name: key, ...(requires ? { requires } : {}), content: { dialect: 'common', ...hook } };
      } else {
        const { name, ...body } = content as { name: string };
        component = { id, kind, name, content: body };
      }
      assertPluginComponent(component, { platform, phase: 'source' }); components.push(component);
    }
  }
  if (allowed('hook')) {
    for (const hook of manifest.extensions?.nativeHooks?.[platform] ?? []) {
      const { id, requires, ...content } = hook;
      const component: PluginComponent = { id: `native-hook:${platform}:${id}`, name: id, kind: 'hook', ...(requires ? { requires } : {}), content: { dialect: 'native', ...content } };
      assertPluginComponent(component, { platform, phase: 'source' }); components.push(component);
    }
  }
  const result: ExpectedComponentSet = options.deferPartition
    ? { components, omitted: [], unmet: [], sources: Object.fromEntries(components.map(({ id }) => [id, 'static' as const])) }
    : partitionStaticPluginComponents(components, options.capabilities, options.hasInstructionAgentRecipients);
  for (const entry of omitted) {
    if (result.sources[entry.id]) throw new Error('Invalid static components: duplicate omitted identity.');
    result.sources[entry.id] = 'static';
    result.omitted.push(entry);
  }
  if (options.deferPartition) return result;
  return applyStaticSkillAgentUnmet({
    expected: result, manifest, platform, capabilities: options.capabilities,
    allowDynamicAgentDeferral: manifest.artifacts !== undefined,
    readSource,
  });
}
export function getRendererConfigKeys(manifest: NormalizedPluginManifest, platform: PlatformId, kind: 'skill' | 'non-skill'): string[] {
  const declared = manifest.artifacts?.configKeys ?? [];
  if (!declared.length) return [];
  if (!manifest.config) throw new Error('Invalid renderer config: missing definition.');
  const config = compilePluginConfigDefinition(manifest.config, platform);
  return declared.filter((key) => kind !== 'skill' || getPluginConfigDependencyKeys(config, [key]).every((dependency) => config.fields[dependency]?.sensitive !== true));
}
