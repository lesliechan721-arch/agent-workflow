import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { isPortablePlatformTarget, type PortablePlatformTarget } from '@lesliechan721/aw-plugin-core';

import type { CliPromptResult } from '../commands/runtime.js';
import type { PortableSkillCandidate, Scope } from '../types.js';
import { resolveCatalogOperationContext, type CatalogOperationContext } from '../utils/catalog-operation-context.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { resolveAwProjectRoot } from '../utils/plugin-config.js';
import { getClaudeHome, getCodexHome, resolveAwHome } from '../utils/paths.js';
import { canonicalizePathThroughExistingAncestor, ensureRegularDirectoryPath } from '../utils/state-paths.js';
import { assertPortablePlatform, materializePortableSkillsFromCatalog, resolvePortableCatalogBindingInput } from './materializer.js';
import { AW_SOURCE_BINDING_FILENAME, writeAwSourceBinding } from '../review/source-binding.js';

export interface PortableSkillTarget { skill: string; agent?: string }
export const SKILLS_CLI_SUPPORTED_VERSION_LABEL = 'AW Portable writer';

export type PortableCommandErrorCode =
  | 'portableUnsupported'
  | 'requiredConfigMissing'
  | 'portableNoSkills'
  | 'portableNoSkillsSelected'
  | 'portableSkillNameConflict'
  | 'portableSkillInvalid'
  | 'portableSensitiveOutput'
  | 'portableRuntimeImportMissing'
  | 'portableRendererFailed'
  | 'portableInvalidAgentSelection'
  | 'portableRetryNotExact'
  | 'portableNoRetryTargets'
  | 'portableOutputConflict'
  | 'confirmationRequired'
  | 'reviewStale';

export class PortableCommandError extends Error {
  constructor(readonly code: PortableCommandErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PortableCommandError';
  }
}

export interface PublicInstalledSkillRecord {
  name: string;
  scope?: string;
  agents: string[];
}

export interface PortableCollision extends PublicInstalledSkillRecord {
  requestedName: string;
}

export interface PortableReview {
  pluginId: string;
  sourceId?: string;
  sourceIdentity?: string;
  pluginVersion?: string;
  scope: Scope;
  selected: PortableSkillCandidate[];
  requestedSkills?: string[];
  agentMode: 'automatic' | 'explicit';
  requestedAgents: string[];
  skillsCliVersion: string;
  collisions: PortableCollision[];
  dependencies: string[];
  materializationDigest: string;
  configDigest: string;
  evidenceDigest: string;
  generationSetDigest: string;
}

export interface PortableInstallReceipt {
  receiptSchemaVersion: 5;
  command: 'skill:install';
  ok: boolean;
  status: 'succeeded' | 'failed' | 'partial';
  plugin: {
    id: string;
    sourceId?: string;
    sourceIdentity?: string;
    version?: string;
  };
  scope: Scope;
  selectedSkills: PortableSkillCandidate[];
  requestedSkills?: string[];
  agentMode: 'automatic' | 'explicit';
  requestedAgents: string[];
  skillsCliVersion: string;
  collisions: PortableCollision[];
  dependencies: string[];
  materializationDigest: string;
  verification: {
    records: PublicInstalledSkillRecord[];
    missing: PortableSkillTarget[];
    unknown?: PortableSkillTarget[];
  };
  attemptedTargets?: PortableSkillTarget[];
  warnings: string[];
  failures: Array<{ code: string; message: string; recovery: string }>;
}

export type PortableInstallProgressStage = 'prepare' | 'add' | 'verify';

export interface PortableRetryTargetGroup {
  agent: string;
  skills: string[];
}

export interface PortableRetryReview extends PortableReview {
  baseEvidenceDigest: string;
  retryPairs: PortableSkillTarget[];
  targetGroups: PortableRetryTargetGroup[];
}

export interface PortableMaterializeReceipt {
  receiptSchemaVersion: 5;
  command: 'skill:materialize';
  ok: true;
  plugin: PortableInstallReceipt['plugin'];
  platform: PortablePlatformTarget;
  scope: Scope;
  out: string;
  selectedSkills: PortableSkillCandidate[];
  requestedSkills?: string[];
  dependencies: string[];
  configDigest: string;
  materializationDigest: string;
  outputDigest: string;
  sourceBindingPath: string;
}

interface PortableMarker extends PortableMaterializeReceipt {
  schemaVersion: 1;
}

export interface PortableCommandTestHooks {
  beforeMaterializeOutputCommit?: (target: string) => Promise<void>;
}

let portableCommandTestHooks: PortableCommandTestHooks | undefined;

