import { fileURLToPath } from 'node:url';

// Test staging carries the complete command source in the same layout.
export function guideRuntimeScripts(from) {
  return fileURLToPath(new URL('../commands/scripts', from));
}
