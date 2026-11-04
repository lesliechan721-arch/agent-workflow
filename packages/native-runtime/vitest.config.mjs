import { fileURLToPath } from 'node:url';

export default {
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['tests/reader-source.vitest.mjs'],
    globals: true,
  },
};
