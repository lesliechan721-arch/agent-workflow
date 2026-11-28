import { realpathSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

export function pluginTestContextGuardUrl(testFiles) {
  const url = new URL(import.meta.url);
  url.searchParams.set('files', JSON.stringify(testFiles));
  return url.href;
}

const files = new URL(import.meta.url).searchParams.get('files');
// Node's --import runs in the test runner, its file workers and potentially
// an explicitly forked fixture. Only guard the actual declared test entries.
function isDeclaredTestEntry(files) {
  const declared = JSON.parse(files).map((file) => realpathSync.native(file));
  if (!process.argv[1]) return false;
  let entry;
  try {
    entry = realpathSync.native(process.argv[1]);
  } catch (error) {
    // An eval/print fixture may pass arbitrary non-file arguments in argv.
    // Declared files above must resolve; other resolution failures are errors.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
  // Relative comparison folds case on Windows, but not on potentially
  // case-sensitive POSIX filesystems. Realpath resolves filesystem aliases.
  return declared.some((file) => path.relative(file, entry) === '');
}

if (files && isDeclaredTestEntry(files)) {
  let conflict;
  const rejectRead = (key) => {
    if (typeof key !== 'string' || !['AW_PLUGIN_CONTEXT', 'AW_PLUGIN_PLATFORM'].includes(key.toUpperCase())) return;
    conflict ??= `Target-platform-agnostic test ${process.argv[1]} read ${key}; remove its declaration or make the test target-independent.`;
    throw new Error(conflict);
  };
  const env = process.env;
  process.env = new Proxy(env, {
    get(target, key) { rejectRead(key); return Reflect.get(target, key); },
    has(target, key) { rejectRead(key); return Reflect.has(target, key); },
    getOwnPropertyDescriptor(target, key) { rejectRead(key); return Reflect.getOwnPropertyDescriptor(target, key); },
    // Node's process.env requires its own receiver for writes to existing keys.
    // Keep native fixture updates working without relaxing the two read guards.
    set(target, key, value) { return Reflect.set(target, key, value); },
  });
  // Keep node:process's named env export on the same guarded object.
  syncBuiltinESMExports();
  process.on('exit', () => {
    if (conflict) {
      writeSync(2, `${conflict}\n`);
      // An optional read/fallback or a caught assertion must not hide a bad
      // declaration from the parent Node runner.
      process.exitCode = 1;
    }
  });
}
