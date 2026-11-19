import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';

import { inspectOwnedComponents, parseOwnedTextHeader } from '../utils/ownership.js';
import { assertSafeFileMutationPath, atomicReplaceSafeFile } from '../utils/safe-fs.js';
import { resolveAbsoluteAwHome } from '../utils/state-paths.js';
import type { DeploymentBinding, DeploymentObservation, ReadContext } from './contracts.js';
import { getDeploymentLayout, getDeploymentResourceKey } from './layout.js';
import { ownedSupplementFile } from './supplement-layout.js';

interface PlatformSupplementOutput {
  id: string;
  fileName: string;
  contentDigest: string;
}

const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function statePath(binding: DeploymentBinding, env?: NodeJS.ProcessEnv) {
  if (!['codex-marketplace', 'grok-cli', 'grok-directory'].includes(binding.route)
    || !SHA256.test(binding.id)) throw new Error('platformSupplementStateIdentityInvalid');
  const root = resolveAbsoluteAwHome(env);
  return { root, filePath: path.join(root, 'platforms', binding.platform, 'supplements', `${binding.id.slice(7)}.json`) };
}

function readOutputs(value: unknown, prefix: string, extension: string): PlatformSupplementOutput[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const output of value) {
    if (!output || typeof output !== 'object' || typeof output.id !== 'string' || !output.id || ids.has(output.id)
      || typeof output.fileName !== 'string' || !output.fileName.startsWith(prefix)
      || !/^[A-Za-z0-9._-]+$/u.test(output.fileName) || !output.fileName.endsWith(extension) || names.has(output.fileName.toLowerCase())
      || typeof output.contentDigest !== 'string' || !SHA256.test(output.contentDigest)) return null;
    ids.add(output.id);
    names.add(output.fileName.toLowerCase());
  }
  return value;
}

/** Expected output evidence is rebuildable and never used to authorize cleanup. */
export async function writePlatformSupplementState(ctx: ReadContext, binding: DeploymentBinding,
  inputDigest: string, outputs: PlatformSupplementOutput[]): Promise<void> {
  const { root, filePath } = statePath(binding, ctx.env);
  await atomicReplaceSafeFile({ filePath, allowedRoot: root, label: 'Platform supplement state',
    content: `${JSON.stringify({ schemaVersion: 1, bindingId: binding.id, inputDigest, outputs }, null, 2)}\n` });
}

export async function inspectPlatformSupplementState(ctx: ReadContext, binding: DeploymentBinding,
  inputDigest: string): Promise<{ inputMatches: boolean; components: DeploymentObservation['components'] } | null> {
  try {
    const { root, filePath } = statePath(binding, ctx.env);
    await assertSafeFileMutationPath({ filePath, allowedRoot: root, label: 'Platform supplement state' });
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const state = await fs.readJson(filePath);
    if (state?.schemaVersion !== 1 || state.bindingId !== binding.id
      || typeof state.inputDigest !== 'string' || !SHA256.test(state.inputDigest)) return null;
    const outputs = readOutputs(state.outputs, `${getDeploymentResourceKey(binding.plugin)}-`, binding.platform === 'grok' ? '.md' : '.toml');
    if (!outputs) return null;
    const { renderUnits, supplementRoot } = await getDeploymentLayout(ctx, binding);
    const unit = renderUnits.find((candidate) => candidate.output === 'supplement');
    if (!unit || !supplementRoot) return null;
    const components = outputs.map(({ fileName }) => ownedSupplementFile(binding, unit.physicalKey, path.join(supplementRoot, fileName)));
    const live = await inspectOwnedComponents({ components });
    const observed = await Promise.all(live.components.map(async ({ component, state }, index): Promise<DeploymentObservation['components'][number]> => {
      ctx.signal?.throwIfAborted();
      const output = outputs[index]!;
      const { id } = output;
      if (state === 'absent') return { id, presence: 'absent', reasonCodes: ['componentOutputMissing'] };
      if (state === 'foreign') return { id, presence: 'unknown', reasonCodes: ['supplementOwnershipConflict'] };
      if (state !== 'present' || component.kind !== 'owned-text-file') return { id, presence: 'unknown', reasonCodes: ['componentOutputUnconfirmed'] };
      const parsed = parseOwnedTextHeader(await fs.readFile(component.path, 'utf8'), component.identity);
      if (!parsed) return { id, presence: 'unknown', reasonCodes: ['componentOutputUnconfirmed'] };
      const digest = `sha256:${createHash('sha256').update(parsed.content).digest('hex')}`;
      return { id, presence: 'present', reasonCodes: digest === output.contentDigest ? [] : ['componentContentDrift'] };
    }));
    return { inputMatches: state.inputDigest === inputDigest, components: observed };
  } catch {
    ctx.signal?.throwIfAborted();
    return null;
  }
}
