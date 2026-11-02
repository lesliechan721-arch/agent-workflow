import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCandidate } from '../../native-tools/windows-job/candidate.mjs';
import { parseNativeToolDescriptor, resolveNativeTool } from '../../packages/native-runtime/src/index.mjs';
import { runCommand, repoRoot as defaultRoot } from './common.mjs';

export async function verifyNativeReferences(axes, options = {}) {
  const root = options.repoRoot ?? defaultRoot;
  const candidate = options.candidateRoot ? await readCandidate(path.resolve(root, options.candidateRoot)) : undefined;
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
  const cacheRoot = candidate ? await mkdtemp(path.join(await realpath(os.tmpdir()), 'aw-native-reference-check-')) : undefined;
  try {
    const checked = new Set();
    for (const descriptor of descriptors) {
      const stats = await lstat(descriptor);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Consumer native descriptor must be a regular file.');
      const bytes = await readFile(descriptor, 'utf8');
      if (checked.has(bytes)) continue;
      if (candidate) {
        const lock = parseNativeToolDescriptor(JSON.parse(bytes));
        for (const variant of lock.variants) {
          const archive = candidate.candidate.packages.find((entry) => entry.name === variant.transport.package
            && entry.arch === variant.arch && candidate.candidate.version === variant.transport.version);
          if (!archive) throw new Error('Current native candidate does not cover a consumer reference.');
          await resolveNativeTool({ descriptor: lock, cacheRoot, platform: variant.platform, arch: variant.arch,
            mode: 'source-candidate', archivePath: path.join(candidate.root, archive.path) });
        }
      } else {
        await (options.runCommand ?? runCommand)(process.execPath, [path.join(root, 'packages/cli/dist/index.js'), 'native', 'verify', descriptor, '--all-variants', '--json'], { cwd: root });
      }
      checked.add(bytes);
    }
  } finally {
    if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter((arg) => arg !== '--');
    if (![1, 3].includes(args.length) || !['--cli', '--catalog', '--all'].includes(args[0])
      || args.length === 3 && (args[1] !== '--candidate' || !args[2] || args[2].startsWith('--'))) {
      throw new Error('Expected --cli, --catalog or --all, optionally followed by --candidate <directory>.');
    }
    await verifyNativeReferences({ cli: args[0] !== '--catalog', catalog: args[0] !== '--cli' }, { candidateRoot: args[2] });
    console.log(args[2] ? 'Consumer native references match the current source candidate.' : 'Published consumer native references verified.');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
