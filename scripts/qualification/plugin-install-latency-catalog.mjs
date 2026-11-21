import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRevision = 'c4f82300e5805501210d9ccec450a85ad1b21062';
const sourceTree = '8bf2da902945ccdf9024d143bd36bb4536df04a9';
export const cloudCatalog = {
  sourceRevision, sourceTree,
  activeDigest: 'sha256:080e893b60154de1e97b232462e72c8c3fcd6c0abfc891dcf9085c43b142547b',
  manifestDigest: 'sha256:514c4a3680b9696e03bba255c1c9bee7e253f755bcb220acded55b106fe11b9a',
};
// The historical macOS staging embedded a temporary module label in one
// esbuild output. Each frozen transport has a known manifest and full digest.
const frozenDigests = new Map([
  [cloudCatalog.manifestDigest, cloudCatalog.activeDigest],
  ['sha256:b9c2ed0265546392fad4298f73727d0fbb15c5f1e6c8969e7654db8e9409796c', 'sha256:af14b402662c99e2f6fac595c4b736f6c17f9d89881e3c28d4c2badc85e12471'],
]);

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
  const manifestDigest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
  const activeDigest = frozenDigests.get(manifestDigest);
  if (!activeDigest) throw new Error(`Frozen Catalog manifest digest mismatch. Got ${manifestDigest}.`);
  const workspace = JSON.parse(await fs.readFile(path.resolve(buildRoot, '.aw-workspace.json'), 'utf8'));
  const { validateCatalogSnapshotComplete } = await import(pathToFileURL(path.resolve(buildRoot, 'packages/cli/dist/src/utils/catalog-snapshot.js')));
  await fs.mkdir(target, { mode: 0o700 });
  try {
    for (const name of await fs.readdir(source)) {
      await fs.cp(path.join(source, name), path.join(target, name), { recursive: true, errorOnExist: true, force: false });
    }
    const marker = { schemaVersion: 1, kind: 'catalog', workspaceIdentity: workspace.workspaceIdentity, sourceIdentity: manifestDigest };
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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
