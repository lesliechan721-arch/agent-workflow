import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const runtimeFiles = ['reader.mjs', 'reader.d.mts', 'reader-runtime.mjs'];

export async function embedNativeRuntime(distRoot) {
  const root = path.resolve(distRoot);
  const output = path.join(root, 'native-runtime');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const name of runtimeFiles) {
    await copyFile(path.join(sourceRoot, name), path.join(output, name));
  }
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('nativeEmbedSymlinkUnsupported');
      if (entry.isDirectory()) await walk(filename);
      else if (/\.(?:js|mjs|d\.ts|d\.mts)$/.test(entry.name)) {
        const original = await readFile(filename, 'utf8');
        const rewritten = original.replace(/(['"])@lesliechan721\/aw-native-runtime\/reader\1/g, (_, quote) => {
          let relative = path.relative(path.dirname(filename), path.join(output, 'reader.mjs')).split(path.sep).join('/');
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
  const positional = process.argv.slice(2);
  let distRoot;
  if (positional.length === 2 && positional[0] === '--dist') distRoot = positional[1];
  else if (positional.length === 1 && !positional[0].startsWith('-')) distRoot = path.join(positional[0], 'dist');
  else throw new Error('Usage: embed.mjs <package-root> | --dist <dist-root>');
  await embedNativeRuntime(distRoot);
}
