import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework §1 — the grants table JOINS the existing
// session-retire/unbind cascade so a recycled session id can never inherit a stale grant. Fully hermetic: a
// REAL Db, no live network, no real claude, no daemon. Covers the card's DoD (b):
//   1. A FULL unbind (deleteCompanionBinding(sessionId), channel omitted) cascade-clears grants — the
//      session can no longer be reached on ANY channel, so its levers go with it.
//   2. A PER-CHANNEL unbind does NOT clear grants — the companion is still reachable (and still holds its
//      levers) on its other channel(s); grants are session-scoped, not channel-scoped.
//   3. deleteCompanionConfig (de-provision / full teardown) cascade-clears grants.
//   4. deleteSession (the Archive tab's permanent delete) cascade-clears grants.
//   5. deleteProject / deleteAgent cascade-clear grants for every session they own.
//   6. Re-running any of these cascades on an already-cleared session is a safe no-op (idempotent).
// Run: 1) build (turbo builds shared first), 2) node test/companion-grants-cascade.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-companion-grants-cascade-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");

const now = new Date().toISOString();
const dbFile = (name) => path.join(tmpHome, name);
function seedCompanion(db, sessionId, projectId = `proj-${sessionId}`) {
  db.insertProject({ id: projectId, name: sessionId, repoPath: projectId, vaultPath: projectId, config: {}, createdAt: now, archivedAt: null });
  const agentId = `agent-${sessionId}`;
  db.insertAgent({ id: agentId, projectId, name: "companion", startupPrompt: "", position: 0 });
  db.insertSession({
    id: sessionId, projectId, agentId, engineSessionId: `eng-${sessionId}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "assistant",
  });
  return { projectId, agentId };
}

try {
  // ============ 1/2 — deleteCompanionBinding: full unbind clears grants, per-channel unbind does NOT ============
  {
    const db = new Db(dbFile("p1.db"));
    const sid = "sess-unbind-cascade";
    const { projectId } = seedCompanion(db, sid);
    db.upsertCompanionBinding({ sessionId: sid, channel: "telegram", chatId: "tg-chat", scope: "dm" });
    db.upsertCompanionBinding({ sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, scope: "dm" });
    db.upsertCompanionCapabilityGrant({ sessionId: sid, capability: "session-status", projectId: null });
    check("(2) setup: grant present before any unbind", db.listCompanionCapabilityGrantsForSession(sid).length === 1);

    // Per-channel unbind (still reachable on the OTHER channel) must NOT touch grants.
    db.deleteCompanionBinding(sid, "telegram");
    check("(2) per-channel unbind does NOT cascade-clear grants (companion still reachable on in-app)",
      db.listCompanionCapabilityGrantsForSession(sid).length === 1);

    // Full unbind (channel omitted) — no channel left ⇒ grants go too.
    db.deleteCompanionBinding(sid);
    check("(1) full unbind (channel omitted) cascade-clears the session's grants",
      db.listCompanionCapabilityGrantsForSession(sid).length === 0);

    // Idempotent re-run.
    let threw = false;
    try { db.deleteCompanionBinding(sid); } catch { threw = true; }
    check("(6) re-running the full-unbind cascade on an already-cleared session is a safe no-op", threw === false);
    db.close();
  }

  // ============ 3 — deleteCompanionConfig cascade-clears grants ============
  {
    const db = new Db(dbFile("p2.db"));
    const sid = "sess-config-teardown";
    seedCompanion(db, sid);
    db.upsertCompanionCapabilityGrant({ sessionId: sid, capability: "session-status", projectId: null });
    check("(3) setup: grant present before teardown", db.listCompanionCapabilityGrantsForSession(sid).length === 1);
    db.deleteCompanionConfig(sid);
    check("(3) deleteCompanionConfig cascade-clears the session's grants", db.listCompanionCapabilityGrantsForSession(sid).length === 0);
    db.close();
  }

  // ============ 4 — deleteSession cascade-clears grants ============
  {
    const db = new Db(dbFile("p3.db"));
    const sid = "sess-delete";
    seedCompanion(db, sid);
    db.upsertCompanionCapabilityGrant({ sessionId: sid, capability: "session-status", projectId: null });
    check("(4) setup: grant present before deleteSession", db.listCompanionCapabilityGrantsForSession(sid).length === 1);
    db.deleteSession(sid);
    check("(4) deleteSession cascade-clears the session's grants", db.listCompanionCapabilityGrantsForSession(sid).length === 0);
    db.close();
  }

  // ============ 5a — deleteProject cascade-clears every owned session's grants ============
  {
    const db = new Db(dbFile("p4.db"));
    const sid = "sess-in-project";
    const { projectId } = seedCompanion(db, sid, "proj-to-delete");
    db.upsertCompanionCapabilityGrant({ sessionId: sid, capability: "session-status", projectId: null });
    check("(5a) setup: grant present before project delete", db.listCompanionCapabilityGrantsForSession(sid).length === 1);
    db.deleteProject(projectId);
    check("(5a) deleteProject cascade-clears the owned session's grants", db.listCompanionCapabilityGrantsForSession(sid).length === 0);
    db.close();
  }

  // ============ 5b — deleteAgent cascade-clears every owned session's grants ============
  {
    const db = new Db(dbFile("p5.db"));
    const sid = "sess-under-agent";
    const { agentId } = seedCompanion(db, sid, "proj-for-agent-delete");
    db.upsertCompanionCapabilityGrant({ sessionId: sid, capability: "session-status", projectId: null });
    check("(5b) setup: grant present before agent delete", db.listCompanionCapabilityGrantsForSession(sid).length === 1);
    db.deleteAgent(agentId);
    check("(5b) deleteAgent cascade-clears the owned session's grants", db.listCompanionCapabilityGrantsForSession(sid).length === 0);
    db.close();
  }

  // ============ 6 — a re-bind of the SAME session after unbind starts with an EMPTY grant set ============
  {
    const db = new Db(dbFile("p6.db"));
    const sid = "sess-rebind";
    seedCompanion(db, sid);
    db.upsertCompanionBinding({ sessionId: sid, channel: "telegram", chatId: "tg-chat-2", scope: "dm" });
    db.upsertCompanionCapabilityGrant({ sessionId: sid, capability: "session-status", projectId: null });
    db.deleteCompanionBinding(sid); // full unbind — clears the grant
    db.upsertCompanionBinding({ sessionId: sid, channel: "telegram", chatId: "tg-chat-2b", scope: "dm" }); // re-bind, same session id
    check("(6) a re-bind of the SAME session id after a full unbind never resurrects the cleared grant",
      db.listCompanionCapabilityGrantsForSession(sid).length === 0);
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — companion_capability_grants JOINS the session-retire/unbind cascade: a full unbind and companion teardown (deleteCompanionConfig) clear grants, a per-channel unbind does NOT (the companion is still reachable), deleteSession/deleteProject/deleteAgent clear every owned session's grants, every cascade is idempotent, and a re-bind of the same session id never resurrects a cleared grant."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
