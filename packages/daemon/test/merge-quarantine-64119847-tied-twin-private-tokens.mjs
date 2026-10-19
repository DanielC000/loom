import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 64119847 — a tied pending twin's own PRIVATE token (one not actually part of what an active
// entry's clear is lifting) was durably lost — both in-memory and across a reboot — by
// `clearMergeQuarantineByKey`'s pending-filter. "Tied" there meant one of FOUR OR-branches
// (`p.entry === entry`, a shared armed key, an orphan-file reference, or a proven token subset) — but
// only the first and last actually PROVE nothing is lost by fully removing the pending entry. The other
// two (a shared armed key, an orphan-file reference) are purely STRUCTURAL and were swept WHOLE anyway.
//
// PROBE G (found by a Code Reviewer, through the `reenterMergeQuarantinesAtBootTestOnly` inject seam):
// W active at key K, tokens {s}. P pending, same identity, tokens {s,v}, armedKeys [K]. Clearing token s
// (`clearMergeQuarantineByToken`) reduces P to {v} first (the by-token pending pass), then fully clears
// W — which delegates to `clearMergeQuarantineByKey`. Its pending-filter ties P via the armedKeys-overlap
// branch alone and swept it WHOLE, durably losing v.
//
// SCENARIO 1 reproduces probe G exactly (the armedKeys-overlap branch) and asserts the FIX's full
// contract: v survives (in-memory AND across a reboot), P's `armedKeys` is left UNTOUCHED (the Lead's own
// mid-review correction — a reduced twin keeps every key it was armed on, exactly as it was, since
// stripping a key out from under a still-outstanding token would let that key admit merges while the
// token is outstanding, the SAME over-unblock one level down), K is STILL BLOCKED for real merge
// admission (via `assertRepoNotQuarantined`, the one shared refusal check every canonical-mutating entry
// point calls — never just "the entry exists"), and a LATER `clearMergeQuarantineByToken(y, "v-token")`
// fully lifts K.
//
// SCENARIO 2 is the SAME shape through the SECOND defective branch — the orphan-file reference — isolated
// from the armedKeys-overlap branch (P's own armedKeys is deliberately empty here) so each branch's own
// fix is independently proven, not just proven in combination.
//
// SCENARIO 3 is the clearability guarantee: the BROAD human route (`clearMergeQuarantineByRecordedPath`)
// must still fully lift BOTH W and a tied, token-bearing P — the reduce-not-drop fix must never regress
// "a human clear still fully lifts" (decision 8db913e2; this module's own stated human-route contract:
// "a human resolving this by hand does not necessarily hold (or need) every outstanding token").
//
// SCENARIO 4 proves the BY-KEY route (`clearMergeQuarantine` on a resolvable path — no broad sweep of its
// own, unlike scenario 3's route) reaches the SAME core fix: a tied P's private token correctly SURVIVES
// there too (this is the correct behavior, not a residual bug — the broad human route is what's for
// "clear away everything regardless"), and that the broad route can still fully lift it afterward.
//
// See docs/decisions/64119847-tied-pending-twin-private-tokens-survive.md.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-64119847-tied-twin-private-tokens.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq64119847-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const {
  clearMergeQuarantineByToken, clearMergeQuarantine, clearMergeQuarantineByRecordedPath,
  reenterMergeQuarantinesAtBootTestOnly, reenterMergeQuarantinesAtBoot, setActiveQuarantineTestOnly,
  listActiveMergeQuarantines, activeMergeQuarantineFor, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(repoLockModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

// Writes W's own real latch file directly at K's deterministic filename — picked up by PASS1 as an
// ordinary, resolvable, independent entry (never raised, so no 8a1bc2ef pending-absorb interferes).
function parkWAt(key, repoPath, tag, tokens, orphanLatchFiles) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`), JSON.stringify({
    repoPath, branch: `${tag}-branch`, reason: `${tag}: real latch`, tokens, orphanLatchFiles, enteredAt: Date.now() - 20_000,
  }, null, 2) + "\n");
}

// Injects P directly into pendingUnresolvedQuarantines via the real test-only boot seam.
function injectP(repoPath, tag, tokens, armedKeys, sourceFile) {
  const entry = { repoPath, branch: `${tag}-branch`, reason: `${tag}: injected pending`, enteredAt: Date.now() - 5_000, tokens, armedKeys };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry, sourceFile: sourceFile ?? `pending-${tag}-test.json` }]);
}

function freshY(tag) {
  const y = path.join(os.tmpdir(), `loom-mq64119847-${tag}-${freshSfx()}`);
  fs.mkdirSync(y, { recursive: true });
  return y;
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 ("64119847-armedkeys-overlap-private-token-survives") — probe G exactly.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("s1");
  const k = canonicalRepoLockKey(y);

  parkWAt(k, y, "64119847-w1", ["s1-token"]);
  injectP(y, "64119847-p1", ["s1-token", "v1-token"], [k]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  // ⚠️ Do NOT call `assertRepoNotQuarantined`/`activeMergeQuarantineFor` as a precondition check here —
  // while W (active, verified) and P (pending, sharing K via armedKeys) coexist, that "read-only" query
  // has a real side effect: `activeMergeQuarantineFor`'s cross-tier-sibling-absorb branch (card 8a1bc2ef)
  // UNIONS P into W right there, destroying the separate-twin setup this scenario exists to exercise
  // before the real clear under test ever runs. `listActiveMergeQuarantines()` is a pure read and safe.
  check("(precondition) W active with s1-token only", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "s1-token"));
  check("(precondition) P pending with both s1-token and v1-token", listActiveMergeQuarantines().some((e) => e.tokens.includes("s1-token") && e.tokens.includes("v1-token")));

  clearMergeQuarantineByToken(y, "s1-token");

  const pAfter = listActiveMergeQuarantines().find((e) => e.tokens.includes("v1-token"));
  check("*** THE FIX *** v1-token survives in-memory", !!pAfter);
  check("*** THE FIX *** s1-token is actually gone (not just hidden)", !listActiveMergeQuarantines().some((e) => e.tokens.includes("s1-token")));
  // Pins the ONLY mechanism that makes this true: replaceEntryEverywhere's own in-place `p.entry =
  // newEntry` mutation (see its doc) is what makes the LIVE pendingUnresolvedQuarantines slot reflect the
  // reduced token set — there is no separate reassignment in clearMergeQuarantineByKey's own pending-
  // filter. If that mutation were ever made non-mutating (a copy instead of an in-place write), the live
  // slot would still hold P's ORIGINAL, un-reduced tokens and this exact check would go RED.
  check("*** MECHANISM *** the in-memory pending entry's own tokens are EXACTLY the reduced set {v1-token}, not a stale superset", JSON.stringify([...pAfter.tokens].sort()) === JSON.stringify(["v1-token"]));
  check("*** THE FIX (Lead correction) *** P's armedKeys is left UNTOUCHED (still names K)", !!pAfter?.armedKeys?.includes(k));
  check("*** THE FIX *** K is STILL BLOCKED for real merge admission (assertRepoNotQuarantined, not just \"the entry exists\")", assertRepoNotQuarantined(y).ok === false);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  const pAfterReboot = rb.listActiveMergeQuarantines().find((e) => e.tokens.includes("v1-token"));
  check("*** THE FIX *** v1-token survives a reboot too", !!pAfterReboot);
  check("*** THE FIX *** K is still blocked after a reboot too", rb.assertRepoNotQuarantined(y).ok === false);

  // Now fully clear it — a later clear of the surviving private token must still fully lift K.
  rb.clearMergeQuarantineByToken(y, "v1-token");
  check("*** CLEARABILITY *** clearing the surviving private token fully lifts K in-memory", rb.assertRepoNotQuarantined(y).ok === true);
  const rb2 = await rebootSim();
  rb2.reenterMergeQuarantinesAtBoot([y]);
  check("*** CLEARABILITY *** K stays lifted after a further reboot", rb2.assertRepoNotQuarantined(y).ok === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 ("64119847-orphanref-private-token-survives") — the SAME shape through the orphan-file
// reference branch, isolated from armedKeys-overlap (P's own armedKeys is deliberately empty).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("s2");
  const k = canonicalRepoLockKey(y);
  const orphanFile = "custom-orphan-64119847-s2.json";

  parkWAt(k, y, "64119847-w2", ["s2-token"], [orphanFile]);
  injectP(y, "64119847-p2", ["s2-token", "v2-token"], [], orphanFile);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  check("(precondition) W active, orphanLatchFiles references the shared file", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "s2-token" && e.orphanLatchFiles?.includes(orphanFile)));
  check("(precondition) P pending with both tokens, armedKeys EMPTY", listActiveMergeQuarantines().some((e) => e.tokens.includes("s2-token") && e.tokens.includes("v2-token") && e.armedKeys.length === 0));

  clearMergeQuarantineByToken(y, "s2-token");

  check("*** THE FIX (orphanLatchFiles branch) *** v2-token survives in-memory", listActiveMergeQuarantines().some((e) => e.tokens.includes("v2-token")));
  check("*** THE FIX *** K is still blocked for real merge admission", assertRepoNotQuarantined(y).ok === false);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** THE FIX *** v2-token survives a reboot too", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("v2-token")));

  rb.clearMergeQuarantineByToken(y, "v2-token");
  check("*** CLEARABILITY *** clearing the surviving private token fully lifts it", rb.assertRepoNotQuarantined(y).ok === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 ("64119847-human-clear-by-recorded-path-still-fully-lifts") — the broad human route must
// still fully lift BOTH W and a tied, token-bearing P.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("s3");
  const k = canonicalRepoLockKey(y);

  parkWAt(k, y, "64119847-w3", ["s3-token"]);
  injectP(y, "64119847-p3", ["s3-token", "v3-token"], [k]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  // ⚠️ Same trap as scenario 1 — no `assertRepoNotQuarantined`/`activeMergeQuarantineFor` precondition
  // call here (would silently absorb P into W before the real clear under test ever runs).
  check("(precondition) W active, P pending, both present before the human clear", listActiveMergeQuarantines().some((e) => e.tokens.includes("s3-token")) && listActiveMergeQuarantines().some((e) => e.tokens.includes("v3-token")));

  clearMergeQuarantineByRecordedPath(y);
  check("*** CLEARABILITY (human route) *** fully lifted in-memory", assertRepoNotQuarantined(y).ok === true);
  check("*** CLEARABILITY *** no token survives in-memory", !listActiveMergeQuarantines().some((e) => e.tokens.includes("s3-token") || e.tokens.includes("v3-token")));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** CLEARABILITY *** stays fully lifted after a reboot", rb.assertRepoNotQuarantined(y).ok === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 ("64119847-by-key-route-private-token-survives") — the BY-KEY route reaches the SAME core
// fix: `clearMergeQuarantine(y)` on a resolvable path delegates DIRECTLY to `clearMergeQuarantineByKey`
// (no broad, unconditional pending sweep of its own — that is `clearMergeQuarantineByRecordedPath`'s
// job, exercised in scenario 3). It only ever clears W's OWN current token set, so a tied P's private
// token (never part of that set) must survive here too, exactly like the by-token route in scenario 1 —
// `clearMergeQuarantineReporting` (the real human REST wrapper) is designed to truthfully report "still
// quarantined" in exactly this case, never to fake a success.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("s4");
  const k = canonicalRepoLockKey(y);

  parkWAt(k, y, "64119847-w4", ["s4-token"]);
  injectP(y, "64119847-p4", ["s4-token", "v4-token"], [k]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  clearMergeQuarantine(y);
  check("*** THE FIX (by-key route) *** v4-token survives in-memory", listActiveMergeQuarantines().some((e) => e.tokens.includes("v4-token")));
  check("*** THE FIX *** s4-token is actually gone", !listActiveMergeQuarantines().some((e) => e.tokens.includes("s4-token")));
  check("*** THE FIX *** K is still blocked (v4-token outstanding) — this is CORRECT, not a residual bug", assertRepoNotQuarantined(y).ok === false);

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** THE FIX *** v4-token survives a reboot too", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("v4-token")));

  // Now the human, broad route fully lifts whatever remains — no token is EVER permanently stuck.
  const fullyLifted = rb.clearMergeQuarantineByRecordedPath(y);
  check("*** CLEARABILITY *** the broad human route still fully lifts the surviving private token", fullyLifted.wasQuarantined === true && rb.assertRepoNotQuarantined(y).ok === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIOS 5-6 ("64119847-reduce-path-durable-writes-...") — a Code Reviewer found that disabling
// EITHER of the reduce path's two real durable writes (the armed-key `writeMergeQuarantineLatch` loop,
// or the `rewriteOrphanLatchFilesAfterPartialClear` call) left scenarios 1-4 fully GREEN — neither one
// ever exercises a SECOND armed key P genuinely occupies (as the SAME object, the 883e29bc dual-tracked-
// twin shape), nor an orphan file P's OWN `orphanLatchFiles` names. These scenarios pin both: P is armed
// at BOTH K (tied to W's clear) and K2 (its own separate key, dual-tracked — same object reference, via
// `setActiveQuarantineTestOnly`), and carries its own `orphanLatchFiles: [F]`. After the clear, K2's own
// physical latch AND F's own physical latch must each hold EXACTLY the reduced token set on disk — not
// merely "some truthy state" — and a reboot must not resurrect the lifted token.
//
// SCENARIO 5 drives it via the by-key route (`clearMergeQuarantine`); SCENARIO 6 drives the IDENTICAL
// shape via the by-token route (`clearMergeQuarantineByToken`) to confirm both routes reach the same two
// writes (both delegate to the same `clearMergeQuarantineByKey` core).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
function buildDualTrackedTwin(tag, sTokens, vToken) {
  const y = freshY(tag);
  const k = canonicalRepoLockKey(y);
  const k2 = `${tag}-k2-${freshSfx()}`;
  const orphanFile = `custom-orphan-64119847-${tag}.json`;
  const pendingSourceFile = `pending-64119847-${tag}-test.json`;

  parkWAt(k, y, `64119847-${tag}-w`, sTokens);

  const pEntry = {
    repoPath: y, branch: `64119847-${tag}-p-branch`, reason: `64119847-${tag}: dual-tracked pending`,
    enteredAt: Date.now() - 5_000, tokens: [...sTokens, vToken], armedKeys: [k, k2],
    orphanLatchFiles: [orphanFile],
  };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: pEntry, sourceFile: pendingSourceFile }]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  // dual-track P at K2 AFTER boot settles — setActiveQuarantineTestOnly is in-memory-only (no disk I/O),
  // mirroring the 883e29bc shape without a real raise.
  setActiveQuarantineTestOnly(k2, pEntry);

  // F: the folded orphan file — written AFTER boot's own directory scan (never before it), or PASS1's own
  // stale-key migration logic (97cff6db) finds this parseable, y-identified content sitting under an
  // unexpected filename and migrates/folds it into W's real latch BEFORE the clear under test ever runs,
  // corrupting the very precondition this scenario depends on. Nothing in the clear-time code that reads
  // `orphanLatchFiles` needs boot to have discovered this file in advance — it reads the named file live.
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, orphanFile), JSON.stringify({
    repoPath: y, branch: pEntry.branch, reason: "folded orphan copy", tokens: [...pEntry.tokens], enteredAt: pEntry.enteredAt,
  }, null, 2) + "\n");

  return { y, k, k2, orphanFile };
}

function readLatchTokens(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")).tokens;
}

// Never throws — a missing/unparsable file (e.g. under a negative control that disables the write
// entirely) reports as a clean FAIL via `check`, not a crashed process that aborts every later scenario.
function readLatchTokensSafe(filePath) {
  try {
    return readLatchTokens(filePath);
  } catch {
    return null;
  }
}

{
  const { y, k2, orphanFile } = buildDualTrackedTwin("s5", ["s5-token"], "v5-token");
  const k2Path = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);
  const fPath = path.join(MERGE_QUARANTINE_DIR, orphanFile);

  check("(precondition) W active with s5-token only", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "s5-token"));
  check("(precondition) P pending+dual-tracked at K2, both tokens, own orphanLatchFiles", listActiveMergeQuarantines().some((e) => e.tokens.includes("s5-token") && e.tokens.includes("v5-token") && e.armedKeys.includes(k2) && e.orphanLatchFiles?.includes(orphanFile)));
  check("(precondition) F's own physical latch exists with the ORIGINAL tokens {s5,v5}", JSON.stringify(readLatchTokens(fPath).sort()) === JSON.stringify(["s5-token", "v5-token"]));

  clearMergeQuarantine(y); // by-key route

  check("*** THE WRITE (armed-key loop) *** K2's own on-disk latch holds EXACTLY {v5-token}", JSON.stringify((readLatchTokensSafe(k2Path) ?? []).sort()) === JSON.stringify(["v5-token"]));
  check("*** THE WRITE (rewriteOrphanLatchFilesAfterPartialClear) *** F's own on-disk latch holds EXACTLY {v5-token}", JSON.stringify((readLatchTokensSafe(fPath) ?? []).sort()) === JSON.stringify(["v5-token"]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** REBOOT *** s5-token does NOT come back", !rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("s5-token")));
  check("*** REBOOT *** v5-token survives", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("v5-token")));
}

