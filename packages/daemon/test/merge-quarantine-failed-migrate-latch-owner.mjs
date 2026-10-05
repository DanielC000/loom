import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card a6fa60e2 (discovered from 9cabd143 / Code Review d37fd1aa of 9cabd143): in
// reenterMergeQuarantinesAtBoot's PASS 1 failed-migrate branch (git/merge-quarantine.ts), a stale-key
// latch whose MIGRATE write fails leaves its ONLY durable copy at its OLD filename `f` — a hash that is
// NOT the hash of any key this entry is armed under, and not `quarantinePathFor(repoPath)` either. Before
// this fix, nothing tracked `f` as owned by the (still fully active, in-memory) entry, so a raw
// clear-by-id of that hash (the boot log names `f`; the list route doesn't hand it out) deleted the file
// outright via the orphan-sweep fallback — the quarantine then fails OPEN on the next restart, since
// there is no durable copy left for PASS 1 to re-arm from.
//
// THE FIX: PASS 1's failed-migrate branch now folds `f` into the entry's own `orphanLatchFiles` — the
// SAME owner-bookkeeping field the rest of this module already uses for "a filename a live entry still
// needs, even though it isn't the entry's current physical write target" — so
// `sweepOrphanLatchFileIfUnreferenced`'s check (1) (an entry's own `orphanLatchFiles` still lists this
// filename) keeps it alive against a raw clear-by-id, while a LEGITIMATE clear of the entry itself still
// sweeps it away (clearMergeQuarantineByKey folds `orphanLatchFiles` into its own sweep).
//
// Code Review `4d619c1f` round 2 added two more scenarios below:
//  - RESURRECTION-ON-LEGITIMATE-CLEAR: the SAME gap this fix closes also broke a LEGITIMATE clear (not
//    just a raw clear-by-id) — pre-fix, `orphanLatchFiles` never named `f`, so a real `clearMergeQuarantine`
//    call never reached/deleted it either, and a FRESH BOOT resurrected a quarantine a human had genuinely
//    cleared. See docs/decisions/a6fa60e2-failed-migrate-latch-ownership.md's "second consequence" section.
//  - DANGLING-ORPHAN-STRIPPED-ON-SUCCESSFUL-MIGRATE: folding `f` in created a narrower follow-up gap — PASS
//    1's SUCCESSFUL-migrate branch deletes `f` from disk but must also strip it from `orphanLatchFiles`, or
//    a dangling reference to a now-nonexistent file falsely "protects" any future, unrelated file reusing
//    that name. See the same decision record's "dangling-reference follow-up" section.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-failed-migrate-latch-owner.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqfm-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantine, clearMergeQuarantineLatchFile, activeMergeQuarantineFor,
  reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR, quarantineLatchIdFor,
} = await import(mergeQuarantineModuleHref);

