import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ContextWatcher PERSIST + RE-NUDGE + ESCALATE test (idle-watcher parity). NO claude — the watcher
// takes an injected pty-slice, so the tick tests use a RECORDING STUB and drive tick() directly.
// Hermetic like context-watcher.mjs / idle-watcher.mjs: each env gets its OWN temp .db. Covers: the
// first nudge PERSISTS state (recordContextNudge increments + stamps + policy stays watching); the
// re-nudge CADENCE (silent within recycleNudgeIntervalMinutes, fires after it elapses); persistence
// across a daemon RESTART (reopen the same .db file); the ESCALATE-once-at-cap path (one
// context_escalated event + policy→escalated, no re-emit on a later tick, no nudge); and that the zod
// orchestrationOverride + resolveConfig accept the two new knobs (strictness otherwise intact).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { ContextWatcher } from "../dist/orchestration/context-watcher.js";
import { resolveConfig } from "@loom/shared";
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const NOW = new Date("2026-06-26T12:00:00.000Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
const minutesLater = (m) => new Date(NOW.getTime() + m * 60_000);

// Build an env over a (fresh or REOPENED) db file, so the restart test can re-attach to the same .db.
function makeEnv({ ratio = 0.8, projectConfig = {}, dbFile, projId, agentId } = {}) {
  const file = dbFile ?? path.join(os.tmpdir(), `loom-ctx-esc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(file);
  const pid = projId ?? `cp-${Math.random().toString(36).slice(2, 8)}`;
  const aid = agentId ?? `ct-${Math.random().toString(36).slice(2, 8)}`;
  if (!dbFile) {
    db.insertProject({ id: pid, name: "Ctx", repoPath: pid, vaultPath: pid, config: projectConfig, createdAt: NOW.toISOString(), archivedAt: null });
    db.insertAgent({ id: aid, projectId: pid, name: "t", startupPrompt: "orchestrate", position: 0 });
  }
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const watcher = new ContextWatcher({ db, pty, ratio });
  return { dbFile: file, db, projId: pid, agentId: aid, alive, enqueued, watcher };
}
// Seed a manager OVER the 0.8 ratio by default (180k / 200k = 0.90), live.
function seedManager(e, id, { ctx = 180_000, model = null, live = true } = {}) {
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy: false,
    createdAt: NOW.toISOString(), lastActivity: NOW.toISOString(), lastError: null, role: "manager",
    ctxInputTokens: ctx, ctxTurns: 1, model,
  });
  if (live) e.alive.add(id);
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ===================== (1) first nudge PERSISTS state (default policy watching) =====================
{
  const e = makeEnv();
  seedManager(e, "mgr-first");
  check("(1) precondition: default state is watching / unanswered 0 / never-nudged",
    (() => { const s = e.db.getContextNudgeState("mgr-first"); return s?.policy === "watching" && s?.unanswered === 0 && s?.lastContextNudgeAt === null; })());
  e.watcher.tick(NOW);
  check("(1) over-ratio manager IS nudged", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-first");
  check("(1) nudge text steers to /session-end + recycle_me", e.enqueued[0]?.text.includes("/session-end") && e.enqueued[0]?.text.includes("recycle_me"));
  const s = e.db.getContextNudgeState("mgr-first");
  check("(1) recordContextNudge incremented unanswered 0→1 + stamped last_context_nudge_at", s?.unanswered === 1 && s?.lastContextNudgeAt === NOW.toISOString());
  check("(1) policy stays 'watching' after a nudge (escalation not yet)", s?.policy === "watching");
  cleanup(e);
}

// ===================== (2) RE-NUDGE cadence — silent within the window, fires after =====================
{
  const e = makeEnv();
  seedManager(e, "mgr-recent");
  e.db.recordContextNudge("mgr-recent", minutesAgo(5)); // nudged 5m ago (< 20 default) → wait
  e.watcher.tick(NOW);
  check("(2) a manager nudged 5m ago is NOT re-nudged within the 20m cadence window", e.enqueued.length === 0);
  cleanup(e);
}
{
  const e = makeEnv();
  seedManager(e, "mgr-stale");
  e.db.recordContextNudge("mgr-stale", minutesAgo(25)); // nudged 25m ago (> 20) → re-nudge due
  e.watcher.tick(NOW);
  check("(2b) a manager last nudged 25m ago IS re-nudged once the cadence elapses", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-stale");
  check("(2b) the re-nudge increments unanswered 1→2", e.db.getContextNudgeState("mgr-stale")?.unanswered === 2);
  cleanup(e);
}

// ===================== (3) state SURVIVES a daemon restart (reopen the same .db) =====================
{
  const e = makeEnv();
  seedManager(e, "mgr-restart");
  e.watcher.tick(NOW); // first nudge persists unanswered=1 + last_context_nudge_at=NOW
  check("(3) pre-restart: nudged once", e.enqueued.length === 1 && e.db.getContextNudgeState("mgr-restart")?.unanswered === 1);
  const { dbFile, projId, agentId } = e;
  e.db.close(); // simulate daemon shutdown (keep the file)
  // Reopen the SAME .db with a fresh watcher/pty (simulate the restarted daemon).
  const e2 = makeEnv({ dbFile, projId, agentId });
  e2.alive.add("mgr-restart"); // the resumed manager is live again
  const s2 = e2.db.getContextNudgeState("mgr-restart");
  check("(3) post-restart: persisted unanswered=1 + last_context_nudge_at survived", s2?.unanswered === 1 && s2?.lastContextNudgeAt === NOW.toISOString());
  e2.watcher.tick(NOW); // same instant → still inside the cadence window
  check("(3) post-restart: NOT re-nudged within the same cadence window (state honored across restart)", e2.enqueued.length === 0);
  e2.watcher.tick(minutesLater(25)); // 25m later → cadence elapsed → re-nudge
  check("(3) post-restart: re-nudged after the cadence elapses (unanswered 1→2)", e2.enqueued.length === 1 && e2.db.getContextNudgeState("mgr-restart")?.unanswered === 2);
  cleanup(e2); // closes + removes the shared file
}

// ===================== (4) ESCALATE once at the unanswered cap (default 3) =====================
{
  const e = makeEnv();
  seedManager(e, "mgr-capped", { ctx: 180_000, model: null }); // 90% of 200k
  // three unanswered nudges, the last stamped in the PAST so the cadence wouldn't itself block → at cap (3).
  e.db.recordContextNudge("mgr-capped", minutesAgo(120));
  e.db.recordContextNudge("mgr-capped", minutesAgo(80));
  e.db.recordContextNudge("mgr-capped", minutesAgo(40));
  check("(4) precondition: unanswered === maxUnansweredRecycleNudges (3)", e.db.getContextNudgeState("mgr-capped")?.unanswered === 3);
  const escalations = () => e.db.listEvents("mgr-capped").filter((ev) => ev.kind === "context_escalated");
  e.watcher.tick(NOW);
  check("(4) at/over the cap → does NOT enqueue another nudge (the event is the signal)", e.enqueued.length === 0);
  const esc = escalations();
  check("(4) at/over the cap → emits exactly ONE context_escalated event", esc.length === 1);
  check("(4) context_escalated detail carries reason=unanswered_cap + unanswered + pct", esc[0]?.detail?.reason === "unanswered_cap" && esc[0]?.detail?.unanswered === 3 && esc[0]?.detail?.pct === 90);
  check("(4) escalation flips policy to 'escalated' (stops nudging + gates re-emit)", e.db.getContextNudgeState("mgr-capped")?.policy === "escalated");
  // A SECOND tick must NOT re-emit (escalated → policy gate skips it; escalate exactly once).
  e.watcher.tick(minutesLater(60));
  check("(4) a second (later) tick does NOT re-emit context_escalated (escalate exactly once)", escalations().length === 1);
  check("(4) a second tick still enqueues no nudge", e.enqueued.length === 0);
  cleanup(e);
}
// An already-'escalated' manager is silent on a fresh tick even though it's still over-ratio.
{
  const e = makeEnv();
  seedManager(e, "mgr-already-esc");
  e.db.setContextNudgePolicy("mgr-already-esc", "escalated");
  e.watcher.tick(NOW);
  check("(4b) an 'escalated' manager is neither re-nudged nor re-escalated", e.enqueued.length === 0 && e.db.listEvents("mgr-already-esc").filter((ev) => ev.kind === "context_escalated").length === 0);
  cleanup(e);
}

// ===================== (5) per-project knobs honored (cadence 60 / cap 1) =====================
{
  const e = makeEnv({ projectConfig: { orchestration: { recycleNudgeIntervalMinutes: 60, maxUnansweredRecycleNudges: 1 } } });
  seedManager(e, "mgr-tight");
  e.db.recordContextNudge("mgr-tight", minutesAgo(30)); // 30m ago: < 60 cadence → silent, AND unanswered=1=cap
  e.watcher.tick(NOW);
  check("(5) per-project cadence (60m) suppresses a 30m-old re-nudge", e.enqueued.length === 0);
  // advance past the 60m cadence → now at cap (1) → escalate (not nudge).
  e.watcher.tick(minutesLater(40)); // 30m-ago nudge is now 70m old → cadence elapsed
  check("(5) per-project cap (1) → escalates after the cadence elapses (one context_escalated)", e.db.listEvents("mgr-tight").filter((ev) => ev.kind === "context_escalated").length === 1);
  check("(5) per-project cap escalation enqueued no nudge", e.enqueued.length === 0);
  cleanup(e);
}

// ===================== (6) zod + resolveConfig accept the two new knobs =====================
{
  const full = validateProjectConfigOverride({ orchestration: { recycleNudgeIntervalMinutes: 15, maxUnansweredRecycleNudges: 5 } });
  check("(6) REST validator accepts recycleNudgeIntervalMinutes/maxUnansweredRecycleNudges", full.ok === true);
  const agent = validateAgentProjectConfigOverride({ orchestration: { recycleNudgeIntervalMinutes: 15, maxUnansweredRecycleNudges: 5 } });
  check("(6) agent (loom-platform MCP) validator accepts the two new keys (benign tuning)", agent.ok === true);
  const bad = validateProjectConfigOverride({ orchestration: { bogusKey: 1 } });
  check("(6) .strict() still rejects an unknown orchestration key", bad.ok === false);
  const resolved = resolveConfig({ orchestration: { recycleNudgeIntervalMinutes: 15, maxUnansweredRecycleNudges: 5 } }).orchestration;
  check("(6) resolveConfig merges the overrides", resolved.recycleNudgeIntervalMinutes === 15 && resolved.maxUnansweredRecycleNudges === 5);
  const defaults = resolveConfig(undefined).orchestration;
  check("(6) resolveConfig defaults are 20m / cap 3", defaults.recycleNudgeIntervalMinutes === 20 && defaults.maxUnansweredRecycleNudges === 3);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ContextWatcher PERSISTS its recycle-nudge state (recordContextNudge increments + stamps; survives a daemon restart), RE-NUDGES only after recycleNudgeIntervalMinutes elapses, ESCALATES ONCE at maxUnansweredRecycleNudges (one context_escalated event + policy→escalated, no re-emit/nudge on a later tick), honors per-project knobs, and the zod/resolveConfig surfaces accept the two new keys (strictness intact)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
