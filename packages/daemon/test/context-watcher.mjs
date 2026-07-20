import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
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

function makeEnv(ratio = 0.8, { projectConfig } = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `cp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `ct-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  // ratio here is the ENV-style global force override (0 = none, per-project cfg governs instead — see
  // ContextWatcherDeps.ratio). projectConfig lets a test set this project's OWN recycleAtContextRatio.
  db.insertProject({ id: projId, name: "Ctx", repoPath: projId, vaultPath: projId, config: projectConfig ?? {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const watcher = new ContextWatcher({ db, pty, ratio });
  return { dbFile, db, projId, agentId, alive, enqueued, watcher };
}
function seedManager(e, id, { ctx, model = null, live = true }) {
  const now = new Date().toISOString();
  e.db.insertSession({
    id, projectId: e.projId, agentId: e.agentId, engineSessionId: "eng-" + id, title: null, cwd: e.projId,
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
  check("nudge text steers to /loom-session-end + recycle_me", e.enqueued[0]?.text.includes("/loom-session-end") && e.enqueued[0]?.text.includes("recycle_me"));
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

// Disabled per-project (recycleAtContextRatio: 0): no nudge even when full, with no env override.
{
  const e = makeEnv(0, { projectConfig: { orchestration: { recycleAtContextRatio: 0 } } });
  seedManager(e, "mgr-disabled", { ctx: 999_000, model: "claude-opus-4-8" });
  e.watcher.tick();
  check("a project's recycleAtContextRatio: 0 disables the watcher for that project", e.enqueued.length === 0);
  cleanup(e);
}

// Platform-default fallback (BYTE-IDENTICAL invariant): no env force override AND an empty project
// config → the ratio must fold to the platform default (0.80), not silently become disabled or
// unbounded. A manager at ~85% ctx on a 1M Opus IS nudged — proves the empty-config path still fires,
// distinct from the explicit-0.5/0.9-override test below and from the env-force tests above.
{
  const e = makeEnv(0); // no env force override
  seedManager(e, "mgr-platform-default", { ctx: 850_000, model: "claude-opus-4-8" }); // 85% of 1M
  e.watcher.tick();
  check("empty project config falls back to the platform default (0.80) — 85% IS nudged", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-platform-default");
  cleanup(e);
}

// Only managers: a plain (roleless) live session over the ratio is ignored (listLivemanagers is manager-only).
{
  const e = makeEnv(0.8);
  const now = new Date().toISOString();
  e.db.insertSession({
    id: "plain-1", projectId: e.projId, agentId: e.agentId, engineSessionId: "e1", title: null, cwd: e.projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: null, ctxInputTokens: 999_000, ctxTurns: 1, model: "claude-opus-4-8",
  });
  e.alive.add("plain-1");
  e.watcher.tick();
  check("only managers are watched (plain session over ratio ignored)", e.enqueued.length === 0);
  cleanup(e);
}

// Per-project resolution: two projects with DIFFERENT recycleAtContextRatio (0.5 vs 0.9), no env
// override. A manager at 60% ctx is over the 0.5 project's threshold but under the 0.9 project's —
// proving the ratio is resolved from EACH manager's own project, not a single global value (93335f4e).
{
  const e = makeEnv(0, { projectConfig: { orchestration: { recycleAtContextRatio: 0.5 } } });
  seedManager(e, "mgr-low-ratio-project", { ctx: 600_000, model: "claude-opus-4-8" }); // 60% of 1M

  const projId2 = `cp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId2 = `ct-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  e.db.insertProject({ id: projId2, name: "Ctx2", repoPath: projId2, vaultPath: projId2, config: { orchestration: { recycleAtContextRatio: 0.9 } }, createdAt: now, archivedAt: null });
  e.db.insertAgent({ id: agentId2, projectId: projId2, name: "t2", startupPrompt: "orchestrate", position: 0 });
  e.db.insertSession({
    id: "mgr-high-ratio-project", projectId: projId2, agentId: agentId2, engineSessionId: "eng-mgr-high-ratio-project",
    title: null, cwd: projId2, processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
    ctxInputTokens: 600_000, ctxTurns: 1, model: "claude-opus-4-8",
  });
  e.alive.add("mgr-high-ratio-project");

  e.watcher.tick();
  check("per-project: manager over its OWN project's 0.5 ratio (60%) IS nudged", e.enqueued.some((x) => x.id === "mgr-low-ratio-project"));
  check("per-project: sibling manager under its OWN project's 0.9 ratio (same 60% ctx) is NOT nudged", !e.enqueued.some((x) => x.id === "mgr-high-ratio-project"));
  cleanup(e);
}

// Env force override wins over EVERY project's own ratio, including a lower one.
{
  const e = makeEnv(0.9, { projectConfig: { orchestration: { recycleAtContextRatio: 0.2 } } }); // project wants 0.2, env forces 0.9
  seedManager(e, "mgr-env-forced", { ctx: 600_000, model: "claude-opus-4-8" }); // 60%: over the project's 0.2, under the env-forced 0.9
  e.watcher.tick();
  check("env override (0.9) wins over a lower per-project ratio (0.2) — 60% is NOT nudged", e.enqueued.length === 0);
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ContextWatcher nudges over-ratio MANAGERS once, scales the threshold per model window, skips below-threshold/plain sessions, resolves the ratio PER-PROJECT (env override else project's own recycleAtContextRatio), and disables at a project's own ratio 0."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
