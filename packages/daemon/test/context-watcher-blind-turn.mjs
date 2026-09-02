import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ContextWatcher BLIND-TURN advisory test (card fdf1291f) — the SECOND, turn-boundary-independent
// input: a manager `busy` in ONE uninterrupted turn (no Stop, so ctxInputTokens/ctxUpdatedAt never
// refresh) past `managerBlindTurnMinutes`. NO claude — the watcher takes an injected pty-slice, so the
// tick tests use a RECORDING STUB and drive tick() directly. Hermetic: each env gets its OWN temp .db.
//
// RED-FIRST (card fdf1291f DoD-4): the literal fixture this file's first block reproduces — a LIVE
// manager, busy=1, ctx_updated_at IS NULL, sustained past the threshold, with NO Stop for the duration —
// was run against context-watcher.ts BEFORE this file's checkBlindTurn existed (temporarily reverted via
// `git diff` + `git checkout HEAD --` + re-apply, per the worker doctrine's revert-to-prove-red recipe;
// never `git stash`, which is shared across worktrees). Observed RED: `db.listEvents(mgrId)` returned
// ZERO events and `e.enqueued` stayed empty — today's watcher (pre-fix) emits nothing for this fixture,
// exactly as the card's DoD-4 predicted. This file, run against the FIXED source, is the GREEN half.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { ContextWatcher } from "../dist/orchestration/context-watcher.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv({ projectConfig } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-ctx-blind-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `cp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ct-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "CtxBlind", repoPath: projId, vaultPath: projId, config: projectConfig ?? {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const watcher = new ContextWatcher({ db, pty, ratio: 0 }); // ratio 0 = no env force override; ratio logic is not this file's concern
  return { dbFile, db, projId, agentId, alive, enqueued, watcher };
}

// `lastActivityMinutesAgo` is the knob that drives checkBlindTurn's staleness math; `ctx`/`ctxUpdatedAt`
// let a test reproduce EITHER the never-armed (DoD-4's literal fixture) or the stale-non-null case.
function seedManager(e, id, { busy, lastActivityMinutesAgo, ctx = null, ctxUpdatedAt = null, model = "claude-opus-4-8", live = true }) {
  const now = new Date();
  const lastActivity = new Date(now.getTime() - lastActivityMinutesAgo * 60_000).toISOString();
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy,
    createdAt: lastActivity, lastActivity, lastError: null, role: "manager",
    ctxInputTokens: ctx, ctxTurns: ctx != null ? 1 : null, ctxUpdatedAt, model,
  });
  if (live) e.alive.add(id);
  return lastActivity;
}

function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

function blindEvents(e, id) {
  return e.db.listEvents(id).filter((ev) => ev.kind === "context_blind_turn");
}

// DoD-4's LITERAL fixture: busy=1, ctx_updated_at IS NULL (never armed), sustained past the threshold,
// no Stop for the duration. Today's ratio-based logic skips this manager outright (ctxInputTokens ==
// null → continue) — this is the exact case the RED half above proved silent.
{
  const e = makeEnv({ projectConfig: { orchestration: { managerBlindTurnMinutes: 20 } } });
  seedManager(e, "mgr-blind-null", { busy: true, lastActivityMinutesAgo: 25, ctx: null, ctxUpdatedAt: null });
  e.watcher.tick();
  const events = blindEvents(e, "mgr-blind-null");
  check("DoD-4 fixture: busy+ctx-null+sustained(25m>20m) → exactly one context_blind_turn event", events.length === 1);
  check("event carries minutesBusy ~25", events[0]?.detail?.minutesBusy === 25);
  check("no queued nudge is attempted (busy-gated queue can't reach a manager stuck mid-turn)", e.enqueued.length === 0);
  cleanup(e);
}

// The MORE dangerous recurring form: ctxInputTokens is NOT null (a stale reading from a prior turn) —
// the ratio check's own null-skip wouldn't even apply here, yet the manager is STILL blind for the
// CURRENT turn. Proves checkBlindTurn deliberately does not gate on ctxInputTokens == null.
{
  const e = makeEnv({ projectConfig: { orchestration: { managerBlindTurnMinutes: 20 } } });
  const staleAt = new Date(Date.now() - 40 * 60_000).toISOString();
  seedManager(e, "mgr-blind-stale", { busy: true, lastActivityMinutesAgo: 25, ctx: 500_000, ctxUpdatedAt: staleAt });
  e.watcher.tick();
  check("stale (non-null) ctxInputTokens does NOT suppress the blind-turn advisory", blindEvents(e, "mgr-blind-stale").length === 1);
  cleanup(e);
}

// Not busy: lastActivity staleness means nothing for an idle manager — never this watchdog's concern.
{
  const e = makeEnv({ projectConfig: { orchestration: { managerBlindTurnMinutes: 20 } } });
  seedManager(e, "mgr-idle", { busy: false, lastActivityMinutesAgo: 999, ctx: null });
  e.watcher.tick();
  check("idle (busy=false) manager never trips the blind-turn advisory", blindEvents(e, "mgr-idle").length === 0);
  cleanup(e);
}

