// Integrated phase-1 end-to-end pass: drives the WHOLE assembled product through one
// running daemon, exercising every surface the UI sits on top of, in one flow:
//   project -> agent -> board task + move -> spawn real session (live terminal) ->
//   agent sees the board via MCP -> vault browse -> git view -> transcript ->
//   dead-session detection (grey-out).
// Run: 1) start the daemon WITH LOOM_TEST=1 set (in addition to an isolated LOOM_HOME/LOOM_PORT),
// 2) node test/integration-e2e.mjs
// LOOM_TEST=1 on the DAEMON (not just this test process) is required for step 8: it gates the
// `/internal/test/sweep-dead-sessions` trigger (gateway/server.ts) the same way it gates
// `/internal/test/seed` — mounted only under `inTestMode()`, so a real end-user daemon never has this
// route at all.
//
// This is the one test that MUST spawn a real `claude` (so it can't use an isolated
// CLAUDE_CONFIG_DIR — that breaks the unattended spawn; see test/claude-config.mjs). The
// real spawn makes the daemon's ensureTrusted add a trust entry for our temp dir into the
// real ~/.claude.json. The finally block surgically removes ONLY that entry and the temp
// dir afterward, so the suite leaves ~/.claude.json and %TEMP% unchanged.
//
// The real spawn also makes Claude create an encoded project dir under the real
// ~/.claude/projects (see encodeProjectDir below) to hold this run's engine transcript. Card
// 89991ed0: this dir can't be avoided by HOME-sandboxing the way other tests do (b7f758f4,
// 9878e520) — that would break the real-claude spawn this test exists to exercise — so cleanup
// has to be cleanup-shaped, not redirection-shaped. `engineDir` below is `registerForCleanup`'d
// the moment it's computable (same defense-in-depth-backstop pattern `_transcript-fixture.mjs`'s
// withEngineTranscriptFixture already uses for the identical real-homedir problem), ON TOP OF an
// explicit recursive removal in the `finally` below — never a substring/prefix match, always the
// exact path this run computed. GUARANTEE: this survives an uncaught exception or an explicit
// process.exit() (both routed through _tmp-fixture.mjs's exit hooks) and a transient
// EBUSY/EPERM handle (bounded retry+backoff). It does NOT survive SIGKILL/taskkill/abort — those
// bypass Node's JS-level shutdown entirely, and no JS-level cleanup can catch them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PLATFORM_DEFAULTS } from "@loom/shared";
import { writeJsonAtomic } from "../dist/pty/claude-config.js";
import { encodeProjectDir } from "../dist/sessions/transcript.js";

