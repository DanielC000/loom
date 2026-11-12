// Real-spawn smoke for card da1a4a1b — a REAL, authenticated `claude` worker-role process is refused, by the
// PreToolUse(Bash) guard hook, when a Bash command names the real (here: temp) LOOM_HOME's loom.db, while a
// control command in the same turn runs. bash-loom-home-guard.mjs covers the matcher, the hook process exit
// codes and the settings wiring; THIS file observes the one thing those cannot: that the engine honours the
// hook's exit 2 and feeds our message back (a subprocess-contract that otherwise ships green and no-ops).
//
// ⛔ MANUAL-ONLY — listed in NOT_HERMETIC (scripts/test-daemon.mjs) and REAL_ENGINE_SPAWN_BASENAMES; same
// cost/flake rationale as loom-home-write-deny-real-spawn.mjs (one real model turn on the owner's account).
// Run: build, then `LOOM_ALLOW_REAL_ENGINE=1 node test/bash-loom-home-guard-real-spawn.mjs`.
//
// DETERMINISM: asserts (1) the refused command's output file does NOT exist, (2) the control command's file
// DOES exist, (3) the session TRANSCRIPT (JSONL under ~/.claude/projects) contains the guard's own refusal
// text — (3) is what attributes the refusal to THIS hook rather than to any other engine/permission layer.
// NOT covered: no no-hook control spawn (a second real turn); attribution rests on the refusal text.
import "./_real-engine-opt-in.mjs";
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempManaged, registerForCleanup, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";
import { reserveHermeticPort } from "./_hermetic-port.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const claudeBin = resolveExecutable(process.env.LOOM_CLAUDE_BIN || "claude");
try {
  const { stdout } = await execFileAsync(claudeBin, ["auth", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
  if (JSON.parse(stdout).loggedIn !== true) throw new Error("not logged in");
} catch (e) {
  console.log(`WARN  SKIP  bash-loom-home-guard-real-spawn.mjs — real, authenticated claude CLI not available (${String(e.message ?? e).split("\n")[0]}).`);
  process.exit(0);
}

useOwnLoomHome("blhg-rs-", { fresh: true });
process.env.LOOM_PORT = String(await reserveHermeticPort());
requireHermeticEnv({ port: true });

const { ensureDirs, LOOM_HOME } = await import("../dist/paths.js");
ensureDirs();
const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");

const now = new Date().toISOString();
const db = new Db(path.join(LOOM_HOME, "loom.db"));
db.insertProject({ id: "p", name: "P", repoPath: "/x", vaultPath: "/x", config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a", projectId: "p", name: "a", startupPrompt: "x", position: 0 });
const SID = "blhg-rs-worker";
db.insertSession({
  id: SID, projectId: "p", agentId: "a", engineSessionId: null, title: null, cwd: "/x",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "worker",
});

const { PtyHost } = await import("../dist/pty/host.js");
const engineIds = new Map();
let sawBusy = false, turnEnded = false;
const host = new PtyHost({
  onEngineSessionId(id, eng) { engineIds.set(id, eng); },
  onBusy(id, busy) { if (id !== SID) return; if (busy) sawBusy = true; else if (sawBusy) turnEnded = true; },
  onContextStats() {}, onRateLimited() {}, onExit() {},
});
const stub = {};
const app = await buildServer({
  db, pty: host, sessions: stub, mcp: new TaskMcpRouter(db, {}),
  orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, operatorMcp: stub, runMcp: stub,
  control: stub, usageStatus: stub, requestShutdown: () => {},
});
await app.listen({ port: Number(process.env.LOOM_PORT), host: "127.0.0.1" });
const port = Number(process.env.LOOM_PORT);
const portOpen = () => new Promise((res) => {
  const s = net.connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); res(true); });
  s.once("error", () => res(false));
});

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "blhg-rs-cwd-"));
registerForCleanup(cwd);
const realDb = path.join(LOOM_HOME, "loom.db");
const refusedOut = path.join(cwd, "refused-copy.db");
const controlOut = path.join(cwd, "control.txt");
const REFUSAL = "Refused: this command names the real Loom data directory";
check("setup: refused-copy target does not pre-exist and the temp loom.db does", !fs.existsSync(refusedOut) && fs.existsSync(realDb));
check("setup: the port is open before the stop (positive control for the freed-port probe)", await portOpen());

