// REAL-CLAUDE STANDALONE PROBE (card c59c216e) — settle the ONE thing `ee082fbb`'s two probes
// (_probe-composer-clear.mjs, _probe-composer-clear-2.mjs) never tested: does an EXACT-COUNT-only
// backspace assumption hold once the count OVERSHOOTS real composer content on the UNCOLLAPSED
// (short, literal multi-line) paste shape — the shape `e1ac691b` half two's cross-generation fusion
// actually strands, as opposed to the COLLAPSED "[Pasted text #N]" placeholder shape ee082fbb tested
// overshoot against successfully.
//
// Every BKSP trial in both ee082fbb probes used `BACKSPACE.repeat(text.length)` — an EXACT match to
// the literal injected text. Neither ever sent MORE backspaces than the composer actually held for an
// uncollapsed paste. That is precisely the count problem an UNCONDITIONAL defensive clear (proposed by
// c59c216e) would face: unlike the give-up branch (which backspaces the exact known `composerDirtyLen`),
// a defensive clear that must also cover half-two's fusion case has NO known residue length to target,
// because Loom's own bookkeeping (composerDirtyLen) reads 0 by the time half two fires (the prior
// generation WAS confirmed). Any unconditional clear can therefore only ever overshoot by some guessed
// budget — this probe checks whether that overshoot is safe for the shape that matters.
//
// GROUND TRUTH is the ENGINE'S OWN transcript JSONL (readTranscript), exactly like both ee082fbb probes.
//
// RUN: `pnpm build` (repo root) then `node test/_probe-composer-clear-overshoot.mjs` from packages/daemon.
//      Override the binary with LOOM_CLAUDE_BIN; default is PATH-resolved "claude".
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

const PORT = 4399;
const tmpHome = path.join(os.tmpdir(), `loom-overshootprobe-home-${Date.now()}-${process.pid}`);
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
  onEngineSessionId(id, eng) { engineIds.set(id, eng); console.log(`[oprobe] engineSessionId ${id} -> ${eng}`); },
  onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit(id, code) { console.log(`[oprobe] onExit ${id} code=${code}`); },
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
console.log(`[oprobe] hook server on 127.0.0.1:${PORT}`);

