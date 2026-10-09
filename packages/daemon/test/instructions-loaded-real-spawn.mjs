// Real-spawn proof for board card 8c70e33c — a REAL, authenticated `claude` process actually fires its
// own `InstructionsLoaded` hook for a Project CLAUDE.md, and that hook is relayed end to end through
// Loom's real wiring (hook-relay.mjs -> /internal/hook -> PtyHost.verifyHookToken -> PtyHost.deliverHook
// -> PtyHostEvents.onInstructionsLoaded -> SessionService.handleInstructionsLoaded -> Db.appendEvent),
// landing a real `instructions_loaded` row. See instructions-loaded-hook.mjs for the pure in-process
// proof of the dispatch/dedupe/filing logic in isolation (fake pty, no real CLI); THIS file proves the
// REAL installed CLI genuinely emits the hook under the name/shape this daemon expects — the engine
// itself, not this repo's own code, is the thing under test here (same split as
// loom-home-write-deny-real-spawn.mjs's own header).
//
// ⛔⛔ MANUAL-ONLY — listed in `NOT_HERMETIC` (scripts/test-daemon.mjs), deliberately NEVER run as part of
// `pnpm --filter @loom/daemon test:daemon` or any merge/worker gate. One real, authenticated `claude`
// process, one real model turn (same cost/flake rationale as loom-home-write-deny-real-spawn.mjs's own
// header — not re-derived here). Re-run by hand only when specifically needed (e.g. after a `claude` CLI
// upgrade — the hook's own existence/exact field names are an engine behavior, not Loom's own code).
//
// Run ONCE. If it fails for a clearly ENVIRONMENTAL reason (auth expiry, a transient network error, host
// contention) retry AT MOST ONCE by hand — do not loop automatically, and do not treat a second failure
// as environmental without saying so explicitly in the report.
//
// ⚠️ ~/.claude.json: like busy-flag.mjs and loom-home-write-deny-real-spawn.mjs, this file CANNOT use an
// isolated CLAUDE_CONFIG_DIR — it needs the REAL login credentials to spawn an authenticated `claude`.
// The real spawn makes the REAL `ensureTrusted` (pty/claude-config.ts, called from createPty via
// ensureTrustedResilient — never hand-rolled here) add a trust entry for THIS file's own temp cwd to the
// real ~/.claude.json; the `finally` block removes ONLY that one entry (and only if we actually added
// it), by trust KEY, never by rewriting unrelated entries. Per the manager's own approval conditions
// (card 8c70e33c): the `projects` entry COUNT in ~/.claude.json is read and reported before AND after —
// never the file's content — and the two counts must match.
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `claude` CLI. SKIPS gracefully (exit 0) via a
// deterministic `claude auth status` preflight if the binary is missing or not logged in.
//
// Uses its OWN hermetic LOOM_HOME (useOwnLoomHome + requireHermeticEnv) — never the real ~/.loom.
//
// Kill discipline: only the ONE pid this file itself spawned, via `host.stop(sessionId, "hard")` —
// never by image name or port (CLAUDE.md's standing process-cleanup rule).
//
// Run: 1) build (turbo builds shared first), 2) node test/instructions-loaded-real-spawn.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { reserveHermeticPort } from "./_hermetic-port.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const claudeBin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || "claude");

