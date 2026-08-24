import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8052977a — `gate_status` positively asserts `never_existed` for a `deploy` opId the `deploy` tool
// itself just handed the manager.
//
// THE TRAP: `deploy` (card 720bb7ad) is SYNCHRONOUS — the manager only ever receives {deployed,opId}
// AFTER the run has already settled. Unlike a merge/worker gate op, `deploy` writes NO durable
// `pending_gate_ops` tombstone (`Db.insertPendingGateOp` has exactly two call sites — merge and worker —
// deploy is a third gate kind neither registry knows about). So `gate_status(opId)` on the id the manager
// was JUST handed fell straight through both lookup layers (GateSemaphore — nothing live, it already
// settled; the tombstone table — no row was ever written) to the UNSCOPED `never_existed` branch — a
// POSITIVE "this id was never minted" claim that is false for exactly the id the caller was just given.
//
// THE FIX (mcp/orchestration.ts, `noteDeployOpId`/`recentDeployOpIds`): the `deploy` tool's own handler
// records every opId it actually returns, in-process; `gate_status`'s handler consults that record ONLY
// when the underlying `sessions.gateStatus` already answered `never_existed`, reclassifying a HIT into
// the honest `"unknown"` (a real op we know we minted, no verdict retained here) — extending the SAME
// vocabulary the worker-scoped path already uses for its own "can't positively assert absence" case,
// rather than overloading `never_existed`. A genuinely bogus id (one this process never handed out) is
// UNTOUCHED and must still read `never_existed` — that negative arm is load-bearing (a fix that makes
// everything `unknown` would destroy the signal), so this file positive-controls BOTH directions.
//
// HERMETIC — a REAL Db + SessionService + OrchestrationMcpRouter, the `deploy` and `gate_status` tool
// handlers invoked directly via the router's `_registeredTools` (mirrors orchestration-tool-gating.mjs /
// deploy-own-project.mjs), an injected `runGate` seam so no real host exec ever happens.
//
// Proves:
//   (1) a `deploy` opId, immediately re-queried via `gate_status`, reads "unknown" — NEVER "never_existed"
//       — on BOTH a successful and a failed deploy run (the opId is minted on both paths, card 720bb7ad).
//   (2) POSITIVE CONTROL, the load-bearing negative arm: a genuinely bogus opId this process never handed
//       out STILL reads "never_existed" — proving the fix doesn't just fold everything into "unknown".
//   (3) a `gate_status` query for a genuinely bogus opId run BEFORE any deploy ever happened also reads
//       "never_existed" (nothing to warm the cache with yet) — rules out a vacuous "always unknown" bug.
//   (4) PREFIX RESOLUTION (manager review): gate_status's own description promises a FULL id OR an
//       unambiguous 8-char PREFIX (the short id Loom displays everywhere) — an 8-char prefix of a real
//       deploy opId ALSO reads "unknown" (not just the full id), while an 8-char prefix of a genuinely
//       bogus opId STILL reads "never_existed" — positive-controlled the same way as (1)/(2).
//   (5) EVICTION (manager review): once the tracked-opId bound is exceeded, the oldest tracked opId
//       reverts to "never_existed" even though it was real — the same conflation one layer out, proven via
//       a test-only seam (__setDeployOpIdTrackMaxForTest) rather than asserted from reading the code.
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
const { OrchestrationMcpRouter, __setDeployOpIdTrackMaxForTest } = await import("../dist/mcp/orchestration.js");

