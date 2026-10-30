import { scanExpired, storeContext } from './runtime/store.mjs';

// The validated caller supplies one configuration snapshot. This process never
// re-reads configuration, reports failures, or belongs to a model execution.
try {
  if (process.argv.length === 3 && Buffer.byteLength(process.argv[2]) <= 16384) {
    const options = JSON.parse(process.argv[2]);
    if (options && typeof options === 'object' && typeof options.root === 'string') {
      await scanExpired(await storeContext(options));
    }
  }
} catch { /* Historical cleanup is best effort and always silent. */ }
