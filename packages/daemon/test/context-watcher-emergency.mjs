import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ContextWatcher EMERGENCY-INTERRUPT test (card 9f279c7b, Trigger A) — the SECOND, harder floor above
// `recycleAtContextRatio`: crossing it bypasses the busy-gated nudge queue entirely and fires a
// daemon-internal interrupt hook instead of just enqueueing text. NO claude, NO SessionService — the
// watcher takes an injected `emergencyInterrupt` callback (exactly like `pty` is an injected slice of
// PtyHost), so these tests drive tick() directly against a RECORDING STUB. Hermetic: each env gets its
// OWN temp .db.
//
// RED-FIRST (card 9f279c7b DoD-6): the literal fixture below — a LIVE manager, busy=1, NO Stop for the
// duration, ctxInputTokens already OVER the emergency floor — was run against context-watcher.ts BEFORE
// checkEmergencyOccupancy existed (temporarily reverted via `git diff` + `git checkout HEAD --` +
// `pnpm --filter @loom/daemon build`, then restored via `git apply` + rebuild — never `git stash`, which
// is shared across worktrees). Observed RED: `db.listEvents(mgrId)` returned ZERO
// `context_emergency_interrupt` events and the `interrupts` recording array stayed EMPTY — today's
// (pre-fix) watcher only ever reaches the ordinary busy-gated `enqueueStdin` path, which for a manager
// stuck in one continuous turn just holds the nudge in a queue that never drains (no Stop ever arrives to
// drain it) — observably IDENTICAL to emitting nothing. This file, run against the FIXED source, is the
// GREEN half.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";
import { Db } from "../dist/db.js";
import { ContextWatcher } from "../dist/orchestration/context-watcher.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv({ projectConfig, emergencyInterruptImpl } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-ctx-emergency-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `cp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ct-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "CtxEmergency", repoPath: projId, vaultPath: projId, config: projectConfig ?? {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const interrupts = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: false, queued: true }; },
  };
  const deps = { db, pty, ratio: 0 }; // ratio 0 = no env force override; the ordinary ratio logic is not this file's concern
  if (emergencyInterruptImpl !== null) { // pass null to test the "hook omitted entirely" case
    deps.emergencyInterrupt = emergencyInterruptImpl ?? ((id, text) => {
      interrupts.push({ id, text });
      return { fired: true, delivered: false, interrupting: true }; // simulates: manager was busy, Esc sent
    });
  }
  const watcher = new ContextWatcher(deps);
  return { dbFile, db, projId, agentId, alive, enqueued, interrupts, watcher };
}

function seedManager(e, id, { busy, ctx, ctxUpdatedAt, model = "claude-opus-4-8", live = true }) {
  const now = new Date().toISOString();
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
    ctxInputTokens: ctx, ctxTurns: ctx != null ? 1 : null, ctxUpdatedAt: ctxUpdatedAt ?? null, model,
  });
  if (live) e.alive.add(id);
}

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

function emergencyEvents(e, id) {
  return e.db.listEvents(id).filter((ev) => ev.kind === "context_emergency_interrupt");
}

// A 1M-window model (claude-opus-4-8) — 900_000 tokens is 90% of it, over a 0.85 emergency floor.
const OVER_FLOOR_CTX = 900_000;

// DoD-6's LITERAL fixture: busy=1, NO Stop for the duration, ctxInputTokens already over the emergency
// floor. The ordinary ratio-based nudge (busy-gated enqueueStdin) can never reach this manager — this is
// the exact case Trigger A exists to close.
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } } });
  const stopAt = new Date().toISOString();
  seedManager(e, "mgr-1", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: stopAt });
  e.watcher.tick();
  const events = emergencyEvents(e, "mgr-1");
  check("DoD-6 fixture: busy+no-Stop+over-emergency-floor → exactly one context_emergency_interrupt event", events.length === 1);
  check("event carries pct ~90", events[0]?.detail?.pct === 90);
  check("event honestly records delivered:false (held, not handed off) — DoD-5", events[0]?.detail?.delivered === false);
  check("event honestly records interrupting:true", events[0]?.detail?.interrupting === true);
  check("the interrupt hook was actually called exactly once", e.interrupts.length === 1);
  check("the interrupt text names the percentage and tells the manager to recycle_me", /90%/.test(e.interrupts[0].text) && /recycle_me/.test(e.interrupts[0].text));
  cleanup(e);
}

// Under the emergency floor (but this test sets no ordinary ratio, so no ordinary nudge either): no
// emergency event at all.
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } } });
  seedManager(e, "mgr-under", { busy: true, ctx: 500_000, ctxUpdatedAt: new Date().toISOString() });
  e.watcher.tick();
  check("under the emergency floor (500k/1M=50% < 85%) → no emergency event", emergencyEvents(e, "mgr-under").length === 0);
  check("no interrupt attempted either", e.interrupts.length === 0);
  cleanup(e);
}

// Disabled per-project (emergencyRecycleAtContextRatio: 0): no event even when clearly over what would
// otherwise be a trip.
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0 } } });
  seedManager(e, "mgr-disabled", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: new Date().toISOString() });
  e.watcher.tick();
  check("emergencyRecycleAtContextRatio:0 disables the emergency watchdog", emergencyEvents(e, "mgr-disabled").length === 0);
  check("no interrupt attempted when disabled", e.interrupts.length === 0);
  cleanup(e);
}

