import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptRoot, '..');
const entries = [
  'skills/codex-subagent-guide/scripts/file-selection/selection.mjs',
  'skills/codex-subagent-guide/scripts/adapters/codex-profile.mjs',
];

// Ordinary plugin builds use only their own resource tree and do not run Go.
await verifyWindowsResources();

// AW runs this script in a staging copy. Keep the source tree editable and make
// the Guide's delivered parsers independent of the plugin's package directory.
for (const relative of entries) {
  const entry = path.join(pluginRoot, relative);
  await bundleRuntime(entry);
}

async function verifyWindowsResources() {
  const root = path.join(pluginRoot, 'skills/codex-subagent-guide/scripts/runtime/native/windows');
  const manifestPath = path.join(root, 'manifest.json');
  if (!(await lstat(manifestPath)).isFile()) throw new Error('Windows helper manifest must be a regular file.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1) throw new Error('Unsupported Windows helper manifest.');
  for (const [arch, machine] of [['x64', 0x8664], ['arm64', 0xaa64]]) {
    const entry = manifest.binaries?.[arch];
    const relative = `${arch}/aw-windows-job.exe`;
    if (entry?.path !== relative || entry.peMachine !== `0x${machine.toString(16)}`) {
      throw new Error(`Invalid Windows helper manifest for ${arch}.`);
    }
    const target = path.join(root, relative);
    if (!(await lstat(target)).isFile()) throw new Error(`Windows helper must be a regular file for ${arch}.`);
    const bytes = await readFile(target);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== entry.sha256 || bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error(`Windows helper does not match its manifest for ${arch}.`);
    }
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset + 6 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
      || bytes.readUInt16LE(peOffset + 4) !== machine) {
      throw new Error(`Windows helper has the wrong PE architecture for ${arch}.`);
    }
  }
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
