import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { statusCommandV5 } from '../../src/commands/status-v5.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function configurePathSource(
  sourceRoot: string,
  sourceId = 'local',
): Promise<{ env: NodeJS.ProcessEnv; sourceIdentity: string }> {
  const isolation = getCurrentSourceTestIsolation();
  const source = { id: sourceId, type: 'path', primary: true, path: sourceRoot } as const;
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 1, sources: [source] },
    expectedDigest: current.digest,
    env: isolation.env,
  });
  return {
    env: isolation.env,
    sourceIdentity: await calculateCatalogSourceIdentity(source),
  };
}

async function filesystemSnapshot(root: string): Promise<Array<{
  path: string;
  type: 'directory' | 'file';
  content?: string;
}>> {
  if (!await fs.pathExists(root)) return [];
  const output: Array<{ path: string; type: 'directory' | 'file'; content?: string }> = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        output.push({ path: relative, type: 'directory' });
        pending.push(entryPath);
      } else if (entry.isFile()) {
        output.push({ path: relative, type: 'file', content: await fs.readFile(entryPath, 'utf8') });
      }
    }
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

describe('status v5 current behavior', () => {
  it('uses the current Codex project capability gate', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'capability-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'demo', '.app.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './.app.json';
    });
    const { env } = await configurePathSource(sourceRoot);

    const result = await statusCommandV5({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.schemaVersion).toBe(5);
    expect(result.payload.targets).toEqual([]);
  });

  it('keeps a partial target when another Catalog source fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const good = path.join(isolation.layout.fixtureCwd, 'partial-good');
    const bad = path.join(isolation.layout.fixtureCwd, 'partial-bad');
    await fs.outputFile(
      path.join(good, 'plugins', 'demo', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review fixture.\n---\n',
    );
    await fs.outputFile(
      path.join(good, 'plugins', 'demo', 'skills', 'review', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    await createCatalogSnapshotFixture(good, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
    });
    await fs.ensureDir(bad);
    const goodSource = { id: 'good', type: 'path', primary: true, path: good } as const;
    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [goodSource, { id: 'bad', type: 'path', primary: false, path: bad }],
      },
      expectedDigest: current.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'review');
    await fs.copy(path.join(good, 'plugins', 'demo', 'skills', 'review'), skillRoot);
    await fs.remove(path.join(skillRoot, 'agents', 'openai.yaml'));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'good',
        sourceIdentity: await calculateCatalogSourceIdentity(goodSource),
        pluginId: 'good/demo',
        plugin: 'demo',
        artifactKey: 'review',
        platform: 'codex',
        scope: 'project',
      },
    });

    const result = await statusCommandV5({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', verbose: true, json: true,
    });

    expect(result.hasErrors).toBe(true);
    expect(result.payload.catalog.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bad', error: expect.any(String) }),
    ]));
    expect(result.payload.targets).toEqual([
      expect.objectContaining({
        pluginId: 'good/demo',
        state: 'partial',
        components: expect.arrayContaining([
          expect.objectContaining({ key: 'review', state: 'partial' }),
        ]),
      }),
    ]);
  });

  it('treats a disabled-capable dynamic component as optional without running its renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'optional-dynamic-source');
    const sentinel = path.join(isolation.layout.fixtureCwd, 'renderer-ran');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.AW_RENDER_SENTINEL, "renderer ran\\n");',
      'console.log(JSON.stringify({ version: 2, artifacts: [] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-skill',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.skill',
          projectManagedKind: 'skill',
          states: ['present', 'disabled'],
          refreshKeys: [],
          skillKey: 'dynamic-skill',
        }],
      };
    });
    const { env } = await configurePathSource(sourceRoot);

    const result = await statusCommandV5({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...env, AW_RENDER_SENTINEL: sentinel },
      platform: 'codex', scope: 'project', verbose: true,
    });

    expect(result.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'local/demo', state: 'absent' }),
    ]);
    expect(await fs.pathExists(sentinel)).toBe(false);
  });

  it('reports live owner residue that is absent from the current snapshot', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'residue-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env, sourceIdentity } = await configurePathSource(sourceRoot);
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'removed-skill');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), [
      '---', 'name: removed-skill', 'description: Removed fixture.', '---', '',
    ].join('\n'));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows', sourceId: 'local', sourceIdentity,
        pluginId: 'local/removed', plugin: 'removed', artifactKey: 'removed-skill',
        platform: 'codex', scope: 'project',
      },
    });

    const result = await statusCommandV5({
      cwd: isolation.layout.fixtureCwd, env,
      platform: 'codex', scope: 'project', json: true,
    });

    expect(result.payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'local/removed',
        state: 'error',
        errors: [expect.objectContaining({ code: 'bundleUnavailable' })],
      }),
    ]));
  });

  it('does not create or change files during a real status inspection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'read-only-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const { env } = await configurePathSource(sourceRoot);
    await statusCommandV5({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'claude', scope: 'project', json: true,
    });
    const before = await filesystemSnapshot(isolation.layout.fixtureCwd);

    const result = await statusCommandV5({
      plugins: ['local/demo'], cwd: isolation.layout.fixtureCwd, env,
      platform: 'claude', scope: 'project', json: true,
    });

    expect(result.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'local/demo', state: 'absent' }),
    ]);
    expect(await filesystemSnapshot(isolation.layout.fixtureCwd)).toEqual(before);
  });
});
