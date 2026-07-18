import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// C3 of the WS delta-push umbrella (1efde4ba) — the Db session change-feed (Db.sessionChangeListener →
// FleetHub.markSessionDirty → a coalesced session:upsert/session:remove broadcast on /ws/fleet).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via @fastify/websocket's injectWS, like
// ws-fleet.mjs's own C2 coverage) — the loopback path needs no gateway token.
//
// Proves:
//   1. With NO fleet socket connected, mutating a session does ZERO point-reads (markSessionDirty's
//      early-out) — spied via a wrapped Db.getSessionListItemById.
//   2. Once a fleet socket is connected, a committed sessions-table mutation (e.g. setBusy) emits exactly
//      ONE session:upsert delta, shaped as SessionListItem & {pendingMerge} — enriched names present,
//      pendingMerge null when nothing is merging.
//   3. N rapid mutations of the SAME id within the debounce window coalesce into ONE delta reflecting the
//      LATEST committed state (not one delta per mutation).
//   4. pendingMerge is folded in via the SAME peek-shape (opId/state/startedAt/outcome) the REST
//      /api/sessions handler uses, when SessionService.peekPendingMerge returns a running op.
//   5. Archiving a session (row now excluded by getSessionListItemById's WHERE) emits session:remove.
//   6. A hard DELETE of a non-archived, still-live-in-the-fleet session (deleteSession — the Code Review
//      completeness gap fixed after the first pass: INSERT + every UPDATE were instrumented, but not the
//      3 hard-DELETE sites) also emits exactly one session:remove — not just the archive path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ws-fleet-sf-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45346"; // distinct from trust-tier.mjs(45342)/ws-fleet.mjs(45343)/ws-json-hardening.mjs(45345)
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { FleetHub } = await import("../dist/gateway/fleet-hub.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Same queued-inbox seam as ws-fleet.mjs: wired via injectWS's `onInit` hook so the FIRST message (the
// server's own `hello`, sent synchronously on open) is never missed by a listener attached too late.
function makeInbox() {
  const queue = [];
  let waiter = null;
  const onInit = (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (waiter) { const resolve = waiter; waiter = null; resolve(msg); } else queue.push(msg);
    });
  };
  const next = (ms = 500) => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiter = null; resolve(null); }, ms);
      waiter = (msg) => { clearTimeout(timer); resolve(msg); };
    });
  };
  return { onInit, next };
}

const db = new Db(path.join(TMP, "loom.db"));
const now = new Date().toISOString();
db.insertProject({ id: "p1", name: "Proj", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "a1", projectId: "p1", name: "Agent", startupPrompt: "x", position: 0, profileId: null });

// A minimal SessionService stand-in — FleetHub's coalescer only ever calls peekPendingMerge on it, so a
// full SessionService (pty/worktrees/etc.) would be pure unused ceremony here. Mutable so test (4) can
// arm a pending op without any real PendingOpRegistry machinery.
const pendingMergeById = new Map();
const sessions = { peekPendingMerge: (id) => pendingMergeById.get(id) };

const fleetHub = new FleetHub();
const app = await buildServer({
  db, pty: {}, sessions, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
  fleetHub,
});

