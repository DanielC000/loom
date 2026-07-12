// REAL-CLAUDE STANDALONE SMOKE (card 9c03f5a6) — mandatory manual verification that the combined
// permission-mode fix (modeCycleChain serialization, the bounded outer retry, the widened auto-heal, and
// the new `skipAutoPermissionPrompt` settings key) does NOT regress the validated gate-free unattended
// boot recipe: spawn ONE real `claude` as role="worker" with the PROD startupModeCycles:2 config, and
// confirm via the daemon's own `[resume-mode]` log line that it lands `mode=auto`, then confirm it takes a
// REAL turn (a Stop hook fires) with no hang on any permission/dialog prompt. NOT a hermetic CI test (needs
// real `claude` + real auth) — mirrors test/_probe-resume-mode.mjs's isolation pattern exactly.
//
// ISOLATION (HARD RULES, same as _probe-resume-mode.mjs): temp LOOM_HOME, a non-prod port, a throwaway
// temp git repo as cwd. The relay POSTs hooks to OUR minimal server on that port — the prod daemon never
// sees this session. We do NOT sandbox HOME: real `claude` needs its real auth to boot. The two MCP
// entries a worker mounts (loom-tasks, loom-orchestration — both HTTP-type, pointed at our own port) have
// no real router behind them here; our server answers with a fast 404 for anything but /internal/hook so
// an unreachable-MCP condition fails FAST rather than hanging — this smoke is only about the mode-cycle
// and turn-completion path, not exercising the actual MCP tool surface. KILLS the spawned claude in
// finally (scoped via host.stop, never a bare process-name kill).
//
// RUN: `pnpm build` (repo root) then `node test/_smoke-mode-fix-9c03f5a6.mjs` from packages/daemon.
//      Override the binary with LOOM_CLAUDE_BIN; default is PATH-resolved "claude".
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4321; // distinct from prod (4317) and the resume-mode probe (4319)
const tmpHome = path.join(os.tmpdir(), `loom-smoke-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(PORT);

const { PtyHost } = await import("../dist/pty/host.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) => s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1B[()][0-9A-Za-z]/g, "").replace(/\x1B[=>]/g, "");

// Capture every "[resume-mode] ..." console.log line PtyHost emits internally — this is the evidence the
// manager asked to see reported verbatim.
const resumeModeLines = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  if (line.includes("[resume-mode]")) resumeModeLines.push(line);
  realLog(...args);
};

const engineIds = new Map();
const stoppedTurns = new Map();
const events = {
  onEngineSessionId(id, eng) { engineIds.set(id, eng); realLog(`[smoke] engineSessionId ${id} -> ${eng}`); },
  onBusy(id, busy) { realLog(`[smoke] onBusy ${id} busy=${busy}`); },
  onContextStats() {}, onRateLimited() {},
  onExit(id, code) { realLog(`[smoke] onExit ${id} code=${code}`); },
};
const host = new PtyHost(events);

// Minimal relay: /internal/hook feeds real hooks to the host (SessionStart/UserPromptSubmit/Stop);
// everything else (incl. the worker's own loom-tasks/loom-orchestration MCP connection attempts) gets a
// fast 404 so an unreachable-MCP condition can't hang the boot.
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/internal/hook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body);
        if (b?.sessionId && b.hook) {
          const ev = b.hook.hook_event_name;
          if (ev === "Stop" || ev === "StopFailure") stoppedTurns.set(b.sessionId, (stoppedTurns.get(b.sessionId) || 0) + 1);
          host.deliverHook(b.sessionId, b.hook);
        }
      } catch { /* ignore */ }
      res.end('{"ok":true}');
    });
    return;
  }
  res.statusCode = 404; res.end("nope");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
realLog(`[smoke] hook/relay server on 127.0.0.1:${PORT}`);

// Throwaway temp git repo as the project cwd — never the actual worktree.
const repo = path.join(os.tmpdir(), `loom-smoke-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# smoke\n");
execSync(`git init -q && git add . && git -c user.email=s@s -c user.name=s commit -q -m init`, { cwd: repo });

const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
// The EXACT prod worker default: acceptEdits boot + 2 cycles → auto (PLATFORM_DEFAULTS.permission).
const permission = { mode: "acceptEdits", allow: ["mcp__loom-tasks"], deny: [], startupModeCycles: 2 };

const SID = "smoke-worker-9c03f5a6";
const results = [];
const assert = (label, cond) => { results.push({ label, pass: !!cond }); realLog(`[smoke] ${cond ? "PASS" : "FAIL"}  ${label}`); };

try {
  realLog("[smoke] spawning a REAL role=worker session (prod startupModeCycles:2 config)...");
  host.spawn({
    sessionId: SID, cwd: repo, permission, geometry, sessionEnv, role: "worker",
    startupPrompt: "Reply with exactly the single word OK and nothing else.",
  });

  // Wait for the boot cycle + logLandedMode's read to settle and log the landed mode.
  const settled = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      if (resumeModeLines.some((l) => l.includes(`${SID} kind=fresh mode=`))) return true;
      await sleep(300);
    }
    return false;
  })();
  assert("the [resume-mode] landed-mode log line appeared within 25s (no boot hang)", settled);

  const landedLine = resumeModeLines.find((l) => l.includes(`${SID} kind=fresh mode=`));
  realLog(`[smoke] captured landed-mode evidence: ${landedLine ?? "(none)"}`);
  assert("the REAL worker landed EXACTLY mode=auto (the prod default target)", !!landedLine && /mode=auto\b/.test(landedLine));

  // Confirm a REAL turn completes (the startup-prompt kickoff) — proves auto mode took the turn without
  // hanging on any permission/dialog prompt (a plan-mode or bypassPermissions-dialog trap would stall here).
  const before = stoppedTurns.get(SID) || 0;
  const completed = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if ((stoppedTurns.get(SID) || 0) > before) return true;
      await sleep(500);
    }
    return false;
  })();
  assert("a REAL turn completed (Stop hook fired) within 60s — no hang on any prompt/dialog", completed);
} finally {
  console.log = realLog;
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  await sleep(1000);
  try { server.close(); } catch { /* ignore */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.pass);
realLog(failed.length === 0
  ? "\n✅ SMOKE PASS — a real role=worker session, spawned with the combined mode-cycle fix live, lands "
    + "EXACTLY mode=auto and completes a real turn with no hang on any permission/dialog prompt."
  : `\n❌ SMOKE FAILED (${failed.length}): ${failed.map((r) => r.label).join("; ")}`);
process.exit(failed.length === 0 ? 0 : 1);
