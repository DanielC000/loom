import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card be79f4d5 (discovered from a6fa60e2 / Code Review 4d619c1f round 2's reading of a6fa60e2):
// `activeMergeQuarantineFor`'s LAZY GRADUATION path (git/merge-quarantine.ts, the graduation branch near
// the end of that function) splices a `pendingUnresolvedQuarantines` entry out UNCONDITIONALLY, before it
// even knows whether the fresh-key durable write will succeed. If `writeMergeQuarantineLatch` then FAILS,
// the entry is still armed in-memory (enforcement holds for THIS process), but its only durable copy stays
// at `pending.sourceFile` — a filename that is:
//   - no longer in `pendingUnresolvedQuarantines` (it was already spliced out), so
//     `physicalOwnerRepoPaths`'s PENDING check (`p.sourceFile === filename`) can never match it again, and
//   - never folded into `armed.orphanLatchFiles` (unlike PASS 1's OWN failed-migrate branch, which a6fa60e2
//     already fixed to do exactly this for its own analogous stale-source file).
// So nothing anywhere tracks this filename as OWNED. A raw clear-by-id of it (the id a human would read off
// an earlier boot-time error log, or simply guess from the repo's own pre-upgrade/legacy key) falls through
// `clearMergeQuarantineLatchFile`'s active/pending match loops into the orphan-sweep fallback, which deletes
// it outright with no ownership signal at all — destroying the quarantine's only durable record. The
// in-memory entry stays active for the rest of THIS process's life, so nothing looks wrong until the NEXT
// restart: there is no file left for `reenterMergeQuarantinesAtBoot` to re-arm the quarantine from, and the
// repo comes back up UNQUARANTINED — the same silent fail-open class a6fa60e2 fixed for PASS 1's migrate
// branch, now reproduced through the lazy-graduation door instead.
//
// SCENARIO 1 covers a PASS-1-sourced (`.json` final) pending entry. SCENARIO 2 covers the SAME defect
// through a PASS-1b-sourced (`.json.tmp-<pid>` residue) pending entry — a second, separate ownership gap
// in `clearMergeQuarantineLatchFile`'s RAW FALLBACK (reached when NOTHING in memory matches the cleared
// id). SCENARIO 3 covers the dangling-reference flip side (a6fa60e2's own scenario 3, applied to this
// branch): once `orphanLatchFiles` is folded in on failure, a SUCCESSFUL graduation must strip it again.
// SCENARIOS 6 and 7 (Code Review eccb3d10, round 2) originally covered the SAME ownership gap through
// `clearMergeQuarantineLatchFile`'s OTHER branch — the PENDING-MATCH branch's own belt-and-suspenders
// sweep, reached when the clear-by-id DOES match some OTHER, unrelated pending entry sharing the same
// hash prefix. ⚠️ SCENARIO 6's own premise (two same-repo pending entries, only one of which graduates in
// one query) was CLOSED by card 188b145f — `activeMergeQuarantineFor` now consumes BOTH in the one
// graduation query, so there is no longer an independent pending entry left for a raw clear-by-id to
// separately match: SCENARIO 6 now exercises the RAW FALLBACK branch instead (see that scenario's own
// updated comment), and `wasQuarantined===false` on its clear-by-id pins that explicitly. SCENARIO 7 (a
// cross-REPO hash collision, not a same-repo multi-pending one) is unaffected and still exercises the
// PENDING-MATCH branch (`wasQuarantined===true`). SCENARIO 9 (added for card 188b145f round 2) is SCENARIO
// 7's `.tmp-`-sourced twin — a TMP variant restoring coverage for the PENDING-MATCH branch's own
// belt-and-suspenders TMP sweep specifically, which scenario 6 moving away from that branch left unguarded.
// SCENARIOS 4 and 5 (Delta Code Review bd812c95, round 3) cover the SAME gap through TWO
// MORE call sites this card's own earlier rounds mistakenly treated as correctly-unconditional "negative
// controls": `clearMergeQuarantineByKey`'s legitimate-clear tmp sweep, and
// `writeMergeQuarantineLatch`'s own `sweepOtherTmpsOnSuccess` — both used to delete a same-hash tmp a
// DIFFERENT, SURVIVING entry still references, silently failing that entry OPEN on the next restart.
// Each now carries its own negative control instead: the CLEARED/SUPERSEDED entry's OWN unreferenced
// residue is still swept. SCENARIO 8 (Delta Code Review 18485645, round 4) closes the LAST remaining
// call site of the same shape: `clearMergeQuarantineByToken`'s own PARTIAL-clear branch (a
// reduced-but-still-outstanding token set), which rounds 1-3 deliberately left as an out-of-scope
// residual until the reviewer reproduced it as real.
//
// See docs/decisions/be79f4d5-lazy-graduation-source-latch-ownership.md for the fix narrative.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-lazy-graduation-source-latch-owner.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqlg-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantine, clearMergeQuarantineLatchFile, clearMergeQuarantineByToken, activeMergeQuarantineFor,
  enterMergeQuarantine, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR, quarantineLatchIdFor,
} = await import(mergeQuarantineModuleHref);

// A genuinely fresh ESM module instance (its OWN empty activeQuarantines/pendingUnresolvedQuarantines) to
// prove the "survives a restart" half — same technique as merge-quarantine-failed-migrate-latch-owner.mjs /
// merge-quarantine-pass1b-clean-parse-gate.mjs. Reads ONLY the durable files on disk.
let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqlg@loom -c user.name=mqlg";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Reproduces the OLD (pre-7673d096) key algorithm by hand — exactly what a pre-upgrade/legacy-keyed latch
// (or any other stale-key latch) is filed under. Same technique as the sibling repro files.
function oldHashFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// A fresh subdir-bound repo (no .git of its own) — its stale (legacy, direct) hash and fresh (toplevel-
// walked) hash necessarily differ, which is what makes "the pending entry's own sourceFile" a DIFFERENT
// filename than "the entry's current/fresh physical write target" in the first place.
function makeSubdirRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqlg-repo-${tag}-${freshSfx()}`);
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-lazy-graduation-source-latch-owner (${tag})\n`);
  execSync(`git init -q && git config user.email mqlg@loom && git config user.name mqlg`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return subdir;
}