import { requireHermeticEnv } from "./_guard.mjs";
import { registerForCleanup, unregister } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv({ port: true }); // prod-guard: abort unless LOOM_HOME=<temp> + LOOM_PORT != 4317
const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const post = async (u, b) => (await fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) })).json();
const postRaw = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- a real git repo with docs, used as both repo + vault ---
const dir = path.join(os.tmpdir(), `loom-e2e-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
fs.writeFileSync(path.join(dir, "README.md"), "# E2E Project\nIntegrated phase-1 pass.\n");
fs.writeFileSync(path.join(dir, "docs", "note.md"), "# Note\nhello vault\n");
execSync(`git init -q`, { cwd: dir });
commitAll(dir, "init e2e", "-c user.email=e2e@loom -c user.name=e2e");

// The exact real-homedir dir this run's spawn will create — computed with the SAME encoder
// production uses (claude-transcript.js), not a hand-rolled copy, so this can never target the
// wrong directory. Registered for cleanup immediately, before the real spawn even happens.
const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(dir));
registerForCleanup(engineDir);

// Hermeticity bookkeeping: the trust key ensureTrusted will add, and whether the real
// ~/.claude.json already had it (it shouldn't — fresh temp dir — but only remove what we add).
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKey = path.resolve(dir).replace(/\\/g, "/");
const realHadKeyBefore = (() => {
  try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; }
})();

let session = null;
try {
  // 1. project + agent
  const P = await post("/api/projects", { name: `E2E-${Date.now()}`, repoPath: dir, vaultPath: dir });
  check("1. project created", !!P.id);
  const PROMPT = "Call the tasks_list tool. Then call tasks_create with title set to exactly 'SAW=' followed by the titles of the tasks you saw joined with '+'. Then stop. Do not use other tools or ask questions.";
  const agent = await post(`/api/projects/${P.id}/agents`, { name: "build", startupPrompt: PROMPT });
  check("1. agent created", !!agent.id);

  // 2. board: create a task and MOVE it (the kanban drag path)
  const t1 = await post(`/api/projects/${P.id}/tasks`, { title: "T1" });
  await post(`/api/tasks/${t1.id}`, { columnKey: "in_progress" });
  const board = await get(`/api/projects/${P.id}/board`);
  check(`2. board has ${PLATFORM_DEFAULTS.kanbanColumns.length} resolved columns (the platform default)`,
    board.columns.length === PLATFORM_DEFAULTS.kanbanColumns.length);
  check("2. card T1 moved to in_progress", board.tasks.find((t) => t.id === t1.id)?.columnKey === "in_progress");

  // 3. spawn -> live session + engine id (the live terminal)
  session = await post(`/api/agents/${agent.id}/sessions`, {});
  check("3. session spawned live", session.processState === "live");
  let engineId = null;
  for (let i = 0; i < 40 && !engineId; i++) {
    await sleep(1000);
    engineId = (await get("/api/sessions")).find((s) => s.id === session.id)?.engineSessionId;
  }
  check("3. engine session id captured (terminal warmed)", !!engineId);

  // 4. the spawned agent saw the board via MCP (board <-> MCP integration in-flow)
  let marker = null;
  for (let i = 0; i < 40 && !marker; i++) {
    await sleep(1500);
    marker = (await get(`/api/projects/${P.id}/board`)).tasks.find((t) => t.title.startsWith("SAW="));
  }
  check("4. agent's tasks_list saw the board task T1", !!marker && marker.title.includes("T1"));

  // 5. vault browse + file viewer
  const tree = await get(`/api/projects/${P.id}/vault`);
  const files = new Set(tree.map((e) => e.path));
  check("5. vault tree lists README.md and docs/note.md", files.has("README.md") && files.has("docs/note.md"));
  const readme = await get(`/api/projects/${P.id}/vault/file?path=README.md`);
  check("5. vault file viewer returns content", readme.content.includes("E2E Project"));

  // 6. git view
  const branches = await get(`/api/projects/${P.id}/git/branches`);
  check("6. git branches present", branches.all.length >= 1);
  const log = await get(`/api/projects/${P.id}/git/log`);
  check("6. git log shows the init commit", log.some((c) => c.message === "init e2e"));

  // 7. transcript
  const tx = await get(`/api/sessions/${session.id}/transcript`);
  check("7. transcript renders real turns", tx.length > 0 && tx.some((t) => t.role === "assistant"));

  // 8. dead-session grey-out: stop, delete the engine transcript, then deterministically trigger the
  // REAL production sweep (sessions/liveness.ts's sweepDeadSessions — the same function boot and the
  // chokidar watcher call) via the test-only /internal/test/sweep-dead-sessions route, and assert
  // immediately. No poll loop, no timing bound — see card 4baa7a08.
  // A "hard" stop auto-archives the session on exit (archiveOnExit, card b37750a4 — every stopped
  // session leaves the live rail), so GET /api/sessions (live rail only) can never see it again
  // regardless of how long anything polls; read it back via the project's Archive listing instead.
  await post(`/api/sessions/${session.id}/stop`, { mode: "hard" });
  await sleep(1500);
  if (engineId) fs.rmSync(path.join(engineDir, `${engineId}.jsonl`), { force: true });
  const sweepRes = await postRaw("/internal/test/sweep-dead-sessions", {});
  if (sweepRes.status === 404) {
    throw new Error("8. /internal/test/sweep-dead-sessions is 404 — this test requires the daemon to be started with LOOM_TEST=1 (see this file's header comment)");
  }
  check("8. dead-session sweep trigger succeeded", sweepRes.status === 200);
  const archived = await get(`/api/projects/${P.id}/archive`);
  const dead = archived.items.find((s) => s.id === session.id)?.resumability === "dead";
  check("8. session greyed out as dead once its transcript vanished", dead);
} finally {
  // Tear down so the suite is hermetic: stop a still-live session, remove ONLY the trust entry
  // we caused (if we added it), drop the temp dir, and drop the real-homedir engine transcript
  // dir this run's spawn created (card 89991ed0 — see the header comment for why this can't be
  // HOME-sandboxed away like the other real-homedir tests).
  try { if (session?.id) await postRaw(`/api/sessions/${session.id}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  await sleep(1500);
  if (!realHadKeyBefore) {
    try {
      const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
      if (cfg.projects && trustKey in cfg.projects) {
        delete cfg.projects[trustKey];
        writeJsonAtomic(realClaudeJson, cfg); // atomic: a crash mid-write can't corrupt the real config
      }
    } catch { /* nothing to clean */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });

  // Exact path only — never a prefix/substring match. This tree also holds ~1761 live worker
  // transcripts and 31 real human project dirs read at runtime by other daemon machinery; a
  // fuzzy match here would be a real production hazard, not just a test-hygiene one.
  try { fs.rmSync(engineDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (err) { console.error(`[integration-e2e] retained for exit-hook backstop: ${engineDir} — ${err}`); }
  if (fs.existsSync(engineDir)) {
    // Left in the registerForCleanup registry deliberately — the process-exit backstop gets
    // another shot at it (a fresh EBUSY/EPERM backoff window) before the process actually ends.
    console.error(`[integration-e2e] engineDir survived explicit teardown, relying on exit-hook backstop: ${engineDir}`);
  } else {
    unregister(engineDir);
  }
}

console.log(failures === 0
  ? "\n✅ INTEGRATED PASS — the assembled phase-1 product works end-to-end in one session."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
