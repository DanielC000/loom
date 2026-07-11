// REAL-CLAUDE STANDALONE PROBE follow-up (card ee082fbb, part 2) — round 1 (_probe-composer-clear.mjs)
// found the multi-line stray paste COLLAPSES into a "[Pasted text #N +K lines]" placeholder token, and
// that CTRLU / BKSP_EXACT both cleared it (ESC does NOT — it arms a "press again to clear" confirm and
// leaves the placeholder intact on a single press; combined with another key afterward it left the
// composer in a WORSE, unpredictable state). This round checks the case round 1 didn't cover: a SHORT
// paste that stays BELOW whatever length/line threshold triggers the placeholder collapse, so it may
// render as literal multi-line text in the box instead — where Ctrl-U's readline semantics (kill to the
// START OF THE CURRENT LINE only) could plausibly strand EARLIER lines while BKSP_EXACT (char-exact
// backspacing) should not.
//
// RUN: `pnpm build` (repo root) then `node test/_probe-composer-clear-2.mjs` from packages/daemon.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4398;
const tmpHome = path.join(os.tmpdir(), `loom-clearprobe2-home-${Date.now()}-${process.pid}`);
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
  onEngineSessionId(id, eng) { engineIds.set(id, eng); console.log(`[probe2] engineSessionId ${id} -> ${eng}`); },
  onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit(id, code) { console.log(`[probe2] onExit ${id} code=${code}`); },
};
const host = new PtyHost(events);

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
console.log(`[probe2] hook server on 127.0.0.1:${PORT}`);

const repo = path.join(os.tmpdir(), `loom-clearprobe2-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# probe\n");
execSync(`git init -q && git add . && git -c user.email=p@p -c user.name=p commit -q -m init`, { cwd: repo });

const captures = new Map();
const cap = (id) => { let c = captures.get(id); if (!c) { c = { raw: "" }; captures.set(id, c); } return c; };
const tail = (id, n = 2000) => stripAnsi(cap(id).raw).slice(-n).replace(/\n{2,}/g, "\n");

const SID = "probe-clear2";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv });
host.subscribe(SID, { onData: (b) => { cap(SID).raw += b.toString("utf8"); }, onControl() {} });

const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";
const BACKSPACE = "\x7f";
const CTRL_U = "\x15";

// SHORT two-line stray (well under any placeholder-collapse threshold — testing the "rendered literally,
// not collapsed" case round 1 didn't cover).
const SHORT_STRAY = ["hey - quick redirect on card ee082fbb", "check StrayMarkerTOKEN before you land it"].join("\n");

// SHORT single-line stray (the simplest case: no paste markers needed at all in real usage, but submit()
// always wraps in bracket-paste — check it doesn't get treated any differently).
const SINGLE_LINE_STRAY = "quick nudge - check StraySingleLineTOKEN before you continue";

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
  console.log(`[probe2] ${cond ? "PASS" : "FAIL"}  ${label}${extra ? `\n    ${extra}` : ""}`);
};

async function runTrial(name, strayText, strayToken, clearBytesFn) {
  console.log(`\n[probe2] ===== TRIAL ${name} =====`);
  cap(SID).raw = "";
  host.writeStdin(SID, BRACKET_PASTE_START + strayText + BRACKET_PASTE_END);
  await sleep(1500);
  console.log(`[probe2] ${name} after stray paste, tail:\n${tail(SID, 1200)}`);

  const clearBytes = clearBytesFn(strayText);
  host.writeStdin(SID, clearBytes);
  await sleep(1200);
  console.log(`[probe2] ${name} after candidate clear, tail:\n${tail(SID, 1200)}`);

  const marker = `CLEARTEST2_${name}_OK - reply with just the word ACK.`;
  host.writeStdin(SID, marker);
  await sleep(600);
  console.log(`[probe2] ${name} after typing marker, tail:\n${tail(SID, 1500)}`);
  const before = stoppedTurns.get(SID) || 0;
  host.writeStdin(SID, "\r");
  const completed = await waitForStop(SID, before, 30000);
  await sleep(500);

  const eng = engineIds.get(SID);
  const turns = eng ? readTranscript(repo, eng) : [];
  const userTurns = turns.filter((t) => t.role === "user");
  const last = userTurns.at(-1);
  console.log(`[probe2] ${name} turn completed=${completed}; engine-recorded LAST user turn:\n---\n${last?.text}\n---`);

  const clean =
    !!last &&
    last.text.includes(`CLEARTEST2_${name}_OK`) &&
    !last.text.includes(strayToken);
  assert(`${name}: engine-recorded submission is the marker ONLY, no stray remnant`, clean, `text=${JSON.stringify(last?.text)}`);
  return clean;
}

try {
  console.log("[probe2] spawning real claude…");
  await sleep(10000);
  if (!engineIds.get(SID)) { console.log("[probe2] waiting extra for SessionStart hook…"); await sleep(4000); }
  assert("engine session id captured", !!engineIds.get(SID));

  await runTrial("SHORT_2LINE_CTRLU", SHORT_STRAY, "StrayMarkerTOKEN", () => CTRL_U);
  await runTrial("SHORT_2LINE_BKSP", SHORT_STRAY, "StrayMarkerTOKEN", (t) => BACKSPACE.repeat(t.length));
  await runTrial("SINGLE_LINE_CTRLU", SINGLE_LINE_STRAY, "StraySingleLineTOKEN", () => CTRL_U);
  await runTrial("SINGLE_LINE_BKSP", SINGLE_LINE_STRAY, "StraySingleLineTOKEN", (t) => BACKSPACE.repeat(t.length));

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[probe2] ${passed}/${results.length} assertions passed.`);
  results.forEach((r) => console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.label}`));
} finally {
  console.log("[probe2] cleanup…");
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
  console.log("[probe2] done.");
  setTimeout(() => process.exit(0), 500);
}
