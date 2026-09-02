import crypto from 'node:crypto';

import { tryParseStrictSemVer } from './manifest.js';

export const CODEX_NATIVE_RENDER_RECEIPT_PATH = '.agents-plugin/aw-codex-native-render.json';
export const CODEX_NATIVE_RENDER_RECEIPT_SCHEMA_VERSION = 1;
export const CODEX_NATIVE_RENDER_RECEIPT_KIND = 'aw-codex-native-render';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ARTIFACT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/u;
const SKILL_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const LOGICAL_PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface CodexNativeRenderTargetReceipt {
  id: string;
  skillKey: string;
  configDigest: string;
  artifactDigest: string;
}

export interface CodexNativeRenderProjection {
  logicalPluginId: string;
  strategy: 'shared-user';
  sourceIdentity: string;
  pluginVersion: string;
  renderInputDigest: string;
  rendererDigest: string;
  configDigest: string;
  targets: CodexNativeRenderTargetReceipt[];
}

export interface CodexNativeRenderReceipt extends CodexNativeRenderProjection {
  schemaVersion: 1;
  kind: 'aw-codex-native-render';
  payloadDigest: string;
}

export interface CreateCodexNativeRenderProjectionInput {
  logicalPluginId: string;
  sourceIdentity: string;
  pluginVersion: string;
  rendererDigest: string;
  targets: readonly CodexNativeRenderTargetReceipt[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  fieldName: string,
): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.length !== normalizedExpected.length
    || actual.some((key, index) => key !== normalizedExpected[index])) {
    throw new Error(`Invalid ${fieldName}: expected exactly ${normalizedExpected.join(', ')}.`);
  }
}

function assertDigest(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a SHA-256 digest.`);
  }
  return value;
}

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw new Error(`Invalid ${fieldName}: expected a non-empty canonical string.`);
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeTargets(value: unknown, fieldName = 'targets'): CodexNativeRenderTargetReceipt[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid ${fieldName}: expected a non-empty array.`);
  }
  const ids = new Set<string>();
  const skillKeys = new Set<string>();
  const targets = value.map((entry, index): CodexNativeRenderTargetReceipt => {
    const targetField = `${fieldName}[${index}]`;
    if (!isRecord(entry)) throw new Error(`Invalid ${targetField}: expected an object.`);
    assertExactKeys(entry, ['id', 'skillKey', 'configDigest', 'artifactDigest'], targetField);
    const id = assertString(entry.id, `${targetField}.id`);
    const skillKey = assertString(entry.skillKey, `${targetField}.skillKey`);
    if (!ARTIFACT_ID_PATTERN.test(id)) {
      throw new Error(`Invalid ${targetField}.id: expected a stable artifact id.`);
    }
    if (!SKILL_KEY_PATTERN.test(skillKey)) {
      throw new Error(`Invalid ${targetField}.skillKey: expected a stable Codex Skill key.`);
    }
    if (ids.has(id)) throw new Error(`Invalid ${fieldName}: duplicate target id "${id}".`);
    if (skillKeys.has(skillKey)) {
      throw new Error(`Invalid ${fieldName}: duplicate target skillKey "${skillKey}".`);
    }
    ids.add(id);
    skillKeys.add(skillKey);
    return {
      id,
      skillKey,
      configDigest: assertDigest(entry.configDigest, `${targetField}.configDigest`),
      artifactDigest: assertDigest(entry.artifactDigest, `${targetField}.artifactDigest`),
    };
  });
  return targets.sort((left, right) =>
    compareText(left.id, right.id) || compareText(left.skillKey, right.skillKey));
}

function normalizeIdentity(value: unknown): string {
  const logicalPluginId = assertString(value, 'logicalPluginId');
  if (!LOGICAL_PLUGIN_ID_PATTERN.test(logicalPluginId)) {
    throw new Error('Invalid logicalPluginId: expected a canonical source/plugin ID.');
  }
  return logicalPluginId;
}

export function calculateCodexNativeRenderConfigDigest(
  targets: readonly CodexNativeRenderTargetReceipt[],
): string {
  const normalized = normalizeTargets(targets);
  return digest(normalized.map(({ id, skillKey, configDigest }) => ({ id, skillKey, configDigest })));
}

export function calculateCodexNativeRenderInputDigest(
  input: Omit<CodexNativeRenderProjection, 'renderInputDigest' | 'configDigest'>,
): string {
  const targets = normalizeTargets(input.targets);
  if (input.strategy !== 'shared-user') {
    throw new Error('Invalid strategy: expected shared-user.');
  }
  if (!tryParseStrictSemVer(input.pluginVersion)) {
    throw new Error('Invalid pluginVersion: expected strict SemVer.');
  }
  const rendererDigest = assertDigest(input.rendererDigest, 'rendererDigest');
  return digest({
    logicalPluginId: normalizeIdentity(input.logicalPluginId),
    strategy: input.strategy,
    sourceIdentity: assertDigest(input.sourceIdentity, 'sourceIdentity'),
    pluginVersion: input.pluginVersion,
    rendererDigest,
    targets,
  });
}

