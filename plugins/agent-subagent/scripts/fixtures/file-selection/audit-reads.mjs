import fs from 'node:fs';
import promises from 'node:fs/promises';

const target = process.env.AW_TEST_READ_AUDIT;
for (const [module, methods] of [[fs, ['open', 'readFile']], [promises, ['open', 'readFile']]]) {
  for (const method of methods) {
    const original = module[method];
    module[method] = function (file, ...args) {
      fs.appendFileSync(target, `${JSON.stringify(String(file))}\n`);
      return original.call(this, file, ...args);
    };
  }
}
