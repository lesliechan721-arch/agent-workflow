import { canonicalizeIdentityValue, type NativeToolClosure, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

export interface NativeToolChange {
  producer: ProducerIdentity;
  before: NativeToolClosure | null;
  after: NativeToolClosure | null;
}

export function describeNativeToolClosure(closure: NativeToolClosure): string[] {
  return closure.consumers.flatMap((consumer) => consumer.tools.map((binding) => {
    const definition = closure.definitions.find((entry) => entry.key === binding.key)!;
    const label = consumer.kind === 'plugin-test' ? `plugin-test/${consumer.key}` : consumer.kind;
    return `${definition.key} · ${definition.protocol} · ${label} · ${binding.platforms.join(',')} · ${binding.policy}${binding.policy === 'preferred' ? ` · fallback=${binding.fallback}` : ''}`;
  }));
}

export function nativeToolChangesForPackage(producer: ProducerIdentity, before?: NativeToolClosure | null, after?: NativeToolClosure | null): NativeToolChange[] {
  if (canonicalizeIdentityValue(before ?? null) === canonicalizeIdentityValue(after ?? null)) return [];
  return [{ producer, before: before ?? null, after: after ?? null }];
}
