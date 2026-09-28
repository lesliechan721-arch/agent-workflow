import path from 'node:path';
import crypto from 'node:crypto';

import fs from 'fs-extra';

import { assertPortablePath } from './historical-materialization.js';
import type { portableRecoveryLayout } from './recovery-layout.js';

type Layout = ReturnType<typeof portableRecoveryLayout>;

/** Validate the provider's independent lock formats without writing either lock. */
export async function observeProviderLock(layout: Layout): Promise<{
  entries: Record<string, unknown>;
  digest: string;
}> {
  const filename = layout.lockPath;
  const root = path.parse(filename).root;
  let exists: boolean;
  try { exists = await assertPortablePath(root, filename); } catch { throw new Error('portableProviderLockInvalid'); }
  if (!exists) return { entries: {}, digest: 'absent' };
  const info = await fs.lstat(filename).catch(() => { throw new Error('portableProviderLockInvalid'); });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('portableProviderLockInvalid');
  const bytes = await fs.readFile(filename).catch(() => { throw new Error('portableProviderLockInvalid'); });
  let value: Record<string, unknown>;
  try { value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
  catch { throw new Error('portableProviderLockInvalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== (layout.scope === 'project' ? 1 : 3)
    || !value.skills || typeof value.skills !== 'object' || Array.isArray(value.skills)) {
    throw new Error('portableProviderLockInvalid');
  }
  if (layout.scope === 'project' && Object.keys(value).some((key) => !['version', 'skills'].includes(key))) {
    throw new Error('portableProviderLockInvalid');
  }
  if (layout.scope === 'user') {
    if (Object.keys(value).some((key) => !['version', 'skills', 'dismissed', 'lastSelectedAgents'].includes(key))) {
      throw new Error('portableProviderLockInvalid');
    }
    if (value.dismissed !== undefined && (!value.dismissed || typeof value.dismissed !== 'object'
      || Array.isArray(value.dismissed)
      || Object.entries(value.dismissed).some(([key, item]) => key !== 'findSkillsPrompt' || typeof item !== 'boolean'))) {
      throw new Error('portableProviderLockInvalid');
    }
    if (value.lastSelectedAgents !== undefined && (!Array.isArray(value.lastSelectedAgents)
      || value.lastSelectedAgents.some((item) => typeof item !== 'string'))) throw new Error('portableProviderLockInvalid');
  }
  for (const row of Object.values(value.skills)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('portableProviderLockInvalid');
    const entry = row as Record<string, unknown>;
    const required = layout.scope === 'project' ? ['source', 'sourceType', 'computedHash']
      : ['source', 'sourceType', 'sourceUrl', 'skillFolderHash', 'installedAt', 'updatedAt'];
    const optional = layout.scope === 'project' ? ['sourceUrl', 'ref', 'skillPath', 'wellKnownDigest']
      : ['ref', 'skillPath', 'wellKnownDigest', 'pluginName', 'sourceBaseUrl'];
    if (required.some((key) => typeof entry[key] !== 'string')
      || optional.some((key) => entry[key] !== undefined && typeof entry[key] !== 'string')
      || (entry.subagents !== undefined && (!Array.isArray(entry.subagents)
        || entry.subagents.some((item) => typeof item !== 'string')))) throw new Error('portableProviderLockInvalid');
    if (layout.scope === 'project' && Object.keys(entry).some((key) =>
      ![...required, ...optional, 'subagents'].includes(key))) throw new Error('portableProviderLockInvalid');
    if (layout.scope === 'user' && Object.keys(entry).some((key) =>
      ![...required, ...optional].includes(key))) throw new Error('portableProviderLockInvalid');
  }
  return { entries: value.skills as Record<string, unknown>,
    digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` };
}