export function setPortableCommandTestHooksForTests(
  hooks: PortableCommandTestHooks | undefined,
): void {
  portableCommandTestHooks = hooks;
}

function digest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function assertScope(scope: string): asserts scope is Scope {
  if (scope !== 'project' && scope !== 'user') throw new Error('scope 必须是 project 或 user。');
}

export function normalizePortableAgents(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  if (values.length === 0 || new Set(values).size !== values.length
    || values.some((value) => !isPortablePlatformTarget(value))) {
    throw new PortableCommandError('portableInvalidAgentSelection', '请选择有效的 Portable 平台。');
  }
  return [...values];
}

function removedPortableWorkflow(): never {
  throw new PortableCommandError('portableUnsupported', '此旧安装流程已移除。请设置本机 targets，再使用统一 install 或 sync。');
}

function selectCandidates(
  candidates: readonly PortableSkillCandidate[],
  requested: readonly string[] | undefined,
): PortableSkillCandidate[] {
  if (candidates.length === 0) {
    throw new PortableCommandError('portableNoSkills', '插件及其依赖没有 portable Skill。');
  }
  if (requested === undefined) return [...candidates];
  const names = requested.map((name) => name.trim());
  if (names.length === 0 || names.some((name) => !name)) {
    throw new PortableCommandError('portableNoSkillsSelected', 'Skill 选择不能为空。');
  }
  const requestedNames = new Set(names);
  const selected = candidates.filter((candidate) => requestedNames.has(candidate.name));
  const unknown = [...requestedNames].filter((name) => !candidates.some((candidate) => candidate.name === name));
  if (unknown.length > 0 || selected.length === 0) {
    throw new PortableCommandError(
      'portableNoSkillsSelected',
      `没有找到所选 Skill：${unknown.join(', ') || names.join(', ')}。`,
    );
  }
  return selected;
}

export async function preparePortableInstall(_options: {
  selector: string;
  scope: Scope;
  requestedSkills?: string[];
  requestedAgents?: string[];
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  catalogOperationContext?: CatalogOperationContext;
}): Promise<PortableReview> {
  return removedPortableWorkflow();
}

export async function installPortableSkills(_options: {
  selector: string;
  scope: string;
  requestedSkills?: string[];
  requestedAgents?: string[];
  yes?: boolean;
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  confirm?: (review: PortableReview) => Promise<CliPromptResult<boolean>>;
  onReview?: (review: PortableReview) => void;
  expectedEvidenceDigest?: string;
  expectedGenerationSetDigest?: string;
  onProgress?: (stage: PortableInstallProgressStage) => void | Promise<void>;
}): Promise<PortableInstallReceipt> {
  return removedPortableWorkflow();
}

export async function recheckPortableInstall(_options: {
  receipt: PortableInstallReceipt;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<PortableInstallReceipt> {
  return removedPortableWorkflow();
}

export async function preparePortableRetry(_options: {
  receipt: PortableInstallReceipt;
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  catalogOperationContext?: CatalogOperationContext;
}): Promise<PortableRetryReview> {
  return removedPortableWorkflow();
}

export async function executePortableRetry(_options: {
  receipt: PortableInstallReceipt;
  review: PortableRetryReview;
  expectedEvidenceDigest: string;
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: (stage: PortableInstallProgressStage) => void | Promise<void>;
}): Promise<PortableInstallReceipt> {
  return removedPortableWorkflow();
}

export function renderPortableReview(_review: PortableReview): string[] {
  return removedPortableWorkflow();
}

async function assertNoSymlinks(root: string): Promise<void> {
  const stats = await fs.lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new PortableCommandError('portableOutputConflict', '输出目标必须是普通目录，不能是符号链接。');
  }
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new PortableCommandError('portableOutputConflict', '已有输出含符号链接。');
    }
    if (entry.isDirectory()) await assertNoSymlinks(path.join(root, entry.name));
  }
}

async function assertSafeOutputPath(
  target: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const blocked = new Set([
    path.parse(target).root,
    path.resolve(options.cwd),
    resolveAwProjectRoot(options.cwd),
    path.resolve(os.homedir()),
    path.resolve(resolveAwHome(options.env)),
    path.resolve(getCodexHome(options.env)),
    path.resolve(getClaudeHome(options.env)),
  ]);
  if (blocked.has(target)) {
    throw new PortableCommandError('portableOutputConflict', '输出目标范围过宽。');
  }
  const canonicalTarget = await canonicalizePathThroughExistingAncestor(target);
  const canonicalBlocked = await Promise.all([...blocked].map((entry) =>
    canonicalizePathThroughExistingAncestor(entry)));
  if (canonicalBlocked.includes(canonicalTarget)) {
    throw new PortableCommandError('portableOutputConflict', '输出目标范围过宽。');
  }
}

