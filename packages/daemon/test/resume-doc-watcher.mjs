import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// ResumeDocWatcher test (card 809cc4b5) — the mid-session proactive half of the resume-doc size-budget
// nudge: composeManagerStartupPrompt only warns at spawn/recycle time, which is too late for a manager
// that stays live and keeps rewriting its doc without ever recycling. NO claude — the watcher takes an
// injected pty-slice, so the tick tests use a RECORDING STUB and drive tick() directly, structural twin
// of context-watcher.mjs. Hermetic: each env gets its OWN temp .db AND its OWN temp vault dir (real
// on-disk files — the watcher stats a real path).
//
// Covers: oversized doc ⇒ nudge fires; below-threshold ⇒ no nudge; cooldown suppresses an immediate
// re-nudge; a doc that shrinks back under threshold clears the cooldown so future regrowth nudges fresh;
// a missing resume-doc file (fresh project, nothing written yet) is a silent no-op and NEVER throws;
// only LIVE managers are watched; multiple live managers across different projects are handled
// independently.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { ResumeDocWatcher } from "../dist/orchestration/resume-doc-watcher.js";
import { RESUME_DOC_WARN_BYTES } from "../dist/sessions/resume-doc-notes.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function makeEnv(opts = {}) {
  const dbFile = path.join(os.tmpdir(), `loom-rdw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Db(dbFile);
  const projId = `rp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `rt-${Math.random().toString(36).slice(2, 8)}`;
  const vaultPath = path.join(os.tmpdir(), `loom-rdw-vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(vaultPath, { recursive: true });
  const now = new Date().toISOString();
  db.insertProject({ id: projId, name: "RDW", repoPath: projId, vaultPath, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
  const alive = new Set();
  const enqueued = [];
  const pty = {
    isAlive: (id) => alive.has(id),
    enqueueStdin: (id, text) => { enqueued.push({ id, text }); return { delivered: true }; },
  };
  const watcher = new ResumeDocWatcher({ db, pty, ...opts });
  return { dbFile, db, projId, agentId, vaultPath, alive, enqueued, watcher };
}
function seedManager(e, id, { live = true, projId = e.projId, agentId = e.agentId } = {}) {
  const now = new Date().toISOString();
  e.db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: projId,
    processState: live ? "live" : "exited", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  if (live) e.alive.add(id);
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(e.vaultPath, { recursive: true, force: true }); } catch { /* ignore */ }
}
const resumeDocPath = (e) => path.join(e.vaultPath, "Orchestrator Log.md");

// A fresh project with no resume doc written yet ⇒ silent no-op, no nudge, no throw.
{
  const e = makeEnv();
  seedManager(e, "mgr-fresh");
  check("missing resume doc: tick() does not throw", (() => { try { e.watcher.tick(); return true; } catch { return false; } })());
  check("missing resume doc: no nudge fires", e.enqueued.length === 0);
  cleanup(e);
}

// Below threshold ⇒ never nudged.
{
  const e = makeEnv();
  seedManager(e, "mgr-small");
  fs.writeFileSync(resumeDocPath(e), "# Orchestrator Log\n\nSTATE: nothing notable.\n");
  e.watcher.tick();
  check("below threshold: not nudged", e.enqueued.length === 0);
  cleanup(e);
}

// At/over threshold ⇒ nudged, with the right message shape.
{
  const e = makeEnv();
  seedManager(e, "mgr-big");
  fs.writeFileSync(resumeDocPath(e), "x".repeat(RESUME_DOC_WARN_BYTES + 1024));
  e.watcher.tick();
  check("over threshold: nudged exactly once", e.enqueued.length === 1 && e.enqueued[0].id === "mgr-big");
  check("nudge text carries the [loom:resume-doc-size] marker + tells the manager to rotate", e.enqueued[0]?.text.includes("[loom:resume-doc-size]") && /rotate/i.test(e.enqueued[0]?.text));
  cleanup(e);
}

// Cooldown: a second tick shortly after does NOT re-nudge while still oversized.
{
  const e = makeEnv({ cooldownMs: 30 * 60_000 });
  seedManager(e, "mgr-cooldown");
  fs.writeFileSync(resumeDocPath(e), "x".repeat(RESUME_DOC_WARN_BYTES + 1024));
  const t0 = 1_000_000;
  e.watcher.tick(t0);
  e.watcher.tick(t0 + 60_000); // 1 minute later — well under the 30-minute cooldown
  check("cooldown: still-oversized doc is nudged exactly once across two quick ticks", e.enqueued.length === 1);
  cleanup(e);
}

// Cooldown elapses ⇒ re-nudges if still oversized.
{
  const e = makeEnv({ cooldownMs: 1000 });
  seedManager(e, "mgr-recooldown");
  fs.writeFileSync(resumeDocPath(e), "x".repeat(RESUME_DOC_WARN_BYTES + 1024));
  const t0 = 1_000_000;
  e.watcher.tick(t0);
  e.watcher.tick(t0 + 2000); // past the 1s cooldown
  check("cooldown elapsed: a still-oversized doc is re-nudged", e.enqueued.length === 2 && e.enqueued.every((x) => x.id === "mgr-recooldown"));
  cleanup(e);
}

// Self-clearing: once the manager rotates (doc shrinks back under threshold), the cooldown clears —
// a LATER regrowth past threshold nudges immediately, not gated by the earlier cooldown window.
{
  const e = makeEnv({ cooldownMs: 30 * 60_000 });
  seedManager(e, "mgr-rotate");
  const doc = resumeDocPath(e);
  fs.writeFileSync(doc, "x".repeat(RESUME_DOC_WARN_BYTES + 1024));
  const t0 = 1_000_000;
  e.watcher.tick(t0); // nudge #1
  fs.writeFileSync(doc, "# Orchestrator Log\n\nSTATE: rotated.\n"); // manager rotates — shrinks back down
  e.watcher.tick(t0 + 5000); // still well within the cooldown window, but now under threshold
  check("rotation: shrinking under threshold fires no additional nudge", e.enqueued.length === 1);
  fs.writeFileSync(doc, "x".repeat(RESUME_DOC_WARN_BYTES + 1024)); // regrows past threshold
  e.watcher.tick(t0 + 6000); // moments later — would still be inside the OLD cooldown if it weren't cleared
  check("rotation: a fresh regrowth past threshold nudges immediately (cooldown was cleared by the shrink)", e.enqueued.length === 2);
  cleanup(e);
}

// Only LIVE managers are watched — an exited manager with an oversized doc is ignored.
{
  const e = makeEnv();
  seedManager(e, "mgr-exited", { live: false });
  fs.writeFileSync(resumeDocPath(e), "x".repeat(RESUME_DOC_WARN_BYTES + 1024));
  e.watcher.tick();
  check("only live managers are watched (exited manager ignored)", e.enqueued.length === 0);
  cleanup(e);
}

// pty.isAlive() reports false even though the DB row is live (a race/edge case) ⇒ still no nudge.
{
  const e = makeEnv();
  seedManager(e, "mgr-notalive");
  e.alive.delete("mgr-notalive"); // DB says live, pty says not alive
  fs.writeFileSync(resumeDocPath(e), "x".repeat(RESUME_DOC_WARN_BYTES + 1024));
  e.watcher.tick();
  check("pty reports not-alive: no nudge even though the DB row is live", e.enqueued.length === 0);
  cleanup(e);
}

// Multiple live managers across different projects handled independently.
{
  const e = makeEnv();
  seedManager(e, "mgr-a");
  fs.writeFileSync(resumeDocPath(e), "x".repeat(RESUME_DOC_WARN_BYTES + 1024)); // oversized

  const projId2 = `rp-${Math.random().toString(36).slice(2, 8)}`;
  const agentId2 = `rt-${Math.random().toString(36).slice(2, 8)}`;
  const vault2 = path.join(os.tmpdir(), `loom-rdw-vault2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(vault2, { recursive: true });
  const now = new Date().toISOString();
  e.db.insertProject({ id: projId2, name: "RDW2", repoPath: projId2, vaultPath: vault2, config: {}, createdAt: now, archivedAt: null });
  e.db.insertAgent({ id: agentId2, projectId: projId2, name: "t2", startupPrompt: "orchestrate", position: 0 });
  seedManager(e, "mgr-b", { projId: projId2, agentId: agentId2 });
  fs.writeFileSync(path.join(vault2, "Orchestrator Log.md"), "# small\n"); // healthy

  e.watcher.tick();
  check("independent projects: the oversized manager IS nudged", e.enqueued.some((x) => x.id === "mgr-a"));
  check("independent projects: the healthy sibling manager is NOT nudged", !e.enqueued.some((x) => x.id === "mgr-b"));
  try { fs.rmSync(vault2, { recursive: true, force: true }); } catch { /* ignore */ }
  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — ResumeDocWatcher nudges over-threshold LIVE managers' resume docs, respects a cooldown, self-clears on rotation so regrowth nudges fresh, and never throws on a missing resume-doc file — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
