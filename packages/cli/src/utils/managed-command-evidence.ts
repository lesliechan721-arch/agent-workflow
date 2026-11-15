import { normalizeProducerIdentity, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

import { verifyManagedCommandPlacement } from '../platforms/managed-command-placement.js';

/** Live source, ownership and fixed platform layout must agree with the full producer identity. */
export async function verifyManagedCommandArtifactEvidence(options: {
  producer: ProducerIdentity; resourceRoot: string; env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const producer = normalizeProducerIdentity(options.producer);
  if (producer.kind === 'package') throw new Error('commandOwnerMismatch: package evidence must use its external owner marker.');
  await verifyManagedCommandPlacement({ ...options, producer });
}