async function prepareExistingOutput(
  target: string,
  pluginId: string,
  sourceIdentity: string | undefined,
  scope: Scope,
  platform: PortablePlatformTarget,
): Promise<void> {
  if (!await fs.pathExists(target)) return;
  await assertNoSymlinks(target);
  const markerPath = path.join(target, '.aw-materialization.json');
  const markerStats = await fs.lstat(markerPath).catch(() => undefined);
  if (!markerStats?.isFile() || markerStats.isSymbolicLink()) {
    throw new PortableCommandError('portableOutputConflict', '已有输出没有有效 AW marker。');
  }
  const marker = await fs.readJson(markerPath).catch(() => undefined) as Partial<PortableMarker> | undefined;
  if (
    marker?.schemaVersion !== 1
    || marker.plugin?.id !== pluginId
    || sourceIdentity === undefined
    || marker.plugin?.sourceIdentity !== sourceIdentity
    || marker.scope !== scope
    || marker.platform !== platform
  ) {
    throw new PortableCommandError(
      'portableOutputConflict',
      '已有输出的 pluginId、sourceIdentity、platform 或 scope 不匹配。',
    );
  }
}

async function commitOutput(
  staging: string,
  target: string,
  expected: { pluginId: string; sourceIdentity: string | undefined; scope: Scope; platform: PortablePlatformTarget },
): Promise<void> {
  const existing = await fs.lstat(target).catch(() => undefined);
  const backup = `${target}.aw-backup-${crypto.randomBytes(6).toString('hex')}`;
  if (existing) {
    await fs.rename(target, backup);
    try {
      await prepareExistingOutput(
        backup,
        expected.pluginId,
        expected.sourceIdentity,
        expected.scope,
        expected.platform,
      );
    } catch {
      const replacement = await fs.lstat(target).catch(() => undefined);
      if (!replacement) {
        await fs.rename(backup, target).catch(() => undefined);
      }
      throw new PortableCommandError(
        'portableOutputConflict',
        '提交前输出身份发生变化；原输出已保留。',
      );
    }
  }
  try {
    await fs.rename(staging, target);
  } catch (error) {
    if (existing && !await fs.lstat(target).catch(() => undefined)) {
      await fs.rename(backup, target).catch(() => undefined);
    }
    throw error;
  }
  if (existing) await fs.remove(backup).catch(() => undefined);
}

