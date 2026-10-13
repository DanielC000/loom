import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 4900c365 (Minor 2 from Code Review 972343bd of d2582692/324c9df1; ROUND 2 per Code Review
// 66eab845 of 0e189a83) — when the durable protective copy `protectOccupantContentBeforeDelete` writes
// before a clear-side delete/sweep FAILS (a disk write failure), every caller used to ignore the failure
// and proceed with the delete/sweep it was guarding against anyway — destroying the foreign occupant's
// only durable copy as pure collateral, both on disk and (since its own in-memory record is normally
// already lifted by this point) in memory. The log line claiming the occupant "stays enforced in-memory
// only... a later boot can retry" was false.
//
// ROUND 1's fix only kept the file on disk — the occupant was STILL unenforced in-memory until a reboot
// (66eab845's own tp-fail probe (a): tokens === [] and assertRepoNotQuarantined(d).ok === true right
// after the clear) — and nothing stopped a DIFFERENT, unrelated caller (e.g. clearMergeQuarantineLatchFile's
// own raw "no entry matches" fallback) from sweeping the kept file moments later via its OWN,
// independently-reached, reference-aware sweep (66eab845's own tp-fail probe (b)).
//
// ROUND 2's fix: on a failed write, protectOccupantContentBeforeDelete now ALSO re-establishes an
// in-memory PENDING record that OWNS the kept file at ITS OWN current name — self-referenced in
// orphanLatchFiles — so (1) assertRepoNotQuarantined/activeMergeQuarantineFor block the occupant in THIS
// PROCESS immediately (via ownIdentityEntryFor's direct pendingUnresolvedQuarantines scan), and (2) EVERY
// reference-aware sweep in this module (sweepTmpResidueForHashIfUnreferenced's orphanLatchFiles check,
// physicalOwnerRepoPaths' sourceFile check) already finds it owned, unmodified, from ANY call path — not
// just the one that hit the failure. The now-redundant per-call exclude-set plumbing (round 1) was removed.
//
// Two scenarios below, each pairing an injected-failure case with its own positive control (a clean,
// non-injected run of the identical fixture) per the card's own DoD:
//   - final-path:  the foreign occupant's content lives directly at `final` — reaches
//                  protectDegradedOccupantBeforeDelete.
//   - tmp-path:    the foreign occupant's content lives only in a `.tmp-<pid>` residue (the d2582692
//                  R/D fixture) — reaches protectForeignTmpResidueBeforeSweep. Also covers the
//                  tp-fail-clearid shape (66eab845 probe (b)): a clear-by-latch-id DURING the window
//                  (before any reboot) must not sweep the kept file either.
//
// ROUND 3 (Code Review 2dd131b4 of 1fa865f5), blocker B1 — round 2's own failure branch at the final
// path built the kept record as `unionQuarantineEntries(priorAtFinal, toPersist)`, exactly the pattern
// `@decision c9114934 (round 3, MAJOR #2)` forbids 9 lines above it in the SAME function: a prior
// pending ref found via `atFinalBasenameIdx` can be a LIVE reference to a boot-time
// `armQuarantineKey`-unioned object a colliding, currently-resolvable sibling's own token was already
// bled into — unioning FROM it durably (and in-memory) re-bleeds that sibling's token into the
// occupant's own kept record. Fixed: the kept record's own base is `toPersist` alone, matching the
// success path's own discipline. The `c9114934-no-token-bleed-on-failed-protect` scenario below reuses
// that card's own "in-memory-twin" X/Y fixture (merge-quarantine-pass1-migrate-union.mjs's own
// `in-memory-twin-clear-destroys-degraded-file`) with the pending-divert write injected to fail.
//
// Fault-injection technique (fs.openSync intercepted to throw EACCES for the pending-divert tmp write)
// mirrors merge-quarantine-failed-migrate-latch-owner.mjs's own already-established seam.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-protect-write-failure.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqpwf-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantineReporting, clearMergeQuarantineLatchFile, clearMergeQuarantineByToken,
  activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, listActiveMergeQuarantines,
  MERGE_QUARANTINE_DIR, assertRepoNotQuarantined,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

// Reads a file's content if (and only if) it still exists — never throws on a (correctly or buggily)
// missing file, so a pre-fix RED run reports every one of its OWN assertions instead of crashing on the
// FIRST one that reads a file the bug already destroyed (66eab845, test fix item 1).
function contentIfExists(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

// A genuinely fresh ESM module instance per boot check — Node's loader keys its module cache on the full
// URL including the query string, so each call here gets its own instance of the SAME file, never reused
// (same technique as merge-quarantine-failed-migrate-latch-owner.mjs).
let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqpwf@loom -c user.name=mqpwf";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqpwf-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-protect-write-failure (${tag})\n`);
  execSync(`git init -q && git config user.email mqpwf@loom && git config user.name mqpwf`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// Intercepts fs.openSync for any path shaped like a fresh pending-divert tmp write
// (`pending-<24hex>.json.tmp-<pid>-<hex>`, written by writePendingDivertFile) and throws EACCES. Returns
// a restore function and an interceptCount the caller can assert against.
function injectPendingDivertWriteFailure() {
  const real = fs.openSync;
  let interceptCount = 0;
  fs.openSync = (p, ...rest) => {
    if (typeof p === "string" && p.includes("pending-") && p.includes(".tmp-")) {
      interceptCount++;
      throw Object.assign(new Error("EACCES: simulated pending-divert write failure"), { code: "EACCES" });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.openSync = real; }, count: () => interceptCount };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO final-path — D's content lives directly at `final` (<Krhash>.json), genuinely ARMED
  // (active, not pending) via an explicit `resolvedKey` field — verified live: an unresolvable
  // repoPath's `.json` with NO `resolvedKey` always defers to `pendingUnresolvedQuarantines` at boot
  // (never armed), which would leave D's own identity untouched by clearMergeQuarantineByKey's
  // activeQuarantines-only eviction regardless of this card's fix — a non-discriminating fixture that
  // would never actually exercise the "D's in-memory entry already removed via keysToLift" bug shape.
  // `resolvedKey` is what makes PASS 1 arm it directly (`armedKeys` present) instead of deferring —
  // confirmed the `deleteMergeQuarantineLatchByKey` call reached here is the `foreignPending`-gated
  // direct `protectOccupantContentBeforeDelete` call, not `protectDegradedOccupantBeforeDelete` (which
  // never fires in this exact shape — `clearingRepoPath` is undefined whenever `entry` from
  // `clearMergeQuarantineByKey` is itself undefined for this key, as it is before this fixture's own
  // resolvedKey was added).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("fp-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir"); // never created — D's own repoPath, a nonexistent subdir of R
  check("(fp precondition) D (R/gone-subdir) never exists", !fs.existsSync(d));

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const finalPath = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  // D's own repoPath walks up to R's own real key Kr (D never exists), so this file IS D's own
  // self-consistent PRIMARY write target — no tmp residue, no migration, needed for this shape.
  // resolvedKey: Kr makes boot genuinely ARM D (active, armedKeys present), not merely defer it pending.
  fs.writeFileSync(finalPath, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token"], resolvedKey: Kr,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]); // `r` deliberately NOT registered — same posture as the d2582692 fixture
  check("(fp precondition) D is active in-memory after boot", !!activeMergeQuarantineFor(d));
  // Discriminator: D must be genuinely ARMED (armedKeys present), not merely "truthy because a pending
  // tier matched" — only an ARMED D is reachable through clearMergeQuarantineByKey's own
  // activeQuarantines-eviction logic, which is the exact shape this card's bug needs.
  check("(fp precondition) D is genuinely ARMED, not merely pending (armedKeys present)", (activeMergeQuarantineFor(d)?.armedKeys?.length ?? 0) > 0);
  check("(fp precondition) D's own file exists before the clear", fs.existsSync(finalPath));

  const inject = injectPendingDivertWriteFailure();
  let reportResult;
  try {
    reportResult = clearMergeQuarantineReporting(r); // clears R while D (foreign) occupies R's own key
  } finally {
    inject.restore();
  }
  check("(fp positive control) the protective write was actually attempted (and injected to fail)", inject.count() >= 1);
  // D is genuinely ARMED at R's own key (no pending entries at all exist yet in this fresh process), so
  // activeMergeQuarantineFor(r)'s own early "no pending entries" shortcut returns `direct` (D's entry)
  // for the query address R too — resolveQuarantineFor(r) sees it as truthy BEFORE the clear, so
  // clearMergeQuarantineReporting reports wasQuarantined:true — verified live against this exact
  // fixture (not guessed), not because R itself ever had its own entry.
  check("(fp sanity) the clear of R itself reports wasQuarantined:true (D occupied R's own key)", reportResult?.wasQuarantined === true);

  check("*** THE FIX (final-path) *** D's own file SURVIVES a failed protective write", fs.existsSync(finalPath));
  check("*** THE FIX (final-path) *** D's own content is still physically present (not overwritten/truncated)", (contentIfExists(finalPath) ?? "").includes("d-token"));
  // CR 66eab845, point 1(a): the occupant must stay enforced IN THIS PROCESS too, not only after a
  // later boot — assertRepoNotQuarantined(d) must block immediately, before any reboot.
  check("*** THE FIX (final-path) *** assertRepoNotQuarantined(d) BLOCKS in-process, before any reboot", assertRepoNotQuarantined(d).ok === false);

  // DURABLE — a fresh boot (new module instance) must still recover D's quarantine from the surviving file.
  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (final-path, restart) *** D's own token SURVIVES clearing R + a reboot", new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token"));
  check("*** THE FIX (final-path, restart) *** assertRepoNotQuarantined(d) STILL BLOCKS after the reboot", fresh.assertRepoNotQuarantined(d).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO final-path (positive control) — identical fixture, NO write injection: the pre-existing,
  // correct behavior (D's content is durably relocated, R's own file is cleanly removed) must be unchanged.
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
    enteredAt: Date.now(), tokens: ["d-token-ctrl"], resolvedKey: Kr,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  clearMergeQuarantineReporting(r); // no injection this time — the write must succeed normally

  check("(fp control) D's own token survives clearing R (relocated, not destroyed)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-ctrl"));
  check("(fp control) R's own original file is actually removed once the protective write succeeds", !fs.existsSync(finalPath));
  check("(fp control) D's content survives SOMEWHERE on disk under a new name", fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8").includes("d-token-ctrl")));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO tmp-path — the d2582692 R/D fixture: R's own genuine content lives at `final`, D's content
  // lives only in a `.tmp-999` residue. protectForeignTmpResidueBeforeSweep is what must exclude D's
  // own tmp filename from the subsequent unconditional sweep on a failed write.
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
    enteredAt: Date.now() - 30_000, tokens: ["r-token"],
  }, null, 2) + "\n");
  // D's own PASS 1b tmp residue — resolvedKey manufactured to equal D's OWN walked-up currentKey (Kr,
  // since D never exists and walks up to R) — a self-consistent, TAUTOLOGICAL primary arm.
  const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
  fs.writeFileSync(dTmpFile, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-tp"], resolvedKey: Kr,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  check("(tp precondition) R's own token survives D's tautological-primary-arm eviction", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("r-token"));
  check("(tp precondition) D's own token is active too", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-tp"));
  check("(tp precondition) D's own tmp residue is still on disk before the clear", fs.existsSync(dTmpFile));

  const inject = injectPendingDivertWriteFailure();
  try {
    clearMergeQuarantineReporting(r); // clears R while D (foreign) occupies R's own key via the tmp residue
  } finally {
    inject.restore();
  }
  check("(tp positive control) the protective write was actually attempted (and injected to fail)", inject.count() >= 1);

  check("*** THE FIX (tmp-path) *** D's own tmp residue SURVIVES a failed protective write", fs.existsSync(dTmpFile));
  check("*** THE FIX (tmp-path) *** D's own content is still physically present in the tmp residue", (contentIfExists(dTmpFile) ?? "").includes("d-token-tp"));
  check("*** THE FIX (tmp-path) *** R's own file is still cleanly removed (its own clear is unaffected by D's failure)", !fs.existsSync(rFile));
  // CR 66eab845, point 1(a) (tp-fail probe): must block IN-PROCESS too, before any reboot — round 1
  // only kept the file on disk but left D's tokens === [] / assertRepoNotQuarantined(d).ok === true.
  check("*** THE FIX (tmp-path) *** assertRepoNotQuarantined(d) BLOCKS in-process, before any reboot", assertRepoNotQuarantined(d).ok === false);

  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([]);
  check("*** THE FIX (tmp-path, restart) *** D's own token SURVIVES clearing R + a reboot", new Set(fresh.listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-tp"));
  check("*** THE FIX (tmp-path, restart) *** assertRepoNotQuarantined(d) STILL BLOCKS after the reboot", fresh.assertRepoNotQuarantined(d).ok === false);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO tp-fail-clearid — CR 66eab845, point 1(b): a clear-by-latch-id call reached DURING the
  // window (before any reboot, right after the failed protect) via a wholly DIFFERENT, independently-
  // reached call path (clearMergeQuarantineLatchFile) must not silently destroy D's kept tmp residue.
  //
  // Pre-fix (round 1), D had NO in-memory record at all, so this call fell into the raw "no entry
  // matches this id" fallback, which reported {ok:true, wasQuarantined:false, liftedRepoPaths:[]} (as if
  // nothing happened) while its OWN unconditional tmp sweep silently unlinked D's kept residue anyway —
  // verified live against commit 0e189a83 before writing this scenario.
  //
  // Post-fix (round 2), D's self-owned pending record means this SAME id now legitimately, unambiguously
  // identifies D's own record (R's own file is already gone — cleared moments earlier — so there is no
  // longer anything else at this id to confuse it with): clear-by-id now takes the ordinary, ACCOUNTED
  // pending-match path and genuinely lifts D, reporting wasQuarantined:true with D in liftedRepoPaths —
  // never the dishonest "nothing happened" shape paired with silent data loss. This is a BETTER outcome
  // than "D stays blocked after this call" (which would require NOT recognizing D as D's own record, a
  // regression) — a human/tool that already holds D's own reported latch id is entitled to clear it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const r = makeToplevelRepo("tp-clearid-r");
  const Kr = canonicalRepoLockKey(r);
  const Krhash = createHash("sha256").update(Kr).digest("hex").slice(0, 24);
  const d = path.join(r, "gone-subdir");

  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const rFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json`);
  fs.writeFileSync(rFile, JSON.stringify({
    repoPath: r, branch: "r-branch", reason: "R's own genuine, currently-active raise",
    enteredAt: Date.now() - 30_000, tokens: ["r-token-clearid"],
  }, null, 2) + "\n");
  const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
  fs.writeFileSync(dTmpFile, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-clearid"], resolvedKey: Kr,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  const inject = injectPendingDivertWriteFailure();
  try {
    clearMergeQuarantineReporting(r);
  } finally {
    inject.restore();
  }
  check("(tp-clearid positive control) the protective write was actually attempted (and injected to fail)", inject.count() >= 1);
  check("(tp-clearid precondition) D's own tmp residue survives the initial failed clear", fs.existsSync(dTmpFile));

  // THE CALL UNDER TEST — reached via a DIFFERENT, independent call path than the clear above.
  const clearIdResult = clearMergeQuarantineLatchFile(Krhash);
  check(
    "*** THE FIX (tp-fail-clearid) *** clear-by-id is now an HONEST, ACCOUNTED clear of D (never the old silent-destroy-while-reporting-nothing-happened shape)",
    clearIdResult?.ok === true && clearIdResult?.wasQuarantined === true && Array.isArray(clearIdResult?.liftedRepoPaths) && clearIdResult.liftedRepoPaths.includes(d),
  );
  // D is correctly, legitimately lifted by this call — its content is now genuinely gone, as a true
  // accounted consequence (not an accident the call's own return value failed to disclose).
  check("(tp-fail-clearid) D's tmp residue is gone, matching the ACCOUNTED lift this call reported", !fs.existsSync(dTmpFile));
  check("(tp-fail-clearid) assertRepoNotQuarantined(d) now correctly reports unblocked (it was genuinely, honestly cleared)", assertRepoNotQuarantined(d).ok === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO tmp-path (positive control) — identical fixture, NO write injection: matches the pre-
  // existing d2582692-clear-resolvable-protects-foreign-occupant scenario's own assertions.
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
    enteredAt: Date.now() - 30_000, tokens: ["r-token-ctrl"],
  }, null, 2) + "\n");
  const dTmpFile = path.join(MERGE_QUARANTINE_DIR, `${Krhash}.json.tmp-999`);
  fs.writeFileSync(dTmpFile, JSON.stringify({
    repoPath: d, branch: "d-branch", reason: "D's own degraded entry, walked up to R's own real key",
    enteredAt: Date.now(), tokens: ["d-token-tp-ctrl"], resolvedKey: Kr,
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([]);
  clearMergeQuarantineReporting(r); // no injection this time — the write must succeed normally

  check("(tp control) D's own token survives clearing R (relocated, not destroyed)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-tp-ctrl"));
  check("(tp control) D's own ORIGINAL tmp residue is swept once its content is durably copied aside", !fs.existsSync(dTmpFile));
  check("(tp control) D's content survives SOMEWHERE on disk under a new name", fs.readdirSync(MERGE_QUARANTINE_DIR).some((f) => fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8").includes("d-token-tp-ctrl")));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO c9114934-no-token-bleed-on-failed-protect — CR 2dd131b4, blocker B1. Reuses card c9114934's
  // own "in-memory-twin" fixture (merge-quarantine-pass1-migrate-union.mjs's own
  // `in-memory-twin-clear-destroys-degraded-file`): X, a manufactured collision, is unresolvable with
  // `resolvedKey` set to Y's own REAL canonical key Ky — at boot, `armQuarantineKey`'s own unconditional
  // in-memory union merges X (older, so the union keeps X's own identity) and Y (a genuinely resolvable
  // repo, migrating in from a separately-named stale source) into ONE live object at Ky, carrying BOTH
  // x-token and y-token — well before any clear ever runs (the pre-existing, deliberate in-memory union
  // card c9114934 itself names). Clearing Y (the resolvable side) reaches `final`'s own
  // `protectDegradedOccupantBeforeDelete` call with X's identity as the occupant to protect.
  //
  // THE BUG (round 2, pre-B1-fix): the failure branch's own `keptBase` unioned `toPersist` (clean, fresh
  // off `final`'s own disk bytes — X's own content, x-token only) against `priorAtFinal` — the SAME live,
  // already-contaminated union object `armQuarantineKey` bled y-token into at boot — durably (if the
  // write had succeeded) OR in-memory (on this exact failure path) re-bleeding y-token into X's own kept
  // record. `clearMergeQuarantineByToken(x, "x-token")` would then leave X still blocked by the phantom
  // y-token, and X's own kept file — once a later successful write ever lands it — durably carries a
  // token that was never legitimately X's own.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const y = path.join(os.tmpdir(), `loom-mqpwf-c9114934-y-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  tmpDirs.push(y);
  fs.writeFileSync(path.join(y, "README.md"), "# c9114934-no-token-bleed-on-failed-protect\n");
  execSync(`git init -q && git config user.email mqpwf@loom && git config user.name mqpwf`, { cwd: y });
  commitAll(y, "init", GIT_ID);
  const ky = canonicalRepoLockKey(y);
  const kyHash = createHash("sha256").update(ky).digest("hex").slice(0, 24);

  const x = path.join(os.tmpdir(), `loom-mqpwf-c9114934-x-never-exists-${freshSfx()}`);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const xFile = path.join(MERGE_QUARANTINE_DIR, `${kyHash}.json`);
  const yFile = path.join(MERGE_QUARANTINE_DIR, `stale-y-${freshSfx()}.json`);
  fs.writeFileSync(xFile, JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "X's own manufactured resolvedKey collision with Y",
    enteredAt: Date.now() - 60_000, tokens: ["x-token"], resolvedKey: ky,
  }, null, 2) + "\n");
  fs.writeFileSync(yFile, JSON.stringify({
    repoPath: y, branch: "y-branch", reason: "Y's real, genuine unconfirmed-kill reason", enteredAt: Date.now(), tokens: ["y-token"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBoot([y, x]);
  check("(c9114934 precondition) X's backing file exists before any clear", fs.existsSync(xFile));
  check("(c9114934 precondition) Y reads quarantined before any clear (the boot-time union)", !!activeMergeQuarantineFor(y));

  const inject = injectPendingDivertWriteFailure();
  try {
    clearMergeQuarantineReporting(y); // clears Y — reaches protectDegradedOccupantBeforeDelete for X's content at `final`
  } finally {
    inject.restore();
  }
  check("(c9114934 positive control) the protective write was actually attempted (and injected to fail)", inject.count() >= 1);
  check("(c9114934) Ky's shared physical file (X's own content) survives the failed protective write", fs.existsSync(xFile));

  const xAfterClear = activeMergeQuarantineFor(x);
  check("(c9114934) X is still enforced, findable by its own path, with its own token intact", !!xAfterClear && (xAfterClear.tokens ?? []).includes("x-token"));
  // *** THE FIX (B1) *** — the discriminating assertion: no bleed from the boot-time union, in-process,
  // immediately after the failed clear (no reboot, no successful write — the in-memory object itself).
  check("*** THE FIX (B1) *** X's kept record does NOT carry y-token in-process (no bleed from the boot-time union)", !((xAfterClear?.tokens ?? []).includes("y-token")));

  // clearMergeQuarantineByToken(x, "x-token") — pre-fix, the phantom y-token survives this and keeps X
  // blocked; post-fix, X's own record only ever held x-token, so this fully frees it.
  clearMergeQuarantineByToken(x, "x-token");
  const fresh = await freshBootModule();
  fresh.reenterMergeQuarantinesAtBoot([y, x]);
  check("*** THE FIX (B1) *** after clearByToken(x,'x-token') + a reboot, X is NOT blocked", fresh.assertRepoNotQuarantined(x).ok === true);
  check("*** THE FIX (B1) *** after clearByToken(x,'x-token') + a reboot, the already-cleared Y is NOT blocked either", fresh.assertRepoNotQuarantined(y).ok === true);
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a failed protective write before a clear-side delete/sweep now leaves the foreign " +
    "occupant's own source file (final OR tmp residue) on disk, self-owned via a fresh pending record, " +
    "instead of destroying it as collateral — enforced IN-PROCESS immediately (not only after a later " +
    "boot) on both the final-path and tmp-path shapes, and honoured by an independent clear-by-id call " +
    "reached during the same window (an honest, accounted clear, never a silent destroy); a successful " +
    "protective write still cleanly relocates the content and removes the original, exactly as before."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
