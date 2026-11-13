import { stripVTControlCharacters } from 'node:util';
import type { NativeCliInput } from '../utils/native-cli.js';

export const geminiConsentMessages = {
  nativeConsentRequired: 'Gemini native installation or update requires --native-consent. This permits extension consent and may persist source-folder and current-workspace trust. AW --yes and TUI Review do not grant this permission.',
  nativeConsentVersionUnsupported: 'The Gemini native consent exchange is verified only for CLI 0.67.0. Use that version before retrying with --native-consent.',
  nativeConsentPromptUnsupported: 'Gemini requested an unknown or repeated native consent prompt. No further answer was sent. Check the retained installation and client version before retrying with --native-consent.',
};

/** Fixed v0.67.0 install.ts and extensions/consent.ts; no generic yes stream. */
export function geminiConsentInput(operation: 'register' | 'refresh', source: string, cwd: string, packageId: string): NativeCliInput {
  let stdout = '';
  let stderr = '';
  let sourceGranted = false;
  let workspaceGranted = false;
  let extensionGranted = false;
  const fail = (): never => { throw Object.assign(new Error(geminiConsentMessages.nativeConsentPromptUnsupported), { code: 'nativeConsentPromptUnsupported' }); };
  const clear = (): void => { stdout = ''; stderr = ''; };
  const advance = (): ReturnType<NativeCliInput['onStdout']> => {
    const output = stripVTControlCharacters(stdout);
    const description = stripVTControlCharacters(stderr);
    const sourcePrompt = 'Do you want to trust this folder and continue with the installation? [y/N]: ';
    const consentPrompt = 'Do you want to continue? [Y/n]: ';
    // v0.67.0 logs update descriptions to stderr and asks on stdout. Either
    // pipe can arrive first. Do not approve or reject a missing header early.
    const workspaceHeaders = [...description.matchAll(/(?:^|\n)(The current workspace at ".*" is not trusted\. Do you want to trust this workspace to install extensions\?)(?=\r?\n|$)/gu)];
    const extensionHeaders = [...description.matchAll(/(?:^|\n)(Installing extension ".*"\.)(?=\r?\n|$)/gu)];
    const workspaceHeader = `The current workspace at "${cwd}" is not trusted. Do you want to trust this workspace to install extensions?`;
    const extensionHeader = `Installing extension "${packageId}".`;
    if (workspaceHeaders.some((match) => match[1] !== workspaceHeader)
      || extensionHeaders.some((match) => match[1] !== extensionHeader)
      || workspaceHeaders.length + extensionHeaders.length > 1
      || /(?:^|\n)(?:Migrating|Renaming) extension [^\r\n]*(?:\r?\n|$)/u.test(description)) fail();
    if (output.endsWith(sourcePrompt)) {
      if (operation !== 'register' || sourceGranted
        || !output.includes('Do you trust the files in this folder?')
        || !output.includes(`The extension source at "${source}" is not trusted.`)
        || output.split(sourcePrompt).length !== 2) fail();
      sourceGranted = true;
      clear();
      return { write: 'y\n', end: true };
    }
    if (output.endsWith(consentPrompt)) {
      if (operation !== 'refresh' || extensionGranted || output.split(consentPrompt).length !== 2) fail();
      if (workspaceHeaders.length) {
        if (workspaceGranted) fail();
        workspaceGranted = true;
        clear();
        return { write: 'y\n' };
      }
      if (!extensionHeaders.length) return undefined;
      extensionGranted = true;
      clear();
      return { write: 'y\n', end: true };
    }
    // The fixed host writes each question without a newline. Refuse other
    // yes/no questions; fragments remain buffered until their suffix arrives.
    if (/\[[^\]\r\n]*\/[^\]\r\n]*\]:\s*$/u.test(output)) fail();
    return undefined;
  };
  const receive = (stream: 'stdout' | 'stderr', chunk: string): ReturnType<NativeCliInput['onStdout']> => {
    if (stream === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (stdout.length + stderr.length > 131_072) fail();
    return advance();
  };
  return {
    initial: '',
    onStdout: (chunk) => receive('stdout', chunk),
    onStderr: (chunk) => receive('stderr', chunk),
  };
}