// A genuinely fresh ESM module instance (its OWN empty activeQuarantines map) to prove the "survives a
// restart" half — Node's loader keys its module cache on the full URL including the query string, so each
// call here gets its own instance of the SAME file, never reused (same technique as
// merge-quarantine-pass1b-clean-parse-gate.mjs).
let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqfm@loom -c user.name=mqfm";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Reproduces the OLD (pre-7673d096) key algorithm by hand: realpath + lowercase-on-win32 of the BOUND
// path directly, with no toplevel walk — exactly what `canonicalRepoLockKey` used to compute, and exactly
// the shape a pre-upgrade latch (or any other stale-key latch) is filed under.
function oldHashFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// A fresh subdir-bound repo (no .git of its own) — every scenario needs its own, so the stale/fresh
// hashes of one scenario never collide with another's.
function makeSubdirRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqfm-repo-${tag}-${freshSfx()}`);
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-failed-migrate-latch-owner (${tag})\n`);
  execSync(`git init -q && git config user.email mqfm@loom && git config user.name mqfm`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return subdir;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 — a raw clear-by-id of a failed-migrate latch's STALE hash must KEEP it, not delete it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s1");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const staleLatchPath = path.join(MERGE_QUARANTINE_DIR, `${staleHash}.json`);
  const freshHash = quarantineLatchIdFor(subdir); // the CURRENT (toplevel-walked) key's hash
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);
  check("(precondition) stale and fresh hashes actually differ (this repo is subdir-bound)", staleHash !== freshHash);

  const manufacturedReason = "the REAL reason for this stale-key latch — must survive a failed migrate";
  const entryContent = {
    repoPath: subdir, branch: "stale-key-branch", reason: manufacturedReason,
    enteredAt: Date.now(), tokens: ["stale-key-token"],
  };
  fs.writeFileSync(staleLatchPath, JSON.stringify(entryContent, null, 2) + "\n");
  check("(precondition) the stale old-key latch file exists on disk", fs.existsSync(staleLatchPath));
  check("(precondition) in-memory map is empty (simulating a fresh boot)", !activeMergeQuarantineFor(subdir));

  // Force PASS 1's migrate WRITE to fail — intercept the open of the NEW tmp file the migrate attempt
  // creates under the fresh hash, exactly the "EMFILE/EACCES-shaped" technique
  // merge-quarantine-pass1b-clean-parse-gate.mjs already uses for the sibling self-heal/promote writes.
  const realOpenSync = fs.openSync;
  let interceptCount = 0;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(freshHash) && p.includes(".tmp-")) {
      interceptCount++;
      throw Object.assign(new Error("EACCES: simulated migrate-write failure"), { code: "EACCES" });
    }
    return realOpenSync(p, ...rest);
  };
  let found;
  try {
    found = reenterMergeQuarantinesAtBoot([subdir]);
  } finally {
    fs.openSync = realOpenSync;
  }

  check("(positive control) the migrate write was actually attempted (and injected to fail)", interceptCount >= 1);
  check("(after failed migrate) boot re-entry still finds this repo's quarantine", found.some((q) => q.repoPath === subdir));
  const activeAfterBoot = activeMergeQuarantineFor(subdir);
  check("(after failed migrate) the repo reads as quarantined in-memory despite the failed write", !!activeAfterBoot);
  check("(after failed migrate) the real reason carried over (not a fabricated/corrupt-latch reason)", activeAfterBoot?.reason === manufacturedReason);
  check("(after failed migrate) the OLD stale file is STILL the only durable copy (write failed, nothing deleted)", fs.existsSync(staleLatchPath));
  check("(after failed migrate) no fresh-hash file was actually written (the write genuinely failed)", !fs.existsSync(freshLatchPath));

  // THE ACTUAL BUG / FIX TARGET: a raw clear-by-id of the STALE hash (the one the boot-time error log
  // names) must never silently delete this entry's only durable copy — it must be recognized as OWNED by
  // the still-active in-memory entry and KEPT.
  const clearResult = clearMergeQuarantineLatchFile(staleHash);
  check("(clear-by-id on stale hash) call succeeds", clearResult.ok === true);
  check("(clear-by-id on stale hash) THE FIX: reports the file was KEPT, not silently deleted", clearResult.ok === true && clearResult.latchKept === true);
  check(
    "(clear-by-id on stale hash) THE FIX: names the owning repoPath in referencingRepoPaths",
    clearResult.ok === true && Array.isArray(clearResult.referencingRepoPaths) && clearResult.referencingRepoPaths.includes(subdir),
  );
  check("(clear-by-id on stale hash) THE BUG THIS PREVENTS: the stale file still exists on disk after the call", fs.existsSync(staleLatchPath));
  check("(clear-by-id on stale hash) the in-memory entry is untouched by this raw, non-matching id clear", !!activeMergeQuarantineFor(subdir));

  // THE REGRESSION THIS PREVENTS, stated directly: a genuinely FRESH boot (new process/module instance,
  // no openSync injection this time — let the migrate succeed) must still find and re-arm this quarantine
  // from the surviving stale file, never fail OPEN because a raw clear-by-id silently destroyed it.
  const fresh = await freshBootModule();
  const foundAfterRestart = fresh.reenterMergeQuarantinesAtBoot([subdir]);
  check("(restart) THE REGRESSION THIS PREVENTS: a fresh boot still finds this repo's quarantine", foundAfterRestart.some((q) => q.repoPath === subdir));
  const activeAfterRestart = fresh.activeMergeQuarantineFor(subdir);
  check("(restart) the quarantine survives the restart with its real reason intact", activeAfterRestart?.reason === manufacturedReason);
  check("(restart) the migrate now succeeds (no injection this time) — a fresh-hash file now exists", fs.existsSync(freshLatchPath));
  check("(restart) the old stale file is cleaned up once the migrate actually succeeds", !fs.existsSync(staleLatchPath));

  fresh.clearMergeQuarantine(subdir);
  check("(cleanup) a real clear removes the migrated latch", !fresh.activeMergeQuarantineFor(subdir) && !fs.existsSync(freshLatchPath));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 (RESURRECTION-ON-LEGITIMATE-CLEAR, Code Review 4d619c1f) — the SAME gap scenario 1 closes
  // also broke a LEGITIMATE clear, not just a raw clear-by-id: pre-fix, orphanLatchFiles never named the
  // stale file, so clearMergeQuarantine's own orphan sweep never reached it either — it survived on disk,
  // and a FRESH BOOT re-armed a quarantine a human genuinely believed they'd just cleared.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s2");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const staleLatchPath = path.join(MERGE_QUARANTINE_DIR, `${staleHash}.json`);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);
  const manufacturedReason = "scenario 2's own stale-key latch — must not resurrect once legitimately cleared";
  fs.writeFileSync(staleLatchPath, JSON.stringify({
    repoPath: subdir, branch: "stale-key-branch-2", reason: manufacturedReason,
    enteredAt: Date.now(), tokens: ["stale-key-token-2"],
  }, null, 2) + "\n");
  check("(s2 precondition) the stale latch exists, in-memory empty", fs.existsSync(staleLatchPath) && !activeMergeQuarantineFor(subdir));

  const realOpenSync = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(freshHash) && p.includes(".tmp-")) {
      throw Object.assign(new Error("EACCES: simulated migrate-write failure"), { code: "EACCES" });
    }
    return realOpenSync(p, ...rest);
  };
  try {
    reenterMergeQuarantinesAtBoot([subdir]);
  } finally {
    fs.openSync = realOpenSync;
  }
  check("(s2 after failed migrate) active in-memory, stale file is the only durable copy", !!activeMergeQuarantineFor(subdir) && fs.existsSync(staleLatchPath) && !fs.existsSync(freshLatchPath));

  // THE FIX TARGET: a LEGITIMATE, SAME-PROCESS clear (no restart yet) must actually delete the stale file
  // — not just lift the in-memory entry — via its orphanLatchFiles sweep.
  clearMergeQuarantine(subdir);
  check("(s2 legitimate clear) in-memory entry is lifted", !activeMergeQuarantineFor(subdir));
  check("(s2 legitimate clear) THE FIX: the stale file is actually deleted, not left behind", !fs.existsSync(staleLatchPath));

  // THE REGRESSION THIS PREVENTS: a fresh boot after that legitimate clear must NOT resurrect the
  // quarantine — there is nothing left on disk for PASS 1 to re-arm from.
  const fresh2 = await freshBootModule();
  const foundAfterClear = fresh2.reenterMergeQuarantinesAtBoot([subdir]);
  const resurrected = foundAfterClear.some((q) => q.repoPath === subdir) || !!fresh2.activeMergeQuarantineFor(subdir);
  check("(s2 restart) THE REGRESSION THIS PREVENTS: a legitimately-cleared quarantine does NOT resurrect (resurrected === false)", resurrected === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 (DANGLING-ORPHAN-STRIPPED-ON-SUCCESSFUL-MIGRATE, Code Review 4d619c1f) — folding the stale
  // filename into orphanLatchFiles (scenario 1's own fix) must not create a DANGLING reference once a
  // migrate eventually SUCCEEDS: the successful-migrate branch deletes the stale file from disk, and must
  // also strip it from orphanLatchFiles, or a nonexistent filename is "protected" forever.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s3");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const staleFilename = `${staleHash}.json`;
  const staleLatchPath = path.join(MERGE_QUARANTINE_DIR, staleFilename);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);
  const manufacturedReason = "scenario 3's own stale-key latch — migrate succeeds, dangling ref must be stripped";
  // Manufacture the precondition directly: this entry's OWN persisted content already names its own
  // (about-to-be-stale) filename in orphanLatchFiles — simulating "picked this up from an earlier
  // failed-migrate attempt in this same process" without needing a two-step fail-then-succeed dance.
  fs.writeFileSync(staleLatchPath, JSON.stringify({
    repoPath: subdir, branch: "stale-key-branch-3", reason: manufacturedReason,
    enteredAt: Date.now(), tokens: ["stale-key-token-3"], orphanLatchFiles: [staleFilename],
  }, null, 2) + "\n");
  check("(s3 precondition) the stale latch (with a self-referencing orphanLatchFiles entry) exists", fs.existsSync(staleLatchPath));

  // No openSync injection this time — the migrate write must succeed normally.
  const found = reenterMergeQuarantinesAtBoot([subdir]);
  check("(s3 after migrate) boot re-entry finds this repo", found.some((q) => q.repoPath === subdir));
  check("(s3 after migrate) the migrate succeeded — fresh file exists, stale file is gone", fs.existsSync(freshLatchPath) && !fs.existsSync(staleLatchPath));

  const active = activeMergeQuarantineFor(subdir);
  check("(s3 after migrate) THE FIX: the in-memory entry no longer lists the now-deleted stale filename", !active?.orphanLatchFiles?.includes(staleFilename));
  const persisted = JSON.parse(fs.readFileSync(freshLatchPath, "utf8"));
  check("(s3 after migrate) THE FIX: the PERSISTED entry doesn't list it either (not just in-memory)", !(persisted.orphanLatchFiles ?? []).includes(staleFilename));

  clearMergeQuarantine(subdir);
  check("(s3 cleanup) a real clear removes the migrated latch", !activeMergeQuarantineFor(subdir) && !fs.existsSync(freshLatchPath));
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a failed-migrate quarantine latch's only surviving file is tracked as OWNED by its " +
    "still-active entry, so a raw clear-by-id of its (stale) hash keeps it instead of silently deleting " +
    "the quarantine's only durable copy and the quarantine survives a restart (scenario 1); a LEGITIMATE " +
    "clear of that same entry actually deletes the stale file too, so it can never resurrect on a later " +
    "boot (scenario 2); and a migrate that eventually SUCCEEDS strips the now-deleted filename from " +
    "orphanLatchFiles instead of leaving a dangling reference that would falsely protect a future, " +
    "unrelated file reusing that name (scenario 3)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
