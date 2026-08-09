process.stdout.write(`stdout:${process.argv.slice(2).join(',')}`);
process.stderr.write('stderr:fake-pnpm');

if (process.argv.includes('--fail')) {
  process.exitCode = 7;
}
