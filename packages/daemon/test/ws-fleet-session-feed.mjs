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
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { observeOnce, assertNeverWithControl } from "./_timing-guard.mjs";

const TMP = mkdtempManaged("loom-ws-fleet-sf-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45346"; // distinct from trust-tier.mjs(45342)/ws-fleet.mjs(45343)/ws-json-hardening.mjs(45345)
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { FleetHub, DIRTY_FLUSH_MS } = await import("../dist/gateway/fleet-hub.js");

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

// A minimal SessionService stand-in — FleetHub's coalescer only ever calls peekPendingMerge and (while a
// merge op is running) gatePhaseForOpId on it, so a full SessionService (pty/worktrees/etc.) would be pure
// unused ceremony here. Mutable so test (4) can arm a pending op without any real PendingOpRegistry
// machinery.
const pendingMergeById = new Map();
const gatePhaseByOpId = new Map();
const sessions = {
  peekPendingMerge: (id) => pendingMergeById.get(id),
  gatePhaseForOpId: (opId) => gatePhaseByOpId.get(opId) ?? null,
};

const fleetHub = new FleetHub();
const app = await buildServer({
  db, pty: {}, sessions, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
  fleetHub,
});

try {
  await app.ready();

  // --- (1) no fleet socket connected: markSessionDirty is a pure no-op (zero point-reads) -------------
  // Tracked PER SESSION ID (not a bare shared counter): the positive control below deliberately arms a
  // real violation on a DIFFERENT id ("CONTROL") concurrently with the real ("S1") scenario it's proving
  // alongside — a shared counter would let either phase's reads bleed into the other depending on exact
  // timing; per-id tracking makes that impossible by construction, no reset/ordering care needed.
  const pointReadCounts = new Map();
  const originalGet = db.getSessionListItemById.bind(db);
  db.getSessionListItemById = (id) => { pointReadCounts.set(id, (pointReadCounts.get(id) ?? 0) + 1); return originalGet(id); };
  db.insertSession({
    id: "S1", projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: TMP,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker", parentSessionId: null,
  });
  db.setBusy("S1", true);
  db.setBusy("S1", false);
  const noPointReadsWithoutSocket = await assertNeverWithControl({
    label: "(1) no socket connected: session mutations trigger zero point-reads",
    check: () => (pointReadCounts.get("S1") ?? 0) > 0,
    windowMs: DIRTY_FLUSH_MS + 100, // derived from FleetHub's own debounce constant, not a guessed value
    positiveControl: async () => {
      // Prove the SAME check+window CAN observe a violation: a throwaway hub WITH a socket connected,
      // marking a DIFFERENT session ("CONTROL") dirty, DOES trigger a point-read within this window.
      // Fully isolated from the real fleetHub under test below — its own hub instance, never touches
      // fleetHub's sockets/dirty state, and its reads land under a DIFFERENT map key than "S1"'s.
      const controlHub = new FleetHub();
      controlHub.attach(db, sessions);
      controlHub.add({}); // fake socket stand-in: readyState never === OPEN, so broadcast() safely no-ops send
      db.insertSession({
        id: "CONTROL", projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: TMP,
        processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
        lastError: null, role: "worker", parentSessionId: null,
      });
      controlHub.markSessionDirty("CONTROL");
      return observeOnce({ check: () => (pointReadCounts.get("CONTROL") ?? 0) > 0, windowMs: DIRTY_FLUSH_MS + 100 });
    },
  });
  check("(1) no socket connected: session mutations trigger zero point-reads", noPointReadsWithoutSocket);

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
  check("(1b) the point-read happened exactly once for this one delta", pointReadCounts.get("S1") === 1);

  // --- (3) N rapid mutations of the SAME id coalesce into ONE delta reflecting the LATEST state -------
  db.setBusy("S1", false);
  db.setLastError("S1", "boom");
  db.setContextCounters("S1", { ctxInputTokens: 10, ctxTurns: 1 });
  const upsert2 = await inbox.next();
  check("(3) coalesced delta reflects the LATEST mutation's committed state",
    upsert2?.t === "session:upsert" && upsert2.session?.busy === false
      && upsert2.session?.lastError === "boom" && upsert2.session?.ctxInputTokens === 10);
  // Card c976f009 (Part 2, resolved (b), fixed): was a bare `inbox.next(300)` — a magic number, not tied
  // to FleetHub's own debounce constant the way (1)'s windowMs above already is. Checked the real value:
  // gateway/fleet-hub.ts's DIRTY_FLUSH_MS is 200ms, so 300 was only a ~1.5x margin for a NEGATIVE
  // assertion (no second delta). Matches this file's own established `DIRTY_FLUSH_MS + 100` convention.
  const noSecondDelta = await inbox.next(DIRTY_FLUSH_MS + 100);
  check("(3) three rapid mutations produced exactly ONE delta (no trailing second one)", noSecondDelta === null);

  // --- (4) pendingMerge is folded in via the SAME opId/state/startedAt/outcome shape as REST ----------
  // gatePhase (card 53ad9ed3) is folded in too, via the SAME gatePhaseForOpId reuse the REST /api/sessions
  // handler uses — proves this WS path can't drift from the REST projection it mirrors.
  pendingMergeById.set("S1", { opId: "op-1", kind: "merge", key: "merge:S1", managerSessionId: "M", startedAt: now, state: "running" });
  gatePhaseByOpId.set("op-1", "queued");
  db.setBusy("S1", true);
  const upsert3 = await inbox.next();
  check("(4) pendingMerge is folded into the upsert when a merge op is running",
    upsert3?.session?.pendingMerge?.opId === "op-1"
      && upsert3.session.pendingMerge.state === "running"
      && upsert3.session.pendingMerge.startedAt === now);
  check("(4) gatePhase is folded in too, reusing the SAME live lookup the REST path uses",
    upsert3?.session?.pendingMerge?.gatePhase === "queued");
  pendingMergeById.delete("S1");
  gatePhaseByOpId.delete("op-1");

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
  // TMP's own trailing cleanup loop removed here: mkdtempManaged already registered it for guaranteed
  // cleanup at process exit (card 995be21f).
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Db session change-feed is inert with no fleet socket connected; a connected socket receives exactly one coalesced session:upsert (correctly shaped, pendingMerge folded in) per debounce window regardless of how many mutations landed in it; archiving AND hard-deleting a session both emit session:remove."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
