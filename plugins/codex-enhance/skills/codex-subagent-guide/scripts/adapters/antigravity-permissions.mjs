import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fail, object } from '../runtime/contracts.mjs';
import { safePath, textFromBytes } from '../runtime/files.mjs';

const invalid = () => fail('communicationPermissionConfigInvalid', 'The Antigravity user settings are invalid or unsafe. Repair settings.json, then start a new run.');
const conflict = () => fail('communicationPermissionConflict', 'Antigravity settings changed during permission preparation. Start a new run to read the current settings.');

/** Only an unambiguous literal token pair is supported without a matcher probe. */
export function antigravityPermissionRule(command, script, platform = process.platform) {
  if (!['darwin', 'linux'].includes(platform)) fail('communicationPermissionUnsupported', 'Exact Antigravity command permissions require qualification on this platform.');
  if (![command, script].every((value) => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && /^\/[A-Za-z0-9_./:@%+=,-]+$/.test(value))) fail('communicationPermissionUnsupported', 'This installation path requires an Antigravity token quoting qualification. Use a qualified path or explicit full-access.');
  return `command(${command} ${script})`;
}

/** Keep the token prefix and also cover quoted executables in agy's raw matcher. */
export function antigravityPermissionRules(command, script, platform = process.platform) {
  const prefix = antigravityPermissionRule(command, script, platform);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = (value) => `(?:${escape(value)}|'${escape(value)}'|"${escape(value)}")`;
  // No literal whitespace in the regex: agy also tokenizes regex rules. In the
  // raw branch, accept only shell literal arguments, never extra shell actions.
  const blank = String.raw`[\x20\t]`;
  const literal = String.raw`(?:[-A-Za-z0-9_./:@%+=,]+|'[^']*'|"(?:[^"\\$\x60]|\\[^\r\n])*"|\\[^\r\n])+`;
  const pattern = `${blank}*${entry(command)}${blank}+${entry(script)}(?:${blank}+${literal})*${blank}*`;
  return [prefix, `command(regex:${pattern})`];
}

export function antigravitySettingsPath(environment = process.env, platform = process.platform) {
  const home = platform === 'win32' ? environment.USERPROFILE || os.homedir() : environment.HOME || os.homedir();
  if (typeof home !== 'string' || !path.isAbsolute(home) || home.includes('\0')) invalid();
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

function settingsObject(value) {
  if (!object(value) || value.permissions !== undefined && !object(value.permissions)) invalid();
  for (const kind of ['allow', 'ask', 'deny']) {
    const list = value.permissions?.[kind];
    if (list !== undefined && (!Array.isArray(list) || list.some((rule) => typeof rule !== 'string'))) invalid();
  }
  if (value.toolPermission !== undefined && (typeof value.toolPermission !== 'string' || !['request-review', 'proceed-in-sandbox', 'always-proceed', 'strict'].includes(value.toolPermission))) invalid();
  return value;
}

/** Recognize definite policy conflicts. Unknown regex policies stay blocked. */
export function assertAntigravityPermissionAllowed(settings, command, script) {
  settingsObject(settings);
  if (settings.toolPermission === 'strict') fail('communicationPermissionDenied', 'Antigravity strict tool permissions require approval even for an allow rule. Change that policy or disable communication.');
  for (const rule of [...(settings.permissions?.deny ?? []), ...(settings.permissions?.ask ?? [])]) {
    const target = /^command\(([\s\S]*)\)$/.exec(rule)?.[1];
    if (target === undefined) continue;
    if (target === '*') fail('communicationPermissionDenied', 'An Antigravity Ask or Deny rule blocks the communication command. Keep the policy and disable communication, or change it explicitly.');
    if (target.startsWith('regex:') || /["'`$\\]/.test(target)) fail('communicationPermissionUnsupported', 'An Antigravity command policy needs a native matching check before communication can be enabled.');
    const prefix = target.trim().split(/\s+/);
    // A more specific restriction on this script (including --bridge,
    // send/receive or text) also prevents an unrestricted communication path.
    if (prefix.slice(0, 2).every((token, index) => token === [command, script][index])) fail('communicationPermissionDenied', 'An Antigravity Ask or Deny rule blocks the communication command. Keep the policy and disable communication, or change it explicitly.');
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function owned(stat, kind) {
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) || kind === 'file' && stat.nlink !== 1n) invalid();
}

async function checkedParents(home, create) {
  await safePath(home, 'directory');
  owned(await fs.lstat(home, { bigint: true }), 'directory');
  const parents = [];
  let target = home;
  for (const component of ['.gemini', 'antigravity-cli']) {
    target = path.join(target, component);
    let stat;
    try { stat = await fs.lstat(target, { bigint: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return null;
      try { await fs.mkdir(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await fs.lstat(target, { bigint: true });
    }
    owned(stat, 'directory');
    if ((stat.mode & 0o022n) !== 0n) invalid();
    parents.push({ target, stat });
  }
  return parents;
}

async function readSettings(target) {
  let before;
  try { before = await fs.lstat(target, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  owned(before, 'file');
  if (before.size > 2n * 1024n * 1024n) invalid();
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) conflict();
    const bytes = await handle.readFile();
    if (bytes.length > 2 * 1024 * 1024 || !sameFile(opened, await handle.stat({ bigint: true }))) conflict();
    let document;
    try { document = settingsObject(JSON.parse(textFromBytes(bytes))); }
    catch (error) { if (error.code === 'communicationPermissionConfigInvalid') throw error; invalid(); }
    return { stat: opened, bytes, document };
  } finally { await handle.close(); }
}

/** Append reusable script-entry rules; no run ID, binding or text is stored. */
export async function prepareAntigravityPermission({ environment = process.env, command, script }) {
  const rules = antigravityPermissionRules(command, script);
  const rule = rules[0];
  await safePath(command, 'file');
  await safePath(script, 'file');
  const target = antigravitySettingsPath(environment);
  const home = path.dirname(path.dirname(path.dirname(target)));
  let temporary;
  try {
    const parents = await checkedParents(home, true);
    const previous = await readSettings(target);
    const document = previous?.document ?? {};
    assertAntigravityPermissionAllowed(document, command, script);
    const missing = rules.filter((candidate) => !document.permissions?.allow?.includes(candidate));
    if (!missing.length) return { status: 'existing', rule, rules };
    const next = { ...document, permissions: { ...document.permissions, allow: [...(document.permissions?.allow ?? []), ...missing] } };
    temporary = path.join(path.dirname(target), `.settings-${randomUUID()}.tmp`);
    const mode = previous ? Number(previous.stat.mode & 0o777n) : 0o600;
    if (previous && (mode & 0o200) === 0) fail('communicationPermissionWriteFailed', 'Antigravity settings.json is read-only. Restore write access, then start a new run.');
    const handle = await fs.open(temporary, 'wx', mode);
    try { await handle.chmod(mode); await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    const currentParents = await checkedParents(home, false);
    if (!currentParents || currentParents.some((item, index) => item.stat.dev !== parents[index].stat.dev || item.stat.ino !== parents[index].stat.ino)) conflict();
    const current = await readSettings(target);
    if (previous ? !current || !sameFile(previous.stat, current.stat) || !previous.bytes.equals(current.bytes) : current !== null) conflict();
    await fs.rename(temporary, target);
    temporary = undefined;
    return { status: 'added', rule, rules };
  } catch (error) {
    if (error.code?.startsWith('communicationPermission')) throw error;
    fail('communicationPermissionWriteFailed', 'The Antigravity user permission could not be saved safely. Repair settings.json access and start a new run.');
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}
