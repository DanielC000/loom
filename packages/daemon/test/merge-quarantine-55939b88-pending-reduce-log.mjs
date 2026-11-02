import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 55939b88 — clearMergeQuarantineByToken is `void`; its real callers are the in-process
// auto-clear closures in git/worktrees.ts and git/batch-merge.ts. When a by-token clear reduces an
// entry but leaves it still blocked, nothing logged that outcome — confirmed empirically: zero console
// output between the arm and a later post-clear status assertion.
//
// Round 1 fixed the PENDING-entry reduce branch only (clearTokenFromPendingIndices). Code Review round 1
// (SHOULD 2) found the SAME shape, reached from the SAME void route, in the ACTIVE-entry reduce branch
// (clearActiveEntryTokenAtKey) — including its own dual-tracked PENDING TWIN case (this card's own title
// class: "ta=enter(A); tb=enter(B); clearByToken(tb)"). Round 2 covers both sites via ONE shared
// formatter (logPartialClearStillBlocked), so their text can never drift apart, and adds:
//   S1-S3: the original pending-reduce scenarios (S1 strengthened with a split-on-"outstanding
//          token(s):" check so a cleared token announced at the START of the line is never mistaken for
//          one still in the TAIL's outstanding list).
//   S4:    a pending reduce whose on-disk record (via writePendingDivertFile's opt-in
//          rebaseOntoRealDiskRecord) unions in a REAL token memory never had — pins that the logged list
//          is read from the entry's final POST-WRITE state, not a pre-write local.
//   S5:    a forced writePendingDivertFile failure on a pending reduce — exactly one line still fires,
//          qualified.
//   S6/S7: the ACTIVE-entry site — a reduce (log fires) and a full lift (log does not fire).
//   S8/S9: the ACTIVE-entry site's own dual-tracked PENDING TWIN — a reduce (log fires, reads the
//          entry's post-write state) and a full lift (log does not fire).
//
// Code Review round 2 (SHOULD 2, a misreport) found that `updated` is NOT actually "the entry's final
// post-write state" at the active-entry site: the twin loop stores its own `written.entry` into
// `pendingUnresolvedQuarantines` but never folds it back into `updated`, and writePendingDivertFile's
// marked-basename reread-and-union branch (gated on `keptUnreadableLatchFiles` alone, never on
// `rebaseOntoRealDiskRecord`) can union a real on-disk token/contributor into a twin's own written entry
// that `updated` — and so the log — never named. Round 3 fixes this with a LOG-ONLY union (never
// changing what is actually written/stored) and adds:
//   S10: the twin's own on-disk union (via a marked, now-readable basename) names a token neither
//        `updated` nor memory ever carried — the log must include it anyway.
//   S11: active-entry reduce, the ARMED-KEY final write is forced to fail — log still fires, qualified.
//   S12: the dual-tracked-twin site, only the TWIN's own pending-divert write is forced to fail (the
//        armed-key final write succeeds) — log still fires, qualified.
//   S13: a pending entry whose own ARMED-KEY write (`clearTokenFromPendingIndices`' defensive, routed-
//        but-today-unreachable-via-the-real-caller branch — reached here via the TestOnly seam, the same
//        "state no real code path can produce" technique every sibling test in this family uses for that
//        branch) is forced to fail — log still fires, qualified.
//   S6/S8 also now assert NO qualifier fires on their own clean (non-forced-failure) write.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-55939b88-pending-reduce-log.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq55939b88-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineByToken, listActiveMergeQuarantines, assertRepoNotQuarantined,
  MERGE_QUARANTINE_DIR, reenterMergeQuarantinesAtBootTestOnly, setActiveQuarantineTestOnly,
  pushPendingQuarantineTestOnly, markLatchFileUnreadableTestOnly, clearTokenFromPendingIndicesTestOnly,
  findPendingIndexByIdentityTestOnly,
} = await import(mergeQuarantineModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Mirrors the real module's own private pendingDivertFilenameFor (hashes an identity's
// directPathIdentity) — same technique every sibling merge-quarantine*.mjs test in this family uses.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

// Captures every console.warn call made during `fn()`, restoring the real console.warn afterward even
// if `fn` throws.
function captureWarnings(fn) {
  const calls = [];
  const orig = console.warn;
  console.warn = (...args) => { calls.push(args.map((a) => String(a)).join(" ")); };
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return calls;
}

// Intercepts fs.openSync for any pending-divert tmp write (`pending-<24hex>.json.tmp-<pid>-<hex>`,
// writePendingDivertFile's own tmp shape — same technique merge-quarantine-protect-write-failure.mjs
// uses) and throws EACCES, forcing writePendingDivertFile's own final write to fail and return `false`.
function injectPendingDivertWriteFailure() {
  const real = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes("pending-") && p.includes(".tmp-")) {
      throw Object.assign(new Error("EACCES: simulated pending-divert write failure (55939b88 S5)"), { code: "EACCES" });
    }
    return real(p, ...rest);
  };
  return () => { fs.openSync = real; };
}

