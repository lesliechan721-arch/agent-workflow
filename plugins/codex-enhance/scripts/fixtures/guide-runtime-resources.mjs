import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Test staging retains the complete installed resource source here. Its root
// aliases contain only static Node imports and can omit URL-loaded helpers.
const preparedAliases = new Set();

export function guideRuntimeScripts(from) {
  const plugin = fileURLToPath(new URL('../', from));
  const alias = path.join(plugin, 'skills/codex-subagent-guide/scripts');
  const staged = path.join(plugin, '.agents-plugin/artifact-sources/codex/codex-subagent-guide-skill/0/scripts');
  if (!existsSync(staged)) return alias;
  // Parent-side ACL calls use the statically imported platform alias. Prepare
  // its URL-loaded resources before callers can invoke those Windows APIs.
  if (!preparedAliases.has(alias)) {
    const target = path.join(alias, 'runtime/native');
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      const temporary = mkdtempSync(`${target}-`);
      try {
        cpSync(path.join(staged, 'runtime/native'), temporary, { recursive: true });
        try { renameSync(temporary, target); }
        catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !existsSync(target)) throw error; }
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    preparedAliases.add(alias);
  }
  return staged;
}
