import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Test staging retains the complete installed resource source here. Root
// aliases contain only static imports and do not locate worker entries.
export function guideRuntimeScripts(from) {
  const plugin = fileURLToPath(new URL('../', from));
  const staged = path.join(plugin, '.agents-plugin/artifact-sources/codex/spawn-subagent-skill/0/scripts');
  return existsSync(staged) ? staged : path.join(plugin, 'skills/spawn-subagent/scripts');
}
