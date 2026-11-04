import test from 'node:test';

// Real Windows behavior needs a runner-resolved tool. Fixture mode exercises
// controlled native boundaries and never counts as native support evidence.
export const windowsNativeTests = process.platform !== 'win32'
  || ['installed', 'source-candidate'].includes(process.env.AW_PLUGIN_TEST_NATIVE_MODE);

export function nativeTest(name, options, body) {
  if (typeof options === 'function') { body = options; options = {}; }
  return test(name, { ...options, skip: options?.skip || (!windowsNativeTests && 'Select an explicit native resolver mode for real Windows tests.') }, body);
}
