import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
await fs.mkdir(config.snapshotRoot, { recursive: true });
await fs.mkdir(config.stageTempRoot, { recursive: true });
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  env: process.env,
  stdio: 'ignore',
});
await fs.writeFile(config.evidencePath, JSON.stringify({
  childPid: process.pid,
  grandchildPid: grandchild.pid,
}));
if (config.replaceParentWithSymlink) {
  const { parentRoot, replacementRoot } = config.replaceParentWithSymlink;
  await fs.rename(parentRoot, `${parentRoot}-original`);
  await fs.symlink(replacementRoot, parentRoot, 'dir');
}
if (config.resultMode) {
  grandchild.kill('SIGTERM');
  if (config.resultMode === 'nonzero') {
    process.stderr.write('fixture nonzero failure');
    process.exitCode = 1;
  } else if (config.resultMode === 'invalid-json') {
    process.stdout.write('{');
  } else if (config.resultMode === 'empty-object') {
    process.stdout.write('{}');
  } else if (config.resultMode === 'null') {
    process.stdout.write('null');
  }
} else {
  setInterval(() => {}, 1000);
}
