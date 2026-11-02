import path from 'node:path';
import { createOperationPlan } from '../commands/operation-plan.js';
import { getCommandPackageId, type NativeToolClosure, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';
import type { OperationAction } from '../commands/operation-plan.js';
import { listManagedCommands, normalizeInstalledCommandProducer, readInstalledCommandProducer } from './managed-command-store.js';

export interface NativeToolChange {
  producer: ProducerIdentity;
  before: NativeToolClosure | null;
  after: NativeToolClosure | null;
}

export function describeNativeToolClosure(closure: NativeToolClosure): string[] {
  return closure.consumers.flatMap((consumer) => consumer.tools.map((binding) => {
    const definition = closure.definitions.find((entry) => entry.key === binding.key)!;
    const packages = definition.descriptor.variants.map((variant) => `${variant.platform}/${variant.arch} ${variant.transport.package}@${variant.transport.version}`).join(', ');
    return `${definition.key} · ${definition.protocol} · ${definition.descriptorDigest} · ${packages} · ${consumer.kind}/${consumer.key} · ${binding.platforms.join(',')} · ${binding.policy}${binding.policy === 'preferred' ? ` · fallback=${binding.fallback}` : ''}`;
  }));
}

/** Bind the native impact to the same immutable plan as the producer files. */
export async function captureNativeToolChanges(options: {
  actions: OperationAction[];
  sourceId?: string;
  pluginName: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  projectRoot: string;
  removed: boolean;
  env: NodeJS.ProcessEnv;
  resourceRoots?: string[];
}): Promise<NativeToolChange[]> {
  const previous = new Map<string, { producer: ProducerIdentity; nativeTools?: NativeToolClosure; resourceRoot: string }>();
  const roots = new Set(options.resourceRoots ?? []);
  for (const command of (await listManagedCommands(options.env)).commands) {
    if (command.owner.kind !== 'plugin' || !command.resourceRoot) continue;
    const producer = command.owner.producer;
    if (producer.sourceId !== options.sourceId || producer.pluginName !== options.pluginName
      || (producer.platform !== null && producer.platform !== options.platform)
      || (producer.scope === 'project' && producer.projectRoot !== options.projectRoot)) continue;
    roots.add(command.resourceRoot);
  }
  for (const root of roots) {
    const record = await readInstalledCommandProducer(root).catch(() => undefined);
    if (record && record.producer.sourceId === options.sourceId && record.producer.pluginName === options.pluginName) previous.set(getCommandPackageId(record.producer), { ...record, resourceRoot: root });
  }
  const next = new Map<string, { producer: ProducerIdentity; nativeTools?: NativeToolClosure }>();
  for (const action of options.actions) {
    if (action.kind === 'syncManagedCommandPackage') next.set(getCommandPackageId(action.producer), action);
    if (action.kind === 'writeOwnedArtifact' || action.kind === 'materializeNativeSkill') {
      const file = action.files?.find((entry) => entry.relativePath === '.aw-command-producer.json');
      if (file) {
        const record = normalizeInstalledCommandProducer(JSON.parse(Buffer.from(file.contentBase64, 'base64').toString('utf8')));
        next.set(getCommandPackageId(record.producer), record);
      }
    }
  }
  const retained = new Set(options.actions.filter((action) => action.kind === 'retainManagedCommandPackage').map((action) => action.packageId));
  const changes: NativeToolChange[] = [];
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    if (retained.has(id)) continue;
    const before = previous.get(id)?.nativeTools ?? null;
    const after = next.get(id)?.nativeTools ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const producer = (next.get(id) ?? previous.get(id))!.producer;
    if (!next.has(id) && !options.removed && producer.kind === 'package') continue;
    if (!next.has(id) && options.removed) {
      const resourceRoot = previous.get(id)!.resourceRoot;
      const removalRoots = [
        ...(options.resourceRoots ?? []),
        ...options.actions.flatMap((action) => action.kind === 'removeOwnedArtifact' ? [action.path]
          : action.kind === 'removeMarketplaceProjection' ? [action.marketplaceRoot] : []),
      ];
      if (!removalRoots.some((root) => containsResource(root, resourceRoot))) continue;
    }
    changes.push({ producer, before, after });
  }
  return changes;
}

function containsResource(root: string, resourceRoot: string): boolean {
  const relative = path.relative(root, resourceRoot);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export async function withNativeToolRemovalImpact(plan: import('../commands/operation-plan.js').OperationPlan, env: NodeJS.ProcessEnv): Promise<import('../commands/operation-plan.js').OperationPlan> {
  const removals = plan.actions.filter((action) => action.kind === 'removeOwnedArtifact' || action.kind === 'removeMarketplaceProjection');
  if (removals.length === 0) return plan;
  const commands = await listManagedCommands(env);
  const recorded = new Set(plan.actions.flatMap((action) => action.nativeToolChanges ?? []).map((change) => getCommandPackageId(change.producer)));
  for (const command of commands.commands) {
    if (command.owner.kind !== 'plugin' || !command.resourceRoot || command.owner.producer.kind === 'package') continue;
    const producer = command.owner.producer;
    const id = getCommandPackageId(producer);
    if (recorded.has(id)) continue;
    const action = removals.find((removal) => {
      if (removal.pluginId !== `${producer.sourceId}/${producer.pluginName}` || removal.platform !== producer.platform) return false;
      const root = removal.kind === 'removeOwnedArtifact' ? removal.path : removal.marketplaceRoot;
      return containsResource(root, command.resourceRoot!);
    });
    if (!action) continue;
    const installed = await readInstalledCommandProducer(command.resourceRoot).catch(() => undefined);
    if (!installed?.nativeTools) continue;
    (action.nativeToolChanges ??= []).push({ producer, before: installed.nativeTools, after: null });
    recorded.add(id);
  }
  const { planFingerprint: _fingerprint, ...input } = plan;
  return createOperationPlan(input);
}