// No hook wired at all (e.g. a narrower test harness, or a caller that only cares about ratio/blind-turn
// logic): the trigger is a safe, permanent no-op — never throws, never records a phantom event.
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } }, emergencyInterruptImpl: null });
  seedManager(e, "mgr-nohook", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: new Date().toISOString() });
  let threw = false;
  try { e.watcher.tick(); } catch { threw = true; }
  check("no emergencyInterrupt hook wired → tick() never throws", !threw);
  check("no emergencyInterrupt hook wired → no event recorded", emergencyEvents(e, "mgr-nohook").length === 0);
  cleanup(e);
}

// DE-DUP: two ticks against the SAME still-current reading (ctxUpdatedAt unchanged) fire exactly ONE
// interrupt — a stuck manager must not be Esc-interrupted every single tick.
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } } });
  const stopAt = new Date().toISOString();
  seedManager(e, "mgr-dedup", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: stopAt });
  e.watcher.tick();
  e.watcher.tick();
  e.watcher.tick();
  check("de-dup: three ticks on the SAME reading → exactly one event", emergencyEvents(e, "mgr-dedup").length === 1);
  check("de-dup: exactly one interrupt call, not three", e.interrupts.length === 1);
  cleanup(e);
}

// RE-ARM: once a fresh (newer) ctxUpdatedAt lands — a real Stop happened, and the reading is STILL over
// the floor — the interrupt fires again. Simulates the "manager published 0.92 and immediately entered
// another long turn" case the card's MANAGER DECISION explicitly calls out as NOT vacuous.
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } } });
  seedManager(e, "mgr-rearm", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: new Date(Date.now() - 60_000).toISOString() });
  e.watcher.tick();
  check("re-arm setup: first reading fires once", emergencyEvents(e, "mgr-rearm").length === 1);
  const firstFireTs = emergencyEvents(e, "mgr-rearm")[0].ts;
  // A fresh Stop landed: `setContextCounters` is the REAL write path a Stop hook uses (db.ts) — it stamps
  // ctx_updated_at to "now" itself, so this reproduces an actual fresh-reading edge, not a hand-picked
  // timestamp. The de-dup check (`already.ts >= m.ctxUpdatedAt`) needs the NEW ctxUpdatedAt to be
  // STRICTLY later than the first fire's own event `ts` — millisecond-resolution ISO strings CAN tie when
  // two calls land in the same synchronous tick, so this polls the OBSERVABLE wall clock until it has
  // genuinely advanced past that `ts`, rather than guessing a sleep duration that happens to be enough
  // (fixed-wait-witness-guard.mjs: a blind sleep adjacent to a check() needs a witness; this is that
  // witness — an executable poll on the real precondition, not a trusted-by-convention delay).
  await waitUntil(() => new Date().toISOString() > firstFireTs, { label: "wall clock strictly past the first fire's event ts" });
  e.db.setContextCounters("mgr-rearm", { ctxInputTokens: OVER_FLOOR_CTX, ctxTurns: 2 });
  e.watcher.tick();
  check("re-arm: a fresh (newer) still-over-floor reading fires a SECOND event", emergencyEvents(e, "mgr-rearm").length === 2);
  check("re-arm: a second interrupt call was made", e.interrupts.length === 2);
  cleanup(e);
}

// REFUSAL (merge-danger-window or any other reason): a `fired:false` outcome does NOT record an event —
// so the VERY NEXT tick retries from scratch, exactly the documented policy (never wait/poll inside one
// tick; never interrupt through a real danger window; just retry next cadence).
{
  const e = makeEnv({
    projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } },
    emergencyInterruptImpl: (() => {
      let calls = 0;
      return (id, text) => {
        calls++;
        if (calls === 1) return { fired: false, reason: "merge-danger-window" };
        return { fired: true, delivered: true, interrupting: false };
      };
    })(),
  });
  seedManager(e, "mgr-refused", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: new Date().toISOString() });
  e.watcher.tick();
  check("a refused (fired:false) attempt records NO event", emergencyEvents(e, "mgr-refused").length === 0);
  e.watcher.tick();
  check("the very next tick retries and, once it fires, records exactly one event", emergencyEvents(e, "mgr-refused").length === 1);
  cleanup(e);
}

// Not alive: db says live but the pty is gone → skip (nothing to interrupt).
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } } });
  seedManager(e, "mgr-notalive", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: new Date().toISOString() });
  e.alive.delete("mgr-notalive"); // db row inserted live, but the pty-side stub reports it gone
  e.watcher.tick();
  check("not-alive (pty gone) manager never trips the emergency interrupt", emergencyEvents(e, "mgr-notalive").length === 0);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ContextWatcher's emergency interrupt (Trigger A) fires for a manager whose last known reading crosses emergencyRecycleAtContextRatio, honestly records the real delivered/interrupting outcome (never inherits 49fdcbbc's collapse-to-success bug), stays silent when disabled/under-floor/no-hook/not-alive, fires at most once per still-current reading and re-arms on a fresh Stop, and a refused attempt (e.g. a merge-danger window) records nothing so the very next tick retries cleanly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
