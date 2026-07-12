// REAL-CLAUDE STANDALONE PROBE (task: pasted-text-attachment-survives-restart) — establish EXACTLY what
// the engine persists to its own transcript JSONL for a submitted turn containing a large bracketed
// paste, and whether a `--resume` of that same engine session id can still resolve the pasted content
// or only sees the collapsed "[Pasted text #N]" placeholder. NOT hermetic CI — needs a logged-in `claude`.
//
// RUN: `pnpm build` (repo root) then `node test/_probe-paste-resume.mjs` from packages/daemon.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4399;
const tmpHome = path.join(os.tmpdir(), `loom-pasteprobe-home-${Date.now()}-${process.pid}`);
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

const repo = path.join(os.tmpdir(), `loom-pasteprobe-repo-${Date.now()}-${process.pid}`);
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

const SID = "probe-paste";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

// A big multi-line paste, well past claude's collapse threshold. The tail marker is what we quiz the
// model about, both live and post-resume.
const PASTE_LINES = Array.from({ length: 600 }, (_, i) => `payload line ${i} - lorem ipsum dolor sit amet consectetur`);
PASTE_LINES.push("PASTE_TAIL_MARKER_Q7F3");
const PASTE_TEXT = PASTE_LINES.join("\n");

async function waitForStop(id, sinceCount, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((stoppedTurns.get(id) || 0) > sinceCount) return true;
    await sleep(250);
  }
  return false;
}

// Goes through the SAME production delivery path as a worker report / manager redirect / human Composer
// send (enqueueStdin -> submit -> writeChunked + bracket-paste + verified Enter) instead of hand-rolling
// bracket-paste bytes over raw writeStdin (which truncates a large blob under ConPTY, a DIFFERENT bug
// than the one this probe is investigating).
async function submitAndWait(id, text, timeoutMs = 45000) {
  const before = stoppedTurns.get(id) || 0;
  host.enqueueStdin(id, text);
  const completed = await waitForStop(id, before, timeoutMs);
  await sleep(500);
  return completed;
}

// Mimics a REAL human paste directly into the raw xterm terminal: the gateway forwards ONE ws "stdin"
// message per browser paste event straight to host.writeStdin (server.ts: `msg.type === "stdin"`), i.e.
// ONE call carrying the WHOLE bracketed blob — NOT hand-chunked application-side. Enter is a distinct
// keystroke the human presses after the paste lands, so it's a separate write.
async function rawPasteAndEnter(id, text, timeoutMs = 45000) {
  const before = stoppedTurns.get(id) || 0;
  host.writeStdin(id, BRACKET_PASTE_START + text + BRACKET_PASTE_END);
  await sleep(1200);
  host.writeStdin(id, "\r");
  const completed = await waitForStop(id, before, timeoutMs);
  await sleep(500);
  return completed;
}

const results = [];
const assert = (label, cond, extra) => {
  results.push({ label, pass: !!cond });
  console.log(`[probe] ${cond ? "PASS" : "FAIL"}  ${label}${extra ? `\n    ${extra}` : ""}`);
};

