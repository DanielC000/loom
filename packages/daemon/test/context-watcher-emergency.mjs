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

// ONCE-PER-SESSION (card c5b234aa, Code Review round 4): three successive rounds each tried a different
// per-TURN re-arm key (per-reading, `lastActivity`, `turnSeq`) and each one reopened the same cascade
// from a different direction — see `docs/decisions/9f279c7b-*.md`'s round-4 section for the full history.
// Round 4 removes the re-arm key entirely: this interrupt fires AT MOST ONCE PER SESSION ID, full stop.
//
// (a) A Stop lands INSIDE the ~1.5s redirect-settle window — turnSeq bumps, a new turn starts, still over
// the floor. Round 3's `turnSeq`-keyed de-dup would read this as "a completed turn, re-arm" and fire
// again; round 4 must not.
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } } });
  seedManager(e, "mgr-oncepersession", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: new Date(Date.now() - 60_000).toISOString() });
  e.watcher.tick();
  check("round-4 setup: first reading fires once", emergencyEvents(e, "mgr-oncepersession").length === 1);

  e.db.incrementTurnSeq("mgr-oncepersession"); // a real Stop lands inside the settle window
  e.db.setBusy("mgr-oncepersession", true); // the new turn's own rising edge
  e.db.setContextCounters("mgr-oncepersession", { ctxInputTokens: OVER_FLOOR_CTX, ctxTurns: 2 }); // still over the floor
  e.watcher.tick();
  check("(a) a Stop inside the settle window bumps turnSeq, but round 4 still does NOT re-fire",
    emergencyEvents(e, "mgr-oncepersession").length === 1 && e.interrupts.length === 1);

  // (b) The wind-down turn now genuinely completes for real (another Stop) and a SECOND new turn starts,
  // still over the floor — this is the multi-turn-wind-down case round 3 missed. Still must not re-fire:
  // this session has already fired once, period.
  e.db.incrementTurnSeq("mgr-oncepersession");
  e.db.setBusy("mgr-oncepersession", false);
  e.db.setBusy("mgr-oncepersession", true);
  e.db.setContextCounters("mgr-oncepersession", { ctxInputTokens: OVER_FLOOR_CTX, ctxTurns: 3 });
  e.watcher.tick();
  check("(b) wind-down turn completed + a new turn, still over the floor: STILL no second interrupt (once per session)",
    emergencyEvents(e, "mgr-oncepersession").length === 1 && e.interrupts.length === 1);
  cleanup(e);
}

// (c) A DIFFERENT (recycled) session id, also over the floor, fires its OWN first interrupt — a recycle
// minting a fresh session id is the ONLY thing that re-arms this check now.
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } } });
  seedManager(e, "mgr-old", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: new Date().toISOString() });
  e.watcher.tick();
  check("(c) setup: the OLD session fires once", emergencyEvents(e, "mgr-old").length === 1);

  seedManager(e, "mgr-new", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: new Date().toISOString() });
  e.watcher.tick();
  check("(c) a DIFFERENT (recycled) session id, also over the floor, fires its own first interrupt",
    emergencyEvents(e, "mgr-new").length === 1);
  check("(c) the old session's own count is untouched by the new session's fire", emergencyEvents(e, "mgr-old").length === 1);
  check("(c) two interrupt calls total, one per distinct session id", e.interrupts.length === 2);
  cleanup(e);
}

// (d) A PRE-EXISTING (legacy-shape, no turnSeqAtFire field) event for this session blocks any fire at
// all — presence alone is the whole rule now, so a round-3-era event (or any older one) still correctly
// suppresses a round-4 fire.
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } } });
  seedManager(e, "mgr-legacy", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: new Date().toISOString() });
  e.db.appendEvent({
    id: "legacy-evt", ts: new Date(Date.now() - 3_600_000).toISOString(), managerSessionId: "mgr-legacy",
    kind: "context_emergency_interrupt", detail: { pct: 90, delivered: true, interrupting: false }, // no turnSeqAtFire — legacy shape
  });
  e.watcher.tick();
  check("(d) a pre-existing (legacy-shape) event for this session → no fire at all",
    emergencyEvents(e, "mgr-legacy").length === 1 /* just the seeded one */ && e.interrupts.length === 0);
  cleanup(e);
}

// NOT RE-ARM: card c5b234aa's own cascade bug, as a regression test — a FRESH ctxUpdatedAt (the mid-turn
// sampler ticking) WITHOUT a new turn (lastActivity unchanged) must NOT fire a second interrupt. This is
// the exact scenario that cascaded under the old per-READING de-dup.
{
  const e = makeEnv({ projectConfig: { orchestration: { emergencyRecycleAtContextRatio: 0.85 } } });
  seedManager(e, "mgr-sampler-cascade", { busy: true, ctx: OVER_FLOOR_CTX, ctxUpdatedAt: new Date(Date.now() - 60_000).toISOString() });
  e.watcher.tick();
  check("cascade regression setup: first reading fires once", emergencyEvents(e, "mgr-sampler-cascade").length === 1);
  const firstFireTs2 = emergencyEvents(e, "mgr-sampler-cascade")[0].ts;
  await waitUntil(() => new Date().toISOString() > firstFireTs2, { label: "wall clock strictly past the first fire's event ts" });
  // Simulates MidTurnContextSampler re-stamping ctxUpdatedAt mid-turn — the SAME turn, lastActivity
  // untouched — several times in a row, exactly what used to re-trigger the interrupt on every tick.
  for (let i = 0; i < 3; i++) {
    e.db.setContextCounters("mgr-sampler-cascade", { ctxInputTokens: OVER_FLOOR_CTX, ctxTurns: 1 });
    e.watcher.tick();
  }
  check("cascade regression: a bumped ctxUpdatedAt with NO new turn does NOT re-fire (still exactly 1 event)",
    emergencyEvents(e, "mgr-sampler-cascade").length === 1);
  check("cascade regression: no additional interrupt call was made", e.interrupts.length === 1);
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
  ? "\n✅ ALL PASS — ContextWatcher's emergency interrupt (Trigger A) fires for a manager whose last known reading crosses emergencyRecycleAtContextRatio, honestly records the real delivered/interrupting outcome (never inherits 49fdcbbc's collapse-to-success bug), stays silent when disabled/under-floor/no-hook/not-alive, fires AT MOST ONCE PER SESSION ID with no re-arm key at all (round 4 — neither a Stop inside the settle window nor a genuinely new wind-down turn re-arms it), a different (recycled) session id fires its own first interrupt, a pre-existing legacy-shape event blocks any fire, and a refused attempt (e.g. a merge-danger window) records nothing so the very next tick retries cleanly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
