import path from 'node:path';
import fg from 'fast-glob';
import { LIMITS, fail, parseSelectors } from './contracts.mjs';
import { createContext } from './io.mjs';

const defaults = new Set(['node_modules', 'dist', 'coverage', '.git', '.turbo', '.next', 'build', 'tmp']);
const posix = (value) => value.replace(/\\/g, '/');
function normalizePattern(value, workspace) {
  const relative = posix(path.isAbsolute(value) ? path.relative(workspace, value) : value);
  return relative.startsWith('./') ? relative.slice(2) : relative;
}

async function workspaceDirectory(workspace, context) {
  if (typeof workspace !== 'string' || workspace.includes('\0') || !path.isAbsolute(workspace) || path.normalize(workspace) !== workspace) {
    fail('fileSelectionInputInvalid', 'workspace must be a real, normalized absolute directory.', 2);
  }
  const stat = await context.optionalStat(workspace);
  if (!stat?.isDirectory()) fail('fileSelectionInputInvalid', 'workspace must be an existing directory.', 2);
  if (await context.call('realpath', workspace) !== workspace) {
    fail('fileSelectionInputInvalid', 'workspace must use its real absolute directory path.', 2);
  }
  await context.directoryReadable(workspace);
}

async function partition(selectors, workspace, context) {
  const result = { globs: [], excludes: [], files: [], directories: [] };
  for (const value of parseSelectors(selectors, context.limits)) {
    if (value.startsWith('!')) result.excludes.push(normalizePattern(value.slice(1), workspace));
    else if (fg.isDynamicPattern(value)) result.globs.push(normalizePattern(value, workspace));
    else {
      const target = path.resolve(workspace, value);
      const stat = await context.optionalStat(target);
      if (!stat) fail('fileSelectionPathMissing', 'An explicit file or directory is missing. Check the selected paths.', 2);
      if (stat.isFile()) result.files.push(target);
      else if (stat.isDirectory()) result.directories.push(target);
      else fail('fileSelectionInputInvalid', 'An explicit path must be a file or directory.', 2);
    }
  }
  result.patterns = [...result.globs, ...result.files.map((file) => posix(path.relative(workspace, file) || path.basename(file))),
    ...result.directories.map((directory) => {
      const relative = posix(path.relative(workspace, directory));
      return relative ? `${relative.replace(/\/+$/g, '')}/**/*` : '**/*';
    })];
  result.usesGlob = !!(result.globs.length || result.excludes.length || result.directories.length);
  return result;
}

async function collect(patterns, excludes, workspace, context) {
  const result = new Set();
  if (!patterns.length) return [];
  const tasks = fg.generateTasks(patterns, { ignore: excludes });
  for (const task of tasks) {
    // Missing dynamic roots are legitimate unmatched patterns. Once a root is
    // present, all traversal errors must survive fast-glob's ENOENT filtering.
    const root = await context.optionalStat(path.resolve(workspace, task.base));
    if (task.dynamic && !root?.isDirectory()) continue;
    // fast-glob 3 also stats synthetic !exclusion strings in a static task.
    // These are parser bookkeeping, not files encountered while scanning.
    const synthetic = new Set(task.negative.map((pattern) => path.resolve(workspace, `!${pattern}`)));
    const adapter = { ...context.adapter, lstat: (target, ...args) => {
      const callback = args.pop();
      context.call('lstat', target, ...args).then((value) => callback(null, value), (error) => {
        callback(synthetic.has(String(target)) && error.cause?.code === 'ENOENT' ? error.cause : error);
      });
    } };
    const stream = fg.stream(task.positive, { cwd: workspace, dot: true, onlyFiles: true,
      followSymbolicLinks: false, suppressErrors: false, ignore: excludes, fs: adapter, concurrency: 4 });
    try {
      for await (const match of stream) {
        context.check(); result.add(path.resolve(workspace, String(match)));
        if (result.size > context.limits.files) fail('fileSelectionLimitExceeded', 'The selection exceeds its file count limit. Reduce the selection.');
      }
    } finally { stream.destroy(); }
  }
  return [...result];
}

function ignoreRuleMatches(relative, rule) {
  const normalized = rule.replace(/\\+/g, '/');
  if (normalized.endsWith('/')) {
    const directory = normalized.slice(0, -1);
    return relative === directory || relative.startsWith(`${directory}/`);
  }
  let expression = '';
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index] === '*') {
      if (normalized[index + 1] === '*') { expression += '.*'; index++; }
      else expression += '[^/]*';
    } else expression += normalized[index].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(relative);
}

async function ignoreSets(workspace, context) {
  const sets = [];
  for (const file of await collect(['**/.gitignore'], [], workspace, context)) {
    const patterns = (await context.readIgnore(file)).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    if (patterns.length) sets.push({ directory: path.dirname(file), patterns });
  }
  return sets;
}

async function defaultMarkers(file, workspace, context, cache) {
  const segments = path.relative(workspace, file).split(path.sep);
  for (let index = 0; index < segments.length - 1; index++) {
    if (!defaults.has(segments[index])) continue;
    const directory = path.resolve(workspace, ...segments.slice(0, index + 1));
    if (!cache.has(directory)) cache.set(directory, !!(await context.optionalStat(path.join(directory, '.gitignore')))?.isFile());
  }
}

