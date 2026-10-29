import crypto from 'node:crypto';
import path from 'node:path';

import type {
  ArtifactPlan,
  ArtifactPlanArtifact,
  ArtifactState,
  ArtifactTarget,
  AgentSkillsSkillArtifact,
  ClaudeSkillArtifact,
  CodexAgentRoleArtifact,
  CodexSkillArtifact,
  DeveloperInstructionsBlockArtifact,
  ArtifactRenderSurfaceName,
  NormalizedPluginManifest,
  Scope,
} from '../types.js';
import type { ResolvedArtifactRenderConfig } from './artifact-renderer.js';
import { assertPlatformFieldSupported } from './manifest.js';
import { validatePortableSkillName } from './dynamic-skill-tree.js';
import { artifactDeclarationSurface, artifactRequestDeclarations, resolveArtifactRequest, type ArtifactRequestDeclaration } from './artifact-request.js';
import { normalizeCommandDefinitions, normalizeCommandRelativeFile } from '@lesliechan721/aw-plugin-core/manifest';

const SUPPORTED_ARTIFACT_TARGETS = new Set<ArtifactTarget>([
  'codex.developerInstructionsBlock',
  'codex.agentRole',
  'codex.skill',
  'claude.skill',
  'agent-skills.skill',
  'aw.command-set',
  'aw.command-package',
]);
const SUPPORTED_ARTIFACT_STATES = new Set<ArtifactState>(['present', 'disabled']);
const TARGET_ORDER: ArtifactTarget[] = [
  'codex.skill',
  'claude.skill',
  'agent-skills.skill',
  'codex.developerInstructionsBlock',
  'codex.agentRole',
];
const ARTIFACT_KIND_BY_TARGET: Record<ArtifactTarget, ArtifactPlanArtifact['kind']> = {
  'codex.developerInstructionsBlock': 'instruction',
  'codex.agentRole': 'codexRole',
  'codex.skill': 'skill',
  'claude.skill': 'skill',
  'agent-skills.skill': 'skill',
  'aw.command-set': 'commandSet',
  'aw.command-package': 'commandPackage',
};

export type ValidatedArtifactPlanArtifact = ArtifactPlanArtifact & {
  declaration: ArtifactRequestDeclaration;
  logicalIdentity: string;
  configDigest: string;
};

export interface ValidatedArtifactPlan {
  version: 2;
  artifacts: ValidatedArtifactPlanArtifact[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAllowedObjectKeys(
  value: Record<string, unknown>,
  fieldName: string,
  allowedKeys: readonly string[],
): void {
  const allowedKeySet = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowedKeySet.has(key)) {
      throw new Error(`Invalid ${fieldName}: unexpected field "${key}".`);
    }
  }
}

function ensureNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}: expected a non-empty string.`);
  }
  return value;
}

function validateArtifactId(value: string, fieldName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(
      `Invalid ${fieldName}: expected a stable id using letters, numbers, ".", "_" or "-".`,
    );
  }
}

function validateCodexRoleKey(value: string, fieldName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a valid Codex role key.`);
  }
}

