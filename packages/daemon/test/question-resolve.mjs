import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// question_resolve (card feat(mcp): let an owner chat reply resolve a pending Request as answered, origin
// finding 308259e5) — closes the file-then-cancel gap: when the owner answers a pending question_ask
// CONVERSATIONALLY in the manager/Lead's own chat, this marks it 'answered' with the owner's own words
// captured as the note, instead of forcing question_ask-then-question_cancel (which loses the owner's
// reasoning to chat scrollback and lands a moot 'cancelled' row instead of an 'answered' one).
//
// THE LOAD-BEARING ANTI-FABRICATION INVARIANT under test: `note` is ALWAYS the server-captured
// `ownerText` of an owner-authored turn — the CURRENT one (PtyHost.getActiveTurnOwnerText), or (card
// fix(mcp): let question_resolve accept mid-turn-tool composer answers, origin finding ca341979) the
// single most-recent one (PtyHost.getRecentOwnerTurns[0]) when the current turn isn't owner-formed — the
// agent supplies only `questionId` (+ `chosenOption` where the question offers one). There is no
// free-text note param the agent can populate.
//
// HERMETIC + CLAUDE-FREE.
//   PART 1 — a lightweight fake `pty` (getActiveTurnOwnerText + an independently-settable
//     getRecentOwnerTurns ring) drives the MCP tool handlers directly (OrchestrationMcpRouter /
//     PlatformMcpRouter), covering:
//   (A) resolve-with-owner-text on a free-text (no-options) decision — lands 'answered' with the
//       verbatim ownerText as note, chosenOption null; identical terminal shape to a REST answer
//       (db.answerQuestion — same write, same fields) so question_pull/history behave the same.
//   (B) refuse when NEITHER the current turn NOR any recent turn is owner-formed.
//   (B2) CROSS-TURN fallback — current turn not owner-formed, but a recent one was: resolves via
//       getRecentOwnerTurns[0] (the LATEST recent turn, not an older one).
//   (B3) the current turn's ownerText is preferred over the recent-turns fallback when both exist.
//   (C) refuse type:"credential" outright.
//   (D) chosenOption validated against a decision's offered `options` (wrong option rejected; a
//       question with NO options rejects a supplied chosenOption too — omit it, the note carries it).
//   (E) type:"permission" — chosenOption REQUIRED, must be one of PERMISSION_ANSWERS.
//   (F) lineage-ownership — can't resolve another agent's question (mirrors question_cancel).
//   (G) role-scoping — a WORKER session's MCP surface never registers question_resolve at all.
//   (H) the Lead (platform) surface shares the identical behavior.
//   (I) side-effect check (manager's guardrail #4) — populating ownerText for a non-Companion session
//       does NOT newly expose the Companion's decision_resolve (or any other capability) to that session;
//       decision_resolve stays absent from the manager's registered tools regardless.
//
//   PART 2 — a REAL PtyHost over a FAKE pty (createPty seam, no real claude) drives the ACTUAL
//     POST /api/sessions/:id/input REST route end-to-end, proving plan A: the composer route now threads
//     the literal human text through as `ownerText`, so a manager's own live chat reply is captured by
//     PtyHost.getActiveTurnOwnerText/getRecentOwnerTurns (previously populated ONLY for Companion
//     inbound) — and question_resolve, built against that SAME real host, resolves the pending question
//     with that exact composer text as the note.
//   (Part 2b) the REAL cross-turn case: a genuine Stop hook ends the owner-formed turn (clearing
//     getActiveTurnOwnerText), then a LATER question_resolve call still resolves via the real
//     getRecentOwnerTurns ring, which Stop never clears — the actual gap the card fixes.
//
// Run: 1) build (turbo builds shared first), 2) node test/question-resolve.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-question-resolve-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");

