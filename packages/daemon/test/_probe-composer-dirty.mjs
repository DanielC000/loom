// MANUAL PROBE (not in the hermetic suite) — drives a REAL `claude` TUI to empirically confirm the
// composer-dirty delivery hold end-to-end. Spawns via the CLAUDE.md recipe (PtyHost.createPty), in an
// isolated temp LOOM_HOME. No daemon needed: we mark readiness by calling deliverHook(SessionStart)
// directly. MCP/hook relay point at a dead port (harmless — the TUI composer still works).
//
//   node test/_probe-composer-dirty.mjs    (after a build; requires a logged-in `claude`)
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = path.join(os.tmpdir(), `loom-dirtyprobe-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = process.env.LOOM_PORT || "4399";

const { PtyHost } = await import("../dist/pty/host.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = new PtyHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });

const SID = "probe-dirty";
const HALF = "the quick brown fox";          // the human's half-typed raw draft
const REPORT = "PROGRAMMATIC_WORKER_REPORT_XYZZY"; // the queued turn that must NOT concatenate

// Capture everything the real claude TUI emits.
let out = "";
const tail = () => out.slice(-1500).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "·esc·").replace(/\s+/g, " ");
// De-ANSI'd, whitespace-stripped view — the TUI interleaves cursor escapes BETWEEN typed chars
// ("the·esc·quick·esc·brown") so a raw substring check misses echoed text; strip escapes + spaces first.
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[\]P^_].*?(?:\x07|\x1b\\)/g, "").replace(/\s+/g, "");

const cwd = process.cwd();
console.log(`[probe] spawning real claude in ${cwd} (LOOM_HOME=${tmpHome})`);
host.spawn({
  sessionId: SID, cwd,
  permission: { mode: "acceptEdits", allow: ["mcp__loom-tasks"], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
});
// Subscribe AFTER spawn (the live session must exist) — replays the boot ring, then streams live.
host.subscribe(SID, { onData: (b) => { out += b.toString("utf8"); }, onControl: () => {} });

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

try {
  // Let the real TUI boot, then mark ready ourselves (stand-in for the SessionStart hook relay).
  await sleep(9000);
  host.deliverHook(SID, { hook_event_name: "SessionStart" });
  await sleep(1500);
  console.log(`[probe] post-boot tail: ${tail()}`);

  // 1) Human types a half-line into the RAW terminal composer.
  host.writeStdin(SID, HALF);
  await sleep(1200);
  const afterTyping = out.length;
  const composerShowsHalf = plain(out).includes("quickbrownfox"); // de-ANSI'd: the typed text is echoed
  check("1) the half-line is echoed in the live composer", composerShowsHalf);

  // 2) A programmatic turn is enqueued while the composer is dirty → MUST be HELD (not written).
  const r = host.enqueueStdin(SID, REPORT);
  check("2) enqueue while dirty returns HELD (delivered:false, queued)", r.delivered === false && r.position === 1);
  await sleep(1500);
  const reportAbsentWhileHeld = !out.slice(afterTyping).includes("PROGRAMMATIC_WORKER_REPORT");
  check("2) the report text NEVER reached the TUI while the draft was open (no concatenation)", reportAbsentWhileHeld);
  console.log(`[probe] held tail: ${tail()}`);

  // 3) Human presses Enter → their own line submits; then the held turn drains cleanly onto the empty box.
  const beforeEnter = out.length;
  host.writeStdin(SID, "\r");
  // Give claude time to submit the human line, then for the held report to drain + paste + submit.
  await sleep(4000);
  const afterEnter = out.slice(beforeEnter);
  check("3) the held report DELIVERED after the box was freed", afterEnter.includes("PROGRAMMATIC_WORKER_REPORT") || out.includes("PROGRAMMATIC_WORKER_REPORT"));
  check("3) the queue is now empty (held turn drained, not stranded)", host.getPending(SID).length === 0);
  console.log(`[probe] post-Enter tail: ${tail()}`);
} finally {
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  await sleep(800);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\n✅ PROBE PASS — real claude: held while dirty, delivered cleanly after the box was freed." : `\n❌ PROBE: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
