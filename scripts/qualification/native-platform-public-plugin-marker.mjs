import { defaultPluginProcessRunner } from '../../packages/cli/dist/src/utils/plugin-scripts.js';
import { createManagedPluginTraceRunner, managedTraceInstalled } from './native-platform-managed-trace.mjs';

// The trace installs the same marker forwarding when enabled. Otherwise only
// the managed renderer/preApply calls need a wrapper in this outer AW process.
if (!managedTraceInstalled) {
  defaultPluginProcessRunner.run = createManagedPluginTraceRunner(defaultPluginProcessRunner.run.bind(defaultPluginProcessRunner));
}
