import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { describe, it, expect } from 'vitest';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Load the actual installed asset so import.meta.url identifies the revision under test.
async function fixture() {
  const root = await fs.realpath(getCurrentSourceTestIsolation().layout.fixtureCwd);
  const pkg = path.join(root, `pkg_${'a'.repeat(64)}`);
  const revision = path.join(pkg, 'revisions', randomUUID());
  const reader = path.join(revision, '.aw', 'command-runtime-config.mjs');
  const caller = path.join(revision, 'scripts', 'main.mjs');
  const producer = { sourceId: 'team', pluginName: 'example', sourceIdentity: `sha256:${'b'.repeat(64)}` };
  const receipt = { schemaVersion: 2, producer, pluginVersion: '1.2.3', sourceContentDigest: `sha256:${'c'.repeat(64)}`,
    runtimeConfigKeys: ['target', 'optional'], runtimeConfigPlatforms: ['codex'] };
  const snapshot = { schemaVersion: 1, kind: 'aw-command-runtime-config', producer, pluginVersion: receipt.pluginVersion,
    sourceContentDigest: receipt.sourceContentDigest, platform: 'codex', allowedKeys: receipt.runtimeConfigKeys, effectiveValues: { target: 'applied' } };
  const snapshotPath = path.join(revision, '.aw/runtime-config/codex.json');
  await fs.copy(fileURLToPath(new URL('../../authoring/assets/command-runtime-config.mjs', import.meta.url)), reader);
  await fs.outputFile(caller, '');
  await fs.outputJson(path.join(pkg, 'owner.json'), { schemaVersion: 2, owner: 'agent-workflows', kind: 'plugin-command-package', producer });
  await fs.outputJson(path.join(revision, '.aw-command-producer.json'), receipt);
  await fs.outputJson(snapshotPath, snapshot);
  const { readCommandRuntimeConfig } = await import(/* @vite-ignore */ pathToFileURL(reader).href);
  const read = (options = {}) => readCommandRuntimeConfig({ from: pathToFileURL(caller), platform: 'codex', keys: ['target'], ...options });
  return { read, snapshotPath, snapshot, revision, producer, caller };
}

describe('installed command runtime configuration', () => {
  it('uses the calling revision and requires a published platform and permitted keys', async () => {
    const { read, revision, producer, snapshot } = await fixture();
    expect(await read()).toEqual({ platform: 'codex', resourceRoot: revision, values: { target: 'applied' },
      installedIdentity: { ...producer, platform: 'codex', pluginId: 'team/example',
        pluginVersion: snapshot.pluginVersion, sourceContentDigest: snapshot.sourceContentDigest } });
    await expect(read({ keys: ['unknown'] })).rejects.toHaveProperty('code', 'commandRuntimeConfigKeyDenied');
    await expect(read({ platform: 'claude' })).rejects.toHaveProperty('code', 'commandRuntimeConfigMissing');
    await expect(read({ from: import.meta.url })).rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
  });

  it('accepts an absolute caller path', async () => {
    const { read, caller } = await fixture();
    await expect(read({ from: caller })).resolves.toMatchObject({ values: { target: 'applied' } });
  });

  it.skipIf(process.platform !== 'win32')('accepts forward and mixed separators in Windows caller paths', async () => {
    const { read, revision } = await fixture();
    await expect(read({ from: `${revision.replaceAll('\\', '/')}/scripts/main.mjs` }))
      .resolves.toMatchObject({ values: { target: 'applied' } });
    await expect(read({ from: `${revision}/scripts\\main.mjs` }))
      .resolves.toMatchObject({ values: { target: 'applied' } });
  });

  it('rejects repeated separators in absolute caller paths', async () => {
    const { read, revision } = await fixture();
    const from = `${revision.replaceAll(path.sep, '/')}/scripts//main.mjs`;
    await expect(read({ from })).rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
  });

  it.each([
    { pluginVersion: '9.0.0' }, { sourceContentDigest: `sha256:${'e'.repeat(64)}` },
    { allowedKeys: ['target', 'other'] }, { platform: 'claude' },
  ])('rejects a substituted snapshot (%j)', async (change) => {
    const { read, snapshotPath, snapshot } = await fixture();
    await fs.writeJson(snapshotPath, { ...snapshot, ...change });
    await expect(read()).rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
  });

  it('rejects a linked directory inside the calling revision', async () => {
    const { read, revision, caller } = await fixture();
    const link = path.join(revision, 'alias');
    await fs.symlink(path.dirname(caller), link, 'junction');
    await expect(read({ from: path.join(link, 'main.mjs') })).rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
  });
});
