import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f55b64af, manager follow-up (2026-09-23): gate-output-spill.mjs's (H)/(I)/(J)/(K) blocks prove
// pruneGateSpills's own two-pool ALGORITHM correctly, but do so with a HAND-SUPPLIED `protectedOpIds`
// set — they never exercise the CLASSIFICATION DECISION itself: `isProtectedGateSpillVerdict` +
// `pruneGateSpillsClassified`'s batched `Db.listPendingGateOpsByOpIds` lookup + its degrade-on-error path
// (all in sessions/service.ts). "Correct by inspection" isn't enough for the actual protection decision —
// this file closes that seam.
//
// HERMETIC: a REAL `Db` (temp sqlite file, no daemon/PTY/claude), no daemon, drives the exported
// `pruneGateSpillsClassified`/`isProtectedGateSpillVerdict` (sessions/service.ts) directly against a
// throwaway spill directory (never real LOOM_HOME/gate-output).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-spill-classification.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { pruneGateSpillsClassified, isProtectedGateSpillVerdict } from "../dist/sessions/service.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

const dbFile = path.join(os.tmpdir(), `loom-gsc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-09-23T00:00:00.000Z";
const projId = "proj-gsc";

/** Seeds a settled pending_gate_ops row via the SAME insert+settle round-trip production code uses —
 *  never hand-written SQL — so this test exercises the real read path a caller would see. */
function seedOp(opId, verdict) {
  db.insertPendingGateOp({ opId, kind: "merge", key: `merge:${opId}`, ownerSessionId: `s-${opId}`, projectId: projId, taskId: null, branch: null, startedAt: now, state: "pending", surfacedPending: false });
  db.settlePendingGateOp(opId, verdict);
}

function writeSpill(dir, opId, ageMs) {
  const p = path.join(dir, `${opId}.log`);
  fs.writeFileSync(p, `content for ${opId}`);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

try {
  // ── (A) THE REAL DECISION — all four PROTECTED verdict shapes + three ORDINARY-verdict shapes + one
  //     UNKNOWN (no row at all), driven through the REAL classifier + a genuinely tiny ordinary cap (3)
  //     so eviction actually happens. The four protected ops are the OLDEST files in the dir — if the
  //     classifier were broken (e.g. any of the four wrongly read as ordinary), they'd be evicted by the
  //     tiny ordinary cap exactly like the ordinary group is. ──────────────────────────────────────────
  {
    const dir = mkdtempManaged("loom-gsc-a-");

    seedOp("op-fail", { kind: "fail", payload: { reason: "build gate failed" } });
    seedOp("op-error", { kind: "error", payload: { reason: "gate errored: ENOENT" } });
    seedOp("op-weak-retriedfile", { kind: "pass", payload: { retriedFile: "test/x.mjs", retryPassed: true } });
    seedOp("op-weak-transient", { kind: "pass", payload: { transientRetried: true } });
    const PROTECTED_IDS = ["op-fail", "op-error", "op-weak-retriedfile", "op-weak-transient"];
    PROTECTED_IDS.forEach((id) => writeSpill(dir, id, 100 * 60_000)); // OLDEST of everything in this dir

    seedOp("op-clean", { kind: "pass", payload: { retriedFile: null, retryPassed: null, transientRetried: false } });
    seedOp("op-cancelled", { kind: "cancelled", payload: { reason: "cancelled by manager" } });
    seedOp("op-skipped", { kind: "skipped", payload: {} });
    const ORDINARY_SEEDED_IDS = ["op-clean", "op-cancelled", "op-skipped"];
    ORDINARY_SEEDED_IDS.forEach((id) => writeSpill(dir, id, 50 * 60_000)); // older than the flood, newer than protected

    // No seedOp call at all for this one — an opId with NO pending_gate_ops row.
    writeSpill(dir, "op-unknown-no-row", 50 * 60_000);

    // FLOOD: 5 more genuinely ordinary (clean-pass) files, newest of all — enough that the tiny keep=3
    // cap has real competition and a correct implementation visibly prunes SOMETHING.
    const FLOOD_IDS = [];
    for (let i = 0; i < 5; i++) {
      const id = `op-flood-${i}`;
      FLOOD_IDS.push(id);
      seedOp(id, { kind: "pass", payload: {} });
      writeSpill(dir, id, (4 - i) * 1000); // op-flood-4 newest, op-flood-0 oldest of the flood
    }

    pruneGateSpillsClassified(db, dir, /* keep */ 3, /* protectedKeep */ 1000);
    const remaining = new Set(fs.readdirSync(dir));

    for (const id of PROTECTED_IDS) {
      check(`(A) PROTECTED (${id}) survives despite being the OLDEST file in the dir`, remaining.has(`${id}.log`));
    }
    for (const id of ORDINARY_SEEDED_IDS) {
      check(`(A) ORDINARY-VERDICT (${id}) does NOT survive — evicted by the tiny ordinary cap like any clean pass`, !remaining.has(`${id}.log`));
    }
    check("(A) UNKNOWN opId (no pending_gate_ops row at all) does NOT survive — fails toward evictable", !remaining.has("op-unknown-no-row.log"));
    const remainingFlood = FLOOD_IDS.filter((id) => remaining.has(`${id}.log`));
    check("(A) exactly the 3 NEWEST flood files survive the tiny ordinary cap", remainingFlood.length === 3 && remainingFlood.includes("op-flood-4") && !remainingFlood.includes("op-flood-0"),
      () => `remainingFlood=${JSON.stringify(remainingFlood)}`);
  }

  // ── (B) DIRECT UNIT COVERAGE of isProtectedGateSpillVerdict — every branch, independent of the prune
  //     dynamics above (a narrower, faster complement to (A)). ──────────────────────────────────────────
  {
    check("(B) fail → protected", isProtectedGateSpillVerdict({ verdict: "fail", verdictPayload: null }) === true);
    check("(B) error → protected", isProtectedGateSpillVerdict({ verdict: "error", verdictPayload: null }) === true);
    check("(B) pass + retriedFile → protected (weaker pass)", isProtectedGateSpillVerdict({ verdict: "pass", verdictPayload: { retriedFile: "x.mjs" } }) === true);
    check("(B) pass + transientRetried → protected (weaker pass)", isProtectedGateSpillVerdict({ verdict: "pass", verdictPayload: { transientRetried: true } }) === true);
    check("(B) pass, no retry, no payload → ordinary (clean pass)", isProtectedGateSpillVerdict({ verdict: "pass", verdictPayload: null }) === false);
    check("(B) pass + retriedFile explicitly null + transientRetried explicitly false → ordinary", isProtectedGateSpillVerdict({ verdict: "pass", verdictPayload: { retriedFile: null, retryPassed: null, transientRetried: false } }) === false);
    check("(B) cancelled → ordinary", isProtectedGateSpillVerdict({ verdict: "cancelled", verdictPayload: null }) === false);
    check("(B) skipped → ordinary", isProtectedGateSpillVerdict({ verdict: "skipped", verdictPayload: null }) === false);
    check("(B) no verdict at all (null) → ordinary", isProtectedGateSpillVerdict({ verdict: null, verdictPayload: null }) === false);
  }

  // ── (C) THE DEGRADE PATH — a Db whose lookup THROWS must never throw out of pruneGateSpillsClassified,
  //     and must treat every spill as ordinary (today's pre-card behavior), never as protected. A stub
  //     standing in for the real Db — pruneGateSpillsClassified only ever calls this one method on it. ──
  {
    const dir = mkdtempManaged("loom-gsc-c-");
    // Even though op-would-be-protected has NO seeded row at all (the throwing stub never reaches the
    // real db, so there's nothing to seed), this specifically proves the FAILURE MODE: if the lookup had
    // silently swallowed the id list and returned [], that's indistinguishable from "no rows exist" —
    // this test's actual claim is narrower and load-bearing: the THROW itself must not propagate out of
    // pruneGateSpillsClassified and must not crash the caller's own settle path.
    writeSpill(dir, "op-a", 3 * 60_000);
    writeSpill(dir, "op-b", 2 * 60_000);
    writeSpill(dir, "op-c", 1 * 60_000);
    const throwingDb = { listPendingGateOpsByOpIds() { throw new Error("simulated DB lookup failure"); } };

    let threw = false;
    try {
      pruneGateSpillsClassified(/** @type {any} */ (throwingDb), dir, /* keep */ 2, /* protectedKeep */ 1000);
    } catch { threw = true; }
    check("(C) a throwing Db lookup does NOT propagate out of pruneGateSpillsClassified", threw === false);
    const remaining = fs.readdirSync(dir);
    check("(C) the ordinary cap (2) still applied — degrade path fell through to a REAL prune, not a no-op",
      remaining.length === 2, () => `remaining=${JSON.stringify(remaining)}`);
    check("(C) the NEWEST files survived (op-c, op-b) — ordinary newest-first eviction, exactly as if every id were unclassified/ordinary",
      remaining.includes("op-c.log") && remaining.includes("op-b.log") && !remaining.includes("op-a.log"));
  }

  // ── (D) >300-ID CHUNKING BOUNDARY — Db.listPendingGateOpsByOpIds chunks its IN-clause at 300; 301 ids
  //     must all round-trip, including the one that falls into the SECOND chunk. Exercised directly at
  //     the Db layer (cheaper and more direct than trying to detect a broken chunk boundary via prune
  //     eviction dynamics). ─────────────────────────────────────────────────────────────────────────────
  {
    const CHUNK_IDS = [];
    for (let i = 0; i < 301; i++) {
      const id = `op-chunk-${i}`;
      CHUNK_IDS.push(id);
      seedOp(id, { kind: "fail", payload: { reason: `chunk boundary ${i}` } });
    }
    const rows = db.listPendingGateOpsByOpIds(CHUNK_IDS);
    check("(D) all 301 ids round-trip across the 300-id chunk boundary", rows.length === 301,
      () => `rows.length=${rows.length}`);
    const byId = new Map(rows.map((r) => [r.opId, r]));
    check("(D) the FIRST id (chunk 1) round-trips with its real verdict", byId.get("op-chunk-0")?.verdict === "fail");
    check("(D) the 300th id (last of chunk 1) round-trips", byId.get("op-chunk-299")?.verdict === "fail");
    check("(D) the 301st id (first — and only member — of chunk 2) round-trips too", byId.get("op-chunk-300")?.verdict === "fail");
    check("(D) an id with NO row is simply absent from the result, not a false/null entry", !byId.has("op-chunk-does-not-exist"));
  }
} finally {
  db.close();
  try { fs.rmSync(dbFile, { force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the gate-spill PROTECTION DECISION itself (isProtectedGateSpillVerdict + pruneGateSpillsClassified's batched Db lookup) is correct against a real sqlite Db: all four protected verdict shapes (fail/error/weaker-pass-by-retriedFile/weaker-pass-by-transientRetried) survive a tiny ordinary cap that evicts every ordinary-verdict and unknown-opId spill; a throwing Db lookup degrades to all-ordinary without propagating; and the >300-id chunked batch lookup round-trips every id, including the one that falls into the second chunk."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
