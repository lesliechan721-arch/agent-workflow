import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { resolvePreferencesPath, setTargets } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('Portable scope capability through Catalog recovery', () => {
  // Test Value Gate: the public recovery result must retain a complete unsupported
  // dependency path, save Intent, and leave every renderer and output untouched.
  it.each(['root', 'dependency'] as const)(
    'reports a user-only dynamic %s as unsupported for a project requirement', async (unsupported) => {
      const isolation = getCurrentSourceTestIsolation();
      const cwd = isolation.layout.fixtureCwd;
      const env = isolation.env;
      await git(cwd, ['init', '--quiet']);
      const sourceRoot = path.join(cwd, 'portable-source');
      const names = unsupported === 'dependency' ? ['root', 'leaf'] : ['root'];
      const renderMarker = path.join(cwd, 'renderer-started');
      for (const name of names) {
        await fs.outputFile(path.join(sourceRoot, 'plugins', name, 'render.mjs'),
          `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(renderMarker)}, ${JSON.stringify(name)});\n`
          + 'throw new Error("Unsupported project closure must not render");\n');
      }
      await createDependencyCatalogSnapshotFixture(sourceRoot, names.map((name) => ({
        name,
        dependencies: name === 'root' && unsupported === 'dependency' ? ['leaf'] : [],
        configureManifest: (manifest) => {
          manifest.platforms = ['cursor'];
          delete manifest.extensions;
          manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
          manifest.artifacts = { targets: [{ id: name, platform: 'cursor', distribution: 'agent-skills',
            target: 'agent-skills.skill', scopes: [name === 'root' && unsupported === 'dependency' ? 'project' : 'user'],
            states: ['present'], refreshKeys: [], skillKey: name }] };
        },
      })));
      const current = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
        { id: 'team', type: 'path', primary: true, path: sourceRoot },
      ] }, expectedDigest: current.digest, env });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
      const options = { cwd, env, cliVersion: '1.0.0', context: 'project' as const,
        scope: 'project' as const, yes: true };
      await setTargets(options, ['cursor']);
      const preferencesPath = await resolvePreferencesPath(options);
      const preferences = await fs.readFile(preferencesPath);

      const result = await runRecovery('install', ['team/root'], options);

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, allSatisfied: true,
        declarationChanged: true, preferencesChanged: false, configChanged: false,
        outputsMayHaveChanged: false, remainingTargets: [], blockers: [], errors: [] });
      const target = result.targetResults.find((entry) => entry.pluginId === 'team/root');
      expect(target).toMatchObject({ agent: 'cursor', scope: 'project', delivery: null,
        satisfaction: 'unsupported', execution: 'no-op', observation: 'verified', blockers: [] });
      const reason = target?.reasons?.find((entry) => entry.code === 'deliveryUnsupported');
      const dependencyPath = unsupported === 'dependency' ? 'team/root → team/leaf' : 'team/root';
      expect(reason?.message).toContain(dependencyPath);
      expect(reason?.message).toContain('project');
      expect(reason?.message).toContain('cursor');
      expect(result.recoveryActions.some((action) => action.includes('plugin sync'))).toBe(false);
      const savedIntent = await observeIntent(options);
      expect(savedIntent).toMatchObject({ state: 'valid', value: { roots: [{ pluginId: 'team/root' }] } });

      const status = await readRecoveryStatus(options);

      expect(status).toMatchObject({ allSatisfied: true, errors: [] });
      const observed = status.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults[0];
      expect(observed).toMatchObject({ satisfaction: 'unsupported', blockers: [], reasons: [reason] });
      expect(await observeIntent(options)).toEqual(savedIntent);
      expect(await fs.readFile(preferencesPath)).toEqual(preferences);
      expect(await fs.pathExists(renderMarker)).toBe(false);
      expect(await fs.pathExists(path.join(cwd, '.cursor', 'skills'))).toBe(false);
      expect(await fs.pathExists(path.join(env.HOME!, '.cursor', 'skills'))).toBe(false);
    }, 30_000,
  );
});
