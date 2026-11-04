import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fail, object } from '../runtime/contracts.mjs';
import { atomicJson, safePath, textFromBytes } from '../runtime/files.mjs';

const invalid = () => fail('communicationPermissionConfigInvalid', 'The Antigravity user settings are invalid or unsafe. Repair settings.json, then start a new run.');
const conflict = () => fail('communicationPermissionConflict', 'Antigravity settings changed while being read. Start a new run to read the current settings.');

/** Only the fixed AW host and the dedicated communication ID may be allowed. */
export function antigravityPermissionRule(command, args, platform = process.platform) {
  if (!['darwin', 'linux'].includes(platform)) fail('communicationPermissionUnsupported', 'Exact Antigravity command permissions require qualification on this platform.');
  if (!Array.isArray(args) || args.length !== 5 || args[1] !== 'command' || args[2] !== 'run' || !/^cmdp_[0-9a-f]{16}$/.test(args[3]) || args[4] !== '--') fail('communicationPermissionUnsupported', 'Use the exact installed Guide communication command.');
  if (![command, args[0]].every((value) => typeof value === 'string' && path.posix.isAbsolute(value) && path.posix.normalize(value) === value && /^\/[A-Za-z0-9_./:@%+=,-]+$/.test(value))) fail('communicationPermissionUnsupported', 'This AW host path requires an Antigravity token quoting qualification. Use a qualified AW host path.');
  return `command(${[command, ...args].join(' ')})`;
}

/** Keep the token prefix and also cover quoted tokens in agy's raw matcher. */
export function antigravityPermissionRules(command, args, platform = process.platform) {
  const prefix = antigravityPermissionRule(command, args, platform);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entry = (value) => `(?:${escape(value)}|'${escape(value)}'|"${escape(value)}")`;
  // No literal whitespace: agy also tokenizes regex rules. The raw branch
  // accepts shell literal arguments, never expansion or extra shell actions.
  const blank = String.raw`[\x20\t]`;
  const literal = String.raw`(?:[-A-Za-z0-9_./:@%+=,]+|'[^']*'|"(?:[^"\\$\x60]|\\[^\r\n])*"|\\[^\r\n])+`;
  const pattern = `${blank}*${[command, ...args].map(entry).join(`${blank}+`)}(?:${blank}+${literal})*${blank}*`;
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
export function assertAntigravityPermissionAllowed(settings, command, args) {
  settingsObject(settings);
  if (settings.toolPermission === 'strict') fail('communicationPermissionDenied', 'Antigravity strict tool permissions require approval even for an allow rule. Change that policy or disable communication.');
  for (const rule of [...(settings.permissions?.deny ?? []), ...(settings.permissions?.ask ?? [])]) {
    const target = /^command\(([\s\S]*)\)$/.exec(rule)?.[1];
    if (target === undefined) continue;
    if (target === '*') fail('communicationPermissionDenied', 'An Antigravity Ask or Deny rule blocks the communication command. Keep the policy and disable communication, or change it explicitly.');
    if (target.startsWith('regex:') || /["'`$\\]/.test(target)) fail('communicationPermissionUnsupported', 'An Antigravity command policy needs a native matching check before communication can be enabled.');
    const prefix = target.trim().split(/\s+/);
    // A restriction on any prefix, or a more specific message invocation,
    // prevents an unrestricted communication path.
    if (prefix.slice(0, args.length + 1).every((token, index) => token === [command, ...args][index])) fail('communicationPermissionDenied', 'An Antigravity Ask or Deny rule blocks the communication command. Keep the policy and disable communication, or change it explicitly.');
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function owned(stat, kind) {
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) || typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()) || kind === 'file' && stat.nlink !== 1n) invalid();
}

async function checkedParents(home) {
  await safePath(home, 'directory');
  owned(await fs.lstat(home, { bigint: true }), 'directory');
  let target = home;
  for (const component of ['.gemini', 'antigravity-cli']) {
    target = path.join(target, component);
    let stat;
    try { stat = await fs.lstat(target, { bigint: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
    owned(stat, 'directory');
    if ((stat.mode & 0o022n) !== 0n) invalid();
  }
  return true;
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
    return document;
  } finally { await handle.close(); }
}

/** Preserve the user's allow list in a session-only override; never write it back. */
export async function prepareAntigravityPermission({ environment = process.env, command, args, directory }) {
  const rules = antigravityPermissionRules(command, args);
  await safePath(command, 'file');
  await safePath(args[0], 'file');
  const target = antigravitySettingsPath(environment);
  const home = path.dirname(path.dirname(path.dirname(target)));
  let document;
  try {
    document = await checkedParents(home) ? await readSettings(target) ?? {} : {};
    assertAntigravityPermissionAllowed(document, command, args);
  } catch (error) {
    if (error.code?.startsWith('communicationPermission')) throw error;
    invalid();
  }
  // agy replaces the supplied allow leaf, but keeps omitted ask/deny and all
  // other settings. Copy only allow so policies keep their native sources.
  const settings = { permissions: { allow: [...new Set([...(document.permissions?.allow ?? []), ...rules])] } };
  const settingsFile = path.join(directory, 'antigravity-settings.json');
  try {
    await safePath(directory, 'directory');
    await atomicJson(settingsFile, settings);
  } catch {
    fail('communicationPermissionWriteFailed', 'The Antigravity session settings could not be prepared in the private execution directory. Check runtime access and start a new run.');
  }
  return { settingsFile, rules };
}
