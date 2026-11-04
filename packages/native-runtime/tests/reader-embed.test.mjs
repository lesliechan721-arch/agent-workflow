import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readNativeTool, createNativeToolReaderSource } from '../src/reader.mjs';
import { embedNativeRuntime } from '../scripts/embed.mjs';

const ready = { state: 'ready', protocol: 'aw.windows-job.v1', executable: 'C:\\native\\job.exe' };
const env = (tools) => ({ AW_NATIVE_TOOL_CONTEXT: JSON.stringify({ schemaVersion: 1, tools }) });
const rejected = (error) => error.code === 'nativeContextInvalid' && error.message === 'nativeContextInvalid';

test('generated reader independently consumes only declared key/protocol and fixed backend', async () => {
  const generated = await import(`data:text/javascript;base64,${Buffer.from(createNativeToolReaderSource()).toString('base64')}`);
  for (const reader of [readNativeTool, generated.readNativeTool]) {
    const result = reader('job', ready.protocol, env({ job: ready }));
    assert.deepEqual(result, ready);
    assert.ok(Object.isFrozen(result));
    const unavailable = { state: 'unavailable', protocol: ready.protocol, code: 'nativePackageUnavailable' };
    assert.deepEqual(reader('job', ready.protocol, env({ job: unavailable })), unavailable);
    assert.deepEqual(reader('job', ready.protocol, { aw_native_tool_context: env({ job: ready }).AW_NATIVE_TOOL_CONTEXT }), ready);
    assert.throws(() => reader('other-producer', ready.protocol, env({ job: ready })), rejected);
    assert.throws(() => reader('job', 'aw.other.v1', env({ job: ready })), rejected);
    assert.throws(() => reader('job', ready.protocol, {}), rejected);
    assert.throws(() => reader('job', ready.protocol, { ...env({ job: ready }), aw_native_tool_context: '{}' }), rejected);
    assert.throws(() => reader('job', ready.protocol, env({ job: { ...ready, executable: 'relative.exe' } })), rejected);
    assert.throws(() => reader('job', ready.protocol, env({ job: { ...ready, sha256: `sha256:${'a'.repeat(64)}` } })), rejected);
    assert.throws(() => reader('job', ready.protocol, env({ job: { ...ready, path: '/override' } })), rejected);
    assert.throws(() => reader('job', ready.protocol, env({ job: ready, malformed: { state: 'other' } })), rejected);
  }
});

test('embedded reader works from an isolated dist without a runtime dependency', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aw-native-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'consumer.mjs'), "export { createNativeToolReaderSource } from '@lesliechan721/aw-native-runtime/reader';\n");
  await writeFile(path.join(directory, 'consumer.d.ts'), "export type { NativeToolReady } from '@lesliechan721/aw-native-runtime/reader';\n");
  await mkdir(path.join(directory, 'native-runtime'));
  await writeFile(path.join(directory, 'native-runtime', 'obsolete.mjs'), 'export {};');
  await embedNativeRuntime(directory);
  const consumer = await import(pathToFileURL(path.join(directory, 'consumer.mjs')).href);
  const reader = await import(`data:text/javascript;base64,${Buffer.from(consumer.createNativeToolReaderSource()).toString('base64')}`);
  assert.deepEqual(reader.readNativeTool('job', ready.protocol, env({ job: ready })), ready);
  assert.deepEqual((await readdir(path.join(directory, 'native-runtime'))).sort(), ['reader-runtime.mjs', 'reader.d.mts', 'reader.mjs']);
});

test('reader bytes remain identical under the actual transformed test runner', async () => {
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../../../scripts/test/run-vitest.mjs', import.meta.url)),
    'run', '--config', fileURLToPath(new URL('../vitest.config.mjs', import.meta.url)),
  ], {
    cwd: fileURLToPath(new URL('../../cli/', import.meta.url)),
    timeout: 60_000,
    maxBuffer: 256 * 1024,
  });
});
