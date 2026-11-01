import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Test staging retains the complete installed resource source here. Its root
// aliases contain only static Node imports and can omit URL-loaded helpers.
export function guideRuntimeScripts(from) {
  const plugin = fileURLToPath(new URL('../', from));
  const staged = path.join(plugin, '.agents-plugin/artifact-sources/codex/codex-subagent-guide-skill/0/scripts');
  return existsSync(staged) ? staged : path.join(plugin, 'skills/codex-subagent-guide/scripts');
}
