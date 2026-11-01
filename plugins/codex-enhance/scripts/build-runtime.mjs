import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptRoot, '..');
const entries = [
  'skills/codex-subagent-guide/scripts/file-selection/selection.mjs',
  'skills/codex-subagent-guide/scripts/adapters/codex-profile.mjs',
];

// AW runs this script in a staging copy. Keep the source tree editable and make
// the Guide's delivered parsers independent of the plugin's package directory.
for (const relative of entries) {
  const entry = path.join(pluginRoot, relative);
  await bundleRuntime(entry);
}

async function bundleRuntime(entry) {
  const result = await build({
    absWorkingDir: pluginRoot,
    entryPoints: [entry],
    nodePaths: [path.join(scriptRoot, 'node_modules')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    banner: { js: "import { createRequire as awCreateRequire } from 'node:module'; const require = awCreateRequire(import.meta.url);" },
    legalComments: 'inline',
    metafile: true,
    logLevel: 'silent',
  });

  // Dependency licenses are often separate files, so esbuild's legal comments
  // alone do not retain them when the parser moves without node_modules.
  const notices = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.split('/').includes('node_modules')) continue;
    let directory = path.dirname(path.resolve(pluginRoot, input));
    while (directory !== path.dirname(directory)) {
      try {
        const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        const identity = `${metadata.name}@${metadata.version}`;
        if (!notices.has(identity)) {
          let license;
          for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
            try {
              license = await readFile(path.join(directory, name), 'utf8');
              break;
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          }
          if (!license) throw new Error(`Missing bundled dependency license: ${identity}`);
          notices.set(identity, license);
        }
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        directory = path.dirname(directory);
      }
    }
  }
  const licenses = [...notices.keys()].sort().map((identity) =>
    `${identity}\n${notices.get(identity)}`).join('\n');
  await writeFile(entry, `/*! Bundled dependency licenses\n${licenses.replaceAll('*/', '* /')}\n*/\n${result.outputFiles[0].text}`);
}
