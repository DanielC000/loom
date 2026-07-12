// REAL-CLAUDE STANDALONE PROBE, part 2 (task: pasted-text-attachment-survives-restart) — the ONE
// scenario part 1 (_probe-paste-resume.mjs) did NOT cover: a large bracketed paste sitting UNSUBMITTED
// in the live composer (no Enter yet) at the moment the process is killed (simulating a daemon restart
// hitting mid-compose, e.g. the human pasted a follow-up while the agent was still busy on a prior turn
// and never got to press Enter before the restart). Does `--resume` reconstruct anything at all, and if
// the human then re-asks about it, does the model report an unresolvable reference or just say it never
// received it? NOT hermetic CI — needs a logged-in `claude`.
//
// RUN: `pnpm build` (repo root) then `node test/_probe-paste-stranded-resume.mjs` from packages/daemon.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4400;
const tmpHome = path.join(os.tmpdir(), `loom-strandprobe-home-${Date.now()}-${process.pid}`);
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
  onEngineSessionId(id, eng) { engineIds.set(id, eng); console.log(`[probe] engineSessionId ${id} -> ${eng}`); },
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
          if (ev === "Stop" || ev === "StopFailure") stoppedTurns.set(b.sessionId, (stoppedTurns.get(b.sessionId) || 0) + 1);
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

const repo = path.join(os.tmpdir(), `loom-strandprobe-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# probe\n");
execSync(`git init -q && git add . && git -c user.email=p@p -c user.name=p commit -q -m init`, { cwd: repo });

const captures = new Map();
const cap = (id) => { let c = captures.get(id); if (!c) { c = { raw: "" }; captures.set(id, c); } return c; };
const tail = (id, n = 2000) => stripAnsi(cap(id).raw).slice(-n).replace(/\n{2,}/g, "\n");

const SID = "probe-strand";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

const PASTE_LINES = Array.from({ length: 600 }, (_, i) => `payload line ${i} - lorem ipsum dolor sit amet consectetur`);
PASTE_LINES.push("STRAND_TAIL_MARKER_X9K2");
const PASTE_TEXT = PASTE_LINES.join("\n");

async function waitForStop(id, sinceCount, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((stoppedTurns.get(id) || 0) > sinceCount) return true;
    await sleep(250);
  }
  return false;
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

  console.log("[probe] === paste the big block, DELIBERATELY never press Enter ===");
  host.writeStdin(SID, BRACKET_PASTE_START + PASTE_TEXT + BRACKET_PASTE_END);
  await sleep(2500);
  const strandedTail = tail(SID, 800);
  console.log(`[probe] composer tail with the paste STRANDED (no Enter sent):\n${strandedTail}`);
  assert("composer shows the collapsed placeholder before any Enter", /\[Pasted ?text #1/i.test(strandedTail.replace(/\s+/g, " ")));

  console.log("[probe] === hard-kill NOW, mid-compose (simulates a daemon restart hitting an unsubmitted paste) ===");
  host.stop(SID, "hard");
  await sleep(1500);

  // Does the engine transcript even exist yet? (No turn was ever submitted for this session.)
  const { engineTranscriptExists } = await import("../dist/sessions/transcript.js");
  const existsBefore = engineTranscriptExists ? engineTranscriptExists(repo, engineId) : "n/a (helper not exported)";
  console.log(`[probe] engine transcript exists pre-resume: ${existsBefore}`);

  console.log("[probe] === resume a FRESH process against the same engine session id ===");
  cap(SID).raw = "";
  stoppedTurns.set(SID, 0);
  host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv, resumeId: engineId });
  host.subscribe(SID, { onData: (b) => { cap(SID).raw += b.toString("utf8"); }, onControl() {} });
  await sleep(9000);
  const postResumeTail = tail(SID, 2000);
  console.log(`[probe] post-resume-boot tail (does the stranded paste show up at all?):\n${postResumeTail}`);
  const strandedSurvivedVerbatim = postResumeTail.includes("STRAND_TAIL_MARKER_X9K2");
  const strandedShowsBarePlaceholder = /\[Pasted ?text #1/i.test(postResumeTail.replace(/\s+/g, " "));
  assert("stranded paste's REAL content reappears in the resumed composer/history", strandedSurvivedVerbatim);
  assert("stranded paste reappears ONLY as a bare placeholder (the reported bug)", strandedShowsBarePlaceholder && !strandedSurvivedVerbatim);

  console.log("[probe] === ask the resumed agent directly whether it ever saw that paste ===");
  const before = stoppedTurns.get(SID) || 0;
  host.enqueueStdin(SID, "Right before this message, did you receive any pasted block of text from me that's still sitting unanswered? If you see a reference like \"[Pasted text #1]\" with no actual content, say UNRESOLVED_PLACEHOLDER. If you see the real content, quote its last line. If you never received anything at all, say NOTHING_RECEIVED.");
  const completed = await waitForStop(SID, before, 30000);
  await sleep(500);
  const askTail = tail(SID, 3000);
  console.log(`[probe] completed=${completed}; ask-tail:\n${askTail}`);
  console.log(`[probe] contains UNRESOLVED_PLACEHOLDER=${askTail.includes("UNRESOLVED_PLACEHOLDER")} NOTHING_RECEIVED=${askTail.includes("NOTHING_RECEIVED")} STRAND_TAIL_MARKER=${askTail.includes("STRAND_TAIL_MARKER_X9K2")}`);

  const turns = readTranscript(repo, engineIds.get(SID) ?? engineId);
  const userTurns = turns.filter((t) => t.role === "user");
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
