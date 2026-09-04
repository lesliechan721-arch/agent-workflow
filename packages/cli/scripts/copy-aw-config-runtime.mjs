import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetRoot = path.join(packageRoot, 'dist', 'authoring', 'assets', 're2-wasm');

await fs.rm(targetRoot, { recursive: true, force: true });
await fs.cp(
  path.join(packageRoot, 'authoring', 'assets', 're2-wasm'),
  targetRoot,
  { recursive: true },
);