function validateCodexSkillKey(value: string, fieldName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a valid Codex skill key.`);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestHex(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function resolvePlanObject(plan: unknown): ArtifactPlan {
  if (!isRecord(plan)) {
    throw new Error('Invalid artifact plan: expected a JSON object.');
  }
  assertAllowedObjectKeys(plan, 'artifact plan', ['version', 'artifacts']);
  if (plan.version !== 2) {
    throw new Error(`Invalid artifact plan version "${String(plan.version)}".`);
  }
  if (!Array.isArray(plan.artifacts)) {
    throw new Error('Invalid artifact plan: "artifacts" must be an array.');
  }
  return plan as unknown as ArtifactPlan;
}

function getDeclaredTargets(options: {
  manifest: NormalizedPluginManifest;
  platform: ArtifactRenderSurfaceName;
  scope: Scope;
}): Map<string, ArtifactRequestDeclaration> {
  const output = new Map<string, ArtifactRequestDeclaration>();

  for (const [index, target] of artifactRequestDeclarations(options.manifest).entries()) {
    if (target.platform) {
      assertPlatformFieldSupported({
        pluginName: options.manifest.name,
        manifest: options.manifest,
        fieldPath: `artifacts.targets[${index}].platform`,
        requiredPlatform: target.platform,
      });
    }
    if (artifactDeclarationSurface(target) !== options.platform || !target.scopes.includes(options.scope)) {
      continue;
    }
    if (
      options.scope === 'project' &&
      target.platform === 'codex' &&
      targetRequiresCodexProjectConfig(target.target) &&
      target.requiresCodexProjectConfig !== true
    ) {
      throw new Error(
        `Artifact "${target.id}" target "${target.target}" is missing requiresCodexProjectConfig for project scope.`,
      );
    }
    output.set(`${target.id}:${target.target}`, target);
  }

  return output;
}

function normalizeRefreshKeys(options: {
  value: unknown;
  fieldName: string;
  declaration: ArtifactRequestDeclaration;
}): string[] {
  if (!Array.isArray(options.value)) {
    throw new Error(`Invalid ${options.fieldName}: expected an array.`);
  }

  const declaredKeys = options.declaration.refreshKeys;
  const declaredKeySet = new Set(declaredKeys);
  const seen = new Set<string>();

  for (const [index, key] of options.value.entries()) {
    const refreshKey = ensureNonEmptyString(key, `${options.fieldName}[${index}]`);
    if (!declaredKeySet.has(refreshKey)) {
      throw new Error(
        `Invalid ${options.fieldName}[${index}]: "${refreshKey}" is not declared for artifact "${options.declaration.id}".`,
      );
    }
    if (seen.has(refreshKey)) {
      throw new Error(`Invalid ${options.fieldName}[${index}]: duplicate refresh key "${refreshKey}".`);
    }
    seen.add(refreshKey);
  }

  for (const refreshKey of declaredKeys) {
    if (!seen.has(refreshKey)) {
      throw new Error(
        `Invalid ${options.fieldName}: artifact "${options.declaration.id}" must preserve declared refresh key "${refreshKey}".`,
      );
    }
  }

  return declaredKeys.slice();
}

function validateDisabledReason(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureNonEmptyString(value, fieldName);
}

function validateInstructionArtifactContent(
  value: unknown,
  fieldName: string,
): string {
  return ensureNonEmptyString(value, fieldName);
}

function validateRoleArtifactContent(
  value: unknown,
  fieldName: string,
  roleKey: string,
): CodexAgentRoleArtifact['content'] {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }
  assertAllowedObjectKeys(value, fieldName, ['registration', 'roleFile']);

  const registrationValue = value.registration;
  if (registrationValue !== undefined) {
    if (!isRecord(registrationValue)) {
      throw new Error(`Invalid ${fieldName}.registration: expected an object.`);
    }
    if (Object.hasOwn(registrationValue, 'config_file')) {
      throw new Error(
        `Invalid ${fieldName}.registration.config_file: this field is reserved for AW-managed output.`,
      );
    }
    assertAllowedObjectKeys(registrationValue, `${fieldName}.registration`, ['description']);
    if (
      registrationValue.description !== undefined &&
      (typeof registrationValue.description !== 'string' || registrationValue.description.trim() === '')
    ) {
      throw new Error(`Invalid ${fieldName}.registration.description: expected a non-empty string.`);
    }
  }

  const roleFileValue = value.roleFile;
  if (!isRecord(roleFileValue)) {
    throw new Error(`Invalid ${fieldName}.roleFile: expected an object.`);
  }
  assertAllowedObjectKeys(roleFileValue, `${fieldName}.roleFile`, [
    'name',
    'description',
    'developer_instructions',
    'model',
    'model_reasoning_effort',
  ]);

  const roleFileName = ensureNonEmptyString(roleFileValue.name, `${fieldName}.roleFile.name`);
  validateCodexRoleKey(roleFileName, `${fieldName}.roleFile.name`);
  if (roleFileName !== roleKey) {
    throw new Error(
      `Invalid ${fieldName}.roleFile.name: expected "${roleKey}" to match the declared roleKey.`,
    );
  }
  if (
    roleFileValue.description !== undefined &&
    (typeof roleFileValue.description !== 'string' || roleFileValue.description.trim() === '')
  ) {
    throw new Error(`Invalid ${fieldName}.roleFile.description: expected a non-empty string.`);
  }
  ensureNonEmptyString(
    roleFileValue.developer_instructions,
    `${fieldName}.roleFile.developer_instructions`,
  );
  if (
    roleFileValue.model !== undefined &&
    (typeof roleFileValue.model !== 'string' || roleFileValue.model.trim() === '')
  ) {
    throw new Error(`Invalid ${fieldName}.roleFile.model: expected a non-empty string.`);
  }
  if (
    roleFileValue.model_reasoning_effort !== undefined &&
    (typeof roleFileValue.model_reasoning_effort !== 'string' ||
      roleFileValue.model_reasoning_effort.trim() === '')
  ) {
    throw new Error(
      `Invalid ${fieldName}.roleFile.model_reasoning_effort: expected a non-empty string.`,
    );
  }

  return value as CodexAgentRoleArtifact['content'];
}

function validateSkillArtifactContent(
  value: unknown,
  fieldName: string,
): CodexSkillArtifact['content'] {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }
  assertAllowedObjectKeys(value, fieldName, ['files']);
  if (!isRecord(value.files)) {
    throw new Error(`Invalid ${fieldName}.files: expected an object.`);
  }

  const files: Record<string, string> = {};
  for (const [relativePath, content] of Object.entries(value.files)) {
    if (
      relativePath.trim() === '' ||
      relativePath.includes('\\') ||
      relativePath.startsWith('/') ||
      path.posix.normalize(relativePath) !== relativePath ||
      relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error(
        `Invalid ${fieldName}.files: "${relativePath}" must be a normalized POSIX path inside the skill root.`,
      );
    }
    if (typeof content !== 'string') {
      throw new Error(`Invalid ${fieldName}.files.${relativePath}: expected a string.`);
    }
    files[relativePath] = content;
  }

  const paths = Object.keys(files).sort();
  for (const [index, relativePath] of paths.entries()) {
    const conflictingPrefix = paths
      .slice(0, index)
      .find((candidate) => relativePath.startsWith(`${candidate}/`));
    if (conflictingPrefix) {
      throw new Error(
        `Invalid ${fieldName}.files: file path "${conflictingPrefix}" conflicts with "${relativePath}".`,
      );
    }
  }

  return {
    files,
  };
}

function targetRequiresCodexProjectConfig(target: ArtifactTarget): boolean {
  return target === 'codex.developerInstructionsBlock' || target === 'codex.agentRole';
}

function normalizeArtifact(options: {
  artifact: unknown;
  index: number;
  platform: ArtifactRenderSurfaceName;
  pluginName: string;
  declarationMap: Map<string, ArtifactRequestDeclaration>;
  renderConfig: Pick<ResolvedArtifactRenderConfig, 'values' | 'sources' | 'issues'>;
  digestSalt: string;
}): ValidatedArtifactPlanArtifact {
  const fieldName = `artifacts[${options.index}]`;
  if (!isRecord(options.artifact)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }

  const id = ensureNonEmptyString(options.artifact.id, `${fieldName}.id`);
  validateArtifactId(id, `${fieldName}.id`);

  const target = ensureNonEmptyString(options.artifact.target, `${fieldName}.target`) as ArtifactTarget;
  if (!SUPPORTED_ARTIFACT_TARGETS.has(target)) {
    throw new Error(`Invalid ${fieldName}.target: unsupported target "${target}".`);
  }
  const declaration = options.declarationMap.get(`${id}:${target}`);
  if (!declaration) {
    throw new Error(`Invalid ${fieldName}: artifact "${id}" target "${target}" is not declared for this surface/scope.`);
  }
  if (target === 'aw.command-set' || target === 'aw.command-package') {
    assertAllowedObjectKeys(options.artifact, fieldName, target === 'aw.command-set'
      ? ['id', 'target', 'kind', 'platform', 'state', 'refreshKeys', 'entries', 'disabledReason']
      : ['id', 'target', 'kind', 'state', 'refreshKeys', 'files']);
    if (options.artifact.kind !== (target === 'aw.command-set' ? 'commandSet' : 'commandPackage')) {
      throw new Error(`Invalid ${fieldName}.kind: unexpected command target kind.`);
    }
    if (declaration.platform ? options.artifact.platform !== declaration.platform : Object.hasOwn(options.artifact, 'platform')) {
      throw new Error(`Invalid ${fieldName}.platform: command target must preserve its declared surface.`);
    }
    const state = options.artifact.state;
    if ((state !== 'present' && state !== 'disabled') || !declaration.states.includes(state)) {
      throw new Error(`Invalid ${fieldName}.state: state is not declared.`);
    }
    const refreshKeys = normalizeRefreshKeys({ value: options.artifact.refreshKeys, fieldName: `${fieldName}.refreshKeys`, declaration });
    let normalized: ArtifactPlanArtifact;
    if (target === 'aw.command-set') {
      const entries = normalizeCommandDefinitions(options.artifact.entries, `${fieldName}.entries`);
      if (state === 'disabled' && entries.length !== 0) throw new Error(`Invalid ${fieldName}.entries: disabled sets must be empty.`);
      if (state === 'present' && Object.hasOwn(options.artifact, 'disabledReason')) throw new Error(`Invalid ${fieldName}.disabledReason: only disabled sets may include this field.`);
      const disabledReason = validateDisabledReason(options.artifact.disabledReason, `${fieldName}.disabledReason`);
      normalized = { id, target, kind: 'commandSet', ...(declaration.platform ? { platform: declaration.platform } : {}), state, refreshKeys, entries, ...(disabledReason ? { disabledReason } : {}) };
    } else {
      if (state !== 'present') throw new Error(`Invalid ${fieldName}.state: command packages must be present.`);
      const content = validateSkillArtifactContent({ files: options.artifact.files }, fieldName);
      for (const [file, text] of Object.entries(content?.files ?? {})) {
        normalizeCommandRelativeFile(file, `${fieldName}.files`);
        if (text.includes('\0') || Buffer.from(text, 'utf8').toString('utf8') !== text) throw new Error(`Invalid ${fieldName}.files: generated configuration must be Unicode text without NUL.`);
      }
      normalized = { id, target, kind: 'commandPackage', state: 'present', refreshKeys, files: content?.files ?? {} };
    }
    return { ...normalized, declaration, logicalIdentity: `${options.pluginName}:${id}:${target}`, configDigest: createArtifactConfigDigest({ artifact: normalized, renderConfig: options.renderConfig, digestSalt: options.digestSalt }) };
  }
  assertAllowedObjectKeys(
    options.artifact,
    fieldName,
    target === 'codex.developerInstructionsBlock'
      ? ['id', 'platform', 'target', 'kind', 'state', 'refreshKeys', 'disabledReason', 'content']
      : target === 'codex.agentRole'
        ? ['id', 'platform', 'target', 'kind', 'state', 'refreshKeys', 'disabledReason', 'roleKey', 'content']
        : ['id', target === 'agent-skills.skill' ? 'distribution' : 'platform', 'target', 'kind', 'state', 'refreshKeys', 'disabledReason', 'skillKey', 'content'],
  );

  const surfaceField = target === 'agent-skills.skill' ? 'distribution' : 'platform';
  const surface = ensureNonEmptyString(options.artifact[surfaceField], `${fieldName}.${surfaceField}`) as Exclude<ArtifactRenderSurfaceName, 'managed-commands'>;
  if (surface !== options.platform) {
    throw new Error(
      `Invalid ${fieldName}.${surfaceField}: expected "${options.platform}" but received "${surface}".`,
    );
  }
  const platform = surface === 'agent-skills' ? undefined : surface;
  const distribution = surface === 'agent-skills' ? surface : undefined;

  const kind = ensureNonEmptyString(options.artifact.kind, `${fieldName}.kind`);
  const expectedKind = declaration.kind ?? ARTIFACT_KIND_BY_TARGET[target];
  if (kind !== expectedKind) {
    throw new Error(
      `Invalid ${fieldName}.kind: expected "${expectedKind}" for target "${target}".`,
    );
  }

  const state = ensureNonEmptyString(options.artifact.state, `${fieldName}.state`) as ArtifactState;
  if (!SUPPORTED_ARTIFACT_STATES.has(state)) {
    throw new Error(`Invalid ${fieldName}.state: unsupported state "${state}".`);
  }
  if (!declaration.states.includes(state)) {
    throw new Error(
      `Invalid ${fieldName}.state: "${state}" is not declared for artifact "${id}".`,
    );
  }

  const refreshKeys = normalizeRefreshKeys({
    value: options.artifact.refreshKeys,
    fieldName: `${fieldName}.refreshKeys`,
    declaration,
  });
  const disabledReason = validateDisabledReason(
    options.artifact.disabledReason,
    `${fieldName}.disabledReason`,
  );
  const logicalIdentity = `${options.pluginName}:${id}:${target}`;

  if (target === 'codex.developerInstructionsBlock') {
    const content = state === 'present'
      ? validateInstructionArtifactContent(
          options.artifact.content,
          `${fieldName}.content`,
        )
      : undefined;
    const normalized: DeveloperInstructionsBlockArtifact = {
      id,
      kind: 'instruction',
      platform,
      target,
      state,
      refreshKeys,
      ...(disabledReason === undefined ? {} : { disabledReason }),
      ...(content === undefined ? {} : { content }),
    };
    return {
      ...normalized,
      declaration,
      logicalIdentity,
      configDigest: createArtifactConfigDigest({
        artifact: normalized,
        renderConfig: options.renderConfig,
        digestSalt: options.digestSalt,
      }),
    };
  }

  if (target === 'codex.skill' || target === 'claude.skill' || target === 'agent-skills.skill') {
    const skillKey = ensureNonEmptyString(options.artifact.skillKey, `${fieldName}.skillKey`);
    if (target === 'agent-skills.skill') validatePortableSkillName(skillKey, `${fieldName}.skillKey`);
    else validateCodexSkillKey(skillKey, `${fieldName}.skillKey`);
    if (skillKey !== declaration.skillKey) {
      throw new Error(
        `Invalid ${fieldName}.skillKey: expected "${declaration.skillKey}" from static metadata.`,
      );
    }
    const content = state === 'present'
      ? validateSkillArtifactContent(options.artifact.content, `${fieldName}.content`)
      : undefined;
    const normalized = {
      id,
      kind: 'skill',
      ...(platform ? { platform } : { distribution: distribution! }),
      target,
      state,
      skillKey,
      refreshKeys,
      ...(disabledReason === undefined ? {} : { disabledReason }),
      ...(content === undefined ? {} : { content }),
    } as CodexSkillArtifact | ClaudeSkillArtifact | AgentSkillsSkillArtifact;
    return {
      ...normalized,
      declaration,
      logicalIdentity,
      configDigest: createArtifactConfigDigest({
        artifact: normalized,
        renderConfig: options.renderConfig,
        digestSalt: options.digestSalt,
      }),
    };
  }

  const roleKey = ensureNonEmptyString(options.artifact.roleKey, `${fieldName}.roleKey`);
  validateCodexRoleKey(roleKey, `${fieldName}.roleKey`);
  if (roleKey !== declaration.roleKey) {
    throw new Error(
      `Invalid ${fieldName}.roleKey: expected "${declaration.roleKey}" from static metadata.`,
    );
  }
  const content = state === 'present'
    ? validateRoleArtifactContent(options.artifact.content, `${fieldName}.content`, roleKey)
    : undefined;
  const normalized: CodexAgentRoleArtifact = {
    id,
    kind: 'codexRole',
    platform,
    target,
    state,
    roleKey,
    refreshKeys,
    ...(disabledReason === undefined ? {} : { disabledReason }),
    ...(content === undefined ? {} : { content }),
  };
  return {
    ...normalized,
    declaration,
    logicalIdentity,
    configDigest: createArtifactConfigDigest({
      artifact: normalized,
      renderConfig: options.renderConfig,
      digestSalt: options.digestSalt,
    }),
  };
}

function artifactSortKey(artifact: ValidatedArtifactPlanArtifact): [number, string] {
  const targetIndex = TARGET_ORDER.indexOf(artifact.target);
  return [targetIndex === -1 ? TARGET_ORDER.length : targetIndex, artifact.id];
}

function resolveDigestSalt(options: {
  manifest: NormalizedPluginManifest;
  rendererDigest?: string;
  manifestDigest?: string;
}): string {
  return options.rendererDigest ??
    options.manifestDigest ??
    digestHex({
      name: options.manifest.name,
      version: options.manifest.version,
      scripts: options.manifest.scripts?.artifacts?.render ?? null,
      artifacts: options.manifest.artifacts?.targets ?? null,
    });
}

export function createArtifactConfigDigest(options: {
  artifact: Pick<ArtifactPlanArtifact, 'id' | 'platform' | 'distribution' | 'target' | 'refreshKeys'>;
  renderConfig: Pick<ResolvedArtifactRenderConfig, 'values' | 'sources' | 'issues'>;
  digestSalt: string;
}): string {
  return digestHex({
    digestSalt: options.digestSalt,
    platform: options.artifact.platform,
    distribution: options.artifact.distribution,
    target: options.artifact.target,
    id: options.artifact.id,
    refreshInputs: options.artifact.refreshKeys.map((key) => ({
      key,
      present: Object.hasOwn(options.renderConfig.values, key),
      value: options.renderConfig.values[key],
      source: options.renderConfig.sources[key],
      issues: options.renderConfig.issues.filter((issue) => issue.key === key),
    })),
  });
}

export function validateArtifactPlan(options: {
  pluginName?: string;
  manifest: NormalizedPluginManifest;
  plan: unknown;
  platform: ArtifactRenderSurfaceName;
  scope: Scope;
  requestedArtifactIds: readonly string[];
  renderConfig: Pick<ResolvedArtifactRenderConfig, 'values' | 'sources' | 'issues'>;
  rendererDigest?: string;
  manifestDigest?: string;
}): ValidatedArtifactPlan {
  const pluginName = options.pluginName ?? options.manifest.name;
  const allDeclarations = getDeclaredTargets({
    manifest: options.manifest,
    platform: options.platform,
    scope: options.scope,
  });
  const request = resolveArtifactRequest({
    manifest: options.manifest,
    platform: options.platform,
    scope: options.scope,
    requestedArtifactIds: options.requestedArtifactIds,
  });
  const requestedIds = new Set(request.requestedArtifactIds);
  const declarationMap = new Map(
    [...allDeclarations].filter(([, declaration]) => requestedIds.has(declaration.id)),
  );
  const parsedPlan = resolvePlanObject(options.plan);
  const digestSalt = resolveDigestSalt({
    manifest: options.manifest,
    rendererDigest: options.rendererDigest,
    manifestDigest: options.manifestDigest,
  });

  const artifacts = parsedPlan.artifacts.map((artifact, index) =>
    normalizeArtifact({
      artifact,
      index,
      platform: options.platform,
      pluginName,
      declarationMap,
      renderConfig: options.renderConfig,
      digestSalt,
    })
  );

  const seen = new Set<string>();
  for (const artifact of artifacts) {
    const key = `${artifact.id}:${artifact.target}`;
    if (seen.has(key)) {
      throw new Error(`Invalid artifact plan: duplicate artifact id + target "${key}".`);
    }
    seen.add(key);
  }

  for (const [key, declaration] of declarationMap.entries()) {
    if (!seen.has(key)) {
      throw new Error(
        `Invalid artifact plan: renderer must return artifact "${declaration.id}" target "${declaration.target}" for ${options.platform}/${options.scope}.`,
      );
    }
  }

  artifacts.sort((left, right) => {
    const [leftTargetIndex, leftId] = artifactSortKey(left);
    const [rightTargetIndex, rightId] = artifactSortKey(right);
    if (leftTargetIndex !== rightTargetIndex) {
      return leftTargetIndex - rightTargetIndex;
    }
    return leftId.localeCompare(rightId);
  });

  return {
    version: 2,
    artifacts,
  };
}
