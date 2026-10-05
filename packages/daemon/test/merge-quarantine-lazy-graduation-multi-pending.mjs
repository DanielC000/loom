import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 188b145f (discovered from Code Reviewer eccb3d10's review of be79f4d5 — pre-existing,
// outside that card's own diff): `activeMergeQuarantineFor`'s lazy-graduation branch (git/merge-
// quarantine.ts) finds only the FIRST `pendingUnresolvedQuarantines` entry matching a repo's identity
// (`findIndex`) and splices only that one out. When PASS 1b has pushed MORE THAN ONE same-hash pending
// entry for ONE repo (two `.json.tmp-<pid>` residues sharing a hash — see
// merge-quarantine-lazy-graduation-source-latch-owner.mjs scenario 6 for how this arises), only the
// first ever graduates. Every later query for that same repo hits `activeQuarantines.get(key)` (the
// `direct` fast path at the top of the function) and returns BEFORE it ever looks at
// `pendingUnresolvedQuarantines` again — so the rest sit there FOREVER: never merged into the real armed
// entry, never cleaned up, their own tokens invisible to anything that reads the armed entry's own
// `tokens` field, and (per `listActiveMergeQuarantines`, which reports both maps) the same repo shows up
// TWICE in any diagnostic listing, permanently.
//
// SCENARIO 1 (THE BUG, write succeeds) proves the token loss + permanent duplicate-listing directly, and
// also pins union SEMANTICS (earliest non-placeholder identity wins — same `unionQuarantineEntries` rule
// PASS 2/`armQuarantineKey` already use) and that `resolvedKey` lands on the fresh key.
// SCENARIO 2 (ownership preserved on a FAILED write) proves every matched entry's own stale `sourceFile`
// must be folded into the graduated entry's `orphanLatchFiles` — not just the one `findIndex` happened to
// pick — mirroring be79f4d5's own ownership rule, now for N matched entries instead of 1.
// SCENARIO 3 is a NEGATIVE CONTROL: a single pending entry (the ordinary case) must keep graduating
// exactly as it always has — proves scenarios 1/2's assertions are not vacuously satisfied by an
// instrument that would also fail on unrelated breakage.
// SCENARIO 4 (cross-repo shared-hash, mirrors be79f4d5 scenario 7's premise) proves matching stays by
// IDENTITY, never by filename hash: repoB's own pending entry, manufactured to share the exact same
// filename hash prefix as repoA's two pending entries (no real SHA-256 collision needed — 9cabd143's own
// point), must never be pulled into repoA's graduation, and must still graduate correctly on its own.
// SCENARIO 5 (round 2, Code Reviewer 638ee0bc) — the SAME bug, a SIBLING call site: `enterMergeQuarantine`
// (git/merge-quarantine.ts) had the identical `findIndex` + `splice(pendingIdx, 1)` shape in its own
// pending-merge branch (a fresh RAISE on a repo that already has one or more pending, key-unverifiable
// latches). Two same-identity pendings plus a re-raise used to leave the repo listed twice, the SECOND
// pending entry's own token invisible, and its tmp residue stranded — same class, same fix (collect every
// identity-matching index, union them all, consume them all in one step).
// SCENARIO 6 (round 3, Delta Code Review f61b7f6e MAJOR) — the FAILED-WRITE variant of scenario 5. Round
// 2's own fix for `enterMergeQuarantine` only spliced/folded on a SUCCESSFUL write — a FAILED one neither
// spliced the matched pendings nor folded their sourceFiles into `orphanLatchFiles`, so the repo stayed
// listed 3 times forever AND a raw clear-by-id of the shared stale hash destroyed both tmps outright
// (the merged entry's ONLY durable copies), failing OPEN on the next restart.
// SCENARIOS 7 (N=1) and 8 (N=2) (round 3, Delta Code Review f61b7f6e Minor) — `enterMergeQuarantine`'s
// pending-merge branch never stripped a matched pending's own dangling self-reference from
// `orphanLatchFiles` before writing (be79f4d5's own strip-before-write rule was never ported to this call
// site). Fixed, along with scenarios 5-6 above, by extracting ONE shared helper —
// `consumeMatchedPendingsIntoArmedEntry` — applying graduation's exact rules (unconditional splice, strip
// before write, delete-on-success / fold-on-failure) from BOTH `activeMergeQuarantineFor` and
// `enterMergeQuarantine`, so the two callers cannot drift from each other again.
//
// Every scenario ends with a fresh-module RESTART assertion (same `freshBootModule` technique the sibling
// repro files use) — proving the fix's effect (or, for scenario 3, the pre-existing correct behavior)
// survives a reboot with no resurrection and no loss.
//
// See docs/decisions/be79f4d5-lazy-graduation-source-latch-ownership.md and
// docs/decisions/a6fa60e2-failed-migrate-latch-ownership.md for the sibling ownership rules this mirrors,
// and docs/decisions/188b145f-*.md for this card's own record.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-lazy-graduation-multi-pending.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqlmp-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantine, clearMergeQuarantineLatchFile, activeMergeQuarantineFor, enterMergeQuarantine,
  reenterMergeQuarantinesAtBoot, listActiveMergeQuarantines, MERGE_QUARANTINE_DIR, quarantineLatchIdFor,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

// A genuinely fresh ESM module instance (its OWN empty activeQuarantines/pendingUnresolvedQuarantines) to
// prove the "survives a restart" half — same technique as the sibling repro files. Reads ONLY the durable
// files on disk.
let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqlmp@loom -c user.name=mqlmp";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Reproduces the OLD (pre-7673d096) key algorithm by hand — same technique as the sibling repro files.
function oldHashFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

// A fresh subdir-bound repo (no .git of its own) — its stale (legacy, direct) hash and fresh (toplevel-
// walked) hash necessarily differ, same as the sibling repro files.
function makeSubdirRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqlmp-repo-${tag}-${freshSfx()}`);
  const subdir = path.join(repo, "teamA");
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-lazy-graduation-multi-pending (${tag})\n`);
  execSync(`git init -q && git config user.email mqlmp@loom && git config user.name mqlmp`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return subdir;
}

