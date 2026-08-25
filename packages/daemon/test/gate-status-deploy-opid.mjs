import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8052977a — `gate_status` positively asserts `never_existed` for a `deploy` opId the `deploy` tool
// itself just handed the manager. Card bed91595 (THIS card) closes 8052977a's own acknowledged DoD-2 gap:
// that card shipped an in-process, best-effort WORKAROUND (a bounded `Set` of recently-handed-out opIds,
// removed by this card) instead of a real durable record — this file is REWRITTEN, not just patched, to
// prove the real fix rather than the workaround it replaces.
//
// THE ORIGINAL TRAP (8052977a): `deploy` (card 720bb7ad) is SYNCHRONOUS — the manager only ever receives
// {deployed,opId} AFTER the run has already settled. Unlike a merge/worker gate op, `deploy` wrote NO
// durable `pending_gate_ops` tombstone (`Db.insertPendingGateOp` had exactly two call sites — merge and
// worker — deploy was a third gate kind neither registry knew about). So `gate_status(opId)` on the id the
// manager was JUST handed fell straight through both lookup layers (GateSemaphore — nothing live, it
// already settled; the tombstone table — no row was ever written) to the UNSCOPED `never_existed` branch —
// a POSITIVE "this id was never minted" claim that is false for exactly the id the caller was just given.
//
// THE REAL FIX (THIS card, service.ts `deployOwnProject`): mint a `pending_gate_ops` row (kind:"deploy")
// the moment the opId is created, and settle it with a real verdict right after the gate run resolves —
// back-to-back, in one synchronous span, before `deploy` ever returns to its caller. `gate_status` then
// resolves a real deploy opId through the SAME ordinary tombstone fallback merge/worker ops already use —
// it reaches `settled` (with a recorded verdict), never the special-cased `unknown` the removed workaround
// used to report. A genuinely bogus id (one no `deploy` call ever minted) is UNTOUCHED and must still read
// `never_existed` — that negative arm is load-bearing (a fix that makes everything resolve would destroy
// the signal), so this file positive-controls BOTH directions.
//
// HERMETIC — a REAL Db + SessionService + OrchestrationMcpRouter, the `deploy` and `gate_status` tool
// handlers invoked directly via the router's `_registeredTools` (mirrors orchestration-tool-gating.mjs /
// deploy-own-project.mjs), an injected `runGate` seam so no real host exec ever happens.
//
// Proves:
//   (1) a `deploy` opId, immediately re-queried via `gate_status`, reads "settled" with a recorded
//       verdict — NEVER "never_existed" — on BOTH a successful and a failed deploy run (the opId is minted
//       and its tombstone settled on both paths, card 720bb7ad / bed91595).
//   (2) POSITIVE CONTROL, the load-bearing negative arm: a genuinely bogus opId this process never handed
//       out STILL reads "never_existed" — proving the fix resolves SPECIFIC real rows, not everything.
//   (3) a `gate_status` query for a genuinely bogus opId run BEFORE any deploy ever happened also reads
//       "never_existed" (nothing to warm anything with yet) — rules out a vacuous "always resolves" bug.
//   (4) PREFIX RESOLUTION: gate_status's own description promises a FULL id OR an unambiguous 8-char
//       PREFIX (the short id Loom displays everywhere) — an 8-char prefix of a real deploy opId ALSO
//       resolves via the tombstone (not just the full id), while an 8-char prefix of a genuinely bogus
//       opId STILL reads "never_existed" — positive-controlled the same way as (1)/(2).
//   (5) NO EVICTION (closes the gap the REMOVED in-process cache's own bound used to have — card 8052977a's
//       `__setDeployOpIdTrackMaxForTest` seam no longer exists because there is no bounded cache left to
//       shrink): many deploys happen in sequence, and the VERY FIRST one's opId still resolves via the
//       durable tombstone afterward — `pending_gate_ops` is a permanent table, never evicted by count.
//   (6) RESTART DURABILITY: a deploy's tombstone row survives a simulated daemon restart (close + reopen
//       the SAME sqlite file) — proving the row was actually committed to disk, not just held in memory.
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/gate-status-deploy-opid.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-gst-deploy-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const dbFile = path.join(tmpHome, "gst-deploy.db");
let db = new Db(dbFile);
const now = new Date().toISOString();

