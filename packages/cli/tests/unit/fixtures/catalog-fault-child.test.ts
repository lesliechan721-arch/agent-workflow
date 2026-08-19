import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  catalogGitProviderInternal,
} from '../../../src/utils/git-catalog-provider.js';
import {
  execFileNativeCliRunner,
  NativeCliError,
  setNativeCliRunnerOverrideForTests,
} from '../../../src/utils/native-cli.js';
import { registerCurrentTestWritableStateRoot } from '../../setup/test-isolation.js';

const remote = process.env.AW_CROSS_PROCESS_FAULT_REMOTE;
const awHome = process.env.AW_CROSS_PROCESS_FAULT_HOME;
const userHome = process.env.AW_CROSS_PROCESS_FAULT_USER_HOME;
const resolveGitCatalogSource = catalogGitProviderInternal.resolve;

describe.skipIf(!remote || !awHome || !userHome)('catalog object fault child', () => {
  it('persists an injected fatal cleanup fault before this process exits', async () => {
    registerCurrentTestWritableStateRoot(
      path.dirname(awHome!),
      'cross-process catalog fault cache and sibling lease',
    );
    setNativeCliRunnerOverrideForTests(async (invocation) => {
      if (invocation.command === 'git' && invocation.args.includes('fetch')) {
        throw new NativeCliError({
          invocation,
          exitCode: 1,
          stdout: '',
          stderr: 'injected child cleanup failure',
          cleanupError: new Error('Native CLI cleanup unconfirmed: child injection.'),
          reason: 'aborted',
        });
      }
      return execFileNativeCliRunner(invocation);
    });

    const error = await resolveGitCatalogSource({
      id: 'official',
      type: 'git',
      primary: true,
      url: remote!,
      refPolicy: { type: 'explicit', ref: 'main' },
      subdir: 'catalog',
    }, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'requireRemote',
      env: {
        ...process.env,
        AW_HOME: awHome!,
        HOME: userHome!,
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('Catalog Git process cleanup could not be confirmed');
  });
});