function moveRepoRootAway(subdir, parkedRoot) {
  fs.renameSync(subdir.replace(/[\\/]teamA$/, ""), parkedRoot);
}
function moveRepoRootBack(subdir, parkedRoot) {
  fs.renameSync(parkedRoot, subdir.replace(/[\\/]teamA$/, ""));
}

// Same EACCES-shaped injection technique the sibling repro files use for a graduation-write failure.
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

function listingCountFor(mod, repoPath) {
  // listActiveMergeQuarantines() reports BOTH activeQuarantines and pendingUnresolvedQuarantines — a
  // leftover, never-merged pending entry for the same repo shows up as a SECOND row here.
  return mod.listActiveMergeQuarantines().filter((q) => q.repoPath === repoPath).length;
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 (THE BUG) — two same-hash pending tmp residues for ONE repo. The graduation write
  // succeeds. THE FIX: both must be consumed in one step — tokens unioned, both stale tmps deleted, the
  // repo must show up exactly ONCE in listActiveMergeQuarantines() afterward (and stay that way), the
  // UNIONED entry's identity (branch/reason) must be the EARLIER (non-placeholder) one per
  // `unionQuarantineEntries`'s own rule, and `resolvedKey` must land on the fresh key.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s1");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const tmp1Name = `${staleHash}.json.tmp-111111`;
  const tmp2Name = `${staleHash}.json.tmp-222222`;
  const tmp1Path = path.join(MERGE_QUARANTINE_DIR, tmp1Name);
  const tmp2Path = path.join(MERGE_QUARANTINE_DIR, tmp2Name);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);
  const expectedFreshKey = canonicalRepoLockKey(subdir);

  // tmp1 is deliberately the EARLIER (non-placeholder) entry — unionQuarantineEntries must keep ITS
  // identity (branch/reason), regardless of which index `findIndex`/the match-collection happens to hit
  // first or which order the two get spliced in.
  fs.writeFileSync(tmp1Path, JSON.stringify({
    repoPath: subdir, branch: "s1-tmp1-branch", reason: "s1 tmp1 — the EARLIER entry, its identity must win the union",
    enteredAt: Date.now() - 60_000, tokens: ["s1-tmp1-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmp2Path, JSON.stringify({
    repoPath: subdir, branch: "s1-tmp2-branch", reason: "s1 tmp2 — the LATER entry, only its token should survive the union",
    enteredAt: Date.now(), tokens: ["s1-tmp2-token"],
  }, null, 2) + "\n");
  check("(s1 precondition) both same-hash pending tmp residues exist", fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlmp-parked-s1-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  const found = reenterMergeQuarantinesAtBoot([subdir]);
  check("(s1 moved away) boot re-entry reports this repo's quarantine", found.some((q) => q.repoPath === subdir));
  check("(s1 moved away) both tmp files are untouched", fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));
  check("(s1 moved away) the repo shows up TWICE pending (two distinct pending entries)", listingCountFor({ listActiveMergeQuarantines }, subdir) === 2);

  moveRepoRootBack(subdir, parkedRoot);
  check("(s1 restored) the subdir resolves on disk again", fs.existsSync(subdir));

  const activeAfterGraduation = activeMergeQuarantineFor(subdir); // THE GRADUATION QUERY — no fault injected
  check("(s1 graduation) the repo reads as quarantined", !!activeAfterGraduation);
  check("(s1 graduation) THE FIX: both tmps' tokens are unioned into the graduated entry", (activeAfterGraduation?.tokens ?? []).includes("s1-tmp1-token") && (activeAfterGraduation?.tokens ?? []).includes("s1-tmp2-token"));
  check("(s1 graduation) UNION SEMANTICS: the earlier (tmp1) entry's own identity wins", activeAfterGraduation?.branch === "s1-tmp1-branch" && activeAfterGraduation?.reason?.startsWith("s1 tmp1"));
  check("(s1 graduation) UNION SEMANTICS: resolvedKey is set to the fresh key", activeAfterGraduation?.resolvedKey === expectedFreshKey);
  check("(s1 graduation) THE FIX: a fresh latch was durably written", fs.existsSync(freshLatchPath));
  check("(s1 graduation) THE FIX: both stale tmps were deleted (superseded by the fresh write)", !fs.existsSync(tmp1Path) && !fs.existsSync(tmp2Path));
  check("(s1 graduation) THE FIX: the repo now shows up exactly ONCE — nothing left dangling in pendingUnresolvedQuarantines", listingCountFor({ listActiveMergeQuarantines }, subdir) === 1);
  const persisted = JSON.parse(fs.readFileSync(freshLatchPath, "utf8"));
  check("(s1 graduation) the PERSISTED file's own resolvedKey is also the fresh key (not just in-memory)", persisted.resolvedKey === expectedFreshKey);

  // THE REGRESSION THIS PREVENTS, stated directly: a SECOND query must never resurrect a stale duplicate
  // (the `direct` fast path at the top of the function returns immediately on every later call) — prove
  // the fix isn't merely "eventually consistent" but genuinely consumed everything in the one step.
  const secondQuery = activeMergeQuarantineFor(subdir);
  check("(s1 second query) still reads as quarantined with both tokens, stable", (secondQuery?.tokens ?? []).includes("s1-tmp1-token") && (secondQuery?.tokens ?? []).includes("s1-tmp2-token"));
  check("(s1 second query) THE REGRESSION THIS PREVENTS: still exactly ONE listing, never a resurrected duplicate", listingCountFor({ listActiveMergeQuarantines }, subdir) === 1);

  // RESTART ASSERTION — a genuinely fresh module instance, reading ONLY the durable file on disk.
  const fresh1 = await freshBootModule();
  const foundAfterRestart = fresh1.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s1 restart) a fresh boot still finds this repo's quarantine", foundAfterRestart.some((q) => q.repoPath === subdir));
  const activeAfterRestart = fresh1.activeMergeQuarantineFor(subdir);
  check("(s1 restart) NO LOSS: both tokens survive a fresh boot", (activeAfterRestart?.tokens ?? []).includes("s1-tmp1-token") && (activeAfterRestart?.tokens ?? []).includes("s1-tmp2-token"));
  check("(s1 restart) NO RESURRECTION: still exactly one listing after reboot", listingCountFor(fresh1, subdir) === 1);

  try { clearMergeQuarantine(subdir); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 (ownership preserved on a FAILED write) — two same-hash pending tmps for ONE repo, but the
  // fresh-key graduation write FAILS. THE FIX: BOTH stale sourceFiles — not just whichever one the match
  // happened to pick — must be folded into the graduated entry's `orphanLatchFiles`, so a raw clear-by-id
  // of the shared stale hash keeps BOTH (mirrors be79f4d5's single-entry rule, now for N entries).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s2");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const tmp1Name = `${staleHash}.json.tmp-333333`;
  const tmp2Name = `${staleHash}.json.tmp-444444`;
  const tmp1Path = path.join(MERGE_QUARANTINE_DIR, tmp1Name);
  const tmp2Path = path.join(MERGE_QUARANTINE_DIR, tmp2Name);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  fs.writeFileSync(tmp1Path, JSON.stringify({
    repoPath: subdir, branch: "s2-tmp1-branch", reason: "s2 tmp1 — must survive a failed graduation write",
    enteredAt: Date.now(), tokens: ["s2-tmp1-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmp2Path, JSON.stringify({
    repoPath: subdir, branch: "s2-tmp2-branch", reason: "s2 tmp2 — must ALSO survive a failed graduation write",
    enteredAt: Date.now(), tokens: ["s2-tmp2-token"],
  }, null, 2) + "\n");

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlmp-parked-s2-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  reenterMergeQuarantinesAtBoot([subdir]);
  moveRepoRootBack(subdir, parkedRoot);

  const inject = injectGraduationWriteFailure(freshHash);
  let activeAfterGraduation;
  try {
    activeAfterGraduation = activeMergeQuarantineFor(subdir); // THE GRADUATION QUERY — write injected to fail
  } finally {
    inject.restore();
  }
  check("(s2 graduation) the fresh-key write was actually attempted (and injected to fail)", inject.counter.interceptCount >= 1);
  check("(s2 graduation) the repo still reads as quarantined despite the failed write", !!activeAfterGraduation);
  check("(s2 graduation) both tokens are unioned even though the write failed", (activeAfterGraduation?.tokens ?? []).includes("s2-tmp1-token") && (activeAfterGraduation?.tokens ?? []).includes("s2-tmp2-token"));
  check("(s2 graduation) no fresh-hash file was actually written (the write genuinely failed)", !fs.existsSync(freshLatchPath));
  check("(s2 graduation) both stale tmps are STILL the only durable copies (write failed, nothing deleted)", fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));
  check("(s2 graduation) THE FIX: BOTH stale sourceFiles are folded into orphanLatchFiles, not just one", (activeAfterGraduation?.orphanLatchFiles ?? []).includes(tmp1Name) && (activeAfterGraduation?.orphanLatchFiles ?? []).includes(tmp2Name));

  // THE ACTUAL BUG / FIX TARGET: a raw clear-by-id of the shared stale hash must keep BOTH tmps.
  const clearResult = clearMergeQuarantineLatchFile(staleHash);
  check("(s2 clear-by-id on stale hash) call succeeds", clearResult.ok === true);
  check("(s2 clear-by-id on stale hash) THE FIX: reports the file(s) were KEPT, not silently deleted", clearResult.ok === true && clearResult.latchKept === true);
  check("(s2 clear-by-id on stale hash) THE BUG THIS PREVENTS: BOTH stale tmps still exist on disk after the call", fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));

  // RESTART ASSERTION (no loss): a genuinely fresh module reboot must union BOTH still-existing tmps back
  // into one active entry carrying both tokens — this is the "a later boot can still recover it" promise
  // the in-process failure-branch fold-in exists to keep.
  const fresh2a = await freshBootModule();
  const foundAfterRestartA = fresh2a.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s2 restart, no loss) a fresh boot still finds this repo's quarantine", foundAfterRestartA.some((q) => q.repoPath === subdir));
  const activeAfterRestartA = fresh2a.activeMergeQuarantineFor(subdir);
  check("(s2 restart, no loss) NO LOSS: both tokens survive a fresh boot from the two still-existing tmps", (activeAfterRestartA?.tokens ?? []).includes("s2-tmp1-token") && (activeAfterRestartA?.tokens ?? []).includes("s2-tmp2-token"));

  // NEGATIVE CONTROL: the fold-in is not a permanent leak — a LEGITIMATE full clear of the entry itself
  // still sweeps both (same posture as be79f4d5's own negative controls).
  clearMergeQuarantine(subdir);
  check("(s2) NEGATIVE CONTROL: a legitimate clear of the entry itself still sweeps BOTH folded-in tmps", !fs.existsSync(tmp1Path) && !fs.existsSync(tmp2Path));

  // RESTART ASSERTION (no resurrection): after a genuine clear, nothing should come back.
  const fresh2b = await freshBootModule();
  fresh2b.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s2 restart, no resurrection) the repo reads as NOT quarantined after a real boot following a genuine clear", !fresh2b.activeMergeQuarantineFor(subdir));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 — NEGATIVE CONTROL: a single pending entry (the ordinary, pre-existing case) must keep
  // graduating exactly as it always has. Proves scenarios 1/2's assertions are not vacuously satisfied by
  // an instrument that would ALSO fail on unrelated breakage (e.g. a graduation that never consumes
  // anything at all).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s3");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const staleLatchPath = path.join(MERGE_QUARANTINE_DIR, `${staleHash}.json`);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  fs.writeFileSync(staleLatchPath, JSON.stringify({
    repoPath: subdir, branch: "s3-branch", reason: "s3 — a single, ordinary pending latch",
    enteredAt: Date.now(), tokens: ["s3-token"],
  }, null, 2) + "\n");

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlmp-parked-s3-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  reenterMergeQuarantinesAtBoot([subdir]);
  check("(s3 moved away) the repo shows up exactly once pending (a single ordinary entry)", listingCountFor({ listActiveMergeQuarantines }, subdir) === 1);
  moveRepoRootBack(subdir, parkedRoot);

  const activeAfterGraduation = activeMergeQuarantineFor(subdir);
  check("(s3 negative control) a single pending entry still graduates correctly", !!activeAfterGraduation && (activeAfterGraduation.tokens ?? []).includes("s3-token"));
  check("(s3 negative control) a fresh latch was durably written", fs.existsSync(freshLatchPath));
  check("(s3 negative control) the stale file was deleted (superseded)", !fs.existsSync(staleLatchPath));
  check("(s3 negative control) the repo still shows up exactly once after graduation", listingCountFor({ listActiveMergeQuarantines }, subdir) === 1);

  // RESTART ASSERTION — unchanged, ordinary single-entry behavior must still survive a reboot.
  const fresh3 = await freshBootModule();
  const foundAfterRestart = fresh3.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s3 restart) a fresh boot still finds this repo's quarantine", foundAfterRestart.some((q) => q.repoPath === subdir));
  check("(s3 restart) NO LOSS: the single token survives a fresh boot", (fresh3.activeMergeQuarantineFor(subdir)?.tokens ?? []).includes("s3-token"));
  check("(s3 restart) NO RESURRECTION: still exactly one listing after reboot", listingCountFor(fresh3, subdir) === 1);

  try { clearMergeQuarantine(subdir); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 4 (cross-repo shared hash, mirrors be79f4d5 scenario 7's premise) — repoA has TWO pending
  // entries (the bug shape); repoB has its OWN, wholly unrelated pending entry manufactured to share the
  // exact SAME filename hash prefix as repoA's (no real SHA-256 collision needed — 9cabd143's own point:
  // a filename is just a string). Matching MUST stay by IDENTITY, never by hash: graduating repoA must
  // never pull in repoB's entry, and repoB must still graduate correctly, with its own token only, once
  // queried on its own.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const repoA = makeSubdirRepo("s4a");
  const repoB = makeSubdirRepo("s4b");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const sharedHash = createHash("sha256").update(`s4-shared-hash-${freshSfx()}`).digest("hex").slice(0, 24);
  const tmp1AName = `${sharedHash}.json.tmp-515151`;
  const tmp2AName = `${sharedHash}.json.tmp-525252`;
  const tmpBName = `${sharedHash}.json.tmp-535353`;
  const tmp1APath = path.join(MERGE_QUARANTINE_DIR, tmp1AName);
  const tmp2APath = path.join(MERGE_QUARANTINE_DIR, tmp2AName);
  const tmpBPath = path.join(MERGE_QUARANTINE_DIR, tmpBName);
  const freshHashA = quarantineLatchIdFor(repoA);
  const freshHashB = quarantineLatchIdFor(repoB);

  fs.writeFileSync(tmp1APath, JSON.stringify({
    repoPath: repoA, branch: "s4-a1-branch", reason: "s4 repoA tmp1 — shares a hash prefix with repoB's own unrelated entry",
    enteredAt: Date.now() - 60_000, tokens: ["s4-a1-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmp2APath, JSON.stringify({
    repoPath: repoA, branch: "s4-a2-branch", reason: "s4 repoA tmp2 — the other of repoA's own two same-hash entries",
    enteredAt: Date.now(), tokens: ["s4-a2-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmpBPath, JSON.stringify({
    repoPath: repoB, branch: "s4-b-branch", reason: "s4 repoB's own pending entry — unrelated to repoA, shares only the hash prefix",
    enteredAt: Date.now(), tokens: ["s4-b-token"],
  }, null, 2) + "\n");

  const parkedRootA = path.join(os.tmpdir(), `loom-mqlmp-parked-s4a-${freshSfx()}`);
  const parkedRootB = path.join(os.tmpdir(), `loom-mqlmp-parked-s4b-${freshSfx()}`);
  moveRepoRootAway(repoA, parkedRootA);
  moveRepoRootAway(repoB, parkedRootB);
  reenterMergeQuarantinesAtBoot([repoA, repoB]);
  check("(s4 moved away) repoA shows up TWICE pending, repoB shows up ONCE", listingCountFor({ listActiveMergeQuarantines }, repoA) === 2 && listingCountFor({ listActiveMergeQuarantines }, repoB) === 1);

  moveRepoRootBack(repoA, parkedRootA);
  // repoB deliberately stays absent — only repoA's graduation matters for this half of the scenario.

  const activeA = activeMergeQuarantineFor(repoA); // THE GRADUATION QUERY for repoA
  check("(s4 repoA graduation) repoA reads as quarantined", !!activeA);
  check("(s4 repoA graduation) THE FIX: repoA's own two tokens are unioned", (activeA?.tokens ?? []).includes("s4-a1-token") && (activeA?.tokens ?? []).includes("s4-a2-token"));
  check("(s4 repoA graduation) THE PREMISE (a): repoB's token was NEVER pulled in — matching is by identity, never by hash", !(activeA?.tokens ?? []).includes("s4-b-token"));
  check("(s4 repoA graduation) repoA's own two tmps were deleted (superseded)", !fs.existsSync(tmp1APath) && !fs.existsSync(tmp2APath));
  check("(s4 repoA graduation) THE PREMISE (a): repoB's unrelated tmp — never matched or removed by repoA's graduation — survives untouched", fs.existsSync(tmpBPath));
  check("(s4 repoA graduation) repoB's own pending entry is untouched (still pending, its own reason intact)", listingCountFor({ listActiveMergeQuarantines }, repoB) === 1 && listActiveMergeQuarantines().find((q) => q.repoPath === repoB)?.reason?.startsWith("s4 repoB's own"));

  // Now bring repoB back and let IT graduate on its own — must carry only its own token, never
  // contaminated by repoA's.
  moveRepoRootBack(repoB, parkedRootB);
  const activeB = activeMergeQuarantineFor(repoB); // THE GRADUATION QUERY for repoB
  check("(s4 repoB graduation) repoB reads as quarantined", !!activeB);
  check("(s4 repoB graduation) repoB graduates with ONLY its own token", (activeB?.tokens ?? []).length === 1 && activeB.tokens.includes("s4-b-token"));
  check("(s4 repoB graduation) repoB's own tmp was deleted (superseded)", !fs.existsSync(tmpBPath));
  check("(s4 after both) exactly one listing each, no cross-contamination", listingCountFor({ listActiveMergeQuarantines }, repoA) === 1 && listingCountFor({ listActiveMergeQuarantines }, repoB) === 1);

  // RESTART ASSERTION — a fresh module instance must find BOTH repos correctly isolated: no cross-merge,
  // no loss, no resurrected duplicates.
  const fresh4 = await freshBootModule();
  fresh4.reenterMergeQuarantinesAtBoot([repoA, repoB]);
  const freshActiveA = fresh4.activeMergeQuarantineFor(repoA);
  const freshActiveB = fresh4.activeMergeQuarantineFor(repoB);
  check("(s4 restart) repoA's both tokens survive, still isolated from repoB's", (freshActiveA?.tokens ?? []).includes("s4-a1-token") && (freshActiveA?.tokens ?? []).includes("s4-a2-token") && !(freshActiveA?.tokens ?? []).includes("s4-b-token"));
  check("(s4 restart) repoB's own token survives, still isolated from repoA's", (freshActiveB?.tokens ?? []).length === 1 && freshActiveB.tokens.includes("s4-b-token"));
  check("(s4 restart) NO RESURRECTION: still exactly one listing each after reboot", listingCountFor(fresh4, repoA) === 1 && listingCountFor(fresh4, repoB) === 1);

  try { clearMergeQuarantine(repoA); } catch { /* best-effort cleanup */ }
  try { clearMergeQuarantine(repoB); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 5 (round 2, Code Reviewer 638ee0bc) — the SAME bug in `enterMergeQuarantine`'s own
  // pending-merge branch: two same-hash pending tmp residues for ONE repo, then a FRESH RAISE
  // (`enterMergeQuarantine`, not a query) on that same repo. Pre-fix, `findIndex` merged with only the
  // FIRST matching pending entry and spliced only it out — the second entry's own token was never
  // folded in, its tmp residue was never deleted, and the repo showed up twice in
  // `listActiveMergeQuarantines` forever (the fresh raise arms `activeQuarantines`, so every later query
  // hits the `direct` fast path and never looks at `pendingUnresolvedQuarantines` again — same stranding
  // shape as scenario 1, reached through a RAISE instead of a QUERY).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s5");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const tmp1Name = `${staleHash}.json.tmp-717171`;
  const tmp2Name = `${staleHash}.json.tmp-727272`;
  const tmp1Path = path.join(MERGE_QUARANTINE_DIR, tmp1Name);
  const tmp2Path = path.join(MERGE_QUARANTINE_DIR, tmp2Name);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  fs.writeFileSync(tmp1Path, JSON.stringify({
    repoPath: subdir, branch: "s5-tmp1-branch", reason: "s5 tmp1 — one of two same-hash pending tmps, re-raise must not strand the other",
    enteredAt: Date.now() - 60_000, tokens: ["s5-tmp1-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmp2Path, JSON.stringify({
    repoPath: subdir, branch: "s5-tmp2-branch", reason: "s5 tmp2 — the other of two same-hash pending tmps",
    enteredAt: Date.now(), tokens: ["s5-tmp2-token"],
  }, null, 2) + "\n");
  check("(s5 precondition) both same-hash pending tmp residues exist", fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlmp-parked-s5-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  reenterMergeQuarantinesAtBoot([subdir]);
  check("(s5 moved away) the repo shows up TWICE pending (two distinct pending entries)", listingCountFor({ listActiveMergeQuarantines }, subdir) === 2);
  moveRepoRootBack(subdir, parkedRoot);
  check("(s5 restored) the subdir resolves on disk again", fs.existsSync(subdir));

  // THE GRADUATION-FREE PATH: a fresh RAISE, not a query. Pre-fix this merged with only one pending entry.
  const freshToken = enterMergeQuarantine(subdir, "s5-fresh-branch", "s5 fresh raise merging into two same-identity pendings");
  const activeAfterRaise = activeMergeQuarantineFor(subdir);
  check("(s5 raise) the repo reads as quarantined", !!activeAfterRaise);
  check("(s5 raise) THE FIX: all three tokens (both pendings' + the fresh raise's) are unioned", (activeAfterRaise?.tokens ?? []).includes("s5-tmp1-token") && (activeAfterRaise?.tokens ?? []).includes("s5-tmp2-token") && (activeAfterRaise?.tokens ?? []).includes(freshToken));
  check("(s5 raise) THE FIX: a fresh latch was durably written", fs.existsSync(freshLatchPath));
  check("(s5 raise) THE FIX: both stale tmps were deleted (superseded by the fresh write)", !fs.existsSync(tmp1Path) && !fs.existsSync(tmp2Path));
  check("(s5 raise) THE FIX: the repo now shows up exactly ONCE — nothing left dangling in pendingUnresolvedQuarantines", listingCountFor({ listActiveMergeQuarantines }, subdir) === 1);

  // RESTART ASSERTION.
  const fresh5 = await freshBootModule();
  const foundAfterRestart = fresh5.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s5 restart) a fresh boot still finds this repo's quarantine", foundAfterRestart.some((q) => q.repoPath === subdir));
  const activeAfterRestart = fresh5.activeMergeQuarantineFor(subdir);
  check("(s5 restart) NO LOSS: all three tokens survive a fresh boot", (activeAfterRestart?.tokens ?? []).includes("s5-tmp1-token") && (activeAfterRestart?.tokens ?? []).includes("s5-tmp2-token") && (activeAfterRestart?.tokens ?? []).includes(freshToken));
  check("(s5 restart) NO RESURRECTION: still exactly one listing after reboot", listingCountFor(fresh5, subdir) === 1);

  try { clearMergeQuarantine(subdir); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 6 (round 3, Delta Code Review f61b7f6e MAJOR) — the FAILED-WRITE variant of scenario 5.
  // Round 2's own fix only spliced matched pendings / folded their sourceFiles into orphanLatchFiles on a
  // SUCCESSFUL write — on a FAILED one, `enterMergeQuarantine`'s pending-merge branch did NEITHER: the
  // repo was listed 3 times (1 armed + 2 still-pending) and STAYED that way (a later successful raise
  // hits the `existing` branch, which never touches `pendingUnresolvedQuarantines` at all); and a raw
  // clear-by-id of the shared stale hash took the PENDING-MATCH branch and deleted BOTH tmps outright —
  // the merged entry's ONLY durable copies — failing the repo OPEN on the next restart.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s6");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const tmp1Name = `${staleHash}.json.tmp-818181`;
  const tmp2Name = `${staleHash}.json.tmp-828282`;
  const tmp1Path = path.join(MERGE_QUARANTINE_DIR, tmp1Name);
  const tmp2Path = path.join(MERGE_QUARANTINE_DIR, tmp2Name);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  fs.writeFileSync(tmp1Path, JSON.stringify({
    repoPath: subdir, branch: "s6-tmp1-branch", reason: "s6 tmp1 — must survive a failed raise-merge write",
    enteredAt: Date.now() - 60_000, tokens: ["s6-tmp1-token"],
  }, null, 2) + "\n");
  fs.writeFileSync(tmp2Path, JSON.stringify({
    repoPath: subdir, branch: "s6-tmp2-branch", reason: "s6 tmp2 — must ALSO survive a failed raise-merge write",
    enteredAt: Date.now(), tokens: ["s6-tmp2-token"],
  }, null, 2) + "\n");

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlmp-parked-s6-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  reenterMergeQuarantinesAtBoot([subdir]);
  check("(s6 moved away) the repo shows up TWICE pending (two distinct pending entries)", listingCountFor({ listActiveMergeQuarantines }, subdir) === 2);
  moveRepoRootBack(subdir, parkedRoot);

  const inject = injectGraduationWriteFailure(freshHash);
  let freshToken;
  try {
    freshToken = enterMergeQuarantine(subdir, "s6-fresh-branch", "s6 fresh raise merging into two same-identity pendings, write FAILS");
  } finally {
    inject.restore();
  }
  check("(s6 raise) the fresh-key write was actually attempted (and injected to fail)", inject.counter.interceptCount >= 1);
  check("(s6 raise) no fresh-hash file was actually written (the write genuinely failed)", !fs.existsSync(freshLatchPath));
  const activeAfterRaise = activeMergeQuarantineFor(subdir);
  check("(s6 raise) the repo still reads as quarantined in-memory despite the failed write", !!activeAfterRaise);
  check("(s6 raise) all three tokens are unioned even though the write failed", (activeAfterRaise?.tokens ?? []).includes("s6-tmp1-token") && (activeAfterRaise?.tokens ?? []).includes("s6-tmp2-token") && (activeAfterRaise?.tokens ?? []).includes(freshToken));
  check("(s6 raise) both stale tmps are STILL the only durable copies (write failed, nothing deleted)", fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));
  check("(s6 raise) THE FIX: BOTH stale sourceFiles are folded into orphanLatchFiles, not left stranded unfolded", (activeAfterRaise?.orphanLatchFiles ?? []).includes(tmp1Name) && (activeAfterRaise?.orphanLatchFiles ?? []).includes(tmp2Name));
  check("(s6 raise) THE MAJOR FIX: the repo shows up exactly ONCE — nothing left dangling in pendingUnresolvedQuarantines", listingCountFor({ listActiveMergeQuarantines }, subdir) === 1);

  // THE MAJOR BUG THIS PREVENTS: a raw clear-by-id of the shared stale hash must KEEP both tmps — they
  // are now the armed entry's own folded-in references, never an independent pending entry any more.
  const clearResult = clearMergeQuarantineLatchFile(staleHash);
  check("(s6 clear-by-id on stale hash) call succeeds", clearResult.ok === true);
  check("(s6 clear-by-id on stale hash) wasQuarantined===false — nothing is independently pending any more", clearResult.wasQuarantined === false);
  check("(s6 clear-by-id on stale hash) THE MAJOR FIX: BOTH tmps survive — reports the surviving file(s) as KEPT", clearResult.latchKept === true && fs.existsSync(tmp1Path) && fs.existsSync(tmp2Path));

  // THE REGRESSION THIS PREVENTS: a fresh boot must still find this repo's quarantine (reading the two
  // surviving tmp residues directly, PASS 1b) — pre-round-3, the clear-by-id above destroyed both.
  const fresh6 = await freshBootModule();
  const foundAfterRestart = fresh6.reenterMergeQuarantinesAtBoot([subdir]);
  check("(s6 restart) THE REGRESSION THIS PREVENTS: a fresh boot still finds this repo's quarantine", foundAfterRestart.some((q) => q.repoPath === subdir));
  check("(s6 restart) THE REGRESSION THIS PREVENTS: the quarantine survives the restart (fails OPEN otherwise)", !!fresh6.activeMergeQuarantineFor(subdir));

  try { clearMergeQuarantine(subdir); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 7 (round 3, Delta Code Review f61b7f6e Minor, N=1) — `enterMergeQuarantine`'s pending-merge
  // branch never stripped a matched pending's own dangling self-reference from `orphanLatchFiles` BEFORE
  // writing (round 2's own fix never added this — be79f4d5's own strip-before-write rule was never ported
  // here). A SINGLE pending entry whose own persisted content already names itself in `orphanLatchFiles`
  // (simulating "picked this up from an earlier failed attempt in this same process") must have that
  // self-reference stripped once a SUCCESSFUL raise deletes it — not left dangling, falsely "protecting" a
  // now-deleted file forever.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s7");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const staleFilename = `${staleHash}.json`;
  const staleLatchPath = path.join(MERGE_QUARANTINE_DIR, staleFilename);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  fs.writeFileSync(staleLatchPath, JSON.stringify({
    repoPath: subdir, branch: "s7-branch", reason: "s7 — a single pending entry with a dangling self-reference, raise succeeds",
    enteredAt: Date.now(), tokens: ["s7-token"], orphanLatchFiles: [staleFilename],
  }, null, 2) + "\n");

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlmp-parked-s7-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  reenterMergeQuarantinesAtBoot([subdir]);
  moveRepoRootBack(subdir, parkedRoot);

  const freshToken = enterMergeQuarantine(subdir, "s7-fresh-branch", "s7 fresh raise, write succeeds normally");
  const activeAfterRaise = activeMergeQuarantineFor(subdir);
  check("(s7 raise) the repo reads as quarantined with both tokens", !!activeAfterRaise && (activeAfterRaise.tokens ?? []).includes("s7-token") && (activeAfterRaise.tokens ?? []).includes(freshToken));
  check("(s7 raise) the migrate succeeded — fresh file exists, stale file is gone", fs.existsSync(freshLatchPath) && !fs.existsSync(staleLatchPath));
  check("(s7 raise) THE FIX: the in-memory entry no longer lists the now-deleted stale filename", !activeAfterRaise?.orphanLatchFiles?.includes(staleFilename));
  const persisted = JSON.parse(fs.readFileSync(freshLatchPath, "utf8"));
  check("(s7 raise) THE FIX: the PERSISTED entry doesn't list it either (not just in-memory)", !(persisted.orphanLatchFiles ?? []).includes(staleFilename));

  try { clearMergeQuarantine(subdir); } catch { /* best-effort cleanup */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 8 (round 3, Delta Code Review f61b7f6e Minor, N=2) — the SAME dangling-self-reference gap as
  // scenario 7, now with TWO matched pending entries (each carrying its own self-reference) unioned into
  // ONE successful raise — proving the strip-before-write rule generalizes across every matched entry,
  // not just a single one.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const subdir = makeSubdirRepo("s8");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

  const staleHash = oldHashFor(subdir);
  const tmp1Name = `${staleHash}.json.tmp-838383`;
  const tmp2Name = `${staleHash}.json.tmp-848484`;
  const tmp1Path = path.join(MERGE_QUARANTINE_DIR, tmp1Name);
  const tmp2Path = path.join(MERGE_QUARANTINE_DIR, tmp2Name);
  const freshHash = quarantineLatchIdFor(subdir);
  const freshLatchPath = path.join(MERGE_QUARANTINE_DIR, `${freshHash}.json`);

  fs.writeFileSync(tmp1Path, JSON.stringify({
    repoPath: subdir, branch: "s8-tmp1-branch", reason: "s8 tmp1 — carries its own dangling self-reference",
    enteredAt: Date.now() - 60_000, tokens: ["s8-tmp1-token"], orphanLatchFiles: [tmp1Name],
  }, null, 2) + "\n");
  fs.writeFileSync(tmp2Path, JSON.stringify({
    repoPath: subdir, branch: "s8-tmp2-branch", reason: "s8 tmp2 — ALSO carries its own dangling self-reference",
    enteredAt: Date.now(), tokens: ["s8-tmp2-token"], orphanLatchFiles: [tmp2Name],
  }, null, 2) + "\n");

  const parkedRoot = path.join(os.tmpdir(), `loom-mqlmp-parked-s8-${freshSfx()}`);
  moveRepoRootAway(subdir, parkedRoot);
  reenterMergeQuarantinesAtBoot([subdir]);
  moveRepoRootBack(subdir, parkedRoot);

  const freshToken = enterMergeQuarantine(subdir, "s8-fresh-branch", "s8 fresh raise merging two self-referencing pendings, write succeeds");
  const activeAfterRaise = activeMergeQuarantineFor(subdir);
  check("(s8 raise) the repo reads as quarantined with all three tokens", !!activeAfterRaise && (activeAfterRaise.tokens ?? []).includes("s8-tmp1-token") && (activeAfterRaise.tokens ?? []).includes("s8-tmp2-token") && (activeAfterRaise.tokens ?? []).includes(freshToken));
  check("(s8 raise) the migrate succeeded — fresh file exists, both stale tmps are gone", fs.existsSync(freshLatchPath) && !fs.existsSync(tmp1Path) && !fs.existsSync(tmp2Path));
  check("(s8 raise) THE FIX: the in-memory entry lists NEITHER now-deleted stale filename", !activeAfterRaise?.orphanLatchFiles?.includes(tmp1Name) && !activeAfterRaise?.orphanLatchFiles?.includes(tmp2Name));
  const persisted = JSON.parse(fs.readFileSync(freshLatchPath, "utf8"));
  check("(s8 raise) THE FIX: the PERSISTED entry lists NEITHER either (not just in-memory)", !(persisted.orphanLatchFiles ?? []).includes(tmp1Name) && !(persisted.orphanLatchFiles ?? []).includes(tmp2Name));

  try { clearMergeQuarantine(subdir); } catch { /* best-effort cleanup */ }
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — activeMergeQuarantineFor's lazy-graduation branch now consumes EVERY identity-matching "
    + "pending entry in one step (unioning tokens and orphanLatchFiles, preserving ownership of every "
    + "matched sourceFile, keeping the earliest non-placeholder identity and the fresh resolvedKey), "
    + "instead of leaving all but the first stuck in pendingUnresolvedQuarantines forever — matching stays "
    + "by IDENTITY, never by filename hash, every effect survives a fresh-module restart, and "
    + "enterMergeQuarantine's own sibling pending-merge branch shares the identical, SINGLE "
    + "consumeMatchedPendingsIntoArmedEntry helper (round 3) — on a SUCCESSFUL write (round 2) and, just as "
    + "load-bearingly, on a FAILED one too (round 3): unconditional splice, strip-before-write, and "
    + "fold-on-failure ownership, never just on the happy path."
  : `\n❌ ${failures} FAILURE(S) — reproduces board card 188b145f.`);
process.exit(failures === 0 ? 0 : 1);
