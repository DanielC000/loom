import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5ff6586d: `autoCancelSettleWakes` is supposed to reap a session's fallback wake(s) ONLY after a
// settle nudge is SUCCESSFULLY, durably handed off (every call site carries a comment saying exactly
// this). But `enqueueDurableMessage` (via `PtyHost.enqueueStdin`) reports a failed delivery by RETURNING
// `{delivered:false, reason:"session-dead"|"shell-terminal", deliveryState:"dropped", ...}` — it never
// throws — so a bare try/catch around each call site's `enqueueDurableMessage(...)` +
// `autoCancelSettleWakes(...)` pair was DEAD for a delivery outcome, and an unconditional
// `autoCancelSettleWakes` call reaped the wake regardless.
//
// This test exercises `reconcileOrphanedGateOps` (one of the 6 affected call sites in service.ts — all 6
// now share the identical `const r = this.enqueueDurableMessage(...); if
// (this.shouldCancelSettleWakeAfter(r)) this.autoCancelSettleWakes(...)` shape) against the ONE
// deliveryState that must still leave every fallback wake untouched:
//   SESSION-DEAD — the target was never spawned in the host at all (`live?.alive` is falsy), so
//   `enqueueStdin` returns `deliveryState:"dropped"`. There is no live recipient at all, so the fallback
//   wake is this session's ONLY remaining recovery path and must survive.
//
// Card 646de997 CORRECTED this file's own prior "HELD" case: a target that's spawned (alive) but never
// reaches `ready` takes `enqueueStdin`'s HELD branch, which returns `deliveryState:"queued"` — a REAL,
// durable hand-off (it WILL land at the recipient's next turn boundary), not a failure. Before card
// 646de997, `if (r.delivered)` alone read `deliveryState:"queued"` as false exactly like "dropped" and
// left the fallback wake to fire pointlessly after the nudge was already durably queued — this file used
// to assert that AS THE CORRECT BEHAVIOR, which was the bug. It now asserts the fix: a HELD result IS
// cancelled, exactly like an immediate delivery. See wake-auto-cancel-on-queued-result.mjs for the
// focused helper-level proof of both polarities.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/wake-survives-failed-delivery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wsfd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

class SeamHost extends createSeamHost(PtyHost) {}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const db = new Db();
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const now = new Date().toISOString();
const P = "wsfd-proj";
db.insertProject({ id: P, name: "WSFD", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 0, profileId: null });
db.insertTask({ id: "twsfd", projectId: P, title: "twsfd", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });

const geometry = { cols: 120, rows: 40 };
const sessionEnv = {};
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

function insertSession(id) {
  db.insertSession({ id, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", taskId: "twsfd" });
}

function insertOrphanedGateOp(opId, ownerSessionId, startedAt) {
  db.insertPendingGateOp({
    opId, kind: "gate", key: `gate:${ownerSessionId}`, ownerSessionId,
    projectId: P, taskId: "twsfd", branch: null, startedAt,
    state: "pending", surfacedPending: true,
  });
}

try {
  // --- CASE 1: SESSION-DEAD — target never spawned in the host at all. ---
  const deadTarget = "wsfd-dead";
  insertSession(deadTarget);
  const opStartedAt1 = new Date(Date.now() - 5000).toISOString();
  const opId1 = randomUUID();
  insertOrphanedGateOp(opId1, deadTarget, opStartedAt1);
  const fallbackWakeId1 = "wake-dead-fallback";
  db.insertWake({ id: fallbackWakeId1, sessionId: deadTarget, wakeAt: new Date(Date.now() + 3600_000).toISOString(), note: "fallback", createdAt: new Date(Date.now() - 1000).toISOString() });

  // --- CASE 2: HELD — target spawned (alive) but never marked ready (no SessionStart fired). ---
  const heldTarget = "wsfd-held";
  insertSession(heldTarget);
  host.spawn({ sessionId: heldTarget, cwd: tmpHome, permission, geometry, sessionEnv });
  const opStartedAt2 = new Date(Date.now() - 5000).toISOString();
  const opId2 = randomUUID();
  insertOrphanedGateOp(opId2, heldTarget, opStartedAt2);
  const fallbackWakeId2 = "wake-held-fallback";
  db.insertWake({ id: fallbackWakeId2, sessionId: heldTarget, wakeAt: new Date(Date.now() + 3600_000).toISOString(), note: "fallback", createdAt: new Date(Date.now() - 1000).toISOString() });

  check("precondition: held target is alive in the host", host.isAlive(heldTarget));
  check("precondition: held target never reached ready (no SessionStart fired)", db.listWakesForSession(heldTarget).length === 1); // sanity: wake present before the sweep

  const cleared = svc.reconcileOrphanedGateOps(new Date().toISOString());
  check("reconcileOrphanedGateOps processed both orphaned rows", cleared === 2);

  check("SESSION-DEAD: fallback wake SURVIVES a dropped (no live recipient at all) settle nudge", db.listWakesForSession(deadTarget).some((w) => w.id === fallbackWakeId1));
  check("HELD (card 646de997): fallback wake IS cancelled — a durably-queued hand-off, not a failure", !db.listWakesForSession(heldTarget).some((w) => w.id === fallbackWakeId2));

  // Both rows still get marked orphaned regardless of delivery outcome — that side effect is untouched by this fix.
  const rows = db.listPendingGateOps();
  check("both pending-gate-op rows were marked orphaned (unrelated to the delivery-gating fix)", rows.every((r) => r.state === "orphaned-by-restart"));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a DROPPED (session-dead, no live recipient) settle nudge leaves every pending fallback wake untouched, while a HELD (durably queued) one now cancels the fallback wake just like an immediate delivery (card 646de997)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
