import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import type { CliPromptResult } from '../commands/runtime.js';
import type { PortableSkillCandidate, Scope } from '../types.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { resolveAwProjectRoot } from '../utils/plugin-config.js';
import { getClaudeHome, getCodexHome, resolveAwHome } from '../utils/paths.js';
import {
  canonicalizePathThroughExistingAncestor,
  ensureRegularDirectoryPath,
} from '../utils/state-paths.js';
import {
  materializePortableSkillsFromCatalog,
  type MaterializedPortableSkills,
} from './materializer.js';
import {
  addSkills,
  listInstalledSkills,
  probeSkillsCli,
  SkillsCliError,
  verifySkills,
  type InstalledSkillRecord,
} from './skills-cli.js';

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
}

export interface PortableInstallReceipt {
  receiptSchemaVersion: 4;
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
    missing: Array<{ skill: string; agent?: string }>;
  };
  warnings: string[];
  failures: Array<{ code: string; message: string; recovery: string }>;
}

export type PortableInstallProgressStage = 'prepare' | 'add' | 'verify';

export interface PortableMaterializeReceipt {
  receiptSchemaVersion: 4;
  command: 'skill:materialize';
  ok: true;
  plugin: PortableInstallReceipt['plugin'];
  scope: Scope;
  out: string;
  selectedSkills: PortableSkillCandidate[];
  requestedSkills?: string[];
  dependencies: string[];
  configDigest: string;
  materializationDigest: string;
  outputDigest: string;
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

interface CollectedEvidence {
  materialized: MaterializedPortableSkills;
  review: PortableReview;
}

function digest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function toPublicInstalledRecord(record: InstalledSkillRecord): PublicInstalledSkillRecord {
  return {
    name: record.name,
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    agents: [...record.agents],
  };
}

function publicInstalledRecords(records: readonly InstalledSkillRecord[]): PublicInstalledSkillRecord[] {
  return records.map(toPublicInstalledRecord);
}

function assertScope(scope: string): asserts scope is Scope {
  if (scope !== 'project' && scope !== 'user') {
    throw new Error('scope 必须是 project 或 user。');
  }
}

export function normalizePortableAgents(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  if (values.length === 0 || values.length > 32) {
    throw new PortableCommandError('portableInvalidAgentSelection', 'Agent 选择必须包含 1 到 32 项。');
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || value.length > 128 || value.startsWith('-') || /[\s\p{Cc}]/u.test(value)) {
      throw new PortableCommandError('portableInvalidAgentSelection', `无效 Agent ID：${JSON.stringify(raw)}。`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
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

function classifyMaterializationError(error: unknown): never {
  if (error instanceof PortableCommandError || error instanceof SkillsCliError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('does not declare distributions.agentSkills')) {
    throw new PortableCommandError('portableUnsupported', '插件不支持 Agent Skills distribution。');
  }
  if (message.includes('Portable materialization config is invalid')) {
    throw new PortableCommandError('requiredConfigMissing', '插件缺少生成内容所需的设置，或设置无效。');
  }
  if (message.includes('name collision')) {
    throw new PortableCommandError('portableSkillNameConflict', message);
  }
  if (message.includes('sensitive config') || message.includes('unresolved template')) {
    throw new PortableCommandError('portableSensitiveOutput', 'portable 输出包含敏感值或未解析模板。');
  }
  if (message.includes('runtime import')) {
    throw new PortableCommandError('portableRuntimeImportMissing', 'portable runtime import 缺失或无效。');
  }
  if (message.toLowerCase().includes('renderer')) {
    throw new PortableCommandError('portableRendererFailed', 'portable renderer 执行失败。');
  }
  if (message.includes('Skill') || message.includes('SKILL.md')) {
    throw new PortableCommandError('portableSkillInvalid', 'portable Skill 内容无效。');
  }
  throw error;
}

async function createMaterialization(options: {
  selector: string;
  scope: Scope;
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  configSnapshot: Awaited<ReturnType<typeof readCatalogSourcesConfigSnapshot>>;
}): Promise<MaterializedPortableSkills> {
  try {
    return await materializePortableSkillsFromCatalog({
      selector: options.selector,
      scope: options.scope,
      cwd: options.cwd,
      cliVersion: options.cliVersion,
      env: options.env,
      signal: options.signal,
      configSnapshot: options.configSnapshot,
    });
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    classifyMaterializationError(error);
  }
}

async function collectEvidence(options: {
  selector: string;
  scope: Scope;
  requestedSkills?: string[];
  agents?: string[];
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<CollectedEvidence> {
  const executionCwd = options.scope === 'project' ? resolveAwProjectRoot(options.cwd) : options.cwd;
  const configSnapshot = await readCatalogSourcesConfigSnapshot(options.env);
  const materialized = await createMaterialization({ ...options, configSnapshot });
  try {
    const skillsCli = await probeSkillsCli({ cwd: executionCwd, env: options.env, signal: options.signal });
    const selected = selectCandidates(materialized.candidates, options.requestedSkills);
    const installed = await listInstalledSkills({
      cwd: executionCwd,
      env: options.env,
      signal: options.signal,
      global: options.scope === 'user',
    });
    const names = new Set(selected.map((candidate) => candidate.name));
    const collisions = installed
      .filter((entry) => names.has(entry.name))
      .map((entry) => ({ ...toPublicInstalledRecord(entry), requestedName: entry.name }));
    const evidence = {
      pluginId: materialized.pluginId,
      sourceId: materialized.sourceId,
      sourceIdentity: materialized.sourceIdentity,
      pluginVersion: materialized.pluginVersion,
      scope: options.scope,
      selected,
      requestedSkills: options.requestedSkills,
      agentMode: options.agents ? 'explicit' as const : 'automatic' as const,
      requestedAgents: options.agents ?? [],
      skillsCliVersion: skillsCli.version,
      collisions,
      dependencies: materialized.dependencyPluginIds,
      materializationDigest: materialized.digest,
      configDigest: digest({
        catalogSources: configSnapshot.digest,
        pluginConfig: materialized.configDigest,
      }),
    };
    return {
      materialized,
      review: { ...evidence, evidenceDigest: digest(evidence) },
    };
  } catch (error) {
    await materialized.cleanup();
    throw error;
  }
}

export async function preparePortableInstall(options: {
  selector: string;
  scope: Scope;
  requestedSkills?: string[];
  requestedAgents?: string[];
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<PortableReview> {
  const agents = normalizePortableAgents(options.requestedAgents);
  const collected = await collectEvidence({ ...options, agents });
  try {
    return structuredClone(collected.review);
  } finally {
    await collected.materialized.cleanup();
  }
}

export function renderPortableReview(review: PortableReview): string[] {
  return [
    `插件：${review.pluginId}${review.pluginVersion ? ` @ ${review.pluginVersion}` : ''}`,
    `范围：${review.scope}`,
    `Skill：${review.selected.map((entry) => `${entry.name}（${entry.providerPluginId}）`).join(', ')}`,
    review.agentMode === 'automatic'
      ? 'Agent：自动选择检测到的 Agent；未检测到时可能选择全部 Agent'
      : `Agent：${review.requestedAgents.join(', ')}`,
    `依赖：${review.dependencies.length > 0 ? review.dependencies.join(', ') : '无'}`,
    `同名覆盖：${review.collisions.length > 0
      ? review.collisions.map((entry) => `${entry.name} [${entry.agents.join(', ') || 'unknown'}]`).join('; ')
      : '无'}`,
  ];
}

function installFailureReceipt(
  review: PortableReview,
  code: string,
  status: 'failed' | 'partial',
  verification: PortableInstallReceipt['verification'],
): PortableInstallReceipt {
  return {
    receiptSchemaVersion: 4,
    command: 'skill:install',
    ok: false,
    status,
    plugin: {
      id: review.pluginId,
      ...(review.sourceId ? { sourceId: review.sourceId } : {}),
      ...(review.sourceIdentity ? { sourceIdentity: review.sourceIdentity } : {}),
      ...(review.pluginVersion ? { version: review.pluginVersion } : {}),
    },
    scope: review.scope,
    selectedSkills: review.selected,
    ...(review.requestedSkills ? { requestedSkills: review.requestedSkills } : {}),
    agentMode: review.agentMode,
    requestedAgents: review.requestedAgents,
    skillsCliVersion: review.skillsCliVersion,
    collisions: review.collisions,
    dependencies: review.dependencies,
    materializationDigest: review.materializationDigest,
    verification: { ...verification, records: publicInstalledRecords(verification.records) },
    warnings: [],
    failures: [{
      code,
      message: code === 'portableSkillsCliInstallFailed'
        ? 'skills add 执行失败，可能已写入部分目标。'
        : 'skills add 已完成，但安装验证缺少目标。',
      recovery: '修复问题后重新运行 aw skill install；也可使用 skills remove 清理外部安装。',
    }],
  };
}

export async function installPortableSkills(options: {
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
  onProgress?: (stage: PortableInstallProgressStage) => void | Promise<void>;
}): Promise<PortableInstallReceipt> {
  assertScope(options.scope);
  const scope = options.scope;
  const agents = normalizePortableAgents(options.requestedAgents);
  await options.onProgress?.('prepare');
  const initial = await collectEvidence({ ...options, scope, agents });
  options.onReview?.(initial.review);
  try {
    if (!options.yes) {
      if (!options.confirm) {
        throw new PortableCommandError('confirmationRequired', '安装需要交互确认或 --yes。');
      }
      const confirmed = await options.confirm(initial.review);
      if (confirmed.cancelled || confirmed.value !== true) {
        throw new PortableCommandError('confirmationRequired', '用户未确认安装。');
      }
    }
  } finally {
    await initial.materialized.cleanup();
  }

  return withAwHomeMutationLock({
    env: options.env,
    action: async () => {
      let current: CollectedEvidence;
      try {
        current = await collectEvidence({ ...options, scope, agents });
      } catch (error) {
        if (error instanceof PortableCommandError && error.code === 'portableNoSkillsSelected') {
          throw new PortableCommandError('reviewStale', '确认后的所选 Skill 已消失。');
        }
        throw error;
      }
      try {
        const initialNames = new Set(initial.review.selected.map((entry) => entry.name));
        const currentNames = new Set(current.review.selected.map((entry) => entry.name));
        if ([...initialNames].some((name) => !currentNames.has(name))) {
          throw new PortableCommandError('reviewStale', '确认后的所选 Skill 已消失。');
        }
        if (options.expectedEvidenceDigest
          && current.review.evidenceDigest !== options.expectedEvidenceDigest) {
          throw new PortableCommandError('reviewStale', '确认后的安装证据已变化。');
        }
        if (current.review.evidenceDigest !== initial.review.evidenceDigest && !options.yes) {
          options.onReview?.(current.review);
          const confirmed = await options.confirm?.(current.review);
          if (!confirmed || confirmed.cancelled || confirmed.value !== true) {
            throw new PortableCommandError('reviewStale', '安装证据已变化，且新 Review 未确认。');
          }
        }
        const executionCwd = options.scope === 'project' ? resolveAwProjectRoot(options.cwd) : options.cwd;
        let addFailure: SkillsCliError | undefined;
        try {
          await options.onProgress?.('add');
          await addSkills({
            rootDir: current.materialized.rootDir,
            skills: current.review.selected.map((entry) => entry.name),
            ...(agents ? { agents } : {}),
            global: options.scope === 'user',
            cwd: executionCwd,
            env: options.env,
          });
        } catch (error) {
          if (error instanceof SkillsCliError && error.code === 'portableSkillsCliInstallFailed') {
            addFailure = error;
          } else {
            throw error;
          }
        }
        let verification: PortableInstallReceipt['verification'];
        try {
          await options.onProgress?.('verify');
          verification = await verifySkills({
            skills: current.review.selected.map((entry) => entry.name),
            ...(agents ? { agents } : {}),
            global: options.scope === 'user',
            cwd: executionCwd,
            env: options.env,
          });
        } catch (error) {
          if (error instanceof SkillsCliError) {
            const receipt = installFailureReceipt(
              current.review,
              addFailure?.code ?? 'portableSkillsCliVerificationFailed',
              'partial',
              {
                records: [],
                missing: [],
              },
            );
            receipt.warnings.push('skills list 验证失败，无法确认已写入的目标。');
            if (!addFailure) receipt.failures = [];
            receipt.failures.push({
              code: 'portableSkillsCliVerificationFailed',
              message: 'skills list 验证失败，安装结果为 unknown，无法确认目标是否存在。',
              recovery: '修复 Skills CLI 后重新运行 aw skill install，并按需使用 skills remove 清理外部安装。',
            });
            return receipt;
          }
          throw error;
        }
        if (addFailure) {
          const expectedCount = current.review.selected.length * (agents?.length ?? 1);
          return installFailureReceipt(
            current.review,
            addFailure.code,
            verification.missing.length === expectedCount ? 'failed' : 'partial',
            verification,
          );
        }
        if (verification.missing.length > 0) {
          return installFailureReceipt(
            current.review,
            'portableSkillsCliVerificationFailed',
            'partial',
            verification,
          );
        }
        return {
          ...installFailureReceipt(current.review, '', 'failed', verification),
          ok: true,
          status: 'succeeded',
          failures: [],
        };
      } finally {
        await current.materialized.cleanup();
      }
    },
  });
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
  ) {
    throw new PortableCommandError(
      'portableOutputConflict',
      '已有输出的 pluginId、sourceIdentity 或 scope 不匹配。',
    );
  }
}

async function commitOutput(
  staging: string,
  target: string,
  expected: { pluginId: string; sourceIdentity: string | undefined; scope: Scope },
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
  scope: string;
  out: string;
  requestedSkills?: string[];
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PortableMaterializeReceipt> {
  return withAwHomeMutationLock({
    env: options.env,
    action: async () => {
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
      const materialized = await createMaterialization({ ...options, scope, configSnapshot });
      try {
        const selected = selectCandidates(materialized.candidates, options.requestedSkills);
        await prepareExistingOutput(
          target,
          materialized.pluginId,
          materialized.sourceIdentity,
          options.scope,
        );
        try {
          await ensureRegularDirectoryPath(path.dirname(target), 'portable output parent');
        } catch {
          throw new PortableCommandError('portableOutputConflict', '输出目标的父目录不是安全的普通目录。');
        }
        const staging = await fs.mkdtemp(path.join(path.dirname(target), `.${path.basename(target)}.aw-stage-`));
        let committed = false;
        try {
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
            receiptSchemaVersion: 4,
            command: 'skill:materialize',
            ok: true,
            plugin: {
              id: materialized.pluginId,
              ...(materialized.sourceId ? { sourceId: materialized.sourceId } : {}),
              ...(materialized.sourceIdentity ? { sourceIdentity: materialized.sourceIdentity } : {}),
              ...(materialized.pluginVersion ? { version: materialized.pluginVersion } : {}),
            },
            scope: options.scope,
            out: target,
            selectedSkills: selected,
            ...(options.requestedSkills ? { requestedSkills: options.requestedSkills } : {}),
            dependencies: materialized.dependencyPluginIds,
            configDigest,
            materializationDigest: materialized.digest,
            outputDigest,
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
          await portableCommandTestHooks?.beforeMaterializeOutputCommit?.(target);
          await commitOutput(staging, target, {
            pluginId: materialized.pluginId,
            sourceIdentity: materialized.sourceIdentity,
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
    },
  });
}
