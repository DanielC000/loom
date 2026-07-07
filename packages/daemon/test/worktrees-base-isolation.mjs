// Worktrees-base isolation test (board card d469339b / home card 65a16fae). WORKTREES_DIR must resolve
// OUTSIDE any git ancestor — specifically outside LOOM_HOME's own git repo in the self-hosting setup,
// where ~/.loom IS a git working tree holding cross-agent state (skill sources, resume docs). Nesting
// worktrees/ inside it let a worker whose Bash cwd sits under its worktree `cd ..` up into that repo and
// mutate the daemon home's LIVE working tree — this actually happened (a worker's `cd .. && git stash`
// swept up another agent's uncommitted WIP). LOOM_HOME is set to a temp dir BEFORE importing dist/
// paths.js (paths.ts reads LOOM_HOME at module load) and is git-inited here to simulate that self-hosting
// layout. Run: 1) build daemon, 2) node test/worktrees-base-isolation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-wtbase-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
// Simulate the self-hosting layout: LOOM_HOME is ITSELF a git repo (cross-agent state).
execSync("git init -q && git config user.email t@loom && git config user.name t", { cwd: process.env.LOOM_HOME });

const { LOOM_HOME, WORKTREES_DIR, ensureDirs } = await import("../dist/paths.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const norm = (p) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// (a) WORKTREES_DIR is a SIBLING of LOOM_HOME (same parent dir), not nested inside it.
check("(a) WORKTREES_DIR is not nested under LOOM_HOME", !norm(WORKTREES_DIR).startsWith(`${norm(LOOM_HOME)}/`));
check("(a) WORKTREES_DIR shares LOOM_HOME's parent directory",
  path.dirname(norm(WORKTREES_DIR)) === path.dirname(norm(LOOM_HOME)));

// (b) ensureDirs() creates it.
ensureDirs();
check("(b) WORKTREES_DIR exists after ensureDirs()", fs.existsSync(WORKTREES_DIR));

// (c) no `.git` in ANY ancestor of WORKTREES_DIR, walking up to (and including) LOOM_HOME's parent — the
//     LOOM_HOME repo created above must NOT be an ancestor of WORKTREES_DIR.
function hasGitAncestor(dir, stopAt) {
  let cur = path.resolve(dir);
  const stop = path.resolve(stopAt);
  for (;;) {
    if (fs.existsSync(path.join(cur, ".git"))) return true;
    if (norm(cur) === norm(stop)) return false;
    const parent = path.dirname(cur);
    if (parent === cur) return false; // filesystem root
    cur = parent;
  }
}
check("(c) no .git ancestor between WORKTREES_DIR and LOOM_HOME's parent",
  !hasGitAncestor(WORKTREES_DIR, path.dirname(LOOM_HOME)));

// (d) git itself agrees: from inside WORKTREES_DIR, `git rev-parse --show-toplevel` must NOT resolve to
//     the LOOM_HOME repo — either it fails outright (not inside any work tree, the ideal case) or it
//     resolves to some other, unrelated ancestor repo, but never LOOM_HOME.
let toplevel = null;
try {
  toplevel = execSync("git rev-parse --show-toplevel", { cwd: WORKTREES_DIR }).toString().trim();
} catch {
  toplevel = null;
}
check("(d) WORKTREES_DIR does not resolve into the LOOM_HOME git repo",
  toplevel === null || norm(toplevel) !== norm(LOOM_HOME));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  worktrees-base-isolation (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
