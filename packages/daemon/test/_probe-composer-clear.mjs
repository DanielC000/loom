// REAL-CLAUDE STANDALONE PROBE (card ee082fbb, part 2) — establish whether a blind clear sequence can
// reliably empty claude's TUI composer after a MULTI-LINE bracketed-paste injection is stranded there —
// the `sendEnterAndVerify` give-up case in host.ts (submit()'s Enter never confirmed, text left un-
// submitted in the box). NOT a hermetic CI test — a manual, real-engine investigation (needs a logged-in
// `claude`).
//
// GROUND TRUTH is the ENGINE'S OWN transcript JSONL, not ANSI screen-scraping: after each candidate clear
// + a short marker turn, we read back the actual "user" message the engine recorded for that turn and
// check it is EXACTLY the marker — no stray remnant from the stranded paste concatenated in.
//
// Candidates tested (host.ts's give-up branch would write ONE of these, chosen by this probe's findings):
//   ESC            — nextComposerLen already treats a lone Esc as clearing the human's draft to empty
//                    (best-effort keystroke-tracking heuristic); this probe checks whether that heuristic
//                    also holds for the REAL TUI on a MULTI-LINE pasted composer, not just a typed line.
//   CTRLU          — kill-line (Ctrl-U, \x15) — readline semantics kill to the start of the CURRENT line
//                    only, which may leave earlier lines of a multi-line paste behind.
//   BKSP_EXACT     — exactly `text.length` backspaces (\x7f). Host.ts's `live.lastPrompt` already holds
//                    the exact injected text at give-up time, so this is available for free in production.
//                    Provably safe even if the TUI collapses a large paste into a "[Pasted text #N]"
//                    placeholder: the first backspace deletes the (shorter) placeholder atomically and the
//                    rest no-op (floored at 0, per nextComposerLen's own backspace semantics).
//   ESC_THEN_CTRLU — belt-and-suspenders combo, in case ESC alone leaves residue Ctrl-U can mop up.
//
// RUN: `pnpm build` (repo root) then `node test/_probe-composer-clear.mjs` from packages/daemon.
//      Override the binary with LOOM_CLAUDE_BIN; default is PATH-resolved "claude".
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4398;
const tmpHome = path.join(os.tmpdir(), `loom-clearprobe-home-${Date.now()}-${process.pid}`);
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
const host = new PtyHost(events);

// Minimal /internal/hook receiver (replicates gateway/server.ts) — the REAL claude process's own
// hook-relay.mjs posts here (see paths.ts PORT / claude-settings.ts), so engineSessionId and Stop/
// StopFailure are captured exactly like production, no ANSI inference needed.
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

// Throwaway temp git repo as the project cwd (claude needs a real project dir; transcript is keyed off it).
const repo = path.join(os.tmpdir(), `loom-clearprobe-repo-${Date.now()}-${process.pid}`);
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

const SID = "probe-clear";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv });
host.subscribe(SID, { onData: (b) => { cap(SID).raw += b.toString("utf8"); }, onControl() {} });

const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";
const ESC = "\x1b";
const BACKSPACE = "\x7f";
const CTRL_U = "\x15";

// A realistic MULTI-LINE stranded directive (mirrors a manager redirect / worker report — the actual
// payloads submit() carries in production).
const STRAY = [
  "worker_report done - commit a1b2c3d, fixed the composer clear gate.",
  "Key decisions: gated on composerLen===0, added a hermetic test.",
  "Please review pty/host.ts sendEnterAndVerify give-up branch closely.",
  "STRAY_TAIL_TOKEN_ZZ",
].join("\n");

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

async function runTrial(name, clearBytesFn) {
  console.log(`\n[probe] ===== TRIAL ${name} =====`);
  cap(SID).raw = "";
  // 1) strand a multi-line paste in the composer (no Enter — models the give-up state: the Enter never
  //    confirmed, so the pasted text is just sitting in the box).
  host.writeStdin(SID, BRACKET_PASTE_START + STRAY + BRACKET_PASTE_END);
  await sleep(1500);
  console.log(`[probe] ${name} after stray paste, tail:\n${tail(SID, 1200)}`);

  // 2) apply the candidate clear
  const clearBytes = clearBytesFn();
  host.writeStdin(SID, clearBytes);
  await sleep(1200);
  console.log(`[probe] ${name} after candidate clear, tail:\n${tail(SID, 1200)}`);

  // 3) type a short marker + Enter — a NORMAL human keystroke submit (not the daemon's bracket-paste +
  //    verify-retry Enter machinery), so a plain \r here is expected to submit reliably regardless of
  //    what this probe is investigating.
  const marker = `CLEARTEST_${name}_OK - reply with just the word ACK.`;
  host.writeStdin(SID, marker);
  await sleep(600);
  console.log(`[probe] ${name} after typing marker, tail:\n${tail(SID, 1500)}`);
  const before = stoppedTurns.get(SID) || 0;
  host.writeStdin(SID, "\r");
  const completed = await waitForStop(SID, before, 30000);
  await sleep(500);

  const eng = engineIds.get(SID);
  const turns = eng ? readTranscript(repo, eng) : [];
  const userTurns = turns.filter((t) => t.role === "user");
  const last = userTurns.at(-1);
  console.log(`[probe] ${name} turn completed=${completed}; engine-recorded LAST user turn:\n---\n${last?.text}\n---`);

  const clean =
    !!last &&
    last.text.includes(`CLEARTEST_${name}_OK`) &&
    !last.text.includes("STRAY_TAIL_TOKEN_ZZ") &&
    !last.text.includes("worker_report done");
  assert(`${name}: engine-recorded submission is the marker ONLY, no stray remnant`, clean, `text=${JSON.stringify(last?.text)}`);
  return clean;
}

try {
  console.log("[probe] spawning real claude…");
  await sleep(10000);
  console.log(`[probe] post-boot tail:\n${tail(SID, 1500)}`);
  if (!engineIds.get(SID)) {
    console.log("[probe] waiting extra for SessionStart hook…");
    await sleep(4000);
  }
  assert("engine session id captured (real hook relay reached us)", !!engineIds.get(SID));

  await runTrial("ESC", () => ESC);
  await runTrial("CTRLU", () => CTRL_U);
  await runTrial("BKSP_EXACT", () => BACKSPACE.repeat(STRAY.length));
  await runTrial("ESC_THEN_CTRLU", () => ESC + CTRL_U);

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
