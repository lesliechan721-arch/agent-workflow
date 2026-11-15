import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalizeIdentityValue } from '@lesliechan721/aw-plugin-core/manifest';
import { canonicalizePathThroughExistingAncestor } from '../utils/state-paths.js';
import type { PhysicalIdentity } from './contracts.js';

export function identityDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalizeIdentityValue(value)).digest('hex')}`;
}
export async function canonicalNamespaceRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root)) throw new Error('platformNamespaceInvalid');
  return canonicalizePathThroughExistingAncestor(root);
}
export function getPhysicalKey(identity: PhysicalIdentity): string {
  const fields = ['sourceIdentity', 'pluginId', 'platform', 'route', 'namespaceRoot', 'resourceKey'];
  if (Object.keys(identity).length !== fields.length || fields.some((field) => typeof identity[field as keyof PhysicalIdentity] !== 'string'
    || !identity[field as keyof PhysicalIdentity] || identity[field as keyof PhysicalIdentity].includes('\0'))
    || !/^sha256:[0-9a-f]{64}$/u.test(identity.sourceIdentity) || !path.isAbsolute(identity.namespaceRoot)
    || path.normalize(identity.namespaceRoot) !== identity.namespaceRoot) throw new Error('platformPhysicalIdentityInvalid');
  return identityDigest(identity);
}
