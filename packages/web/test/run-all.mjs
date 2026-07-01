import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const testDir = dirname(fileURLToPath(import.meta.url));
const self = basename(fileURLToPath(import.meta.url));

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.mjs'))
  .filter((f) => f !== self)
  .filter((f) => !f.startsWith('_'))
  .sort();

console.log(`Running ${files.length} test file(s) in ${testDir}`);

for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(testDir, file)],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    console.log(`FAIL ${file}`);
    console.log(`\n${files.length} test file(s), failed at ${file}`);
    process.exit(result.status ?? 1);
  }

  console.log(`PASS ${file}`);
}

console.log(`\nAll ${files.length} test file(s) passed`);