// A toplevel-bound repo (no subdir offset) — used by scenarios 4/5, which don't need a stale/fresh hash
// split; they only need a repo `enterMergeQuarantine` can raise against normally.
function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqlg-top-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "toplevel\n");
  execSync(`git init -q && git config user.email mqlg@loom && git config user.name mqlg`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function moveRepoRootAway(subdir, parkedRoot) {
  fs.renameSync(subdir.replace(/[\\/]teamA$/, ""), parkedRoot);
}
function moveRepoRootBack(subdir, parkedRoot) {
  fs.renameSync(parkedRoot, subdir.replace(/[\\/]teamA$/, ""));
}

// Intercepts the open of the fresh-hash tmp file a graduation write creates, same EACCES-shaped injection
// technique the a6fa60e2 repro (merge-quarantine-failed-migrate-latch-owner.mjs) already uses for the
// sibling PASS 1 migrate-write failure. Returns {interceptCount, restore}.
function injectGraduationWriteFailure(freshHash) {
  const realOpenSync = fs.openSync;
  const counter = { interceptCount: 0 };
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(freshHash) && p.includes(".tmp-")) {
      counter.interceptCount++;
      throw Object.assign(new Error("EACCES: simulated graduation-write failure"), { code: "EACCES" });
    }
    return realOpenSync(p, ...rest);
  };
  return { counter, restore: () => { fs.openSync = realOpenSync; } };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — a PASS-1-sourced (`.json` final) pending latch becomes resolvable, graduation's fresh-key
  // write FAILS. The old sourceFile must stay OWNED (by the still-active in-memory entry) against a raw
  // clear-by-id — it currently is not.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s1");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const staleLatchPath = path.join(MERGE_QUARANTINE_DIR, `${staleHash}.json`);
  const freshHash = quarantineLatchIdFor(subdir); // the CURRENT (toplevel-walked) key's hash
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);
  check("(s1 precondition) stale and fresh hashes actually differ (this repo is subdir-bound)", staleHash !== freshHash);

  // Manufacture a PRE-upgrade-shaped latch (no resolvedKey) under the STALE hash — exactly the shape a
  // latch that predates the toplevel-walk upgrade would have.
  const manufacturedReason = "the REAL reason for this pending latch — must survive a failed graduation write";
  fs.writeFileSync(staleLatchPath, JSON.stringify({
    repoPath: subdir, branch: "pending-branch", reason: manufacturedReason,
    enteredAt: Date.now(), tokens: ["pending-token"],
  }, null, 2) + "\n");
  check("(s1 precondition) the pending stale-key latch file exists on disk", fs.existsSync(staleLatchPath));
  check("(s1 precondition) in-memory map is empty (simulating a fresh boot)", !activeMergeQuarantineFor(subdir));

  // Move the WHOLE repo away so boot re-entry can't verify the key — this is what files it as PENDING
  // (pendingUnresolvedQuarantines) rather than arming it directly into activeQuarantines.
  const parkedRoot = path.join(os.tmpdir(), `loom-mqlg-parked-s1-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  check("(s1 moved away) the subdir no longer resolves on disk", !fs.existsSync(subdir));

  const found = reenterMergeQuarantinesAtBoot([subdir]);
  check("(s1 moved away) boot re-entry reports this repo's quarantine (via the pending list)", found.some((q) => q.repoPath === subdir));
  check("(s1 moved away) the stale file is untouched (not migrated — key unverifiable while absent)", fs.existsSync(staleLatchPath));
  const pendingQuery = activeMergeQuarantineFor(subdir);
  check("(s1 moved away) activeMergeQuarantineFor reports it active while still unresolvable, WITHOUT graduating", !!pendingQuery && pendingQuery.reason === manufacturedReason);
  check("(s1 moved away) no fresh-hash file exists yet (not graduated)", !fs.existsSync(freshLatchPath));

  // Restore the repo — the path is resolvable again, so the NEXT query will attempt to GRADUATE the
  // pending entry (splice it out of pendingUnresolvedQuarantines, arm it under the fresh key, and durably
  // write it there).
  moveRepoRootBack(subdir, parkedRoot);
  check("(s1 restored) the subdir resolves on disk again", fs.existsSync(subdir));

  const inject = injectGraduationWriteFailure(freshHash);
  let activeAfterGraduation;
  try {
    activeAfterGraduation = activeMergeQuarantineFor(subdir); // THE GRADUATION QUERY
  } finally {
    inject.restore();
  }

  check("(s1 graduation attempt) the fresh-key write was actually attempted (and injected to fail)", inject.counter.interceptCount >= 1);
  check("(s1 graduation attempt) the repo still reads as quarantined in-memory despite the failed write", !!activeAfterGraduation);
  check("(s1 graduation attempt) the real reason carried over (not fabricated)", activeAfterGraduation?.reason === manufacturedReason);
  check("(s1 graduation attempt) the stale file is STILL the only durable copy (write failed, nothing deleted)", fs.existsSync(staleLatchPath));
  check("(s1 graduation attempt) no fresh-hash file was actually written (the write genuinely failed)", !fs.existsSync(freshLatchPath));

  // THE ACTUAL BUG / FIX TARGET: a raw clear-by-id of the STALE hash — the id a human would read off an
  // earlier boot log, or the repo's own pre-upgrade key — must be recognized as OWNED by the still-active
  // in-memory entry and KEPT, exactly like a6fa60e2 already guarantees for PASS 1's own analogous
  // failed-migrate branch.
  const clearResult = clearMergeQuarantineLatchFile(staleHash);
  check("(s1 clear-by-id on stale hash) call succeeds", clearResult.ok === true);
  check("(s1 clear-by-id on stale hash) THE FIX: reports the file was KEPT, not silently deleted", clearResult.ok === true && clearResult.latchKept === true);
  check("(s1 clear-by-id on stale hash) THE BUG THIS PREVENTS: the stale file still exists on disk after the call", fs.existsSync(staleLatchPath));
  check("(s1 clear-by-id on stale hash) the in-memory entry is untouched by this raw, non-matching id clear", !!activeMergeQuarantineFor(subdir));

  // THE CONSEQUENCE, stated directly as the regression a human would actually hit: a GENUINELY FRESH boot
  // (new module instance, reading ONLY the durable files on disk) must still find and re-arm this
  // quarantine — never fail OPEN because a raw clear-by-id silently destroyed its only durable copy.
  const fresh = await freshBootModule();
  const foundAfterRestart = fresh.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s1 restart) THE REGRESSION THIS PREVENTS: a fresh boot still finds this repo's quarantine", foundAfterRestart.some((q) => q.repoPath === subdir));
  const activeAfterRestart = fresh.activeMergeQuarantineFor(subdir);
  check("(s1 restart) THE REGRESSION THIS PREVENTS: the quarantine survives the restart (fails OPEN otherwise)", !!activeAfterRestart);

  try { clearMergeQuarantine(subdir); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 — the SAME defect through a PASS-1b-sourced (`.json.tmp-<pid>` residue) pending latch. A
  // SECOND, separate ownership gap: `clearMergeQuarantineLatchFile`'s raw fallback unconditionally calls
  // `deleteMergeQuarantineTmpResidueForHash`, which sweeps ANY tmp residue for a hash with NO ownership
  // check at all (not even the `orphanLatchFiles` check that protects scenario 1's `.json` shape).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s2");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const staleTmpName = `${staleHash}.json.tmp-424242`; // bare-pid shape PASS 1b's own regex matches
  const staleTmpPath = path.join(MERGE_QUARANTINE_DIR, staleTmpName);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  const manufacturedReason = "scenario 2's own pending tmp-residue latch — must survive a failed graduation write";
  fs.writeFileSync(staleTmpPath, JSON.stringify({
    repoPath: subdir, branch: "pending-tmp-branch", reason: manufacturedReason,
    enteredAt: Date.now(), tokens: ["pending-tmp-token"],
  }, null, 2) + "\n");
  check("(s2 precondition) the pending tmp-residue latch exists on disk", fs.existsSync(staleTmpPath));

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlg-parked-s2-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  check("(s2 moved away) the subdir no longer resolves on disk", !fs.existsSync(subdir));

  const found = reenterMergeQuarantinesAtBoot([subdir]);
  check("(s2 moved away) boot re-entry reports this repo's quarantine (via the PASS-1b pending list)", found.some((q) => q.repoPath === subdir));
  check("(s2 moved away) the tmp-residue file is untouched", fs.existsSync(staleTmpPath));
  const pendingQuery = activeMergeQuarantineFor(subdir);
  check("(s2 moved away) activeMergeQuarantineFor reports it active while still unresolvable, WITHOUT graduating", !!pendingQuery && pendingQuery.reason === manufacturedReason);

  moveRepoRootBack(subdir, parkedRoot);
  check("(s2 restored) the subdir resolves on disk again", fs.existsSync(subdir));

  const inject = injectGraduationWriteFailure(freshHash);
  let activeAfterGraduation;
  try {
    activeAfterGraduation = activeMergeQuarantineFor(subdir); // THE GRADUATION QUERY
  } finally {
    inject.restore();
  }
  check("(s2 graduation attempt) the fresh-key write was actually attempted (and injected to fail)", inject.counter.interceptCount >= 1);
  check("(s2 graduation attempt) the repo still reads as quarantined in-memory despite the failed write", !!activeAfterGraduation);
  check("(s2 graduation attempt) the tmp-residue file is STILL the only durable copy (write failed, nothing deleted)", fs.existsSync(staleTmpPath));
  check("(s2 graduation attempt) no fresh-hash file was actually written (the write genuinely failed)", !fs.existsSync(freshLatchPath));

  // THE ACTUAL BUG (second shape) / FIX TARGET: a raw clear-by-id of the stale hash must keep the
  // tmp-residue file too, exactly like scenario 1's `.json` shape.
  const clearResult = clearMergeQuarantineLatchFile(staleHash);
  check("(s2 clear-by-id on stale hash) call succeeds", clearResult.ok === true);
  check("(s2 clear-by-id on stale hash) THE FIX: reports the file was KEPT, not silently deleted", clearResult.ok === true && clearResult.latchKept === true);
  check("(s2 clear-by-id on stale hash) THE BUG THIS PREVENTS: the tmp-residue file still exists on disk after the call", fs.existsSync(staleTmpPath));

  const fresh = await freshBootModule();
  const foundAfterRestart = fresh.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s2 restart) THE REGRESSION THIS PREVENTS: a fresh boot still finds this repo's quarantine", foundAfterRestart.some((q) => q.repoPath === subdir));
  const activeAfterRestart = fresh.activeMergeQuarantineFor(subdir);
  check("(s2 restart) THE REGRESSION THIS PREVENTS: the quarantine survives the restart (fails OPEN otherwise)", !!activeAfterRestart);

  try { clearMergeQuarantine(subdir); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 (DANGLING-ORPHAN-STRIPPED-ON-SUCCESSFUL-GRADUATION, a6fa60e2 scenario 3's own analogue) —
  // a pending entry's OWN persisted content already names its own (about-to-be-superseded) filename in
  // orphanLatchFiles (simulating "picked this up from an earlier failed graduation in this same process"
  // without needing a two-step fail-then-succeed dance). Once the graduation write SUCCEEDS this time, the
  // dangling self-reference must be stripped — not left to falsely "protect" a now-deleted file forever.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s3");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const staleFilename = `${staleHash}.json`;
  const staleLatchPath = path.join(MERGE_QUARANTINE_DIR, staleFilename);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);
  const manufacturedReason = "scenario 3's own pending latch — migrate succeeds, dangling self-reference must be stripped";
  fs.writeFileSync(staleLatchPath, JSON.stringify({
    repoPath: subdir, branch: "pending-branch-3", reason: manufacturedReason,
    enteredAt: Date.now(), tokens: ["pending-token-3"], orphanLatchFiles: [staleFilename],
  }, null, 2) + "\n");
  check("(s3 precondition) the pending latch (with a self-referencing orphanLatchFiles entry) exists", fs.existsSync(staleLatchPath));

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlg-parked-s3-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  reenterMergeQuarantinesAtBoot([subdir]);
  moveRepoRootBack(subdir, parkedRoot);
  check("(s3 restored) the subdir resolves on disk again", fs.existsSync(subdir));

  // No write-failure injection this time — the graduation write must succeed normally.
  const activeAfterGraduation = activeMergeQuarantineFor(subdir); // THE GRADUATION QUERY
  check("(s3 after graduation) the migrate succeeded — fresh file exists, stale file is gone", fs.existsSync(freshLatchPath) && !fs.existsSync(staleLatchPath));
  check("(s3 after graduation) THE FIX: the in-memory entry no longer lists the now-deleted stale filename", !activeAfterGraduation?.orphanLatchFiles?.includes(staleFilename));
  const persisted = JSON.parse(fs.readFileSync(freshLatchPath, "utf8"));
  check("(s3 after graduation) THE FIX: the PERSISTED entry doesn't list it either (not just in-memory)", !(persisted.orphanLatchFiles ?? []).includes(staleFilename));

  try { clearMergeQuarantine(subdir); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 6 (MAJOR, Code Review eccb3d10) — TWO pending entries share the exact same hash (two tmp
  // residues for ONE repo). ⚠️ UPDATED for card 188b145f: the reviewer's OTHER finding here — that only
  // ONE of several same-hash pending entries ever graduated in one query, leaving the rest stuck pending
  // forever — was real and went to a separate, already-filed follow-up card; 188b145f CLOSED it
  // (`activeMergeQuarantineFor` now graduates EVERY identity-matching pending entry together). So this
  // scenario's own premise changed: there is no longer an "OTHER, still-pending" entry left behind for a
  // raw clear-by-id to separately match-and-delete — a failed write now folds BOTH tmps into the ONE
  // graduated entry's own `orphanLatchFiles`. What this scenario still proves, generalized: a raw
  // clear-by-id of the shared stale hash must KEEP BOTH tmps, not just whichever single one an
  // older, single-entry-only ownership fix would have folded in.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s6");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const tmp1Name = `${staleHash}.json.tmp-111111`;
  const tmp2Name = `${staleHash}.json.tmp-222222`;
  const tmp1Path = path.join(MERGE_QUARANTINE_DIR, tmp1Name);
  const tmp2Path = path.join(MERGE_QUARANTINE_DIR, tmp2Name);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  fs.writeFileSync(tmp1Path, JSON.stringify({
    repoPath: subdir, branch: "s6-tmp1-branch", reason: "s6 tmp1 — one of two same-hash pending tmps for this repo",
    enteredAt: Date.now(), tokens: ["s6-tmp1-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmp2Path, JSON.stringify({
    repoPath: subdir, branch: "s6-tmp2-branch", reason: "s6 tmp2 — the other of two same-hash pending tmps for this repo",
    enteredAt: Date.now(), tokens: ["s6-tmp2-token"],
  }, null, 2) + "\n");
  check("(s6 precondition) both same-hash pending tmp residues exist", fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlg-parked-s6-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  const found = reenterMergeQuarantinesAtBoot([subdir]);
  check("(s6 moved away) boot re-entry reports this repo's quarantine", found.some((q) => q.repoPath === subdir));
  check("(s6 moved away) both tmp files are untouched (no clean .json final exists to trigger the stale-residue-beside-a-good-final branch)", fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));

  moveRepoRootBack(subdir, parkedRoot);
  check("(s6 restored) the subdir resolves on disk again", fs.existsSync(subdir));

  const inject = injectGraduationWriteFailure(freshHash);
  let activeAfterGraduation;
  try {
    activeAfterGraduation = activeMergeQuarantineFor(subdir); // graduates BOTH same-repo pending entries together (card 188b145f)
  } finally {
    inject.restore();
  }
  check("(s6 graduation attempt) the fresh-key write was actually attempted (and injected to fail)", inject.counter.interceptCount >= 1);
  check("(s6 graduation attempt) the repo still reads as quarantined in-memory despite the failed write", !!activeAfterGraduation);

  check("(s6 graduation attempt) THE FIX (card 188b145f): BOTH tmps are folded in as the graduated entry's own stale sources", (activeAfterGraduation?.orphanLatchFiles ?? []).includes(tmp1Name) && (activeAfterGraduation?.orphanLatchFiles ?? []).includes(tmp2Name));
  check("(s6 graduation attempt) both tmps are STILL the only durable copies (write failed, nothing deleted)", fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));
  check("(s6 graduation attempt) no fresh-hash file was actually written (the write genuinely failed)", !fs.existsSync(freshLatchPath));

  // THE MAJOR FIX, generalized by card 188b145f: clearing by the shared stale hash must KEEP BOTH tmps —
  // both are genuinely owned by the ONE surviving (unioned) entry now, not just whichever single tmp an
  // older, single-entry-only ownership fix would have folded in.
  const clearResult = clearMergeQuarantineLatchFile(staleHash);
  check("(s6 clear-by-id on shared stale hash) call succeeds", clearResult.ok === true);
  check("(s6 clear-by-id on shared stale hash) 188b145f round 2: wasQuarantined===false — this now hits the RAW FALLBACK branch, never the PENDING-MATCH one (nothing is independently pending any more)", clearResult.wasQuarantined === false);
  check("(s6 clear-by-id on shared stale hash) THE MAJOR FIX: BOTH tmps survive — neither is an independent pending entry left to match-and-delete any more", fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));
  check("(s6 clear-by-id on shared stale hash) THE MAJOR FIX: reports the surviving file(s) as KEPT", clearResult.latchKept === true);

  const fresh = await freshBootModule();
  const foundAfterRestart = fresh.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s6 restart) THE REGRESSION THIS PREVENTS: a fresh boot still finds this repo's quarantine", foundAfterRestart.some((q) => q.repoPath === subdir));
  check("(s6 restart) THE REGRESSION THIS PREVENTS: the quarantine survives the restart (fails OPEN otherwise)", !!fresh.activeMergeQuarantineFor(subdir));

  try { clearMergeQuarantine(subdir); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 7 (MAJOR, `.json`-final analogue of scenario 6) — TWO INDEPENDENT repos happen to
  // reference/own the exact SAME hash (no real SHA-256 collision needed — 9cabd143's own point: a
  // filename is just a string). repoG graduates from a `.json`-shaped pending source whose write FAILS
  // (orphanLatchFiles=[sharedHash.json]); a WHOLLY UNRELATED repoP separately holds a pending `.tmp-<pid>`
  // entry sharing that exact hash prefix. Clearing by that shared hash matches only repoP's pending tmp —
  // but the belt-and-suspenders `${id}.json` sweep used to be gated on OWNERSHIP ALONE (check 2), which
  // repoG's entry does not satisfy (it's armed under repoG's own real fresh key, not the shared hash).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const repoG = makeSubdirRepo("s7g");
  const repoP = makeSubdirRepo("s7p");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const sharedHash = createHash("sha256").update(`s7-shared-hash-${freshSfx()}`).digest("hex").slice(0, 24);
  const sharedJsonPath = path.join(MERGE_QUARANTINE_DIR, `${sharedHash}.json`);
  const sharedTmpName = `${sharedHash}.json.tmp-333333`;
  const sharedTmpPath = path.join(MERGE_QUARANTINE_DIR, sharedTmpName);
  const freshHashG = quarantineLatchIdFor(repoG);
  const freshLatchPathG = path.join(MERGE_QUARANTINE_DIR, `${freshHashG}.json`);

  fs.writeFileSync(sharedJsonPath, JSON.stringify({
    repoPath: repoG, branch: "s7-g-branch", reason: "s7 repoG's own pending .json source, filed under the shared hash",
    enteredAt: Date.now(), tokens: ["s7-g-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(sharedTmpPath, JSON.stringify({
    repoPath: repoP, branch: "s7-p-branch", reason: "s7 repoP's own pending tmp source — unrelated to repoG, shares only the hash prefix",
    enteredAt: Date.now(), tokens: ["s7-p-token"],
  }, null, 2) + "\n");

  const parkedRootG = path.join(os.tmpdir(), `loom-mqlg-parked-s7g-${freshSfx()}`);
  const parkedRootP = path.join(os.tmpdir(), `loom-mqlg-parked-s7p-${freshSfx()}`);
  moveRepoRootAway(repoG, parkedRootG);
  moveRepoRootAway(repoP, parkedRootP);
  reenterMergeQuarantinesAtBoot([repoG, repoP]);

  moveRepoRootBack(repoG, parkedRootG);
  // repoP deliberately stays absent — only repoG's graduation and the clear-by-id call matter here.

  const inject = injectGraduationWriteFailure(freshHashG);
  let activeAfterGraduation;
  try {
    activeAfterGraduation = activeMergeQuarantineFor(repoG); // graduates repoG; write FAILS
  } finally {
    inject.restore();
  }
  check("(s7 graduation) repoG's fresh-key write was actually attempted (and injected to fail)", inject.counter.interceptCount >= 1);
  check("(s7 graduation) repoG still reads as quarantined in-memory despite the failed write", !!activeAfterGraduation);
  check("(s7 graduation) repoG's orphanLatchFiles now protects the shared-hash .json file", !!activeAfterGraduation?.orphanLatchFiles?.includes(`${sharedHash}.json`));
  check("(s7 graduation) the shared .json file is STILL the only durable copy (write failed, nothing deleted)", fs.existsSync(sharedJsonPath));
  check("(s7 graduation) no fresh-hash file was actually written for repoG (the write genuinely failed)", !fs.existsSync(freshLatchPathG));

  // THE MAJOR BUG (`.json` variant): clearing by the shared hash matches ONLY repoP's unrelated pending
  // tmp entry — never repoG's entry at all — yet the belt-and-suspenders `.json` sweep used to delete
  // `${sharedHash}.json` on ownership alone, destroying repoG's only durable copy.
  const clearResult = clearMergeQuarantineLatchFile(sharedHash);
  check("(s7 clear-by-id on shared hash) call succeeds", clearResult.ok === true);
  check("(s7 clear-by-id on shared hash) wasQuarantined===true — this hits the PENDING-MATCH branch (repoP's own pending entry was actually matched and removed)", clearResult.wasQuarantined === true);
  check("(s7 clear-by-id on shared hash) repoP's own (matched) tmp entry is deleted (its own file, correctly)", !fs.existsSync(sharedTmpPath));
  check("(s7 clear-by-id on shared hash) THE MAJOR FIX: repoG's shared .json file — never matched by this clear — survives", fs.existsSync(sharedJsonPath));
  check("(s7 clear-by-id on shared hash) THE MAJOR FIX: reports the surviving file as KEPT", clearResult.latchKept === true);

  const fresh = await freshBootModule();
  const foundAfterRestart = fresh.reenterMergeQuarantinesAtBoot([repoG]);
  check("(s7 restart) THE REGRESSION THIS PREVENTS: a fresh boot still finds repoG's quarantine", foundAfterRestart.some((q) => q.repoPath === repoG));
  check("(s7 restart) THE REGRESSION THIS PREVENTS: repoG's quarantine survives the restart (fails OPEN otherwise)", !!fresh.activeMergeQuarantineFor(repoG));

  try { clearMergeQuarantine(repoG); } catch { /* best-effort cleanup */ }
  try { clearMergeQuarantine(repoP); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 4 (MAJOR, Delta Code Review bd812c95, round 3) — `clearMergeQuarantineByKey`'s own
  // tmp-residue sweep (via `deleteMergeQuarantineLatchByKey`) used to delete EVERY tmp sharing the
  // CLEARED entry's hash UNCONDITIONALLY — including a DIFFERENT, SURVIVING entry's own protected
  // residue, destroying ITS only durable copy and silently failing it OPEN on the next restart. The
  // round-2 version of this scenario mistakenly asserted THAT destruction as a correct "negative
  // control" — it was the same bug this card exists to close, reached through a THIRD call site.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const repoA = makeToplevelRepo("s4a");
  const repoB = makeToplevelRepo("s4b");
  enterMergeQuarantine(repoA, "branch-s4a", "scenario 4 — repoA, the entry actually being cleared");
  const hashA = quarantineLatchIdFor(repoA);

  // repoB is a SEPARATE, SURVIVING entry whose own orphanLatchFiles references a tmp filed under repoA's
  // OWN hash prefix — manufactured via the same failed-graduation technique as scenarios 6/7.
  const refdTmpName = `${hashA}.json.tmp-999999`;
  const refdTmpPath = path.join(MERGE_QUARANTINE_DIR, refdTmpName);
  fs.writeFileSync(refdTmpPath, JSON.stringify({
    repoPath: repoB, branch: "s4-b-branch", reason: "scenario 4 — repoB's own pending tmp source, filed under repoA's hash prefix",
    enteredAt: Date.now(), tokens: ["s4-b-token"],
  }, null, 2) + "\n");
  const parkedRootB = path.join(os.tmpdir(), `loom-mqlg-top-parked-s4b-${freshSfx()}`);
  fs.renameSync(repoB, parkedRootB);
  reenterMergeQuarantinesAtBoot([repoB]);
  fs.renameSync(parkedRootB, repoB);

  const freshHashB = quarantineLatchIdFor(repoB);
  const inject = injectGraduationWriteFailure(freshHashB);
  let activeB;
  try {
    activeB = activeMergeQuarantineFor(repoB); // graduates repoB; write FAILS; orphanLatchFiles=[refdTmpName]
  } finally {
    inject.restore();
  }
  check("(s4 precondition) repoB's graduation write was injected to fail", inject.counter.interceptCount >= 1);
  check("(s4 precondition) repoB now references the REFERENCED tmp under repoA's hash prefix", !!activeB?.orphanLatchFiles?.includes(refdTmpName));
  check("(s4 precondition) the referenced tmp residue genuinely still exists", fs.existsSync(refdTmpPath));
  check("(s4 precondition) repoB's own fresh-hash final was never written (the write genuinely failed)", !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, `${freshHashB}.json`)));

  // repoA's OWN unreferenced leftover tmp residue (e.g. an earlier interrupted write) — nothing's
  // orphanLatchFiles names it. Created NOW, right before the act under test — any earlier (e.g. before
  // repoB's own `reenterMergeQuarantinesAtBoot` above) and PASS 2's fail-closed orphan-fanout would catch
  // it as an unmatched corrupt tmp during repoB's OWN boot re-entry, clobbering repoB's setup entirely.
  const ownUnrefTmpPath = path.join(MERGE_QUARANTINE_DIR, `${hashA}.json.tmp-555555`);
  fs.writeFileSync(ownUnrefTmpPath, "{}");
  check("(s4 precondition) repoA's own unreferenced leftover tmp exists", fs.existsSync(ownUnrefTmpPath));

  // THE MAJOR FIX: clearing repoA — a DIFFERENT entry than the one that references this tmp — must KEEP
  // it (reference-aware, same helper scenarios 6/7 already prove), while still sweeping repoA's OWN
  // unreferenced residue (the negative control).
  clearMergeQuarantine(repoA);
  check("(s4) THE MAJOR FIX (expected RED pre-round-3): a legitimate clear of a DIFFERENT entry KEEPS a tmp a surviving entry still references", fs.existsSync(refdTmpPath));
  check("(s4) NEGATIVE CONTROL: the cleared entry's OWN unreferenced residue is still swept", !fs.existsSync(ownUnrefTmpPath));

  // THE REGRESSION THIS PREVENTS: a fresh boot must still find repoB's quarantine — pre-round-3, repoA's
  // own clear destroyed repoB's only durable copy and repoB silently failed OPEN on the next restart.
  const fresh = await freshBootModule();
  const foundAfterRestart = fresh.reenterMergeQuarantinesAtBoot([repoB]);
  check("(s4 restart) THE REGRESSION THIS PREVENTS (expected RED pre-round-3): a fresh boot still finds repoB's quarantine", foundAfterRestart.some((q) => q.repoPath === repoB));
  check("(s4 restart) THE REGRESSION THIS PREVENTS (expected RED pre-round-3): repoB's quarantine survives the restart (fails OPEN otherwise)", !!fresh.activeMergeQuarantineFor(repoB));

  try { clearMergeQuarantine(repoB); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 5 (MAJOR, Delta Code Review bd812c95, round 3) — the SAME shape as scenario 4, through
  // `writeMergeQuarantineLatch`'s `sweepOtherTmpsOnSuccess:true` (every existing-entry re-raise goes
  // through this) instead of a legitimate clear.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const repoC = makeToplevelRepo("s5c");
  const repoD = makeToplevelRepo("s5d");
  enterMergeQuarantine(repoC, "branch-s5c-first", "scenario 5 — repoC, first raise");
  const hashC = quarantineLatchIdFor(repoC);

  const refdTmpName = `${hashC}.json.tmp-121212`;
  const refdTmpPath = path.join(MERGE_QUARANTINE_DIR, refdTmpName);
  fs.writeFileSync(refdTmpPath, JSON.stringify({
    repoPath: repoD, branch: "s5-d-branch", reason: "scenario 5 — repoD's own pending tmp source, filed under repoC's hash prefix",
    enteredAt: Date.now(), tokens: ["s5-d-token"],
  }, null, 2) + "\n");
  const parkedRootD = path.join(os.tmpdir(), `loom-mqlg-top-parked-s5d-${freshSfx()}`);
  fs.renameSync(repoD, parkedRootD);
  reenterMergeQuarantinesAtBoot([repoD]);
  fs.renameSync(parkedRootD, repoD);

  const freshHashD = quarantineLatchIdFor(repoD);
  const inject = injectGraduationWriteFailure(freshHashD);
  let activeD;
  try {
    activeD = activeMergeQuarantineFor(repoD);
  } finally {
    inject.restore();
  }
  check("(s5 precondition) repoD's graduation write was injected to fail", inject.counter.interceptCount >= 1);
  check("(s5 precondition) repoD now references the REFERENCED tmp under repoC's hash prefix", !!activeD?.orphanLatchFiles?.includes(refdTmpName));
  check("(s5 precondition) the referenced tmp residue genuinely still exists", fs.existsSync(refdTmpPath));

  // repoC's OWN unreferenced leftover tmp — created NOW, right before the act under test, for the same
  // reason as scenario 4's own fixture (see its comment): any earlier and repoD's OWN boot re-entry
  // above would catch it as an unmatched corrupt tmp via PASS 2's fail-closed fanout.
  const ownUnrefTmpPath = path.join(MERGE_QUARANTINE_DIR, `${hashC}.json.tmp-333222`);
  fs.writeFileSync(ownUnrefTmpPath, "{}");
  check("(s5 precondition) repoC's own unreferenced leftover tmp exists", fs.existsSync(ownUnrefTmpPath));

  // THE MAJOR FIX: a SECOND raise on repoC (already quarantined) hits enterMergeQuarantine's "existing"
  // branch, calling writeMergeQuarantineLatch(entry, true) -> sweepOtherTmpsOnSuccess:true — this must
  // KEEP repoD's still-referenced tmp while still sweeping repoC's OWN unreferenced residue.
  enterMergeQuarantine(repoC, "branch-s5c-second", "scenario 5 — repoC, second raise, triggers sweepOtherTmpsOnSuccess");
  check("(s5) THE MAJOR FIX (expected RED pre-round-3): sweepOtherTmpsOnSuccess KEEPS a tmp a surviving entry still references", fs.existsSync(refdTmpPath));
  check("(s5) NEGATIVE CONTROL: repoC's OWN unreferenced residue is still swept", !fs.existsSync(ownUnrefTmpPath));

  // THE REGRESSION THIS PREVENTS: a fresh boot must still find repoD's quarantine.
  const fresh = await freshBootModule();
  const foundAfterRestart = fresh.reenterMergeQuarantinesAtBoot([repoD]);
  check("(s5 restart) THE REGRESSION THIS PREVENTS (expected RED pre-round-3): a fresh boot still finds repoD's quarantine", foundAfterRestart.some((q) => q.repoPath === repoD));
  check("(s5 restart) THE REGRESSION THIS PREVENTS (expected RED pre-round-3): repoD's quarantine survives the restart (fails OPEN otherwise)", !!fresh.activeMergeQuarantineFor(repoD));

  try { clearMergeQuarantine(repoC); } catch { /* best-effort cleanup */ }
  try { clearMergeQuarantine(repoD); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 8 (MAJOR, Delta Code Review 18485645, round 4) — the SAME shape as scenarios 4/5, through
  // `clearMergeQuarantineByToken`'s own PARTIAL-clear branch (a reduced-but-still-outstanding token set)
  // — the ONE remaining caller of the unconditional `deleteMergeQuarantineTmpResidue*` chain rounds 1-3
  // deliberately left alone as an out-of-scope residual. The reviewer reproduced it as real, so it's
  // closed here instead of deferred further.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const repoA = makeToplevelRepo("s8a");
  const repoB = makeToplevelRepo("s8b");
  const tA1 = enterMergeQuarantine(repoA, "branch-s8a-1", "scenario 8 — repoA, first outstanding token");
  const tA2 = enterMergeQuarantine(repoA, "branch-s8a-2", "scenario 8 — repoA, second outstanding token");
  const hashA = quarantineLatchIdFor(repoA);

  // repoB is a SEPARATE, SURVIVING entry whose own orphanLatchFiles references a tmp filed under repoA's
  // OWN hash prefix — same failed-graduation technique as scenarios 4-7.
  const refdTmpName = `${hashA}.json.tmp-818181`;
  const refdTmpPath = path.join(MERGE_QUARANTINE_DIR, refdTmpName);
  fs.writeFileSync(refdTmpPath, JSON.stringify({
    repoPath: repoB, branch: "s8-b-branch", reason: "scenario 8 — repoB's own pending tmp source, filed under repoA's hash prefix",
    enteredAt: Date.now(), tokens: ["s8-b-token"],
  }, null, 2) + "\n");
  const parkedRootB = path.join(os.tmpdir(), `loom-mqlg-top-parked-s8b-${freshSfx()}`);
  fs.renameSync(repoB, parkedRootB);
  reenterMergeQuarantinesAtBoot([repoB]);
  fs.renameSync(parkedRootB, repoB);

  const freshHashB = quarantineLatchIdFor(repoB);
  const inject = injectGraduationWriteFailure(freshHashB);
  let activeB;
  try {
    activeB = activeMergeQuarantineFor(repoB); // graduates repoB; write FAILS; orphanLatchFiles=[refdTmpName]
  } finally {
    inject.restore();
  }
  check("(s8 precondition) repoB's graduation write was injected to fail", inject.counter.interceptCount >= 1);
  check("(s8 precondition) repoB now references the REFERENCED tmp under repoA's hash prefix", !!activeB?.orphanLatchFiles?.includes(refdTmpName));
  check("(s8 precondition) the referenced tmp residue genuinely still exists", fs.existsSync(refdTmpPath));

  // THE MAJOR FIX: a PARTIAL clear of repoA (tA1 cleared, tA2 still outstanding — repoA itself stays
  // quarantined) must KEEP repoB's referenced tmp, exactly like scenarios 4/5's full-clear/superseding
  // writes.
  clearMergeQuarantineByToken(repoA, tA1);
  check("(s8) repoA stays quarantined (tA2 is still outstanding)", !!activeMergeQuarantineFor(repoA));
  check("(s8) THE MAJOR FIX (expected RED pre-round-4): a partial clear of repoA KEEPS a tmp repoB still references", fs.existsSync(refdTmpPath));

  // THE REGRESSION THIS PREVENTS: a fresh boot must still find repoB's quarantine.
  const fresh = await freshBootModule();
  const foundAfterRestart = fresh.reenterMergeQuarantinesAtBoot([repoB]);
  check("(s8 restart) THE REGRESSION THIS PREVENTS (expected RED pre-round-4): a fresh boot still finds repoB's quarantine", foundAfterRestart.some((q) => q.repoPath === repoB));
  check("(s8 restart) THE REGRESSION THIS PREVENTS (expected RED pre-round-4): repoB's quarantine survives the restart (fails OPEN otherwise)", !!fresh.activeMergeQuarantineFor(repoB));

  try { clearMergeQuarantineByToken(repoA, tA2); } catch { /* best-effort cleanup */ }
  try { clearMergeQuarantine(repoB); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 9 (added for card 188b145f round 2, Code Reviewer 638ee0bc) — SCENARIO 7's `.tmp-`-sourced
  // twin. Card 188b145f's own fix moved SCENARIO 6 off the PENDING-MATCH branch entirely (see its own
  // updated comment above), which left the belt-and-suspenders TMP sweep at line ~951
  // (`sweepTmpResidueForHashIfUnreferenced(id)`, reached from the PENDING-MATCH branch specifically) with
  // no test that can still go RED against it — reverting that one line to the unconditional
  // `deleteMergeQuarantineTmpResidueForHash(id)` left all 15 merge-quarantine*.mjs files green. This
  // scenario restores that coverage: repoG graduates from its OWN `.json.tmp-*` pending source with a
  // FAILED write (folding that tmp into its own orphanLatchFiles), while repoP — a wholly unrelated repo —
  // stays genuinely PENDING on its OWN `.json.tmp-*` source sharing the EXACT SAME hash prefix (no real
  // SHA-256 collision needed — 9cabd143's own point). Clearing by that shared hash matches ONLY repoP's
  // still-pending entry (never repoG's, which is armed under its own real fresh key) — provably hitting
  // the PENDING-MATCH branch (`wasQuarantined===true`), never the raw fallback. repoP's own tmp is deleted
  // (its own file, correctly); repoG's referenced tmp — never matched by this clear at all — must survive
  // line ~951's own sweep.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const repoG = makeSubdirRepo("s9g");
  const repoP = makeSubdirRepo("s9p");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const sharedHash = createHash("sha256").update(`s9-shared-hash-${freshSfx()}`).digest("hex").slice(0, 24);
  const tmpGName = `${sharedHash}.json.tmp-616161`;
  const tmpPName = `${sharedHash}.json.tmp-626262`;
  const tmpGPath = path.join(MERGE_QUARANTINE_DIR, tmpGName);
  const tmpPPath = path.join(MERGE_QUARANTINE_DIR, tmpPName);
  const freshHashG = quarantineLatchIdFor(repoG);
  const freshLatchPathG = path.join(MERGE_QUARANTINE_DIR, `${freshHashG}.json`);

  fs.writeFileSync(tmpGPath, JSON.stringify({
    repoPath: repoG, branch: "s9-g-branch", reason: "s9 repoG's own pending tmp source, filed under the shared hash",
    enteredAt: Date.now(), tokens: ["s9-g-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmpPPath, JSON.stringify({
    repoPath: repoP, branch: "s9-p-branch", reason: "s9 repoP's own pending tmp source — unrelated to repoG, shares only the hash prefix",
    enteredAt: Date.now(), tokens: ["s9-p-token"],
  }, null, 2) + "\n");

  const parkedRootG = path.join(os.tmpdir(), `loom-mqlg-parked-s9g-${freshSfx()}`);
  const parkedRootP = path.join(os.tmpdir(), `loom-mqlg-parked-s9p-${freshSfx()}`);
  moveRepoRootAway(repoG, parkedRootG);
  moveRepoRootAway(repoP, parkedRootP);
  reenterMergeQuarantinesAtBoot([repoG, repoP]);

  moveRepoRootBack(repoG, parkedRootG);
  // repoP deliberately stays absent — it must remain genuinely PENDING (never graduated) for this
  // scenario's own premise: the clear-by-id below must match it via the PENDING-MATCH branch.

  const inject = injectGraduationWriteFailure(freshHashG);
  let activeAfterGraduation;
  try {
    activeAfterGraduation = activeMergeQuarantineFor(repoG); // graduates repoG; write FAILS
  } finally {
    inject.restore();
  }
  check("(s9 graduation) repoG's fresh-key write was actually attempted (and injected to fail)", inject.counter.interceptCount >= 1);
  check("(s9 graduation) repoG still reads as quarantined in-memory despite the failed write", !!activeAfterGraduation);
  check("(s9 graduation) repoG's orphanLatchFiles now protects its own tmp under the shared hash", !!activeAfterGraduation?.orphanLatchFiles?.includes(tmpGName));
  check("(s9 graduation) repoG's own tmp is STILL the only durable copy (write failed, nothing deleted)", fs.existsSync(tmpGPath));
  check("(s9 graduation) no fresh-hash file was actually written for repoG (the write genuinely failed)", !fs.existsSync(freshLatchPathG));
  check("(s9 precondition) repoP's own pending tmp still exists, genuinely pending (never graduated)", fs.existsSync(tmpPPath));

  // THE FIX THIS RESTORES COVERAGE FOR: clearing by the shared hash matches ONLY repoP's still-pending
  // entry (via the PENDING-MATCH branch) — never repoG's, which is armed under its own real fresh key.
  // That branch's own belt-and-suspenders TMP sweep (line ~951, sweepTmpResidueForHashIfUnreferenced) must
  // KEEP repoG's referenced tmp; the pre-188b145f-round-2 unconditional sibling would have deleted it too.
  const clearResult = clearMergeQuarantineLatchFile(sharedHash);
  check("(s9 clear-by-id on shared hash) call succeeds", clearResult.ok === true);
  check("(s9 clear-by-id on shared hash) wasQuarantined===true — PROVABLY hits the PENDING-MATCH branch (repoP's own pending entry was actually matched and removed)", clearResult.wasQuarantined === true);
  check("(s9 clear-by-id on shared hash) repoP's own (matched) tmp is deleted (its own file, correctly)", !fs.existsSync(tmpPPath));
  check("(s9 clear-by-id on shared hash) THE FIX: repoG's referenced tmp — never matched by this clear — survives the PENDING-MATCH branch's own belt-and-suspenders tmp sweep", fs.existsSync(tmpGPath));
  check("(s9 clear-by-id on shared hash) THE FIX: reports the surviving file as KEPT", clearResult.latchKept === true);

  const fresh = await freshBootModule();
  const foundAfterRestart = fresh.reenterMergeQuarantinesAtBoot([repoG]);
  check("(s9 restart) THE REGRESSION THIS PREVENTS: a fresh boot still finds repoG's quarantine", foundAfterRestart.some((q) => q.repoPath === repoG));
  check("(s9 restart) THE REGRESSION THIS PREVENTS: repoG's quarantine survives the restart (fails OPEN otherwise)", !!fresh.activeMergeQuarantineFor(repoG));

  try { clearMergeQuarantine(repoG); } catch { /* best-effort cleanup */ }
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a lazily-graduated pending quarantine's stale source file (`.json` final or " +
    "`.json.tmp-<pid>` residue alike) is tracked as owned by its still-active entry when the graduation " +
    "write fails, so a raw clear-by-id of its stale hash keeps it and the quarantine survives a restart " +
    "via the RAW-FALLBACK branch (scenarios 1-2, and — since card 188b145f — scenario 6, where every one " +
    "of a repo's OWN same-hash pending entries now graduates together leaving nothing independently " +
    "pending) and via the PENDING-MATCH branch's own belt-and-suspenders sweep, whether that match is a " +
    "cross-repo hash collision on a `.json` final (scenario 7) or its `.tmp-`-sourced twin (scenario 9); " +
    "a graduation that SUCCEEDS strips a dangling self-reference instead " +
    "of leaving one behind (scenario 3); and a legitimate clear / a successful sweepOtherTmpsOnSuccess " +
    "write both KEEP a tmp residue a DIFFERENT, surviving entry still references, while still sweeping " +
    "the cleared/superseded entry's OWN unreferenced residue (scenarios 4-5, round 3); and a PARTIAL " +
    "clear (an entry with more than one outstanding token) does the same (scenario 8, round 4)."
  : `\n❌ ${failures} FAILURE(S) — reproduces board card be79f4d5.`);
process.exit(failures === 0 ? 0 : 1);
