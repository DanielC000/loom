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

// Captures console.error/warn lines fired during `fn` (still mirrored to the real console too),
// restoring both unconditionally. Used by scenario 10 to prove ZERO calls, not just a successful no-op.
async function captureConsole(fn) {
  const lines = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args) => { lines.push(String(args[0] ?? "")); realError(...args); };
  console.warn = (...args) => { lines.push(String(args[0] ?? "")); realWarn(...args); };
  try {
    await fn();
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
  return lines;
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIOS 7-8 ("eedf16f5-multi-token-overlap-...") — board card eedf16f5: the SAME dual-tracked-twin
// shape as scenarios 5-6, but W holds TWO tokens at once (not one), so P's own overlap with W is 2
// tokens, not 1. Pre-fix, `rewriteOrphanLatchFilesAfterPartialClear` was called ONCE PER OVERLAP TOKEN —
// each call's own ownership-confirmed check only accounted for the ONE token passed THAT call, so F's
// on-disk content still named the OTHER not-yet-accounted overlap token and the write was refused every
// time, deterministically, leaving F stale at its full pre-clear token set forever (and resurrecting both
// tokens on the next reboot). SCENARIO 7 drives this via the by-key route — reaches the bug directly:
// `clearMergeQuarantine` hands `clearMergeQuarantineByKey` an active entry holding BOTH tokens in ONE
// call. SCENARIO 8 drives the SAME underlying multi-token setup via two SEQUENTIAL by-token clears —
// confirming (per docs/decisions/64119847's own reachability analysis, restated in eedf16f5's record)
// that the by-token route structurally never needs this card's widening: `clearMergeQuarantineByToken`'s
// own pre-pass reduces the tied pending twin ONE token at a time, BEFORE the active entry is ever
// emptied, so `clearMergeQuarantineByKey`'s own reduce branch is only ever reached there with a
// SINGLE-token overlap, never two.
//
// See docs/decisions/eedf16f5-rewrite-folded-orphan-latch-once-per-overlap-set.md.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const { y, k2, orphanFile } = buildDualTrackedTwin("s7", ["s7a-token", "s7b-token"], "v7-token");
  const k2Path = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);
  const fPath = path.join(MERGE_QUARANTINE_DIR, orphanFile);

  check("(precondition) W active with BOTH s7a-token and s7b-token", listActiveMergeQuarantines().some((e) => e.tokens.length === 2 && e.tokens.includes("s7a-token") && e.tokens.includes("s7b-token")));
  check("(precondition) P pending+dual-tracked at K2, all three tokens, own orphanLatchFiles", listActiveMergeQuarantines().some((e) => e.tokens.includes("s7a-token") && e.tokens.includes("s7b-token") && e.tokens.includes("v7-token") && e.armedKeys.includes(k2) && e.orphanLatchFiles?.includes(orphanFile)));
  check("(precondition) F's own physical latch exists with the ORIGINAL three tokens", JSON.stringify(readLatchTokens(fPath).sort()) === JSON.stringify(["s7a-token", "s7b-token", "v7-token"]));

  clearMergeQuarantine(y); // by-key route — ONE call, W holds BOTH overlap tokens at once

  const pAfter = listActiveMergeQuarantines().find((e) => e.tokens.includes("v7-token"));
  check("in-memory P correctly reduced to {v7-token}", !!pAfter && JSON.stringify([...pAfter.tokens].sort()) === JSON.stringify(["v7-token"]));
  check("*** THE WRITE (armed-key loop) *** K2's own on-disk latch holds EXACTLY {v7-token}", JSON.stringify((readLatchTokensSafe(k2Path) ?? []).sort()) === JSON.stringify(["v7-token"]));
  check("*** THE FIX (rewriteOrphanLatchFilesAfterPartialClear, whole overlap set in ONE call) *** F's own on-disk latch holds EXACTLY {v7-token}, not the stale {s7a,s7b,v7}", JSON.stringify((readLatchTokensSafe(fPath) ?? []).sort()) === JSON.stringify(["v7-token"]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** REBOOT *** neither s7a-token nor s7b-token comes back", !rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("s7a-token") || e.tokens.includes("s7b-token")));
  check("*** REBOOT *** v7-token survives", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("v7-token")));
}

