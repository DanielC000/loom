import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// diffOwedLanding (card 13fc5227, the HELD-branch "late range" review diffstat shown by worker_merge)
// path-identity coverage (card fdf09672). REAL git on a temp repo, no daemon, no SessionService —
// diffOwedLanding is a pure git function (repoPath/tip/owedBase), so this exercises it directly rather
// than standing up the full held-branch/mergeBatchTracked machinery `_held-branch-fixture.mjs` provides
// (see batch-merge-late-range-commits.mjs for that fuller integration surface).
//
// Pre-fix, this function parsed plain `git diff --numstat <mainTree> <tree>` (NO `-z`) via a hand-rolled
// `/^(\d+|-)\t(\d+|-)\t(.+)$/` line regex — worse than the other 3 consumers card fdf09672 fixed: it never
// attempted rename handling at all, so a renamed file's "path" would literally be the garbled
// `"old => new"` text pushed straight into `DiffstatFile.file`, and a non-ASCII path stayed C-quoted.
//
// Run: 1) pnpm build, 2) node test/diff-owed-landing-pathnames.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

const { diffOwedLanding } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=dol@loom -c user.name=dol";

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repos = [];
function mkRepo(name) {
  const repo = path.join(os.tmpdir(), `loom-dol-${name}-${sfx}`);
  repos.push(repo);
  return repo;
}
function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

try {
  // ══════════════════════ (N) NON-ASCII ══════════════════════════════════════════════════════════════
  // owedBase = main's HEAD (C0); the owed commit (on a side branch, never checked out onto main) adds a
  // real non-ASCII file — main's own HEAD never moves, so this one commit is "owed" relative to it.
  {
    const repo = mkRepo("nonascii");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# dol\n");
    execSync("git init -q -b main", { cwd: repo });
    execSync("git config user.email dol@loom && git config user.name dol", { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const owedBase = git(repo, "rev-parse HEAD");

    execSync("git checkout -q -b feat", { cwd: repo });
    fs.writeFileSync(path.join(repo, "café.txt"), "owed content\n");
    commitAll(repo, "owed: add non-ASCII file", GIT_ID);
    const tip = git(repo, "rev-parse HEAD");
    execSync("git checkout -q main", { cwd: repo }); // main's own HEAD is owedBase — diffOwedLanding reads `rev-parse HEAD` as `main`

    const result = await diffOwedLanding(repo, tip, owedBase);
    check("(N) no refusal", result?.failure === undefined);
    check("(N) exactly one owed file reported", result?.files.length === 1);
    check("(N) the REAL unquoted non-ASCII path, not C-quoted octal text", result?.files[0]?.file === "café.txt");
    check("(N) no entry is corrupted into the C-quoted form", !result?.files.some((f) => f.file.startsWith('"caf')));
    check("(N) one owed commit listed", result?.commits.length === 1 && result?.commits[0]?.emptyOnMain === false);
  }

  // ══════════════════════ (R) RENAME — the pre-fix shape never even attempted this ═══════════════════
  // A big-enough original body is load-bearing (same reasoning as unanchored-comment-blocks-detect.mjs's
  // own (E) scenario): git's rename detector keys off byte-level similarity, not line-count proportion.
  {
    const repo = mkRepo("rename");
    fs.mkdirSync(repo, { recursive: true });
    const body = Array.from({ length: 100 }, (_, i) => `export const x${i} = ${i};`).join("\n") + "\n";
    fs.writeFileSync(path.join(repo, "README.md"), "# dol\n");
    fs.writeFileSync(path.join(repo, "old-name.ts"), body);
    execSync("git init -q -b main", { cwd: repo });
    execSync("git config user.email dol@loom && git config user.name dol", { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const owedBase = git(repo, "rev-parse HEAD");

    execSync("git checkout -q -b feat", { cwd: repo });
    execSync("git mv old-name.ts new-name.ts", { cwd: repo });
    commitAll(repo, "owed: rename only", GIT_ID);
    const tip = git(repo, "rev-parse HEAD");
    execSync("git checkout -q main", { cwd: repo });

    // Sanity: confirm plain `--numstat` (no -z) really DOES collapse this into "old => new" display
    // text for this fixture — otherwise this test would pass vacuously.
    const numstatOldWay = execSync(`git diff --numstat ${owedBase} ${tip}`, { cwd: repo, encoding: "utf8" });
    check("(R) sanity: plain --numstat (no -z) renders this rename as garbled 'old => new' text", /old-name\.ts => new-name\.ts/.test(numstatOldWay));

    const result = await diffOwedLanding(repo, tip, owedBase);
    check("(R) no refusal", result?.failure === undefined);
    check("(R) exactly one owed file reported", result?.files.length === 1);
    check("(R) the REAL destination path, never the garbled 'old => new' text", result?.files[0]?.file === "new-name.ts");
    check("(R) carries the real rename-source via the dedicated field", result?.files[0]?.renameFrom === "old-name.ts");
  }
} finally {
  for (const repo of repos) {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
