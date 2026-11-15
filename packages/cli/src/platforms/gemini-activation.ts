import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';

import { atomicReplaceSafeFile, assertSafeFileMutationPath } from '../utils/safe-fs.js';
import { readSkillOwnerMarker, type OwnerIdentity } from '../utils/ownership.js';
import { readEnvironmentValue, resolveUserHome } from '../utils/state-paths.js';
import { readPlatformPackageContentDigest } from '../utils/platform-empty-state.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';
import type { DeploymentBinding, DeploymentObservation, FrozenDeploymentPlan, MutationContext, MutationOutcome, NativeIdentity, PreparationEvidence, ReadContext } from './contracts.js';

export const geminiReplacementMessages = {
  nativeRefreshDataUnconfirmed: 'The installed Gemini copy has unconfirmed ownership or contains data outside its recorded AW package. No native replacement was started. Preserve any local settings or files before repairing the installation.',
  nativeInstallContentPostcheckFailed: 'The Gemini native copy could not be confirmed against the frozen AW package. The AW source and reviewed activation rules were retained. Inspect the native installation before retrying.',
};
const installMetadataFile = '.gemini-extension-install.json';

export interface GeminiActivationSnapshot {
  path: string;
  content: string | null;
}
interface ExtensionEnablement extends Record<string, unknown> { overrides: string[] }
type EnablementConfig = Record<string, ExtensionEnablement>;

