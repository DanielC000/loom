import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card dc281db8 — computeWorktreeGateStamp derived `dirty` from the daemon-noise FILTER
// (uncommittedWorkFiles/worktreeStatusHasWork) but derived `dirtyHash` from RAW, UNFILTERED
// `git status --porcelain` + `git diff HEAD`. On an ALREADY-DIRTY tree, pure daemon/Claude-injected
// `.claude/` churn — exactly the class the filter exists to swallow — flipped `dirtyHash` (and therefore
// `gateStampsDiffer`) even though `dirty` itself correctly stayed governed by the filtered view. A
// clean-tree fixture is structurally blind to this: the bug only shows up once the tree is ALREADY dirty
// for a real reason, so every case below starts from a real, uncommitted tracked edit.
//
// THE FIX (git/worktrees.ts, computeWorktreeGateStamp): hash the SAME filtered lines/paths `dirty` is
// computed from, and scope the `diff HEAD` used in the hash to those same survivor paths — so noise that
// `uncommittedWorkFiles` already excludes can never reach the hash either, from either input.
//
// Proves:
//   (A) an ALREADY-DIRTY tree (a real uncommitted edit to a tracked file), then untracked `.claude/`
//       noise (a non-skills doctrine artifact) PLUS a re-copied/modified TRACKED `.claude/skills/…` file
//       (the "re-copy over a tracked colliding skill name" case worktreeStatusHasWork's own doc names) —
//       `dirty` stays true (unaffected either way) and `gateStampsDiffer` is FALSE: the noise does not
//       flip the hash.
//   (B) CONTROL — a CLEAN tree, then the identical noise: `dirty` stays false and `gateStampsDiffer` is
//       FALSE. Proves the filter holds while `dirty` stays false, unaffected by this fix either way.
//   (C) POSITIVE CONTROL — from the (A) noisy-but-still-real-dirty tree, a REAL further edit to the
//       already-tracked file: `gateStampsDiffer` is TRUE. This is the load-bearing assertion — the fix
//       makes the detector LESS sensitive to noise, and this proves it did not also make it blind to a
//       genuine change.
//   (D) POSITIVE CONTROL, rename case — reviewer nit on this fix's own diff-scoping: porcelain v1 renders
//       a rename/copy as `old -> new`, so scoping the hash's `diff HEAD` to the porcelain-derived path
//       could easily extract that WHOLE `old -> new` string as one bogus pathspec (matching nothing) and
//       go blind to a REAL content edit made to the renamed file afterward. A `git mv`, then a content
//       edit to the renamed file, must still flip `gateStampsDiffer`.
//
// Run: 1) build daemon (pnpm build), 2) node test/gate-stamp-noise-filter.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gsnf-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { computeWorktreeGateStamp, gateStampsDiffer } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execSync(`git init -q && git config user.email gsnf@loom && git config user.name gsnf`, { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "line one\n");
  fs.mkdirSync(path.join(dir, ".claude", "skills", "existing-skill"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "skills", "existing-skill", "SKILL.md"), "original skill body\n");
  execSync(`git add -A && git commit -q -m init`, { cwd: dir });
}

function addNoise(dir) {
  // (a) untracked, non-skills doctrine artifact — Claude's own permission-persistence write.
  fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), JSON.stringify({ n: Date.now() }));
  // (b) the daemon-injected skills subtree, re-copied over a TRACKED colliding skill name — surfaces as a
  //     TRACKED modification, not `??` (worktreeStatusHasWork's own doc comment names this exact case).
  fs.writeFileSync(path.join(dir, ".claude", "skills", "existing-skill", "SKILL.md"), "re-copied skill body\n");
  // (c) an untracked skill dir with no prior tracked collision at all.
  fs.mkdirSync(path.join(dir, ".claude", "skills", "injected-skill"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "skills", "injected-skill", "SKILL.md"), "injected\n");
}

const repoA = path.join(os.tmpdir(), `loom-gsnf-a-${Date.now()}-${process.pid}`);
const repoB = path.join(os.tmpdir(), `loom-gsnf-b-${Date.now()}-${process.pid}`);
const repoD = path.join(os.tmpdir(), `loom-gsnf-d-${Date.now()}-${process.pid}`);