try {
  await app.ready();

  // --- (1) no fleet socket connected: markSessionDirty is a pure no-op (zero point-reads) -------------
  let pointReads = 0;
  const originalGet = db.getSessionListItemById.bind(db);
  db.getSessionListItemById = (id) => { pointReads++; return originalGet(id); };
  db.insertSession({
    id: "S1", projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: TMP,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: null,
  });
  db.setBusy("S1", true);
  db.setBusy("S1", false);
  await new Promise((r) => setTimeout(r, 300)); // past the debounce window, if one had (wrongly) armed
  check("(1) no socket connected: session mutations trigger zero point-reads", pointReads === 0);

  // --- connect a fleet socket ----------------------------------------------------------------------
  const inbox = makeInbox();
  const ws = await app.injectWS("/ws/fleet", { headers: { host: "127.0.0.1" } }, { onInit: inbox.onInit });
  const hello = await inbox.next();
  check("connecting sends {t:'hello',v:1}", hello?.t === "hello" && hello.v === 1);

  // --- (2) a committed mutation emits exactly ONE session:upsert, correctly shaped -------------------
  db.setBusy("S1", true);
  const upsert1 = await inbox.next();
  check("(2) a busy UPDATE emits a session:upsert delta", upsert1?.t === "session:upsert" && upsert1.session?.id === "S1");
  check("(2) delta reflects the committed state (busy:true)", upsert1?.session?.busy === true);
  check("(2) delta is enriched like listAllSessions (projectName/agentName)",
    upsert1?.session?.projectName === "Proj" && upsert1?.session?.agentName === "Agent");
  check("(2) delta shape carries pendingMerge, null when nothing is merging",
    "pendingMerge" in (upsert1?.session ?? {}) && upsert1.session.pendingMerge === null);
  check("(1b) the point-read happened exactly once for this one delta", pointReads === 1);

  // --- (3) N rapid mutations of the SAME id coalesce into ONE delta reflecting the LATEST state -------
  db.setBusy("S1", false);
  db.setLastError("S1", "boom");
  db.setContextCounters("S1", { ctxInputTokens: 10, ctxTurns: 1 });
  const upsert2 = await inbox.next();
  check("(3) coalesced delta reflects the LATEST mutation's committed state",
    upsert2?.t === "session:upsert" && upsert2.session?.busy === false
      && upsert2.session?.lastError === "boom" && upsert2.session?.ctxInputTokens === 10);
  const noSecondDelta = await inbox.next(300);
  check("(3) three rapid mutations produced exactly ONE delta (no trailing second one)", noSecondDelta === null);

  // --- (4) pendingMerge is folded in via the SAME opId/state/startedAt/outcome shape as REST ----------
  pendingMergeById.set("S1", { opId: "op-1", kind: "merge", key: "merge:S1", managerSessionId: "M", startedAt: now, state: "running" });
  db.setBusy("S1", true);
  const upsert3 = await inbox.next();
  check("(4) pendingMerge is folded into the upsert when a merge op is running",
    upsert3?.session?.pendingMerge?.opId === "op-1"
      && upsert3.session.pendingMerge.state === "running"
      && upsert3.session.pendingMerge.startedAt === now);
  pendingMergeById.delete("S1");

  // --- (5) archiving emits session:remove (row now excluded from getSessionListItemById) --------------
  db.archiveSession("S1");
  const removed = await inbox.next();
  check("(5) archiving a session emits session:remove", removed?.t === "session:remove" && removed.id === "S1");

  // --- (6) a hard DELETE of a non-archived session emits session:remove too — the completeness gap ------
  // (deleteSession/deleteProject/deleteAgent's cascades are the only 3 hard-DELETE-sessions sites; a
  // non-archived NON-live row is reachable there, e.g. DELETE /api/projects/:id/permanent only guards on
  // live-count, not archived state). S2 is inserted live/non-archived so getSessionListItemById would
  // otherwise still resolve it — proving the delta comes from the DELETE instrumentation, not a stale
  // archived_at.
  db.insertSession({
    id: "S2", projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: TMP,
    processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: null,
  });
  const upsertS2 = await inbox.next();
  check("(6) inserting S2 emits its own upsert first (sanity: it was live/visible before delete)",
    upsertS2?.t === "session:upsert" && upsertS2.session?.id === "S2");
  db.deleteSession("S2");
  const removedS2 = await inbox.next();
  check("(6) hard-deleting a non-archived session emits session:remove", removedS2?.t === "session:remove" && removedS2.id === "S2");

  ws.terminate();
} finally {
  await app.close();
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Db session change-feed is inert with no fleet socket connected; a connected socket receives exactly one coalesced session:upsert (correctly shaped, pendingMerge folded in) per debounce window regardless of how many mutations landed in it; archiving AND hard-deleting a session both emit session:remove."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