const prompt = [
  "Run these two Bash commands, one at a time, in order. Do not try any alternate command or tool if one is refused, and do not stop early if one succeeds. Quote each tool result verbatim in your reply.",
  `1) cp "${realDb.replace(/\\/g, "/")}" "${refusedOut.replace(/\\/g, "/")}"`,
  `2) echo CONTROL_RAN > "${controlOut.replace(/\\/g, "/")}"`,
  "After both, reply with exactly one line: DONE",
].join("\n");

let pid;
try {
  host.spawn({
    sessionId: SID, cwd, permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    resumeModeTarget: "auto", geometry: { cols: 120, rows: 40 },
    sessionEnv: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" },
    role: "worker", startupPrompt: prompt,
  });
  const written = JSON.parse(fs.readFileSync(path.join((await import("../dist/paths.js")).SETTINGS_DIR, `${SID}.json`), "utf8"));
  check("settings: the written file carries the Bash guard PreToolUse group for this worker spawn",
    written.hooks.PreToolUse.some((g) => g.matcher === "Bash" && g.hooks[0].command.includes("bash-loom-home-guard.mjs")));
  pid = host.getPid(SID);

  const engineDeadline = Date.now() + 60000;
  // TIMING-GUARD-SAFE: fully-awaited-completion — this loop's exit condition IS the fact the check below re-reads.
  while (!engineIds.has(SID) && Date.now() < engineDeadline) await sleep(250);
  check("SessionStart captured a real engine session id", engineIds.has(SID));

  const deadline = Date.now() + 180000;
  // TIMING-GUARD-SAFE: fully-awaited-completion — exits on the control file + turn end, both re-read below.
  while (Date.now() < deadline && !(fs.existsSync(controlOut) && turnEnded)) await sleep(1000);

  check("[control] the control command ran (control.txt written with CONTROL_RAN)",
    fs.existsSync(controlOut) && fs.readFileSync(controlOut, "utf8").includes("CONTROL_RAN"));
  check("[refused] the command naming the real loom.db did NOT produce its output file", !fs.existsSync(refusedOut));
  check("the turn ended (Stop fired)", turnEnded);

  // Transcript: find <engineId>.jsonl under ~/.claude/projects and look for the guard's own message.
  const engineId = engineIds.get(SID);
  let transcript = null;
  const root = path.join(os.homedir(), ".claude", "projects");
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const f = path.join(root, d, `${engineId}.jsonl`);
    if (fs.existsSync(f)) { transcript = f; break; }
  }
  check("transcript JSONL for this engine session was found", !!transcript);
  const text = transcript ? fs.readFileSync(transcript, "utf8") : "";
  const hit = text.indexOf(REFUSAL);
  check("[attribution] the transcript contains the guard's own refusal message", hit !== -1);
  if (hit !== -1) console.log(`[evidence] transcript excerpt: ${text.slice(Math.max(0, hit - 160), hit + 200).replace(/\s+/g, " ")}`);
} finally {
  console.log("[cleanup] hard-stopping the real claude process…");
  const aliveBefore = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
  try { host.stop(SID, "hard"); } catch { /* best-effort */ }
  await sleep(3000);
  const aliveAfter = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
  try { await app.close(); } catch { /* best-effort */ }
  try { db.close(); } catch { /* best-effort */ }
  await sleep(500);
  check(`captured pid ${pid} was alive before the hard stop (positive control for the liveness probe)`, aliveBefore);
  check(`captured pid ${pid} is gone after the hard stop`, !aliveAfter);
  check(`port ${port} is freed after close`, !(await portOpen()));
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
