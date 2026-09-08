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
