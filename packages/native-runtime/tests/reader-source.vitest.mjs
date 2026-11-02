import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createNativeToolReaderSource } from '../src/reader.mjs';

test('the transformed runner and native Node emit the same executable reader contract', async () => {
  const readerUrl = new URL('../src/reader.mjs', import.meta.url).href;
  const ready = { state: 'ready', protocol: 'aw.windows-job.v1', executable: '/fixture/native.exe', sha256: `sha256:${'a'.repeat(64)}` };
  const script = `import { createNativeToolReaderSource } from ${JSON.stringify(readerUrl)};
    const source = createNativeToolReaderSource();
    const reader = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const tool = reader.readNativeTool('job', 'aw.windows-job.v1', { AW_NATIVE_TOOL_CONTEXT: JSON.stringify({ schemaVersion: 1, tools: { job: ${JSON.stringify(ready)} } }) });
    console.log(JSON.stringify({ source, tool }));`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { timeout: 10_000, maxBuffer: 128 * 1024 });
  const native = JSON.parse(result.stdout);
  expect(native.source).toBe(createNativeToolReaderSource());
  expect(native.tool).toEqual(ready);
});