function fail(code: string): never { throw Object.assign(new Error(code), { code, mutation: 'none' }); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('nativeConfigInvalid');
  return value as Record<string, unknown>;
}
export function geminiExtensionPaths(ctx: ReadContext): { home: string; root: string; file: string } {
  const env = ctx.env ?? process.env;
  const home = readEnvironmentValue(env, 'GEMINI_CLI_HOME', ctx.platform) || resolveUserHome(env, ctx.platform);
  const root = path.join(home, '.gemini', 'extensions');
  return { home, root, file: path.join(root, 'extension-enablement.json') };
}
export function geminiActivationEvidence(snapshot: GeminiActivationSnapshot): NonNullable<MutationContext['geminiActivationSnapshot']> {
  return { path: snapshot.path, contentDigest: snapshot.content === null ? null
    : `sha256:${crypto.createHash('sha256').update(snapshot.content).digest('hex')}` };
}
export async function readGeminiActivationSnapshot(ctx: ReadContext,
  expected?: MutationContext['geminiActivationSnapshot']): Promise<GeminiActivationSnapshot> {
  const { home, file } = geminiExtensionPaths(ctx);
  await assertSafeFileMutationPath({ filePath: file, allowedRoot: home, label: 'Gemini extension activation' });
  let content: string | null;
  try { content = await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') content = null; else throw error; }
  const snapshot = { path: file, content };
  if (expected && (expected.path !== file || expected.contentDigest !== geminiActivationEvidence(snapshot).contentDigest)) fail('operationPlanStale');
  return snapshot;
}
function config(snapshot: GeminiActivationSnapshot): EnablementConfig {
  let value: Record<string, unknown> = {};
  if (snapshot.content !== null) {
    try { value = object(JSON.parse(snapshot.content)); }
    catch { fail('nativeConfigInvalid'); }
  }
  // The native installer reads the entire map. Reject invalid sibling entries
  // before it can replace a failed parse with an empty configuration.
  for (const entry of Object.values(value)) {
    const overrides = object(entry).overrides;
    if (!Array.isArray(overrides) || !overrides.every((rule) => typeof rule === 'string')) fail('nativeConfigInvalid');
  }
  return value as EnablementConfig;
}
export function geminiScopePattern(location: string): string {
  const normalized = location.replaceAll('\\', '/');
  if (normalized.includes('*') || normalized.startsWith('//?/') || normalized.startsWith('//./')) fail('nativeActivationEvidenceUnknown');
  return `${normalized.startsWith('/') ? '' : '/'}${normalized.replace(/\/$/u, '')}/*`;
}
function pattern(rule: string): string { return rule.startsWith('!') ? rule.slice(1) : rule; }
function expression(rule: string): RegExp {
  return new RegExp(`^${pattern(rule).replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/(\/?)\*/gu, '($1.*)?')}$`, 'u');
}
export function geminiActivationRules(snapshot: GeminiActivationSnapshot, id: string): string[] {
  const rules = config(snapshot)[id]?.overrides ?? [];
  let pathRuleSeen = false;
  for (const rule of rules) {
    const value = pattern(rule);
    if (value === '*') {
      if (pathRuleSeen) fail('nativeActivationEvidenceUnknown');
      continue;
    }
    pathRuleSeen = true;
    if (value === '/*' || !value.startsWith('/') || !value.endsWith('/*') || value.slice(0, -1).includes('*')
      || value.includes('\\') || value.startsWith('//?/') || value.startsWith('//./')
      || /\/(?:\.|\.\.)\//u.test(value) || value.slice(2).includes('//')) fail('nativeActivationEvidenceUnknown');
  }
  return rules;
}
export function geminiPathEnabled(rules: readonly string[], location: string): boolean {
  const currentPath = geminiScopePattern(location).slice(0, -1);
  let enabled = true;
  for (const rule of rules) if (expression(rule).test(currentPath)) enabled = !rule.startsWith('!');
  return enabled;
}
/** Global intent is distinct from the enabled state at one home directory. */
export function geminiUserActivation(snapshot: GeminiActivationSnapshot, id: string, home: string): boolean | 'unknown' {
  const rules = geminiActivationRules(snapshot, id);
  let enabled = true;
  for (const rule of rules) if (pattern(rule) === '*') enabled = !rule.startsWith('!');
  const homePattern = geminiScopePattern(home);
  const homeRule = rules.filter((rule) => pattern(rule) === homePattern).at(-1);
  if (homeRule !== undefined && (!homeRule.startsWith('!')) !== enabled) return 'unknown';
  const homeIndex = homeRule === undefined ? -1 : rules.lastIndexOf(homeRule);
  if (homeIndex >= 0 && rules.slice(0, homeIndex).some((rule) => pattern(rule) !== homePattern
    && pattern(rule) !== '*' && expression(homePattern).test(pattern(rule).slice(0, -1)))) return 'unknown';
  return enabled;
}
export async function assertGeminiProjectRules(ctx: ReadContext, binding: DeploymentBinding, rules: readonly string[]): Promise<void> {
  if (binding.scope.kind !== 'project') return;
  const target = geminiScopePattern(binding.scope.projectRoot);
  if (target === '/*' || target === geminiScopePattern(geminiExtensionPaths(ctx).home)) fail('nativeActivationEvidenceUnknown');
  const canonical = await fs.realpath(binding.scope.projectRoot);
  if (geminiScopePattern(canonical) !== target) fail('nativeActivationEvidenceUnknown');
  for (const rule of rules) {
    const value = pattern(rule);
    if (value === '*' || value === target) continue;
    let location = value.slice(0, -2);
    if ((ctx.platform ?? process.platform) === 'win32' && /^\/[A-Za-z]:\//u.test(location)) location = location.slice(1);
    const resolved = await fs.realpath(location).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (resolved && geminiScopePattern(resolved) === target) fail('nativeActivationEvidenceUnknown');
  }
}
export async function assertGeminiNativeOwner(ctx: ReadContext, binding: DeploymentBinding, identity: NativeIdentity, evidence: PreparationEvidence): Promise<void> {
  if (identity.route !== 'gemini-extension' || identity.sourceLocation !== evidence.layout.packageRoot) fail('nativeIdentityUnconfirmed');
  const component = evidence.ownership.find((slot) => slot.component.kind === 'owned-directory'
    && slot.component.path === identity.sourceLocation)?.component;
  if (component?.kind !== 'owned-directory' || component.identity.sourceId !== binding.plugin.sourceId
    || component.identity.sourceIdentity !== binding.plugin.sourceIdentity || component.identity.pluginId !== binding.plugin.pluginId
    || component.identity.physicalKey !== binding.physicalKey
    || !await readSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, expectedIdentity: component.identity })) fail('nativeIdentityUnconfirmed');
  const directory = path.join(geminiExtensionPaths(ctx).root, identity.packageId);
  for (const file of ['gemini-extension.json', '.gemini-extension-install.json']) {
    await assertSafeFileMutationPath({ filePath: path.join(directory, file), allowedRoot: geminiExtensionPaths(ctx).home, label: 'Gemini extension identity' });
  }
  const metadata = object(await fs.readJson(path.join(directory, '.gemini-extension-install.json')));
  const manifest = object(await fs.readJson(path.join(directory, 'gemini-extension.json')));
  if (!['local', 'link'].includes(String(metadata.type)) || metadata.source !== identity.sourceLocation || manifest.name !== identity.packageId) fail('nativeIdentityUnconfirmed');
}

/** Unknown or locally modified copies never confirm current installed content. */
export async function readGeminiNativeCopyContentDigest(ctx: ReadContext, identity: NativeIdentity,
  expectedIdentity: OwnerIdentity): Promise<string | undefined> {
  try {
    const { home, root } = geminiExtensionPaths(ctx);
    const directory = path.join(root, identity.packageId);
    await assertSafeFileMutationPath({ filePath: path.join(directory, installMetadataFile), allowedRoot: home, label: 'Gemini extension identity' });
    if (await fs.pathExists(path.join(directory, '.env'))) return undefined;
    const marker = await readSkillOwnerMarker({ skillRoot: directory, allowedRoot: root, expectedIdentity });
    if (!marker?.nativeProjection) return undefined;
    const digest = await readPlatformPackageContentDigest(directory, { excludeRootFiles: [installMetadataFile] });
    return digest === marker.nativeProjection.contentDigest ? digest : undefined;
  } catch (error) { rethrowFatalError(error); ctx.signal?.throwIfAborted(); return undefined; }
}

/** A copied old marker proves only its own recorded bytes, never the new source bytes. */
export async function geminiRefreshNeedsReplacement(ctx: ReadContext, binding: DeploymentBinding, identity: NativeIdentity,
  evidence: PreparationEvidence, before: DeploymentObservation): Promise<boolean> {
  await assertGeminiNativeOwner(ctx, binding, identity, evidence);
  const directory = path.join(geminiExtensionPaths(ctx).root, identity.packageId);
  const manifest = object(await fs.readJson(path.join(directory, 'gemini-extension.json')));
  if (typeof manifest.version !== 'string') fail('nativeIdentityUnconfirmed');
  if (manifest.version !== binding.plugin.version) return false;
  if (before.ownership !== 'aw' || before.registration !== 'present'
    || before.nativeIdentity?.packageId !== identity.packageId
    || before.nativeIdentity.sourceLocation !== identity.sourceLocation) fail('nativeIdentityUnconfirmed');
  try {
    const component = evidence.ownership.find((slot) => slot.component.kind === 'owned-directory'
      && slot.component.path === identity.sourceLocation)?.component;
    if (component?.kind !== 'owned-directory') fail('nativeRefreshDataUnconfirmed');
    if (!await readGeminiNativeCopyContentDigest(ctx, identity, component.identity)) fail('nativeRefreshDataUnconfirmed');
  } catch (error) { rethrowFatalError(error); ctx.signal?.throwIfAborted(); fail('nativeRefreshDataUnconfirmed'); }
  return true;
}

export async function assertGeminiRefreshSource(plan: FrozenDeploymentPlan): Promise<void> {
  const bundles = plan.projections.flatMap((projection) => projection.bundle ? [projection.bundle] : []);
  if (bundles.length !== 1 || await readPlatformPackageContentDigest(bundles[0]!.stagingRoot) !== bundles[0]!.contentDigest
    || await readPlatformPackageContentDigest(plan.evidence.layout.packageRoot) !== bundles[0]!.contentDigest) fail('operationPlanStale');
}

/** Check the real native directory, including removed/extra files, after replacement. */
export async function assertGeminiReplacementContent(ctx: ReadContext, plan: FrozenDeploymentPlan, identity: NativeIdentity): Promise<void> {
  await assertGeminiRefreshSource(plan);
  const bundle = plan.projections.find((projection) => projection.bundle)?.bundle;
  const component = plan.evidence.ownership.find((slot) => slot.component.kind === 'owned-directory'
    && slot.component.path === identity.sourceLocation)?.component;
  try {
    await assertGeminiNativeOwner(ctx, plan.binding, identity, plan.evidence);
    if (!bundle || component?.kind !== 'owned-directory') fail('nativeInstallContentPostcheckFailed');
    if (await readGeminiNativeCopyContentDigest(ctx, identity, component.identity) !== bundle.contentDigest) fail('nativeInstallContentPostcheckFailed');
  } catch (error) { rethrowFatalError(error); ctx.signal?.throwIfAborted(); fail('nativeInstallContentPostcheckFailed'); }
}
async function writeConfig(ctx: ReadContext, baseline: GeminiActivationSnapshot, value: EnablementConfig): Promise<MutationOutcome> {
  const current = await readGeminiActivationSnapshot(ctx);
  if (current.path !== baseline.path || current.content !== baseline.content) fail('operationPlanStale');
  if (JSON.stringify(config(current)) === JSON.stringify(value)) return { changed: false, mutation: 'none' };
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await atomicReplaceSafeFile({ filePath: baseline.path, allowedRoot: geminiExtensionPaths(ctx).home,
    content, label: 'Gemini extension activation', beforeRename: async () => {
      if ((await readGeminiActivationSnapshot(ctx)).content !== baseline.content) fail('operationPlanStale');
    } });
  baseline.content = content;
  return { changed: true, mutation: 'confirmed' };
}
function activationConfig(ctx: ReadContext, snapshot: GeminiActivationSnapshot, binding: DeploymentBinding,
  id: string, userEnabled: boolean, enabled: boolean): EnablementConfig {
  const value = config(snapshot);
  const home = geminiScopePattern(geminiExtensionPaths(ctx).home);
  const target = binding.scope.kind === 'project' ? geminiScopePattern(binding.scope.projectRoot) : null;
  const retained = geminiActivationRules(snapshot, id).filter((rule) => pattern(rule) !== '*'
    && pattern(rule) !== home && (!target || pattern(rule) !== target));
  if (target && enabled) {
    const firstChild = retained.findIndex((rule) => expression(target).test(pattern(rule).slice(0, -1)));
    const insertion = firstChild < 0 ? retained.length : firstChild;
    // Enabling a parent workspace must not override another workspace's more
    // specific rule. Conflicting existing order cannot be repaired by guessing.
    if (retained.slice(insertion).some((rule) => expression(rule).test(target.slice(0, -1)))) fail('nativeActivationEvidenceUnknown');
    retained.splice(insertion, 0, target);
  }
  // A global default precedes all preserved path overrides. Native User enable
  // deletes child Workspace rules; the narrow writer keeps their order and bytes.
  const overrides = [userEnabled ? '*' : '!*', ...retained];
  return { ...value, [id]: { ...value[id], overrides } };
}
export async function setGeminiActivation(ctx: ReadContext, evidence: PreparationEvidence, binding: DeploymentBinding,
  identity: NativeIdentity, enabled: boolean, baseline: GeminiActivationSnapshot): Promise<MutationOutcome> {
  if (typeof evidence.userActivationEnabled !== 'boolean') fail('nativeActivationEvidenceUnknown');
  await assertGeminiNativeOwner(ctx, binding, identity, evidence);
  await assertGeminiProjectRules(ctx, binding, geminiActivationRules(baseline, identity.packageId));
  return writeConfig(ctx, baseline, activationConfig(ctx, baseline, binding, identity.packageId,
    binding.scope.kind === 'user' ? enabled : evidence.userActivationEnabled, enabled));
}

async function checkedGeminiNativeMutation(ctx: ReadContext, identity: NativeIdentity,
  kind: 'register' | 'refresh' | 'unregister', baseline: GeminiActivationSnapshot, allowUnchanged = false): Promise<GeminiActivationSnapshot> {
  const previous = config(baseline);
  const current = await readGeminiActivationSnapshot(ctx);
  if (allowUnchanged && current.content === baseline.content) return current;
  let expected: EnablementConfig;
  if (kind === 'refresh') {
    if (current.content !== baseline.content) fail('operationPlanStale');
  } else {
    // Native zod parsing drops unknown entry fields when it writes the map.
    // Restore those fields from the checked snapshot after the native command.
    expected = Object.fromEntries(Object.entries(previous).map(([id, entry]) => [id, { overrides: entry.overrides }]));
    if (kind === 'unregister') delete expected[identity.packageId];
    else {
      const home = geminiScopePattern(geminiExtensionPaths(ctx).home);
      const parent = expression(home);
      expected[identity.packageId] = { overrides: [...(expected[identity.packageId]?.overrides ?? []).filter((rule) => {
        const base = pattern(rule).replace(/\*$/u, '');
        return pattern(rule) !== home && !parent.test(base);
      }), home] };
    }
    if (current.content !== JSON.stringify(expected, null, 2)) fail('operationPlanStale');
  }
  return current;
}

/** A refresh is not a final removal: keep every prior activation through each native step. */
export async function restoreGeminiReplacementActivation(ctx: ReadContext, identity: NativeIdentity,
  kind: 'register' | 'unregister', baseline: GeminiActivationSnapshot, allowUnchanged = false): Promise<void> {
  const current = await checkedGeminiNativeMutation(ctx, identity, kind, baseline, allowUnchanged);
  await writeConfig(ctx, current, config(baseline));
  baseline.content = current.content;
}

/** Fixed 0.67.0 install performs User enable; same-name update preserves rules. */
export async function finishGeminiNativeMutation(ctx: ReadContext, evidence: PreparationEvidence, binding: DeploymentBinding,
  identity: NativeIdentity, kind: 'register' | 'refresh' | 'unregister', baseline: GeminiActivationSnapshot): Promise<void> {
  const previous = config(baseline);
  const current = await checkedGeminiNativeMutation(ctx, identity, kind, baseline);
  const desired = { ...previous };
  if (kind === 'unregister') delete desired[identity.packageId];
  else {
    await assertGeminiNativeOwner(ctx, binding, identity, evidence);
    if (typeof evidence.userActivationEnabled !== 'boolean') fail('nativeActivationEvidenceUnknown');
    await assertGeminiProjectRules(ctx, binding, geminiActivationRules(baseline, identity.packageId));
    Object.assign(desired, activationConfig(ctx, baseline, binding, identity.packageId,
      binding.scope.kind === 'user' ? true : evidence.userActivationEnabled, true));
  }
  await writeConfig(ctx, current, desired);
  baseline.content = current.content;
}
