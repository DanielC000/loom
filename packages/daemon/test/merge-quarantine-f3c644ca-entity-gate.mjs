import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card f3c644ca -- `entryStillOwnsKey` (merge-quarantine.ts) treated ANY same-identity occupant as
// automatically "the same logical entry" -- bare `directPathIdentity` equality, no proof the two objects
// were actually related. That contradicts decision d4b25feb ("one identity can legitimately hold TWO
// INDEPENDENT records at once") -- a stale 883e29bc pending-divert twin whose own `armedKeys` still names
// a key a later, UNRELATED same-identity raise now genuinely owns gets wrongly treated as "still owning"
// that key, and every lift/write site gated on this predicate acts on it.
//
// SCENARIOS 1-2 ("LIFT A"/"LIFT B") are the reproduced bug: an independent pending record V (its own
// disjoint token) with a STALE `armedKeys` reference to key K, where K is genuinely, independently
// occupied by active entry W (its own disjoint token, same identity as V). Clearing V wrongly deletes W's
// map slot AND physically unlinks W's real latch file -- a full, DURABLE over-unblock, surviving a
// simulated reboot. RED on the bare-identity predicate; GREEN after the fix.
//
// ROUND 2 (Code Review): the fix's own FIRST shape (`entry ⊆ occupant || occupant ⊆ entry`, SYMMETRIC)
// reopened a DIFFERENT over-unblock. SCENARIO 3 is Code Review's own "probe A": W active with TWO
// outstanding tokens {s,u}; P pending, same identity, ONE token {s} (a SUBSET of W's), armedKeys [K] (W's
// own key). The AUTOMATIC settle-time clear (`clearMergeQuarantineByToken`, the route `git/worktrees.ts`/
// `git/batch-merge.ts` call when an op settles) runs the PENDING pass first; P's last token makes it a
// full lift, and under the symmetric gate `entryStillOwnsKey(K,P)` was `P ⊆ W` (true) -- wrongly lifting
// W's ENTIRE slot (and its physical latch) before the ACTIVE pass could reduce W to {u} on its own. `u`
// was lost, in memory AND after a reboot -- breaking this module's own token SET semantics (clearing one
// token must never lift while another is outstanding). THE FIX IS NOW SINGLE-DIRECTION,
// `occupant ⊆ entry` ONLY (never the reverse) -- scenario 3 asserts `u` SURVIVES this exact automatic
// clear, in memory and after reboot, and is verified (manual negative control, not committed) to go RED
// with the `entry ⊆ occupant` half restored.
//
// SCENARIO 4 replaces the ORIGINAL (round-1) scenario 3, which used `clearMergeQuarantineByKey` on an
// UNUSED key to "prove" `entry ⊆ occupant` was needed for clearability -- a shape no real clear route
// uses (Code Review's own finding). This scenario instead runs the REAL human clear routes
// (`clearMergeQuarantine`, both the resolvable and the by-recorded-path/unresolvable forms) against the
// SAME probe-A state and asserts each still fully lifts BOTH W and P -- clearability survives on
// `occupant ⊆ entry` alone, because these routes clear the ACTIVE entry directly (not through this
// predicate's own subset check at all for the primary target).
//
// SCENARIO 5 is the ONE direction the fix keeps: `occupant ⊆ entry` -- a legitimate rebuild where the
// PENDING twin is the bigger, current truth and the ACTIVE occupant is a smaller, already-subsumed
// snapshot. A human clear must still fully lift both.
//
// SCENARIO 6 pins `entryStillOwnsKey`'s own defensive non-empty-tokens clause: an empty token set is
// vacuously a subset of anything, which would silently reopen the identity-only hole for a pathological
// zero-token occupant -- a state no real code path can produce (every construction path seeds >=1
// token), so it is injected directly into the real `activeQuarantines` map via the new
// `setActiveQuarantineTestOnly` test-only seam.
//
// SCENARIO 7 is a plain regression sanity check: an ORDINARY multi-token raise/partial-clear/full-clear
// sequence (reference-equality-covered at every step) stays fully clearable.
//
// Probe G (pre-existing, same general class, OUTSIDE this predicate) was found by Code Review and carded
// separately -- not fixed here.
//
// See docs/decisions/8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md, Follow-up f3c644ca.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-f3c644ca-entity-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mqfeg-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const {
  enterMergeQuarantine, clearMergeQuarantine, clearMergeQuarantineByKey, clearMergeQuarantineByToken,
  clearMergeQuarantineByRecordedPath, reenterMergeQuarantinesAtBootTestOnly, reenterMergeQuarantinesAtBoot,
  listActiveMergeQuarantines, activeMergeQuarantineFor, setActiveQuarantineTestOnly, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(repoLockModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

// Writes W's own real latch file directly at K's deterministic filename -- picked up by PASS1 as an
// ordinary, resolvable, independent entry. Never raised (no 8a1bc2ef pending-absorb to interfere).
function parkWAt(key, repoPath, tag, tokens) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`), JSON.stringify({
    repoPath, branch: `${tag}-branch`, reason: `${tag}: real latch`, tokens, enteredAt: Date.now() - 20_000,
  }, null, 2) + "\n");
}

function injectV(repoPath, tag, tokens, armedKeys) {
  const entry = { repoPath, branch: `${tag}-branch`, reason: `${tag}: injected pending`, enteredAt: Date.now() - 5_000, tokens, armedKeys };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry, sourceFile: `pending-${tag}-test.json` }]);
}

function freshY(tag) {
  const y = path.join(os.tmpdir(), `loom-mqfeg-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  return y;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("f3c644ca-lift-a-clearbykey")
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("y1");
  const k = canonicalRepoLockKey(y);

  parkWAt(k, y, "f3c-w1", ["w1-token"]);
  injectV(y, "f3c-v1", ["v1-token"], [k]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  check("(precondition) W is genuinely active at K, independent of V", listActiveMergeQuarantines().some((e) => e.tokens.includes("w1-token")));
  check("(precondition) V is pending, disjoint tokens from W", listActiveMergeQuarantines().some((e) => e.tokens.includes("v1-token")));

  const unusedKey = `f3c-unused-${freshSfx()}`;
  clearMergeQuarantineByKey(unusedKey, y);

  check("*** THE FIX *** W survives in-memory (w1-token still outstanding)", listActiveMergeQuarantines().some((e) => e.tokens.includes("w1-token")));
  check("*** THE FIX *** activeFor(Y) is still true in-memory", !!activeMergeQuarantineFor(y));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** THE FIX *** W's latch survives a reboot (w1-token still enforced)", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("w1-token")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 ("f3c644ca-lift-b-clearbytoken")
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("y2");
  const k = canonicalRepoLockKey(y);

  parkWAt(k, y, "f3c-w2", ["w2-token"]);
  injectV(y, "f3c-v2", ["v2-token"], [k]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  check("(precondition) W is genuinely active at K, independent of V", listActiveMergeQuarantines().some((e) => e.tokens.includes("w2-token")));

  clearMergeQuarantineByToken(y, "v2-token");

  check("*** THE FIX *** W survives in-memory (w2-token still outstanding)", listActiveMergeQuarantines().some((e) => e.tokens.includes("w2-token")));
  check("*** THE FIX *** activeFor(Y) is still true in-memory", !!activeMergeQuarantineFor(y));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** THE FIX *** W's latch survives a reboot (w2-token still enforced)", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("w2-token")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 ("f3c644ca-probe-a-auto-clear-preserves-other-token") -- Code Review's own probe A. W is
// active with TWO outstanding tokens {s,u}; P is pending, same identity, carrying only {s} (a SUBSET of
// W's own tokens), with a STALE `armedKeys:[K]` naming W's own key. The AUTOMATIC settle-time clear for
// token "s" must drop P (whose own token is genuinely gone) WITHOUT touching W's OTHER, still-outstanding
// token "u" -- this is the module's own token SET semantics invariant, and exactly what the round-1
// symmetric gate's `entry ⊆ occupant` direction broke (P ⊆ W wrongly lifted W's whole slot).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("y3");
  const k = canonicalRepoLockKey(y);

  parkWAt(k, y, "f3c-w3", ["s3-token", "u3-token"]);
  injectV(y, "f3c-p3", ["s3-token"], [k]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  check("(precondition) W carries both tokens", listActiveMergeQuarantines().some((e) => e.tokens.includes("s3-token") && e.tokens.includes("u3-token")));
  check("(precondition) P carries only the shared token", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "s3-token"));

  // The REAL automatic route: worktrees.ts/batch-merge.ts call this when an op settles.
  clearMergeQuarantineByToken(y, "s3-token");

  check("*** THE FIX (round 2) *** P's own token is gone", !listActiveMergeQuarantines().some((e) => e.tokens.includes("s3-token") && e.tokens.length === 1));
  check("*** THE FIX (round 2) *** W's OTHER token (u3-token) SURVIVES in-memory", listActiveMergeQuarantines().some((e) => e.tokens.includes("u3-token")));
  check("*** THE FIX (round 2) *** activeFor(Y) is still true (u3-token still outstanding)", !!activeMergeQuarantineFor(y));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** THE FIX (round 2) *** u3-token survives a reboot too", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("u3-token")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 ("f3c644ca-real-clear-routes-still-fully-lift") -- the REWRITE of the original (round-1)
// scenario 3, which used `clearMergeQuarantineByKey` on an UNUSED key to argue `entry ⊆ occupant` was
// needed for clearability -- a shape no real clear route takes (Code Review's own finding). This
// scenario runs the REAL human clear routes against probe A's own state (fresh instances) and asserts
// each still fully lifts BOTH sides, with `occupant ⊆ entry` alone.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  // 4a: clearMergeQuarantine(y) on a RESOLVABLE y -> clearMergeQuarantineByKey.
  const y = freshY("y4a");
  const k = canonicalRepoLockKey(y);
  parkWAt(k, y, "f3c-w4a", ["s4a-token", "u4a-token"]);
  injectV(y, "f3c-p4a", ["s4a-token"], [k]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  clearMergeQuarantine(y);
  check("*** CLEARABILITY (4a, resolvable clearMergeQuarantine) *** fully lifted in-memory", !activeMergeQuarantineFor(y));
  check("*** CLEARABILITY (4a) *** no token survives in-memory", !listActiveMergeQuarantines().some((e) => e.tokens.includes("s4a-token") || e.tokens.includes("u4a-token")));
  const rb4a = await rebootSim();
  rb4a.reenterMergeQuarantinesAtBoot([y]);
  check("*** CLEARABILITY (4a) *** stays fully lifted after a reboot", !rb4a.activeMergeQuarantineFor(y));
}
{
  // 4b: clearMergeQuarantineByRecordedPath(y) directly (the broad, identity-wide human route).
  const y = freshY("y4b");
  const k = canonicalRepoLockKey(y);
  parkWAt(k, y, "f3c-w4b", ["s4b-token", "u4b-token"]);
  injectV(y, "f3c-p4b", ["s4b-token"], [k]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  clearMergeQuarantineByRecordedPath(y);
  check("*** CLEARABILITY (4b, clearMergeQuarantineByRecordedPath) *** fully lifted in-memory", !activeMergeQuarantineFor(y));
  check("*** CLEARABILITY (4b) *** no token survives in-memory", !listActiveMergeQuarantines().some((e) => e.tokens.includes("s4b-token") || e.tokens.includes("u4b-token")));
  const rb4b = await rebootSim();
  rb4b.reenterMergeQuarantinesAtBoot([y]);
  check("*** CLEARABILITY (4b) *** stays fully lifted after a reboot", !rb4b.activeMergeQuarantineFor(y));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 5 ("f3c644ca-clearability-occupant-subset-entry") -- the ONE direction the fix keeps:
// `occupant ⊆ entry`. W (occupant) is the stale, SMALLER snapshot; P (entry) is the bigger, current
// truth that already incorporated W's own token via an earlier fold. A human clear must still fully
// lift both.
//
// Deliberately still uses `clearMergeQuarantineByKey` on an UNUSED key -- this is NOT the round-1
// mistake (claiming that shape proves a direction is NEEDED for real-route clearability; SCENARIO 4
// already proves that, with real routes, on real routes). This scenario instead ISOLATES the ONE kept
// branch itself: any REAL route that targets W's own identity clears W directly via its own primary
// `keysToLift` step before V's own armedKeys-lift loop ever runs, which would make the assertion pass
// trivially without the `occupant ⊆ entry` check ever firing at all. The unused key is what keeps V's
// own lift loop -- and so this one branch -- the thing actually under test.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("y5");
  const k = canonicalRepoLockKey(y);

  parkWAt(k, y, "f3c-w5", ["shared5-token"]); // occupant: the stale, smaller snapshot
  injectV(y, "f3c-v5", ["shared5-token", "v5-only-token"], [k]); // entry: bigger, current truth
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  check("(precondition) W carries only the shared token", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "shared5-token"));
  check("(precondition) V carries both tokens", listActiveMergeQuarantines().some((e) => e.tokens.includes("shared5-token") && e.tokens.includes("v5-only-token")));

  const unusedKey = `f3c-unused5-${freshSfx()}`;
  clearMergeQuarantineByKey(unusedKey, y);

  check("*** CLEARABILITY (occupant⊆entry) *** W's own token is ALSO lifted (no stuck residual)", !listActiveMergeQuarantines().some((e) => e.tokens.includes("shared5-token")));
  check("*** CLEARABILITY (occupant⊆entry) *** activeFor(Y) is false -- fully cleared", !activeMergeQuarantineFor(y));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** CLEARABILITY (occupant⊆entry) *** nothing resurrects after a reboot", !rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("shared5-token") || e.tokens.includes("v5-only-token")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 6 ("f3c644ca-empty-tokens-guard-pin") -- pins the non-empty-tokens clause. W is a synthetic,
// pathological occupant with EMPTY tokens -- no real code path can produce this (every construction path
// seeds >=1 token) -- injected directly into the real `activeQuarantines` map via
// `setActiveQuarantineTestOnly`. Without the guard, `[].every(...)` is vacuously `true`, so ANY entry
// would wrongly be treated as "still owning" K.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("y6");
  const k = canonicalRepoLockKey(y);

  setActiveQuarantineTestOnly(k, { repoPath: y, branch: "f3c-empty-ghost", reason: "f3c6: synthetic empty-token occupant", enteredAt: Date.now(), tokens: [] });
  injectV(y, "f3c-p6", ["p6-token"], [k]);

  check("(precondition) the empty-token ghost occupies K", listActiveMergeQuarantines().some((e) => e.branch === "f3c-empty-ghost"));

  const unusedKey = `f3c-unused6-${freshSfx()}`;
  clearMergeQuarantineByKey(unusedKey, y);

  check("*** GUARD (non-empty tokens) *** the empty-token ghost at K is left UNTOUCHED", listActiveMergeQuarantines().some((e) => e.branch === "f3c-empty-ghost"));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 7 ("f3c644ca-ordinary-multi-raise-stays-clearable") -- plain regression sanity.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("y7");

  const t1 = enterMergeQuarantine(y, "f3c-rebuild-branch", "f3c-rebuild-reason-1");
  const t2 = enterMergeQuarantine(y, "f3c-rebuild-branch", "f3c-rebuild-reason-2");
  check("(precondition) both tokens outstanding after two raises", listActiveMergeQuarantines().some((e) => e.tokens.includes(t1) && e.tokens.includes(t2)));

  clearMergeQuarantineByToken(y, t1);
  check("(precondition) partial clear leaves the other token outstanding", listActiveMergeQuarantines().some((e) => e.tokens.includes(t2)) && !listActiveMergeQuarantines().some((e) => e.tokens.includes(t1)));
  check("(precondition) still quarantined after the partial clear", !!activeMergeQuarantineFor(y));

  clearMergeQuarantine(y);
  check("*** no regression *** fully clearable after the fix", !activeMergeQuarantineFor(y));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** no regression *** stays clear after a reboot", !rb.activeMergeQuarantineFor(y));
}

console.log(failures === 0
  ? "\n✅ ALL SCENARIOS PASS -- entryStillOwnsKey's single-direction (occupant⊆entry) token-subset gate "
    + "rejects an independent same-identity record (no over-unblock) and preserves the module's own token "
    + "SET semantics (the automatic settle-time clear never lifts one outstanding token's clear onto "
    + "another), while still letting every legitimate rebuild clear fully (no stuck quarantine)."
  : `\n❌ ${failures} CHECK(S) FAILED -- reproduces board card f3c644ca.`);
process.exit(failures === 0 ? 0 : 1);
