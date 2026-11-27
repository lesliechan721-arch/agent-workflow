import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { defaultPluginProcessRunner } from '../../packages/cli/dist/src/utils/plugin-scripts.js';
import { createManagedPluginTraceRunner, managedTraceInstalled } from './native-platform-managed-trace.mjs';

const frozenRoot = new URL(import.meta.url).searchParams.get('frozenRoot');
let runner = defaultPluginProcessRunner;
if (frozenRoot !== null) {
  assert(process.argv[1], 'Historical AW preload requires its package entry.');
  const { resolveFrozenPublicAwPackage } = await import('./native-platform-public-process.mjs');
  const frozen = resolveFrozenPublicAwPackage(frozenRoot, process.argv[1]);
  runner = (await import(pathToFileURL(frozen.pluginScripts).href)).defaultPluginProcessRunner;
}

// The trace wraps the candidate singleton when enabled. A separate historical
// CLI needs the same exact marker forwarding on its own singleton instead.
if (runner !== defaultPluginProcessRunner || !managedTraceInstalled) {
  runner.run = createManagedPluginTraceRunner(runner.run.bind(runner));
}
