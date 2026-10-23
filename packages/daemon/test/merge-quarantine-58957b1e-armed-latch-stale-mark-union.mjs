import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 58957b1e — the OTHER write path 2dd97aaa/535fd69d never touched: the ARMED-KEY latch write
// (writeMergeQuarantineLatch -> reconcileMarkedBasenameBeforeWrite), as opposed to the PENDING-divert
// write (writePendingDivertFile -> unionIntoOnDiskPendingEntry) those two cards already fixed.
// reconcileMarkedBasenameBeforeWrite's own union only ever consulted the GLOBAL `clearedTokens` tombstone
// (via readSurvivingOnDiskTokens), never the caller's own known-dropped set — so a stale
// keptUnreadableLatchFiles mark on an ARMED key's final can resurrect a token a partial clear just
// dropped, exactly like the pending-side bug, via a structurally different write.
//
// SCENARIO 1 ("58957b1e-s1-clearActiveEntryTokenAtKey") — the card's own named repro: Y's armed-key loop
// (clearActiveEntryTokenAtKey, reached via clearMergeQuarantineByToken). This function's own
// tombstoneIfNotSurviving call runs BEFORE the armed loop, so in the ordinary single-entity case the
// token IS genuinely tombstoned first — to isolate the SAME structural gap (the union never consults
// droppedTokens, only the global clearedTokens the tombstone call populates), inject an unrelated active
// entry Q that independently also holds the literal token and is visited LATER in Map iteration order,
// defeating tombstoneIfNotSurviving's own "surviving anywhere" scan — same fixture-level isolation
// technique as 535fd69d's own scenario 2.
//
// SCENARIO 2 ("58957b1e-s2-clearMergeQuarantineByKey-reduce-armed") — clearMergeQuarantineByKey's own
// tied-twin "reduce" branch ALSO writes its armed-key copy via writeMergeQuarantineLatch (a SEPARATE write
// from the writePendingDivertFile call 2dd97aaa item 2 already fixed for this exact branch). Unlike
// scenario 1, this function defers its ONE tombstone call to the very end (decision 8db913e2 round 4) —
// well AFTER this reduce loop's own write runs — so the global clearedTokens set is NEVER populated yet
// at write time, regardless of any other in-memory holder. No "unrelated Q" trick is needed to defeat it;
// the ordering alone demonstrates the gap. Constructs a genuine dual-tracked twin P (same object, in BOTH
// pendingUnresolvedQuarantines AND activeQuarantines at a SECOND key) tied to W via an orphan-file
// reference, mirroring 2dd97aaa item 2's own tied-twin construction but with P's OWN armed-key final
// stale-marked instead of P's pending sourceFile.
//
// A THIRD SITE, NOT independently reproduced here ("58957b1e-clearTokenFromPendingIndices-armed-loop",
// not a SCENARIO — no test block exists for it below) — clearTokenFromPendingIndices's own
// armed-key loop (~:3551) shares the IDENTICAL shape and was threaded with the same `droppedTokens` fix,
// but per decision 64283e06's own posture this loop is UNREACHABLE today: its sole caller
// (clearMergeQuarantineByToken) only ever passes NON-TWIN pending indices (any pending entry whose own
// object reference is already found holding `token` in activeQuarantines is excluded before this function
// is even called), so a pending entry that could satisfy `activeQuarantines.get(k) === updated` inside
// this loop can never actually reach it. NOT independently reproduced here — reported, not manufactured,
// per this project's own rule against inventing a repro that doesn't exist. The fix is still applied
// defensively (card 64283e06: "do not remove this routing on [unreachable-today] grounds").
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-58957b1e-armed-latch-stale-mark-union.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, registerForCleanup } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq58957b1e-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const repoLockModuleHref = pathToFileURL(path.join(distGitDir, "repo-lock.js")).href;
const {
  clearMergeQuarantine, clearMergeQuarantineByToken, reenterMergeQuarantinesAtBootTestOnly,
  reenterMergeQuarantinesAtBoot, markLatchFileUnreadableTestOnly, listActiveMergeQuarantines,
  MERGE_QUARANTINE_DIR, setActiveQuarantineTestOnly,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(repoLockModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const hashForKey = (k) => createHash("sha256").update(k).digest("hex").slice(0, 24);

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

function parkAt(key, repoPath, tag, tokens, extra = {}) {
  fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`), JSON.stringify({
    repoPath, branch: `${tag}-branch`, reason: `${tag}: real latch`, tokens, enteredAt: Date.now() - 20_000, ...extra,
  }, null, 2) + "\n");
}

// @decision 9c681680 — registerForCleanup (never a bare fs.mkdirSync-and-forget): an empty os.tmpdir()
// dir left behind per call leaks across every run of this file.
function freshRepo(tag) {
  const p = path.join(os.tmpdir(), `loom-mq58957b1e-${tag}-${freshSfx()}`);
  fs.mkdirSync(p, { recursive: true });
  registerForCleanup(p);
  return p;
}

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — clearActiveEntryTokenAtKey's own armed-key write.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshRepo("s1-y");
  const k = canonicalRepoLockKey(y);
  const q = freshRepo("s1-q");
  const kq = canonicalRepoLockKey(q);

  parkAt(k, y, "58957b1e-s1-w", ["ta", "tb"]);
  reenterMergeQuarantinesAtBoot([y]);
  check("(precondition) Y active with both ta and tb", listActiveMergeQuarantines().some((e) => e.repoPath === y && e.tokens.includes("ta") && e.tokens.includes("tb")));

  // Q: inserted AFTER Y — Map iteration visits Y's own key first, so Q is still "surviving" (unprocessed)
  // at the exact instant clearActiveEntryTokenAtKey(k, Y, "ta") calls its own tombstoneIfNotSurviving(["ta"]).
  setActiveQuarantineTestOnly(kq, { repoPath: q, branch: "58957b1e-s1-q-branch", reason: "58957b1e-s1-q: unrelated, defeats tombstoning until its own turn", tokens: ["ta", "q-token"], enteredAt: Date.now() - 1_000 });
  check("(precondition) Q (unrelated) also holds ta, armed after Y", listActiveMergeQuarantines().some((e) => e.repoPath === q && e.tokens.includes("ta") && e.tokens.includes("q-token")));

  // The stale mark on Y's OWN armed-key final — genuinely readable, same identity, right now.
  markLatchFileUnreadableTestOnly(path.basename(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k)}.json`)));

  clearMergeQuarantineByToken(y, "ta");

  const finalYPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k)}.json`);
  check("(invariant) Y is correctly reduced to {tb} in-memory", listActiveMergeQuarantines().some((e) => e.repoPath === y && JSON.stringify([...e.tokens].sort()) === JSON.stringify(["tb"])));
  check("*** THE BUG (if reproduced) *** Y's own armed-key final holds EXACTLY {tb}, not a resurrected {ta,tb}", (() => {
    try { return JSON.stringify(JSON.parse(fs.readFileSync(finalYPath, "utf8")).tokens.sort()) === JSON.stringify(["tb"]); } catch { return false; }
  })());
  check("Q is correctly reduced to {q-token} too (ta cleared process-wide)", listActiveMergeQuarantines().some((e) => e.repoPath === q && JSON.stringify([...e.tokens].sort()) === JSON.stringify(["q-token"])));

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y, q]);
  check("*** REBOOT *** ta does NOT come back on Y from the armed final's resurrected on-disk copy", !rb.listActiveMergeQuarantines().some((e) => e.repoPath === y && e.tokens.includes("ta")));
  check("*** REBOOT *** tb survives on Y", rb.listActiveMergeQuarantines().some((e) => e.repoPath === y && e.tokens.includes("tb")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — clearMergeQuarantineByKey's own tied-twin "reduce" branch's armed-key write. The function's
// single deferred tombstone call runs at the very END, well AFTER this write — so the gap is reachable
// with no "unrelated Q" needed at all; the ordering itself never populates clearedTokens in time.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const y = freshRepo("s2-y");
  const k = canonicalRepoLockKey(y);
  const v = freshRepo("s2-v"); // a SEPARATE real repo path — just for a stable, distinct secondary key k2
  const k2 = canonicalRepoLockKey(v);
  const pSourceFile = "pending-58957b1e-s2-test.json";
  const pPath = path.join(MERGE_QUARANTINE_DIR, pSourceFile);
  const k2FinalPath = path.join(MERGE_QUARANTINE_DIR, `${hashForKey(k2)}.json`);

  // W: active entry fully lifted by this clear — holds only "wa" — ties P via its own orphanLatchFiles
  // reference (the pendingPlan tie loop's FIRST gate requires p.entry.repoPath to share W's OWN identity
  // — "y" below — a tied twin is a SEPARATE RECORD for the SAME identity, never a different repo).
  parkAt(k, y, "58957b1e-s2-w", ["wa"], { orphanLatchFiles: [pSourceFile] });

  // P: a genuine dual-tracked twin for y's OWN identity — the SAME object reference lives in BOTH
  // pendingUnresolvedQuarantines (sourceFile=pSourceFile) AND activeQuarantines (at its own SECONDARY key
  // k2, a historical/degraded armedKeys member distinct from W's own key k) — mirrors the 883e29bc
  // dual-tracked-twin shape, constructed via the test-only seams for precision. Injected PURELY in-memory
  // first (mirrors 64119847/2dd97aaa item2's own `injectP` pattern), before W's own real boot runs.
  const pEntry = { repoPath: y, branch: "58957b1e-s2-p-branch", reason: "58957b1e-s2-p: dual-tracked tied twin", tokens: ["wa", "p-token"], armedKeys: [k2], enteredAt: Date.now() - 5_000 };
  reenterMergeQuarantinesAtBootTestOnly([], [{ entry: pEntry, sourceFile: pSourceFile }]);
  setActiveQuarantineTestOnly(k2, pEntry);
  reenterMergeQuarantinesAtBootTestOnly([y], []);
  // NOW write P's own real backing files, AFTER both boot calls already ran — so they exist and are
  // genuinely readable at clear time, matching what the reconcile's own re-read will find.
  fs.writeFileSync(pPath, JSON.stringify(pEntry, null, 2) + "\n");
  // P's OWN secondary armed-key final (k2's final) — genuinely readable, same identity (y), holding "wa".
  fs.writeFileSync(k2FinalPath, JSON.stringify({ ...pEntry, branch: "58957b1e-s2-p-final-branch", reason: "58957b1e-s2-p-final: real latch" }, null, 2) + "\n");

  check("(precondition) W active with only wa, orphanLatchFiles names P", listActiveMergeQuarantines().some((e) => e.repoPath === y && JSON.stringify(e.tokens) === JSON.stringify(["wa"]) && e.orphanLatchFiles?.includes(pSourceFile)));
  check("(precondition) P pending AND active at k2, dual-tracked (same object), same identity as W", listActiveMergeQuarantines().some((e) => e.repoPath === y && e.tokens.includes("wa") && e.tokens.includes("p-token") && e.armedKeys?.includes(k2)));

  // The stale mark: outlived whatever earlier (unmodeled) read failure set it — the file is genuinely
  // readable, same identity, right now.
  markLatchFileUnreadableTestOnly(path.basename(k2FinalPath));

  clearMergeQuarantine(y); // by-key route — ONE call, exercises clearMergeQuarantineByKey directly

  check("W is fully lifted (wa gone)", !listActiveMergeQuarantines().some((e) => e.repoPath === y && e.tokens.includes("wa")));
  const pAfter = listActiveMergeQuarantines().find((e) => e.armedKeys?.includes(k2));
  check("(invariant) in-memory P is reduced to EXACTLY {p-token}, wa does NOT come back via the union", !!pAfter && JSON.stringify([...pAfter.tokens].sort()) === JSON.stringify(["p-token"]));
  check("*** THE BUG (if reproduced) *** P's own armed-key final (k2) holds EXACTLY {p-token}, not a resurrected {wa,p-token}", (() => {
    try { return JSON.stringify(JSON.parse(fs.readFileSync(k2FinalPath, "utf8")).tokens.sort()) === JSON.stringify(["p-token"]); } catch { return false; }
  })());

  const rb = await rebootSim();
  rb.reenterMergeQuarantinesAtBoot([y, v]);
  check("*** REBOOT *** wa does NOT come back on P from k2's own resurrected on-disk copy", !rb.listActiveMergeQuarantines().some((e) => e.armedKeys?.includes(k2) && e.tokens.includes("wa")));
  check("*** REBOOT *** p-token survives", rb.listActiveMergeQuarantines().some((e) => e.armedKeys?.includes(k2) && e.tokens.includes("p-token")));
}

console.log(failures === 0
  ? "\n✅ ALL SCENARIOS PASS — a stale keptUnreadableLatchFiles mark on an ARMED key's own final can never "
    + "let writeMergeQuarantineLatch's internal reconcileMarkedBasenameBeforeWrite union resurrect a token "
    + "clearActiveEntryTokenAtKey's own armed-key loop or clearMergeQuarantineByKey's own tied-twin reduce "
    + "branch just dropped."
  : `\n❌ ${failures} CHECK(S) FAILED — reproduces board card 58957b1e.`);
process.exit(failures === 0 ? 0 : 1);
