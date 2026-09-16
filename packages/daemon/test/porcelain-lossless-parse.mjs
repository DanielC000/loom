import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8cc047d3 — Code Reviewer follow-up on 00a6cdd6: `porcelainLinePath` (the shared parser feeding
// `uncommittedWorkFiles`/`precheckWorkerDone` and `computeWorktreeGateStamp`'s `dirtyHash`) parsed a v1
// (non-`-z`) `git status --porcelain` line and only stripped ONE outer pair of quotes. Two real breaks:
//   (1) a non-ASCII path comes back C-ESCAPED (`"caf\303\251.txt"` stays escaped octal text, not
//       `café.txt`) — verified directly below (positive control: `-c core.quotePath=false` / `-z` alone
//       makes it print verbatim; that's the fix this card ships).
//   (2) an unconditional `p.indexOf(" -> ")` mis-splits ANY path containing a literal `" -> "` substring,
//       whether or not the line is actually a rename (a `??` line has no separator at all — a hit there
//       is always a false rename).
// THE FIX (git/worktrees.ts): every affected caller now reads `git status --porcelain -z` (NUL-delimited,
// verbatim bytes, no `" -> "` string-search) through a shared, structured `-z` record parser
// (generalized from the already-merged `parseAutoCommitStatusZ`, card 00a6cdd6) instead of parsing text
// lines.
//
// Proves, against REAL git in temp repos:
//   (A) precheckWorkerDone names a non-ASCII UNTRACKED file's REAL bytes, not its C-escaped form.
//   (B) [load-bearing] computeWorktreeGateStamp's dirtyHash actually changes when a TRACKED non-ASCII
//       file's CONTENT changes — pre-fix, the escaped pathspec `git diff HEAD -- <path>` builds from
//       silently matches nothing, so the diff half of the hash goes blind and two DIFFERENT contents can
//       hash identically (a false "unchanged").
//   (C) a STAGED RENAME to a non-ASCII+space name: precheckWorkerDone names the real new path, and a
//       further content edit to the renamed file still flips gateStampsDiffer.
//   (D) [posix-only — see SKIP] an UNTRACKED file literally named with a `" -> "` substring is named
//       correctly, not mis-split to the tail after the fake "arrow". `>` is illegal on NTFS (CLAUDE.md),
//       so this is SKIPPED on Windows and must be exercised by ubuntu CI.
//   (E) [positive/negative control] a plain ASCII path containing an ordinary SPACE was NEVER broken
//       (git already quotes-without-escaping a bare space) — asserted here so a control run against the
//       UNFIXED parser shows this one passing even pre-fix, isolating what the fix actually changes.
//   (F/G/H) manager follow-up: worktreeHasWork/classifyRetainedWorktree are NOT near-duplicates of (A)-(E)
//       — they sit behind the boot-reconcile worktree-GC "safe to discard" guard (@decision 9cb0287a, a
//       P0 data-loss fix), so a wrong "no work" there deletes a worker's uncommitted changes. Direct
//       real-git coverage: (F) an untracked non-ASCII file, (G) a tracked-modified non-ASCII file, and
//       (H) [positive/negative control] daemon `.claude/` noise ALONE, still correctly filtered under `-z`.
//   (I) discardedByResetFiles (exercised via createWorktree's real 0-ahead recut path, the only way to
//       reach it): a TRACKED non-ASCII modification a `reset --hard` is about to destroy is named
//       correctly in `discardedOnRecut`, not C-escaped.
// Run: 1) build daemon (pnpm build), 2) node test/porcelain-lossless-parse.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-plp-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const {
  precheckWorkerDone, computeWorktreeGateStamp, gateStampsDiffer, worktreeHasWork, createWorktree,
} = await import("../dist/git/worktrees.js");