export async function materializePortableSkillsToDirectory(options: {
  selector: string;
  platform: PortablePlatformTarget;
  scope: string;
  out: string;
  requestedSkills?: string[];
  /** Recovery may prepare an empty deployment to remove its obsolete owned Skills. */
  allowEmpty?: boolean;
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  catalogOperationContext?: CatalogOperationContext;
}): Promise<PortableMaterializeReceipt> {
  assertPortablePlatform(options.platform);
  assertScope(options.scope);
  const scope = options.scope;
  const rawTarget = path.resolve(options.cwd, options.out);
  const rawTargetStats = await fs.lstat(rawTarget).catch(() => undefined);
  if (rawTargetStats?.isSymbolicLink()) {
    throw new PortableCommandError('portableOutputConflict', '输出目标不能是符号链接。');
  }
  const target = await canonicalizePathThroughExistingAncestor(rawTarget);
  await assertSafeOutputPath(target, options);
  const configSnapshot = await readCatalogSourcesConfigSnapshot(options.env);
  const parsedSelector = parsePluginId(options.selector);
  const catalogOperationContext = options.catalogOperationContext ?? await resolveCatalogOperationContext({
    ...(parsedSelector.sourceId ? { sourceIds: [parsedSelector.sourceId] } : {}),
    env: options.env,
  });
  const materialized = await materializePortableSkillsFromCatalog({
    ...options,
    scope,
    configSnapshot,
    catalogOperationContext,
  });
  try {
    const selected = options.allowEmpty && options.requestedSkills === undefined && materialized.candidates.length === 0
      ? [] : selectCandidates(materialized.candidates, options.requestedSkills);
    await prepareExistingOutput(
      target,
      materialized.pluginId,
      materialized.sourceIdentity,
      options.scope,
      options.platform,
    );
    try {
      await ensureRegularDirectoryPath(path.dirname(target), 'portable output parent');
    } catch {
      throw new PortableCommandError('portableOutputConflict', '输出目标的父目录不是安全的普通目录。');
    }
    const stagingPrefix = path.join(path.dirname(target), `.${path.basename(target)}.aw-stage-`);
    // Node's mkdtemp does not add the Windows extended-length prefix itself.
    const createdStaging = await fs.mkdtemp(path.toNamespacedPath(stagingPrefix));
    const staging = path.join(path.dirname(target), path.basename(createdStaging));
    let committed = false;
    try {
      await fs.ensureDir(path.join(staging, 'skills'));
      for (const candidate of selected) {
        await fs.copy(
          path.join(materialized.rootDir, 'skills', candidate.name),
          path.join(staging, 'skills', candidate.name),
          { dereference: false, errorOnExist: true },
        );
      }
      await assertNoSymlinks(staging);
      const outputDigest = digest(selected.map((entry) => [entry.name, entry.filesDigest]));
      const configDigest = digest({
        catalogSources: configSnapshot.digest,
        pluginConfig: materialized.configDigest,
      });
      const receipt: PortableMaterializeReceipt = {
        receiptSchemaVersion: 5,
        command: 'skill:materialize',
        ok: true,
        plugin: {
          id: materialized.pluginId,
          ...(materialized.sourceId ? { sourceId: materialized.sourceId } : {}),
          ...(materialized.sourceIdentity ? { sourceIdentity: materialized.sourceIdentity } : {}),
          ...(materialized.pluginVersion ? { version: materialized.pluginVersion } : {}),
        },
        platform: options.platform,
        scope: options.scope,
        out: target,
        selectedSkills: selected,
        ...(options.requestedSkills ? { requestedSkills: options.requestedSkills } : {}),
        dependencies: materialized.dependencyPluginIds,
        configDigest,
        materializationDigest: materialized.digest,
        outputDigest,
        sourceBindingPath: path.join(target, AW_SOURCE_BINDING_FILENAME),
      };
      const marker: PortableMarker & {
        config: { digest: string; catalogSourcesDigest: string; pluginConfigDigest: string };
      } = {
        schemaVersion: 1,
        ...receipt,
        config: {
          digest: configDigest,
          catalogSourcesDigest: configSnapshot.digest,
          pluginConfigDigest: materialized.configDigest,
        },
      };
      await fs.writeJson(path.join(staging, '.aw-materialization.json'), marker, { spaces: 2 });
      if (!materialized.sourceBindingSource) {
        throw new Error('Portable Catalog materialization is missing validated snapshot identity.');
      }
      await writeAwSourceBinding({
        rootDir: staging,
        source: materialized.sourceBindingSource,
        subject: { plugin: materialized.pluginId.split('/').at(-1)! },
        profile: {
          kind: 'portable',
          id: `${options.platform}-${scope}`,
          platform: options.platform,
          scope,
          inputDigest: materialized.configDigest,
        },
        artifacts: selected.map((candidate) => ({
          kind: 'portable-skill' as const,
          plugin: parsePluginId(candidate.providerPluginId).pluginName,
          skill: candidate.name,
          path: `skills/${candidate.name}`,
        })),
      });
      await portableCommandTestHooks?.beforeMaterializeOutputCommit?.(target);
      const currentConfigSnapshot = await readCatalogSourcesConfigSnapshot(options.env);
      const currentCatalogOperationContext = await resolveCatalogOperationContext({
        ...(parsedSelector.sourceId ? { sourceIds: [parsedSelector.sourceId] } : {}),
        configSnapshot: currentConfigSnapshot,
        env: options.env,
      });
      const currentBinding = await resolvePortableCatalogBindingInput({
        selector: options.selector,
        platform: options.platform,
        scope,
        cwd: options.cwd,
        cliVersion: options.cliVersion,
        env: options.env,
        configSnapshot: currentConfigSnapshot,
        catalogOperationContext: currentCatalogOperationContext,
      });
      if (
        JSON.stringify(currentBinding.source) !== JSON.stringify(materialized.sourceBindingSource)
        || currentBinding.profile.inputDigest !== materialized.configDigest
        || currentBinding.subject.plugin !== materialized.pluginId.split('/').at(-1)
      ) {
        throw new PortableCommandError('reviewStale', 'portable source 或 profile 在输出准备期间发生变化。');
      }
      await commitOutput(staging, target, {
        pluginId: materialized.pluginId,
        sourceIdentity: materialized.sourceIdentity,
        platform: options.platform,
        scope: options.scope,
      });
      committed = true;
      return receipt;
    } finally {
      if (!committed) await fs.remove(staging);
    }
  } finally {
    await materialized.cleanup();
  }
}
