import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';
import { deploymentPackageComponent, inspectDeployment } from '../../src/platforms/inspection.js';
import { readPlatformPackageContentDigest } from '../../src/utils/platform-empty-state.js';
import { SKILL_OWNER_MARKER, writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import type { ReadContext } from '../../src/platforms/contracts.js';

async function fixture() {
  const isolated = getCurrentSourceTestIsolation();
  const ctx: ReadContext = { cwd: isolated.layout.fixtureCwd, env: isolated.env, platform: 'linux', arch: 'x64' };
  const host = path.join(isolated.env.HOME!, '.gemini/config');
  const resolution = await resolveDeployments(ctx, { operation: 'ensure', scope: { kind: 'user' }, recoveryCandidates: [],
    plugin: { sourceId: 'team', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'team/demo', version: '1.0.0' },
    discovery: { platform: 'antigravity', availability: 'available', diagnostics: [], installations: [{ id: 'agy', product: 'cli',
      version: '1.3.4', availability: 'available', reasonCodes: [], entry: { kind: 'cli', executable: '/fake/agy', configRoot: host } }] } });
  const binding = resolution.bindings[0]!;
  const layout = await getDeploymentLayout(ctx, binding);
  const component = deploymentPackageComponent(binding, layout);
  const directory = path.join(host, 'plugins/demo');
  const rows = [{ name: 'demo', source: 'antigravity', path: directory, enabled: true, version: '1.0.0' }];
  ctx.runner = async () => ({ exitCode: 0, stdout: JSON.stringify(rows), stderr: '' });
  const publish = async (body: string) => {
    await fs.outputJson(path.join(layout.packageRoot, '.antigravity-plugin/plugin.json'), { name: 'demo', version: '1.0.0', skills: './skills/' });
    await fs.outputFile(path.join(layout.packageRoot, 'skills/check/SKILL.md'), body);
    const digest = (await readPlatformPackageContentDigest(layout.packageRoot))!;
    await writeSkillOwnerMarker({ skillRoot: layout.packageRoot, allowedRoot: path.dirname(layout.packageRoot), identity: component.identity,
      nativeProjection: { physicalIdentity: layout.physicalIdentity, preparation: 'complete', inputDigest: `sha256:${'b'.repeat(64)}`,
        contentDigest: digest, components: [{ id: 'skill:check', nativeName: 'check', relativeOutputs: ['skills/check/SKILL.md'] }] } });
    return digest;
  };
  const digest = await publish('Revision 1.\n');
  await fs.copy(layout.packageRoot, directory);
  return { ctx, binding, layout, directory, rows, publish, digest, inspect: () => inspectDeployment(ctx, binding) };
}

describe('Antigravity native copy', () => {
  // Test Value Gate: 1.3.4 lists source="antigravity" and the copied directory.
  // Only its own complete owner and bytes can confirm that native installation.
  it('compares actual same-version copy bytes and keeps model observations unknown', async () => {
    const item = await fixture();
    expect(await item.inspect()).toMatchObject({ ownership: 'aw', registration: 'present', nativePackageContentDigest: item.digest,
      consumers: [{ activation: 'enabled', trust: 'unknown', load: 'unknown' }],
      components: [{ id: 'skill:check', presence: 'present', reasonCodes: [] }] });
    const nextDigest = await item.publish('Revision 2.\n');
    expect(nextDigest).not.toBe(item.digest);
    expect(await item.inspect()).toMatchObject({ ownership: 'aw', nativePackageContentDigest: item.digest,
      components: [{ id: 'skill:check', presence: 'unknown', reasonCodes: ['nativePackageContentDrift'] }] });
    await fs.copy(item.layout.packageRoot, item.directory);
    expect((await item.inspect()).nativePackageContentDigest).toBe(nextDigest);
  });

  // Test Value Gate: an AW source marker alone cannot authorize native replacement.
  it.each(['missing-marker', 'foreign-owner', 'weak-owner', 'wrong-physical-identity', 'modified-body', 'extra-data', 'outside-path', 'source-path', 'shared-path'] as const)(
    'retains unconfirmed or shared native data for %s', async (boundary) => {
      const item = await fixture();
      const markerPath = path.join(item.directory, SKILL_OWNER_MARKER);
      const marker = await fs.readJson(markerPath);
      if (boundary === 'missing-marker') await fs.remove(markerPath);
      if (boundary === 'foreign-owner') { marker.sourceId = 'foreign'; await fs.outputJson(markerPath, marker); }
      if (boundary === 'weak-owner') { delete marker.sourceIdentity; delete marker.physicalKey; await fs.outputJson(markerPath, marker); }
      if (boundary === 'wrong-physical-identity') { marker.nativeProjection.physicalIdentity.namespaceRoot += '-other'; await fs.outputJson(markerPath, marker); }
      if (boundary === 'modified-body') await fs.outputFile(path.join(item.directory, 'skills/check/SKILL.md'), 'Local changes.\n');
      if (boundary === 'extra-data') await fs.outputFile(path.join(item.directory, '.env'), 'LOCAL_DATA=keep\n');
      if (boundary === 'outside-path') item.rows[0]!.path = path.join(item.ctx.cwd, 'outside/demo');
      if (boundary === 'source-path') item.rows[0]!.source = item.layout.packageRoot;
      if (boundary === 'shared-path') item.rows.push({ ...item.rows[0]!, name: 'other-name' });
      const observed = await item.inspect();
      expect(observed.registration).toBe('present');
      expect(['foreign', 'unknown', 'shared']).toContain(observed.ownership);
      expect(observed.nativePackageContentDigest).toBeUndefined();
      expect(await fs.pathExists(item.directory)).toBe(true);
    });

  it.skipIf(process.platform === 'win32')('rejects a symlink in the native copy path', async () => {
    const item = await fixture();
    const moved = path.join(item.ctx.cwd, 'outside');
    await fs.move(path.dirname(item.directory), moved);
    await fs.symlink(moved, path.dirname(item.directory), 'dir');
    expect(await item.inspect()).toMatchObject({ ownership: 'foreign', registration: 'present' });
  });

  // Test Value Gate: missing weak source output must not hide a proven native
  // copy from removal and must not turn the source path into an install ledger.
  it('keeps exact native ownership available after loss of the AW source package', async () => {
    const item = await fixture();
    await fs.remove(item.layout.packageRoot);
    expect(await item.inspect()).toMatchObject({ package: 'absent', ownership: 'aw', registration: 'present', nativePackageContentDigest: item.digest });
    item.rows.length = 0;
    expect(await item.inspect()).toMatchObject({ package: 'absent', ownership: 'absent', registration: 'absent', consumers: [{ activation: 'disabled' }] });
  });
});
