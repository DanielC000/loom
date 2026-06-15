import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_merge step-1 payload-shape test (card bb1264cc). REAL git on a temp repo (worker-diff.mjs
// style), fully in-process — NO daemon, NO claude. Proves the diffBranch change that backs the gate's
// step-1 default: a BOUNDED diffstat (per-file ± + totals) is returned WITHOUT the unbounded patch, so a
// manager relying on step-1 as its review surface can't be blinded by an overflow exactly when the diff is
// large/riskiest; the full patch is still obtainable on request (includePatch:true → the worker_merge
// `fullDiff` flag). LOOM_HOME set before importing dist/* so WORKTREES_DIR is isolated.
// Run: 1) build daemon, 2) node test/merge-review-diffstat.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mrd-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree, removeWorktree, deleteBranch, diffBranch } =
  await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const repo = path.join(os.tmpdir(), `loom-mrd-repo-${Date.now()}`);

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# v1\n");
  execSync(`git init -q && git config user.email mrd@loom && git config user.name mrd && git add . && git commit -q -m init`, { cwd: repo });

  // A worker branch with a LARGE multi-file change — the case where the OLD full-patch payload overflowed.
  const { worktreePath, branch } = await createWorktree(repo, "projMRD", "bigdiff-aaaa-1111");
  const NFILES = 12, LINES = 400;
  for (let i = 0; i < NFILES; i++) {
    const body = Array.from({ length: LINES }, (_, n) => `file ${i} line ${n} — padding to make the patch large`).join("\n") + "\n";
    fs.writeFileSync(path.join(worktreePath, `big-${i}.txt`), body);
  }
  execSync(`git add . && git -c user.email=mrd@loom -c user.name=mrd commit -qm "big change"`, { cwd: worktreePath });

  // ── DEFAULT (includePatch:false) → bounded diffstat, NO patch.
  const stat = await diffBranch(repo, branch, "HEAD", { includePatch: false });
  check("DEFAULT: filesChanged counts every changed file", stat.filesChanged === NFILES);
  check("DEFAULT: returns a per-file diffstat array", Array.isArray(stat.files) && stat.files.length === NFILES);
  check("DEFAULT: each diffstat row has file + numeric ±", stat.files.every((f) => typeof f.file === "string" && Number.isFinite(f.insertions) && Number.isFinite(f.deletions) && typeof f.binary === "boolean"));
  check("DEFAULT: insertion total matches files × lines", stat.insertions === NFILES * LINES);
  check("DEFAULT: patch is EMPTY (not computed — the unbounded field is skipped)", stat.patch === "");

  // ── FULL (includePatch:true) → same diffstat PLUS the full unified patch.
  const full = await diffBranch(repo, branch, "HEAD", { includePatch: true });
  check("FULL: includes the full unified patch on request", full.patch.includes("big-0.txt") && full.patch.includes("file 11 line 399"));
  check("FULL: still carries the diffstat", full.filesChanged === NFILES && full.files.length === NFILES);

  // ── BOUNDEDNESS: the default payload (what step-1 ships) must stay small regardless of diff size,
  //    while the full patch grows with it — that's the overflow fix.
  const defaultBytes = JSON.stringify({ filesChanged: stat.filesChanged, insertions: stat.insertions, deletions: stat.deletions, files: stat.files }).length;
  check("BOUNDED: default payload is far smaller than the full patch", defaultBytes < full.patch.length / 10);
  check("BOUNDED: full patch is genuinely large (the overflow case)", full.patch.length > 100_000);

  // ── DEFAULT-OF-DEFAULT: omitting opts keeps the patch (existing callers like workerDiff stay intact).
  const legacy = await diffBranch(repo, branch);
  check("BACK-COMPAT: no opts → patch still present (workerDiff path unchanged)", typeof legacy.patch === "string" && legacy.patch.includes("big-0.txt"));
  check("BACK-COMPAT: no opts → diffstat also present (additive)", Array.isArray(legacy.files) && legacy.files.length === NFILES);

  await removeWorktree(repo, worktreePath);
  await deleteBranch(repo, branch);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_merge step-1 returns a bounded diffstat by default (no unbounded patch, won't overflow on a big diff), with the full patch obtainable on request; existing diffBranch callers are unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
