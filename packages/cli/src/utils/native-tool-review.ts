import path from 'node:path';
import { createOperationPlan, operationPlanNativeToolChanges } from '../commands/operation-plan.js';
import { canonicalizeIdentityValue, getCommandPackageId, normalizeProducerIdentity, type InstalledCommandProducer, type NativeToolClosure, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';
import type { OperationAction } from '../commands/operation-plan.js';
import { listManagedCommands, ManagedCommandError, normalizeInstalledCommandProducer, readInstalledCommandProducer } from './managed-command-store.js';

export interface NativeToolChange {
  producer: ProducerIdentity;
  before: NativeToolClosure | null;
  after: NativeToolClosure | null;
}

export function describeNativeToolClosure(closure: NativeToolClosure): string[] {
  return closure.consumers.flatMap((consumer) => consumer.tools.map((binding) => {
    const definition = closure.definitions.find((entry) => entry.key === binding.key)!;
    return `${definition.key} · ${definition.protocol} · ${consumer.kind}/${consumer.key} · ${binding.platforms.join(',')} · ${binding.policy}${binding.policy === 'preferred' ? ` · fallback=${binding.fallback}` : ''}`;
  }));
}

/** Bind the native impact to the same immutable plan as the producer files. */
export async function captureNativeToolChanges(options: {
  actions: OperationAction[];
  producers: readonly ProducerIdentity[];
  nextProducers?: readonly Pick<InstalledCommandProducer, 'producer' | 'sets' | 'nativeTools'>[];
  removed: boolean;
  env: NodeJS.ProcessEnv;
  resourceRoots?: string[];
}): Promise<NativeToolChange[]> {
  const producerIds = new Set(options.producers.map((producer) => getCommandPackageId(normalizeProducerIdentity(producer))));
  if (producerIds.size === 0) return [];
  const previous = new Map<string, { producer: ProducerIdentity; nativeTools?: NativeToolClosure; resourceRoot: string }>();
  const roots = new Set(options.resourceRoots ?? []);
  for (const command of (await listManagedCommands(options.env)).commands) {
    if (command.owner.kind !== 'plugin' || !command.resourceRoot) continue;
    const producer = command.owner.producer;
    if (!producerIds.has(getCommandPackageId(producer))) continue;
    roots.add(command.resourceRoot);
  }
  for (const root of roots) {
    const record = await readInstalledCommandProducer(root).catch(() => undefined);
    if (record && producerIds.has(getCommandPackageId(record.producer))) previous.set(getCommandPackageId(record.producer), { ...record, resourceRoot: root });
  }
  const next = new Map<string, InstalledCommandProducer>();
  const addNext = (candidate: Pick<InstalledCommandProducer, 'producer' | 'sets' | 'nativeTools'>): void => {
    const record = normalizeInstalledCommandProducer({ schemaVersion: 1, producer: candidate.producer, sets: candidate.sets,
      ...(candidate.nativeTools ? { nativeTools: candidate.nativeTools } : {}) });
    const id = getCommandPackageId(record.producer);
    if (!producerIds.has(id)) return;
    const existing = next.get(id);
    if (existing && canonicalizeIdentityValue(existing) !== canonicalizeIdentityValue(record)) throw new ManagedCommandError('commandIdentityConflict', 'The same producer has conflicting frozen native tool records.');
    next.set(id, record);
  };
  for (const candidate of options.nextProducers ?? []) addNext(candidate);
  for (const action of options.actions) {
    if (action.kind === 'syncManagedCommandPackage') addNext(action);
    if (action.kind === 'writeOwnedArtifact' || action.kind === 'materializeNativeSkill') {
      const file = action.files?.find((entry) => entry.relativePath === '.aw-command-producer.json');
      if (file) {
        const record = normalizeInstalledCommandProducer(JSON.parse(Buffer.from(file.contentBase64, 'base64').toString('utf8')));
        addNext(record);
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
  const recorded = new Set(operationPlanNativeToolChanges(plan).map((change) => getCommandPackageId(change.producer)));
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
    if (!installed?.nativeTools || getCommandPackageId(installed.producer) !== id) continue;
    (action.nativeToolChanges ??= []).push({ producer, before: installed.nativeTools, after: null });
    recorded.add(id);
  }
  const { planFingerprint: _fingerprint, ...input } = plan;
  return createOperationPlan(input);
}
