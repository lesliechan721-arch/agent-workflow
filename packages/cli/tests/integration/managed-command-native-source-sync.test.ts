import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { normalizePluginCommand } from '@lesliechan721/aw-plugin-core/manifest';
import { type prepareWindowsJobHelper } from '@lesliechan721/agent-skill-eval';
import type { CommandManagementResult } from '../../src/commands/managed-commands.js';
import type { CommandResult } from '../../src/output/public-result.js';
type ManagedResult = CommandResult<Pick<CommandManagementResult, 'commands' | 'packages' | 'changes' | 'nativeToolChanges'>>;
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { runManagedCommand } from '../../src/utils/managed-command-runtime.js';
import { readInstalledCommandProducer } from '../../src/utils/managed-command-store.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { runSafeCli } from '../helpers/cli-runtime.js';
import { nativeToolFixture } from '../helpers/native-tools.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('installed native declaration across Catalog and producer sync', () => {
  // Test Value Gate: source edits alone cannot prove Active replacement isolation.
  // Exercise both public sync boundaries, installed evidence, Review, and a real
  // Node consumer. No registry, model, native executable, or Go build is involved.
  it('uses current host paths and retains installed bindings until reviewed package sync', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'native-source');
    const pluginRoot = path.join(sourceRoot, 'plugins/native-sync');
    const report = path.join(cwd, 'native-consumer.json');
    const v1 = nativeToolFixture();
    const v2 = nativeToolFixture({ policy: 'preferred' });

    async function writeSnapshot(fixture: ReturnType<typeof nativeToolFixture>, version: string) {
      for (const [relative, content] of Object.entries(fixture.files)) {
        await fs.outputFile(path.join(pluginRoot, relative), content);
      }
      await fs.outputFile(path.join(pluginRoot, 'tools/run.mjs'), [
        'import fs from "node:fs";',
        'import { readNativeTool } from "./.aw/native-tool-reader.mjs";',
        `fs.writeFileSync(process.env.REPORT, JSON.stringify({ version: ${JSON.stringify(version)}, native: readNativeTool("job", "aw.windows-job.v1") }));`,
      ].join('\n'));
      await createCatalogSnapshotFixture(sourceRoot, 'native-sync', [], 'Native sync fixture\n', (manifest) => {
        manifest.version = version;
        manifest.extensions = { permissions: [{ name: 'tool', allow: ['echo hello'] }] };
        manifest.platforms = ['claude'];
        manifest.command = normalizePluginCommand({
          sourceDir: './tools', mode: 'static',
          routes: { fallback: { runner: 'node', entry: 'run.mjs', env: { REPORT: report } } },
        }, manifest);
        manifest.nativeTools = {
          reader: './.aw/native-tool-reader.mjs',
          definitions: fixture.closure.definitions.map((definition) => ({
            key: definition.key, protocol: definition.protocol,
          })),
          consumers: structuredClone(fixture.closure.consumers),
        };
      });
    }

    async function run(args: string[]) {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false });
      return { exitCode, receipt: JSON.parse(output.readStdout()) as ManagedResult, stderr: output.readStderr() };
    }

    await writeSnapshot(v1, '1.0.0');
    expect(await run(['source', 'add', 'team', '--path', sourceRoot, '--no-auto-check']))
      .toMatchObject({ exitCode: 0, stderr: '' });
    expect(await run(['source', 'sync', 'team']))
      .toMatchObject({
        exitCode: 0, stderr: '', receipt: {
          schemaVersion: 2,
          status: 'success',
          data: {}
        }
      });
    const activeV1 = (await readCatalogGenerationState(env)).sources.team!.active!;
    const selector = 'team/native-sync';
    const packageSync = ['command', 'package', 'sync', selector];
    const installed = await run([...packageSync, '--yes']);
    expect(installed, JSON.stringify(installed)).toMatchObject({
      exitCode: 0, stderr: '', receipt: {
        schemaVersion: 2,
        status: 'success',
        data: {}
      }
    });
    const resourceRoot = (await run(['command', 'show', selector])).receipt.data.commands[0]!.resourceRoot!;
    const initialProducer = await readInstalledCommandProducer(resourceRoot);
    expect(initialProducer.nativeTools).toEqual(v1.closure);

    const ready = { state: 'ready' as const, protocol: 'aw.windows-job.v1', executable: process.execPath };
    let selectedHelper = ready.executable;
    const prepare = vi.fn<typeof prepareWindowsJobHelper>(async () => selectedHelper);
    async function invokeInstalled(version: string) {
      const callsBefore = prepare.mock.calls.length;
      expect(await runManagedCommand({ id: selector, args: [], cwd, cliEntry: path.join(cwd, 'aw.mjs'), env,
        platform: 'win32', arch: 'x64', prepareNativeTool: prepare })).toBe(0);
      expect(prepare.mock.calls.length).toBe(callsBefore + 1);
      expect(prepare.mock.calls.at(-1)![0]).toMatchObject({ platform: 'win32', arch: 'x64' });
      expect(await fs.readJson(report)).toEqual({ version, native: { ...ready, executable: selectedHelper } });
    }
    await invokeInstalled('1.0.0');
    selectedHelper = path.join(cwd, 'new-host', 'aw-windows-job.exe');
    await invokeInstalled('1.0.0');
    expect(await readInstalledCommandProducer(resourceRoot)).toEqual(initialProducer);

    await writeSnapshot(v2, '2.0.0');
    expect(await run(['source', 'sync', 'team', '--yes']))
      .toMatchObject({
        exitCode: 0, stderr: '', receipt: {
          schemaVersion: 2,
          status: 'success',
          data: {}
        }
      });
    const activeV2 = (await readCatalogGenerationState(env)).sources.team!.active!;
    expect(activeV2.snapshotDigest).not.toBe(activeV1.snapshotDigest);
    expect(activeV2.sourceIdentity).toBe(activeV1.sourceIdentity);
    expect(await readInstalledCommandProducer(resourceRoot)).toEqual(initialProducer);
    await invokeInstalled('1.0.0');

    const blocked = await run(packageSync);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.receipt).toMatchObject({ status: 'blocked', data: {
      confirmation: { required: true, provided: false },
      nativeToolChanges: [{ producer: initialProducer.producer, before: v1.closure, after: v2.closure }],
    }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]) });
    expect(await readInstalledCommandProducer(resourceRoot)).toEqual(initialProducer);
    await invokeInstalled('1.0.0');

    const updated = await run([...packageSync, '--yes']);
    expect(updated, JSON.stringify(updated)).toMatchObject({
      exitCode: 0, stderr: '', receipt: {
        schemaVersion: 2,
        status: 'success',
        data: {}
      }
    });
    expect(updated.receipt.data.nativeToolChanges).toEqual([{ producer: initialProducer.producer, before: v1.closure, after: v2.closure }]);
    expect(updated.receipt.data.packages[0]).toMatchObject({ selector, packageId: installed.receipt.data.packages[0]!.packageId });
    const updatedRoot = (await run(['command', 'show', selector])).receipt.data.commands[0]!.resourceRoot!;
    expect(updatedRoot).not.toBe(resourceRoot);
    expect((await readInstalledCommandProducer(updatedRoot)).nativeTools).toEqual(v2.closure);
    await invokeInstalled('2.0.0');
    expect(await fs.pathExists(path.join(isolation.layout.awHomeDir, 'native-artifacts'))).toBe(false);
  });
});
