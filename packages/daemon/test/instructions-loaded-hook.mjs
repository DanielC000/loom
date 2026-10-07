import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1)
// Card 8c70e33c — wires the installed CLI's own `InstructionsLoaded` hook as a durable audit trail of
// which instruction file (CLAUDE.md/AGENTS.md/rule) a session actually loaded. Two layers, two parts:
//
// PART 1 (host.ts): `PtyHost.deliverHook`'s new `case "InstructionsLoaded"` — dispatches the hook,
// dedupes on (file_path, memory_type, load_reason) PER LIVE INCARNATION (`Live.instructionsLoadedKeys`),
// and invokes the new `PtyHostEvents.onInstructionsLoaded` callback. Exercised at the `createPty()` seam
// (fake pty, no real claude) via `_seam-host-fixture.mjs`, same technique as claude-boot-dialog-stuck.mjs.
//
// PART 2 (sessions/service.ts): `SessionService.handleInstructionsLoaded` — the DB-holding implementer
// that appends the durable `instructions_loaded` orchestration event with the MINIMAL approved payload.
// Exercised directly against a real in-memory `Db` + `SessionService`, same technique as
// claude-boot-dialog-stuck-no-self-nudge.mjs's (I)-(L) block.
//
// See docs/decisions/8c70e33c-instructions-loaded-audit-event.md for the full scope/payload/filing
// rationale this test is pinning.
//
// RED-BEFORE-GREEN: run against a worktree with ONLY this test file applied and the real source changes
// (claude-settings.ts/host.ts/index.ts/sessions/service.ts/shared/types.ts) reverted to their pre-card
// state — every PART 1 check fails (onInstructionsLoaded is never invoked; the hook falls through
// deliverHook's `default` no-op) and every PART 2 check throws (`sessions.handleInstructionsLoaded` does
// not exist yet). See this card's own worker_report for the exact revert/rebuild/retest/restore run.
//
// RUN: pnpm build (repo root) then `node test/instructions-loaded-hook.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-instr-loaded-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