// Below threshold: busy but not sustained long enough yet.
{
  const e = makeEnv({ projectConfig: { orchestration: { managerBlindTurnMinutes: 20 } } });
  seedManager(e, "mgr-short", { busy: true, lastActivityMinutesAgo: 5, ctx: null });
  e.watcher.tick();
  check("busy but under the threshold (5m<20m) → no event yet", blindEvents(e, "mgr-short").length === 0);
  cleanup(e);
}

// Disabled per-project (managerBlindTurnMinutes: 0): no event even when everything else would trip it.
{
  const e = makeEnv({ projectConfig: { orchestration: { managerBlindTurnMinutes: 0 } } });
  seedManager(e, "mgr-disabled", { busy: true, lastActivityMinutesAgo: 999, ctx: null });
  e.watcher.tick();
  check("a project's managerBlindTurnMinutes: 0 disables the blind-turn watchdog", blindEvents(e, "mgr-disabled").length === 0);
  cleanup(e);
}

// Once-per-episode: two ticks on the SAME still-blind turn fire exactly one event (mirrors
// BusyWorkerWatcher's worker_stuck de-dup — an event stamped after lastActivity suppresses a repeat).
{
  const e = makeEnv({ projectConfig: { orchestration: { managerBlindTurnMinutes: 20 } } });
  seedManager(e, "mgr-once", { busy: true, lastActivityMinutesAgo: 25, ctx: null });
  e.watcher.tick();
  e.watcher.tick();
  check("once-per-episode: a sustained blind turn is flagged exactly once across ticks", blindEvents(e, "mgr-once").length === 1);
  cleanup(e);
}

// Best-effort diagnostic: session_usage_samples rows recorded during the blind window are summarized
// into the event's detail, WITHOUT being required to fire (see the next block for the no-samples case).
{
  const e = makeEnv({ projectConfig: { orchestration: { managerBlindTurnMinutes: 20 } } });
  const lastActivity = seedManager(e, "mgr-active", { busy: true, lastActivityMinutesAgo: 25, ctx: null });
  const sampleTs = new Date(Date.parse(lastActivity) + 5 * 60_000).toISOString(); // inside the blind window
  e.db.insertUsageSample({
    id: "s1", sessionId: "mgr-active", projectId: e.projId, agentId: e.agentId, model: "claude-opus-4-8",
    ts: sampleTs, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 2000, cacheReadTokens: 8000, costUsd: 0.01,
  });
  e.watcher.tick();
  const ev = blindEvents(e, "mgr-active")[0];
  check("usage-sample activity is summarized into the event (100+50+2000+8000=10150)", ev?.detail?.tokensSinceLastKnown === 10150);
  check("sampleCount reflects the one row recorded during the window", ev?.detail?.sampleCount === 1);
  cleanup(e);
}

// No samples yet: the alert still fires (a sampler outage must never suppress it) — with a null token
// figure and zero sampleCount, honest about not having confirmed genuine token flow.
{
  const e = makeEnv({ projectConfig: { orchestration: { managerBlindTurnMinutes: 20 } } });
  seedManager(e, "mgr-no-samples", { busy: true, lastActivityMinutesAgo: 25, ctx: null });
  e.watcher.tick();
  const ev = blindEvents(e, "mgr-no-samples")[0];
  check("no samples recorded → event STILL fires (a sampler outage must not suppress the alert)", !!ev);
  check("tokensSinceLastKnown is honestly null, not a guessed 0", ev?.detail?.tokensSinceLastKnown === null);
  check("sampleCount is 0", ev?.detail?.sampleCount === 0);
  cleanup(e);
}

// Only managers: a plain (roleless) live session is never watched by listLiveManagers().
{
  const e = makeEnv({ projectConfig: { orchestration: { managerBlindTurnMinutes: 20 } } });
  const now = new Date();
  const lastActivity = new Date(now.getTime() - 999 * 60_000).toISOString();
  e.db.insertSession({
    id: "plain-1", projectId: e.projId, agentId: e.agentId, engineSessionId: "e1", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: true, createdAt: lastActivity, lastActivity, lastError: null,
    role: null, ctxInputTokens: null, ctxTurns: null, model: "claude-opus-4-8",
  });
  e.alive.add("plain-1");
  e.watcher.tick();
  check("only managers are watched (plain busy session ignored)", blindEvents(e, "plain-1").length === 0);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ContextWatcher's blind-turn advisory fires for a busy manager stuck past managerBlindTurnMinutes with no Stop (armed or stale-armed alike), stays silent for idle/under-threshold/disabled/non-manager sessions, fires exactly once per episode, and folds in session_usage_samples as a best-effort (never gating) diagnostic."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
