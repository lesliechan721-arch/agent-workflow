import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { createRuntimeConfigBinding, createRuntimeConfigSnapshot } from '../../../plugin-core/src/runtime-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const exec = promisify(execFile);

// Test Value Gate: production runtime assets must survive npm packaging and need no repository dependencies.
it('ships a standalone runtime reader in the CLI tarball', async () => {
  const isolation = getCurrentSourceTestIsolation();
  const root = isolation.layout.fixtureCwd;
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const packRoot = path.join(root, 'packed-runtime');
  await fs.ensureDir(packRoot);
  const result = await exec('npm', ['pack', cliRoot, '--offline', '--ignore-scripts', '--json', '--pack-destination', packRoot], {
    cwd: root, env: { ...isolation.env, npm_config_cache: path.join(root, 'npm-cache') },
  });
  const packed = JSON.parse(result.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const helperRelative = 'dist/authoring/assets/aw-runtime-config.mjs';
  expect(packed[0]!.files.some((file) => file.path === helperRelative)).toBe(true);
  await exec('tar', ['-xzf', path.join(packRoot, packed[0]!.filename), '-C', packRoot, `package/${helperRelative}`]);
  const skillRoot = path.join(root, 'installed', 'standalone-tool');
  const caller = Buffer.from("import {readRuntimeConfig} from './aw-runtime-config.mjs'; console.log(JSON.stringify(await readRuntimeConfig({from:import.meta.url,keys:['displayStyle']})));\n");
  const files = {
    'scripts/caller.mjs': caller,
    'scripts/aw-runtime-config.mjs': await fs.readFile(path.join(packRoot, 'package', helperRelative)),
  };
  for (const [relative, bytes] of Object.entries(files)) await fs.outputFile(path.join(skillRoot, relative), bytes);
  const snapshot = createRuntimeConfigSnapshot({
    installedIdentity: { sourceId: 'team', sourceIdentity: `sha256:${'1'.repeat(64)}`, pluginId: 'team/standalone-plugin',
      pluginName: 'standalone-plugin', pluginVersion: '1.0.0', platform: 'codex', scope: 'user', configScope: 'user',
      artifactId: 'standalone-tool', skillKey: 'standalone-tool' },
    declaration: { keys: ['displayStyle'], resourceVersion: 'text-v1' },
    definition: { fields: { displayStyle: { type: 'string' } } }, values: { displayStyle: 'compact' }, sources: { displayStyle: 'user' },
  });
  const resources = Object.fromEntries(Object.entries(files).map(([relative, bytes]) => [
    relative, `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  ]));
  await fs.outputJson(path.join(skillRoot, '.aw-runtime-config.json'), createRuntimeConfigBinding(snapshot, resources));
  const env = { ...isolation.env };
  delete env.AW_PLUGIN_CONTEXT;
  const execution = await exec(process.execPath, [path.join(skillRoot, 'scripts/caller.mjs')], { cwd: root, env });
  expect(JSON.parse(execution.stdout)).toMatchObject({ effectiveValues: { displayStyle: 'compact' }, revision: snapshot.revision });
});
