import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Load the actual installed asset so import.meta.url identifies the revision under test.
async function fixture() {
  const root = await fs.realpath(getCurrentSourceTestIsolation().layout.fixtureCwd);
  const producer = { sourceId: 'team', pluginName: 'example', sourceIdentity: `sha256:${'b'.repeat(64)}` };
  const packageId = getCommandPackageId(producer);
  const pkg = path.join(root, packageId);
  const revision = path.join(pkg, 'revisions', randomUUID());
  const reader = path.join(revision, '.aw', 'command-runtime-config.mjs');
  const caller = path.join(revision, 'scripts', 'main.mjs');
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
  const setContext = (changes = {}) => vi.stubEnv('AW_COMMAND_RUNTIME_CONFIG', JSON.stringify({
    schemaVersion: 1, platform: 'codex', packageId, revision: path.basename(revision), ...changes,
  }));
  setContext();
  const { readCommandRuntimeConfig } = await import(/* @vite-ignore */ pathToFileURL(reader).href);
  const read = (options = {}) => readCommandRuntimeConfig({ from: pathToFileURL(caller), keys: ['target'], ...options });
  return { read, setContext, snapshotPath, snapshot, revision, producer, caller };
}

describe('installed command runtime configuration', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('uses the calling revision and requires a published platform and permitted keys', async () => {
    const { read, setContext, revision, producer, snapshot } = await fixture();
    expect(await read()).toEqual({ platform: 'codex', resourceRoot: revision, values: { target: 'applied' },
      installedIdentity: { ...producer, platform: 'codex', pluginId: 'team/example',
        pluginVersion: snapshot.pluginVersion, sourceContentDigest: snapshot.sourceContentDigest } });
    await expect(read({ keys: ['unknown'] })).rejects.toHaveProperty('code', 'commandRuntimeConfigKeyDenied');
    await expect(read({ keys: ['target', 'target'] })).rejects.toHaveProperty('code', 'commandRuntimeConfigKeyDenied');
    await expect(read({ platform: 'codex' })).rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
    await expect(read({ unknown: true })).rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
    await expect(read({ from: import.meta.url })).rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
    setContext({ platform: 'claude' });
    await expect(read()).rejects.toHaveProperty('code', 'commandRuntimeConfigMissing');
  });

  it('requires a runtime context that identifies this physical revision', async () => {
    const { read, setContext } = await fixture();
    vi.stubEnv('AW_COMMAND_RUNTIME_CONFIG', undefined);
    await expect(read()).rejects.toHaveProperty('code', 'commandRuntimeConfigContextMissing');
    vi.stubEnv('AW_COMMAND_RUNTIME_CONFIG', '{malformed');
    await expect(read()).rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
    for (const change of [{ packageId: `pkg_${'0'.repeat(64)}` }, { revision: randomUUID() }, { platform: 'generic' }]) {
      setContext(change);
      await expect(read()).rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
    }
  });

  it('accepts an absolute caller path', async () => {
    const { read, caller } = await fixture();
    await expect(read({ from: caller })).resolves.toMatchObject({ values: { target: 'applied' } });
  });

  it('distinguishes a missing platform snapshot from a missing caller or producer record', async () => {
    const { read, caller, revision, snapshotPath } = await fixture();
    await expect(read({ from: path.join(path.dirname(caller), 'missing.mjs') }))
      .rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
    const receipt = path.join(revision, '.aw-command-producer.json');
    const saved = await fs.readFile(receipt);
    await fs.remove(receipt);
    await expect(read()).rejects.toHaveProperty('code', 'commandRuntimeConfigInvalid');
    await fs.writeFile(receipt, saved);
    await fs.remove(snapshotPath);
    await expect(read()).rejects.toHaveProperty('code', 'commandRuntimeConfigMissing');
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
