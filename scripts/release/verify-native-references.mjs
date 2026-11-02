import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, repoRoot as defaultRoot } from './common.mjs';

export async function verifyNativeReferences(axes, options = {}) {
  const root = options.repoRoot ?? defaultRoot;
  const descriptors = new Set();
  if (axes.cli) {
    descriptors.add(path.join(root, 'packages/agent-skill-eval/src/native/windows-job.lock.json'));
    descriptors.add(path.join(root, 'packages/cli/src/native/windows-job.lock.json'));
  }
  if (axes.catalog) {
    const pluginsRoot = path.join(root, 'plugins');
    for (const entry of await readdir(pluginsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const pluginRoot = path.join(pluginsRoot, entry.name);
      let manifest;
      try { manifest = JSON.parse(await readFile(path.join(pluginRoot, '.agents-plugin/plugin.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const definition of manifest.nativeTools?.definitions ?? []) descriptors.add(path.resolve(pluginRoot, definition.descriptor));
    }
  }
  const checked = new Set();
  for (const descriptor of descriptors) {
    const stats = await lstat(descriptor);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Consumer native descriptor must be a regular file.');
    const bytes = await readFile(descriptor, 'utf8');
    if (checked.has(bytes)) continue;
    await (options.runCommand ?? runCommand)(process.execPath, [path.join(root, 'packages/cli/dist/index.js'), 'native', 'verify', descriptor, '--all-variants', '--json'], { cwd: root });
    checked.add(bytes);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter((arg) => arg !== '--');
    if (args.length !== 1 || !['--cli', '--catalog', '--all'].includes(args[0])) throw new Error('Expected --cli, --catalog or --all.');
    await verifyNativeReferences({ cli: args[0] !== '--catalog', catalog: args[0] !== '--cli' });
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
