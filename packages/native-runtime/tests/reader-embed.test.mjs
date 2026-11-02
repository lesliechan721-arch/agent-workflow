import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readNativeTool, createNativeToolReaderSource } from '../src/reader.mjs';
import { embedNativeRuntime } from '../scripts/embed.mjs';
import { tempFixture } from './fixtures.mjs';

const ready = { state: 'ready', protocol: 'aw.windows-job.v1', executable: 'C:\\native\\job.exe', sha256: `sha256:${'a'.repeat(64)}` };
const env = (tools) => ({ AW_NATIVE_TOOL_CONTEXT: JSON.stringify({ schemaVersion: 1, tools }) });
const rejected = (error) => error.code === 'nativeContextInvalid' && error.message === 'nativeContextInvalid';

test('generated reader independently consumes only declared key/protocol and fixed backend', async () => {
  const generated = await import(`data:text/javascript;base64,${Buffer.from(createNativeToolReaderSource()).toString('base64')}`);
  for (const reader of [readNativeTool, generated.readNativeTool]) {
    const result = reader('job', ready.protocol, env({ job: ready }));
    assert.deepEqual(result, ready);
    assert.ok(Object.isFrozen(result));
    const unavailable = { state: 'unavailable', protocol: ready.protocol, code: 'nativeCacheMiss' };
    assert.deepEqual(reader('job', ready.protocol, env({ job: unavailable })), unavailable);
    assert.deepEqual(reader('job', ready.protocol, { aw_native_tool_context: env({ job: ready }).AW_NATIVE_TOOL_CONTEXT }), ready);
    assert.throws(() => reader('other-producer', ready.protocol, env({ job: ready })), rejected);
    assert.throws(() => reader('job', 'aw.other.v1', env({ job: ready })), rejected);
    assert.throws(() => reader('job', ready.protocol, {}), rejected);
    assert.throws(() => reader('job', ready.protocol, { ...env({ job: ready }), aw_native_tool_context: '{}' }), rejected);
    assert.throws(() => reader('job', ready.protocol, env({ job: { ...ready, executable: 'relative.exe' } })), rejected);
    assert.throws(() => reader('job', ready.protocol, env({ job: { ...ready, path: '/override' } })), rejected);
    assert.throws(() => reader('job', ready.protocol, env({ job: ready, malformed: { state: 'other' } })), rejected);
  }
});

test('offline embed imports work from an isolated dist with descriptor and reader only', async (t) => {
  const input = await tempFixture(t);
  await writeFile(path.join(input.directory, 'consumer.mjs'), `import { parseNativeToolDescriptor } from '@lesliechan721/aw-native-runtime/descriptor';\nimport { createNativeToolReaderSource } from '@lesliechan721/aw-native-runtime/reader';\nexport { parseNativeToolDescriptor, createNativeToolReaderSource };\n`);
  await writeFile(path.join(input.directory, 'consumer.d.ts'), "export type { NativeToolDescriptor } from '@lesliechan721/aw-native-runtime/descriptor';\n");
  await embedNativeRuntime(input.directory, { offline: true });
  const consumer = await import(pathToFileURL(path.join(input.directory, 'consumer.mjs')).href);
  assert.equal(consumer.parseNativeToolDescriptor(input.descriptor).tool.protocol, ready.protocol);
  const reader = await import(`data:text/javascript;base64,${Buffer.from(consumer.createNativeToolReaderSource()).toString('base64')}`);
  assert.deepEqual(reader.readNativeTool('job', ready.protocol, env({ job: ready })), ready);
  assert.deepEqual((await readdir(path.join(input.directory, 'native-runtime'))).sort(), ['descriptor.d.mts', 'descriptor.mjs', 'reader-runtime.mjs', 'reader.d.mts', 'reader.mjs']);
});

test('full embed runs a resolver with no workspace dependency in the installed closure', async (t) => {
  const input = await tempFixture(t);
  await writeFile(path.join(input.directory, 'consumer.mjs'), "export { importNativeTool } from '@lesliechan721/aw-native-runtime';\n");
  await embedNativeRuntime(input.directory);
  const consumer = await import(pathToFileURL(path.join(input.directory, 'consumer.mjs')).href);
  const result = await consumer.importNativeTool(input);
  assert.deepEqual(await readFile(result.executable), input.binary);
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
