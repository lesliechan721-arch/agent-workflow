import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await fs.remove(path.join(packageRoot, 'dist'));