{
  const { y, k2, orphanFile } = buildDualTrackedTwin("s6", ["s6-token"], "v6-token");
  const k2Path = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);
  const fPath = path.join(MERGE_QUARANTINE_DIR, orphanFile);

  check("(precondition, by-token) W active with s6-token only", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "s6-token"));

  clearMergeQuarantineByToken(y, "s6-token"); // by-token route -- same core delegation

  check("*** THE WRITE (by-token route, armed-key loop) *** K2's own on-disk latch holds EXACTLY {v6-token}", JSON.stringify((readLatchTokensSafe(k2Path) ?? []).sort()) === JSON.stringify(["v6-token"]));
  check("*** THE WRITE (by-token route, rewriteOrphanLatchFilesAfterPartialClear) *** F's own on-disk latch holds EXACTLY {v6-token}", JSON.stringify((readLatchTokensSafe(fPath) ?? []).sort()) === JSON.stringify(["v6-token"]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** REBOOT (by-token route) *** s6-token does NOT come back", !rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("s6-token")));
  check("*** REBOOT (by-token route) *** v6-token survives", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("v6-token")));
}

console.log(failures === 0
  ? "\n✅ ALL SCENARIOS PASS — a tied pending twin's own private token survives a key/orphan-file-addressed "
    + "clear (in-memory and across a reboot), keeping every key it was armed on untouched, while a human "
    + "clear still fully lifts both sides."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 64119847.`);
process.exit(failures === 0 ? 0 : 1);
