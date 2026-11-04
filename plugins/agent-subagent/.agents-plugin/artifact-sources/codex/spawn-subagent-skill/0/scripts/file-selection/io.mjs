import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { LIMITS, fail } from './contracts.mjs';

export function createContext({ limits = LIMITS, filesystem = fs, isCancelled } = {}) {
  let entries = 0;
  let operations = 0;
  let ignoreBytes = 0;
  const started = performance.now();
  function check() {
    if (isCancelled?.()) fail('adapterCancelled', 'File selection was cancelled.');
    if (performance.now() - started >= limits.durationMs) fail('fileSelectionLimitExceeded', 'File selection exceeded its time limit. Reduce the selection.');
  }
  function countOperation() {
    check();
    if (++operations > limits.operations) fail('fileSelectionLimitExceeded', 'File selection exceeded its filesystem operation limit. Reduce the selection.');
  }
  async function call(method, ...args) {
    countOperation();
    try { const result = await filesystem[method](...args); check(); return result; }
    catch (error) {
      if (error?.code?.startsWith('fileSelection') || error?.code === 'adapterCancelled') throw error;
      throw Object.assign(new Error('File selection could not read filesystem metadata. Check permissions and retry.'),
        { code: 'fileSelectionReadFailed', exitCode: 1, cause: error });
    }
  }
  async function optionalStat(target) {
    try { return await call('stat', target); }
    catch (error) { if (error.cause?.code === 'ENOENT' || error.cause?.code === 'ENOTDIR') return undefined; throw error; }
  }
  async function list(target, options = { withFileTypes: true }) {
    const directory = await call('opendir', target);
    const result = [];
    try {
      for await (const entry of directory) {
        check();
        if (++entries > limits.entries) fail('fileSelectionLimitExceeded', 'File selection exceeded its directory entry limit. Reduce the selection.');
        result.push(options?.withFileTypes ? entry : entry.name);
      }
      return result;
    } catch (error) {
      if (error?.code?.startsWith('fileSelection') || error?.code === 'adapterCancelled') throw error;
      fail('fileSelectionReadFailed', 'File selection could not scan a directory. Check permissions and retry.');
    }
  }
  async function readIgnore(target) {
    const handle = await call('open', target, constants.O_RDONLY);
    try {
      countOperation();
      const stat = await handle.stat();
      if (!stat.isFile()) fail('fileSelectionReadFailed', 'An ignore file changed type during selection. Retry on a stable tree.');
      if (stat.size > limits.ignoreFileBytes) fail('fileSelectionLimitExceeded', 'An ignore file exceeds its byte limit. Reduce the ignore file.');
      const chunks = [];
      let total = 0;
      while (true) {
        countOperation();
        const chunk = Buffer.alloc(Math.min(65536, limits.ignoreFileBytes + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        check();
        if (!bytesRead) break;
        total += bytesRead; ignoreBytes += bytesRead;
        if (total > limits.ignoreFileBytes || ignoreBytes > limits.ignoreTotalBytes) {
          fail('fileSelectionLimitExceeded', 'Ignore files exceed their byte limit. Reduce the ignore files.');
        }
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks, total).toString('utf8');
    } catch (error) {
      if (error?.code?.startsWith('fileSelection') || error?.code === 'adapterCancelled') throw error;
      fail('fileSelectionReadFailed', 'File selection could not read an ignore file. Check permissions and retry.');
    } finally {
      try { await handle.close(); }
      catch { fail('fileSelectionReadFailed', 'File selection could not close an ignore file. Retry on a stable tree.'); }
    }
  }
  // Preserve errors that fast-glob normally treats as an absent entry. An absent
  // dynamic root is a valid no-match; absence after opening a tree is a scan failure.
  const adapter = {};
  for (const method of ['stat', 'lstat']) {
    adapter[method] = (target, ...args) => {
      const callback = args.pop();
      call(method, target, ...args).then((value) => callback(null, value), (error) => callback(error));
    };
  }
  adapter.readdir = (target, ...args) => {
    const callback = args.pop();
    list(target, args[0]).then((value) => callback(null, value), (error) => callback(error));
  };
  return { limits, check, call, optionalStat, list, readIgnore, adapter,
    readable: (target) => call('access', target, constants.R_OK),
    directoryReadable: (target) => call('access', target, constants.R_OK | constants.X_OK),
    resolved: (target) => path.resolve(target) };
}