try {
  // ===================================================================================================
  // PART 1 — PtyHost.deliverHook: dispatch + per-incarnation dedupe
  // ===================================================================================================
  {
    const loadedCalls = [];
    const events = {
      onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
      onInstructionsLoaded(sessionId, info) { loadedCalls.push({ sessionId, info }); },
    };
    class TestPtyHost extends createSeamHost(PtyHost) {}
    const host = new TestPtyHost(events);
    const spawnOne = (id, resumeId) => host.spawn({
      sessionId: id, cwd: tmpHome, resumeId,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker",
    });

    // --- 1: a fresh InstructionsLoaded hook fires onInstructionsLoaded exactly once, full payload mapped
    const A = `instr-A-${sfx}`;
    spawnOne(A);
    host.deliverHook(A, {
      hook_event_name: "InstructionsLoaded", session_id: "eng-A",
      file_path: "/repo/CLAUDE.md", memory_type: "Project", load_reason: "session_start",
      globs: ["**/*.md"], trigger_file_path: "/repo/src/x.ts", parent_file_path: "/repo/.claude/rules/x.md",
      agent_id: "agent-1", agent_type: "general-purpose",
    });
    check("1: a fresh InstructionsLoaded hook fires onInstructionsLoaded exactly once",
      loadedCalls.filter((c) => c.sessionId === A).length === 1);
    const info1 = loadedCalls.find((c) => c.sessionId === A)?.info;
    check("1: the payload maps every field (filePath/memoryType/loadReason/globs/triggerFilePath/parentFilePath/agentId/agentType)",
      info1?.filePath === "/repo/CLAUDE.md" && info1?.memoryType === "Project" && info1?.loadReason === "session_start"
        && Array.isArray(info1?.globs) && info1.globs[0] === "**/*.md"
        && info1?.triggerFilePath === "/repo/src/x.ts" && info1?.parentFilePath === "/repo/.claude/rules/x.md"
        && info1?.agentId === "agent-1" && info1?.agentType === "general-purpose");

    // --- 2: a SECOND, identical (file_path, memory_type, load_reason) hook is deduped — zero more calls
    host.deliverHook(A, {
      hook_event_name: "InstructionsLoaded", session_id: "eng-A",
      file_path: "/repo/CLAUDE.md", memory_type: "Project", load_reason: "session_start",
    });
    check("2: a re-load of the SAME (file_path, memory_type, load_reason) is deduped — still exactly one call",
      loadedCalls.filter((c) => c.sessionId === A).length === 1);

    // --- 3: a DIFFERENT load_reason for the SAME file/memory_type is NOT globally suppressed — fires again
    host.deliverHook(A, {
      hook_event_name: "InstructionsLoaded", session_id: "eng-A",
      file_path: "/repo/CLAUDE.md", memory_type: "Project", load_reason: "compact",
    });
    check("3: a different load_reason for the same file is a DISTINCT dedupe key — fires a second time",
      loadedCalls.filter((c) => c.sessionId === A).length === 2);

    // --- 4: a DIFFERENT file_path, same memory_type/load_reason — also a distinct key, fires again
    host.deliverHook(A, {
      hook_event_name: "InstructionsLoaded", session_id: "eng-A",
      file_path: "/repo/nested/CLAUDE.md", memory_type: "Project", load_reason: "session_start",
    });
    check("4: a different file_path is a DISTINCT dedupe key — fires a third time",
      loadedCalls.filter((c) => c.sessionId === A).length === 3);

    // --- 5: a fresh respawn (new Live incarnation) resets the dedupe for the SAME session id
    // Stop first (realistic shape — a resume always follows the prior process exiting) so this is a
    // genuinely FRESH Live, never an overwrite of a still-alive one.
    host.stop(A, "hard");
    spawnOne(A, "eng-A-prior"); // resume ⇒ brand-new Live, per the Live interface's own documented invariant
    host.deliverHook(A, {
      hook_event_name: "InstructionsLoaded", session_id: "eng-A-2",
      file_path: "/repo/CLAUDE.md", memory_type: "Project", load_reason: "session_start",
    });
    check("5: a fresh respawn (new Live) re-fires for a (file_path, memory_type, load_reason) already seen in the PRIOR incarnation",
      loadedCalls.filter((c) => c.sessionId === A).length === 4);

    // --- 6: negative control — a DIFFERENT hook_event_name never invokes onInstructionsLoaded
    const B = `instr-B-${sfx}`;
    spawnOne(B);
    host.deliverHook(B, { hook_event_name: "SessionStart", session_id: "eng-B" });
    host.deliverHook(B, { hook_event_name: "UserPromptSubmit", session_id: "eng-B" });
    check("6: negative control — SessionStart/UserPromptSubmit hooks never invoke onInstructionsLoaded",
      loadedCalls.filter((c) => c.sessionId === B).length === 0);

    // --- 7: optional fields omitted entirely still fire, with those fields undefined (never a crash)
    const C = `instr-C-${sfx}`;
    spawnOne(C);
    host.deliverHook(C, {
      hook_event_name: "InstructionsLoaded", session_id: "eng-C",
      file_path: "/repo/CLAUDE.md", memory_type: "User", load_reason: "nested_traversal",
    });
    const info7 = loadedCalls.find((c) => c.sessionId === C)?.info;
    check("7: optional fields (globs/triggerFilePath/parentFilePath/agentId/agentType) are all undefined when the hook omits them",
      info7?.globs === undefined && info7?.triggerFilePath === undefined && info7?.parentFilePath === undefined
        && info7?.agentId === undefined && info7?.agentType === undefined);
  }

  // ===================================================================================================
  // PART 1.5 — Code Review fix: a throwing DB-holding implementer must never propagate back into
  // deliverHook, and must never corrupt the Live state machine for a LATER, unrelated hook on the SAME
  // session. Wires a REAL SessionService (handleInstructionsLoaded is NOT a stub here) over a minimal
  // Db-shaped object whose appendEvent throws — the exact shape the manager's review named.
  // ===================================================================================================
  {
    class ThrowingDb {
      getSession() { return undefined; }
      appendEvent() { throw new Error("simulated DB failure (appendEvent)"); }
    }
    const throwingDb = new ThrowingDb();
    let sessionsT; // forward reference — same pattern as index.ts's real wiring
    const eventsT = {
      onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
      onInstructionsLoaded(sessionId, info) { sessionsT.handleInstructionsLoaded(sessionId, info); },
    };
    class TestPtyHostT extends createSeamHost(PtyHost) {}
    const hostT = new TestPtyHostT(eventsT);
    sessionsT = new SessionService(throwingDb, hostT, new OrchestrationControl());

    const D = `instr-throw-${sfx}`;
    hostT.spawn({
      sessionId: D, cwd: tmpHome,
      permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker",
    });

    let threw = false;
    try {
      hostT.deliverHook(D, {
        hook_event_name: "InstructionsLoaded", session_id: "eng-D",
        file_path: "/x/CLAUDE.md", memory_type: "Project", load_reason: "session_start",
      });
    } catch {
      threw = true;
    }
    check("8: deliverHook does NOT throw when the DB-holding implementer's appendEvent throws", !threw);

    // A LATER, unrelated hook for the SAME session is still processed normally — the swallowed throw
    // left no corrupted state behind (e.g. a stuck handler, a wedged Live) that would block it.
    hostT.deliverHook(D, { hook_event_name: "SessionStart", session_id: "eng-D-2" });
    check("8: a later SessionStart for the SAME session is still processed (sessionStartObserved flips true)",
      hostT.live.get(D).sessionStartObserved === true);
  }

  // ===================================================================================================
  // PART 2 — SessionService.handleInstructionsLoaded: the durable event write, minimal payload
  // ===================================================================================================
  {
    const db = new Db();
    const proj = `instr-proj-${sfx}`, agent = `instr-ag-${sfx}`;
    const now = new Date().toISOString();
    db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
    const mkSession = (o) => db.insertSession({
      id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
      worktreePath: null, branch: null,
    });
    const ptyStub = {};
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

    // --- 9: a worker with a manager parent + a task — full payload, correct filing identity
    const mgr = `instr-g-mgr-${sfx}`, wkr = `instr-g-wkr-${sfx}`, task = `instr-g-task-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr, taskId: task });
    sessions.handleInstructionsLoaded(wkr, {
      filePath: "/repo/CLAUDE.md", memoryType: "Project", loadReason: "session_start",
      globs: ["**/*.md"], triggerFilePath: "/repo/src/x.ts", parentFilePath: "/repo/.claude/rules/x.md",
      agentId: "agent-1", agentType: "general-purpose",
    });
    const rowsG = db.listEventsForWorker(wkr).filter((e) => e.kind === "instructions_loaded");
    check("9: exactly one instructions_loaded event appended for the worker", rowsG.length === 1);
    check("9: filed under workerSessionId = the session itself, managerSessionId = its parent, taskId = its task",
      rowsG[0]?.workerSessionId === wkr && rowsG[0]?.managerSessionId === mgr && rowsG[0]?.taskId === task);
    check("9: detail carries the full payload with the EXACT field names the audit event uses",
      rowsG[0]?.detail?.filePath === "/repo/CLAUDE.md" && rowsG[0]?.detail?.memoryType === "Project"
        && rowsG[0]?.detail?.loadReason === "session_start"
        && Array.isArray(rowsG[0]?.detail?.globs) && rowsG[0].detail.globs[0] === "**/*.md"
        && rowsG[0]?.detail?.triggerFilePath === "/repo/src/x.ts" && rowsG[0]?.detail?.parentFilePath === "/repo/.claude/rules/x.md"
        && rowsG[0]?.detail?.agentId === "agent-1" && rowsG[0]?.detail?.agentType === "general-purpose");
    check("9: detail does NOT carry any of the hook's other real base fields (transcript_path/cwd/scratchpad_dir/prompt_id/effort) — minimal payload",
      !("transcriptPath" in (rowsG[0]?.detail ?? {})) && !("cwd" in (rowsG[0]?.detail ?? {}))
        && !("scratchpadDir" in (rowsG[0]?.detail ?? {})) && !("promptId" in (rowsG[0]?.detail ?? {}))
        && !("effort" in (rowsG[0]?.detail ?? {})));

    // --- 10: a parentless session (e.g. a manager/platform with no parentSessionId) falls back to its own id
    const lone = `instr-h-lone-${sfx}`;
    mkSession({ id: lone, role: "platform" });
    sessions.handleInstructionsLoaded(lone, { filePath: "/x/CLAUDE.md", memoryType: "User", loadReason: "session_start" });
    const rowsH = db.listEventsForWorker(lone).filter((e) => e.kind === "instructions_loaded");
    check("10: a parentless session files managerSessionId = its OWN sessionId (never empty/null)",
      rowsH.length === 1 && rowsH[0].managerSessionId === lone && rowsH[0].workerSessionId === lone);

    // --- 11: optional fields omitted on the call — detail key set is exactly the three required fields
    const minimal = `instr-i-min-${sfx}`;
    mkSession({ id: minimal, role: "worker" });
    sessions.handleInstructionsLoaded(minimal, { filePath: "/x/AGENTS.md", memoryType: "Local", loadReason: "include" });
    const rowsI = db.listEventsForWorker(minimal).filter((e) => e.kind === "instructions_loaded");
    check("11: with no optional fields passed, detail's key set is EXACTLY {filePath, memoryType, loadReason} — no stray undefined keys",
      rowsI.length === 1 && Object.keys(rowsI[0].detail ?? {}).sort().join(",") === "filePath,loadReason,memoryType");

    // --- 12: SessionService itself does NOT dedupe — two distinct calls append two distinct rows
    // (dedup is deliverHook's own job, PART 1 above; this proves the two layers stay cleanly separated)
    const dup = `instr-j-dup-${sfx}`;
    mkSession({ id: dup, role: "worker" });
    sessions.handleInstructionsLoaded(dup, { filePath: "/x/CLAUDE.md", memoryType: "Project", loadReason: "session_start" });
    sessions.handleInstructionsLoaded(dup, { filePath: "/x/CLAUDE.md", memoryType: "Project", loadReason: "session_start" });
    const rowsJ = db.listEventsForWorker(dup).filter((e) => e.kind === "instructions_loaded");
    check("12: SessionService.handleInstructionsLoaded does not itself dedupe — two calls, two rows", rowsJ.length === 2);
  }
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the InstructionsLoaded hook dispatches through PtyHost.deliverHook with correct "
    + "per-incarnation dedupe, and SessionService.handleInstructionsLoaded appends a correctly-filed, "
    + "minimal-payload instructions_loaded event for every role."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
