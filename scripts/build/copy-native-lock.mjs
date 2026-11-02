import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const packageRoot = path.resolve(process.argv[2] ?? '.');
const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const destination = path.join(packageRoot, 'dist', ...(metadata.name === '@lesliechan721/aw' ? ['src'] : []), 'native');
await mkdir(destination, { recursive: true });
await copyFile(path.join(packageRoot, 'src', 'native', 'windows-job.lock.json'), path.join(destination, 'windows-job.lock.json'));
