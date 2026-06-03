// Busy-flag state-machine test (PR #9). Live-daemon style (like mcp-scope/integration-e2e):
// spawns a REAL `claude` session with a startup prompt and asserts the hook-driven busy flag
// rises while the turn runs and falls when it ends, observed purely through GET /api/sessions:
//
//   busy=true  while the startup turn runs  (rising edge: spawn-time optimistic set, which the
//              UserPromptSubmit hook then re-asserts — both confirmed in the daemon's [hook] log)
//   busy=false after the turn's Stop hook    (falling edge — exactly one Stop per end-of-turn)
//
// Scope note: this covers the SPAWN path, which is PR #9's DoD. The injected-prompt rising edge
// (a prompt pushed mid-session) rides on PR #14's enqueueStdin mechanic and is validated there
// (messaging.mjs), not here — the same deliverHook switch routes UserPromptSubmit for both.
//
// Run: 1) start the daemon (node dist/index.js), 2) node test/busy-flag.mjs
//
// Like integration-e2e.mjs this MUST spawn a real `claude`, so it can't use an isolated
// CLAUDE_CONFIG_DIR. The spawn makes ensureTrusted add a trust entry for our temp dir to the
// real ~/.claude.json; the finally block removes ONLY that entry (if we added it) + the temp dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { writeJsonAtomic } from "../dist/pty/claude-config.js";

const BASE = `http://127.0.0.1:${process.env.LOOM_PORT || 4317}`;
const post = async (u, b) => (await fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) })).json();
const postRaw = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
const get = async (u) => (await fetch(BASE + u)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Poll GET /api/sessions until our session matches `pred`, or time out. Returns the row (or last seen).
async function waitForSession(sessionId, pred, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await get("/api/sessions")).find((s) => s.id === sessionId) ?? last;
    if (last && pred(last)) return last;
    await sleep(intervalMs);
  }
  return last;
}

// --- a real git repo to point the session at ---
const dir = path.join(os.tmpdir(), `loom-busy-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "README.md"), "# Busy-flag test\n");
execSync(`git init -q && git add . && git -c user.email=busy@loom -c user.name=busy commit -q -m "init"`, { cwd: dir });

// Hermeticity bookkeeping: only remove the trust key if WE added it.
const realClaudeJson = path.join(os.homedir(), ".claude.json");
const trustKey = path.resolve(dir).replace(/\\/g, "/");
const realHadKeyBefore = (() => {
  try { return trustKey in (JSON.parse(fs.readFileSync(realClaudeJson, "utf8")).projects ?? {}); } catch { return false; }
})();

let session = null;
try {
  // Project + agent. The startup prompt runs one tool-free turn and stops — one full
  // UserPromptSubmit -> Stop busy cycle.
  const P = await post("/api/projects", { name: `Busy-${Date.now()}`, repoPath: dir, vaultPath: dir });
  check("project created", !!P.id);
  const STARTUP = "Respond with exactly the word READY and nothing else, then stop. Do not use any tools and do not ask any questions.";
  const agent = await post(`/api/projects/${P.id}/agents`, { name: "busy", startupPrompt: STARTUP });
  check("agent created", !!agent.id);

  session = await post(`/api/agents/${agent.id}/sessions`, {});
  check("session spawned live", session.processState === "live");

  // Rising edge: the optimistic spawn set makes busy=true visible immediately; the
  // UserPromptSubmit hook re-asserts it (idempotent). Either way GET /api/sessions sees true.
  const rose = await waitForSession(session.id, (s) => s.busy === true, 10_000);
  check("busy=true while the startup turn runs (rising edge)", rose?.busy === true);

  // SessionStart still captures the engine id — confirms PR #9 didn't regress it.
  const warmed = await waitForSession(session.id, (s) => !!s.engineSessionId, 60_000);
  check("engine session id captured (SessionStart unaffected)", !!warmed?.engineSessionId);

  // Falling edge: the Stop hook clears busy at end-of-turn.
  const fell = await waitForSession(session.id, (s) => s.busy === false, 90_000);
  check("busy=false after the turn's Stop hook (falling edge)", fell?.busy === false);
} finally {
  try { if (session?.id) await postRaw(`/api/sessions/${session.id}/stop`, { mode: "hard" }); } catch { /* ignore */ }
  await sleep(1500);
  if (!realHadKeyBefore) {
    try {
      const cfg = JSON.parse(fs.readFileSync(realClaudeJson, "utf8"));
      if (cfg.projects && trustKey in cfg.projects) {
        delete cfg.projects[trustKey];
        writeJsonAtomic(realClaudeJson, cfg);
      }
    } catch { /* nothing to clean */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — busy rises while the startup turn runs and falls on its Stop hook."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
