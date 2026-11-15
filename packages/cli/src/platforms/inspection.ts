import path from 'node:path';
import fs from 'fs-extra';
import type { PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';

import { inspectOwnedComponents, parseOwnedTextHeader, readSkillOwnerMarker, type OwnedComponent } from '../utils/ownership.js';
import type { DeploymentBinding, DeploymentObservation, ReadContext } from './contracts.js';
import { getDeploymentLayout, getNativePackageName, type DeploymentLayout } from './layout.js';
import { inspectNativeDeployment } from './inspection-native.js';
import { tryParseStrictSemVer } from '../utils/manifest.js';
import { rethrowFatalError } from '../utils/codex-executable-discovery.js';
import { projectSupplementFile } from './projection.js';
import { ownedSupplementFile } from './supplement-layout.js';

export function unknownDeployment(binding: DeploymentBinding, code = 'deploymentObservationUnknown'): DeploymentObservation {
  const generic = binding.route === 'generic-skills';
  return { physicalKey: binding.physicalKey, package: 'unknown', registration: generic ? 'not-applicable' : 'unknown', ownership: 'unknown',
    consumers: binding.consumers.map((product) => ({ productId: product.id, activationKey: binding.activationKey,
      activation: generic ? 'not-applicable' : 'unknown', trust: generic ? 'not-applicable' : 'unknown', load: generic ? 'not-applicable' : 'unknown' })),
    components: [], nativeIdentity: null,
    prerequisites: { agentConsumers: { observation: binding.platform === 'pi' ? 'unknown' : 'complete', candidates: [], reasonCodes: binding.platform === 'pi' ? ['agentConsumerDiscoveryUnverified'] : [] } },
    diagnostics: [{ code, severity: 'warning', message: 'The deployment could not be fully observed. Check permissions and client status before a change.', subject: { target: binding.platform, pluginId: binding.plugin.pluginId, scope: binding.scope.kind } }] };
}
export function deploymentPackageComponent(binding: DeploymentBinding, layout: DeploymentLayout): OwnedComponent {
  const shared = ['codex-marketplace', 'claude-marketplace', 'gemini-extension', 'copilot-marketplace'].includes(binding.route);
  return { kind: 'owned-directory', path: layout.packageRoot, allowedRoot: path.dirname(layout.packageRoot),
    identity: { owner: 'agent-workflows', plugin: getNativePackageName(binding.plugin), pluginId: binding.plugin.pluginId,
      sourceId: binding.plugin.sourceId, platform: binding.platform, scope: shared ? 'user' : binding.scope.kind,
      sourceIdentity: binding.plugin.sourceIdentity, physicalKey: binding.physicalKey,
      artifactKey: path.basename(layout.packageRoot) } };
}

/** Static expected host files can be checked without preparing or rendering a package. */
export async function inspectStaticSupplements(ctx: ReadContext, binding: DeploymentBinding,
  components: readonly PluginComponent[]): Promise<{ components: DeploymentObservation['components']; owned: boolean }> {
  const result: DeploymentObservation['components'] = [];
  let owned = false;
  if (!components.length) return { components: result, owned };
  const layout = await getDeploymentLayout(ctx, binding);
  const unit = layout.renderUnits.find((candidate) => candidate.output === 'supplement');
  if (!layout.supplementRoot || !unit) throw new Error('platformSupplementLayoutUnconfirmed');
  for (const component of components) {
    const file = projectSupplementFile(binding, component);
    const destination = path.join(layout.supplementRoot, file.relativePath);
    const slot = ownedSupplementFile(binding, unit.physicalKey, destination);
    const inspected = (await inspectOwnedComponents({ components: [slot] })).components[0]!;
    if (inspected.state === 'absent') {
      result.push({ id: component.id, presence: 'absent', reasonCodes: ['componentOutputMissing'] });
    } else if (inspected.state === 'foreign') {
      result.push({ id: component.id, presence: 'unknown', reasonCodes: ['supplementOwnershipConflict'] });
    } else if (inspected.state === 'present' || inspected.state === 'partial') {
      owned = true;
      try {
        const parsed = parseOwnedTextHeader(await fs.readFile(destination, 'utf8'), slot.identity);
        result.push({ id: component.id, presence: 'present', reasonCodes: parsed?.content === file.content.replace(/\r\n/gu, '\n')
          ? [] : ['componentContentDrift'] });
      } catch (error) {
        rethrowFatalError(error); ctx.signal?.throwIfAborted();
        result.push({ id: component.id, presence: 'unknown', reasonCodes: ['componentOutputUnconfirmed'] });
      }
    } else result.push({ id: component.id, presence: 'unknown', reasonCodes: ['componentOutputUnconfirmed'] });
  }
  return { components: result, owned };
}
async function fileExists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
}
async function inspectRelativeOutput(root: string, output: string): Promise<'present' | 'absent' | 'unknown'> {
  let current = root;
  for (const segment of output.split('/')) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) return 'unknown'; }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'absent'; throw error; }
  }
  return 'present';
}