let failures = 0;
let skipped = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const skip = (label, reason) => { console.log(`SKIP  ${label} — ${reason}`); skipped++; };
const GIT_ID = "-c user.email=plp@loom -c user.name=plp";

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execSync(`git init -q && git config user.email plp@loom && git config user.name plp`, { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# plp\n");
  commitAll(dir, "init", GIT_ID);
}

function canCreateFileNamed(dir, name) {
  try {
    fs.writeFileSync(path.join(dir, name), "x");
    return true;
  } catch {
    return false;
  }
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repoA = path.join(os.tmpdir(), `loom-plp-a-${sfx}`); // (A) non-ASCII untracked
const repoB = path.join(os.tmpdir(), `loom-plp-b-${sfx}`); // (B) non-ASCII tracked content-change
const repoC = path.join(os.tmpdir(), `loom-plp-c-${sfx}`); // (C) staged rename to non-ASCII+space
const repoD = path.join(os.tmpdir(), `loom-plp-d-${sfx}`); // (D) literal " -> " in an untracked name
const repoE = path.join(os.tmpdir(), `loom-plp-e-${sfx}`); // (E) control: plain ASCII space
const repoF = path.join(os.tmpdir(), `loom-plp-f-${sfx}`); // (F) worktreeHasWork: untracked non-ASCII
const repoG = path.join(os.tmpdir(), `loom-plp-g-${sfx}`); // (G) worktreeHasWork: tracked-modified non-ASCII
const repoH = path.join(os.tmpdir(), `loom-plp-h-${sfx}`); // (H) worktreeHasWork: .claude noise only, control
const repoI = path.join(os.tmpdir(), `loom-plp-i-${sfx}`); // (I) discardedByResetFiles via recut

try {
  // ── (A) precheckWorkerDone names a non-ASCII untracked file's REAL bytes ─────────────────────────────
  initRepo(repoA);
  fs.writeFileSync(path.join(repoA, "café.txt"), "hello");
  const pcA = await precheckWorkerDone(repoA, repoA, null);
  check("(A) precheckWorkerDone sees the tree as uncommitted", pcA.uncommitted === true);
  check("(A) the reported file is the REAL byte path 'café.txt', not a C-escaped placeholder",
    pcA.files.includes("café.txt"));
  check("(A) [negative control] the file list contains no octal-escape artifact",
    !pcA.files.some((f) => f.includes("\\303\\251") || f.includes('"')));

  // ── (B) [load-bearing] gate-stamp dirtyHash must SEE a content edit to a non-ASCII tracked file ───────
  initRepo(repoB);
  fs.writeFileSync(path.join(repoB, "café.txt"), "v1\n");
  commitAll(repoB, "add café.txt", GIT_ID);
  fs.writeFileSync(path.join(repoB, "café.txt"), "v2 — first edit\n");
  const bStamp1 = await computeWorktreeGateStamp(repoB);
  check("(B) stamp1 is dirty", bStamp1.dirty === true && bStamp1.dirtyHash !== null);
  fs.writeFileSync(path.join(repoB, "café.txt"), "v3 — a COMPLETELY DIFFERENT further edit\n");
  const bStamp2 = await computeWorktreeGateStamp(repoB);
  check("(B) stamp2 is dirty", bStamp2.dirty === true && bStamp2.dirtyHash !== null);
  check("(B) [load-bearing] a genuine further content edit to a TRACKED non-ASCII-named file DOES flip "
    + "gateStampsDiffer (pre-fix: the escaped diff pathspec matches nothing, so both edits silently hash "
    + "the same and this assertion is FALSE)",
    gateStampsDiffer(bStamp1, bStamp2) === true);

  // ── (C) staged rename to a non-ASCII+space name ──────────────────────────────────────────────────────
  initRepo(repoC);
  fs.writeFileSync(path.join(repoC, "old.txt"), "line one\n");
  commitAll(repoC, "add old.txt", GIT_ID);
  execFileSync("git", ["mv", "old.txt", "café new.txt"], { cwd: repoC });
  execFileSync("git", ["add", "-A"], { cwd: repoC }); // fully stage the rename
  const pcC = await precheckWorkerDone(repoC, repoC, null);
  check("(C) precheckWorkerDone sees the staged rename as uncommitted", pcC.uncommitted === true);
  check("(C) the reported NEW path is the real byte path 'café new.txt', not escaped/quoted",
    pcC.files.includes("café new.txt"));
  const cStamp1 = await computeWorktreeGateStamp(repoC);
  check("(C) [precondition] gate stamp registers the staged rename as dirty", cStamp1.dirty === true);
  fs.writeFileSync(path.join(repoC, "café new.txt"), "line one\none more small line\n");
  execFileSync("git", ["add", "-A"], { cwd: repoC }); // re-stage: small edit, still detected as the same rename
  const cStamp2 = await computeWorktreeGateStamp(repoC);
  check("(C) a further content edit to the RENAMED non-ASCII file still flips gateStampsDiffer",
    gateStampsDiffer(cStamp1, cStamp2) === true);

  // ── (D) [posix-only] a literal " -> " substring in an untracked filename ────────────────────────────
  initRepo(repoD);
  if (!canCreateFileNamed(repoD, "a -> b.txt")) {
    skip("(D) literal \" -> \" in a filename", "this filesystem rejects '>' in a filename (Windows/NTFS) — exercised on ubuntu CI");
  } else {
    fs.writeFileSync(path.join(repoD, "a -> b.txt"), "x");
    const pcD = await precheckWorkerDone(repoD, repoD, null);
    check("(D) precheckWorkerDone sees the tree as uncommitted", pcD.uncommitted === true);
    check("(D) the reported file is the WHOLE real name 'a -> b.txt', not mis-split to a fake rename tail",
      pcD.files.includes("a -> b.txt"));
    check("(D) [negative control] the mis-split artifact 'b.txt' is NOT what got reported",
      !pcD.files.includes("b.txt"));
  }

  // ── (E) [control] a plain ASCII space was never broken — must keep passing post-fix ────────────────
  initRepo(repoE);
  fs.writeFileSync(path.join(repoE, "my file.txt"), "x");
  const pcE = await precheckWorkerDone(repoE, repoE, null);
  check("(E) [control] a plain space-containing path is reported byte-exact (pre- and post-fix)",
    pcE.files.includes("my file.txt"));

  // ── (F) worktreeHasWork: an untracked non-ASCII file alone ⇒ has work ───────────────────────────────
  initRepo(repoF);
  const wtF = await createWorktree(repoF, "plp-proj-f", "plp-task-f");
  fs.writeFileSync(path.join(wtF.worktreePath, "café.txt"), "hello");
  check("(F) worktreeHasWork sees an untracked non-ASCII file as work",
    await worktreeHasWork(repoF, wtF.worktreePath, null) === true);

  // ── (G) worktreeHasWork: a TRACKED, modified non-ASCII file alone ⇒ has work ────────────────────────
  initRepo(repoG);
  fs.writeFileSync(path.join(repoG, "café.txt"), "v1\n"); // tracked on the canonical repo BEFORE the worktree exists
  commitAll(repoG, "add café.txt", GIT_ID);
  const wtG = await createWorktree(repoG, "plp-proj-g", "plp-task-g");
  fs.writeFileSync(path.join(wtG.worktreePath, "café.txt"), "v2 — uncommitted edit\n");
  check("(G) worktreeHasWork sees a tracked-modified non-ASCII file as work",
    await worktreeHasWork(repoG, wtG.worktreePath, null) === true);

  // ── (H) [positive/negative control] worktreeHasWork: daemon `.claude/` noise ALONE ⇒ NOT work ───────
  //     Proves the noise filter still filters correctly reading `-z` — a regression here would silently
  //     make boot-reconcile treat every daemon-touched worktree as holding real work forever.
  initRepo(repoH);
  const wtH = await createWorktree(repoH, "plp-proj-h", "plp-task-h");
  fs.mkdirSync(path.join(wtH.worktreePath, ".claude", "skills", "foo"), { recursive: true });
  fs.writeFileSync(path.join(wtH.worktreePath, ".claude", "skills", "foo", "SKILL.md"), "injected\n");
  fs.writeFileSync(path.join(wtH.worktreePath, ".claude", "settings.local.json"), "{}");
  check("(H) [control] worktreeHasWork treats daemon .claude/ noise ALONE as NOT work",
    await worktreeHasWork(repoH, wtH.worktreePath, null) === false);

  // ── (I) discardedByResetFiles: a TRACKED non-ASCII modification a recut is about to destroy is named
  //     correctly — reached the only way it's reachable: a real 0-ahead reused-worktree recut.
  initRepo(repoI);
  fs.writeFileSync(path.join(repoI, "café.txt"), "v1\n"); // tracked on the canonical repo before the worktree exists
  commitAll(repoI, "add café.txt", GIT_ID);
  const wtI1 = await createWorktree(repoI, "plp-proj-i", "plp-task-i"); // 0 commits ahead
  fs.writeFileSync(path.join(wtI1.worktreePath, "café.txt"), "v2 — about to be discarded\n"); // tracked, dirty, uncommitted
  const wtI2 = await createWorktree(repoI, "plp-proj-i", "plp-task-i"); // same task → reuse → 0-ahead recut resets --hard
  check("(I) [precondition] reuse returned the SAME worktree path", wtI2.worktreePath === wtI1.worktreePath);
  check("(I) discardedOnRecut IS set (the tracked non-ASCII edit was destroyed by the reset)",
    wtI2.discardedOnRecut !== undefined);
  check("(I) discardedOnRecut names the REAL byte path 'café.txt', not a C-escaped placeholder",
    wtI2.discardedOnRecut?.statusSummary.includes("café.txt"));
  check("(I) [negative control] no octal-escape artifact leaked into the summary",
    !(wtI2.discardedOnRecut?.statusSummary.includes("\\303\\251") || wtI2.discardedOnRecut?.statusSummary.includes('"')));
  // normalize \r\n → \n: a host with core.autocrlf=true (this box included) checks the reset-restored
  // content back out as CRLF, which is a host-config artifact, not something this assertion cares about.
  check("(I) the tracked edit is actually GONE on disk — reverted by the reset",
    fs.readFileSync(path.join(wtI2.worktreePath, "café.txt"), "utf8").replace(/\r\n/g, "\n") === "v1\n");
} finally {
  for (const d of [repoA, repoB, repoC, repoD, repoE, repoF, repoG, repoH, repoI]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`\n${skipped} case(s) skipped (see SKIP reasons above — only ubuntu CI, where '>' is a legal `
  + `filename character, actually exercises them).`);
console.log(failures === 0
  ? "\n✅ ALL PASS — uncommittedWorkFiles/precheckWorkerDone and computeWorktreeGateStamp now parse "
    + "`git status --porcelain -z` losslessly: non-ASCII paths come back as real bytes (not C-escaped), a "
    + "path containing a literal \" -> \" is never mis-split, and a content edit to a non-ASCII-named "
    + "tracked file is no longer invisible to the gate stamp's dirtyHash."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
