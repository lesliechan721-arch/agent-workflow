// The pinned Cursor archive provides its own Node runtime and JS entry.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadInterfaceArchive, extractInterfaceArchive, interfaceDistributions } from './native-platform-interface-probes.mjs';
import { prepareEnvironment } from './native-platform-runtime.mjs';
import { runComponentQualification } from './native-platform-public-components.mjs';

assert(process.platform === 'linux' && process.arch === 'x64', 'This pinned distribution is Linux x64.');
const output = process.argv[2];
assert(output, 'Supply the destination JSON file.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-component-cursor-'));
const report = { status: 'failed', outcomes: [] };
try {
  const distribution = interfaceDistributions.cursor;
  const archive = path.join(root, 'cursor.tar.gz');
  report.acquisition = await downloadInterfaceArchive(distribution, archive);
  const files = path.join(root, 'files');
  report.extraction = await extractInterfaceArchive(archive, files, await prepareEnvironment(root));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  for (const entry of distribution.entries) assert((await fs.lstat(path.join(files, entry))).isFile());
  await fs.writeFile(path.join(bin, 'cursor-agent'), [
    '#!/bin/sh', 'export CURSOR_INVOKED_AS=cursor-agent',
    'base=$(dirname "$0")/../files/dist-package', 'exec "$base/node" "$base/index.js" "$@"', '',
  ].join('\n'), { mode: 0o755 });
  const clientPath = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  for (const scope of ['user', 'project']) for (const suite of ['matrix', 'candidate']) {
    const result = await runComponentQualification({ platform: 'cursor', scope, suite, clientPath });
    report.outcomes.push(result);
  }
  if (report.outcomes.every(result => result.status === 'passed')) report.status = 'passed';
} catch (error) {
  report.reason = error.message.replaceAll(root, '<isolated>');
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
if (report.status !== 'passed') process.exitCode = 1;
