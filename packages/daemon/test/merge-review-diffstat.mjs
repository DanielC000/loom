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

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mrd-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree, removeWorktree, deleteBranch, diffBranch } =
  await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const repo = path.join(os.tmpdir(), `loom-mrd-repo-${Date.now()}-${process.pid}`);

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

  // ── BOUNDED (card 53518a56): diffBranch's git ops (diffSummary, diff, and the name-status `raw` call
  //    behind includeStatus) were NOT timeout-bounded, unlike the sibling reconcile ops reviewWorkerMerge
  //    calls alongside it (detectStrandedWork / countCommitsBehind, both already {timeoutMs}-bounded) — a
  //    hung one of these could wedge reviewWorkerMerge (and so the manager's worker_merge gate) forever;
  //    the outer try/catch around diffBranch only ever caught an ERROR, never a HANG. Mirrors the
  //    never-resolving-fake-git proof worktrees.mjs already uses for removeWorktree/isBranchMerged/
  //    deleteBranch. Proves ALL THREE ops are bounded individually — a half-fix bounding only one would
  //    still wedge on either of the others.
  {
    const TIMER_SLACK_MS = 50;
    const tinyMs = 250;

    // (a) diffSummary hangs → diffBranch REJECTS within the bound (not an infinite hang).
    const neverGit = {
      diffSummary: () => new Promise(() => {}), // a hung `git diff --stat` child: never settles
      diff: () => new Promise(() => {}),
      raw: () => new Promise(() => {}),
    };
    let boundMs = -1;
    let rejected = false;
    const t0 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    await diffBranch(repo, branch, "HEAD", {}, { gitFactory: (_p, ms) => { boundMs = ms; return neverGit; }, timeoutMs: tinyMs })
      .then(() => {}, () => { rejected = true; });
    const elapsed = performance.now() - t0;
    check("BOUNDED(a): diffBranch REJECTS (not hangs) when the underlying diffSummary never resolves", rejected);
    check(`BOUNDED(a): settles within the bound (${Math.round(elapsed)}ms, cap ${tinyMs}ms)`,
      elapsed >= tinyMs - TIMER_SLACK_MS && elapsed < tinyMs * 8 + 1500);
    check(`BOUNDED(a): the block timeout is passed through to the git factory (got ${boundMs}ms)`, boundMs === tinyMs);

    // (b) the DEFAULT (no timeoutMs) path uses the same 15s per-op block timeout as the sibling reconcile
    //     ops (detectStrandedWork / countCommitsBehind / GIT_OP_TIMEOUT_MS).
    let defaultMs = -1;
    const fastGit = { diffSummary: async () => ({ files: [], insertions: 0, deletions: 0 }), diff: async () => "", raw: async () => "" };
    await diffBranch(repo, branch, "HEAD", { includePatch: false }, { gitFactory: (_p, ms) => { defaultMs = ms; return fastGit; } });
    check("BOUNDED(b): default per-op block timeout is 15000ms (matches GIT_OP_TIMEOUT_MS)", defaultMs === 15000);

    // (c) the `git diff` PATCH step hangs (diffSummary succeeds) → still bounded, not just the summary call.
    const patchHangsGit = {
      diffSummary: async () => ({ files: [{ file: "x.txt", insertions: 1, deletions: 0, binary: false }], insertions: 1, deletions: 0 }),
      diff: () => new Promise(() => {}), // the patch step hangs
      raw: async () => "",
    };
    let rejectedPatch = false;
    const t1 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    await diffBranch(repo, branch, "HEAD", { includePatch: true }, { gitFactory: () => patchHangsGit, timeoutMs: tinyMs })
      .then(() => {}, () => { rejectedPatch = true; });
    const elapsedPatch = performance.now() - t1;
    check("BOUNDED(c): diffBranch REJECTS when the `git diff` patch step hangs (summary already succeeded)", rejectedPatch);
    check(`BOUNDED(c): patch-step hang also settles within the bound (${Math.round(elapsedPatch)}ms, cap ${tinyMs}ms)`,
      elapsedPatch >= tinyMs - TIMER_SLACK_MS && elapsedPatch < tinyMs * 8 + 1500);

    // (d) the name-status `raw` call (includeStatus:true) hangs → diffNameStatus fails safe (its own
    //     try/catch swallows a withTimeout rejection same as any other git error), so diffBranch RESOLVES
    //     with no status rather than propagating — but it must still settle within the bound, not hang.
    const nameStatusHangsGit = {
      diffSummary: async () => ({ files: [{ file: "x.txt", insertions: 1, deletions: 0, binary: false }], insertions: 1, deletions: 0 }),
      diff: async () => "",
      raw: () => new Promise(() => {}), // `git diff --name-status` hangs
    };
    let statusSettled = false;
    let statusResult;
    const t2 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
    await diffBranch(repo, branch, "HEAD", { includePatch: false, includeStatus: true }, { gitFactory: () => nameStatusHangsGit, timeoutMs: tinyMs })
      .then((r) => { statusSettled = true; statusResult = r; });
    const elapsedStatus = performance.now() - t2;
    check("BOUNDED(d): diffBranch RESOLVES (degrades, not hangs) when the name-status call hangs", statusSettled);
    check(`BOUNDED(d): name-status hang also settles within the bound (${Math.round(elapsedStatus)}ms, cap ${tinyMs}ms)`,
      elapsedStatus >= tinyMs - TIMER_SLACK_MS && elapsedStatus < tinyMs * 8 + 1500);
    check("BOUNDED(d): degraded result carries NO status (timeout swallowed, not guessed)", statusResult.files.every((f) => f.status === undefined));
  }

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
