import { defaultPluginProcessRunner } from '../../packages/cli/dist/src/utils/plugin-scripts.js';
import { createManagedPluginTraceRunner } from './native-platform-managed-trace.mjs';

// Only outer AW loads this qualification preload. Its managed renderer and
// preApply children keep their private environment and independent cleanup.
defaultPluginProcessRunner.run = createManagedPluginTraceRunner(
  defaultPluginProcessRunner.run.bind(defaultPluginProcessRunner),
);
