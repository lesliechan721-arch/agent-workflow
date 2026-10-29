import path from 'node:path';

import fs from 'fs-extra';
import { validateCommandEntryFiles, type CommandDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import { scanNodeImportContract } from './plugin-script-contract.js';

/** Command packages are self-contained; imports cannot use the plugin's dependencies. */
export async function validateManagedCommandPackageClosure(
  resourceRoot: string,
  entries: readonly CommandDefinition[],
): Promise<void> {
  await validateCommandEntryFiles(resourceRoot, entries);
  const entryFiles = entries.filter((entry) => entry.runner === 'node').map((entry) => entry.entry);
  if (entryFiles.length === 0) return;
  const filePaths: string[] = [];
  const files: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    const directory = path.join(resourceRoot, relative);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error('Invalid managed command package: only ordinary files and directories are supported.');
      }
      if (entry.isDirectory()) await visit(relativePath);
      else {
        filePaths.push(relativePath);
        if (entryFiles.includes(relativePath) || /\.[cm]?js$/iu.test(relativePath) || entry.name === 'package.json') {
          files[relativePath] = await fs.readFile(path.join(resourceRoot, relativePath), 'utf8');
        }
      }
    }
  }
  await visit('');
  const scan = scanNodeImportContract({ files, filePaths, entryFiles, dependencies: [], devDependencies: [] });
  if (scan.errors.length > 0) throw new Error(`Invalid managed command package runtime imports:\n${scan.errors.join('\n')}`);
}
