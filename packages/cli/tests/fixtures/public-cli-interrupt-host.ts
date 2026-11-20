import path from 'node:path';
import fs from 'fs-extra';
import { runCli } from '../../src/index.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { defaultPluginProcessRunner } from '../../src/utils/plugin-scripts.js';

const [root, awHome, continued, readyPath, mode] = process.argv.slice(2);
if (!root || !awHome || !continued) throw new Error('Missing public CLI interrupt fixture arguments.');
const source = path.join(root, 'source');
const pluginRoot = path.join(source, 'plugins/demo');
const cwd = path.join(root, 'project');
await fs.ensureDir(cwd);
await git(cwd, ['init', '--quiet']);
await fs.copy(path.join(root, 'scripts/preApply.mjs'), path.join(pluginRoot, 'pre-apply.mjs'));
for (const folder of ['skills', 'generic/skills']) {
  await fs.outputFile(path.join(pluginRoot, folder, 'demo/SKILL.md'), '---\nname: demo\ndescription: Interrupt fixture\n---\nUse demo.\n');
  await fs.outputFile(path.join(pluginRoot, folder, 'demo/README.md'), 'Use demo.\n');
}
await createDependencyCatalogSnapshotFixture(source, [{ name: 'demo', configureManifest: (manifest) => {
  manifest.platforms = ['generic']; manifest.skills = './skills'; delete manifest.extensions;
  manifest.scripts = { preApply: { path: './pre-apply.mjs', timeoutMs: 30_000 } };
} }]);
const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
await fs.outputJson(path.join(pluginRoot, 'generic/skills/demo/aw-plugin-requirements.json'), createAwPluginRequirementsReceipt({ name: 'demo', version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []));
const catalogPath = path.join(source, 'catalog-manifest.json');
await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [await createCatalogManifestV7Entry(plugin, pluginRoot)] });
const env = { ...process.env, AW_HOME: awHome };
const config = await readCatalogSourcesConfigSnapshot(env);
await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', cwd, env });
await setTargets({ cwd, scope: 'project', env }, ['generic']);
const productionRunner = defaultPluginProcessRunner.run.bind(defaultPluginProcessRunner);
const waitingForLock = mode === 'wait-lock' || mode === 'wait-confirmed-lock';
if (readyPath && !waitingForLock) defaultPluginProcessRunner.run = async (invocation, options) => {
  if (!invocation.args.some((argument) => argument.endsWith('pre-apply.mjs'))) return productionRunner(invocation, options);
  return new Promise((_resolve, reject) => {
    const finish = (): void => { clearTimeout(deadline); reject(new Error('synthetic cleanup failure')); };
    const deadline = setTimeout(finish, 10_000);
    options.signal?.addEventListener('abort', finish, { once: true });
    void fs.outputFile(readyPath, 'ready\n');
  });
};
// vite-node's development-server handler exits before the application can clean
// up. This fixture tests the application handler, as a built CLI process would.
for (const listener of process.listeners('SIGTERM')) {
  if (String(listener).includes('sigtermCallbacks')) process.removeListener('SIGTERM', listener);
}
const args = ['plugin', 'install', 'local/demo', '--scope', 'project', '--yes', '--json'];
if (waitingForLock && readyPath) {
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holder: Promise<void> | undefined;
  const mkdir = fs.mkdir;
  const holdLock = async () => {
    holder = withAwHomeMutationLock({ env, action: async () => {
      fs.mkdir = new Proxy(mkdir, { apply(target, receiver, args) {
        if (typeof args[0] === 'string' && path.basename(args[0]) === 'aw-home-mutation.lock') {
          void fs.outputFile(readyPath, 'waiting');
        }
        return Reflect.apply(target, receiver, args);
      } });
      acquired.resolve();
      await release.promise;
    } });
    await Promise.race([acquired.promise, holder]);
  };
  try {
    if (mode === 'wait-lock') await holdLock();
    process.exitCode = await runCli(args, { cwd, env, interactive: false, debugLogger: {
      async log(event) {
        if (!holder && event.data?.name === 'recovery.lock.wait' && event.data.phase === 'start') await holdLock();
      },
    } });
  } finally {
    fs.mkdir = mkdir;
    release.resolve();
    await holder;
  }
} else process.exitCode = await runCli(args, { cwd, env, interactive: false });
await fs.outputFile(continued, 'boundary-returned\n');
