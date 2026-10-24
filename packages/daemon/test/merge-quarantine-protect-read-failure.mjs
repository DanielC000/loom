import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 63e49ee2 (Blocker #2 from Code Review 66eab845 of 4900c365, split out as pre-existing) —
// protectOccupantContentBeforeDelete and the occupant detectors (differentUnresolvableOccupantRepoPathAt,
// unincorporatedOccupantRepoPathAt, and protectForeignTmpResidueBeforeSweep's own tmp-residue read) used
// to treat ANY read failure of a foreign occupant's latch file as "nothing to protect". A non-ENOENT read
// error (EACCES, EMFILE, a mode-000 file in an otherwise-writable dir, ...) therefore let the caller
// unlink or sweep the foreign file, losing the foreign quarantine for good after a reboot: fail-OPEN.
//
// THE FIX: a read failure is now classified tri-state (see `OccupantReadResult` in merge-quarantine.ts) —
// `"none"` only for ENOENT or genuinely corrupt/invalid JSON; every other read error is `"unknown"`, and
// every caller treats `"unknown"` exactly like a confirmed occupant for the purpose of never deleting or
// sweeping the file — `final` (or the tmp residue) is kept on disk, byte-for-byte, instead.
//
// ⚠️ MEASURED, ACCEPTED SCOPE OF THE FIX — read this before trusting an "in-process" claim below:
// unlike 4900c365's own write-failure fix (which HAS successfully-read content to self-own a fresh
// in-memory pending record from), a READ failure means there is NO parsed content anywhere to self-own
// FROM — `clearMergeQuarantineByKey`'s own `keysToLift`/`activeQuarantines.delete` already runs BEFORE
// any protect call, unconditionally, so the occupant's in-memory record is already gone by the time a
// protect call could even attempt to re-establish it. Measured directly (see both scenarios below): when
// EVERY read of the foreign file fails throughout the clear, the occupant's file survives on disk and a
// later REBOOT fully recovers it (both in-memory and the `assertRepoNotQuarantined` block) — but the
// occupant is genuinely NOT re-blocked IN-PROCESS between the failed clear and that reboot. This matches
// 4900c365's own "Known gap tracked separately — read-side errors" section verbatim: "the read-side
// failure happens before any content is even parsed, so there is nothing yet to protect-write in the
// first place." Both scenarios assert this honestly (an ACCEPTED RESIDUAL check, not the fix's goal) —
// see the Code Reviewer: closing this residual needs a structurally different mechanism (e.g. threading
// the caller's own already-in-memory `clearedEntry` through as a content fallback), not attempted here.
//
// ROUND 2 added `pushUnknownReadOwnershipStub` so every OTHER reference-aware sweep in this module (not
// just the one call site that saw the read failure) also honours the kept file. ROUND 3 (Manager ruling)
// found THAT fix itself unsafe — pushing a real, identity-matchable pending entry let any identity-based
// clear/list/raise code path pick it up and destroy the file it existed to protect (B1/B2/M3 below) — and
// replaced it with `keptUnreadableLatchFiles`, a pure `Set<string>` of basenames carrying no identity at
// all, so nothing can ever identity-match it. See docs/decisions/63e49ee2-*.md's "Round 3" section.
//
// ROUND 4 (Code Review e0bdf111) found round 3's own fix unsafe in a DIFFERENT way: it called
// `keptUnreadableLatchFiles.delete(...)` on every SUCCESSFUL read, but a single clear can read the SAME
// `final` more than once for different purposes — a later caller's successful read un-kept a file an
// EARLIER caller's failed read had just marked, and a wholly separate, later clear-by-id then deleted it
// as an "unreferenced orphan". Fixed by making the set GROW-ONLY within a process (every `.delete()`
// removed) — fail-closed and over-broad, matching this card's own accepted residual. The lifecycle test
// below ALSO found `deleteMergeQuarantineLatchByKey`'s own unconditional unlink bypassing the set
// entirely once a key's in-memory record is evicted (so neither protect call it gates on even runs) —
// fixed by consulting the set as a fallback ONLY when no protect call ran this invocation (never by
// poisoning `finalProtectOk` up front, which broke an unrelated, pre-existing EISDIR-vs-directory-blocker
// scenario in merge-quarantine-boot-hardening.mjs). See the decision record's "Round 4" section.
//
// ROUND 5 (Code Review b1d4614c) found round 4's own `anyProtectRan` override unsafe in turn: a
// detector's `"none"` for the SAME identity is only sound when memory reflects disk, and after a
// read-failure eviction an identity's own OLD tokens can live ONLY in `final` while its in-memory record
// has been rebuilt from a DIFFERENT raise generation whose own write never landed — "same identity" does
// not mean "same content". Fixed by removing `anyProtectRan` entirely: the set is now checked
// UNCONDITIONALLY, after every protect call, with no override — only a durable overwrite-by-rename
// (writeMergeQuarantineLatch, writePendingDivertFile) or a durable copy-aside
// (protectOccupantContentBeforeDelete's own success) may ever clear a mark. See the decision record's
// "Round 5" section — including its own scoped note on which new test actually discriminates against
// round 4's code vs. which was proven correct by direct, local ablation instead.
//
// CARD 8db913e2 (the RAISE side): `round5-rename-unmarks`'s own fixture (below) used to expose a
// PRE-EXISTING defect in `enterMergeQuarantine`'s own raise-write call sites — a protect call's `false`
// return (or a stale "none" against a MARKED basename) was ignored, so the guard-skipped raise write
// could overwrite a kept occupant's file outright, or a same-identity re-raise could overwrite `final`
// without unioning whatever token(s) were already outstanding there. Fixed by threading each protect
// call's own return (plus a re-check against `keptUnreadableLatchFiles`) into a divert-or-carry-forward
// decision at every raise write site — see `resolveRaiseOverwrite`/`divertRaiseEntry` in
// merge-quarantine.ts and docs/decisions/8db913e2-*.md.
//
// Two scenarios, each with its own positive control (clean, non-injected) and an explicit ENOENT control:
//   - final-path: the foreign occupant's content lives directly at `final` — reaches
//                 differentUnresolvableOccupantRepoPathAt / protectOccupantContentBeforeDelete /
//                 unincorporatedOccupantRepoPathAt (same fixture shape as 4900c365's own final-path test).
//   - tmp-path:   the foreign occupant's content lives only in a `.tmp-999` residue (the d2582692 R/D
//                 fixture) — reaches protectForeignTmpResidueBeforeSweep's own read.
//
// Fault-injection technique: intercept `fs.readFileSync` for the EXACT foreign path and throw EACCES —
// same seam style as merge-quarantine-protect-write-failure.mjs's `injectPendingDivertWriteFailure`
// (which intercepts `fs.openSync`), just on the read side.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-protect-read-failure.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqprf-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineReporting, activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot,
  listActiveMergeQuarantines, MERGE_QUARANTINE_DIR, assertRepoNotQuarantined,
  clearMergeQuarantineLatchFile, enterMergeQuarantine, clearMergeQuarantineByToken,
  clearMergeQuarantine,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

function contentIfExists(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqprf@loom -c user.name=mqprf";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqprf-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-protect-read-failure (${tag})\n`);
  execSync(`git init -q && git config user.email mqprf@loom && git config user.name mqprf`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// Intercepts fs.readFileSync for the EXACT given absolute path and throws the given error code
// (default EACCES). Returns a restore function and an interceptCount the caller can assert against.
function injectReadFailure(targetPath, code = "EACCES") {
  const real = fs.readFileSync;
  let interceptCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      interceptCount++;
      throw Object.assign(new Error(`${code}: simulated read failure`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => interceptCount };
}

// Round 2 (Code Review 91b49a21) — same technique as injectReadFailure, but fails only from the Nth
// read of `targetPath` ONWARD (n=1 behaves identically to injectReadFailure). Lets a scenario pin EXACTLY
// which read in a multi-read chain fails (the B2 second-read case needs the FIRST read of a tmp residue
// to succeed — that's what determines its occupant identity — while a SECOND, independent read of the
// same path fails).
function injectReadFailureFromNth(targetPath, n, code = "EACCES") {
  const real = fs.readFileSync;
  let callCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      callCount++;
      if (callCount >= n) throw Object.assign(new Error(`${code}: simulated read failure (call #${callCount})`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => callCount };
}

// Round 4 (CR e0bdf111) — fails ONLY the Nth read of `targetPath`, letting every OTHER read of the same
// path (before AND after) succeed normally. Lets a scenario reproduce "the first read of `final` within
// ONE clear fails, a LATER read of the SAME `final` within that SAME clear succeeds" — the shape that
// exposed the keptUnreadableLatchFiles un-keep bug (a transient failure followed by a different caller's
// successful read of the identical path).
function injectReadFailureOnlyNth(targetPath, n, code = "EACCES") {
  const real = fs.readFileSync;
  let callCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      callCount++;
      if (callCount === n) throw Object.assign(new Error(`${code}: simulated read failure (call #${callCount})`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => callCount };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO final-path — D's content lives directly at `final` (<Krhash>.json), genuinely ARMED via an
  // explicit `resolvedKey` field (same fixture shape as 4900c365's own final-path scenario — a bare
  // no-`resolvedKey` final is never armed, only deferred to pendingUnresolvedQuarantines at boot, and
  // would never reach the eviction shape this card's bug needs).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("fp-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");
  check("(fp precondition) D (R/gone-subdir) never exists", !fs.existsSync(d));

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-fp"], resolvedKey: Kr,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  check("(fp precondition) D is genuinely ARMED (armedKeys present)", (activeMergeQuarantineFor(d)?.armedKeys?.length ?? 0) > 0);
  check("(fp precondition) D's own file exists before the clear", fs.existsSync(finalPath));

  const inject = injectReadFailure(finalPath);
  let reportResult;
  try {
    reportResult = clearMergeQuarantineReporting(r); // clears R while D (foreign) occupies R's own key
  } finally {
    inject.restore();
  }
  check("(fp positive control) the read was actually attempted (and injected to fail)", inject.count() >= 1);
  check("(fp sanity) the clear of R itself still reports wasQuarantined:true (D occupied R's own key)", reportResult?.wasQuarantined === true);

  check("*** THE FIX (final-path) *** D's own file SURVIVES a read failure (never unlinked)", fs.existsSync(finalPath));
  check("*** THE FIX (final-path) *** D's own content is still physically present, byte-for-byte", (contentIfExists(finalPath) ?? "").includes("d-token-fp"));
  // ⚠️ ACCEPTED RESIDUAL (see file header) — NOT the fix's goal: with every read of `final` failing,
  // there is no parsed content anywhere to re-establish an in-memory record from, so D is genuinely NOT
  // re-blocked in-process by this fix alone. Asserted explicitly so this residual stays honest and
  // visible rather than silently assumed away.
  check("(fp accepted residual) assertRepoNotQuarantined(d) is NOT blocked in-process right after the failed clear (no content was ever read to re-enforce it)", assertRepoNotQuarantined(d).ok === true);

  // DURABLE — a fresh boot (new module instance) must recover D's quarantine from the surviving file.
  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (final-path, restart) *** D's own token SURVIVES a read failure + a reboot", new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-fp"));
  check("*** THE FIX (final-path, restart) *** assertRepoNotQuarantined(d) BLOCKS after the reboot", fresh.assertRepoNotQuarantined(d).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO final-path (positive control) — identical fixture, NO read injection: the pre-existing,
  // correct behavior (D's content is durably relocated, R's own file is cleanly removed) is unchanged.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("fp-ctrl-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-fp-ctrl"], resolvedKey: Kr,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  clearMergeQuarantineReporting(r); // no injection — the read must succeed normally

  check("(fp control) D's own token survives clearing R (relocated, not destroyed)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-fp-ctrl"));
  check("(fp control) R's own original file is actually removed once the read+protect succeeds", !fs.existsSync(finalPath));
  check("(fp control) D's content survives SOMEWHERE on disk under a new name", fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8").includes("d-token-fp-ctrl")));
  // Unlike the read-failure scenario above, a SUCCESSFUL read lets protectOccupantContentBeforeDelete
  // self-own D into a fresh pending record immediately — so this positive control DOES block in-process.
  check("(fp control) assertRepoNotQuarantined(d) BLOCKS in-process (a successful read self-owns it immediately)", assertRepoNotQuarantined(d).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO final-path (ENOENT control) — the file is genuinely missing at the moment of the read; this
  // is a PROVEN "none" (nothing to protect), never "unknown" — the clear must proceed exactly as today
  // (no foreign content ever existed here to lose).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("fp-enoent-r");
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  // No foreign occupant at all — R's own ordinary clear of a key with nothing armed there. The latch
  // file genuinely never existed, so every protect detector's own read hits ENOENT ("none"), never
  // "unknown" — this must proceed exactly as before, reporting nothing was ever quarantined.
  const reportResult = clearMergeQuarantineReporting(r);
  check("(fp ENOENT control) clearing a repo with nothing armed at its key proceeds exactly as today (no throw, wasQuarantined:false)", reportResult?.wasQuarantined === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO tmp-path — the d2582692 R/D fixture: R's own genuine content lives at `final`, D's content
  // lives only in a `.tmp-999` residue. protectForeignTmpResidueBeforeSweep's own read of that residue is
  // what must exclude D's tmp filename from the subsequent unconditional-by-ownership sweep.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("tp-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");
  check("(tp precondition) D (R/gone-subdir) never exists", !fs.existsSync(d));

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(rFile, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
    enteredAt: Date.now() - 30_000, tokens: ["r-token-tp"],
  }, null, 2) + "\n");
  const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
  fs.writeFileSync(dTmpFile, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-tp"], resolvedKey: Kr,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  // @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492) — R is no longer evicted at all: D's own
  // coincidentally-matching scalar now diverts D to pending at boot (card 43cf3b26's own fix) rather than
  // falling through to a tautological primary arm that used to evict R.
  check("(tp precondition) R's own token is active, never evicted by D", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("r-token-tp"));
  check("(tp precondition) D's own token is active too", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-tp"));
  check("(tp precondition) D's own tmp residue is still on disk before the clear", fs.existsSync(dTmpFile));

  const inject = injectReadFailure(dTmpFile);
  try {
    clearMergeQuarantineReporting(r); // clears R while D (foreign) occupies R's own key via the tmp residue
  } finally {
    inject.restore();
  }
  check("(tp positive control) the tmp residue's read was actually attempted (and injected to fail)", inject.count() >= 1);

  check("*** THE FIX (tmp-path) *** D's own tmp residue SURVIVES a read failure (marked kept, never swept)", fs.existsSync(dTmpFile));
  check("*** THE FIX (tmp-path) *** D's own content is still physically present in the tmp residue", (contentIfExists(dTmpFile) ?? "").includes("d-token-tp"));
  check("*** THE FIX (tmp-path) *** R's own file is still cleanly removed (its own clear is unaffected by D's read failure)", !fs.existsSync(rFile));
  // @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492) — this residual is RETIRED, not merely
  // unaffected: D's own degraded identity (resolvedKey coincidentally equal to its own walked-up
  // currentKey, same shape as card 43cf3b26's own natural.mjs repro) is now UNCONDITIONALLY diverted to
  // `pendingUnresolvedQuarantines` at BOOT TIME, independent of R's own key — so D's own content was
  // never entangled with R's entry (no tautological-primary-arm eviction of R by D, the mechanism that
  // used to make D's survival depend on this read succeeding) and is untouched by R's clear regardless of
  // whether this read fails. D is correctly reported blocked, not as an "accepted residual" fallback.
  check("*** THE FIX (tmp-path, CR 46c5c492) *** assertRepoNotQuarantined(d) IS blocked in-process right after the clear -- D's own pending entry was never entangled with R's", assertRepoNotQuarantined(d).ok === false);

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (tmp-path, restart) *** D's own token SURVIVES clearing R + a reboot", new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-tp"));
  check("*** THE FIX (tmp-path, restart) *** assertRepoNotQuarantined(d) BLOCKS after the reboot", fresh.assertRepoNotQuarantined(d).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO tmp-path (positive control) — identical fixture, NO read injection: matches the pre-existing
  // d2582692 / 4900c365 tmp-path scenarios' own assertions.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("tp-ctrl-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(rFile, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
    enteredAt: Date.now() - 30_000, tokens: ["r-token-tp-ctrl"],
  }, null, 2) + "\n");
  const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
  fs.writeFileSync(dTmpFile, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-tp-ctrl"], resolvedKey: Kr,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  clearMergeQuarantineReporting(r); // no injection — the read must succeed normally

  check("(tp control) D's own token survives clearing R (relocated, not destroyed)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-tp-ctrl"));
  check("(tp control) D's own ORIGINAL tmp residue is swept once its content is durably copied aside", !fs.existsSync(dTmpFile));
  check("(tp control) D's content survives SOMEWHERE on disk under a new name", fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8").includes("d-token-tp-ctrl")));
  check("(tp control) assertRepoNotQuarantined(d) BLOCKS in-process (a successful read self-owns it immediately)", assertRepoNotQuarantined(d).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 2 (Code Review 91b49a21) — B1: the kept file was OWNERLESS. Round 1's fix only made the ONE
  // call site that saw the read failure skip its own unlink — nothing in memory REFERENCED the kept
  // file, so every OTHER reference-aware sweep in this module (which only ever check `orphanLatchFiles`,
  // never "did someone already decide not to delete this once") still destroyed it the instant it ran,
  // regardless of which call path reached it. Fixed: `pushUnknownReadOwnershipStub` pushes a
  // content-less, fail-closed PENDING record that self-references the kept file's own basename via
  // `orphanLatchFiles` — a REFERENCE-ONLY anchor, never a content stand-in — so every sweep in this
  // module (not just the one that hit the failure) now finds it owned.
  //
  // The anchor's own identity matters: a RESOLVABLE candidate (almost always the party doing the
  // clearing) is measured to self-destroy if used directly — `resolveQuarantineFor`'s own lazy-
  // graduation (routine after any ordinary clear, e.g. `clearMergeQuarantineReporting`'s own post-clear
  // check) promotes the anchor into `activeQuarantines` as if it were that identity's own genuine raise;
  // a wholly ordinary LATER clear of that SAME identity then legitimately sweeps away "its own" pending
  // leftovers — destroying the real kept file as collateral. So a resolvable candidate gets a synthetic,
  // basename-derived identity instead (never itself resolvable, never graduated); only a genuinely
  // UNRESOLVABLE candidate (almost always the real foreign occupant) is used as-is.
  //
  // Four repros below, each named exactly as specified by the review: "p" keeps the original read
  // injection ON through the SECOND operation too; "t" removes it first (transient — the second
  // operation's own reads, if any, succeed normally). Each asserts on D's own TOKEN surviving a reboot,
  // never `assertRepoNotQuarantined(d)` — that query can read as "blocked" merely because D's own key is
  // ALSO answered by an unrelated entry (R's own, or the synthetic anchor's), which proves nothing about
  // whether D's own real token specifically survived.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  // ---- fp:clearid — clear(r) → clearMergeQuarantineLatchFile(<Kr hash>) destroyed D's final (p and t) ----
  for (const variant of ["p", "t"]) {
  const r = makeToplevelRepo(`fp-clearid-${variant}-r`);
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [`d-token-fp-clearid-${variant}`], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectReadFailureFromNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  check(`(fp:clearid-${variant}) D's file survives the first clear(r)`, fs.existsSync(finalPath));
  if (variant === "t") inject.restore(); // transient: the SECOND op's own reads, if any, now succeed

  const clearIdResult = clearMergeQuarantineLatchFile(Krhash);
  if (variant === "p") inject.restore();
  check(`*** THE FIX (fp:clearid-${variant}) *** clearMergeQuarantineLatchFile(<Kr hash>) does not destroy D's file`, fs.existsSync(finalPath));
  check(`(fp:clearid-${variant}) clearMergeQuarantineLatchFile reports ok (never throws)`, clearIdResult?.ok === true);

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check(`*** THE FIX (fp:clearid-${variant}, reboot) *** D's own token SURVIVES`, new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(`d-token-fp-clearid-${variant}`));
  }

  // ---- tp:clearid — same shape, via the unconditional sweepTmpResidueForHashIfUnreferenced (p and t) ----
  for (const variant of ["p", "t"]) {
  const r = makeToplevelRepo(`tp-clearid-${variant}-r`);
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(rFile, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
    enteredAt: Date.now() - 30_000, tokens: [`r-token-tp-clearid-${variant}`],
  }, null, 2) + "\n");
  const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
  fs.writeFileSync(dTmpFile, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [`d-token-tp-clearid-${variant}`], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectReadFailureFromNth(dTmpFile, 1);
  clearMergeQuarantineReporting(r);
  check(`(tp:clearid-${variant}) D's tmp residue survives the first clear(r)`, fs.existsSync(dTmpFile));
  if (variant === "t") inject.restore();

  const clearIdResult = clearMergeQuarantineLatchFile(Krhash);
  if (variant === "p") inject.restore();
  // @decision 656fdf39 (CR 66fad7ed round 2, B3) — re-baselined for "t" only. `reenterMergeQuarantinesAtBoot([])`
  // (above, before any injection) already READ dTmpFile successfully and armed D as a genuine, non-placeholder
  // PENDING entry (real branch/tokens, a `resolvedKey` — never card 702b4241's own synthetic placeholder
  // shape) self-referencing dTmpFile as its own sourceFile — confirmed directly via listActiveMergeQuarantines()
  // right before this call. So `clearMergeQuarantineLatchFile`'s own matched-pending branch finds D's REAL
  // tokens already in memory; once the injected failure lifts ("t"), the pre-existing coverage proof
  // (markedFinalFullyCoveredByClear) reads dTmpFile fresh, finds its on-disk tokens an EXACT match for D's
  // already-known tokens, and correctly lifts + discharges — this is 656fdf39's own fix working as intended on
  // a GENUINELY, already-fully-known entry, never an adopt-from-disk shortcut (reconcileClearedEntryIfPlaceholder
  // is a no-op here: D's entry was never placeholder-shaped). "p" is UNCHANGED: the injection is still active
  // during this exact call, so the fresh read fails and the file correctly stays kept.
  if (variant === "p") {
    check(`*** THE FIX (tp:clearid-${variant}) *** clearMergeQuarantineLatchFile(<Kr hash>) does not destroy D's tmp residue`, fs.existsSync(dTmpFile));
  } else {
    check(`*** THE FIX (tp:clearid-${variant}) *** clearMergeQuarantineLatchFile(<Kr hash>) genuinely lifts D — its own tmp residue is removed, fully covered`, !fs.existsSync(dTmpFile));
  }
  check(`(tp:clearid-${variant}) clearMergeQuarantineLatchFile reports ok (never throws)`, clearIdResult?.ok === true);

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  if (variant === "p") {
    check(`*** THE FIX (tp:clearid-${variant}, reboot) *** D's own token SURVIVES`, new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(`d-token-tp-clearid-${variant}`));
  } else {
    check(`*** THE FIX (tp:clearid-${variant}, reboot) *** D is NOT re-quarantined — the genuine lift stays lifted`, !new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(`d-token-tp-clearid-${variant}`));
  }
  }

  // ---- tp:reraise2 — clear(r); enterMergeQuarantine(r) twice; the SECOND (existing-branch) write's own
  // sweepOtherTmpsOnSuccess destroyed D's tmp (p and t) ----
  for (const variant of ["p", "t"]) {
  const r = makeToplevelRepo(`tp-reraise2-${variant}-r`);
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(rFile, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
    enteredAt: Date.now() - 30_000, tokens: [`r-token-tp-reraise2-${variant}`],
  }, null, 2) + "\n");
  const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
  fs.writeFileSync(dTmpFile, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [`d-token-tp-reraise2-${variant}`], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectReadFailureFromNth(dTmpFile, 1);
  clearMergeQuarantineReporting(r);
  check(`(tp:reraise2-${variant}) D's tmp residue survives the first clear(r)`, fs.existsSync(dTmpFile));
  if (variant === "t") inject.restore();

  enterMergeQuarantine(r, "reraise-1", "fresh raise after clear — brand-new-entry branch"); // first: nothing armed for r yet
  enterMergeQuarantine(r, "reraise-2", "second fresh raise — existing branch, sweepOtherTmpsOnSuccess"); // second: existing branch
  if (variant === "p") inject.restore();
  check(`*** THE FIX (tp:reraise2-${variant}) *** the second enterMergeQuarantine's own sweepOtherTmpsOnSuccess does not destroy D's tmp residue`, fs.existsSync(dTmpFile));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check(`*** THE FIX (tp:reraise2-${variant}, reboot) *** D's own token SURVIVES`, new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(`d-token-tp-reraise2-${variant}`));
  }

  // ---- tp:partial — clear(r); t1=raise(r); raise(r); clearMergeQuarantineByToken(r,t1) — the
  // partial-clear's own sweep destroyed D's tmp (p only, per the review's own list) ----
  {
  const r = makeToplevelRepo("tp-partial-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(rFile, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
    enteredAt: Date.now() - 30_000, tokens: ["r-token-tp-partial"],
  }, null, 2) + "\n");
  const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
  fs.writeFileSync(dTmpFile, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-tp-partial"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectReadFailureFromNth(dTmpFile, 1);
  clearMergeQuarantineReporting(r);
  check("(tp:partial) D's tmp residue survives the first clear(r)", fs.existsSync(dTmpFile));
  const t1 = enterMergeQuarantine(r, "partial-1", "fresh raise after clear");
  enterMergeQuarantine(r, "partial-2", "second fresh raise, kept outstanding");
  check("(tp:partial) D's tmp residue survives two fresh raises", fs.existsSync(dTmpFile));
  clearMergeQuarantineByToken(r, t1); // partial clear — r's OTHER token stays outstanding
  inject.restore();
  check("*** THE FIX (tp:partial) *** the partial-clear's own sweep does not destroy D's tmp residue", fs.existsSync(dTmpFile));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (tp:partial, reboot) *** D's own token SURVIVES", new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-tp-partial"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 2 — B2: a SECOND, independent read of the SAME foreign file (protectForeignTmpResidueBeforeSweep's
  // own successful read determines the occupant, then protectOccupantContentBeforeDelete's own re-read of
  // the identical path fails) used to return `false` with the failure IGNORED by its own caller's loop —
  // nothing self-owned the file, and the unconditional sweep right after destroyed it anyway while the log
  // claimed it was kept. Pinned via injectReadFailureFromNth(path, 2): the FIRST read (inside
  // protectForeignTmpResidueBeforeSweep) succeeds, the SECOND (inside protectOccupantContentBeforeDelete)
  // fails.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("b2-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(rFile, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
    enteredAt: Date.now() - 30_000, tokens: ["r-token-b2"],
  }, null, 2) + "\n");
  const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
  fs.writeFileSync(dTmpFile, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-b2"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectReadFailureFromNth(dTmpFile, 2);
  clearMergeQuarantineReporting(r);
  inject.restore();
  check("(B2 positive control) at least 2 reads of D's tmp residue were attempted (1st succeeded, 2nd+ injected to fail)", inject.count() >= 2);
  check("*** THE FIX (B2) *** D's tmp residue SURVIVES a second, independent read failure", fs.existsSync(dTmpFile));
  check("*** THE FIX (B2) *** D's own content is still physically present", (contentIfExists(dTmpFile) ?? "").includes("d-token-b2"));
  check("(B2) R's own file is still cleanly removed", !fs.existsSync(rFile));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (B2, reboot) *** D's own token SURVIVES", new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-b2"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 3 (Manager ruling) — round 2's own fix (pushUnknownReadOwnershipStub) pushed a REAL, IDENTITY-
  // MATCHABLE pending entry to anchor ownership, and that was itself the bug: any identity-based clear/
  // list/raise code path can pick up a stub sharing an identity and sweep/absorb it like a genuine entry,
  // destroying the very file it existed to protect. Fixed by replacing it with `keptUnreadableLatchFiles`,
  // a pure Set<string> of basenames carrying no identity at all — see the decision record's "Round 3".
  //
  // ROUND 3 — B1: clearing D ITSELF (never R) used to let clearMergeQuarantineByRecordedPath's own
  // identity-match for D, running in the SAME call that pushed D's own stub, immediately find and sweep
  // that stub's `orphanLatchFiles` — destroying a wholly unrelated sibling E's own kept tmp residue.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("round3-b1-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");
  const e = path.join(r, "other-gone");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-round3-b1"], resolvedKey: Kr,
  }, null, 2) + "\n");
  const eTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-998`);
  fs.writeFileSync(eTmpFile, JSON.stringify({
    repoPath: e, branch: "e-branch", reason: "E's own degraded entry, walked up to the SAME key via R",
    enteredAt: Date.now(), tokens: ["e-token-round3-b1"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(round3-b1 precondition) D is genuinely ARMED at R's own key", (activeMergeQuarantineFor(d)?.armedKeys?.length ?? 0) > 0);
  check("(round3-b1 precondition) E's own tmp residue exists before the clear", fs.existsSync(eTmpFile));

  const inject = injectReadFailureFromNth(eTmpFile, 1);
  let clearResult;
  try {
    clearResult = clearMergeQuarantine(d); // clearing D itself (unresolvable) — routes to clearMergeQuarantineByRecordedPath
  } finally {
    inject.restore();
  }
  check("(round3-b1) the read of E's own tmp residue was actually attempted (and injected to fail)", inject.count() >= 1);
  check("(round3-b1) clearing D itself still reports wasQuarantined:true", clearResult?.wasQuarantined === true);
  check("*** THE FIX (round3-b1) *** E's own tmp residue SURVIVES clearing D in the SAME call", fs.existsSync(eTmpFile));
  check("*** THE FIX (round3-b1) *** E's own content is still physically present", (contentIfExists(eTmpFile) ?? "").includes("e-token-round3-b1"));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (round3-b1, reboot) *** E's own token SURVIVES", new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("e-token-round3-b1"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 3 — B2: round 2's stub, if RESOLVABLE, graduated into `activeQuarantines` on D's very next
  // ordinary raise (`enterMergeQuarantine`'s own `existing` branch identity-matched it), polluting D's
  // real branch/reason with the stub's placeholder ("" branch, anchor reason) plus a phantom token. With
  // the identity-less Set, a fresh raise after a failed clear finds NOTHING STUB-SHAPED to absorb.
  //
  // @decision 8db913e2 (Follow-up 43cf3b26, CR 46c5c492) — RE-GROUNDED, not merely re-asserted: card
  // 43cf3b26's own fix means D's tmp here is no longer a transient residue the CLEAR's own protect call
  // first learns about — D's coincidentally-matching scalar diverts it to `pendingUnresolvedQuarantines`
  // at BOOT, independent of R's own key (same mechanism as the "tp" scenario above), so D's own REAL
  // content (never a round-2-shaped stub: a real branch/reason/token, not "" / an ownership anchor)
  // SURVIVES R's clear untouched regardless of the injected read failure. A fresh raise on D then
  // correctly UNIONS with that surviving record (this module's own stated "a repo can be quarantined by
  // more than one outstanding unconfirmed kill at once" design) — keeping the older side's branch/reason
  // and BOTH tokens, never starting "clean". This is distinct from, and does not reopen, the round-3 bug:
  // the M3 checks below (empty branch / ownership-anchor reason) still pin that the ACTUAL stub shape
  // never appears anywhere.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("round3-b2-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(rFile, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
    enteredAt: Date.now() - 30_000, tokens: ["r-token-round3-b2"],
  }, null, 2) + "\n");
  // D's own content lives ONLY in a tmp residue carrying a REAL branch/reason/token (never the round-2
  // stub shape) -- this now represents a genuine, surviving prior raise on D (card 43cf3b26's own shape),
  // not something the clear's own protect call originates.
  const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
  fs.writeFileSync(dTmpFile, JSON.stringify({
    repoPath: d, branch: "d-branch-prior", reason: "D's own genuine prior raise, now degraded",
    enteredAt: Date.now() - 60_000, tokens: ["d-token-round3-b2-prior"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);
  check("(round3-b2 precondition) D's own prior raise is ALREADY pending at boot, independent of R", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-round3-b2-prior"));

  const inject = injectReadFailureFromNth(dTmpFile, 2);
  clearMergeQuarantineReporting(r); // clears R; D's tmp residue is foreign — 2nd read of it injected to fail
  inject.restore();
  check("(round3-b2 precondition) D's own tmp residue SURVIVES the failed clear", fs.existsSync(dTmpFile));
  check("*** (CR 46c5c492) *** D's own prior raise is UNAFFECTED by R's clear (never entangled with R's key)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-round3-b2-prior"));

  const freshToken = enterMergeQuarantine(d, "REAL-BRANCH", "REAL REASON");
  const all = listActiveMergeQuarantines();
  const dEntries = all.filter((q) => q.repoPath === d);
  check("*** THE FIX (round3-b2) *** exactly one entry now represents D", dEntries.length === 1);
  check("*** (CR 46c5c492) *** the fresh raise UNIONS with D's own surviving prior raise, keeping the older (prior) branch", dEntries[0]?.branch === "d-branch-prior");
  check("*** (CR 46c5c492) *** the fresh raise UNIONS with D's own surviving prior raise, keeping the older (prior) reason", dEntries[0]?.reason === "D's own genuine prior raise, now degraded");
  check("*** (CR 46c5c492) *** D's token set is the UNION of the prior raise's own token AND the fresh raise's own -- never just one, never a phantom anchor token",
    new Set(dEntries[0]?.tokens ?? []).size === 2
    && (dEntries[0]?.tokens ?? []).includes("d-token-round3-b2-prior")
    && (dEntries[0]?.tokens ?? []).includes(freshToken));
  check("*** THE FIX (round3-b2 / M3) *** no entry anywhere carries an empty/stub branch", !all.some((q) => q.branch === ""));
  check("*** THE FIX (round3-b2 / M3) *** no entry anywhere carries a content-less ownership-anchor reason",
    !all.some((q) => q.reason.includes("ownership anchor") || q.reason.includes("content-less")));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 3 — M3: round 2's stub could appear in listActiveMergeQuarantines/the REST list under a decoy
  // repoPath (`<MERGE_QUARANTINE_DIR>/unknown-occupant/<basename>`), and clearing that decoy by id or path
  // unlinked the kept file. With the stub mechanism removed entirely, no such decoy can ever be minted —
  // checked against the GLOBAL list state accumulated by every scenario run so far in this file.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const all = listActiveMergeQuarantines();
  check("*** THE FIX (M3) *** no listed entry's repoPath names the old synthetic 'unknown-occupant' path",
    !all.some((q) => q.repoPath.includes("unknown-occupant")));
  check("*** THE FIX (M3) *** no 'unknown-occupant' subdirectory was ever created on disk",
    !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, "unknown-occupant")));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 4 (Code Review e0bdf111) — BLOCKER: round 3's `keptUnreadableLatchFiles.delete(...)` on every
  // successful read un-kept a file no reader actually protected. `deleteMergeQuarantineLatchByKey` reads
  // `final` up to 3 times in ONE clear (protectDegradedOccupantBeforeDelete, then
  // protectUnincorporatedOccupantBeforeDelete, then possibly protectOccupantContentBeforeDelete) — if the
  // FIRST read fails (marking the basename kept) and a LATER read within the SAME clear succeeds
  // (unincorporatedOccupantRepoPathAt reaching `"none"` because the identity equals `clearedEntry`), the
  // successful read's own `.delete()` erased the keep-mark the failed read had just set. The file then
  // survived ONLY through the first call's own returned boolean — a completely separate, LATER operation
  // (a clear-by-id fallback sweep) found nothing in the set and deleted it.
  //
  // THE FIX (Manager ruling): `keptUnreadableLatchFiles` is GROW-ONLY within a process — every
  // `.delete()` call removed. Fail-closed and over-broad (a transiently unreadable file stays marked kept
  // until the next reboot), matching this card's own accepted residual.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  // ---- round4-b1 — the review's own repro: a transient first-read failure, surviving a clear-by-id ----
  {
  const r = makeToplevelRepo("round4-b1-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-round4-b1"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  // Fail ONLY the first read of `final` — every later read of the SAME path, within this SAME clear,
  // succeeds normally (this is what previously un-kept the file).
  const inject = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  inject.restore();
  check("(round4-b1) at least 2 reads of `final` happened within the one clear (1st failed, later ones succeeded)", inject.count() >= 2);
  check("(round4-b1) D's own file SURVIVES the clear whose first read failed", fs.existsSync(finalPath));

  const clearIdResult = clearMergeQuarantineLatchFile(Krhash);
  check("(round4-b1) clearMergeQuarantineLatchFile reports ok (never throws)", clearIdResult?.ok === true);
  check("*** THE FIX (round4-b1) *** D's own file SURVIVES the clear-by-id follow-up (never un-kept by the later successful read)", fs.existsSync(finalPath));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (round4-b1, reboot) *** D's own token SURVIVES", new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-round4-b1"));
  }

  // ---- round4-lifecycle — transient failure, then an ORDINARY clear whose own read succeeds, then a
  // clear-by-id: the file must survive every step, never un-kept by the ordinary successful read ----
  {
  const r = makeToplevelRepo("round4-lifecycle-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-round4-lifecycle"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  // Step 1: a transient failure — the first clear's first read of `final` fails, marking it kept.
  const inject = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  inject.restore();
  check("(round4-lifecycle) D's own file survives the transient-failure clear", fs.existsSync(finalPath));

  // Step 2: an ORDINARY clear of the same repo, no injection at all. D's in-memory record was already
  // evicted by step 1's own clear (the accepted residual), so THIS call passes neither `clearingRepoPath`
  // nor `clearedEntry` — neither protect function even runs, exercising the `anyProtectRan`-gated
  // fallback to the set directly, never a fresh read reaching `"none"`.
  clearMergeQuarantineReporting(r);
  check("*** THE FIX (round4-lifecycle) *** D's own file survives an ORDINARY, fully-successful-read clear run right after the transient failure", fs.existsSync(finalPath));

  // Step 3: clear-by-id — the file must still be found kept, never deleted as an "unreferenced orphan".
  const clearIdResult = clearMergeQuarantineLatchFile(Krhash);
  check("(round4-lifecycle) clearMergeQuarantineLatchFile reports ok (never throws)", clearIdResult?.ok === true);
  check("*** THE FIX (round4-lifecycle) *** D's own file SURVIVES the clear-by-id follow-up too", fs.existsSync(finalPath));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (round4-lifecycle, reboot) *** D's own token SURVIVES", new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-round4-lifecycle"));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ROUND 5 (Code Review b1d4614c) — round 4's `anyProtectRan` override reopened the blocker ACROSS
  // calls: a detector's `"none"` for the SAME identity is only sound when memory reflects disk, but after
  // a read-failure eviction, an identity's OLD tokens can live ONLY in `final` while its in-memory record
  // has since been rebuilt from a DIFFERENT raise generation — "same identity" does not mean "same
  // content". Fixed: a marked basename is now ALWAYS kept, unconditionally, with NO override from
  // anyProtectRan (removed entirely) — only a durable overwrite-by-rename (writeMergeQuarantineLatch,
  // writePendingDivertFile) or a durable copy-aside (protectOccupantContentBeforeDelete's own success)
  // may clear the mark; a fresh read or a detector "none" never does.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  // ---- round5-b2 — the review's own cross-call repro: a read-failure eviction, then a DIFFERENT raise
  // generation of the SAME identity whose own write never durably lands, must not let its "same identity,
  // none" fresh read override the kept mark ----
  for (const variant of ["bug", "control"]) {
  const r = makeToplevelRepo(`round5-b2-${variant}-r`);
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [`D-TOK-${variant}`], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  // "bug": fail only the first read of final, marking it kept. "control": no injection at all — D's
  // content is protected normally (content-based, via the pre-existing pending mechanism), never via the
  // keep-set — proving the bug is specific to the read-failure path, not the scenario shape itself.
  if (variant === "bug") {
    const inject = injectReadFailureOnlyNth(finalPath, 1);
    clearMergeQuarantineReporting(r);
    inject.restore();
  } else {
    clearMergeQuarantineReporting(r);
  }

  // D is now resolvable, and canonicalRepoLockKey(d) === Kr (a real nested-but-empty dir never gets its
  // own .git, so it walks up to R's own key).
  fs.mkdirSync(d, { recursive: true });
  check(`(round5-b2-${variant}) D now resolves to R's own key`, canonicalRepoLockKey(d) === Kr);

  // A fresh, DIFFERENT raise generation of D itself — its own durable write never lands (manufactured
  // EIO on the rename to `final`), so D is armed IN-MEMORY ONLY with a brand-new token; `final` (if it
  // still exists) still carries whatever content the clear above left behind.
  const realRename = fs.renameSync;
  fs.renameSync = (src, dest) => {
    if (dest === finalPath) throw Object.assign(new Error("EIO simulated"), { code: "EIO" });
    return realRename(src, dest);
  };
  const t2 = enterMergeQuarantine(d, "d-branch-2", "manufactured rename failure");
  fs.renameSync = realRename;

  // Clearing D by ITS OWN fresh token reaches deleteMergeQuarantineLatchByKey with `clearedEntry` set to
  // the in-memory entry just raised — `unincorporatedOccupantRepoPathAt` reads `final` fresh, finds the
  // SAME identity (D), and correctly reports "none" — THE FIX is that this must never, by itself, permit
  // deleting a basename the keep-set still marks.
  clearMergeQuarantineByToken(d, t2);
  if (variant === "bug") {
    check("*** THE FIX (round5-b2) *** D's own file SURVIVES clearing an UNRELATED raise generation of itself", fs.existsSync(finalPath));
  }

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  const survived = new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(`D-TOK-${variant}`);
  check(`*** THE FIX (round5-b2-${variant}, reboot) *** D's own ORIGINAL token SURVIVES`, survived);
  }

  // ---- round5-copy-aside — deleteMergeQuarantineLatchByKey's own `foreignPending` branch durably
  // copies FOREIGN content aside, clearing `final`'s own mark so THIS SAME call's own fs.unlinkSync can
  // proceed right after, with no duplicate of D's content left behind. Reached via a two-step setup:
  // (1) mark `final` kept via a transient READ failure; (2) manufacture a WRITE failure during a fresh
  // raise of R so D's own content self-owns at `sourceFile === finalBasename` (the pre-existing 4900c365
  // mechanism) WITHOUT overwriting `final`'s own bytes — leaving BOTH preconditions true at once: the
  // keep-set still marks `final`, AND a pending record claims it under a DIFFERENT identity (D, not R).
  // ----
  {
  const r = makeToplevelRepo("round5-copy-aside-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir"); // left UNRESOLVABLE deliberately — a genuinely foreign occupant

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-round5-copy-aside"], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  // Step 1: mark `final`'s own basename kept via a transient READ failure while clearing R (D, foreign
  // to R, occupies R's own key) — D's in-memory record is evicted; `final` survives, physically unchanged.
  const injectRead = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  injectRead.restore();
  check("(round5-copy-aside) D's own file survives the marking clear", fs.existsSync(finalPath));

  // Step 2: a fresh raise of R reaches protectDegradedOccupantBeforeDelete's own pre-check, which reads
  // `final` fine (no injection) and discovers D's STALE content as foreign — but EVERY fs.openSync this
  // raise attempts is injected to fail, so (a) protectOccupantContentBeforeDelete's own protective copy
  // for D fails too, self-owning D at `sourceFile === finalBasename` (4900c365's own mechanism — NOT
  // this card's keep-set), and (b) R's own fresh write to `final` ALSO fails, leaving `final`'s bytes as
  // D's stale content and R armed IN-MEMORY ONLY.
  const realOpenSync = fs.openSync;
  fs.openSync = () => { throw Object.assign(new Error("EACCES simulated"), { code: "EACCES" }); };
  const rToken = enterMergeQuarantine(r, "r-branch-2", "a fresh raise, every durable write injected to fail");
  fs.openSync = realOpenSync;
  check("(round5-copy-aside precondition) `final` is UNCHANGED — still D's own stale content", (contentIfExists(finalPath) ?? "").includes("d-token-round5-copy-aside"));
  check("(round5-copy-aside precondition) R is armed in-memory only (its own write never landed)", activeMergeQuarantineFor(r)?.tokens?.includes(rToken) === true);

  // Step 3: an ORDINARY clear of R's OWN (in-memory-only) entry reaches deleteMergeQuarantineLatchByKey
  // with `clearedEntry` = R's entry and `clearIdentity` = R's own identity — its `foreignPending` branch
  // finds step 2's self-owned D record at `sourceFile === finalBasename` (a DIFFERENT identity than R)
  // and calls protectOccupantContentBeforeDelete AGAIN, this time with NO injection — the copy-aside
  // succeeds, clearing `final`'s own mark; THE FIX is that this SAME call's own fs.unlinkSync then
  // proceeds, never blocked by the now-cleared mark.
  clearMergeQuarantineByToken(r, rToken);
  check("*** THE FIX (round5-copy-aside) *** D's content is durably copied aside (a real pending entry now carries its token)",
    new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-round5-copy-aside"));
  check("*** THE FIX (round5-copy-aside) *** `final` itself is UNLINKED right after the copy-aside, in the SAME clear", !fs.existsSync(finalPath));
  const copiesOfDContent = fs.readdirSync(MERGE_QUARANTINE_DIR)
    .filter((f) => { try { return fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8").includes("d-token-round5-copy-aside"); } catch { return false; } });
  check("*** THE FIX (round5-copy-aside) *** exactly ONE copy of D's content survives — no duplicate", copiesOfDContent.length === 1);

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (round5-copy-aside, reboot) *** D's own token still SURVIVES", new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-round5-copy-aside"));
  }

  // ---- round5-rename-unmarks — a successful rename onto a marked basename clears the mark, AND
  // (card 8db913e2) a same-identity re-raise now UNIONS whatever token(s) were already outstanding at
  // `final` into its own fresh write, rather than silently dropping them ----
  {
  const r = makeToplevelRepo("round5-rename-unmarks-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");
  const origToken = "d-token-round5-rename-unmarks";

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: [origToken], resolvedKey: Kr,
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([]);

  const inject = injectReadFailureOnlyNth(finalPath, 1);
  clearMergeQuarantineReporting(r);
  inject.restore();
  check("(round5-rename-unmarks) D's own file survives the marking clear", fs.existsSync(finalPath));

  // D becomes resolvable and re-raises ITSELF (same identity as the stale content at `final` — "none",
  // no copy-aside needed) — card 8db913e2: the write now carries `origToken` forward instead of
  // silently overwriting it.
  fs.mkdirSync(d, { recursive: true });
  const t2 = enterMergeQuarantine(d, "d-branch-fresh", "a fresh raise overwriting its own stale content");
  check("*** THE FIX (round5-rename-unmarks) *** the re-raise carries the ORIGINAL token forward",
    new Set(activeMergeQuarantineFor(d)?.tokens ?? []).has(origToken));

  // Clearing ONLY the fresh token must be a PARTIAL clear — `origToken` is still outstanding, so the
  // file must survive (it would NOT have, pre-fix: the original token was already gone by this point).
  clearMergeQuarantineByToken(d, t2);
  check("*** THE FIX (round5-rename-unmarks) *** a partial clear of the fresh token alone leaves the file on disk (ORIG still outstanding)", fs.existsSync(finalPath));
  check("*** THE FIX (round5-rename-unmarks) *** the ORIGINAL token is still listed as active after the partial clear",
    new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(origToken));

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (round5-rename-unmarks, reboot) *** the ORIGINAL token SURVIVES the reboot",
    new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has(origToken));

  // Clearing the ORIGINAL token too (now, against the rebooted module's own state) must actually unlink
  // the file — the rename's own mark-clear (round 5) is still intact; nothing about this fix leaves it
  // falsely blocked forever.
  fresh.clearMergeQuarantineByToken(d, origToken);
  check("(round5-rename-unmarks mechanism check) clearing the LAST outstanding token actually UNLINKS the file", !fs.existsSync(finalPath));
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a read failure of a foreign occupant's latch file (final OR tmp residue), for a " +
    "reason other than being missing, no longer lets the subsequent unconditional unlink/sweep destroy " +
    "it; the file survives on disk byte-for-byte, and a later reboot fully recovers the occupant's " +
    "quarantine (in-memory and assertRepoNotQuarantined alike). In-process re-enforcement right after the " +
    "failed clear is an accepted, explicitly-asserted residual (no content was ever read to rebuild it " +
    "from) — see this file's own header. ENOENT (a proven absence) still proceeds exactly as before, and " +
    "a successful read still self-owns the occupant immediately, in-process, as it already did. " +
    "ROUND 2: a reference-only ownership anchor (pushUnknownReadOwnershipStub) now protects the kept file " +
    "from EVERY reference-aware sweep in this module, not just the one call site that saw the original " +
    "read failure — fp:clearid/tp:clearid/tp:reraise2/tp:partial (each proven to have destroyed D's own " +
    "token before this round's fix) and the B2 second-independent-read case all now survive, in-process " +
    "and across a reboot, with D's own real token asserted directly. " +
    "ROUND 3: replaced that stub with an identity-less keptUnreadableLatchFiles Set, since the stub's own " +
    "identity could be picked up by an ordinary clear/raise in the SAME call and destroy the file it " +
    "protected — round3-b1 (clearing D itself no longer destroys a sibling E's kept tmp residue in the " +
    "same call), round3-b2 (a fresh raise after a failed clear starts clean — real branch/reason/token, " +
    "no phantom), and M3 (no synthetic 'unknown-occupant' decoy is ever listed or created) all pass. " +
    "ROUND 4: made keptUnreadableLatchFiles GROW-ONLY (removed every .delete() call), since a later " +
    "caller's successful read of the SAME `final` used to un-key a file an earlier caller's failed read " +
    "had just marked; also gated deleteMergeQuarantineLatchByKey's own fallback to the set on " +
    "anyProtectRan (never by poisoning finalProtectOk up front, which broke an unrelated EISDIR scenario " +
    "in merge-quarantine-boot-hardening.mjs, re-verified clean here) — round4-b1 (the review's own " +
    "transient-first-read repro, surviving a clear-by-id) and round4-lifecycle (a transient failure, " +
    "then a fully-successful ordinary clear whose own in-memory record was already evicted, then a " +
    "clear-by-id — the file survives every step) both pass. " +
    "ROUND 5: removed anyProtectRan entirely — a detector's \"none\" for the same identity can still be " +
    "wrong when disk and memory have diverged across raise generations — round5-b2 (the review's own " +
    "cross-call repro, with its control) is the one new assertion proven RED against round 4's own code; " +
    "round5-copy-aside (deleteMergeQuarantineLatchByKey's own foreignPending branch literally unlinks a " +
    "marked file after a durable copy-aside, no duplicate left) and round5-rename-unmarks (a successful " +
    "rename onto a marked basename clears it, so a later ordinary clear isn't falsely blocked forever) " +
    "were each proven by direct, local ablation of their own specific .delete() line instead, since " +
    "round 4's own anyProtectRan happened to produce the same visible outcome in both of those exact " +
    "scenarios. " +
    "CARD 8db913e2 (the RAISE side): round5-rename-unmarks now ALSO asserts the re-raise carries the " +
    "ORIGINAL token forward (instead of silently dropping it), that a partial clear of only the fresh " +
    "token leaves the file on disk with the original still active, that the original survives a reboot, " +
    "and that clearing it too finally unlinks the file."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