try {
  // ── (A) already-dirty tree + daemon/.claude noise ─────────────────────────────────────────────────
  initRepo(repoA);
  fs.writeFileSync(path.join(repoA, "README.md"), "line one\nreal uncommitted edit\n"); // real tracked work
  const aStamp1 = await computeWorktreeGateStamp(repoA);
  check("(A) stamp1 is dirty (real tracked edit present)", aStamp1.dirty === true && aStamp1.dirtyHash !== null);

  addNoise(repoA);
  const aStamp2 = await computeWorktreeGateStamp(repoA);
  check("(A) stamp2 is still dirty (noise doesn't clear it)", aStamp2.dirty === true && aStamp2.dirtyHash !== null);
  check("(A) noise-only churn on an already-dirty tree does NOT flip gateStampsDiffer",
    gateStampsDiffer(aStamp1, aStamp2) === false);

  // ── (B) CONTROL: clean tree + the identical noise ─────────────────────────────────────────────────
  initRepo(repoB);
  const bStamp1 = await computeWorktreeGateStamp(repoB);
  check("(B) [control] stamp1 is clean", bStamp1.dirty === false && bStamp1.dirtyHash === null);

  addNoise(repoB);
  const bStamp2 = await computeWorktreeGateStamp(repoB);
  check("(B) [control] stamp2 stays clean (noise never trips dirty)", bStamp2.dirty === false && bStamp2.dirtyHash === null);
  check("(B) [control] gateStampsDiffer is FALSE on a clean tree with only noise",
    gateStampsDiffer(bStamp1, bStamp2) === false);

  // ── (C) POSITIVE CONTROL: a REAL further edit on top of the (A) noisy tree still trips it ─────────
  fs.writeFileSync(path.join(repoA, "README.md"), "line one\nreal uncommitted edit\nANOTHER real edit\n");
  const aStamp3 = await computeWorktreeGateStamp(repoA);
  check("(C) [positive control] a genuine further tracked edit DOES flip gateStampsDiffer",
    gateStampsDiffer(aStamp2, aStamp3) === true);

  // ── (D) POSITIVE CONTROL: a FULLY-STAGED rename, then a FURTHER staged content edit small enough to
  //     stay above git's rename-similarity threshold — the porcelain STATUS LINE reads byte-identical both
  //     times ("R  old -> new", nothing left unstaged; asserted below, not assumed), so only the SCOPED
  //     `diff HEAD` can tell the two states apart. This is the exact case a bogus, unsplit `old -> new`
  //     pathspec goes blind to (verified separately: `git diff HEAD -- "a -> b"` returns empty, silently,
  //     no error) — proving the fix must extract the NEW path from a rename line, not merely that doing so
  //     doesn't crash. (An earlier version of this case used a large edit that dropped git's own rename
  //     detection below its similarity threshold — the porcelain line itself then changed shape (`R`
  //     became `D`+`A`), which discriminates for an unrelated reason and would pass even pre-fix.)
  try {
    initRepo(repoD);
    const base = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    fs.writeFileSync(path.join(repoD, "renamed source.txt"), base);
    execSync(`git add -A && git commit -q -m "add renamed source"`, { cwd: repoD });
    execSync(`git mv "renamed source.txt" "renamed target.txt"`, { cwd: repoD });
    execSync(`git add -A`, { cwd: repoD }); // fully stage the rename, content still v1
    const dPorcelain1 = execSync(`git status --porcelain`, { cwd: repoD }).toString();
    const dStamp1 = await computeWorktreeGateStamp(repoD);
    check("(D) fully-staged rename registers as dirty", dStamp1.dirty === true && dStamp1.dirtyHash !== null);

    fs.writeFileSync(path.join(repoD, "renamed target.txt"), base + "one more small line\n");
    execSync(`git add -A`, { cwd: repoD }); // re-stage: small edit, still detected as the same rename
    const dPorcelain2 = execSync(`git status --porcelain`, { cwd: repoD }).toString();
    check("(D) [precondition] the porcelain status line is byte-identical before/after the content edit "
      + "— confirms this case exercises the diff, not the status text", dPorcelain1 === dPorcelain2 && /^R  /.test(dPorcelain1));
    const dStamp2 = await computeWorktreeGateStamp(repoD);
    check("(D) [positive control] a staged content edit to the RENAMED file still flips gateStampsDiffer "
      + "(even though the porcelain status line itself did not change)",
      gateStampsDiffer(dStamp1, dStamp2) === true);
  } finally {
    try { fs.rmSync(repoD, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
} finally {
  for (const d of [repoA, repoB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — computeWorktreeGateStamp's dirtyHash now hashes the SAME daemon-noise-filtered view " +
    "`dirty` uses (filtered porcelain lines + a diff scoped to those survivor paths), so `.claude/` churn " +
    "on an already-dirty tree no longer flips gateStampsDiffer, while a genuine further edit still does."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