const repo = path.join(os.tmpdir(), `loom-overshootprobe-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# probe\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=p@p -c user.name=p");

const captures = new Map();
const cap = (id) => { let c = captures.get(id); if (!c) { c = { raw: "" }; captures.set(id, c); } return c; };
const tail = (id, n = 2000) => stripAnsi(cap(id).raw).slice(-n).replace(/\n{2,}/g, "\n");

const SID = "oprobe-clear";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv });
host.subscribe(SID, { onData: (b) => { cap(SID).raw += b.toString("utf8"); }, onControl() {} });

const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";
const BACKSPACE = "\x7f";

// SHORT two-line stray, well under placeholder-collapse threshold (mirrors ee082fbb probe 2's
// SHORT_STRAY exactly — same shape half two's residue is: a genuinely uncollapsed, literal multi-line
// leftover, NOT a "[Pasted text #N]" placeholder).
const SHORT_STRAY = ["hey - quick redirect, overshoot probe", "check OvershootStrayTOKEN before you land it"].join("\n");
const OVERSHOOT_EXTRA = 200; // backspace this many MORE than the stray's own length — an UNKNOWN-residue budget guess

async function waitForStop(id, sinceCount, timeoutMs) {
  try {
    await sharedWaitUntil(() => (stoppedTurns.get(id) || 0) > sinceCount, { timeoutMs, intervalMs: 250, label: "_probe-composer-clear-overshoot: turn stopped" });
    return true;
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return false;
  }
}

const results = [];
const assert = (label, cond, extra) => {
  results.push({ label, pass: !!cond });
  console.log(`[oprobe] ${cond ? "PASS" : "FAIL"}  ${label}${extra ? `\n    ${extra}` : ""}`);
};

async function runTrial(name, strayText, strayToken, extraBackspaces) {
  console.log(`\n[oprobe] ===== TRIAL ${name} (backspaces=${strayText.length + extraBackspaces}, strayLen=${strayText.length}, overshoot=${extraBackspaces}) =====`);
  cap(SID).raw = "";
  host.writeStdin(SID, BRACKET_PASTE_START + strayText + BRACKET_PASTE_END);
  await sleep(1500);
  console.log(`[oprobe] ${name} after stray paste, tail:\n${tail(SID, 1200)}`);

  // Force-close first (mirrors submit()'s own defensive clear-prefix — a fresh zero-length START+END
  // pair before backspacing), then send the OVERSHOOT backspace burst.
  host.writeStdin(SID, BRACKET_PASTE_START + BRACKET_PASTE_END);
  await sleep(300);
  host.writeStdin(SID, BACKSPACE.repeat(strayText.length + extraBackspaces));
  await sleep(1200);
  const afterClearTail = tail(SID, 1500);
  console.log(`[oprobe] ${name} after OVERSHOOT clear, tail:\n${afterClearTail}`);

  const marker = `CLEARTESTOS_${name}_OK - reply with just the word ACK.`;
  host.writeStdin(SID, marker);
  await sleep(600);
  console.log(`[oprobe] ${name} after typing marker, tail:\n${tail(SID, 1500)}`);
  const before = stoppedTurns.get(SID) || 0;
  host.writeStdin(SID, "\r");
  const completed = await waitForStop(SID, before, 30000);
  await sleep(500);

  const eng = engineIds.get(SID);
  const turns = eng ? readTranscript(repo, eng) : [];
  const userTurns = turns.filter((t) => t.role === "user");
  const last = userTurns.at(-1);
  console.log(`[oprobe] ${name} turn completed=${completed}; engine-recorded LAST user turn:\n---\n${last?.text}\n---`);

  const clean =
    !!last &&
    last.text.includes(`CLEARTESTOS_${name}_OK`) &&
    !last.text.includes(strayToken);
  assert(`${name}: engine-recorded submission is the marker ONLY, no stray remnant despite ${extraBackspaces}-char overshoot`, clean, `text=${JSON.stringify(last?.text)}`);

  // Second control: the overshoot burst itself must not have produced any VISIBLE side effect beyond
  // clearing the composer (no error banner, no mode change, no unexpected engine output) — a bare no-op
  // floor-at-0 should leave the screen looking like an idle empty composer, same as after a normal clear.
  const noVisibleCorruption = !/error|exception|panic/i.test(afterClearTail);
  assert(`${name}: overshoot burst produced no visible error/exception in the terminal`, noVisibleCorruption, `tail=${JSON.stringify(afterClearTail.slice(-400))}`);

  return clean;
}

// NEGATIVE CONTROL: no clear at all — proves this harness's "clean" assertion can actually FAIL when a
// stray remnant really does leak into the transcript, before trusting any of the three PASS results
// below. Inverted polarity: here a leaked stray is the EXPECTED, correct outcome.
async function runNoClearControl(name, strayText, strayToken) {
  console.log(`\n[oprobe] ===== TRIAL ${name} (negative control: NO clear sent at all) =====`);
  cap(SID).raw = "";
  host.writeStdin(SID, BRACKET_PASTE_START + strayText + BRACKET_PASTE_END);
  await sleep(1500);
  const marker = `CLEARTESTOS_${name}_OK - reply with just the word ACK.`;
  host.writeStdin(SID, marker);
  await sleep(600);
  const before = stoppedTurns.get(SID) || 0;
  host.writeStdin(SID, "\r");
  const completed = await waitForStop(SID, before, 30000);
  await sleep(500);
  const eng = engineIds.get(SID);
  const turns = eng ? readTranscript(repo, eng) : [];
  const userTurns = turns.filter((t) => t.role === "user");
  const last = userTurns.at(-1);
  console.log(`[oprobe] ${name} turn completed=${completed}; engine-recorded LAST user turn:\n---\n${last?.text}\n---`);
  const strayLeaked = !!last && last.text.includes(strayToken);
  assert(`${name}: NEGATIVE CONTROL — with no clear, the stray DOES leak into the transcript (proves the harness/assertion can detect a real failure)`, strayLeaked, `text=${JSON.stringify(last?.text)}`);
}

try {
  console.log("[oprobe] spawning real claude…");
  await sleep(10000);
  if (!engineIds.get(SID)) { console.log("[oprobe] waiting extra for SessionStart hook…"); await sleep(4000); }
  assert("engine session id captured", !!engineIds.get(SID));

  await runNoClearControl("NO_CLEAR_CONTROL", SHORT_STRAY, "OvershootStrayTOKEN");

  // Baseline (sanity re-check of ee082fbb's own exact-count finding, same shape/session as this probe).
  await runTrial("EXACT_BASELINE", SHORT_STRAY, "OvershootStrayTOKEN", 0);
  // The actual open question: overshoot by 200 chars beyond the stray's own length.
  await runTrial("OVERSHOOT_200", SHORT_STRAY, "OvershootStrayTOKEN", OVERSHOOT_EXTRA);
  // A second, larger overshoot to check the floor-at-0 no-op doesn't degrade/misbehave at scale.
  await runTrial("OVERSHOOT_2000", SHORT_STRAY, "OvershootStrayTOKEN", 2000);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[oprobe] ${passed}/${results.length} assertions passed.`);
  results.forEach((r) => console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.label}`));
} finally {
  console.log("[oprobe] cleanup…");
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
  console.log("[oprobe] done.");
  setTimeout(() => process.exit(0), 500);
}
