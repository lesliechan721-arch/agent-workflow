import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { qualificationArguments, checkQualification } from './codex-enhance-external.mjs';

// Test Value Gate: real qualification must not submit a model call by default or
// mistake a matching fake CLI version for model/platform qualification evidence.
test('qualification defaults to local preflight and requires all actual call inputs', () => {
  assert.equal(qualificationArguments(['--binary', '/absolute/codex']).run, false);
  assert.throws(() => qualificationArguments(['--run', '--binary', '/absolute/codex']), { code: 'qualificationInputsRequired' });
  assert.throws(() => qualificationArguments(['--run', '--binary', '/absolute/codex', '--guide-root', '/installed/guide', '--out', '/new/output', '--model', 'explicit-model']), { code: 'qualificationNotAuthorized' });
  assert.throws(() => qualificationArguments(['--binary', 'codex']), { code: 'codexExecutableMissing' });
});

test('fake preflight proves exact-version rejection and zero generation only', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-subagent-qualification-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'fake-codex');
  const observed = path.join(directory, 'arguments.json');
  await fs.writeFile(binary, `#!${await fs.realpath(process.execPath)}
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify(process.argv.slice(2)));
process.stdout.write('codex-cli 0.160.1\\n');
`, { mode: 0o700 });
  const result = await checkQualification({ binary });
  assert.equal(result.generationStarted, false);
  assert.equal(result.qualification, 'not-established');
  assert.deepEqual(JSON.parse(await fs.readFile(observed, 'utf8')), ['--version']);
  await fs.writeFile(binary, `#!${await fs.realpath(process.execPath)}\nprocess.stdout.write('codex-cli 0.160.0\\n');\n`, { mode: 0o700 });
  await assert.rejects(checkQualification({ binary }), { code: 'codexVersionUnsupported' });
});
