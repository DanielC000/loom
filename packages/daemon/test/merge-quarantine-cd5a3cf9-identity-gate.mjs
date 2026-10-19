import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card cd5a3cf9 -- `protectOccupantContentBeforeDelete`'s own `atFilenameIdx`/`atFinalBasenameIdx`
// matched a `pendingUnresolvedQuarantines` slot by STRING EQUALITY of `sourceFile` alone, with NO check
// that the matched slot's own identity (`repoPath`) was the SAME identity as the occupant being
// protected. Decision 8db913e2's own Follow-ups 6451a749/37452ddd introduced both match branches
// specifically to catch an `883e29bc` boot-diverted TWIN -- every one of THEIR OWN fixtures constructed
// that twin to genuinely be the SAME identity as the occupant. This card is the first to walk a
// DIFFERENT identity's own boot-time bookkeeping record into a basename collision with an unrelated
// occupant: clearing one key (Kc2) of identity Y's own two independently-armed keys (Kb, Kc2) protects a
// wholly foreign occupant (Z2) physically sitting at Kc2's own hash -- and a basename match found Y's OWN
// pending bookkeeping twin (still armed at Kb), not Z2's. The unconditional
// `replaceEntryEverywhere(activeQuarantines, Y's object, Z2's content)` then spliced Z2's content into
// every key Y's object was armed at (Kb), destroying Y's own quarantine at a key the clear never touched
// -- CRITICAL over-unblock. **IN-PROCESS**, for this shape (see SCENARIO 1's own note on why a reboot
// cannot discriminate this particular fixture).
//
// THE FIX: gate every union/re-point use of `atFilenameIdx`/`atFinalBasenameIdx`'s matched entry on
// `directPathIdentity(matched.repoPath) === directPathIdentity(toPersist.repoPath)` (`toPersist`'s own
// identity, captured BEFORE any union/mutation -- Lesson 196). On a mismatch the matched slot is left
// completely untouched (no union, no re-point, no splice/overwrite) and the occupant's own protective
// copy falls through to the pre-existing, already-tested "mint an independent record" `else` shape
// (decision 1922be3a -- Lesson 198: the SAME code path the "no match at all" case already used).
//
// SIX gate sites guard this fix (TS source line numbers, re-verify against the real file -- these drift):
//   :2158 atFilenameIdx's own union-as-source               -- SCENARIO 2 (and SCENARIO 4's own setup)
//   :2192 double-fault fallback's re-point                  -- SCENARIO 3
//   :2218 outer branch selection (atFilenameSameIdentity)    -- SCENARIO 4
//   :2220 inner re-point when BOTH indices matched           -- SCENARIO 4
//   :2222 inner splice when BOTH indices matched             -- NOT independently testable, see below
//   :2223 `else if` branch selection (atFinalBasenameIdx only) -- SCENARIO 1
// Each of the first five was independently reverted (Code Review, one gate at a time) and confirmed to
// turn at least one of these scenarios RED, confirming every assertion below is load-bearing, not
// vacuous. :2222 (the splice, inside the BOTH-matched branch, guarding only whether the mismatched
// twin's OWN pendingUnresolvedQuarantines slot is removed) has NO observable effect when reverted alone:
// with :2220 intact, the mismatched twin's `activeQuarantines` arming is never re-pointed, so it keeps
// enforcing via the ACTIVE side regardless of whether its PENDING array slot is also spliced away --
// `listActiveMergeQuarantines` dedupes by object reference across both structures, so losing only the
// pending-side bookkeeping reference changes nothing observable. Confirmed directly (Code Review): with
// ONLY :2222 reverted, SCENARIO 4 stays fully GREEN.
//
// See docs/decisions/8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md, Follow-up cd5a3cf9.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-cd5a3cf9-identity-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqcig-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBootTestOnly, reenterMergeQuarantinesAtBoot, clearMergeQuarantineByKey,
  MERGE_QUARANTINE_DIR, listActiveMergeQuarantines, assertRepoNotQuarantined,
} = await import(mergeQuarantineModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

// Mirrors merge-quarantine.ts's own `pendingDivertFilenameFor` (unexported) -- a repoPath's deterministic
// pending-divert filename, hashed from its directPathIdentity (realpath, lowercased on win32). Same
// helper merge-quarantine-raise-protect-failure.mjs already carries under this exact name.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

// Intercepts fs.openSync for any path shaped like a fresh pending-divert tmp write (written by
// writePendingDivertFile) and throws EACCES -- same technique, same shape of path match, as
// merge-quarantine-protect-write-failure.mjs's own `injectPendingDivertWriteFailure`.
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

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

function parkedAnchor(repoPath, resolvedKey, tag) {
  const parkKey = `cd5a3cf9-park-${tag}-${freshSfx()}`;
  const file = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(parkKey)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    repoPath, branch: `${tag}-branch`, reason: `${tag}: parked`,
    enteredAt: Date.now() - 90_000, tokens: [`${tag}-token`], resolvedKey,
  }, null, 2) + "\n");
  return file;
}
function foreignAt(atKey, pointsAt, repoPath, tag) {
  const file = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(atKey)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    repoPath, branch: `${tag}-branch`, reason: `${tag}: foreign`,
    enteredAt: Date.now() - 30_000, tokens: [`${tag}-token`], resolvedKey: pointsAt,
  }, null, 2) + "\n");
  return file;
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("cd5a3cf9-cross-identity-twin-not-clobbered") -- the card's own repro. W1@Kb and W3@Kc2 are
// TWO INDEPENDENT active anchors of the SAME identity Y, with NO pending entry naming Kb at all. Z2 is a
// wholly foreign occupant physically at hash(Kc2), its own resolvedKey -> Kb. Clearing Kc2 (W3's own key)
// must leave Kb (W1, Y's own OTHER key) completely untouched. Exercises the `:2223` `else if` gate.
//
// THE DEFECT HERE IS IN-PROCESS ONLY, NOT REBOOT-DISCRIMINATING, for this exact shape (Code Review
// confirmed): the reboot checks below PASS whether or not the fix is applied, because Y's own parked
// file genuinely survives either way (confirmed: nothing in real production deletes or skips a repo's
// own pre-existing quarantine backing file just because a boot ran -- boot's own documented policy for
// an unresolvable repoPath explicitly "leaves the latch file AS WRITTEN rather than risk
// migrating/deleting it"). They are labelled DURABILITY checks below, not regression checks -- they
// prove Z2's/Y's own content survives a reboot in this shape, never that THIS gate fired. Do not read
// their PASS as discriminating evidence for the fix; only the in-process checks do that (and are proven
// so by Code Review's own single-gate reverts).
//
// NOTE, diverging from the card's own repro script by design: its script discards the "parked" bootstrap
// files right after the first boot, to simulate "boot already consumed them". That discard is itself an
// ARTIFACT of the test harness, not of real boot behaviour -- verified directly (Code Review confirmed
// this too): re-running the card's own exact script WITH vs WITHOUT that discard step (same fix, same
// build) showed Y correctly surviving the reboot when the discard is omitted, and Z2 wrongly occupying Kb
// when it is not. This scenario leaves the parked files in place, matching what boot's own documented
// policy actually guarantees, rather than inheriting an unrelated test-harness artifact.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = path.join(os.tmpdir(), `loom-mqcig-y-never-${freshSfx()}`);
  const z2 = path.join(os.tmpdir(), `loom-mqcig-z2-never-${freshSfx()}`);
  const kb = `cd5a3cf9-kb-${freshSfx()}`;
  const kc2 = `cd5a3cf9-kc2-${freshSfx()}`;

  parkedAnchor(y, kb, "w1");
  parkedAnchor(y, kc2, "w3");
  foreignAt(kc2, kb, z2, "z2");
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  const before = listActiveMergeQuarantines();
  check("(precondition) Y is armed at Kb", before.some((e) => e.branch === "w1-branch" && (e.armedKeys ?? []).includes(kb)));
  check("(precondition) Y is armed at Kc2", before.some((e) => e.branch === "w3-branch" && (e.armedKeys ?? []).includes(kc2)));
  check("(precondition) Y reads blocked before the clear", !assertRepoNotQuarantined(y).ok);

  // Clear Kc2 (W3's own key) -- Kb/Y is a completely separate, untouched active anchor.
  clearMergeQuarantineByKey(kc2, y);

  const after = listActiveMergeQuarantines();
  const kbOccupant = after.find((e) => (e.armedKeys ?? []).includes(kb));
  check("*** THE FIX (in-process, :2223) *** Kb's own occupant is STILL Y (never swapped for Z2's content)",
    kbOccupant?.repoPath === y);
  check("*** THE FIX (in-process, :2223) *** Y still reads blocked in-process", !assertRepoNotQuarantined(y).ok);
  const z2Pending = fs.readdirSync(MERGE_QUARANTINE_DIR)
    .filter((f) => f.startsWith("pending-"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")))
    .find((e) => e.repoPath === z2);
  check("Z2's own protective copy is minted, carrying Z2's own token intact (never Y's)",
    !!z2Pending && (z2Pending.tokens ?? []).includes("z2-token") && !(z2Pending.tokens ?? []).includes("w1-token"));

  const freshR = await rebootSim();
  freshR.reenterMergeQuarantinesAtBoot([]);
  const afterReboot = freshR.listActiveMergeQuarantines();
  const kbOccupantReboot = afterReboot.find((e) => (e.armedKeys ?? []).includes(kb));
  check("(durability, non-discriminating -- passes pre-fix too, see header) Kb's own occupant is Y after a fresh-process reboot",
    kbOccupantReboot?.repoPath === y);
  check("(durability, non-discriminating -- passes pre-fix too, see header) Y still reads blocked after reboot",
    !freshR.assertRepoNotQuarantined(y).ok);
  const z2PendingReboot = fs.readdirSync(MERGE_QUARANTINE_DIR)
    .filter((f) => f.startsWith("pending-"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")))
    .find((e) => e.repoPath === z2);
  check("(durability, non-discriminating) Z2's own token survives the reboot too (protected content not lost)",
    !!z2PendingReboot && (z2PendingReboot.tokens ?? []).includes("z2-token"));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 ("cd5a3cf9-atfilenameidx-mismatch-defensive") -- the LATENT (a) channel: `atFilenameIdx`
// matches by `sourceFile === filename`, where `filename` is `pendingDivertFilenameFor(occupantRepoPath)`
// -- a content-hash of the OCCUPANT's OWN identity. A genuinely different identity's record can only
// ever land at that exact string via a true SHA-256 collision (not constructible), so this shape is NOT
// reachable through any real boot/raise/clear code path found during investigation -- constructed here
// ONLY via the `reenterMergeQuarantinesAtBootTestOnly` direct-injection seam (`testOnlyInjectUnprotectedPending`,
// a raw, unconditional push with no identity validation of its own), to verify the SAME identity gate
// defends this call site too, in depth, even though nothing in production can reach it today. Exercises
// the `:2158` union-as-source gate.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = path.join(os.tmpdir(), `loom-mqcig-y2-never-${freshSfx()}`);
  const z2 = path.join(os.tmpdir(), `loom-mqcig-z2b-never-${freshSfx()}`);
  const q = path.join(os.tmpdir(), `loom-mqcig-q-never-${freshSfx()}`);
  const kb = `cd5a3cf9b-kb-${freshSfx()}`;
  const kc2 = `cd5a3cf9b-kc2-${freshSfx()}`;

  parkedAnchor(y, kb, "w1b");
  parkedAnchor(y, kc2, "w3b");
  foreignAt(kc2, kb, z2, "z2b");

  const z2OwnFilename = pendingDivertFilenameForTest(z2);
  check("(precondition) nothing already sits at Z2's own pending-divert filename on disk",
    !fs.existsSync(path.join(MERGE_QUARANTINE_DIR, z2OwnFilename)));

  // Direct injection: Q is a WHOLLY UNRELATED identity, hand-placed at the EXACT sourceFile Z2's own
  // protective copy will resolve to -- never possible via a real boot/raise, per this scenario's own
  // header.
  reenterMergeQuarantinesAtBootTestOnly([y], [
    { entry: { repoPath: q, branch: "q-branch", reason: "injected mismatched twin", enteredAt: Date.now(), tokens: ["q-token"] }, sourceFile: z2OwnFilename },
  ]);

  check("(precondition) Q's own injected record is visible, pending-only", listActiveMergeQuarantines().some((e) => e.repoPath === q && (e.tokens ?? []).includes("q-token")));

  clearMergeQuarantineByKey(kc2, y);

  const after = listActiveMergeQuarantines();
  check("*** THE FIX (:2158) *** Q's own injected record SURVIVES untouched (never clobbered by Z2's content)",
    after.some((e) => e.repoPath === q && (e.tokens ?? []).includes("q-token") && !(e.tokens ?? []).includes("z2b-token")));
  check("*** THE FIX (:2158) *** Z2's own protective copy is minted as an INDEPENDENT record, never merged with Q",
    after.some((e) => e.repoPath === z2 && (e.tokens ?? []).includes("z2b-token") && !(e.tokens ?? []).includes("q-token")));
  check("Z2's own protective copy lands at the SAME reconciled filename, on disk, carrying Z2's own content",
    (() => {
      const p = path.join(MERGE_QUARANTINE_DIR, z2OwnFilename);
      if (!fs.existsSync(p)) return false;
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      return parsed.repoPath === z2 && (parsed.tokens ?? []).includes("z2b-token") && !(parsed.tokens ?? []).includes("q-token");
    })());
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 ("cd5a3cf9-double-fault-mismatch") -- Code Review's own case (a). Exercises the `:2192`
// gate inside the double-fault fallback branch (the DURABLE write to `filename` itself fails). Same base
// fixture as SCENARIO 1 (Y armed at Kb/Kc2, Z2 foreign at hash(Kc2) resolvedKey -> Kb), plus an injected
// `fs.openSync` EACCES failure on the pending-divert tmp write (same technique as
// merge-quarantine-protect-write-failure.mjs), forcing `writePendingDivertFile` to fail and the
// double-fault branch to run. `atFinalBasenameIdx` still matches Y's mismatched twin there -- without the
// `:2192` gate, the double-fault's own `replaceEntryEverywhere(activeQuarantines, Y's object, kept)`
// clobbers Kb exactly like the primary bug, just reached via the write-failure leg instead.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = path.join(os.tmpdir(), `loom-mqcig-y3-never-${freshSfx()}`);
  const z2 = path.join(os.tmpdir(), `loom-mqcig-z2c-never-${freshSfx()}`);
  const kb = `cd5a3cf9c-kb-${freshSfx()}`;
  const kc2 = `cd5a3cf9c-kc2-${freshSfx()}`;

  parkedAnchor(y, kb, "w1c");
  parkedAnchor(y, kc2, "w3c");
  const z2File = foreignAt(kc2, kb, z2, "z2c");
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  check("(precondition) Y is armed at Kb", listActiveMergeQuarantines().some((e) => e.branch === "w1c-branch" && (e.armedKeys ?? []).includes(kb)));
  check("(precondition) Y reads blocked before the clear", !assertRepoNotQuarantined(y).ok);

  const inj = injectPendingDivertWriteFailure();
  let clearResult;
  try {
    clearResult = clearMergeQuarantineByKey(kc2, y);
  } finally {
    inj.restore();
  }
  check("(precondition) the pending-divert write was genuinely intercepted", inj.count() > 0);

  const after = listActiveMergeQuarantines();
  const kbOccupant = after.find((e) => (e.armedKeys ?? []).includes(kb));
  check("*** THE FIX (:2192, double-fault leg) *** Kb's own occupant is STILL Y (never swapped for kept Z2 content)",
    kbOccupant?.repoPath === y);
  check("*** THE FIX (:2192, double-fault leg) *** Y still reads blocked in-process", !assertRepoNotQuarantined(y).ok);
  check("Z2's own original physical file is left exactly as-is (never unlinked on a failed protective write)",
    fs.existsSync(z2File) && JSON.parse(fs.readFileSync(z2File, "utf8")).repoPath === z2);
  check("Z2 itself stays enforced in THIS PROCESS too (the double-fault's own self-owned 'kept' record)",
    !assertRepoNotQuarantined(z2).ok);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 ("cd5a3cf9-both-matched-mismatch") -- Code Review's own case (b). Exercises the `:2218`
// outer branch AND the `:2220` inner re-point gate, for the shape where `atFilenameIdx` matches the
// OCCUPANT's OWN identity (Z2, genuinely a twin -- same as any ordinary same-identity case) WHILE
// `atFinalBasenameIdx` STILL matches Y's foreign, mismatched twin. Setup: SCENARIO 1's fixture, plus a
// pre-existing `pending-<hash(Z2)>.json` file for Z2 ALREADY on disk before boot (mirroring a prior,
// still-outstanding raise for the same occupant) -- PASS 1 scans it filename-agnostically and tracks it
// as Z2's own pending record, so `atFilenameIdx` now finds a GENUINE Z2 twin (safe to union/re-point) at
// the exact same time `atFinalBasenameIdx` finds Y's mismatched one (must NOT be touched). Without the
// `:2220` gate, the SECOND `replaceEntryEverywhere` call (fired unconditionally once `atFilenameIdx`
// already matched) clobbers Kb exactly like the primary bug, reached via the BOTH-matched leg instead.
//
// `:2222` (the sibling splice, same `if`-condition, guarding only whether Y's own pending-array slot is
// REMOVED) is reverted here too, in isolation, as its own check: Code Review confirmed — and this
// scenario reproduces — that it has NO observable effect on its own. With `:2220` intact (so Y's
// `activeQuarantines` arming is never re-pointed), Y keeps enforcing via the ACTIVE side regardless of
// whether its PENDING array slot also survives; `listActiveMergeQuarantines` dedupes by object reference
// across both structures, so losing only the pending-side bookkeeping entry changes nothing this (or any
// other) scenario can observe. Not independently testable for that reason — documented, not asserted.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = path.join(os.tmpdir(), `loom-mqcig-y4-never-${freshSfx()}`);
  const z2 = path.join(os.tmpdir(), `loom-mqcig-z2d-never-${freshSfx()}`);
  const kb = `cd5a3cf9d-kb-${freshSfx()}`;
  const kc2 = `cd5a3cf9d-kc2-${freshSfx()}`;

  parkedAnchor(y, kb, "w1d");
  parkedAnchor(y, kc2, "w3d");
  foreignAt(kc2, kb, z2, "z2d");

  // Z2's own PRE-EXISTING pending record, already on disk before boot -- the SAME identity as the
  // occupant being protected later, so `atFilenameIdx` will correctly match it as a genuine twin.
  const z2PreFilename = pendingDivertFilenameForTest(z2);
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, z2PreFilename), JSON.stringify({
    repoPath: z2, branch: "z2d-pre-branch", reason: "z2d: pre-existing pending", enteredAt: Date.now() - 60_000, tokens: ["z2d-pre-token"],
  }, null, 2) + "\n");

  reenterMergeQuarantinesAtBootTestOnly([y], []);
  check("(precondition) Y is armed at Kb", listActiveMergeQuarantines().some((e) => e.branch === "w1d-branch" && (e.armedKeys ?? []).includes(kb)));
  check("(precondition) Z2's own pre-existing pending record is tracked, pending-only",
    listActiveMergeQuarantines().some((e) => e.repoPath === z2 && (e.tokens ?? []).includes("z2d-pre-token")));

  clearMergeQuarantineByKey(kc2, y);

  const after = listActiveMergeQuarantines();
  const kbOccupant = after.find((e) => (e.armedKeys ?? []).includes(kb));
  check("*** THE FIX (:2218/:2220, both-matched leg) *** Kb's own occupant is STILL Y",
    kbOccupant?.repoPath === y);
  check("*** THE FIX (:2218/:2220, both-matched leg) *** Y still reads blocked in-process", !assertRepoNotQuarantined(y).ok);
  check("Z2's own pre-existing AND fresh tokens are unioned into ONE record (the genuine same-identity twin union still works)",
    after.some((e) => e.repoPath === z2 && (e.tokens ?? []).includes("z2d-pre-token") && (e.tokens ?? []).includes("z2d-token")));
}

console.log(failures === 0
  ? "\n✅ ALL SCENARIOS PASS -- a basename match in protectOccupantContentBeforeDelete is never trusted as "
    + "same-identity without a verified directPathIdentity check; a mismatch leaves the matched slot "
    + "completely untouched and mints the occupant's own protective copy as an independent record."
  : `\n❌ ${failures} CHECK(S) FAILED -- reproduces board card cd5a3cf9.`);
process.exit(failures === 0 ? 0 : 1);
