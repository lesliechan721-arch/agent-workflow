import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import type { PluginConfigScalar } from '../../src/types.js';
import { projectConfigSuggestionsResponse, runPluginConfigSuggestions } from '../../src/utils/plugin-config-suggestion-runner.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { waitForProcessExit } from '../support/process-tree.js';

const secret = 'fixture-private-secret';

function fixtureOptions() {
  const { layout, env } = getCurrentSourceTestIsolation();
  const identity = { pluginId: 'local/demo', name: 'demo', version: '1.0.0' };
  return {
    entry: './suggestions.mjs',
    env,
    request: {
      schemaVersion: 2 as const,
      kind: 'scalar' as const,
      provider: 'models',
      profile: 'common' as const,
      consumer: identity,
      providerPlugin: { ...identity, rootDir: layout.rootDir },
      fieldPath: ['profiles', 0, 'model'],
      dependencyValues: { executor: 'demo' },
      providerConfigValues: { models: ['one', 'two'] },
      cwd: layout.homeDir,
    },
    sensitiveValues: [secret],
  };
}

// Windows uses the same script boundary with the packaged Job helper, which
// requires the candidate package setup outside ordinary source tests.
describe.skipIf(process.platform === 'win32')('config suggestions script boundary', () => {
  it('passes a single JSON request, filters AW controls, and publishes only safe valid items', async () => {
    const options = fixtureOptions();
    await writeFile(path.join(options.request.providerPlugin.rootDir, options.entry), `
      import assert from 'node:assert/strict';
      import { realpath } from 'node:fs/promises';

      process.stdin.setEncoding('utf8');
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const request = JSON.parse(input);
      assert.equal(await realpath(process.cwd()), await realpath(request.providerPlugin.rootDir));
      assert.equal(request.schemaVersion, 2);
      assert.equal(request.kind, 'scalar');
      assert.equal(request.profile, 'common');
      assert.equal(Object.hasOwn(request, 'platform'), false);
      assert.deepEqual(request.fieldPath, ['profiles', 0, 'model']);
      assert.deepEqual(request.dependencyValues, { executor: 'demo' });
      assert.deepEqual(request.providerConfigValues, { models: ['one', 'two'] });
      assert.equal(input.includes(${JSON.stringify(secret)}), false);
      assert.deepEqual(Object.keys(process.env).filter(key => /^AW_/i.test(key)),
        ['AW_AGENT_SKILL_EVAL_PROCESS_MARKER']);
      assert.equal(process.env.AW_AGENT_SKILL_EVAL_PROCESS_MARKER, 'explicit-eval-marker');
      assert.equal(process.env.HOME, ${JSON.stringify(options.env.HOME)});
      assert.equal(process.env.PATH, ${JSON.stringify(options.env.PATH)});
      assert.equal(process.env.CODEX_HOME, 'probe-codex-home');
      assert.equal(process.env.CLAUDE_CONFIG_DIR, 'probe-claude-home');

      process.stderr.write(${JSON.stringify(secret)});
      const protectedValue = ${JSON.stringify(secret)};
      const split = protectedValue.replace('-', '-\\u001b[31m');
      process.stdout.write(JSON.stringify({
        schemaVersion: 2,
        status: 'ok',
        items: [
          { value: 3, title: 'Wrong type', recommended: true },
          { value: 'one', title: 'One \\u202e' + split, recommended: true, source: 'dynamic', recommendedHints: ['fast'] },
          { value: 'one', title: 'duplicate' },
          { value: 'two', title: '😀'.repeat(128), recommended: true,
            description: 'Link \\u009d52;c;hidden payload\\u009c' },
          { value: 'x'.repeat(128), title: 'Invalid value' },
          { value: 'control\\u001b[31m', title: 'Unsafe value' },
          { value: protectedValue, title: 'Secret value' },
        ],
        message: 'token=unrelated-secret',
        diagnostics: [
          { code: 'fixtureNotice', message: 'Notice ' + protectedValue },
          { code: protectedValue, message: 'Safe notice' },
        ],
        raw: protectedValue,
      }));
    `);

    const response = await runPluginConfigSuggestions({
      ...options,
      env: {
        ...options.env,
        AW_PLUGIN_CONTEXT: 'inherited-plugin',
        aw_native_tool_context: 'inherited-native',
        AW_COMMAND_RUNTIME_CONFIG: 'inherited-command',
        AW_DEBUG: 'inherited-debug',
        AW_AGENT_SKILL_EVAL_PROCESS_MARKER: 'explicit-eval-marker',
        aw_agent_skill_eval_process_marker: 'not-a-marker-on-posix',
        CODEX_HOME: 'probe-codex-home',
        CLAUDE_CONFIG_DIR: 'probe-claude-home',
      },
    });

    expect(response.items.filter(({ recommended }) => recommended).map((item) => 'value' in item ? item.value : undefined))
      .toEqual([3, 'one', 'two']);
    expect(JSON.stringify(response)).not.toContain(secret);
    const validForField = (value: PluginConfigScalar) => typeof value === 'string' && value.length < 128;
    const result = projectConfigSuggestionsResponse(response, options.sensitiveValues, { kind: 'scalar', mode: 'field', isValidValue: validForField });
    expect(result).toEqual({
      schemaVersion: 2,
      status: 'ok',
      items: [
        { value: 'one', title: 'One [REDACTED]', recommended: true, source: 'dynamic' },
        { value: 'two', title: '😀'.repeat(128), recommended: false, description: 'Link ' },
      ],
      message: 'token=[REDACTED]',
      diagnostics: [
        { code: 'fixtureNotice', message: 'Notice [REDACTED]' },
        { code: 'configSuggestionsProviderDiagnostic', message: 'Safe notice' },
      ],
    });
  });

  it.each([
    ['a nonzero exit', `process.stderr.write(${JSON.stringify(secret)}); process.exitCode = 1;`, 'configSuggestionsScriptFailed'],
    ['multiple JSON values', `process.stdout.write('{}{}');`, 'configSuggestionsResponseInvalid'],
    ['invalid UTF-8 inside otherwise valid JSON', `process.stdout.write(Buffer.concat([
      Buffer.from('{"schemaVersion":2,"status":"ok","items":[],"message":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]));`, 'configSuggestionsResponseInvalid'],
    ['stdout over 1 MiB', `process.stdout.write('😀'.repeat(262145));`, 'configSuggestionsOutputTooLarge'],
  ])('returns a safe unavailable response for %s', async (_name, script, code) => {
    const options = fixtureOptions();
    await writeFile(path.join(options.request.providerPlugin.rootDir, options.entry), script);
    const result = await runPluginConfigSuggestions(options);
    expect(result).toMatchObject({ status: 'unavailable', items: [], diagnostics: [{ code }] });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('accepts one valid JSON response at the exact byte limit', async () => {
    const options = fixtureOptions();
    await writeFile(path.join(options.request.providerPlugin.rootDir, options.entry), `
      const output = JSON.stringify({
        schemaVersion: 2, status: 'no-probe', items: [{ value: 'unused', title: 'Unused' }],
        message: 'Probe unavailable 🛠️',
      });
      process.stdout.write(output + ' '.repeat(1048576 - Buffer.byteLength(output)));
    `);
    await expect(runPluginConfigSuggestions(options)).resolves.toEqual({
      schemaVersion: 2, status: 'no-probe', items: [], message: 'Probe unavailable 🛠️',
    });
  });

  it('rejects an entry symlink even when the target stays in the bundle', async () => {
    const options = fixtureOptions();
    const root = options.request.providerPlugin.rootDir;
    await writeFile(path.join(root, 'actual.mjs'),
      'process.stdout.write(JSON.stringify({ schemaVersion: 2, status: "ok", items: [] }));');
    await symlink('actual.mjs', path.join(root, options.entry));
    await expect(runPluginConfigSuggestions(options)).resolves.toMatchObject({ status: 'unavailable' });
  });

  it.each(['exit', 'timeout', 'abort'] as const)('reaps a child and grandchild with inherited pipes on %s', async (mode) => {
    const options = fixtureOptions();
    const root = options.request.providerPlugin.rootDir;
    const readyPath = path.join(root, 'ready.json');
    const controller = new AbortController();
    const abortReason = new Error('Cancelled the suggestion probe');
    await writeFile(path.join(root, 'grandchild.mjs'), `
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {});
      writeFileSync('ready.json', JSON.stringify([process.ppid, process.pid]));
      setTimeout(() => {}, 5000);
    `);
    await writeFile(path.join(root, 'child.mjs'), `
      import { spawn } from 'node:child_process';
      spawn(process.execPath, ['grandchild.mjs'], { stdio: ['ignore', 'inherit', 'inherit'] });
      setTimeout(() => {}, 5000);
    `);
    await writeFile(path.join(root, options.entry), `
      import { spawn } from 'node:child_process';
      import { existsSync } from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      const child = spawn(process.execPath, ['child.mjs'], { stdio: ['ignore', 'inherit', 'inherit'] });
      child.unref();
      while (!existsSync('ready.json')) await delay(10);
      if (${JSON.stringify(mode)} === 'exit') {
        process.stdout.write(JSON.stringify({ schemaVersion: 2, status: 'ok', items: [] }));
      } else {
        await delay(5000);
      }
    `);
    const result = runPluginConfigSuggestions({
      ...options,
      signal: controller.signal,
      timeoutMs: mode === 'timeout' ? 1_000 : 4_000,
    });

    try {
      if (mode === 'abort') {
        const outcome = result.catch((error: unknown) => error);
        const deadline = Date.now() + 3_000;
        while (true) {
          try {
            JSON.parse(await readFile(readyPath, 'utf8'));
            break;
          } catch (error) {
            if (Date.now() >= deadline) throw error;
            await delay(10);
          }
        }
        controller.abort(abortReason);
        expect(await outcome).toBe(abortReason);
      } else if (mode === 'timeout') {
        await expect(result).resolves.toMatchObject({
          status: 'unavailable', items: [], diagnostics: [{ code: 'configSuggestionsTimeout' }],
        });
      } else {
        await expect(result).resolves.toEqual({ schemaVersion: 2, status: 'ok', items: [] });
      }
      const pids: number[] = JSON.parse(await readFile(readyPath, 'utf8'));
      await Promise.all(pids.map((pid) => waitForProcessExit(pid)));
    } finally {
      controller.abort();
      await result.catch(() => undefined);
    }
  });
});

describe('suggestions v2 object projection', () => {
  const targets = ['model', 'effort', 'required'];
  const field = {
    kind: 'object' as const, mode: 'field' as const, targets,
    isValidPatch: (patch: import('../../src/utils/plugin-config-suggestion-runner.js').ObjectSuggestionPatch) =>
      Object.entries(patch.set ?? {}).every(([key, value]) => typeof value === 'string'
        && (key !== 'effort' || ['low', 'high'].includes(value))) && !patch.unset?.includes('required'),
  };
  const project = (items: unknown[], hint?: string) => projectConfigSuggestionsResponse(
    { schemaVersion: 2, status: 'ok', items }, [secret, 'private-hint'], { ...field, hint },
  );
  it('accepts unset-only leaves, validates merged overrides, and drops invalid containers and duplicate patches', () => {
    const projected = project([
      { title: 'Default', unset: ['effort', 'model'] },
      { title: 'Duplicate default', unset: ['model', 'effort'], set: {} },
      { title: 'Conflict', set: { model: 'one' }, unset: ['model'] },
      { title: 'Nothing' },
      { title: 'Required removal', unset: ['required'] },
      { title: 'Illegal key', set: { alien: 'x' } },
      { title: 'Illegal value', set: { effort: 'unknown' } },
      { title: 'Sensitive value', set: { model: secret } },
      { title: 'Unsafe value', set: { model: 'a\u001b[31m' } },
      {
        title: 'Model family', unset: ['model'], set: { effort: 'high' },
        children: { title: 'Variants', items: [
          { title: 'Explicit model', set: { model: 'explicit' }, unset: ['effort'] },
          { title: 'Same merged result', set: { model: 'explicit' }, unset: ['effort', 'effort'] },
          { title: 'Conflicting child', set: { model: 'x' }, unset: ['model'] },
          { title: 'Invalid merged', set: { effort: 'invalid' } },
          { title: 'Third level', children: { items: [{ title: 'too deep', set: { model: 'deep' } }] } },
        ] },
      },
      {
        title: 'Overridden invalid parent', set: { effort: 'invalid' },
        children: { items: [{ title: 'Valid merged', set: { effort: 'low' } }] },
      },
      { title: 'Empty container', set: { model: 'x' }, children: { items: [{ title: 'Invalid child', unset: ['required'] }] } },
      { title: 'Oversized container', children: { items: Array.from({ length: 33 }, (_, i) => ({ title: String(i), set: { model: String(i) } })) } },
    ]);
    expect(projected.items).toEqual([
      { title: 'Default', unset: ['effort', 'model'] },
      {
        title: 'Model family', unset: ['model'], set: { effort: 'high' },
        children: { title: 'Variants', items: [{ title: 'Explicit model', set: { model: 'explicit' }, unset: ['effort'] }] },
      },
      {
        title: 'Overridden invalid parent', set: { effort: 'invalid' },
        children: { items: [{ title: 'Valid merged', set: { effort: 'low' } }] },
      },
    ]);
  });

  it('keeps all valid hint annotations in cache and recalculates only the first valid field recommendation', () => {
    const raw = { schemaVersion: 2, status: 'ok', items: [
      { title: 'Static fallback', unset: ['model'], recommended: true },
      { title: 'Invalid for this field', set: { effort: 'other' }, recommendedHints: ['fast'] },
      { title: 'Group', set: { model: 'a' }, recommended: true, recommendedHints: ['deep'],
        children: { items: [
          { title: 'Fast', set: { effort: 'low' }, recommendedHints: ['fast', 'fast', 'INVALID', 0, 'private-hint',
            'balanced', 'extra-1', 'extra-2', 'extra-3', 'extra-4', 'extra-5', 'extra-6', 'extra-7'] },
          { title: 'Strong', set: { effort: 'high' }, recommendedHints: ['fast', 'strong'], recommended: true },
        ] },
      },
      { title: 'Other model', set: { model: 'b' }, recommendedHints: ['fast', 'deep'], recommended: true },
    ] };
    const cache = projectConfigSuggestionsResponse(raw, [secret, 'private-hint'], { kind: 'object', mode: 'cache', targets });
    expect(cache.items[2]).toEqual({
      title: 'Group', set: { model: 'a' }, recommended: true,
      children: { items: [
        { title: 'Fast', set: { effort: 'low' }, recommendedHints: ['fast', 'balanced', 'extra-1', 'extra-2',
          'extra-3', 'extra-4', 'extra-5', 'extra-6'] },
        { title: 'Strong', set: { effort: 'high' }, recommendedHints: ['fast', 'strong'], recommended: true },
      ] },
    });
    const projectField = (hint?: string) => projectConfigSuggestionsResponse(cache, [], { ...field, hint });
    for (const hint of ['fast', undefined]) {
      const response = projectField(hint);
      expect(response.items.filter((item) => item.recommended).map((item) => item.title)).toEqual(['Group']);
      expect(response.items[1]).toMatchObject({ children: { items: [
        { title: 'Fast', recommended: true },
        { title: 'Strong', recommendedHints: ['strong'] },
      ] } });
    }
    expect(JSON.stringify(projectField('missing'))).not.toContain('"recommended":');
    expect(projectField('deep').items.filter((item) => item.recommended).map((item) => item.title)).toEqual(['Other model']);
    const wider = projectConfigSuggestionsResponse(cache, [], { ...field, hint: 'fast', isValidPatch: () => true });
    expect(wider.items.filter((item) => item.recommended).map((item) => item.title)).toEqual(['Invalid for this field']);
  });

  it('falls back to one static recommendation per sibling list only without valid hints', () => {
    const response = project([
      { title: 'One', set: { model: 'one' }, recommended: true, recommendedHints: ['INVALID'] },
      { title: 'Two', set: { model: 'two' }, recommended: true, recommendedHints: 'bad format' },
      { title: 'Group', recommended: true, recommendedHints: ['balanced'], children: { items: [
        { title: 'Low', set: { effort: 'low' }, recommended: true },
        { title: 'High', set: { effort: 'high' }, recommended: true },
      ] } },
    ]);
    expect(response.items.map((item) => item.recommended)).toEqual([true, false, false]);
    expect(response.items[2]).toMatchObject({ children: { items: [{ recommended: true }, { recommended: false }] } });
  });

  it('requires the v2 envelope, bounds response collections and empties every non-ok status', () => {
    for (const status of ['not-applicable', 'no-probe', 'unavailable']) {
      expect(projectConfigSuggestionsResponse({ schemaVersion: 2, status, items: [{ title: 'Discarded', set: { model: 'x' } }] },
        [], field)).toEqual({ schemaVersion: 2, status, items: [] });
    }
    for (const raw of [
      { schemaVersion: 1, status: 'ok', items: [] },
      { schemaVersion: 2, status: 'unsupported', items: [] },
      { schemaVersion: 2, status: 'ok', items: Array(129).fill({}) },
      { schemaVersion: 2, status: 'ok', items: [], message: '😀'.repeat(257) },
      { schemaVersion: 2, status: 'ok', items: [], diagnostics: Array(9).fill({ code: 'note', message: '' }) },
    ]) expect(() => projectConfigSuggestionsResponse(raw, [], field)).toThrow();
  });
});
