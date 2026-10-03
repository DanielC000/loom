import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { requireHermeticEnv } from "./_guard.mjs";
// Card 646de997: the 6 call sites that gate SessionService.autoCancelSettleWakes on a settle-nudge
// enqueue result used to check `if (r.delivered)` alone. `EnqueueResult.delivered` is true ONLY for the
// immediate-submit case (deliveryState:"handed-off") — a HELD/QUEUED result (deliveryState:"queued",
// `delivered:false`) is just as durable a hand-off (it WILL land at the recipient's next turn boundary),
// but `r.delivered` reads false for it exactly like the genuinely-undelivered `deliveryState:"dropped"`
// (session-dead / no live pty) case — so the old gate could not tell "durably queued, safe to reap the
// fallback wake" apart from "never delivered at all, the fallback wake is this session's only remaining
// recovery path and MUST survive". All 6 sites now delegate to ONE shared helper,
// `SessionService.shouldCancelSettleWakeAfter(r)`, which discriminates on `r.deliveryState` directly:
// true for "handed-off" AND "queued", false ONLY for "dropped".
//
// Hermetic, no git/worktree/PTY involved — this proves the DECISION the gate makes, plus that the real
// production `autoCancelSettleWakes` (never mocked) actually reaps/preserves wakes correctly once that
// decision says to run it. The existing wake-auto-cancel-on-settle.mjs test already proves the
// "handed-off" (delivered:true) case end-to-end through a real runWorkerGate/recycle cycle; this file
// is scoped to the two cases that test does NOT cover: queued/held, and session-dead/dropped.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/wake-auto-cancel-on-queued-result.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-wacq-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const now = new Date().toISOString();
const db = new Db();
// `shouldCancelSettleWakeAfter`/`autoCancelSettleWakes` touch only `this.db` — a bare stub stands in for
// the PtyHost (never called) and OrchestrationControl needs no args.
const svc = new SessionService(db, /** @type {any} */ ({}), new OrchestrationControl());

try {
  const P = "wacq-proj";
  db.insertProject({ id: P, name: "WACQ", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${P}-dev`, projectId: P, name: "Dev", startupPrompt: "DEV", position: 0, profileId: null });
  const sessionId = `${P}-s1`;
  db.insertSession({
    id: sessionId, projectId: P, agentId: `${P}-dev`, engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker",
  });

  // --- (1) the pure gating decision, for all three real EnqueueResult.deliveryState values ---
  const handedOff = { delivered: true, deliveryState: "handed-off" };
  const queued = { delivered: false, queued: true, deliveryState: "queued" };
  const dropped = { delivered: false, reason: "session-dead", queued: false, deliveryState: "dropped" };

  check("handed-off (immediate delivery) ⇒ cancel", svc.shouldCancelSettleWakeAfter(handedOff) === true);
  check("queued/held ⇒ cancel (THE FIX — the old `r.delivered` check read this as false)", svc.shouldCancelSettleWakeAfter(queued) === true);
  check("dropped/session-dead ⇒ do NOT cancel (the fallback wake is this session's only recovery path)", svc.shouldCancelSettleWakeAfter(dropped) === false);

  // --- (2) integration: the real autoCancelSettleWakes, gated exactly as the 6 call sites gate it ---
  const opStartedAt = new Date(Date.now() - 1000).toISOString();
  const opId = "op-wacq-1";

  function seedWakes() {
    for (const w of db.listWakesForSession(sessionId)) db.deleteWake(w.id);
    // predates the op — must always survive (the over-cancellation guard).
    db.insertWake({ id: "wake-before", sessionId, wakeAt: new Date(Date.now() + 3600_000).toISOString(), note: "unrelated, predates op", createdAt: new Date(Date.now() - 60_000).toISOString() });
    // postdates the op start — the fallback wake this op's own settle nudge should reap.
    db.insertWake({ id: "wake-after", sessionId, wakeAt: new Date(Date.now() + 3600_000).toISOString(), note: "fallback for this op", createdAt: new Date(Date.now() + 10).toISOString() });
  }

  // Scenario A: a QUEUED (held) settle-nudge result — gate must still reap the fallback wake.
  seedWakes();
  if (svc.shouldCancelSettleWakeAfter(queued)) svc.autoCancelSettleWakes(sessionId, opStartedAt, opId);
  let remaining = db.listWakesForSession(sessionId).map((w) => w.id).sort();
  check("QUEUED result: the fallback wake (postdates op start) IS cancelled", !remaining.includes("wake-after"));
  check("QUEUED result: the unrelated wake (predates op start) SURVIVES", remaining.includes("wake-before"));
  check("QUEUED result: exactly one wake remains", remaining.length === 1);

  // Scenario B: a DROPPED (session-dead) settle-nudge result — gate must leave every wake untouched;
  // the fallback wake is this session's only remaining recovery path.
  seedWakes();
  if (svc.shouldCancelSettleWakeAfter(dropped)) svc.autoCancelSettleWakes(sessionId, opStartedAt, opId);
  remaining = db.listWakesForSession(sessionId).map((w) => w.id).sort();
  check("DROPPED result: the fallback wake SURVIVES untouched (no live recipient to have received it)", remaining.includes("wake-after"));
  check("DROPPED result: the unrelated wake also survives", remaining.includes("wake-before"));
  check("DROPPED result: both wakes remain (nothing was reaped)", remaining.length === 2);
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a settle-nudge result that is durably QUEUED/held now auto-cancels the fallback wake exactly like an immediate delivery does, while a DROPPED (session-dead) result still leaves every pending wake untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