const dbFile = path.join(tmpHome, "qr.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const call = async (server, name, args) => JSON.parse((await server._registeredTools[name].handler(args ?? {})).content[0].text);

try {
  // --- fixtures: two projects/agents (A, A2 — no shared lineage), a worker under agent A, and the
  // reserved Platform home for the Lead surface. ---
  db.insertProject({ id: "pA", name: "Project A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentA", projectId: "pA", name: "Mgr A", startupPrompt: "MGR", position: 0 });
  db.insertAgent({ id: "agentA2", projectId: "pA", name: "Mgr A2", startupPrompt: "MGR", position: 1 });
  db.insertSession({ id: "mgrA", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: "pA", processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: "mgrA2", projectId: "pA", agentId: "agentA2", engineSessionId: null, title: null, cwd: "pA", processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: "workerA", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: "pA", processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: "mgrA" });
  db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: "pHome", vaultPath: "pHome", config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0 });
  db.insertSession({ id: "PL", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: "pHome", processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform" });

  const insertQ = (id, over) => {
    db.insertQuestion({
      id, sessionId: over.sessionId, projectId: over.projectId, type: over.type ?? "decision",
      title: over.title ?? `Q ${id}`, body: over.body ?? "b", options: over.options ?? null,
      recommendation: over.recommendation ?? null, taskId: over.taskId ?? null,
      permissionAction: over.permissionAction ?? null, permissionScope: over.permissionScope ?? null,
      permissionExpiresAt: over.permissionExpiresAt ?? null, credentialEnvVar: over.credentialEnvVar ?? null,
      provisionTarget: null, provisionConnectionId: null, provisionBindingState: "none",
      state: over.state ?? "pending", chosenOption: over.chosenOption ?? null, note: over.note ?? null,
      createdAt: over.createdAt ?? now, answeredAt: over.answeredAt ?? null, consumedAt: over.consumedAt ?? null,
      cancelledReason: null, cancelledBy: null, cancelledAt: null,
    });
    return id;
  };

  // ============ PART 1 — fake pty, MCP tool handlers ============
  const fakePty = {
    ownerText: new Map(),
    // Separate, independently-settable recent-turns ring (card fix(mcp): let question_resolve accept
    // mid-turn-tool composer answers) — defaults to mirroring `ownerText` (byte-identical to the old
    // fake) unless a test explicitly overrides it via `recentTurns.set(sid, [...])`, so a case can
    // simulate "current turn is NOT owner-formed, but a recent one was" independently of the current-turn
    // map.
    recentTurns: new Map(),
    getActiveTurnOwnerText(sid) { return this.ownerText.has(sid) ? this.ownerText.get(sid) : null; },
    getRecentOwnerTurns(sid) {
      if (this.recentTurns.has(sid)) return this.recentTurns.get(sid);
      const t = this.ownerText.get(sid); return t ? [t] : [];
    },
    isAlive: () => true,
    enqueueStdin: () => ({ delivered: true }),
    getActiveTurnOrigin: () => null,
    purgeQueuedByQuestionIds: () => [],
  };
  const sessions = new SessionService(db, fakePty, new OrchestrationControl());
  const router = new OrchestrationMcpRouter(db, sessions, {}, fakePty);
  const mgrServer = router.buildServer("mgrA", "manager");
  check("question_resolve is registered on the manager surface", "question_resolve" in mgrServer._registeredTools);

  // ============ (A) resolve-with-owner-text — free-text (no options) decision ============
  insertQ("a1", { sessionId: "mgrA", projectId: "pA", title: "Ship timing?" });
  fakePty.ownerText.set("mgrA", "Yeah go ahead and ship it tomorrow morning, that works.");
  const resolvedA = await call(mgrServer, "question_resolve", { questionId: "a1" });
  check("(A) resolves with resolved:true", resolvedA.resolved === true && resolvedA.questionId === "a1");
  check("(A) chosenOption is null (no options offered)", resolvedA.chosenOption === null);
  check("(A) note is the VERBATIM server-captured owner text", resolvedA.note === "Yeah go ahead and ship it tomorrow morning, that works.");
  const a1Row = db.getQuestion("a1");
  check("(A) the row is 'answered' — identical terminal shape to a REST answer (same db.answerQuestion write)", a1Row.state === "answered" && typeof a1Row.answeredAt === "string" && a1Row.note === resolvedA.note && a1Row.chosenOption === null);

  // question_pull picks it up exactly like any other answered question.
  const pulledA = await call(mgrServer, "question_pull", {});
  check("(A) question_pull returns it like any other answered question", pulledA.questions.some((q) => q.questionId === "a1" && q.note === "Yeah go ahead and ship it tomorrow morning, that works."));
  check("(A) pulling consumed it", db.getQuestion("a1").state === "consumed");

  // ============ (B) refuse when there is no owner reply at all (current OR recent) ============
  insertQ("b1", { sessionId: "mgrA", projectId: "pA", title: "No owner text yet" });
  fakePty.ownerText.delete("mgrA"); // simulate: no owner-authored turn in flight, and (default mirroring) no recent one either
  const refusedB = await call(mgrServer, "question_resolve", { questionId: "b1" });
  check("(B) refused — no owner reply yet this session", typeof refusedB.error === "string" && refusedB.error.includes("no owner reply yet this session"));
  check("(B) the row is untouched (still pending)", db.getQuestion("b1").state === "pending");

  // ============ (B2) CROSS-TURN fallback — current turn not owner-formed, but a RECENT one was ============
  // (card fix(mcp): let question_resolve accept mid-turn-tool composer answers, origin finding ca341979,
  // axis a) — the asker ended its own turn (e.g. after spawning workers) and only calls question_resolve
  // on a LATER, non-owner-formed turn. getActiveTurnOwnerText is null, but getRecentOwnerTurns still
  // carries the owner's most recent reply — question_resolve must fall back to it rather than refuse.
  insertQ("b2", { sessionId: "mgrA", projectId: "pA", title: "Cross-turn resolve" });
  fakePty.ownerText.delete("mgrA"); // current turn is NOT owner-formed (e.g. a worker-report-triggered turn)
  fakePty.recentTurns.set("mgrA", ["Go with option two, thanks", "an even older owner turn"]);
  const resolvedB2 = await call(mgrServer, "question_resolve", { questionId: "b2" });
  check("(B2) resolves via the RECENT-turn fallback when the current turn isn't owner-formed", resolvedB2.resolved === true && resolvedB2.note === "Go with option two, thanks");
  check("(B2) uses index [0] only (the LATEST recent turn), not an older one", resolvedB2.note !== "an even older owner turn");
  fakePty.recentTurns.delete("mgrA"); // reset back to default mirroring for later cases

  // ============ (B3) current-turn ownerText WINS over a stale recent-turns entry ============
  insertQ("b3", { sessionId: "mgrA", projectId: "pA", title: "Current beats recent" });
  fakePty.ownerText.set("mgrA", "the CURRENT reply");
  fakePty.recentTurns.set("mgrA", ["a STALE older reply", "the CURRENT reply"]);
  const resolvedB3 = await call(mgrServer, "question_resolve", { questionId: "b3" });
  check("(B3) the CURRENT turn's ownerText is preferred over the recent-turns fallback", resolvedB3.resolved === true && resolvedB3.note === "the CURRENT reply");
  fakePty.ownerText.delete("mgrA");
  fakePty.recentTurns.delete("mgrA");

  // ============ (C) refuse type:"credential" outright ============
  insertQ("c1", { sessionId: "mgrA", projectId: "pA", title: "A secret", type: "credential", credentialEnvVar: "X" });
  fakePty.ownerText.set("mgrA", "here's the key: sk-abc123");
  const refusedC = await call(mgrServer, "question_resolve", { questionId: "c1" });
  check("(C) refused — credential must go through the secure REST flow", typeof refusedC.error === "string" && refusedC.error.toLowerCase().includes("credential"));
  check("(C) the row is untouched (still pending) — the 'secret' text in ownerText was NEVER written anywhere", db.getQuestion("c1").state === "pending" && db.getQuestion("c1").note === null);

  // ============ (D) chosenOption validated against offered options ============
  insertQ("d1", { sessionId: "mgrA", projectId: "pA", title: "Pick one", options: ["red", "blue"] });
  fakePty.ownerText.set("mgrA", "let's go with blue");
  const badOption = await call(mgrServer, "question_resolve", { questionId: "d1", chosenOption: "green" });
  check("(D) an option NOT offered is rejected", typeof badOption.error === "string" && badOption.error.includes("red, blue"));
  check("(D) the row is untouched", db.getQuestion("d1").state === "pending");
  const goodOption = await call(mgrServer, "question_resolve", { questionId: "d1", chosenOption: "blue" });
  check("(D) an offered option resolves with that chosenOption + the verbatim note", goodOption.resolved === true && goodOption.chosenOption === "blue" && goodOption.note === "let's go with blue");

  insertQ("d2", { sessionId: "mgrA", projectId: "pA", title: "No options here" });
  fakePty.ownerText.set("mgrA", "just do it");
  const spuriousOption = await call(mgrServer, "question_resolve", { questionId: "d2", chosenOption: "anything" });
  check("(D) supplying chosenOption on a no-options question is rejected", typeof spuriousOption.error === "string" && spuriousOption.error.includes("no offered options"));
  check("(D) omitting chosenOption on the same no-options question resolves fine", (await call(mgrServer, "question_resolve", { questionId: "d2" })).resolved === true);

  // ============ (E) type:"permission" — chosenOption required, from PERMISSION_ANSWERS ============
  insertQ("e1", { sessionId: "mgrA", projectId: "pA", title: "Deploy to prod?", type: "permission", permissionAction: "deploy" });
  fakePty.ownerText.set("mgrA", "yes, authorized, go ahead");
  const missingPerm = await call(mgrServer, "question_resolve", { questionId: "e1" });
  check("(E) missing chosenOption on a permission request is rejected", typeof missingPerm.error === "string" && missingPerm.error.includes("permission"));
  const badPerm = await call(mgrServer, "question_resolve", { questionId: "e1", chosenOption: "sure" });
  check("(E) an invalid chosenOption on a permission request is rejected", typeof badPerm.error === "string" && badPerm.error.includes("authorize, deny"));
  const goodPerm = await call(mgrServer, "question_resolve", { questionId: "e1", chosenOption: "authorize" });
  check("(E) 'authorize' resolves the permission request", goodPerm.resolved === true && goodPerm.chosenOption === "authorize" && goodPerm.note === "yes, authorized, go ahead");

  // ============ (F) lineage-ownership — can't resolve another agent's question ============
  insertQ("f1", { sessionId: "mgrA2", projectId: "pA", title: "Not mgrA's" });
  fakePty.ownerText.set("mgrA", "I'll answer this one too");
  const foreign = await call(mgrServer, "question_resolve", { questionId: "f1" });
  check("(F) resolving ANOTHER agent's pending ask is REJECTED", typeof foreign.error === "string" && foreign.error.includes("own agent lineage"));
  check("(F) the foreign row is untouched (still pending)", db.getQuestion("f1").state === "pending");

  // ============ (G) role-scoping — a worker never gets question_resolve at all ============
  const workerServer = router.buildServer("workerA", "worker");
  check("(G) question_resolve is NOT registered on the worker surface", !("question_resolve" in workerServer._registeredTools));
  check("(G) question_ask is NOT registered on the worker surface either (same scoping)", !("question_ask" in workerServer._registeredTools));

  // ============ (H) the Lead (platform) surface shares the identical behavior ============
  const platform = new PlatformMcpRouter(db, sessions, undefined, fakePty);
  const leadServer = platform.buildServer("PL");
  check("(H) question_resolve is registered on the platform (Lead) surface", "question_resolve" in leadServer._registeredTools);
  insertQ("h1", { sessionId: "PL", projectId: "pHome", title: "Lead's own pending ask" });
  fakePty.ownerText.set("PL", "approved, thanks");
  const leadResolve = await call(leadServer, "question_resolve", { questionId: "h1" });
  check("(H) the Lead can resolve its own pending ask with the verbatim owner text", leadResolve.resolved === true && leadResolve.note === "approved, thanks");
  // Ownership still applies on the Lead surface too.
  insertQ("h2", { sessionId: "mgrA", projectId: "pA", title: "Not the Lead's" });
  const leadForeign = await call(leadServer, "question_resolve", { questionId: "h2" });
  check("(H) the Lead cannot resolve a manager's pending ask (ownership still scoped by agent lineage)", typeof leadForeign.error === "string");

  // ============ (I) side-effect check — populating ownerText does NOT expose Companion capabilities ============
  check("(I) decision_resolve (Companion-only) is NOT registered on the manager surface, ownerText notwithstanding", !("decision_resolve" in mgrServer._registeredTools));
  check("(I) board_create (Companion-only) is NOT registered on the manager surface either", !("board_create" in mgrServer._registeredTools));

  // ============ PART 2 — REAL PtyHost + the ACTUAL POST /api/sessions/:id/input route ============
  db.insertSession({ id: "mgrLive", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: tmpHome, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  insertQ("p1", { sessionId: "mgrLive", projectId: "pA", title: "Live composer reply" });

  function makeFakePty() {
    return { pid: 4242, write: () => {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill: () => {}, resize: () => {} };
  }
  class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
  const realHost = new TestPtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
  realHost.spawn({ sessionId: "mgrLive", cwd: tmpHome, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 }, geometry: { cols: 120, rows: 40 }, sessionEnv: {} });
  realHost.deliverHook("mgrLive", { hook_event_name: "SessionStart" }); // mark ready — session is IDLE, no primer

  check("(Part 2 pre) getActiveTurnOwnerText starts null (no turn formed yet)", realHost.getActiveTurnOwnerText("mgrLive") === null);

  const stub = {};
  const app = await buildServer({ db, pty: realHost, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  try {
    const composerText = "Go ahead and use the blue theme, thanks for asking!";
    const inputRes = await app.inject({ method: "POST", url: "/api/sessions/mgrLive/input", payload: { text: composerText } });
    check("(Part 2) POST /input delivers immediately (session was idle)", inputRes.statusCode === 200 && inputRes.json().delivered === true);
    check("(Part 2) getActiveTurnOwnerText is now populated with the LITERAL composer text (plan A)", realHost.getActiveTurnOwnerText("mgrLive") === composerText);
    check("(Part 2) getRecentOwnerTurns also carries it", realHost.getRecentOwnerTurns("mgrLive").includes(composerText));

    // Build a REAL OrchestrationMcpRouter against this SAME real host and resolve the pending question —
    // proving the end-to-end wire: composer route -> PtyHost.activeTurnOwnerText -> question_resolve.
    const liveSessions = new SessionService(db, realHost, new OrchestrationControl());
    const liveRouter = new OrchestrationMcpRouter(db, liveSessions, {}, realHost);
    const liveServer = liveRouter.buildServer("mgrLive", "manager");
    const liveResolve = await call(liveServer, "question_resolve", { questionId: "p1" });
    check("(Part 2) question_resolve resolves using the REAL composer text end-to-end", liveResolve.resolved === true && liveResolve.note === composerText);
    check("(Part 2) the row is 'answered' with that exact note", db.getQuestion("p1").state === "answered" && db.getQuestion("p1").note === composerText);

    // ============ (Part 2b) REAL cross-turn fallback — a genuine Stop hook ends the owner-formed turn,
    // then question_resolve is called on a LATER turn (card fix(mcp): let question_resolve accept
    // mid-turn-tool composer answers, origin finding ca341979, axis a). This is the actual real-world gap
    // the card fixes: the asker's engagement with the owner's reply spans MORE than one daemon turn (it
    // ends its own turn — e.g. after spawning workers — before getting to question_resolve). ============
    insertQ("p2", { sessionId: "mgrLive", projectId: "pA", title: "Resolved on a later, non-owner-formed turn" });
    realHost.deliverHook("mgrLive", { hook_event_name: "Stop" }); // ends the turn that carried composerText
    check("(Part 2b) a real Stop clears the CURRENT-turn attestation", realHost.getActiveTurnOwnerText("mgrLive") === null);
    check("(Part 2b) but getRecentOwnerTurns still carries it — never cleared at Stop", realHost.getRecentOwnerTurns("mgrLive").includes(composerText));
    const crossTurnResolve = await call(liveServer, "question_resolve", { questionId: "p2" });
    check("(Part 2b) question_resolve resolves via the recent-turn fallback on a turn the owner never formed", crossTurnResolve.resolved === true && crossTurnResolve.note === composerText);
    check("(Part 2b) the row is 'answered' with the recent (not current) owner text as its note", db.getQuestion("p2").state === "answered" && db.getQuestion("p2").note === composerText);
  } finally {
    await app.close();
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — question_resolve (manager + Lead surfaces) marks a pending Request 'answered' using ONLY the server-captured verbatim owner text (never agent-authored, current-turn or the single most-recent turn as a cross-turn fallback), refuses cleanly with no owner turn at all / a credential type / an unoffered chosenOption / a foreign agent's question, is absent from the worker surface entirely, and — end-to-end via a REAL PtyHost, including a genuine Stop hook ending the owner-formed turn — the cross-turn fallback resolves a question on a LATER, non-owner-formed turn without exposing any Companion-only capability to a non-Companion session."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
