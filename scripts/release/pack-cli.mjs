import { packCli, relativeToRepo } from './common.mjs';

try {
  const tarballPath = await packCli();
  console.log(`Packed tarball: ${relativeToRepo(tarballPath)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
