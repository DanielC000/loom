// MANUAL PROBE (not in the hermetic suite) — card f9b47cd1's DoD item 5: prove a REAL `claude` process
// still boots unattended when spawned with `-n <name>`, and that the name actually shows (Claude Code
// docs: "-n, --name <name> — Set a display name for this session (shown in the prompt box, /resume
// picker, and terminal title)"). Spawns via the CLAUDE.md recipe (PtyHost.createPty), in an isolated temp
// LOOM_HOME, mirroring _probe-composer-dirty.mjs. No daemon needed — readiness is marked directly via
// deliverHook(SessionStart).
//
//   node test/_probe-session-name.mjs    (after a build; requires a logged-in `claude` >= 2.1.196)
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = path.join(os.tmpdir(), `loom-snprobe-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = process.env.LOOM_PORT || "4398";

const { PtyHost } = await import("../dist/pty/host.js");
const { getCachedClaudeVersion, prewarmClaudeVersionAsync } = await import("../dist/orchestration/usage-status.js");
const { meetsMinVersion } = await import("../dist/pty/session-name.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// 0) Confirm the installed claude actually clears the version gate — else this probe can't show anything
// (the gate would omit -n and this would just re-prove today's behavior). Uses the REAL async prewarm
// (production path), not an override, so this also doubles as a live check of that prewarm.
prewarmClaudeVersionAsync();
for (let i = 0; i < 40 && getCachedClaudeVersion() === null; i++) await sleep(100); // up to ~4s
const installedVersion = getCachedClaudeVersion();
console.log(`[probe] installed claude version (cached): ${installedVersion}`);
check("0) claude version resolved (prewarm succeeded)", installedVersion !== null);
check("0) installed version clears the session-naming gate (>= 2.1.196)", meetsMinVersion(installedVersion));
if (!meetsMinVersion(installedVersion)) {
  console.log("\n⚠️  installed claude is below the session-naming gate — this probe would only re-prove the OFF path. Upgrade claude to run the ON-path proof.");
  process.exit(1);
}

const host = new PtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });

const cwd = process.cwd();
const SESSION_NAME = "loom-probe-realspawn-name";
const SID = "probe-session-name";

let out = "";
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[\]P^_].*?(?:\x07|\x1b\\)/g, "").replace(/\s+/g, "");
const tail = () => out.slice(-2000).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "·esc·").replace(/\s+/g, " ");

console.log(`[probe] spawning real claude in ${cwd} (LOOM_HOME=${tmpHome}) with -n ${SESSION_NAME}`);
host.spawn({
  sessionId: SID, cwd,
  permission: { mode: "acceptEdits", allow: ["mcp__loom-tasks"], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  sessionName: SESSION_NAME, // the thing under test — createPty's version gate should let this through
});
host.subscribe(SID, { onData: (b) => { out += b.toString("utf8"); }, onControl: () => {} });

try {
  // 1) The pty must still boot unattended — the load-bearing part: an unsupported/rejected flag would
  // make claude exit immediately or hang on an error screen instead of reaching a normal idle prompt.
  await sleep(9000);
  host.deliverHook(SID, { hook_event_name: "SessionStart" });
  await sleep(2000);
  console.log(`[probe] post-boot tail: ${tail()}`);
  check("1) the pty is still alive after boot (an unsupported -n would have exited it)", host.isAlive(SID));

  // 2) The name is OBSERVABLE somewhere in the rendered terminal output (prompt box / title), per the
  // documented -n behavior — the definitive "it actually landed" proof, not just "the process didn't die".
  const nameLanded = plain(out).includes(SESSION_NAME.replace(/-/g, "")) || out.includes(SESSION_NAME);
  check("2) the composed session name is visible in the rendered terminal output", nameLanded);
  if (!nameLanded) console.log(`[probe] FULL de-ANSI'd output for inspection:\n${plain(out)}`);

  // 3) Sanity: the session can still take a normal turn (never blocks on the name flag / any permission
  // gate) — types a trivial prompt and confirms it's echoed, mirroring the composer-dirty probe's check.
  host.writeStdin(SID, "say ok");
  await sleep(1200);
  check("3) still interactive after a named boot (typed text is echoed)", plain(out).includes("sayok"));
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  await sleep(800);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ PROBE PASS — a REAL claude process booted unattended with -n <name>, the name is observable in the rendered terminal, and the session stayed interactive."
  : `\n❌ PROBE: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
