import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const offlineFiles = ['descriptor.mjs', 'descriptor.d.mts', 'reader.mjs', 'reader.d.mts', 'reader-runtime.mjs'];
const runtimeFiles = [...offlineFiles, 'index.mjs', 'index.d.mts', 'archive.mjs', 'cache.mjs', 'transport.mjs'];

export async function embedNativeRuntime(distRoot, { offline = false } = {}) {
  const root = path.resolve(distRoot);
  const output = path.join(root, 'native-runtime');
  await mkdir(output, { recursive: true });
  for (const name of runtimeFiles) {
    if (!offline || offlineFiles.includes(name)) await copyFile(path.join(sourceRoot, name), path.join(output, name));
    else {
      try { await unlink(path.join(output, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('nativeEmbedSymlinkUnsupported');
      if (entry.isDirectory()) await walk(filename);
      else if (/\.(?:js|mjs|d\.ts|d\.mts)$/.test(entry.name)) {
        const original = await readFile(filename, 'utf8');
        const rewritten = original.replace(/(['"])@lesliechan721\/aw-native-runtime(?:\/(descriptor|reader))?\1/g, (_, quote, module) => {
          if (offline && !module) throw new Error('nativeOfflineEmbedImportInvalid');
          let relative = path.relative(path.dirname(filename), path.join(output, `${module ?? 'index'}.mjs`)).split(path.sep).join('/');
          if (!relative.startsWith('.')) relative = `./${relative}`;
          return `${quote}${relative}${quote}`;
        });
        if (rewritten !== original) await writeFile(filename, rewritten);
      }
    }
  }
  await walk(root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const positional = args.filter((arg) => arg !== '--offline');
  let distRoot;
  if (positional.length === 2 && positional[0] === '--dist') distRoot = positional[1];
  else if (positional.length === 1 && !positional[0].startsWith('-')) distRoot = path.join(positional[0], 'dist');
  else throw new Error('Usage: embed.mjs <package-root> [--offline] | --dist <dist-root> [--offline]');
  await embedNativeRuntime(distRoot, { offline });
}
