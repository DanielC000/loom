// REAL-CLAUDE STANDALONE PROBE (bug: companion/system-injected pastes collapse to a bare
// "[Pasted text #N]" placeholder — task 16c50cdd). Unlike `_probe-paste-resume.mjs` (which hand-writes
// BRACKET_PASTE_START + text + BRACKET_PASTE_END as ONE raw `host.writeStdin` call to mimic a human
// pasting into the raw xterm terminal), THIS probe drives the REAL companion/system delivery path —
// `host.enqueueStdin` -> `submit()` -> `writeChunked()` — which is what chat-gateway.ts's `submitTurn`
// actually calls. That path writes BRACKET_PASTE_START and BRACKET_PASTE_END as their OWN, ISOLATED
// `pty.write()` calls around the (possibly chunked) text — a different byte-delivery shape than the
// raw-terminal path the old probe validated. This probe checks the REAL engine transcript to see
// whether the submitted turn recorded the full pasted text or just the collapsed placeholder, for BOTH
// a small paste (single chunk, well under PTY_WRITE_CHUNK_BYTES=1024) and a large paste (multi-chunk,
// forces writeChunked's paced multi-write path) — the small/large split matters because a fix that only
// coalesces a single-chunk write wouldn't prove anything about the multi-chunk case.
//
// NOT hermetic CI — needs a logged-in `claude`. RUN: `pnpm build` (repo root) then
// `node test/_probe-paste-companion.mjs` from packages/daemon.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4401;
const tmpHome = path.join(os.tmpdir(), `loom-pastecompanion-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(PORT);

const { PtyHost } = await import("../dist/pty/host.js");
const { readTranscript } = await import("../dist/sessions/transcript.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) =>
  s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1B[()][0-9A-Za-z]/g, "").replace(/\x1B[=>]/g, "");

const engineIds = new Map();
const stoppedTurns = new Map();
const events = {
  onEngineSessionId(id, eng) {
    engineIds.set(id, eng);
    console.log(`[probe] engineSessionId ${id} -> ${eng}`);
  },
  onBusy() {},
  onContextStats() {},
  onRateLimited() {},
  onExit(id, code) { console.log(`[probe] onExit ${id} code=${code}`); },
};
let host = new PtyHost(events);

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/internal/hook") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const b = JSON.parse(body);
        if (b?.sessionId && b.hook) {
          const ev = b.hook.hook_event_name;
          if (ev === "Stop" || ev === "StopFailure") {
            stoppedTurns.set(b.sessionId, (stoppedTurns.get(b.sessionId) || 0) + 1);
          }
          host.deliverHook(b.sessionId, b.hook);
        }
      } catch { /* ignore */ }
      res.end('{"ok":true}');
    });
    return;
  }
  res.statusCode = 404;
  res.end("nope");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`[probe] hook server on 127.0.0.1:${PORT}`);

const repo = path.join(os.tmpdir(), `loom-pastecompanion-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# probe\n");
execSync(`git init -q && git add . && git -c user.email=p@p -c user.name=p commit -q -m init`, { cwd: repo });

const captures = new Map();
const cap = (id) => {
  let c = captures.get(id);
  if (!c) { c = { raw: "" }; captures.set(id, c); }
  return c;
};
const tail = (id, n = 2000) => stripAnsi(cap(id).raw).slice(-n).replace(/\n{2,}/g, "\n");

const SID = "probe-paste-companion";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

// SMALL paste: a handful of lines, well under PTY_WRITE_CHUNK_BYTES (1024) — writeChunked's text write
// is a SINGLE pty.write, matching the real production failure (session 5db71873's "+3 lines" pastes).
const SMALL_LINES = ["small companion paste line 1", "small companion paste line 2", "small companion paste line 3"];
SMALL_LINES.push("SMALL_TAIL_MARKER_A1B2C3");
const SMALL_TEXT = SMALL_LINES.join("\n");

// LARGE paste: intentionally past PTY_WRITE_CHUNK_BYTES so writeChunked splits the text itself across
// MULTIPLE paced pty.write calls (8ms apart) between the (isolated, pre-fix) START/END writes.
const LARGE_LINES = Array.from({ length: 400 }, (_, i) => `payload line ${i} - lorem ipsum dolor sit amet consectetur adipiscing elit`);
LARGE_LINES.push("LARGE_TAIL_MARKER_D4E5F6");
const LARGE_TEXT = LARGE_LINES.join("\n");
console.log(`[probe] SMALL_TEXT length=${SMALL_TEXT.length} bytes, LARGE_TEXT length=${LARGE_TEXT.length} bytes`);

async function waitForStop(id, sinceCount, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((stoppedTurns.get(id) || 0) > sinceCount) return true;
    await sleep(250);
  }
  return false;
}