const dbFile = path.join(tmpHome, "gst-deploy.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  // The runGate seam: a hermetic stand-in for runGateSequential — no real process is ever spawned.
  let nextResult = { passed: true };
  const fakeRunGate = async () => nextResult;
  const sessions = new SessionService(
    db,
    { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null },
    new OrchestrationControl(),
    { runGate: fakeRunGate },
  );
  const router = new OrchestrationMcpRouter(db, sessions);

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

  const server = router.buildServer("mgrDeploy", "manager");
  check("(precondition) deploy IS registered on this manager's surface", "deploy" in server._registeredTools);
  check("(precondition) gate_status IS registered on this manager's surface", "gate_status" in server._registeredTools);

  const callDeploy = async (reason) => JSON.parse((await server._registeredTools["deploy"].handler({ reason })).content[0].text);
  const callGateStatus = async (opId) => JSON.parse((await server._registeredTools["gate_status"].handler({ opId })).content[0].text);

  // ── (3) BEFORE any deploy has ever run: a bogus opId reads "never_existed" — nothing to warm the ──────
  // cache with yet, so this can't be a vacuous "always unknown" instrument.
  const neverDeployedBogus = "00000000-0000-4000-8000-000000000001";
  const preStatus = await callGateStatus(neverDeployedBogus);
  check("(3 — precondition) a bogus opId queried BEFORE any deploy ever ran reads \"never_existed\"", preStatus.state === "never_existed");

  // ── RED-PROOF SETUP: capture what a genuinely-never-handed-out id looks like, for the (2) positive ────
  // control below, taken AFTER at least one real deploy has happened (so the cache is genuinely warm and
  // this isn't just "the cache was always empty").
  nextResult = { passed: true };
  const ok1 = await callDeploy("ship it");
  check("(1a — precondition) deploy SUCCEEDS and returns a real opId", ok1.deployed === true && typeof ok1.opId === "string" && ok1.opId.length > 0);

  // ── (1a) THE CENTRAL FIX — a successful deploy's own returned opId reads "unknown", never "never_existed" ──
  const statusOk1 = await callGateStatus(ok1.opId);
  check("(1a — THE FIX) a successful deploy's opId, re-queried via gate_status, reads \"unknown\"", statusOk1.state === "unknown");
  check("(1a) it is NEVER \"never_existed\" — the exact false positive-nonexistence claim this card fixes", statusOk1.state !== "never_existed");

  // ── (1b) same fix, the FAILURE path — a deploy opId is minted on EITHER outcome (card 720bb7ad) ───────
  nextResult = { passed: false, failedStatus: 2, outputTail: "remote: rejected" };
  const fail1 = await callDeploy("ship it again");
  check("(1b — precondition) a failed deploy ALSO returns a real opId", fail1.deployed === false && typeof fail1.opId === "string" && fail1.opId.length > 0);
  const statusFail1 = await callGateStatus(fail1.opId);
  check("(1b — THE FIX) a FAILED deploy's opId ALSO reads \"unknown\", never \"never_existed\"", statusFail1.state === "unknown" && statusFail1.state !== "never_existed");

  // ── (2) POSITIVE CONTROL — THE LOAD-BEARING NEGATIVE ARM: a genuinely bogus opId this process never ───
  // handed out, queried in the SAME run right after two real deploys warmed the cache, must STILL read
  // "never_existed" — proving the fix recognizes SPECIFIC known opIds rather than collapsing every miss
  // into "unknown" (which would destroy the signal entirely, per the card's own DoD-3).
  const bogusOpId = "11111111-0000-4000-8000-000000000002";
  const bogusStatus = await callGateStatus(bogusOpId);
  check("(2 — LOAD-BEARING CONTROL) a genuinely never-minted opId STILL reads \"never_existed\" after real deploys warmed the cache", bogusStatus.state === "never_existed");
  check("(2) the real deploy op and the bogus op remain DISTINGUISHABLE", statusOk1.state !== bogusStatus.state);

  // ── (3) PREFIX RESOLUTION — manager review, card 8052977a: gate_status's OWN description promises a ────
  // FULL id OR an unambiguous 8-char PREFIX (the short id Loom displays everywhere) — a bare Set.has(opId)
  // recognizes only the full id, silently missing the SHORT form for the exact "paste the id you were just
  // handed" case the card is about. Positive-controlled BOTH directions, same discipline as (1)/(2) above.
  check("(3 — precondition) the tracked opId is long enough for a real 8-char-prefix test", statusOk1 && ok1.opId.length > 8);
  const okPrefixStatus = await callGateStatus(ok1.opId.slice(0, 8));
  check("(3a — THE FIX) an 8-char PREFIX of a real deploy opId ALSO reads \"unknown\", never \"never_existed\"", okPrefixStatus.state === "unknown" && okPrefixStatus.state !== "never_existed");
  const bogusPrefixStatus = await callGateStatus(bogusOpId.slice(0, 8));
  check("(3b — LOAD-BEARING CONTROL) an 8-char PREFIX of a genuinely bogus opId STILL reads \"never_existed\"", bogusPrefixStatus.state === "never_existed");
  check("(3b) the real deploy prefix and the bogus prefix remain DISTINGUISHABLE", okPrefixStatus.state !== bogusPrefixStatus.state);

  // ── (5) EVICTION — manager review, card 8052977a: the tracking set is BOUNDED, so an opId that ages ────
  // out past the bound must ALSO revert to "never_existed", even though it was a real, once-tracked deploy
  // — the SAME conflation this card exists to fix, one layer out. Shrink the bound via the test-only seam
  // (mirrors deploy.ts's __resetDeployRateLimitState) so this is provable without 500 real deploys. ────────
  __setDeployOpIdTrackMaxForTest(2);
  nextResult = { passed: true };
  const evict1 = await callDeploy("evict test 1");
  const evict2 = await callDeploy("evict test 2");
  const evict3 = await callDeploy("evict test 3"); // pushes the set to size 3 → evicts evict1 (oldest)
  check("(5 — precondition) three distinct deploy opIds were minted", new Set([evict1.opId, evict2.opId, evict3.opId]).size === 3);

  const evict1Status = await callGateStatus(evict1.opId);
  check("(5 — THE ACKNOWLEDGED GAP, PROVEN) the OLDEST tracked opId, now evicted past the bound, reverts to \"never_existed\" even though it was a real deploy", evict1Status.state === "never_existed");
  const evict3Status = await callGateStatus(evict3.opId);
  check("(5) the MOST RECENT opId, still within the bound, correctly reads \"unknown\"", evict3Status.state === "unknown");
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a deploy opId (success or failure path) reads \"unknown\" via gate_status, never the false-positive \"never_existed\"; a genuinely bogus opId still correctly reads \"never_existed\" even after real deploys have warmed the tracking cache."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
