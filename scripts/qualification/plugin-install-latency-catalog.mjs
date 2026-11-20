import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRevision = 'c4f82300e5805501210d9ccec450a85ad1b21062';
const sourceTree = '8bf2da902945ccdf9024d143bd36bb4536df04a9';
const activeDigest = 'sha256:af14b402662c99e2f6fac595c4b736f6c17f9d89881e3c28d4c2badc85e12471';
const manifestDigest = 'sha256:b9c2ed0265546392fad4298f73727d0fbb15c5f1e6c8969e7654db8e9409796c';

async function main() {
  const [buildRoot, destination, ...extra] = process.argv.slice(2);
  if (buildRoot === '--help') {
    process.stdout.write(`Usage: node scripts/qualification/plugin-install-latency-catalog.mjs <built ${sourceRevision} archive> <new Catalog directory>\n`);
    return;
  }
  if (!buildRoot || !destination || extra.length) throw new Error('Supply the frozen staging build and new Catalog directory. See --help.');
  const source = path.resolve(buildRoot, 'packages/cli/plugins-dist');
  const target = path.resolve(destination);
  const manifest = await fs.readFile(path.join(source, 'catalog-manifest.json'));
  const manifestHash = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
  if (manifestHash !== manifestDigest) throw new Error(`Frozen Catalog manifest digest mismatch. Got ${manifestHash}.`);
  const workspace = JSON.parse(await fs.readFile(path.resolve(buildRoot, '.aw-workspace.json'), 'utf8'));
  const { validateCatalogSnapshotComplete } = await import(pathToFileURL(path.resolve(buildRoot, 'packages/cli/dist/src/utils/catalog-snapshot.js')));
  await fs.mkdir(target, { mode: 0o700 });
  try {
    for (const name of await fs.readdir(source)) {
      await fs.cp(path.join(source, name), path.join(target, name), { recursive: true, errorOnExist: true, force: false });
    }
    const marker = { schemaVersion: 1, kind: 'catalog', workspaceIdentity: workspace.workspaceIdentity, sourceIdentity: manifestHash };
    await fs.writeFile(path.join(target, '.aw-generated.json'), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
    const { snapshotDigest, manifestDigest: verifiedManifest } = await validateCatalogSnapshotComplete(target);
    if (snapshotDigest !== activeDigest || verifiedManifest !== manifestDigest) {
      throw new Error(`Frozen Catalog transport digest mismatch. Got ${snapshotDigest} and ${verifiedManifest}.`);
    }
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ sourceRevision, sourceTree, catalog: target, activeDigest, manifestDigest })}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