async function inspectPackageVersion(ctx: ReadContext, binding: DeploymentBinding, layout: DeploymentLayout): Promise<string | undefined> {
  const relative = binding.platform === 'pi' || binding.platform === 'opencode' ? 'package.json'
    : binding.platform === 'gemini' ? 'gemini-extension.json' : binding.platform === 'copilot' ? 'plugin.json'
      : `.${binding.platform}-plugin/plugin.json`;
  try {
    if (await inspectRelativeOutput(layout.packageRoot, relative) !== 'present') return undefined;
    const file = path.join(layout.packageRoot, relative);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    ctx.signal?.throwIfAborted();
    return value && value.name === layout.nativeIdentity.packageId && typeof value.version === 'string'
      && tryParseStrictSemVer(value.version) ? value.version : undefined;
  } catch (error) { rethrowFatalError(error); ctx.signal?.throwIfAborted(); return undefined; }
}

/** Inspection never renders or changes trust. Explicit native observation can start app-server. */
export async function inspectDeployment(ctx: ReadContext, binding: DeploymentBinding): Promise<DeploymentObservation> {
  let layout: DeploymentLayout;
  try { layout = await getDeploymentLayout(ctx, binding); }
  catch (error) { rethrowFatalError(error); ctx.signal?.throwIfAborted(); return unknownDeployment(binding, 'deploymentLayoutUnconfirmed'); }
  const result = unknownDeployment(binding);
  result.diagnostics = [];
  result.nativeIdentity = layout.nativeIdentity;
  try {
    if (binding.route === 'generic-skills') {
      // Generic owns individual skill directories, never the shared skills root.
      result.registration = 'not-applicable';
      const entries = await fs.readdir(layout.packageRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
        throw error;
      });
      const components: OwnedComponent[] = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => ({
        kind: 'skill-directory', path: path.join(layout.packageRoot, entry.name), allowedRoot: layout.packageRoot,
        identity: { owner: 'agent-workflows', sourceId: binding.plugin.sourceId, pluginId: binding.plugin.pluginId,
          plugin: getNativePackageName(binding.plugin), platform: binding.platform, scope: binding.scope.kind, artifactKey: entry.name },
      }));
      const inspected = await inspectOwnedComponents({ components });
      const owned = inspected.components.filter((item) => item.state === 'present' || item.state === 'partial');
      result.package = inspected.state === 'error' ? 'unknown' : owned.length ? 'present' : 'absent';
      result.ownership = inspected.state === 'error' ? 'unknown' : owned.length ? 'aw' : 'absent';
      result.components = owned.map((item) => ({ id: item.component.identity.artifactKey, presence: 'present', reasonCodes: [] }));
      return result;
    }
    const packageComponent = deploymentPackageComponent(binding, layout);
    const inspected = await inspectOwnedComponents({ components: [packageComponent] });
    const state = inspected.components[0]!.state;
    result.package = state === 'absent' ? 'absent' : state === 'error' ? 'unknown' : 'present';
    result.ownership = state === 'foreign' ? 'foreign' : state === 'error' ? 'unknown' : state === 'absent' ? 'absent' : 'aw';
    if (state === 'present' || state === 'partial') {
      result.packageVersion = await inspectPackageVersion(ctx, binding, layout);
      const marker = await readSkillOwnerMarker({ skillRoot: layout.packageRoot, allowedRoot: path.dirname(layout.packageRoot), expectedIdentity: packageComponent.identity });
      for (const component of marker?.nativeProjection?.components ?? []) {
        const outputs = await Promise.all(component.relativeOutputs.map((output) => inspectRelativeOutput(layout.packageRoot, output)));
        const presence = !outputs.length || outputs.includes('unknown') ? 'unknown' : outputs.includes('absent') ? 'absent' : 'present';
        result.components.push({ id: component.id, presence, reasonCodes: presence === 'present' ? [] : [presence === 'absent' ? 'componentOutputMissing' : 'componentOutputUnconfirmed'] });
      }
    }
    await inspectNativeDeployment(ctx, binding, layout, result);
    if (['antigravity-directory', 'opencode-directory', 'cursor-workspace-hook'].includes(binding.route)) {
      result.registration = 'not-applicable';
      // A directory proves materialization, not host loading or project trust.
      for (const consumer of result.consumers) {
        consumer.load = 'not-observed';
        consumer.activation = result.package === 'absent' ? 'disabled' : 'unknown';
      }
      if (binding.route === 'cursor-workspace-hook' && !await fileExists(layout.activationPath)) {
        for (const consumer of result.consumers) consumer.activation = 'disabled';
      }
    }
    if (state === 'error') result.diagnostics.push(...unknownDeployment(binding, 'deploymentOwnershipUnreadable').diagnostics);
  } catch (error) {
    rethrowFatalError(error);
    ctx.signal?.throwIfAborted();
    const unknown = unknownDeployment(binding);
    return { ...result, registration: unknown.registration, consumers: unknown.consumers,
      diagnostics: [...result.diagnostics, ...unknown.diagnostics] };
  }
  return result;
}
