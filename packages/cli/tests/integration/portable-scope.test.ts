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
  // Test Value Gate: an out-of-scope renderer contributes no component; in-scope consumers still install and status stays read-only.
  it.each(['root', 'dependency'] as const)(
    'omits a user-only dynamic %s from a generic project requirement', async (unsupported) => {
      const isolation = getCurrentSourceTestIsolation();
      const cwd = isolation.layout.fixtureCwd;
      const env = isolation.env;
      await git(cwd, ['init', '--quiet']);
      const sourceRoot = path.join(cwd, 'portable-source');
      const names = unsupported === 'dependency' ? ['root', 'leaf'] : ['root'];
      const renderMarker = path.join(cwd, 'renderer-started');
      for (const name of names) {
        const plan = { version: 3, components: [{ id: 'skill', kind: 'skill', name,
          content: { files: { 'SKILL.md': { text: `---\nname: ${name}\ndescription: Test skill\n---\nUse ${name}.\n` },
            'README.md': { text: `Use ${name}.\n` } } } }],
        omitted: [], unmet: [] };
        await fs.outputFile(path.join(sourceRoot, 'plugins', name, 'render.mjs'),
          `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(renderMarker)}, ${JSON.stringify(name + '\n')});\n`
          + `console.log(${JSON.stringify(JSON.stringify(plan))});\n`);
      }
      await createDependencyCatalogSnapshotFixture(sourceRoot, names.map((name) => ({
        name,
        dependencies: name === 'root' && unsupported === 'dependency' ? ['leaf'] : [],
        configureManifest: (manifest) => {
          manifest.platforms = ['generic'];
          delete manifest.extensions;
          manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
          manifest.artifacts = { configKeys: [],
            scopes: [name === 'root' && unsupported === 'dependency' ? 'project' : 'user'] };
        },
      })));
      const current = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
        { id: 'team', type: 'path', primary: true, path: sourceRoot },
      ] }, expectedDigest: current.digest, env });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
      const options = { cwd, env, cliVersion: '1.0.0', context: 'project' as const,
        scope: 'project' as const, yes: true };
      await setTargets(options, ['generic']);
      const preferencesPath = await resolvePreferencesPath(options);
      const preferences = await fs.readFile(preferencesPath);

      const result = await runRecovery('install', ['team/root'], options);

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, allSatisfied: true,
        declarationChanged: true, preferencesChanged: false, configChanged: false,
        outputsMayHaveChanged: unsupported === 'dependency', remainingTargets: [], blockers: [], errors: [] });
      const target = result.targetResults.find((entry) => entry.pluginId === 'team/root');
      expect(target).toMatchObject({ agent: 'generic', scope: 'project',
        delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
        content: 'satisfied', execution: unsupported === 'dependency' ? 'applied' : 'no-op',
        observation: 'verified', blockers: [] });
      expect(result.recoveryActions.some((action) => action.includes('plugin sync'))).toBe(false);
      const savedIntent = await observeIntent(options);
      expect(savedIntent).toMatchObject({ state: 'valid', value: { roots: [{ pluginId: 'team/root' }] } });

      const rendered = await fs.readFile(renderMarker, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      expect(rendered).toBe(unsupported === 'dependency' ? 'root\n' : '');
      const status = await readRecoveryStatus(options);

      expect(status).toMatchObject({ allSatisfied: true, errors: [] });
      const observed = status.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults[0];
      expect(observed).toMatchObject({ content: 'satisfied', blockers: [] });
      expect(await observeIntent(options)).toEqual(savedIntent);
      expect(await fs.readFile(preferencesPath)).toEqual(preferences);
      expect(await fs.readFile(renderMarker, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      })).toBe(rendered);
      expect(await fs.pathExists(path.join(cwd, '.agents', 'skills', 'root', 'SKILL.md'))).toBe(unsupported === 'dependency');
      expect(await fs.pathExists(path.join(cwd, '.agents', 'skills', 'leaf'))).toBe(false);
      expect(await fs.pathExists(path.join(env.HOME!, '.agents', 'skills'))).toBe(false);
    }, 30_000,
  );
});
