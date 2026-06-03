// Claude-free regression guard for PLAIN SHELL terminals (PtyHost.spawnShell + the human-only/no-MCP
// trust rule). Two things this locks down:
//   1) A shell registers as a kind:"shell" entry in PtyHost's live map, is listed by listShells(),
//      takes RAW writeStdin + resize, and is SKIPPED by the Claude-only machinery (deliverHook's
//      busy state machine + reconcile). On pty exit it drops from the map WITHOUT calling
//      events.onExit (a shell is not a DB Session — it must not touch Session/MCP persistence).
//   2) The SECURITY guardrail: spawning a shell is human-only (POST /api/terminals) and is NEVER an
//      MCP tool — so an acceptEdits-sandboxed agent can't spawn an arbitrary host process. We assert
//      no MCP server source registers a terminal/shell-spawn tool, and that spawnShell/listShells/the
//      REST path appear ONLY in the pty host + gateway, never in any mcp/*.ts.
//
// Exercises the real PtyHost via the createShellPty() seam with a FAKE pty — NO real process, no
// network, no daemon. RUN (after `pnpm build`): node test/shell-terminal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-id log under $LOOM_HOME/logs in spawnShell) — set BEFORE import.
const tmpHome = path.join(os.tmpdir(), `loom-shelltest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");

// A fake shell pty: records writes + resizes; kill() fires onExit (mirrors real node-pty teardown).
const fakes = [];
function makeFakeShellPty() {
  const writes = [];
  const resizes = [];
  let exitCb = null;
  const fake = {
    pid: 7777,
    write: (d) => { writes.push(d); },
    resize: (c, r) => { resizes.push([c, r]); },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitCb = cb; return { dispose() {} }; },
    kill: () => { if (exitCb) exitCb({ exitCode: 0 }); },
    writes, resizes,
  };
  fakes.push(fake);
  return fake;
}

// Override the ONE shell seam → no real process. (createPty, the Claude seam, is left real but unused.)
class TestPtyHost extends PtyHost {
  createShellPty() { return makeFakeShellPty(); }
}

const events = {
  onEngineSessionId() {}, onBusy() { events.busyCalls++; }, onContextStats() {},
  onRateLimited() {}, onExit() { events.exitCalls++; }, busyCalls: 0, exitCalls: 0,
};

const host = new TestPtyHost(events);
const SID = "shell-test-id";

try {
  host.spawnShell({ id: SID, cwd: tmpHome, command: "pwsh", args: ["-NoLogo"], geometry: { cols: 120, rows: 40 }, label: "demo · shell" });
  const fake = fakes[0];
  check("spawnShell used the injected fake pty (no real process)", !!fake && host.isAlive(SID) === true);

  // --- listing ---
  const list = host.listShells();
  check("listShells returns the one shell with its metadata", list.length === 1
    && list[0].id === SID && list[0].cwd === tmpHome && list[0].command === "pwsh"
    && list[0].label === "demo · shell" && list[0].alive === true);

  // --- raw input passthrough (writeStdin, NOT the busy-gated enqueue) ---
  host.writeStdin(SID, "git status\r");
  check("writeStdin passes raw bytes straight to the shell pty", fake.writes.join("").includes("git status\r"));

  // --- resize is honored for shells ---
  host.resize(SID, 100, 30);
  check("resize forwards to the shell pty", fake.resizes.length === 1 && fake.resizes[0][0] === 100 && fake.resizes[0][1] === 30);

  // --- Claude-only machinery SKIPS the shell ---
  const busyBefore = events.busyCalls;
  host.deliverHook(SID, { hook_event_name: "UserPromptSubmit" });
  host.deliverHook(SID, { hook_event_name: "Stop" });
  check("deliverHook is a no-op for a shell (no busy transitions, no throw)", events.busyCalls === busyBefore);
  host.reconcile(); // must skip the shell (no busy/queue to heal/drain) and not crash
  check("reconcile leaves the shell alive and untouched", host.isAlive(SID) === true);

  // --- exit drops it from the map WITHOUT events.onExit (not a DB Session) ---
  const exitBefore = events.exitCalls;
  host.stop(SID, "hard"); // hard → pty.kill() → fake fires onExit
  check("after exit the shell is gone from the live map", host.isAlive(SID) === false && host.listShells().length === 0);
  check("shell exit did NOT call events.onExit (no Session/MCP persistence for a shell)", events.exitCalls === exitBefore);
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ===================== SECURITY: human-only, never an MCP tool =====================
const here = path.dirname(url.fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const read = (rel) => fs.readFileSync(path.join(srcDir, rel), "utf-8");
const mcpFiles = ["mcp/server.ts", "mcp/orchestration.ts", "mcp/platform.ts"];

// No MCP server may reference the shell-spawn surface at all (no registerTool, no call into it).
const SHELL_SURFACE = ["spawnShell", "listShells", "/api/terminals", "createShellPty"];
let mcpClean = true;
for (const f of mcpFiles) {
  const body = read(f);
  for (const needle of SHELL_SURFACE) {
    if (body.includes(needle)) { mcpClean = false; console.log(`  ✗ ${f} references "${needle}"`); }
  }
  // Belt-and-suspenders: no tool whose NAME mentions terminal/shell.
  if (/registerTool\(\s*["'][^"']*(terminal|shell)/i.test(body)) { mcpClean = false; console.log(`  ✗ ${f} registers a terminal/shell tool`); }
}
check("no MCP server (tasks/orchestration/platform) exposes a shell-spawn tool", mcpClean);

// And the spawn surface IS reachable from the human REST gateway (the endpoint exists).
const gw = read("gateway/server.ts");
check("the human-only REST endpoint POST /api/terminals exists in the gateway",
  gw.includes('"/api/terminals"') && gw.includes("spawnShell"));

console.log(failures === 0
  ? "\n✅ ALL PASS — shell terminals register/list/resize/skip-Claude-logic/clean-exit, and shell spawn is human-only (no MCP tool)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
