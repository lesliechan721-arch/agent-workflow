import path from 'node:path';

import fs from 'fs-extra';

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return fs.readJson(filePath) as Promise<T>;
}

export async function readJsonFileIfExists<T>(filePath: string): Promise<T | null> {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  return readJsonFile<T>(filePath);
}

export async function readJsonFileIfExistsSafe<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonFileIfExists<T>(filePath);
  } catch {
    return null;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, value, { spaces: 2 });
}