async function resolve(input, context) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 3 || !['protocolVersion', 'workspace', 'selectors'].every((key) => Object.hasOwn(input, key)) || input.protocolVersion !== 1) {
    fail('fileSelectionInputInvalid', 'Expected only protocolVersion: 1, workspace and selectors.', 2);
  }
  if (Buffer.byteLength(JSON.stringify(input)) > context.limits.inputBytes) fail('fileSelectionLimitExceeded', 'The input exceeds its byte limit. Reduce the selection.');
  parseSelectors(input.selectors, context.limits);
  await workspaceDirectory(input.workspace, context);
  if (!input.selectors.length) return { protocolVersion: 1, files: [] };
  const selection = await partition(input.selectors, input.workspace, context);
  if (!selection.patterns.length) fail('fileSelectionEmpty', 'File selection has no matches. Add a positive selector.', 2);
  let candidates;
  if (!selection.usesGlob) candidates = selection.files;
  else {
    const ignores = await ignoreSets(input.workspace, context);
    candidates = await collect(selection.patterns, selection.excludes, input.workspace, context);
    const dot = selection.patterns.some((pattern) => pattern.split('/').some((segment) => segment.startsWith('.') && segment.length > 1));
    candidates = candidates.filter((file) => !ignores.some(({ directory, patterns }) => file.startsWith(directory) &&
      patterns.some((rule) => ignoreRuleMatches(path.relative(directory, file) || path.basename(file), rule))))
      .filter((file) => dot || !path.basename(file).startsWith('.'));
  }
  const allowed = [...selection.files, ...selection.directories.filter((directory) => defaults.has(path.basename(directory)))];
  const markers = new Map();
  const files = [];
  for (const file of [...new Set(candidates)]) {
    await defaultMarkers(file, input.workspace, context, markers);
    if (!allowed.some((entry) => file === entry || file.startsWith(`${entry}${path.sep}`))) {
      const segments = path.relative(input.workspace, file).split(path.sep);
      if (segments.some((segment, index) => defaults.has(segment) && !markers.get(path.resolve(input.workspace, ...segments.slice(0, index + 1))))) continue;
    }
    const stat = await context.call('stat', file);
    if (!stat.isFile()) fail('fileSelectionReadFailed', 'A selected file changed type. Retry on a stable file tree.');
    await context.readable(file);
    files.push(path.normalize(file));
    if (files.length > context.limits.files) fail('fileSelectionLimitExceeded', 'The selection exceeds its file count limit. Reduce the selection.');
  }
  if (!files.length) fail('fileSelectionEmpty', 'File selection has no matches. Check positive selectors and exclusions.', 2);
  files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const result = { protocolVersion: 1, files };
  if (Buffer.byteLength(JSON.stringify(result)) + 1 > context.limits.outputBytes) fail('fileSelectionLimitExceeded', 'The result exceeds its byte limit. Reduce the selection.');
  return result;
}

async function withinDeadline(operation, options) {
  const context = createContext(options);
  let timer;
  try {
    return await Promise.race([operation(context), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('File selection exceeded its time limit. Reduce the selection.'),
        { code: 'fileSelectionLimitExceeded', exitCode: 1 })), context.limits.durationMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function resolveFiles(input, options) { return withinDeadline((context) => resolve(input, context), options); }

// Oracle suppresses some scan and ignore errors. Check only read completeness;
// never match selectors, produce a path set, read material bodies or use a helper.
export function assertNativeSelectionReadable(workspace, selectors, options) {
  return withinDeadline(async (context) => {
    parseSelectors(selectors, context.limits);
    await workspaceDirectory(workspace, context);
    if (!selectors.length) return;
    const selection = await partition(selectors, workspace, context);
    for (const file of selection.files) { await context.readable(file); await defaultMarkers(file, workspace, context, new Map()); }
    if (!selection.usesGlob || !selection.patterns.length) return;
    const roots = new Map([[workspace, Infinity]]);
    for (const task of fg.generateTasks(selection.patterns)) {
      if (!task.dynamic) continue;
      const root = path.resolve(workspace, task.base);
      const depth = Math.max(...task.positive.map((pattern) => {
        const segments = path.posix.relative(posix(task.base), pattern).split('/');
        return segments.some((segment) => segment.includes('**')) ? Infinity : Math.max(0, segments.length - 1);
      }));
      roots.set(root, Math.max(roots.get(root) ?? -1, depth));
    }
    const visited = new Map();
    const markers = new Map();
    async function walk(directory, readIgnores, depth) {
      const key = `${readIgnores}:${directory}`;
      if ((visited.get(key) ?? -1) >= depth) return;
      visited.set(key, depth);
      await context.directoryReadable(directory);
      for (const entry of await context.list(directory)) {
        const child = path.join(directory, entry.name);
        const stat = await context.call('lstat', child);
        if (stat.isDirectory() && depth > 0) await walk(child, readIgnores, depth - 1);
        else if (stat.isFile()) {
          if (readIgnores && entry.name === '.gitignore') await context.readIgnore(child);
          await defaultMarkers(child, workspace, context, markers);
        }
      }
    }
    for (const [root, depth] of roots) {
      const stat = await context.optionalStat(root);
      if (!stat?.isDirectory()) continue;
      // The workspace ignore scan already covers its ordinary descendants.
      // Explicit links retain their literal paths and need a separate scan.
      if (root !== workspace && root.startsWith(`${workspace}${path.sep}`) && await context.call('realpath', root) === root) continue;
      await walk(root, root === workspace, depth);
    }
  }, options);
}

export { LIMITS };
