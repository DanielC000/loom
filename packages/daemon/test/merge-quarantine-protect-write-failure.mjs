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
  // confirmed the `deleteMergeQuarantineLatchByKey` call reached here IS `protectDegradedOccupantBeforeDelete`
  // (card 182c01cc round 2: stale comment fix). D is genuinely ARMED at R's own key, so `entry` (D's own
  // object) is DEFINED and its `repoPath` (d) differs from `identityRepoPath` (r) — `clearingRepoPath`
  // is therefore SET, not undefined, which is exactly what routes this call through
  // `protectDegradedOccupantBeforeDelete`, never the `foreignPending`-gated direct call (that one needs
  // a PENDING record sharing this exact filename, which D is not — D is active here).
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

  // Card 182c01cc, DOUBLE-FAULT branch: the protective write itself failed, so D survives only as an
  // in-memory-only self-owned record at its OWN old name — protectOccupantContentBeforeDelete must still
  // name it in `stillBlockedCoOccupants`, not just keep it enforced silently.
  check("*** THE FIX (182c01cc, final-path double-fault) *** stillBlockedCoOccupants names D", Array.isArray(reportResult?.stillBlockedCoOccupants) && reportResult.stillBlockedCoOccupants.some((c) => c.repoPath === d));
  const coFp = reportResult?.stillBlockedCoOccupants?.find((c) => c.repoPath === d);
  check("*** THE FIX (182c01cc) *** D's own route names both a repoPath and a 24-hex id form", coFp?.route?.repoPath === d && /^[0-9a-f]{24}$/.test(coFp?.route?.id ?? ""));
  // Card 182c01cc, round 2, M4 (CR test-gap): CORRECTED after the (AE) finding in
  // merge-quarantine-clear-by-path.mjs applies here too — `survivingSharedClaimRepoPaths` has a SECOND
  // half (a self-referencing `orphanLatchFiles` hit), and the double-fault branch's own `kept` object
  // self-references `finalBasename` in its OWN `orphanLatchFiles` by design — so `sharedClaimants` DOES
  // independently find D here too, via that self-reference, and latchKept is genuinely TRUE (D's old
  // file really is still enforced, unconfirmed-removed). The double-fault's own `persisted` push and
  // this self-reference happen to name the EXACT SAME filename in this shape (the write never moved
  // anywhere — it failed), so the real discriminator is the ROUND-2 DEDUPE: D must still be named
  // exactly ONCE, never twice, even though two independent mechanisms both found it.
  check("*** THE FIX (182c01cc, M4) *** latchKept is TRUE (sharedClaimants' own orphanLatchFiles self-reference also finds D here)", reportResult?.latchKept === true);
  check("*** THE FIX (182c01cc, M4 dedupe) *** D is named EXACTLY ONCE, never duplicated across kept+relocated", reportResult?.stillBlockedCoOccupants?.filter((c) => c.repoPath === d).length === 1);

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

  // *** ROUND 4 (Code Review CR3, MAJOR) *** — a double-fault is KEPT at its own real file, never
  // RELOCATED: nothing new was ever minted, so route.id === alsoClear.id (and a false "clear id X FIRST,
  // THEN id X" text) was the bug, not a feature. Asserted against the ORIGINAL (first) module instance,
  // BEFORE the restart checks above consume nothing (they use a SEPARATE `fresh` import) — D's own entry
  // here is still live and unconsumed.
  check("*** THE FIX (round 4, final-path double-fault) *** no alsoClear — exactly one route, not two", coFp?.alsoClear === undefined);
  check("*** THE FIX (round 4, final-path double-fault) *** reason never claims a relocation that never happened", !(reportResult?.reason ?? "").includes("RELOCATED") && !(reportResult?.reason ?? "").includes("just removed"));
  // ONE clear of the fold's own named route.id genuinely lifts D — never needs (and must never offer) a
  // second id, since nothing was ever relocated to a different name.
  const oneClearFp = clearMergeQuarantineLatchFile(coFp.route.id);
  check("*** THE FIX (round 4, final-path double-fault) *** ONE clear of the named id lifts D", oneClearFp?.ok === true && oneClearFp?.wasQuarantined === true && (oneClearFp?.liftedRepoPaths ?? []).includes(d));
  check("(final-path, round 4) D now reads as genuinely unblocked after that one clear", assertRepoNotQuarantined(d).ok === true);
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
  const reportResultCtrl = clearMergeQuarantineReporting(r); // no injection this time — the write must succeed normally

  check("(fp control) D's own token survives clearing R (relocated, not destroyed)", new Set(listActiveMergeQuarantines().flatMap((q) => q.tokens ?? [])).has("d-token-ctrl"));
  check("(fp control) R's own original file is actually removed once the protective write succeeds", !fs.existsSync(finalPath));
  // Card 182c01cc, MINT branch: D has no pre-existing pending record anywhere (first discovery) — the
  // successful protective write mints an independent record, and stillBlockedCoOccupants must name it.
  // (The route's own actionability is already proven by (AD1) in merge-quarantine-clear-by-path.mjs —
  // don't clear D here, or the "survives SOMEWHERE on disk" check just below would false-fail.)
  check("*** THE FIX (182c01cc, final-path mint) *** stillBlockedCoOccupants names D", Array.isArray(reportResultCtrl?.stillBlockedCoOccupants) && reportResultCtrl.stillBlockedCoOccupants.some((c) => c.repoPath === d));
  const coFpCtrl = reportResultCtrl?.stillBlockedCoOccupants?.find((c) => c.repoPath === d);
  check("*** THE FIX (182c01cc) *** D's own route names both a repoPath and a 24-hex id form", coFpCtrl?.route?.repoPath === d && /^[0-9a-f]{24}$/.test(coFpCtrl?.route?.id ?? ""));
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
  let tpResult;
  try {
    tpResult = clearMergeQuarantineReporting(r); // clears R while D (foreign) occupies R's own key via the tmp residue
  } finally {
    inject.restore();
  }
  check("(tp positive control) the protective write was actually attempted (and injected to fail)", inject.count() >= 1);

  // Card 182c01cc, round 2, finding 1 (THE EXACT shape the Code Review named): D's content sits ONLY in
  // the `.json.tmp-<pid>` residue, reached via protectForeignTmpResidueBeforeSweep — which used to
  // discard its own protect call's result entirely. This double-fault sub-case (write injected to fail)
  // keeps D at its OWN old tmp filename.
  check("*** THE FIX (182c01cc, tmp-path double-fault) *** stillBlockedCoOccupants names D", Array.isArray(tpResult?.stillBlockedCoOccupants) && tpResult.stillBlockedCoOccupants.some((c) => c.repoPath === d));
  check("*** THE FIX (182c01cc) *** D's own route names both a repoPath and a 24-hex id form", (() => {
    const co = tpResult?.stillBlockedCoOccupants?.find((c) => c.repoPath === d);
    return co?.route?.repoPath === d && /^[0-9a-f]{24}$/.test(co?.route?.id ?? "");
  })());
  // Card 182c01cc, round 2, M4 — R's own file IS cleanly unlinked here (R's own clear is unaffected by
  // D's failure, per the pre-existing assertion just below), so `keptClaimants` (which is keyed on
  // `finalBasename`, R's own file) never finds D. **CORRECTED, round 4**: this does NOT mean latchKept is
  // absent — round 2 wrongly assumed D's own name here could only ever come from a RELOCATION; round 4's
  // fix correctly buckets D's double-fault (it genuinely stays kept, at its OWN tmp filename, a DIFFERENT
  // file than `finalBasename`) as kept too, via `protectForeignTmpResidueBeforeSweep`'s own now-split
  // `{kept, relocated}` return — so `latchKept:true` is the CORRECT outcome, with D named in
  // `referencingRepoPaths` at its own (not R's) filename.
  check("*** THE FIX (round 4, 182c01cc M4 corrected) *** latchKept is TRUE — D's double-fault is genuinely kept, at its OWN tmp file", tpResult?.latchKept === true && (tpResult?.referencingRepoPaths ?? []).includes(d));

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

  // *** ROUND 4 (Code Review CR3, MAJOR) *** — same discriminator as the final-path double-fault above,
  // for the tmp-residue shape: the .tmp residue genuinely SURVIVES at its OWN name (never removed), so
  // this must never be reported as a relocation either. Asserted against the ORIGINAL module instance.
  const coTp = tpResult?.stillBlockedCoOccupants?.find((c) => c.repoPath === d);
  check("*** THE FIX (round 4, tmp-path double-fault) *** no alsoClear — exactly one route, not two", coTp?.alsoClear === undefined);
  check("*** THE FIX (round 4, tmp-path double-fault) *** reason never claims a relocation that never happened", !(tpResult?.reason ?? "").includes("RELOCATED") && !(tpResult?.reason ?? "").includes("just removed"));
  const oneClearTp = clearMergeQuarantineLatchFile(coTp.route.id);
  check("*** THE FIX (round 4, tmp-path double-fault) *** ONE clear of the named id lifts D", oneClearTp?.ok === true && oneClearTp?.wasQuarantined === true && (oneClearTp?.liftedRepoPaths ?? []).includes(d));
  check("(tmp-path, round 4) D now reads as genuinely unblocked after that one clear", assertRepoNotQuarantined(d).ok === true);
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
  const tpCtrlResult = clearMergeQuarantineReporting(r); // no injection this time — the write must succeed normally

  // Card 182c01cc, round 2, finding 1 — THE EXACT repro the Code Review named (R real, D's own content
  // ONLY in a tmp residue, NO injected failure): protectForeignTmpResidueBeforeSweep's own successful
  // relocation used to be discarded entirely, so this call returned a bare {wasQuarantined:true} with
  // no stillBlockedCoOccupants even though D was genuinely still blocked.
  check("*** THE FIX (182c01cc, tmp-path mint) *** stillBlockedCoOccupants names D", Array.isArray(tpCtrlResult?.stillBlockedCoOccupants) && tpCtrlResult.stillBlockedCoOccupants.some((c) => c.repoPath === d));
  check("*** THE FIX (182c01cc) *** latchKept is ABSENT (D's old tmp residue is genuinely gone, relocated — never \"kept\")", tpCtrlResult?.latchKept === undefined);
  check("*** THE FIX (182c01cc) *** assertRepoNotQuarantined(d) still correctly BLOCKS (the field addition changes reporting only, never lift/keep behavior)", assertRepoNotQuarantined(d).ok === false);

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

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO cr3-m3 — card 182c01cc round 4, CR3 untested-site findings (b)/(c): the CR's own probe
  // construction (P unresolvable at boot, armed at a SYNTHETIC resolvedKey K — an 883e29bc-shaped raw
  // twin, deliberately NEVER mkdir'd — stays unresolvable the whole scenario, unlike (AH) in
  // merge-quarantine-clear-by-path.mjs); X's foreign record written to hash(K).json AFTER boot (a fresh
  // mint, never a re-point). `clearMergeQuarantineReporting(p)` then dispatches via `clearMergeQuarantine`
  // to `clearMergeQuarantineByRecordedPath` (p stays unresolvable the whole time) — NEVER
  // `clearMergeQuarantineByKey` directly — reaching this card's (c) site: `clearMergeQuarantineReporting`'s
  // own `latchKept` branch, composing onto a reason `clearMergeQuarantineByRecordedPath` ALREADY composed
  // (the compose-ONCE fix, m3). With the pending-divert write injected to fail, X's own protect call
  // double-faults — reaching this card's (b) site: `clearMergeQuarantineByRecordedPath`'s own
  // kept/relocated split-and-recombine of its delegated `clearMergeQuarantineByKey` result (never reached
  // when p is resolvable, since that dispatches straight to ByKey and never enters this function at all).
  //
  // MEASURED (not assumed): in THIS exact construction, X's double-fault is bucketed as PURELY kept (no
  // relocation at all — nothing else here ever mints a NEW latch), so `mergeKeptAndRelocatedCoOccupant`
  // itself (the literal combine call inside site (b), for ONE repoPath independently found in BOTH
  // buckets) is NOT invoked — confirmed via a temporary debug instrument during development, not
  // asserted blind. What IS genuinely exercised, and controlled below: `clearMergeQuarantineByRecordedPath`'s
  // own `splitCoOccupants` call, its `keptReferencingRepoPaths`/`relocatedCoOccupants` Map-building, and
  // the `combinedRelocated`/final-return assembly (site (b)'s surrounding machinery) — and
  // `clearMergeQuarantineReporting`'s own compose-once branch (site (c)) with a REAL already-composed
  // base reason to not double onto. See this card's own decision record, "Round 4" section, for why a
  // construction that ALSO drives `mergeKeptAndRelocatedCoOccupant` itself was not found.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const p = path.join(os.tmpdir(), `loom-mqpwf-cr3m3-p-${freshSfx()}`); // never created — stays unresolvable
  const k = "loom-mqpwf-cr3m3-synthetic-key";
  const khash = createHash("sha256").update(k).digest("hex").slice(0, 24);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "mqpwf-cr3m3-p-twin.json"), JSON.stringify({
    repoPath: p, branch: "p-branch", reason: "P — cr3-m3, armed at a synthetic resolvedKey K", enteredAt: Date.now(),
    tokens: ["p-cr3m3-token"], resolvedKey: k, armedKeys: [k],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([p]);
  check("(cr3-m3 precondition) P reads as blocked right after this boot", !!activeMergeQuarantineFor(p));

  const x = path.join(os.tmpdir(), `loom-mqpwf-cr3m3-x-never-${freshSfx()}`);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${khash}.json`), JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "X — cr3-m3, foreign, written AFTER boot", enteredAt: Date.now(), tokens: ["x-cr3m3-token"],
  }, null, 2) + "\n");
  check("(cr3-m3 precondition) X is NOT yet known to memory before the clear (never scanned)", !activeMergeQuarantineFor(x));
  check("(cr3-m3 precondition) p is genuinely unresolvable (never created)", !fs.existsSync(p));

  const inject = injectPendingDivertWriteFailure();
  let rr;
  try { rr = clearMergeQuarantineReporting(p); } finally { inject.restore(); }
  check("(cr3-m3 positive control) the protective write was actually attempted (and injected to fail)", inject.count() >= 1);

  check("*** THE FIX (cr3-m3, sites b+c) *** stillBlockedCoOccupants names X via the ByRecordedPath dispatch", Array.isArray(rr?.stillBlockedCoOccupants) && rr.stillBlockedCoOccupants.some((c) => c.repoPath === x));
  const coCr3m3 = rr?.stillBlockedCoOccupants?.find((c) => c.repoPath === x);
  check("*** THE FIX (round 4, cr3-m3) *** no alsoClear (double-fault stays kept, never relocated)", coCr3m3?.alsoClear === undefined);
  check("(cr3-m3) latchKept is true, X named in referencingRepoPaths", rr?.latchKept === true && (rr?.referencingRepoPaths ?? []).includes(x));
  // *** THE FIX (c): compose-ONCE *** — `clearMergeQuarantineByRecordedPath`'s own reason ALREADY
  // composes everything; `clearMergeQuarantineReporting`'s latchKept branch must pass it through
  // UNCHANGED, never compose a SECOND time on top. A pre-round-3-m3-fix regression would double any
  // relocated clause present — here there is none to double, so the discriminating assertion is that
  // the base `keptReason` clause itself (identifiable by its own "stays on disk" wording) appears
  // EXACTLY ONCE, never duplicated wholesale.
  check("*** THE FIX (round 4, cr3-m3, m3 compose-once) *** the base reason clause appears exactly once, never doubled", ((rr?.reason ?? "").split("stays on disk").length - 1) === 1);
  check("*** THE FIX (round 4, cr3-m3) *** reason never claims a relocation that never happened", !(rr?.reason ?? "").includes("RELOCATED") && !(rr?.reason ?? "").includes("just removed"));

  // ONE clear of the fold's own named route.id genuinely lifts X.
  const oneClearCr3m3 = clearMergeQuarantineLatchFile(coCr3m3.route.id);
  check("*** THE FIX (round 4, cr3-m3) *** ONE clear of the named id lifts X", oneClearCr3m3?.ok === true && oneClearCr3m3?.wasQuarantined === true && (oneClearCr3m3?.liftedRepoPaths ?? []).includes(x));
  check("(cr3-m3) X now reads as genuinely unblocked after that one clear", assertRepoNotQuarantined(x).ok === true);
  }

  // Positive control (no injection): the SAME p/k/x shape, but the protective write succeeds — a clean
  // relocation through the ByRecordedPath dispatch, never latchKept, never a doubled clause (nothing to
  // double in the first place — this is the baseline the injected case above is contrasted against).
  {
  const p = path.join(os.tmpdir(), `loom-mqpwf-cr3m3ctrl-p-${freshSfx()}`);
  const k = "loom-mqpwf-cr3m3ctrl-synthetic-key";
  const khash = createHash("sha256").update(k).digest("hex").slice(0, 24);
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, "mqpwf-cr3m3ctrl-p-twin.json"), JSON.stringify({
    repoPath: p, branch: "p-branch", reason: "P — cr3-m3 control", enteredAt: Date.now(), tokens: ["p-cr3m3ctrl-token"], resolvedKey: k, armedKeys: [k],
  }, null, 2) + "\n");
  reenterMergeQuarantinesAtBoot([p]);
  const x = path.join(os.tmpdir(), `loom-mqpwf-cr3m3ctrl-x-never-${freshSfx()}`);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${khash}.json`), JSON.stringify({
    repoPath: x, branch: "x-branch", reason: "X — cr3-m3 control, foreign, written AFTER boot", enteredAt: Date.now(), tokens: ["x-cr3m3ctrl-token"],
  }, null, 2) + "\n");

  const rrCtrl = clearMergeQuarantineReporting(p); // no injection this time
  check("(cr3-m3 control) stillBlockedCoOccupants names X", Array.isArray(rrCtrl?.stillBlockedCoOccupants) && rrCtrl.stillBlockedCoOccupants.some((c) => c.repoPath === x));
  check("(cr3-m3 control) latchKept is absent (a clean mint, never kept)", rrCtrl?.latchKept === undefined);
  check("(cr3-m3 control) reason correctly DOES say RELOCATED (a genuine mint, unlike the injected case above)", (rrCtrl?.reason ?? "").includes("RELOCATED"));
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