try {
  // The runGate seam: a hermetic stand-in for runGateSequential — no real process is ever spawned.
  let nextResult = { passed: true, steps: [] };
  const fakeRunGate = async () => nextResult;
  let sessions = new SessionService(
    db,
    { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null },
    new OrchestrationControl(),
    { runGate: fakeRunGate },
  );
  let router = new OrchestrationMcpRouter(db, sessions);

  db.insertProject({
    id: "pDeploy", name: "Deployable", repoPath: "pDeploy", vaultPath: "pDeploy",
    config: { orchestration: { deployCommand: "echo shipping" } }, createdAt: now, archivedAt: null,
  });
  db.insertAgent({ id: "aDeploy", projectId: "pDeploy", name: "Mgr", startupPrompt: "MGR", position: 0 });
  db.insertSession({
    id: "mgrDeploy", projectId: "pDeploy", agentId: "aDeploy", engineSessionId: null, title: null,
    cwd: "pDeploy", processState: "live", resumability: "resumable", busy: false, createdAt: now,
    lastActivity: now, lastError: null, role: "manager",
  });

  let server = router.buildServer("mgrDeploy", "manager");
  check("(precondition) deploy IS registered on this manager's surface", "deploy" in server._registeredTools);
  check("(precondition) gate_status IS registered on this manager's surface", "gate_status" in server._registeredTools);

  const callDeploy = async (reason) => JSON.parse((await server._registeredTools["deploy"].handler({ reason })).content[0].text);
  const callGateStatus = async (opId) => JSON.parse((await server._registeredTools["gate_status"].handler({ opId })).content[0].text);

  // ── (3) BEFORE any deploy has ever run: a bogus opId reads "never_existed" — nothing to resolve from ──
  // yet, so this can't be a vacuous "always resolves" instrument.
  const neverDeployedBogus = "00000000-0000-4000-8000-000000000001";
  const preStatus = await callGateStatus(neverDeployedBogus);
  check("(3 — precondition) a bogus opId queried BEFORE any deploy ever ran reads \"never_existed\"", preStatus.state === "never_existed");

  // ── RED-PROOF SETUP: capture what a genuinely-never-handed-out id looks like, for the (2) positive ────
  // control below, taken AFTER at least one real deploy has happened (so this isn't just "nothing has run
  // yet").
  nextResult = { passed: true, steps: [{ step: "echo shipping", durationMs: 5, status: 0 }], outputTail: "shipping\n" };
  const ok1 = await callDeploy("ship it");
  check("(1a — precondition) deploy SUCCEEDS and returns a real opId", ok1.deployed === true && typeof ok1.opId === "string" && ok1.opId.length > 0);

  // ── (1a) THE CENTRAL FIX — a successful deploy's own returned opId resolves via the durable tombstone ──
  const statusOk1 = await callGateStatus(ok1.opId);
  check("(1a — THE FIX) a successful deploy's opId, re-queried via gate_status, reads \"settled\"", statusOk1.state === "settled");
  check("(1a) it is NEVER \"never_existed\" — the exact false positive-nonexistence claim this card fixes", statusOk1.state !== "never_existed");
  check("(1a) gateType is \"deploy\"", statusOk1.gateType === "deploy");
  check("(1a) the recorded verdict is a real PASS (outcome + passed), not just \"exists\"", statusOk1.outcome === "pass" && statusOk1.passed === true);
  check("(1a) the recorded verdict carries the gate's own output tail", statusOk1.outputTail === "shipping\n");

  // ── (1b) same fix, the FAILURE path — a deploy opId is minted AND settled on EITHER outcome ───────────
  nextResult = { passed: false, failedStatus: 2, outputTail: "remote: rejected", steps: [{ step: "echo shipping", durationMs: 3, status: 2 }] };
  const fail1 = await callDeploy("ship it again");
  check("(1b — precondition) a failed deploy ALSO returns a real opId", fail1.deployed === false && typeof fail1.opId === "string" && fail1.opId.length > 0);
  const statusFail1 = await callGateStatus(fail1.opId);
  check("(1b — THE FIX) a FAILED deploy's opId ALSO reads \"settled\", never \"never_existed\"", statusFail1.state === "settled" && statusFail1.state !== "never_existed");
  check("(1b) the recorded verdict is a real FAIL (outcome + passed:false), with gateDetail", statusFail1.outcome === "fail" && statusFail1.passed === false && statusFail1.gateDetail?.exitCode === 2);

  // ── (2) POSITIVE CONTROL — THE LOAD-BEARING NEGATIVE ARM: a genuinely bogus opId this process never ───
  // handed out, queried in the SAME run right after two real deploys minted real tombstones, must STILL
  // read "never_existed" — proving the fix resolves SPECIFIC known rows rather than collapsing every miss
  // into a resolved state (which would destroy the signal entirely).
  const bogusOpId = "11111111-0000-4000-8000-000000000002";
  const bogusStatus = await callGateStatus(bogusOpId);
  check("(2 — LOAD-BEARING CONTROL) a genuinely never-minted opId STILL reads \"never_existed\" after real deploys ran", bogusStatus.state === "never_existed");
  check("(2) the real deploy op and the bogus op remain DISTINGUISHABLE", statusOk1.state !== bogusStatus.state);

  // ── (4) PREFIX RESOLUTION: gate_status's OWN description promises a FULL id OR an unambiguous 8-char ──
  // PREFIX (the short id Loom displays everywhere) — positive-controlled both directions, same discipline
  // as (1)/(2) above.
  check("(4 — precondition) the tracked opId is long enough for a real 8-char-prefix test", statusOk1 && ok1.opId.length > 8);
  const okPrefixStatus = await callGateStatus(ok1.opId.slice(0, 8));
  check("(4a — THE FIX) an 8-char PREFIX of a real deploy opId ALSO resolves via the tombstone, never \"never_existed\"", okPrefixStatus.state === "settled" && okPrefixStatus.state !== "never_existed");
  const bogusPrefixStatus = await callGateStatus(bogusOpId.slice(0, 8));
  check("(4b — LOAD-BEARING CONTROL) an 8-char PREFIX of a genuinely bogus opId STILL reads \"never_existed\"", bogusPrefixStatus.state === "never_existed");
  check("(4b) the real deploy prefix and the bogus prefix remain DISTINGUISHABLE", okPrefixStatus.state !== bogusPrefixStatus.state);

  // ── (5) NO EVICTION — the gap the REMOVED in-process cache used to have, now closed for real: unlike ───
  // that cache (a bounded Set, oldest entry evicted past a size bound), `pending_gate_ops` is a PERMANENT
  // table. Run several more deploys and confirm the VERY FIRST deploy's opId (minted several calls ago)
  // still resolves via the tombstone — proving there is no size-bound eviction under the new mechanism.
  nextResult = { passed: true, steps: [] };
  const evict2 = await callDeploy("deploy 3");
  const evict3 = await callDeploy("deploy 4");
  const evict4 = await callDeploy("deploy 5");
  check("(5 — precondition) distinct opIds were minted across every deploy call", new Set([ok1.opId, fail1.opId, evict2.opId, evict3.opId, evict4.opId]).size === 5);

  const firstEverStatus = await callGateStatus(ok1.opId);
  check("(5 — THE FIX, PROVING THE OPPOSITE OF THE OLD GAP) the FIRST-EVER deploy opId still resolves via the durable tombstone after several later deploys, never reverting to \"never_existed\"", firstEverStatus.state === "settled" && firstEverStatus.state !== "never_existed");

  // ── (6) RESTART DURABILITY — the SECOND gap the removed in-process cache used to have: close the Db ────
  // (releasing the sqlite file handle) and reopen a FRESH Db/SessionService/router pointed at the SAME
  // file, simulating a daemon restart. The tombstone was written to disk (better-sqlite3 is synchronous)
  // BEFORE `deploy` ever returned its opId to the caller — it must still resolve after "restart".
  db.close();
  db = new Db(dbFile);
  sessions = new SessionService(
    db,
    { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null },
    new OrchestrationControl(),
    { runGate: fakeRunGate },
  );
  router = new OrchestrationMcpRouter(db, sessions);
  server = router.buildServer("mgrDeploy", "manager");
  const postRestartStatus = await callGateStatus(evict4.opId);
  check("(6 — THE FIX, RESTART DURABILITY) a deploy opId still resolves via the tombstone after a simulated daemon restart (fresh Db over the SAME file)", postRestartStatus.state === "settled" && postRestartStatus.state !== "never_existed");
  const postRestartBogus = await callGateStatus(bogusOpId);
  check("(6 — CONTROL) a genuinely bogus opId still reads \"never_existed\" after the simulated restart too", postRestartBogus.state === "never_existed");
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a deploy opId (success or failure path) durably resolves via gate_status's tombstone fallback (never the false-positive \"never_existed\"), survives many later deploys and a simulated daemon restart, while a genuinely bogus opId still correctly reads \"never_existed\" throughout."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
