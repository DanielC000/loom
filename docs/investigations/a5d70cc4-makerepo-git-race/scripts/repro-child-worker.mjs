// Child process: does exactly one makeRepo()-shaped git init chain (verbatim shape from
// packages/daemon/test/merge-rest-route-tracked.mjs:56-60) and reports the raw result as
// JSON on stdout. Invoked by repro-makerepo-race.mjs as a separate OS process so N of
// these running together actually contend at the OS/filesystem level (execSync alone is
// synchronous and cannot be parallelized within one node process).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const repo = process.argv[2];
const GIT_ID = "-c user.email=mrt@loom -c user.name=mrt";

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mrt\n");
  execSync(`git init -q && git config user.email mrt@loom && git config user.name mrt && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

try {
  const start = Date.now();
  makeRepo(repo);
  process.stdout.write(JSON.stringify({ ok: true, repo, ms: Date.now() - start }));
} catch (err) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      repo,
      status: err.status ?? null,
      signal: err.signal ?? null,
      stdout: err.stdout ? err.stdout.toString("utf8") : null,
      stderr: err.stderr ? err.stderr.toString("utf8") : null,
      message: err.message,
      code: err.code ?? null,
    })
  );
}
