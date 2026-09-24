#!/usr/bin/env node
/** Delegates to AW's actual public parser; contains no copied AW schema/validator. */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args[0] === '--help') {
  console.log('node check-evals.mjs [--module /absolute/path/to/agent-skill-eval/dist/index.js]');
  process.exit(0);
}
if (args.length && !(args.length === 2 && args[0] === '--module')) {
  console.error('Unknown arguments. Use --help.'); process.exit(2);
}
try {
  const moduleName = args.length ? pathToFileURL(resolve(args[1])).href : '@lesliechan721/agent-skill-eval';
  const { parseSelectedCases } = await import(moduleName);
  if (typeof parseSelectedCases !== 'function') throw new Error('Public parseSelectedCases export missing.');
  const evalRoot = fileURLToPath(new URL('../skills/browser-use/evals/', import.meta.url));
  const files = readdirSync(evalRoot).filter(f => f.endsWith('-cases.json'));
  let cases = 0;
  for (const f of files) {
    const parsed = parseSelectedCases(JSON.parse(readFileSync(resolve(evalRoot, f), 'utf8')));
    cases += parsed.cases.length;
  }
  console.log(JSON.stringify({ ok: true, parser: 'parseSelectedCases', files: files.length, cases,
    oracleAudit: 'not-performed', modelExecution: 'not-performed' }));
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e.message),
    note: 'No fallback parser. Install/build the matching AW public Eval package, then rerun.' }));
  process.exitCode = 1;
}