// Mirrors the real module's own private quarantineHashForKey (hashes a raw KEY, never a repoPath) — same
// helper every sibling merge-quarantine*.mjs test in this family uses.
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

// Intercepts fs.openSync for the FINAL-latch tmp write at ONE specific key's own hash
// (`<hash>.json.tmp-<pid>-<hex>`, writeMergeQuarantineLatch's own tmp shape for an armed key) and throws
// EACCES — forces writeLatchAndAdopt to fail for that key alone, without disturbing any pending-divert
// write (a disjoint filename shape, "pending-<hash>.json...").
function injectFinalWriteFailureForHash(hash) {
  const real = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes(`${hash}.json.tmp-`)) {
      throw Object.assign(new Error(`EACCES: simulated final-latch write failure (55939b88 round 3) for hash ${hash}`), { code: "EACCES" });
    }
    return real(p, ...rest);
  };
  return () => { fs.openSync = real; };
}

// Item (a) — split the logged line on "outstanding token(s):" and assert the cleared token is ABSENT
// from the tail (never confused with the "partial clear of token <X>" announcement at the START of the
// SAME line) while every expected survivor IS present in it. Also asserts exactly one line fired.
function assertReduceLog(label, warnings, matchFilter, clearedToken, expectedSurvivors) {
  const matches = warnings.filter(matchFilter);
  check(`${label}: exactly ONE log line fired`, matches.length === 1);
  if (matches.length !== 1) return matches;
  const line = matches[0];
  const tailIdx = line.indexOf("outstanding token(s):");
  check(`${label}: line contains "outstanding token(s):"`, tailIdx !== -1);
  const tail = tailIdx === -1 ? "" : line.slice(tailIdx);
  check(`${label}: the cleared token is ABSENT from the tail`, !tail.includes(clearedToken));
  for (const t of expectedSurvivors) {
    check(`${label}: survivor "${t}" is PRESENT in the tail`, tail.includes(t));
  }
  return matches;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("55939b88-reduce-still-blocked-logs") — X holds two tokens; clearing one leaves the other
// outstanding (the pending reduce branch) — the log line must fire, naming X's own repoPath/branch and
// the surviving token in the TAIL, and the cleared token must not appear in that same tail.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const X = path.join(os.tmpdir(), `loom-mq55939b88-s1-X-never-${sfx}`);
  const tCleared = "tok-cleared-" + sfx;
  const tSurvivor = "tok-survivor-" + sfx;
  const xCanonicalName = pendingDivertFilenameForTest(X);

  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: X, branch: "loom/55939b88-x-branch", reason: "55939b88 S1: reduce leaves a survivor", enteredAt: Date.now(), tokens: [tCleared, tSurvivor] }, sourceFile: xCanonicalName },
  ]);

  check("(precondition S1) X reads blocked before the clear", !assertRepoNotQuarantined(X).ok);

  const warnings = captureWarnings(() => clearMergeQuarantineByToken(X, tCleared));

  check("*** S1 *** X is STILL blocked after the clear (a real reduce, not a full lift)", !assertRepoNotQuarantined(X).ok);
  const xAfter = listActiveMergeQuarantines().find((e) => e.repoPath === X);
  check("*** S1 *** X's own survivor token is the only one left", !!xAfter && JSON.stringify([...xAfter.tokens].sort()) === JSON.stringify([tSurvivor].sort()));

  const matches = assertReduceLog("S1", warnings, (w) => w.includes("[merge-quarantine] partial clear of token"), tCleared, [tSurvivor]);
  check("*** THE FIX (S1) *** the line names X's own repoPath", matches.some((w) => w.includes(X)));
  check("*** THE FIX (S1) *** the line names X's own branch", matches.some((w) => w.includes("loom/55939b88-x-branch")));
  check("*** THE FIX (S1) *** the line carries NO write-failure qualifier (the write succeeded)", !matches.some((w) => w.includes("durable records still hold")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 ("55939b88-full-lift-no-log") — Y holds exactly one token; clearing it is a FULL lift (the
// "remove" branch, no survivor) — the new reduce-only log line must NOT fire for Y at all.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const Y = path.join(os.tmpdir(), `loom-mq55939b88-s2-Y-never-${sfx}`);
  const tOnly = "tok-only-" + sfx;
  const yCanonicalName = pendingDivertFilenameForTest(Y);

  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: Y, branch: "loom/55939b88-y-branch", reason: "55939b88 S2: full lift, no survivor", enteredAt: Date.now(), tokens: [tOnly] }, sourceFile: yCanonicalName },
  ]);

  check("(precondition S2) Y reads blocked before the clear", !assertRepoNotQuarantined(Y).ok);

  const warnings = captureWarnings(() => clearMergeQuarantineByToken(Y, tOnly));

  check("*** S2 *** Y is fully lifted (a genuine full lift, not a reduce)", assertRepoNotQuarantined(Y).ok);

  const matches = warnings.filter((w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(Y));
  check("*** THE FIX (S2) *** the reduce-only log line did NOT fire for a full lift", matches.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 ("55939b88-reduce-names-contributor") — Z's own entry carries contributorRepoPaths (another
// raiser's token folded into the same flat tokens set, per 82032b5c). A reduce that still leaves tokens
// outstanding must name that other raiser too, since it's the closest attribution the data in hand gives
// for whose token(s) might be among the survivors.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const Z = path.join(os.tmpdir(), `loom-mq55939b88-s3-Z-never-${sfx}`);
  const ContribRepo = path.join(os.tmpdir(), `loom-mq55939b88-s3-contrib-never-${sfx}`);
  const tCleared3 = "tok-cleared3-" + sfx;
  const tSurvivor3 = "tok-survivor3-" + sfx;
  const zCanonicalName = pendingDivertFilenameForTest(Z);

  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: Z, branch: "loom/55939b88-z-branch", reason: "55939b88 S3: reduce with a folded contributor", enteredAt: Date.now(), tokens: [tCleared3, tSurvivor3], contributorRepoPaths: [ContribRepo] }, sourceFile: zCanonicalName },
  ]);

  check("(precondition S3) Z reads blocked before the clear", !assertRepoNotQuarantined(Z).ok);

  const warnings = captureWarnings(() => clearMergeQuarantineByToken(Z, tCleared3));

  check("*** S3 *** Z is STILL blocked after the clear", !assertRepoNotQuarantined(Z).ok);

  const matches = assertReduceLog("S3", warnings, (w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(Z), tCleared3, [tSurvivor3]);
  check("*** THE FIX (S3) *** the line names the folded contributor's own repoPath", matches.some((w) => w.includes(ContribRepo)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 ("55939b88-reduce-rebase-union", round 2 item 2b) — W's own IN-MEMORY record holds only
// {tCleared4, tSurvivor4}, but its real ON-DISK pending-divert file (written AFTER the inject, so it is
// never scanned into memory by anything but this clear's own rebase read) ALSO carries tExtra4 — a real
// token memory never had. clearTokenFromPendingIndices' own reduce-branch write passes
// rebaseOntoRealDiskRecord:true, so the union pulls tExtra4 in. The logged list must reflect the FINAL
// post-write entry (tSurvivor4 + tExtra4), never the pre-write `remaining` local (which would show only
// tSurvivor4) — pinning the post-write-entry source the shared formatter reads from.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const W = path.join(os.tmpdir(), `loom-mq55939b88-s4-W-never-${sfx}`);
  const tCleared4 = "tok-cleared4-" + sfx;
  const tSurvivor4 = "tok-survivor4-" + sfx;
  const tExtra4 = "tok-extra4-disk-only-" + sfx;
  const wCanonicalName = pendingDivertFilenameForTest(W);

  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: W, branch: "loom/55939b88-w-branch", reason: "55939b88 S4: in-memory record, pre-rebase", enteredAt: Date.now(), tokens: [tCleared4, tSurvivor4] }, sourceFile: wCanonicalName },
  ]);

  // Overwrite the real on-disk copy with an EXTRA real token memory does not have — simulating a prior
  // failed-then-recovered write, or a sibling process's own durable fold, that memory never observed.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, wCanonicalName), JSON.stringify({
    repoPath: W, branch: "loom/55939b88-w-branch", reason: "55939b88 S4: real on-disk record, carries an extra token", enteredAt: Date.now(), tokens: [tCleared4, tSurvivor4, tExtra4],
  }, null, 2) + "\n");

  check("(precondition S4) W reads blocked before the clear", !assertRepoNotQuarantined(W).ok);

  const warnings = captureWarnings(() => clearMergeQuarantineByToken(W, tCleared4));

  check("*** S4 *** W is STILL blocked after the clear", !assertRepoNotQuarantined(W).ok);
  const wAfter = listActiveMergeQuarantines().find((e) => e.repoPath === W);
  check("*** S4 *** W's own in-memory tokens were rebased to include the disk-only extra token", !!wAfter && JSON.stringify([...wAfter.tokens].sort()) === JSON.stringify([tExtra4, tSurvivor4].sort()));

  const matches = assertReduceLog("S4", warnings, (w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(W), tCleared4, [tSurvivor4, tExtra4]);
  check("*** THE FIX (S4) *** the logged list includes the DISK-ONLY token the rebase unioned in (proves the post-write entry is the source)", matches.some((w) => w.includes(tExtra4)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 5 ("55939b88-reduce-write-failure-qualifies", round 2 item 2c) — V's own reduce-branch write
// (writePendingDivertFile) is forced to fail (EACCES on its tmp). The reduce still happened IN MEMORY
// (the token is dropped from the live entry and tombstoned), so the log must still fire exactly once,
// qualified to say the durable record was NOT updated.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const V = path.join(os.tmpdir(), `loom-mq55939b88-s5-V-never-${sfx}`);
  const tCleared5 = "tok-cleared5-" + sfx;
  const tSurvivor5 = "tok-survivor5-" + sfx;
  const vCanonicalName = pendingDivertFilenameForTest(V);

  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: { repoPath: V, branch: "loom/55939b88-v-branch", reason: "55939b88 S5: reduce whose durable write is forced to fail", enteredAt: Date.now(), tokens: [tCleared5, tSurvivor5] }, sourceFile: vCanonicalName },
  ]);

  check("(precondition S5) V reads blocked before the clear", !assertRepoNotQuarantined(V).ok);

  const restore = injectPendingDivertWriteFailure();
  let warnings;
  try {
    warnings = captureWarnings(() => clearMergeQuarantineByToken(V, tCleared5));
  } finally {
    restore();
  }

  check("*** S5 *** V is STILL blocked after the clear (in-memory reduce happened regardless of the write failure)", !assertRepoNotQuarantined(V).ok);

  const matches = assertReduceLog("S5", warnings, (w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(V), tCleared5, [tSurvivor5]);
  check("*** THE FIX (S5) *** NIT 1/3 — the line qualifies itself when the durable write failed", matches.some((w) => w.includes("(one or more durable records still hold the cleared token)")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 6 ("55939b88-active-entry-reduce", round 2 items 1+2d) — an ACTIVE (not pending) entry at key
// K6 holds two tokens; clearing one reaches clearActiveEntryTokenAtKey's own reduce branch (no pending
// twin involved here — see S8 for that). The SAME shared formatter must fire once, naming the entry's
// repoPath/branch and the surviving token in the tail, with the cleared token absent from it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const ActiveX = path.join(os.tmpdir(), `loom-mq55939b88-s6-activex-never-${sfx}`);
  const K6 = "mq55939b88-s6-k6-" + sfx;
  const tCleared6 = "tok-cleared6-" + sfx;
  const tSurvivor6 = "tok-survivor6-" + sfx;

  setActiveQuarantineTestOnly(K6, { repoPath: ActiveX, branch: "loom/55939b88-activex-branch", reason: "55939b88 S6: active entry, reduce leaves a survivor", enteredAt: Date.now(), tokens: [tCleared6, tSurvivor6] });

  check("(precondition S6) ActiveX reads blocked before the clear", !assertRepoNotQuarantined(ActiveX).ok);

  const warnings = captureWarnings(() => clearMergeQuarantineByToken(ActiveX, tCleared6));

  check("*** S6 *** ActiveX is STILL blocked after the clear (a real reduce, not a full lift)", !assertRepoNotQuarantined(ActiveX).ok);
  const activeXAfter = listActiveMergeQuarantines().find((e) => e.repoPath === ActiveX);
  check("*** S6 *** ActiveX's own survivor token is the only one left", !!activeXAfter && JSON.stringify([...activeXAfter.tokens].sort()) === JSON.stringify([tSurvivor6].sort()));

  const matches = assertReduceLog("S6", warnings, (w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(ActiveX), tCleared6, [tSurvivor6]);
  check("*** THE FIX (S6) *** item 1 — the ACTIVE-entry reduce branch now logs too, via the same shared formatter", matches.length === 1);
  check("*** THE FIX (S6) *** round 3 item 2d — NO write-failure qualifier on a clean write", !matches.some((w) => w.includes("durable records still hold")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 7 ("55939b88-active-entry-full-lift-no-log", round 2 item 2d negative) — an ACTIVE entry at
// K7 holds exactly one token; clearing it is a full lift (clearActiveEntryTokenAtKey's own "remove"
// branch, delegating to clearMergeQuarantineByKey) — the reduce-only log must NOT fire for it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const ActiveY = path.join(os.tmpdir(), `loom-mq55939b88-s7-activey-never-${sfx}`);
  const K7 = "mq55939b88-s7-k7-" + sfx;
  const tOnly7 = "tok-only7-" + sfx;

  setActiveQuarantineTestOnly(K7, { repoPath: ActiveY, branch: "loom/55939b88-activey-branch", reason: "55939b88 S7: active entry, full lift", enteredAt: Date.now(), tokens: [tOnly7] });

  check("(precondition S7) ActiveY reads blocked before the clear", !assertRepoNotQuarantined(ActiveY).ok);

  const warnings = captureWarnings(() => clearMergeQuarantineByToken(ActiveY, tOnly7));

  check("*** S7 *** ActiveY is fully lifted (a genuine full lift, not a reduce)", assertRepoNotQuarantined(ActiveY).ok);

  const matches = warnings.filter((w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(ActiveY));
  check("*** THE FIX (S7) *** the reduce-only log line did NOT fire for an active-entry full lift", matches.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 8 ("55939b88-pending-twin-reduce", round 2 items 1+2d) — this card's own title class: an
// 883e29bc dual-tracked twin — ONE entry object, armed BOTH active (at K8) and pending (at its own
// physical sourceFile, the SAME object reference in both). ta=enter(A) (tCleared8), tb=enter(B)
// (tSurvivor8); clearByToken(tCleared8) reaches clearActiveEntryTokenAtKey's own reduce branch, which
// rewrites BOTH the armed key's final AND the twin's own separate pending-divert file. The shared
// formatter must fire exactly once, reading `updated` (the post-write entry both writes converge on).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const Twin8 = path.join(os.tmpdir(), `loom-mq55939b88-s8-twin-never-${sfx}`);
  const K8 = "mq55939b88-s8-k8-" + sfx;
  const tCleared8 = "tok-cleared8-" + sfx;
  const tSurvivor8 = "tok-survivor8-" + sfx;
  const twin8SourceFile = pendingDivertFilenameForTest(Twin8);

  const sharedEntry8 = { repoPath: Twin8, branch: "loom/55939b88-twin8-branch", reason: "55939b88 S8: dual-tracked twin, reduce leaves a survivor", enteredAt: Date.now(), tokens: [tCleared8, tSurvivor8] };
  setActiveQuarantineTestOnly(K8, sharedEntry8);
  pushPendingQuarantineTestOnly(sharedEntry8, twin8SourceFile);
  // The twin's own physical pending-divert file must ALREADY exist on disk, or
  // clearActiveEntryTokenAtKey's own twin loop skips rewriting it entirely (ae79d492 round 2 — never
  // rewrites a twin sourceFile that "no longer exists", since that shape means its own tmp was just
  // swept) — this is the genuine dual-tracked-twin precondition, not an incidental setup detail.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, twin8SourceFile), JSON.stringify(sharedEntry8, null, 2) + "\n");

  check("(precondition S8) Twin8 reads blocked before the clear", !assertRepoNotQuarantined(Twin8).ok);

  const warnings = captureWarnings(() => clearMergeQuarantineByToken(Twin8, tCleared8));

  check("*** S8 *** Twin8 is STILL blocked after the clear", !assertRepoNotQuarantined(Twin8).ok);
  const twin8After = listActiveMergeQuarantines().find((e) => e.repoPath === Twin8);
  check("*** S8 *** Twin8's own survivor token is the only one left", !!twin8After && JSON.stringify([...twin8After.tokens].sort()) === JSON.stringify([tSurvivor8].sort()));
  const twin8OnDisk = (() => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, twin8SourceFile), "utf8")); } catch { return null; } })();
  check("*** S8 *** (sanity) the twin's own physical pending-divert file was ALSO durably rewritten with the reduced set", !!twin8OnDisk && JSON.stringify([...(twin8OnDisk.tokens ?? [])].sort()) === JSON.stringify([tSurvivor8].sort()));

  const matches = assertReduceLog("S8", warnings, (w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(Twin8), tCleared8, [tSurvivor8]);
  check("*** THE FIX (S8) *** item 1 — this card's own title class (a dual-tracked pending twin) now logs too, exactly once (not once per write)", matches.length === 1);
  check("*** THE FIX (S8) *** round 3 item 2d — NO write-failure qualifier on a clean write", !matches.some((w) => w.includes("durable records still hold")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 9 ("55939b88-pending-twin-full-lift-no-log", round 2 item 2d negative) — the SAME dual-tracked
// twin shape as S8, but holding exactly one token — clearing it is a full lift; the reduce-only log must
// NOT fire.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const Twin9 = path.join(os.tmpdir(), `loom-mq55939b88-s9-twin-never-${sfx}`);
  const K9 = "mq55939b88-s9-k9-" + sfx;
  const tOnly9 = "tok-only9-" + sfx;
  const twin9SourceFile = pendingDivertFilenameForTest(Twin9);

  const sharedEntry9 = { repoPath: Twin9, branch: "loom/55939b88-twin9-branch", reason: "55939b88 S9: dual-tracked twin, full lift", enteredAt: Date.now(), tokens: [tOnly9] };
  setActiveQuarantineTestOnly(K9, sharedEntry9);
  pushPendingQuarantineTestOnly(sharedEntry9, twin9SourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, twin9SourceFile), JSON.stringify(sharedEntry9, null, 2) + "\n");

  check("(precondition S9) Twin9 reads blocked before the clear", !assertRepoNotQuarantined(Twin9).ok);

  const warnings = captureWarnings(() => clearMergeQuarantineByToken(Twin9, tOnly9));

  check("*** S9 *** Twin9 is fully lifted (a genuine full lift, not a reduce)", assertRepoNotQuarantined(Twin9).ok);

  const matches = warnings.filter((w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(Twin9));
  check("*** THE FIX (S9) *** the reduce-only log line did NOT fire for a dual-tracked twin's own full lift", matches.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 10 ("55939b88-twin-on-disk-union-logged", round 3 item 1, Code Review round 2 SHOULD 2) — the
// SAME dual-tracked-twin shape as S8, but the twin's own physical sourceFile is marked
// keptUnreadableLatchFiles AND its real on-disk content carries an EXTRA token (tExtra10) neither memory
// nor `updated` ever had. writePendingDivertFile's own marked-basename reread-and-union branch pulls
// tExtra10 into the twin's own `written.entry` — a real token that still blocks this repo. The log must
// name it, even though it never reaches `updated` itself (by design — see 702b4241 round 3's own rule).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const Twin10 = path.join(os.tmpdir(), `loom-mq55939b88-s10-twin-never-${sfx}`);
  const K10 = "mq55939b88-s10-k10-" + sfx;
  const tCleared10 = "tok-cleared10-" + sfx;
  const tSurvivor10 = "tok-survivor10-" + sfx;
  const tExtra10 = "tok-extra10-disk-only-" + sfx;
  const twin10SourceFile = pendingDivertFilenameForTest(Twin10);

  const sharedEntry10 = { repoPath: Twin10, branch: "loom/55939b88-twin10-branch", reason: "55939b88 S10: dual-tracked twin, twin's own on-disk union", enteredAt: Date.now(), tokens: [tCleared10, tSurvivor10] };
  setActiveQuarantineTestOnly(K10, sharedEntry10);
  pushPendingQuarantineTestOnly(sharedEntry10, twin10SourceFile);
  // Real on-disk content at the twin's own sourceFile, carrying tExtra10 — a token `updated` (derived
  // from in-memory `sharedEntry10`) never had. Written AFTER the inject, same technique as S4.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, twin10SourceFile), JSON.stringify({
    repoPath: Twin10, branch: "loom/55939b88-twin10-branch", reason: "55939b88 S10: real on-disk twin record, carries an extra token", enteredAt: Date.now(), tokens: [tCleared10, tSurvivor10, tExtra10],
  }, null, 2) + "\n");
  // Marks the twin's own sourceFile as previously-unreadable, now proven readable — the precondition
  // writePendingDivertFile's own reread-and-union branch (gated on `keptUnreadableLatchFiles` alone,
  // never `rebaseOntoRealDiskRecord`) requires before it will union disk content into `written.entry`.
  markLatchFileUnreadableTestOnly(twin10SourceFile);

  check("(precondition S10) Twin10 reads blocked before the clear", !assertRepoNotQuarantined(Twin10).ok);

  const warnings = captureWarnings(() => clearMergeQuarantineByToken(Twin10, tCleared10));

  check("*** S10 *** Twin10 is STILL blocked after the clear", !assertRepoNotQuarantined(Twin10).ok);
  const twin10After = listActiveMergeQuarantines().find((e) => e.repoPath === Twin10);
  check("*** S10 *** (sanity) `updated` itself (what's actually stored in activeQuarantines) is UNCHANGED by the twin's own union — still just the survivor, never mutated by the fix", !!twin10After && JSON.stringify([...twin10After.tokens].sort()) === JSON.stringify([tSurvivor10].sort()));
  const twin10OnDisk = (() => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, twin10SourceFile), "utf8")); } catch { return null; } })();
  check("*** S10 *** (sanity) the twin's own on-disk file was durably rewritten holding BOTH the survivor and the disk-only extra token", !!twin10OnDisk && JSON.stringify([...(twin10OnDisk.tokens ?? [])].sort()) === JSON.stringify([tExtra10, tSurvivor10].sort()));

  const matches = assertReduceLog("S10", warnings, (w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(Twin10), tCleared10, [tSurvivor10, tExtra10]);
  check("*** THE FIX (S10) *** round 3 item 1 — the logged list includes the twin's own on-disk-union-only token, even though `updated` itself never carries it", matches.some((w) => w.includes(tExtra10)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 11 ("55939b88-active-armedkey-write-failure", round 3 item 2a) — an ACTIVE entry (no twin)
// whose own ARMED-KEY final write is forced to fail (EACCES on that key's own hashed tmp). The in-memory
// reduce still happens; the log must still fire exactly once, qualified.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const ActiveZ11 = path.join(os.tmpdir(), `loom-mq55939b88-s11-activez-never-${sfx}`);
  const K11 = "mq55939b88-s11-k11-" + sfx;
  const tCleared11 = "tok-cleared11-" + sfx;
  const tSurvivor11 = "tok-survivor11-" + sfx;

  setActiveQuarantineTestOnly(K11, { repoPath: ActiveZ11, branch: "loom/55939b88-activez-branch", reason: "55939b88 S11: active entry, forced armed-key final write failure", enteredAt: Date.now(), tokens: [tCleared11, tSurvivor11] });

  check("(precondition S11) ActiveZ11 reads blocked before the clear", !assertRepoNotQuarantined(ActiveZ11).ok);

  const restore = injectFinalWriteFailureForHash(hashForKey(K11));
  let warnings;
  try {
    warnings = captureWarnings(() => clearMergeQuarantineByToken(ActiveZ11, tCleared11));
  } finally {
    restore();
  }

  check("*** S11 *** ActiveZ11 is STILL blocked after the clear (in-memory reduce happened regardless of the write failure)", !assertRepoNotQuarantined(ActiveZ11).ok);

  const matches = assertReduceLog("S11", warnings, (w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(ActiveZ11), tCleared11, [tSurvivor11]);
  check("*** THE FIX (S11) *** round 3 item 2a — the line qualifies itself when the ARMED-KEY final write fails", matches.some((w) => w.includes("(one or more durable records still hold the cleared token)")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 12 ("55939b88-twin-pendingdivert-write-failure", round 3 item 2b) — the dual-tracked-twin
// shape (S8), but ONLY the twin's own pending-divert write is forced to fail (the armed-key final write
// succeeds normally) — the "pending-"+".tmp-" interceptor is disjoint from the active key's own
// `<hash>.json.tmp-` shape, so it isolates the twin write without touching the armed-key write.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const Twin12 = path.join(os.tmpdir(), `loom-mq55939b88-s12-twin-never-${sfx}`);
  const K12 = "mq55939b88-s12-k12-" + sfx;
  const tCleared12 = "tok-cleared12-" + sfx;
  const tSurvivor12 = "tok-survivor12-" + sfx;
  const twin12SourceFile = pendingDivertFilenameForTest(Twin12);

  const sharedEntry12 = { repoPath: Twin12, branch: "loom/55939b88-twin12-branch", reason: "55939b88 S12: dual-tracked twin, forced twin-only write failure", enteredAt: Date.now(), tokens: [tCleared12, tSurvivor12] };
  setActiveQuarantineTestOnly(K12, sharedEntry12);
  pushPendingQuarantineTestOnly(sharedEntry12, twin12SourceFile);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, twin12SourceFile), JSON.stringify(sharedEntry12, null, 2) + "\n");

  check("(precondition S12) Twin12 reads blocked before the clear", !assertRepoNotQuarantined(Twin12).ok);

  const restore = injectPendingDivertWriteFailure();
  let warnings;
  try {
    warnings = captureWarnings(() => clearMergeQuarantineByToken(Twin12, tCleared12));
  } finally {
    restore();
  }

  check("*** S12 *** Twin12 is STILL blocked after the clear", !assertRepoNotQuarantined(Twin12).ok);
  const twin12After = listActiveMergeQuarantines().find((e) => e.repoPath === Twin12);
  check("*** S12 *** (sanity) the ARMED-KEY final write succeeded despite the twin's own write failing", !!twin12After && JSON.stringify([...twin12After.tokens].sort()) === JSON.stringify([tSurvivor12].sort()));

  const matches = assertReduceLog("S12", warnings, (w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(Twin12), tCleared12, [tSurvivor12]);
  check("*** THE FIX (S12) *** round 3 item 2b — the line qualifies itself when ONLY the twin's own pending-divert write fails", matches.some((w) => w.includes("(one or more durable records still hold the cleared token)")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 13 ("55939b88-pending-armedkey-write-failure", round 3 item 2c) — a PENDING entry whose own
// ARMED-KEY write (`clearTokenFromPendingIndices`' defensive, routed branch — unreachable via the real
// caller `clearMergeQuarantineByToken`, whose own identity scan already excludes any active twin before
// this function ever runs; see 64283e06's own doc) is forced to fail. Driven directly via the
// `clearTokenFromPendingIndicesTestOnly` seam — same "state no real code path can produce" technique
// `merge-quarantine-3315b08a-replace-not-splice-stale-target.mjs`'s own S3b uses for an analogous branch.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const sfx = freshSfx();
  const P13 = path.join(os.tmpdir(), `loom-mq55939b88-s13-p13-never-${sfx}`);
  const Kp13 = "mq55939b88-s13-kp13-" + sfx;
  const tCleared13 = "tok-cleared13-" + sfx;
  const tSurvivor13 = "tok-survivor13-" + sfx;
  const p13SourceFile = pendingDivertFilenameForTest(P13);

  // SAME object reference armed both active (at Kp13) and pending — the precondition
  // `clearTokenFromPendingIndices`'s own armed-key loop requires (`activeQuarantines.get(k) === updated`
  // only becomes true once `replaceEntryEverywhere` has something to replace).
  const pendingEntry13 = { repoPath: P13, branch: "loom/55939b88-p13-branch", reason: "55939b88 S13: pending entry, forced armed-key write failure (defensive branch)", enteredAt: Date.now(), tokens: [tCleared13, tSurvivor13], armedKeys: [Kp13] };
  setActiveQuarantineTestOnly(Kp13, pendingEntry13);
  pushPendingQuarantineTestOnly(pendingEntry13, p13SourceFile);
  const idx13 = findPendingIndexByIdentityTestOnly(P13);
  check("(precondition S13) P13's own pending index was found", idx13 !== -1);

  check("(precondition S13) P13 reads blocked before the clear", !assertRepoNotQuarantined(P13).ok);

  const restore = injectFinalWriteFailureForHash(hashForKey(Kp13));
  let warnings;
  try {
    warnings = captureWarnings(() => clearTokenFromPendingIndicesTestOnly([idx13], tCleared13));
  } finally {
    restore();
  }

  check("*** S13 *** P13 is STILL blocked after the clear (in-memory reduce happened regardless of the write failure)", !assertRepoNotQuarantined(P13).ok);

  const matches = assertReduceLog("S13", warnings, (w) => w.includes("[merge-quarantine] partial clear of token") && w.includes(P13), tCleared13, [tSurvivor13]);
  check("*** THE FIX (S13) *** round 3 item 2c — the line qualifies itself when the PENDING site's own armed-key write fails", matches.some((w) => w.includes("(one or more durable records still hold the cleared token)")));
}

console.log(failures === 0
  ? "\n✅ ALL CHECKS PASS — a by-token clear that reduces (but does not fully lift) EITHER a pending "
    + "entry or an active entry (including its own dual-tracked pending twin) logs exactly once via one "
    + "shared formatter, correctly reflects the post-write entry (including a real rebase-unioned token), "
    + "qualifies itself when the durable write failed, and a full lift never fires this line at either site."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 55939b88.`);
process.exit(failures === 0 ? 0 : 1);
