// Runs every hermetic web unit test in this directory. Each file is a self-contained node script
// (no shared daemon/db/fs state), so this is embarrassingly-parallel — a fixed pool of lanes pulls the
// next unclaimed file off a shared cursor. Pool size defaults to os.availableParallelism() capped at
// MAX_CONCURRENCY; override with LOOM_TEST_CONCURRENCY=<n> (e.g. =1 to force serial). Every file still
// runs to completion regardless of an earlier failure — output is buffered per file and printed as
// PASS/FAIL on completion (with the failing file's captured output) so concurrent runs stay legible.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const testDir = dirname(fileURLToPath(import.meta.url));
const self = basename(fileURLToPath(import.meta.url));

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.mjs'))
  .filter((f) => f !== self)
  .filter((f) => !f.startsWith('_'))
  .sort();

console.log(`Running ${files.length} test file(s) in ${testDir}`);

const MAX_CONCURRENCY = 8;
const POOL_SIZE = Math.max(
  1,
  Math.min(Number(process.env.LOOM_TEST_CONCURRENCY) || os.availableParallelism(), MAX_CONCURRENCY),
);

function runOne(file) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, ['--experimental-strip-types', join(testDir, file)]);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ file, ok: false, status: null, stdout, stderr: `${stderr}\n${err.message}` }));
    child.on('close', (status) => resolve({ file, ok: status === 0, status, stdout, stderr }));
  });
}

function makeCursor(length) {
  let next = 0;
  return () => (next < length ? next++ : null);
}

async function runLane(names, nextIndex, results) {
  for (let idx = nextIndex(); idx !== null; idx = nextIndex()) {
    const file = names[idx];
    const result = await runOne(file);
    results[idx] = result;
    if (result.ok) {
      console.log(`PASS ${file}`);
    } else {
      console.log(`FAIL ${file}`);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
  }
}

const results = new Array(files.length);
const nextIndex = makeCursor(files.length);
await Promise.all(
  Array.from({ length: Math.min(POOL_SIZE, files.length) }, () => runLane(files, nextIndex, results)),
);

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n${files.length} test file(s), ${failed.length} failed: ${failed.map((f) => f.file).join(', ')}`);
  process.exit(1);
}

console.log(`\nAll ${files.length} test file(s) passed`);
