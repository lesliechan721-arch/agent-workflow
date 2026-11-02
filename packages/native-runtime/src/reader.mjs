import { readFileSync } from 'node:fs';

export { NATIVE_TOOL_CONTEXT_ENV, readNativeTool } from './reader-runtime.mjs';

// Read the standalone source, rather than a function transformed by the caller's
// test runner or bundler. Normalize checkout line endings for identical bundles.
const readerSource = readFileSync(new URL('./reader-runtime.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

export function createNativeToolReaderSource() {
  return readerSource;
}
