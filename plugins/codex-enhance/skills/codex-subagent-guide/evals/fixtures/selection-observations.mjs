import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const fixtureAssetURL = import.meta.url;

// Run the actual final function in a realm with no filesystem, process, or host objects.
export async function observeSelection(workspace) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const modules = new Map();
  async function moduleAt(relative) {
    if (!relative.startsWith('src/') || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('selectionImportUnsupported');
    if (modules.has(relative)) return modules.get(relative);
    let cursor = workspace;
    for (const part of relative.split('/')) { cursor = path.join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new Error('selectionSourceUnsafe'); }
    const stat = await lstat(cursor);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('selectionSourceUnsupported');
    const source = await readFile(cursor, 'utf8');
    const module = new vm.SourceTextModule(source, { context, identifier: relative });
    modules.set(relative, module);
    await module.link(async (specifier, parent) => {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error('selectionImportUnsupported');
      return moduleAt(path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier), specifier)));
    });
    return module;
  }
  const entry = await moduleAt('src/select.js');
  await entry.evaluate({ timeout: 1000 });
  if (typeof entry.namespace.selectRows !== 'function') throw new Error('selectionExportMissing');
  context.subjectFunction = entry.namespace.selectRows;
  const rows = [{ id: 'a', tenantId: 't1', sequence: 1 }, { id: 'a', tenantId: 't2', sequence: 2 },
    { id: 'b', tenantId: 't1', sequence: 3 }, { id: 'a', tenantId: 't1', sequence: 4 }];
  const probes = [{ name: 'tenant-and-order', rows, tenant: 't1', ids: ['b', 'a'], expected: [rows[0], rows[2], rows[3]] },
    { name: 'empty-ids', rows, tenant: 't1', ids: [], expected: [] },
    { name: 'other-tenant', rows, tenant: 't2', ids: ['a'], expected: [rows[1]] }];
  const observations = probes.map((probe) => {
    const input = JSON.stringify({ rows: probe.rows, tenant: probe.tenant, ids: probe.ids });
    const observed = JSON.parse(vm.runInContext(`(() => { const input=JSON.parse(${JSON.stringify(input)}); const before=JSON.stringify(input); const result=subjectFunction(input.rows,input.tenant,input.ids); return JSON.stringify({result,unchanged:JSON.stringify(input)===before}); })()`, context, { timeout: 1000 }));
    return { name: probe.name, expected: probe.expected, actual: observed.result,
      outputEqual: JSON.stringify(observed.result) === JSON.stringify(probe.expected), inputUnchanged: observed.unchanged === true };
  });
  const sourceSha256 = createHash('sha256').update(await readFile(path.join(workspace, 'src', 'select.js'))).digest('hex');
  return { source: 'src/select.js', sourceSha256, observations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  observeSelection(input.workspace).then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => { process.stderr.write(JSON.stringify({ code: error.message }) + '\n'); process.exitCode = 1; });
}
