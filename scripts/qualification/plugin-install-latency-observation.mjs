import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const commandWords = new Set([
  '--version', '-v', 'version', '--help', '-h', 'help', 'plugin', 'plugins', 'marketplace', 'marketplaces',
  'extensions', 'extension', 'list', 'ls', 'add', 'install', 'update', 'inspect', 'enable', 'disable',
  'config', 'get', 'api', 'GET', 'skills', 'serve', 'remove', 'uninstall',
]);

export function commandLabel({ command, args }) {
  const words = args.filter((arg) => commandWords.has(arg)).slice(0, 4);
  return [path.basename(command), ...words].join(' ');
}

// Observe direct children of the qualification worker, including system tools
// launched outside the native runner. Do not record arguments or environment.
export function observeProcesses(currentStage) {
  const original = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    const stage = currentStage();
    const startedMs = performance.now();
    const result = Reflect.apply(original, this, [options]);
    if (!stage || !this.pid) return result;
    const call = {
      label: commandLabel({ command: options.file, args: options.args.slice(1) }),
      pid: this.pid, startedMs, finishedMs: null, exitCode: null, signal: null,
    };
    stage.processes.push(call);
    this.once('exit', (exitCode, signal) => {
      Object.assign(call, { finishedMs: performance.now(), exitCode, signal });
    });
    return result;
  };
  return () => { ChildProcess.prototype.spawn = original; };
}

// These are real staging copies and rename calls, measured in the worker's
// monotonic clock so they can be compared directly with child processes.
export function observePortableWrites(buildRoot, isolatedRoot, currentStage, rows) {
  const requireFromBuild = createRequire(path.join(buildRoot, 'packages/cli/dist/src/portable/writer.js'));
  const extra = requireFromBuild('fs-extra');
  const promises = requireFromBuild('node:fs/promises');
  const stagingPath = (value) => typeof value === 'string' && path.isAbsolute(value)
    && value.startsWith(`${isolatedRoot}${path.sep}`) && path.relative(isolatedRoot, value).split(path.sep)
      .some((segment) => segment.startsWith('.aw-portable-stage-'));
  const restore = [];
  const observe = (object, method, classify) => {
    const original = object[method];
    object[method] = function (source, destination, ...args) {
      const stage = currentStage();
      const kind = stage === 'execute' && classify(source, destination);
      if (!kind) return Reflect.apply(original, this, [source, destination, ...args]);
      const row = { kind, path: path.relative(isolatedRoot, destination), startedMs: performance.now(), finishedMs: null, succeeded: false };
      rows.push(row);
      return Promise.resolve(Reflect.apply(original, this, [source, destination, ...args])).then((result) => {
        row.succeeded = true;
        return result;
      }).finally(() => {
        row.finishedMs = performance.now();
      });
    };
    restore.push(() => { object[method] = original; });
  };
  observe(extra, 'copy', (_source, destination) => stagingPath(destination) && 'stage-copy');
  observe(extra, 'rename', (source, destination) => stagingPath(source) && !stagingPath(destination) && 'publish');
  observe(promises, 'rename', (_source, destination) => stagingPath(destination)
    && path.basename(destination) === '.agent-workflows-owner.json' && 'owner-commit');
  syncBuiltinESMExports();
  return () => {
    for (const reset of restore.reverse()) reset();
    syncBuiltinESMExports();
  };
}

async function readTree(directory) {
  try { return await fs.readdir(directory, { recursive: true, withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
}

async function fileDigests(directory) {
  const entries = await readTree(directory);
  const files = entries.filter((entry) => entry.isFile() && entry.name !== '.agent-workflows-owner.json')
    .map((entry) => path.join(entry.parentPath, entry.name)).sort();
  const result = {};
  for (const file of files) {
    result[path.relative(directory, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  }
  return result;
}

function optionalJson(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse, (error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

export async function readSkillOutputs(catalogs, selectors, root) {
  const fixtures = [];
  for (const pluginId of selectors) {
    const [source, plugin] = pluginId.split('/');
    const catalog = catalogs[source];
    const fixture = catalog?.entries.find((entry) => entry.name === plugin);
    if (!fixture) continue;
    const directory = path.resolve(catalog.path, fixture.source, 'skills');
    const entries = await readTree(directory);
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'SKILL.md') {
        fixtures.push({ pluginId, version: fixture.version, skill: path.basename(entry.parentPath), files: await fileDigests(entry.parentPath) });
      }
    }
  }
  const wanted = new Set(fixtures.map(({ skill }) => skill));
  const outputs = [];
  // The Active store and AW package sources are not client output. Native
  // receipts carry source package ownership and registration separately.
  for (const hostDir of ['home', 'project', 'codex', 'claude', 'pi', 'grok', 'copilot', 'config', 'data', 'state', 'appdata', 'localappdata']) {
    for (const entry of await readTree(path.join(root, hostDir))) {
      if (!entry.isFile() || entry.name !== 'SKILL.md' || !wanted.has(path.basename(entry.parentPath))) continue;
      const owner = await optionalJson(path.join(entry.parentPath, '.agent-workflows-owner.json'));
      outputs.push({ path: path.relative(root, entry.parentPath), skill: path.basename(entry.parentPath), owner,
        files: await fileDigests(entry.parentPath) });
    }
  }
  return { fixtures, outputs };
}

export async function readNativePackages(targets, root) {
  const observations = [];
  for (const target of targets) {
    for (const { after } of target.deploymentReceipts ?? []) {
      const source = after?.nativeIdentity?.sourceLocation;
      if (!source || !source.startsWith(`${root}${path.sep}`)) continue;
      const resolved = await fs.realpath(source).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (!resolved || !resolved.startsWith(`${root}${path.sep}`)) continue;
      const owner = await optionalJson(path.join(resolved, '.agent-workflows-owner.json'));
      const manifests = [];
      for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.agents-plugin/plugin.json',
        '.github/plugin/plugin.json', 'package.json']) {
        const manifest = await optionalJson(path.join(resolved, file));
        if (manifest?.version) manifests.push({ file, name: manifest.name, version: manifest.version });
      }
      observations.push({ pluginId: target.pluginId, agent: target.agent ?? target.target,
        scope: target.scope, package: path.relative(root, resolved), owner, manifests });
    }
  }
  return observations;
}
