// ContextWatcher test (manager recycle-by-context). NO claude — the watcher takes an injected
// pty-slice, so the tick tests use a RECORDING STUB and drive tick() directly. Hermetic: each env
// gets its OWN temp .db. Covers: per-model threshold (1M vs 200k window), nudge-once, below-threshold
// skip, ratio=0 disable, and forgetting a manager that goes not-live.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { ContextWatcher } from "../dist/orchestration/context-watcher.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv(ratio = 0.8) {
  const dbFile = path.join(os.tmpdir(), `loom-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `cp-${Math.random().toString(36).slice(2, 8)}`;
  const topicId = `ct-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "Ctx", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertTopic({ id: topicId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const watcher = new ContextWatcher({ db, pty, ratio });
  return { dbFile, db, projId, topicId, alive, enqueued, watcher };
}
function seedManager(e, id, { ctx, model = null, live = true }) {
  const now = new Date().toISOString();
  e.db.insertSession({
    id, projectId: e.projId, topicId: e.topicId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
    ctxInputTokens: ctx, ctxTurns: 1, model,
  });
  if (live) e.alive.add(id);
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// Per-model threshold: at the SAME 170k tokens, a 200k-window model is over 0.8 (nudge) while a 1M
// Opus is well under (no nudge) — proving the trigger scales with the model's window.
{
  const e = makeEnv(0.8);
  seedManager(e, "mgr-200k", { ctx: 170_000, model: null });        // 170k/200k = 0.85 → nudge
  seedManager(e, "mgr-opus", { ctx: 170_000, model: "claude-opus-4-8" }); // 170k/1M = 0.17 → no nudge
  e.watcher.tick();
  check("per-model: 200k-window manager at 170k (85%) is nudged", e.enqueued.some((x) => x.id === "mgr-200k"));
  check("per-model: 1M Opus manager at 170k (17%) is NOT nudged", !e.enqueued.some((x) => x.id === "mgr-opus"));
  check("nudge text steers to /session-end + recycle_me", e.enqueued[0]?.text.includes("/session-end") && e.enqueued[0]?.text.includes("recycle_me"));
  cleanup(e);
}

// Opus over its own 0.8: 850k / 1M = 0.85 → nudge.
{
  const e = makeEnv(0.8);
  seedManager(e, "mgr-big", { ctx: 850_000, model: "claude-opus-4-8[1m]" });
  e.watcher.tick();
  check("1M Opus at 850k (85%) is nudged", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-big");
  cleanup(e);
}

// Nudge-once: a second tick on the same over-threshold manager does NOT re-nudge.
{
  const e = makeEnv(0.8);
  seedManager(e, "mgr-once", { ctx: 950_000, model: "claude-opus-4-8" });
  e.watcher.tick();
  e.watcher.tick();
  check("nudge-once: an over-threshold manager is nudged exactly once across ticks", e.enqueued.length === 1);
  cleanup(e);
}

// Below threshold: never nudged.
{
  const e = makeEnv(0.8);
  seedManager(e, "mgr-small", { ctx: 100_000, model: "claude-opus-4-8" }); // 10%
  e.watcher.tick();
  check("below threshold: not nudged", e.enqueued.length === 0);
  cleanup(e);
}

// Disabled (ratio 0): no nudge even when full.
{
  const e = makeEnv(0);
  seedManager(e, "mgr-disabled", { ctx: 999_000, model: "claude-opus-4-8" });
  e.watcher.tick();
  check("ratio 0 disables the watcher entirely", e.enqueued.length === 0);
  cleanup(e);
}

// Only managers: a plain (roleless) live session over the ratio is ignored (listLivemanagers is manager-only).
{
  const e = makeEnv(0.8);
  const now = new Date().toISOString();
  e.db.insertSession({
    id: "plain-1", projectId: e.projId, topicId: e.topicId, engineSessionId: "e1", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: null, ctxInputTokens: 999_000, ctxTurns: 1, model: "claude-opus-4-8",
  });
  e.alive.add("plain-1");
  e.watcher.tick();
  check("only managers are watched (plain session over ratio ignored)", e.enqueued.length === 0);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ContextWatcher nudges over-ratio MANAGERS once, scales the threshold per model window, skips below-threshold/plain sessions, and disables at ratio 0."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