try {
  console.log("[probe] spawning real claude…");
  host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv });
  host.subscribe(SID, { onData: (b) => { cap(SID).raw += b.toString("utf8"); }, onControl() {} });
  await sleep(10000);
  if (!engineIds.get(SID)) { console.log("[probe] waiting extra for SessionStart hook…"); await sleep(4000); }
  assert("engine session id captured", !!engineIds.get(SID));
  const engineId = engineIds.get(SID);

  console.log("[probe] === STEP 1: a REAL raw-terminal paste (bracketed, one ws-stdin-shaped write) + a typed question, in ONE live turn ===");
  const askAboutPaste = "What is the tail marker token at the end of the text I just pasted above? Reply with just the token, nothing else.";
  const before1 = stoppedTurns.get(SID) || 0;
  host.writeStdin(SID, BRACKET_PASTE_START + PASTE_TEXT + BRACKET_PASTE_END); // the paste event itself
  await sleep(2500); // let the TUI actually render the collapse before typing more
  console.log(`[probe] after raw paste (before typing the question), composer tail:\n${tail(SID, 800)}`);
  host.writeStdin(SID, askAboutPaste); // human types the question right after, as literal keystrokes
  await sleep(1000);
  // A lone \r right after a large paste can be dropped/land mid-ingest (host.ts documents this same
  // hazard for submit()'s own Enter, hence sendEnterAndVerify) — retry a plain human Enter a few times.
  let completed1 = false;
  for (let attempt = 0; attempt < 5 && !completed1; attempt++) {
    host.writeStdin(SID, "\r");
    completed1 = await waitForStop(SID, before1, 8000);
  }
  await sleep(500);
  console.log(`[probe] turn1 completed=${completed1}`);
  console.log(`[probe] post-turn1 tail:\n${tail(SID, 1500)}`);
  const liveAnswerOk = tail(SID, 3000).includes("PASTE_TAIL_MARKER_Q7F3");
  assert("LIVE turn: model can read back the pasted tail marker", liveAnswerOk);

  let turns = readTranscript(repo, engineId);
  let userTurns = turns.filter((t) => t.role === "user");
  const pasteTurn = userTurns.find((t) => t.text?.includes(askAboutPaste) || t.text?.includes("PASTE_TAIL_MARKER") || /Pasted text/i.test(t.text ?? ""));
  console.log(`[probe] transcript-recorded turn1 user text (first 500 chars):\n${(pasteTurn?.text ?? "<not found>").slice(0, 500)}`);
  const transcriptHasFullText = !!pasteTurn?.text?.includes("PASTE_TAIL_MARKER_Q7F3");
  const transcriptHasPlaceholder = /\[Pasted text #\d+/i.test(pasteTurn?.text ?? "");
  assert("transcript records the FULL pasted text (not just a placeholder)", transcriptHasFullText,
    `placeholderPresent=${transcriptHasPlaceholder}`);

  console.log("[probe] === STEP 2: hard-kill the pty (simulates a daemon restart) ===");
  host.stop(SID, "hard");
  await sleep(1500);

  console.log("[probe] === STEP 3: resume a FRESH process against the SAME engine session id ===");
  cap(SID).raw = "";
  stoppedTurns.set(SID, 0);
  host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv, resumeId: engineId });
  host.subscribe(SID, { onData: (b) => { cap(SID).raw += b.toString("utf8"); }, onControl() {} });
  await sleep(9000);
  console.log(`[probe] post-resume-boot tail:\n${tail(SID, 1500)}`);

  const askAgain = "Two messages ago I pasted a large block of text. What was the tail marker token at the end of it? Reply with just the token; if you genuinely cannot see the original pasted content anymore, reply with exactly NO_LONGER_RESOLVABLE instead of guessing.";
  const completed2 = await submitAndWait(SID, askAgain);
  console.log(`[probe] post-resume-question completed=${completed2}`);
  console.log(`[probe] post-resume-question tail:\n${tail(SID, 2500)}`);
  const resumedAnswerHasMarker = tail(SID, 4000).includes("PASTE_TAIL_MARKER_Q7F3");
  const resumedAnswerSaysUnresolvable = tail(SID, 4000).includes("NO_LONGER_RESOLVABLE");
  assert("RESUMED turn: model can STILL read back the pasted tail marker", resumedAnswerHasMarker,
    `saysUnresolvable=${resumedAnswerSaysUnresolvable}`);

  const engineIdAfterResume = engineIds.get(SID);
  turns = readTranscript(repo, engineIdAfterResume ?? engineId);
  userTurns = turns.filter((t) => t.role === "user");
  console.log(`[probe] full transcript user-turn texts (first 200 chars each):`);
  for (const t of userTurns) console.log(`  - ${JSON.stringify((t.text ?? "").slice(0, 200))}`);

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