export function createCodexNativeRenderProjection(
  input: CreateCodexNativeRenderProjectionInput,
): CodexNativeRenderProjection {
  const logicalPluginId = normalizeIdentity(input.logicalPluginId);
  const sourceIdentity = assertDigest(input.sourceIdentity, 'sourceIdentity');
  if (!tryParseStrictSemVer(input.pluginVersion)) {
    throw new Error('Invalid pluginVersion: expected strict SemVer.');
  }
  const rendererDigest = assertDigest(input.rendererDigest, 'rendererDigest');
  const targets = normalizeTargets(input.targets);
  const base = {
    logicalPluginId,
    strategy: 'shared-user' as const,
    sourceIdentity,
    pluginVersion: input.pluginVersion,
    rendererDigest,
    targets,
  };
  return {
    ...base,
    renderInputDigest: calculateCodexNativeRenderInputDigest(base),
    configDigest: calculateCodexNativeRenderConfigDigest(targets),
  };
}

export function createCodexNativeRenderReceipt(
  input: CreateCodexNativeRenderProjectionInput & { payloadDigest: string },
): CodexNativeRenderReceipt {
  return {
    schemaVersion: CODEX_NATIVE_RENDER_RECEIPT_SCHEMA_VERSION,
    kind: CODEX_NATIVE_RENDER_RECEIPT_KIND,
    ...createCodexNativeRenderProjection(input),
    payloadDigest: assertDigest(input.payloadDigest, 'payloadDigest'),
  };
}

export function parseCodexNativeRenderReceipt(value: string | unknown): CodexNativeRenderReceipt {
  let raw: unknown = value;
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value) as unknown;
    } catch {
      throw new Error('Invalid Codex native render receipt: expected valid JSON.');
    }
  }
  if (!isRecord(raw)) throw new Error('Invalid Codex native render receipt: expected an object.');
  assertExactKeys(raw, [
    'schemaVersion', 'kind', 'logicalPluginId', 'strategy', 'sourceIdentity', 'pluginVersion',
    'renderInputDigest', 'rendererDigest', 'configDigest', 'targets', 'payloadDigest',
  ], 'Codex native render receipt');
  if (raw.schemaVersion !== CODEX_NATIVE_RENDER_RECEIPT_SCHEMA_VERSION) {
    throw new Error('Invalid Codex native render receipt schemaVersion.');
  }
  if (raw.kind !== CODEX_NATIVE_RENDER_RECEIPT_KIND) {
    throw new Error('Invalid Codex native render receipt kind.');
  }
  if (raw.strategy !== 'shared-user') {
    throw new Error('Invalid Codex native render receipt strategy.');
  }
  const projection = createCodexNativeRenderProjection({
    logicalPluginId: raw.logicalPluginId as string,
    sourceIdentity: raw.sourceIdentity as string,
    pluginVersion: raw.pluginVersion as string,
    rendererDigest: raw.rendererDigest as string,
    targets: raw.targets as CodexNativeRenderTargetReceipt[],
  });
  const renderInputDigest = assertDigest(raw.renderInputDigest, 'renderInputDigest');
  const configDigest = assertDigest(raw.configDigest, 'configDigest');
  if (renderInputDigest !== projection.renderInputDigest) {
    throw new Error('Invalid Codex native render receipt renderInputDigest binding.');
  }
  if (configDigest !== projection.configDigest) {
    throw new Error('Invalid Codex native render receipt configDigest binding.');
  }
  return {
    schemaVersion: CODEX_NATIVE_RENDER_RECEIPT_SCHEMA_VERSION,
    kind: CODEX_NATIVE_RENDER_RECEIPT_KIND,
    ...projection,
    payloadDigest: assertDigest(raw.payloadDigest, 'payloadDigest'),
  };
}

export function serializeCodexNativeRenderReceipt(receipt: CodexNativeRenderReceipt): string {
  return `${JSON.stringify(parseCodexNativeRenderReceipt(receipt), null, 2)}\n`;
}

export function codexNativeRenderProjectionsEqual(
  left: CodexNativeRenderProjection,
  right: CodexNativeRenderProjection,
): boolean {
  const comparable = (value: CodexNativeRenderProjection): CodexNativeRenderProjection => ({
    logicalPluginId: value.logicalPluginId,
    strategy: value.strategy,
    sourceIdentity: value.sourceIdentity,
    pluginVersion: value.pluginVersion,
    renderInputDigest: value.renderInputDigest,
    rendererDigest: value.rendererDigest,
    configDigest: value.configDigest,
    targets: value.targets,
  });
  return stableStringify(comparable(left)) === stableStringify(comparable(right));
}