// The REAL companion/system delivery path: chat-gateway.ts's submitTurn calls exactly this.
async function submitAndWait(id, text, timeoutMs = 60000) {
  const before = stoppedTurns.get(id) || 0;
  host.enqueueStdin(id, text);
  const completed = await waitForStop(id, before, timeoutMs);
  await sleep(500);
  return completed;
}

const results = [];
const assert = (label, cond, extra) => {
  results.push({ label, pass: !!cond });
  console.log(`[probe] ${cond ? "PASS" : "FAIL"}  ${label}${extra ? `\n    ${extra}` : ""}`);
};

async function testPasteViaCompanionPath(engineIdGetter, label, text, marker) {
  console.log(`[probe] === ${label}: enqueueStdin (companion path) with ${text.length}-byte paste ===`);
  const completed = await submitAndWait(SID, text);
  console.log(`[probe] ${label} completed=${completed}`);
  console.log(`[probe] ${label} post-turn tail:\n${tail(SID, 1200)}`);

  const engineId = engineIdGetter();
  const turns = readTranscript(repo, engineId);
  const userTurns = turns.filter((t) => t.role === "user");
  const lastUserTurn = userTurns[userTurns.length - 1];
  const recordedText = lastUserTurn?.text ?? "<none>";
  const transcriptHasFullText = recordedText.includes(marker);
  const transcriptIsBarePlaceholder = /^\[Pasted text #\d+[^\]]*\]$/.test(recordedText.trim());
  console.log(`[probe] ${label} last recorded user-turn text (first 300 chars): ${JSON.stringify(recordedText.slice(0, 300))}`);
  assert(`${label}: transcript records the FULL pasted text (marker present)`, transcriptHasFullText,
    `barePlaceholder=${transcriptIsBarePlaceholder} recordedLength=${recordedText.length}`);

  // Belt-and-suspenders: ask the model to recall the marker in a follow-up turn.
  const askQuestion = `What is the tail marker token at the end of the text I just pasted in my previous message? Reply with just the token, nothing else. If you cannot see the pasted content, reply with exactly CANNOT_SEE_PASTE instead of guessing.`;
  await submitAndWait(SID, askQuestion);
  const modelSawIt = tail(SID, 3000).includes(marker);
  const modelSaysCannot = tail(SID, 3000).includes("CANNOT_SEE_PASTE");
  console.log(`[probe] ${label} post-question tail:\n${tail(SID, 1500)}`);
  assert(`${label}: model can read back the pasted tail marker`, modelSawIt, `saysCannotSee=${modelSaysCannot}`);

  return { transcriptHasFullText, modelSawIt, recordedText };
}

// Companion messages that arrive while the session is BUSY don't go through enqueueStdin's immediate-
// submit path — they sit in `live.pending` and get drained by `drainPending`, called SYNCHRONOUSLY
// within the Stop-hook handler for the turn that was in flight (host.ts's M2 invariant: no `await`
// between setBusy(false) and drainPending). That is a much TIGHTER timing window relative to the CLI's
// own Stop than a caller that waits out `waitForStop` + an extra settle sleep before enqueuing (which is
// what `testPasteViaCompanionPath` above does, and it passed for both small and large). This variant
// reproduces that tighter timing: fire a short turn, and WHILE it's still busy, enqueue the paste so it
// is forced onto the drainPending path instead of the immediate-submit path.
async function testPasteViaDrainPendingPath(engineIdGetter, label, text, marker) {
  console.log(`[probe] === ${label} (queued-while-busy / drainPending path) ===`);
  const beforeCount = stoppedTurns.get(SID) || 0;
  host.enqueueStdin(SID, "Reply with exactly the single word BUSY_TURN_ACK and nothing else.");
  const enq = host.enqueueStdin(SID, text);
  console.log(`[probe] ${label} paste enqueue result while busy: ${JSON.stringify(enq)}`);
  assert(`${label}: paste was actually queued (not immediate-submitted)`, enq.delivered === false);

  const gotFirstStop = await waitForStop(SID, beforeCount, 30000);
  const afterFirst = stoppedTurns.get(SID) || 0;
  console.log(`[probe] ${label} busy-ack turn stopped=${gotFirstStop} (count now ${afterFirst})`);
  const gotSecondStop = await waitForStop(SID, afterFirst, 60000);
  await sleep(500);
  console.log(`[probe] ${label} drained paste turn stopped=${gotSecondStop}`);
  console.log(`[probe] ${label} post-turn tail:\n${tail(SID, 1500)}`);

  const engineId = engineIdGetter();
  const turns = readTranscript(repo, engineId);
  const userTurns = turns.filter((t) => t.role === "user");
  const lastUserTurn = userTurns[userTurns.length - 1];
  const recordedText = lastUserTurn?.text ?? "<none>";
  const transcriptHasFullText = recordedText.includes(marker);
  const transcriptIsBarePlaceholder = /^\[Pasted text #\d+[^\]]*\]$/.test(recordedText.trim());
  console.log(`[probe] ${label} last recorded user-turn text (first 300 chars): ${JSON.stringify(recordedText.slice(0, 300))}`);
  assert(`${label}: drainPending-delivered transcript records the FULL pasted text`, transcriptHasFullText,
    `barePlaceholder=${transcriptIsBarePlaceholder} recordedLength=${recordedText.length}`);

  return { transcriptHasFullText, recordedText };
}

try {
  console.log("[probe] spawning real claude…");
  host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv });
  host.subscribe(SID, { onData: (b) => { cap(SID).raw += b.toString("utf8"); }, onControl() {} });
  await sleep(10000);
  if (!engineIds.get(SID)) { console.log("[probe] waiting extra for SessionStart hook…"); await sleep(4000); }
  assert("engine session id captured", !!engineIds.get(SID));

  await testPasteViaCompanionPath(() => engineIds.get(SID), "SMALL", SMALL_TEXT, "SMALL_TAIL_MARKER_A1B2C3");
  await testPasteViaCompanionPath(() => engineIds.get(SID), "LARGE", LARGE_TEXT, "LARGE_TAIL_MARKER_D4E5F6");
  await testPasteViaDrainPendingPath(() => engineIds.get(SID), "QUEUED-SMALL", SMALL_TEXT, "SMALL_TAIL_MARKER_A1B2C3");
  await testPasteViaDrainPendingPath(() => engineIds.get(SID), "QUEUED-LARGE", LARGE_TEXT, "LARGE_TAIL_MARKER_D4E5F6");

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[probe] ${passed}/${results.length} assertions passed.`);
  results.forEach((r) => console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.label}`));
} finally {
  console.log("[probe] cleanup…");
  try { host.stop(SID, "hard"); } catch { /* ignore */ }
  await sleep(1500);
  try { server.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    const enc = path.resolve(repo).replace(/[^a-zA-Z0-9]/g, "-");
    const projDir = path.join(os.homedir(), ".claude", "projects", enc);
    fs.rmSync(projDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log("[probe] done.");
  setTimeout(() => process.exit(0), 500);
}
