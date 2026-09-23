import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6654a47c — hermetic coverage for the `give-up screen tail:` line `PtyHost#captureCodexEngineSessionId`
// logs when engine-session-id discovery gives up: ANSI-stripped, single-line, capped tail of the session's
// own ring, routed through `redactedExcerpt` (raw only under LOOM_LOG_MESSAGE_CONTENT=1) plus allowlisted
// marker LABELS (a hint, not a verdict). Drives the REAL host give-up path with a fake pty.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-giveup-screen-tail.mjs
process.env.LOOM_CODEX_ENGINE_ID_RETRY_MS = "20";
process.env.LOOM_CODEX_ENGINE_ID_MAX_ATTEMPTS = "2";
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond, diag) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diag) console.log(`      ${diag}`); }
};

process.env.LOOM_HOME = mkdtempManaged("loom-codex-tail-loomhome-");
const { PtyHost } = await import("../dist/pty/host.js");
const { ensureDirs } = await import("../dist/paths.js");
ensureDirs();
const { describeCodexScreenTail, CODEX_SCREEN_TAIL_MAX_CHARS } = await import("../dist/pty/codex-host.js");

const READY = "> Ask Codex to do anything";
function makeFakePty() {
  let onDataCb = null;
  let onExitCb = null;
  return {
    pid: 5152,
    write() {},
    onData(cb) { onDataCb = cb; return { dispose() { onDataCb = null; } }; },
    onExit(cb) { onExitCb = cb; return { dispose() { onExitCb = null; } }; },
    kill() { const cb = onExitCb; onExitCb = null; cb?.({ exitCode: 0 }); },
    resize() {},
    push(text) { onDataCb?.(text); },
  };
}
class FakeCodexHost extends PtyHost {
  constructor(events) { super(events); this.fakeCodexPtys = new Map(); }
  createCodexPty(opts) { const f = makeFakePty(); this.fakeCodexPtys.set(opts.sessionId, f); return f; }
}
const host = new FakeCodexHost({
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {},
});

// Empty sessions dir → rollout "none present"; the tail line is independent of that.
const home = mkdtempManaged("loom-codex-tail-home-");
fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
process.env.CODEX_HOME = home;

/** Spawn, push `chunks` (with READY first unless `noReady`), wait for the real give-up, return the tail line. */
async function giveUp(sessionId, chunks, { noReady = false } = {}) {
  const lines = [];
  const origWarn = console.warn;
  console.warn = (...a) => { lines.push(a.join(" ")); };
  try {
    const cwd = mkdtempManaged("loom-codex-tail-cwd-");
    host.spawn({ sessionId, cwd, permission: {}, geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role: "worker", harness: "codex" });
    const fake = host.fakeCodexPtys.get(sessionId);
    if (!noReady) fake.push(`codex TUI booted\n${READY}\n`);
    for (const c of chunks) fake.push(c);
    await waitUntil(() => host.liveCodex.get(sessionId)?.engineSessionIdCaptureEndReason === "exhausted", { label: `${sessionId} exhausts` });
    await waitUntil(() => lines.some((l) => l.includes("give-up screen tail")), { label: `${sessionId} tail logged` });
  } finally { console.warn = origWarn; }
  return lines.find((l) => l.includes("give-up screen tail"));
}

const SECRET = "ZQX-SECRET-PROMPT-BODY-7741";
const esc = "\u001b";
const screenChunk = `${esc}[1;32m• Starting${esc}[1C${"MCP"}${esc}[1Cservers (1/2)${esc}[0m\r\n${esc}[2K${SECRET} echoed prompt\r\nWorking (3s • esc to interrupt)\r\n`;

// --- (1) flag OFF (default): no raw content, marker labels present, single line ---
delete process.env.LOOM_LOG_MESSAGE_CONTENT;
{
  const line = await giveUp("tail-off", [screenChunk]);
  check("(1) tail line is emitted", !!line, line);
  check("(1) flag OFF: the echoed prompt text does NOT appear", !!line && !line.includes(SECRET), line);
  check("(1) flag OFF: tail is redacted (len+hash shape)", !!line && /tail=<redacted len=\d+ hash=/.test(line), line);
  check("(1) markers name codex chrome phrases (starting-mcp-servers, esc-to-interrupt, ready-placeholder)",
    !!line && /markers=\[[^\]]*starting-mcp-servers[^\]]*\]/.test(line) && line.includes("esc-to-interrupt") && line.includes("ready-placeholder"), line);
  check("(1) single line, no ESC bytes", !!line && !/[\r\n\u001b]/.test(line), line);
}

// --- (2) flag ON: raw tail, ANSI-stripped, CSI cursor-forward turned into spaces ---
process.env.LOOM_LOG_MESSAGE_CONTENT = "1";
{
  const line = await giveUp("tail-on", [screenChunk]);
  check("(2) flag ON: raw tail is present", !!line && line.includes(SECRET), line);
  check("(2) flag ON: ANSI stripped + cursor-forward became a space ('Starting MCP servers')", !!line && line.includes("Starting MCP servers (1/2)"), line);
  check("(2) flag ON: single line, no ESC bytes", !!line && !/[\r\n\u001b]/.test(line), line);
}
delete process.env.LOOM_LOG_MESSAGE_CONTENT;

// --- (3) empty ring: capture only starts at the ready marker, so the host path can never reach give-up with an
// empty ring; the pure helper must still be total (the host wraps it in try/catch either way). ---
{
  const { tail, markers } = describeCodexScreenTail("");
  check("(3) empty input: empty tail, no markers, no throw", tail === "" && markers.length === 0);
}

// --- (4) pure helper: cap + WHAT SURVIVES it (the TAIL, not the head) ---
{
  const long = "HEAD-MARKER " + "x".repeat(5000) + " esc to interrupt END-OF-TAIL";
  const { tail, markers } = describeCodexScreenTail(long);
  check(`(4) tail capped at ${CODEX_SCREEN_TAIL_MAX_CHARS}`, tail.length <= CODEX_SCREEN_TAIL_MAX_CHARS, `len=${tail.length}`);
  check("(4) what survives is the END of the screen (not the head)", tail.endsWith("END-OF-TAIL") && !tail.includes("HEAD-MARKER"), tail.slice(-40));
  check("(4) a marker inside the surviving tail is still labelled", markers.includes("esc-to-interrupt"), JSON.stringify(markers));
  // NEGATIVE CONTROL: a marker pushed out of the tail window by the cap is NOT labelled.
  const pushedOut = describeCodexScreenTail("update available " + "y".repeat(2000));
  check("(4) control: a phrase that fell outside the capped tail yields no label", !pushedOut.markers.includes("update-available"), JSON.stringify(pushedOut.markers));
  check("(4) control: bogus text yields no markers", describeCodexScreenTail("nothing to see here").markers.length === 0);
}

// --- (5) KNOWN LIMIT (documented, asserted): a marker label is a HINT, not proof of codex chrome ---
// A prompt that merely CONTAINS a marker phrase, with no codex chrome at all, still emits that label. Nobody
// should read a label as proof the screen showed that state (the tail includes the echoed prompt).
{
  const { markers } = describeCodexScreenTail(`user asked: please explain 'esc to interrupt' and 'update available' semantics`);
  check("(5) KNOWN LIMIT: prompt-only text containing marker phrases still emits their labels",
    markers.includes("esc-to-interrupt") && markers.includes("update-available"), JSON.stringify(markers));
  check("(5) generic words are NOT markers (error/auth/working/trust/approval alone)",
    describeCodexScreenTail("error auth working trust approval").markers.length === 0);
}

await finishAndExit(failures === 0 ? 0 : 1);