{
  const { y, k2, orphanFile } = buildDualTrackedTwin("s8", ["s8a-token", "s8b-token"], "v8-token");
  const k2Path = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);
  const fPath = path.join(MERGE_QUARANTINE_DIR, orphanFile);

  check("(precondition, by-token) W active with BOTH s8a-token and s8b-token", listActiveMergeQuarantines().some((e) => e.tokens.length === 2 && e.tokens.includes("s8a-token") && e.tokens.includes("s8b-token")));

  clearMergeQuarantineByToken(y, "s8a-token"); // first of two sequential single-token clears
  clearMergeQuarantineByToken(y, "s8b-token"); // second call empties W -- delegates to clearMergeQuarantineByKey with a SINGLE-token entry

  const pAfter = listActiveMergeQuarantines().find((e) => e.tokens.includes("v8-token"));
  check("*** THE FIX (by-token route, sequential single-token clears) *** in-memory P correctly reduced to {v8-token}", !!pAfter && JSON.stringify([...pAfter.tokens].sort()) === JSON.stringify(["v8-token"]));
  check("*** THE FIX (by-token route) *** K2's own on-disk latch holds EXACTLY {v8-token}", JSON.stringify((readLatchTokensSafe(k2Path) ?? []).sort()) === JSON.stringify(["v8-token"]));
  check("*** THE FIX (by-token route) *** F's own on-disk latch holds EXACTLY {v8-token}", JSON.stringify((readLatchTokensSafe(fPath) ?? []).sort()) === JSON.stringify(["v8-token"]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** REBOOT (by-token route) *** neither s8a-token nor s8b-token comes back", !rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("s8a-token") || e.tokens.includes("s8b-token")));
  check("*** REBOOT (by-token route) *** v8-token survives", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("v8-token")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 9 ("eedf16f5-untied-third-entry-durability-non-interference") — a DURABILITY /
// NON-INTERFERENCE check, NOT an empirical safety probe against over-acceptance (Code Review round 2,
// findings 1/4): Q's own token ("q9-private-token") never appears in F's on-disk content under this
// scenario's own construction, so this check stays green whether or not the ownership-confirming
// chokepoint over-accepts — it cannot discriminate correct acceptance from wrongful acceptance. What it
// DOES prove: Q is a THIRD, wholly independent pending entry (own private token, own healthy
// `sourceFile` distinct from F, NOT tied to W via any armed key or token subset) that merely happens to
// ALSO list the SAME orphan filename F in its own `orphanLatchFiles` as a non-self, secondary reference —
// exactly the shape `anotherLiveEntryOwnsFile` does NOT check (it only looks at an entry's own PRIMARY
// backing: its armed-key hash, or its own `sourceFile`). Q's own correctness never depends on F's
// content — its own `sourceFile` is authoritative — so F's rewrite (driven entirely by tied twin P's own
// overlap with W) must leave Q's own on-disk state, and its own outstanding token, completely untouched,
// both immediately after the clear and after a reboot. The real over-acceptance coverage lives elsewhere:
// `merge-quarantine-raise-protect-failure.mjs`'s `29fe2372-isolate-b` and `f2cc5f18` scenarios (a
// DIFFERENT, independent same-identity record's own file, silently destroyed by a partial clear of an
// unrelated record sharing only its identity) — unaffected by this card.
//
// A discriminating Q (holding an overlap token with F as its ONLY durable carrier via a non-self
// reference) was investigated and found NOT reachable via any current production write path — see
// docs/decisions/eedf16f5-rewrite-folded-orphan-latch-once-per-overlap-set.md's "Why widening is safe"
// section for why `orphanLatchFiles` entries are always self-scoped to an entry's own consumption
// history, never an arbitrary unrelated entity's file.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("s9");
  const k = canonicalRepoLockKey(y);
  const orphanFile = "custom-orphan-64119847-s9.json";
  const pSourceFile = "pending-64119847-s9-p-test.json";
  const qSourceFile = "pending-64119847-s9-q-test.json";
  const fPath = path.join(MERGE_QUARANTINE_DIR, orphanFile);
  const qPath = path.join(MERGE_QUARANTINE_DIR, qSourceFile);

  parkWAt(k, y, "64119847-s9-w", ["s9a-token", "s9b-token"]);

  const pEntry = {
    repoPath: y, branch: "64119847-s9-p-branch", reason: "64119847-s9: tied twin",
    enteredAt: Date.now() - 5_000, tokens: ["s9a-token", "s9b-token", "v9-token"], armedKeys: [k],
    orphanLatchFiles: [orphanFile],
  };
  // Q: untied to W (no shared armedKeys, not a subset of W's tokens, no structural tie at all) — its own
  // private token and own healthy sourceFile, but ALSO non-self-referencing the SAME orphan filename F.
  const qEntry = {
    repoPath: y, branch: "64119847-s9-q-branch", reason: "64119847-s9: untied third entry",
    enteredAt: Date.now() - 5_000, tokens: ["q9-private-token"], armedKeys: [],
    orphanLatchFiles: [orphanFile],
  };
  reenterMergeQuarantinesAtBootTestOnly([], [
    { entry: pEntry, sourceFile: pSourceFile },
    { entry: qEntry, sourceFile: qSourceFile },
  ]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  fs.writeFileSync(fPath, JSON.stringify({
    repoPath: y, branch: pEntry.branch, reason: "folded orphan copy", tokens: [...pEntry.tokens], enteredAt: pEntry.enteredAt,
  }, null, 2) + "\n");
  fs.writeFileSync(qPath, JSON.stringify({
    repoPath: y, branch: qEntry.branch, reason: "Q's own real pending latch", tokens: [...qEntry.tokens], enteredAt: qEntry.enteredAt,
  }, null, 2) + "\n");

  check("(precondition) W active with both s9a/s9b tokens", listActiveMergeQuarantines().some((e) => e.tokens.length === 2 && e.tokens.includes("s9a-token") && e.tokens.includes("s9b-token")));
  check("(precondition) P pending, tied via armedKeys, all three tokens, own orphanLatchFiles", listActiveMergeQuarantines().some((e) => e.tokens.includes("v9-token") && e.armedKeys?.includes(k) && e.orphanLatchFiles?.includes(orphanFile)));
  check("(precondition) Q pending, UNTIED (no armedKeys, not a token subset of W), own private token, ALSO references F", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "q9-private-token" && (e.armedKeys ?? []).length === 0 && e.orphanLatchFiles?.includes(orphanFile)));

  clearMergeQuarantine(y); // by-key route — clears W, reduces tied twin P; Q must be left entirely alone

  check("*** DURABILITY *** Q's own in-memory private token SURVIVES, untouched (non-interference, not an over-acceptance probe)", listActiveMergeQuarantines().some((e) => e.tokens.includes("q9-private-token")));
  check("*** DURABILITY *** Q's own on-disk sourceFile still holds EXACTLY {q9-private-token}", JSON.stringify((readLatchTokensSafe(qPath) ?? []).sort()) === JSON.stringify(["q9-private-token"]));
  check("*** THE FIX *** F is still correctly rewritten to P's reduced set {v9-token} despite Q's own dangling reference to it", JSON.stringify((readLatchTokensSafe(fPath) ?? []).sort()) === JSON.stringify(["v9-token"]));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** REBOOT (durability) *** Q's own private token still survives", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("q9-private-token")));
  check("*** REBOOT *** s9a-token/s9b-token do NOT come back via F", !rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("s9a-token") || e.tokens.includes("s9b-token")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 10 ("eedf16f5-empty-overlap-makes-zero-calls") — Code Review finding 3 on eedf16f5's round 1:
// a tied pending twin P can reach `clearMergeQuarantineByKey`'s reduce branch with an EMPTY
// `overlapTokens` from the very first call — tied via armedKeys/orphan-ref alone, holding NO token in
// common with the active entry W being cleared AT ALL (never a two-step reduction; see the construction
// note below for why the by-token route's own pre-pass would confound this probe). Pre-fix, the
// per-token `for` loop made ZERO calls to `rewriteOrphanLatchFilesAfterPartialClear` on an empty array —
// a plain, unconditional "call it once with the whole set" change would have made ONE call with an EMPTY
// `droppedTokens` set instead, a write attempt the old code never made. The landed fix guards this:
// `if (overlapTokens.length > 0)`. This scenario proves ZERO CALLS, not merely "no visible damage from a
// call" — it plants an orphan file F10 holding a token that is NEITHER in `updated.tokens` NOR in the
// (empty) overlap, so ANY attempted write — even one that ultimately gets refused — would print a
// detectable `[merge-quarantine] keeping ... UNTOUCHED` console line (the ownership-check chokepoint's
// own failure log). Byte-identical F10 content AND the absence of that console line together are what
// distinguish "never attempted" from "attempted and happened to no-op or fail silently."
//
// CONSTRUCTION NOTE: deliberately drives this via the BY-KEY route (`clearMergeQuarantine`), a single
// call to `clearMergeQuarantineByKey`, never `clearMergeQuarantineByToken` — that route's own pending
// pre-pass (`clearTokenFromPendingIndices`) would ALSO legitimately process P's `orphanLatchFiles` via
// its own (unrelated, single-token, already-correct) call BEFORE the empty-overlap reduce branch is ever
// reached, confusing which of the two calls produced any observed console line. The by-key route makes
// ONE call, with P tied to W from the very start holding no shared token, so the ONLY call that could
// ever touch F10 is the one this probe is isolating.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshY("s10");
  const k = canonicalRepoLockKey(y);
  const orphanFile = "custom-orphan-64119847-s10.json";
  const fPath = path.join(MERGE_QUARANTINE_DIR, orphanFile);

  parkWAt(k, y, "64119847-s10-w", ["w10-token"]); // W: its own single token, disjoint from P's from the start

  const pEntry = {
    repoPath: y, branch: "64119847-s10-p-branch", reason: "64119847-s10: tied via armedKeys, NO shared token at all",
    enteredAt: Date.now() - 5_000, tokens: ["v10-token"], armedKeys: [k],
    orphanLatchFiles: [orphanFile],
  };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: pEntry, sourceFile: "pending-64119847-s10-test.json" }]);
  reenterMergeQuarantinesAtBootTestOnly([y], []);

  // F10 deliberately holds a FOREIGN token ("foreign10-token") never in `updated.tokens` ({v10-token})
  // nor in the (empty) overlap — nothing in this scenario ever legitimately writes F10, so a write
  // attempt here is GUARANTEED to fail ownership confirmation and log, never silently succeed.
  const f10Before = JSON.stringify({
    repoPath: y, branch: pEntry.branch, reason: "folded orphan copy (foreign content, deliberately unaccountable)",
    tokens: ["v10-token", "foreign10-token"], enteredAt: pEntry.enteredAt,
  }, null, 2) + "\n";
  fs.writeFileSync(fPath, f10Before);

  check("(precondition) W active with w10-token only", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "w10-token"));
  check("(precondition) P pending, tied via armedKeys, v10-token only (NO overlap with W)", listActiveMergeQuarantines().some((e) => e.tokens.length === 1 && e.tokens[0] === "v10-token" && e.armedKeys?.includes(k)));

  const lines = await captureConsole(() => {
    clearMergeQuarantine(y); // by-key route — ONE call; P's overlap with W is empty from the start
  });

  const pAfter = listActiveMergeQuarantines().find((e) => e.tokens.includes("v10-token"));
  check("in-memory P is untouched — still exactly {v10-token}, armedKeys unchanged (nothing to reduce)", !!pAfter && JSON.stringify([...pAfter.tokens].sort()) === JSON.stringify(["v10-token"]) && pAfter.armedKeys?.includes(k));
  check("*** THE GUARD *** F10's on-disk bytes are BYTE-IDENTICAL to before the clear (zero write attempt)", fs.readFileSync(fPath, "utf8") === f10Before);
  check("*** THE GUARD *** NO '[merge-quarantine] keeping ... UNTOUCHED' line for F10 (zero calls, not a call that failed silently)", !lines.some((l) => l.includes(orphanFile) && l.includes("keeping") && l.includes("UNTOUCHED")));
  check("*** THE FIX *** W is fully lifted (w10-token gone) despite P's own tie surviving", !listActiveMergeQuarantines().some((e) => e.tokens.includes("w10-token")));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y]);
  check("*** REBOOT *** w10-token does NOT come back", !rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("w10-token")));
  check("*** REBOOT *** v10-token (P's own, always-private token) survives", rb.listActiveMergeQuarantines().some((e) => e.tokens.includes("v10-token")));
}

console.log(failures === 0
  ? "\n✅ ALL SCENARIOS PASS — a tied pending twin's own private token survives a key/orphan-file-addressed "
    + "clear (in-memory and across a reboot), keeping every key it was armed on untouched, a multi-token "
    + "overlap rewrites its folded orphan latch correctly in ONE call (card eedf16f5) but makes ZERO calls "
    + "when the overlap is empty, an untied third entry sharing the same orphan filename sees its own "
    + "durable state left alone, and a human clear still fully lifts both sides."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 64119847 or eedf16f5.`);
process.exit(failures === 0 ? 0 : 1);