// --- Graceful skip: deterministic preflight (mirrors loom-home-write-deny-real-spawn.mjs) ---
try {
  const { stdout } = await execFileAsync(claudeBin, ["auth", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
  const parsed = JSON.parse(stdout);
  if (parsed.loggedIn !== true) throw new Error(`claude auth status reports loggedIn=${parsed.loggedIn}`);
} catch (e) {
  console.log(`WARN  SKIP  instructions-loaded-real-spawn.mjs — real, authenticated claude CLI not available on this host (${String(e.message ?? e).split("\n")[0]}).`);
  process.exit(0);
}

useOwnLoomHome("instr-loaded-real-", { fresh: true });
// reserveHermeticPort (not the plain pid-derived hermeticPort()) — this file imports PtyHost BEFORE its
// server/listen() exist, so the port must be FINAL here (same note as loom-home-write-deny-real-spawn.mjs).
process.env.LOOM_PORT = String(await reserveHermeticPort());
requireHermeticEnv({ port: true });

const { ensureDirs, LOOM_HOME } = await import("../dist/paths.js");
ensureDirs();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { writeJsonAtomic } = await import("../dist/pty/claude-config.js");

const now = new Date().toISOString();
const db = new Db(path.join(LOOM_HOME, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });

const SID = "instr-loaded-real-worker";
db.insertSession({
  id: SID, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker",
});

const { PtyHost } = await import("../dist/pty/host.js");
const engineIds = new Map();
const loadedCalls = []; // { sessionId, info } captured from the REAL PtyHostEvents.onInstructionsLoaded
let sessions; // forward reference — same pattern as index.ts's real wiring (sessions assigned after `host`)
const events = {
  onEngineSessionId(id, eng) { engineIds.set(id, eng); },
  onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onInstructionsLoaded(sessionId, info) {
    loadedCalls.push({ sessionId, info });
    sessions.handleInstructionsLoaded(sessionId, info); // the REAL implementer — a real Db.appendEvent
  },
};
const host = new PtyHost(events);
sessions = new SessionService(db, host, new OrchestrationControl());

const stub = {};
const app = await buildServer({
  db, pty: host, sessions: stub,
  mcp: new TaskMcpRouter(db, {}),
  orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
await app.listen({ port: Number(process.env.LOOM_PORT), host: "127.0.0.1" });

// cwd OUTSIDE LOOM_HOME, with a throwaway Project-scope CLAUDE.md so a session_start-reason,
// memory_type:"Project" InstructionsLoaded load is guaranteed on boot.
const cwd = mkdtempManaged("loom-instr-loaded-cwd-");
fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "# Instructions-Loaded real-spawn test\n\nThrowaway CLAUDE.md for card 8c70e33c's real-spawn proof. No real project conventions here.\n");

// --- ~/.claude.json hermeticity bookkeeping (manager-approved conditions, card 8c70e33c) ---
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKey = path.resolve(cwd).replace(/\\/g, "/");
const countProjects = () => { try { return Object.keys(JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}).length; } catch { return null; } };
const realHadKeyBefore = (() => {
  try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; }
})();
const projectsCountBefore = countProjects();
console.log(`[evidence] ~/.claude.json projects entry count BEFORE this spawn: ${projectsCountBefore}`);

const prompt = "Respond with exactly the word READY and nothing else, then stop. Do not use any tools and do not ask any questions.";

const spawned = [SID];
try {
  host.spawn({
    sessionId: SID, cwd, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    resumeModeTarget: "auto",
    geometry: { cols: 120, rows: 40 },
    sessionEnv: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" },
    role: "worker", startupPrompt: prompt,
  });

  const engineDeadline = Date.now() + 30000;
  // TIMING-GUARD-SAFE: fully-awaited-completion — card c83983cc: this loop's OWN exit condition
  // (`engineIds.has(SID)`) IS the exact fact the check right below re-reads.
  while (!engineIds.has(SID) && Date.now() < engineDeadline) await sleep(250);
  check("SessionStart captured a real engine session id", engineIds.has(SID));

  // 120s — InstructionsLoaded fires at session start, typically well before the model's own first turn
  // completes.
  const deadline = Date.now() + 120000;
  let fired = false;
  while (Date.now() < deadline) {
    if (loadedCalls.some((c) => c.sessionId === SID)) { fired = true; break; }
    // TIMING-GUARD-SAFE: fully-awaited-completion — card c83983cc: this loop's OWN exit condition
    // (`fired`, set from the real captured onInstructionsLoaded call) IS the exact fact the check below
    // re-reads.
    await sleep(1000);
  }
  check("the real installed claude CLI fired a real InstructionsLoaded hook for this session", fired);

  const ours = loadedCalls.filter((c) => c.sessionId === SID);
  const projectLoad = ours.find((c) => c.info.memoryType === "Project" && c.info.loadReason === "session_start");
  check("at least one captured load is memoryType=Project, loadReason=session_start (our own throwaway CLAUDE.md)", !!projectLoad);
  check("that load's filePath names a real CLAUDE.md under our temp cwd", !!projectLoad && projectLoad.info.filePath.toLowerCase().includes("claude.md"));
  if (ours.length) console.log(`[evidence] captured InstructionsLoaded payload(s) for ${SID}: ${JSON.stringify(ours.map((c) => c.info))}`);

  // --- end-to-end: the durable row actually landed via the REAL SessionService.handleInstructionsLoaded ---
  const rows = db.listEventsForWorker(SID).filter((e) => e.kind === "instructions_loaded");
  check("a real `instructions_loaded` durable event row exists for this session", rows.length >= 1);
  check("the durable row's detail carries filePath/memoryType/loadReason matching the captured hook",
    rows.some((r) => r.detail?.memoryType === "Project" && r.detail?.loadReason === "session_start" && typeof r.detail?.filePath === "string"));
} finally {
  console.log("[cleanup] killing the real claude process this file spawned (by tracked pid only, via host.stop)…");
  for (const id of spawned) { try { host.stop(id, "hard"); } catch { /* best-effort */ } }
  await sleep(2000);
  try { await app.close(); } catch { /* best-effort */ }
  try { db.close(); } catch { /* best-effort */ }

  // Surgical ~/.claude.json cleanup — remove ONLY our own trust entry, only if WE added it (same recipe
  // as busy-flag.mjs), then verify the projects COUNT is back to where it started (never print/copy the
  // file itself).
  if (!realHadKeyBefore) {
    try {
      const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
      if (cfg.projects && trustKey in cfg.projects) {
        delete cfg.projects[trustKey];
        writeJsonAtomic(realClaudeJson, cfg);
      }
    } catch { /* nothing to clean */ }
  }
  const projectsCountAfter = countProjects();
  console.log(`[evidence] ~/.claude.json projects entry count AFTER cleanup: ${projectsCountAfter}`);
  check("~/.claude.json projects entry count is unchanged after cleanup (before === after)", projectsCountAfter === projectsCountBefore);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real, authenticated claude process fired a real InstructionsLoaded hook for a "
    + "Project CLAUDE.md, relayed end to end through PtyHost.deliverHook into a real "
    + "SessionService.handleInstructionsLoaded call, landing a real durable instructions_loaded row — "
    + "and ~/.claude.json's own projects entry count is unchanged after cleanup."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
