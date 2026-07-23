// REAL-CLAUDE STANDALONE PROBE (card b64b3726, part (a)) — does an idle Ink composer emit ANY pty output
// in response to a zero-length bracketed paste (`BRACKET_PASTE_START + BRACKET_PASTE_END`, no Enter)?
//
// Why this matters: sendEnterAndVerify's give-up branch (host.ts, card 71de1f9c) suppresses give-up
// recovery when `live.lastOutputAt > enterWrittenAt` — output after the final Enter write is read as
// "the Enter probably landed, a turn is running, the confirming hook is just slow." But EVERY retry
// attempt>1 (always true at give-up in production — SUBMIT_MAX_ATTEMPTS defaults to 4) re-asserts
// `BRACKET_PASTE_START + BRACKET_PASTE_END` immediately before that Enter (card 97558183). If THAT
// re-assert alone reliably provokes engine output (e.g. a repaint), it would land inside the give-up
// window and make the discriminator fire on nearly every give-up — not just genuine slow-hook cases.
//
// NOT a hermetic CI test — a manual, real-engine investigation (needs a logged-in `claude`). Modeled on
// test/_probe-composer-clear.mjs's real-PtyHost standalone harness (no daemon needed).
//
// METHOD: after the engine settles idle, run N trials of {idle baseline window, then an
// identical-duration post-`START+END` window}, comparing captured byte counts. A positive control (a
// real submitted prompt) proves the capture harness would see output if any occurred — without it,
// "zero bytes" and "capture is broken" are indistinguishable (the same reasoning that made 71de1f9c's
// 85s idle observation trustworthy).
//
// RUN: `pnpm build` (repo root) then `node test/_probe-empty-paste-provocation.mjs` from packages/daemon.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4399;
const tmpHome = path.join(os.tmpdir(), `loom-provokeprobe-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(PORT);

const { PtyHost } = await import("../dist/pty/host.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) =>
  s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1B[()][0-9A-Za-z]/g, "").replace(/\x1B[=>]/g, "");

const engineIds = new Map();
const stoppedTurns = new Map();
const events = {
  onEngineSessionId(id, eng) { engineIds.set(id, eng); console.log(`[provoke] engineSessionId ${id} -> ${eng}`); },
  onBusy() {}, onContextStats() {}, onRateLimited() {},
  onExit(id, code) { console.log(`[provoke] onExit ${id} code=${code}`); },
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
console.log(`[provoke] hook server on 127.0.0.1:${PORT}`);

const repo = path.join(os.tmpdir(), `loom-provokeprobe-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# probe\n");
execSync(`git init -q && git add . && git -c user.email=p@p -c user.name=p commit -q -m init`, { cwd: repo });

const captures = new Map();
const cap = (id) => { let c = captures.get(id); if (!c) { c = { raw: "", bytes: 0, rawBuf: [] }; captures.set(id, c); } return c; };
const tail = (id, n = 1200) => stripAnsi(cap(id).raw).slice(-n).replace(/\n{2,}/g, "\n");
const visible = (s) => s.replace(/\x1b/g, "\\x1b").replace(/\r/g, "\\r").replace(/\n/g, "\\n");

const SID = "probe-provoke";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv });
host.subscribe(SID, { onData: (b) => { const c = cap(SID); c.raw += b.toString("utf8"); c.bytes += b.length; c.rawBuf.push(Buffer.from(b)); }, onControl() {} });

const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

async function waitForStop(id, sinceCount, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((stoppedTurns.get(id) || 0) > sinceCount) return true;
    await sleep(250);
  }
  return false;
}

// Same-duration window measurement: reset the byte counter, wait `windowMs` doing (or not doing)
// something, and report bytes captured strictly within that window.
async function measureWindow(label, windowMs, action, dumpBytes = false) {
  const c = cap(SID);
  c.bytes = 0;
  c.rawBuf = [];
  if (action) action();
  await sleep(windowMs);
  console.log(`[provoke] ${label}: ${c.bytes} byte(s) captured over ${windowMs}ms`);
  if (dumpBytes && c.bytes > 0) {
    const buf = Buffer.concat(c.rawBuf);
    console.log(`[provoke]   raw hex: ${buf.toString("hex")}`);
    console.log(`[provoke]   raw visible: ${visible(buf.toString("utf8"))}`);
  }
  return c.bytes;
}

const WINDOW_MS = 4000; // comparable to the real give-up window (~3.6s: SUBMIT_VERIFY_TIMEOUT_MS * attempts)
const TRIALS = 3; // round 1 already showed a deterministic 16-byte response in 5/5 trials; this round just captures the raw bytes

const results = { baseline: [], provocation: [] };

try {
  console.log("[provoke] spawning real claude…");
  await sleep(10000);
  if (!engineIds.get(SID)) { console.log("[provoke] waiting extra for SessionStart hook…"); await sleep(4000); }
  const gotId = !!engineIds.get(SID);
  console.log(`[provoke] ${gotId ? "PASS" : "FAIL"}  engine session id captured (real hook relay reached us)`);

  // Let residual startup output fully settle before measuring anything.
  console.log("[provoke] settling idle before baseline…");
  await sleep(6000);

  for (let i = 1; i <= TRIALS; i++) {
    const b = await measureWindow(`trial ${i} IDLE BASELINE`, WINDOW_MS, null, true);
    results.baseline.push(b);
    // A brief gap between baseline and provocation so the provocation window starts from a clean idle
    // state, not tailing the baseline window's own measurement boundary.
    await sleep(500);
    const p = await measureWindow(`trial ${i} POST START+END (no Enter)`, WINDOW_MS,
      () => host.writeStdin(SID, BRACKET_PASTE_START + BRACKET_PASTE_END), true);
    results.provocation.push(p);
    await sleep(500);
  }

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const baselineTotal = sum(results.baseline);
  const provocationTotal = sum(results.provocation);
  console.log(`\n[provoke] baseline bytes per trial: [${results.baseline.join(", ")}]  total=${baselineTotal}`);
  console.log(`[provoke] provocation bytes per trial: [${results.provocation.join(", ")}]  total=${provocationTotal}`);

  // POSITIVE CONTROL: a real submitted prompt must produce substantial output — proves the capture
  // harness is actually working and would have seen provocation bytes if they existed.
  cap(SID).raw = ""; cap(SID).bytes = 0;
  const marker = "PROVOKE_CONTROL_OK - reply with just the word ACK.";
  const before = stoppedTurns.get(SID) || 0;
  host.writeStdin(SID, BRACKET_PASTE_START + marker + BRACKET_PASTE_END);
  await sleep(300);
  host.writeStdin(SID, "\r");
  const completed = await waitForStop(SID, before, 30000);
  await sleep(300);
  const controlBytes = cap(SID).bytes;
  console.log(`[provoke] positive control: turn completed=${completed}, ${controlBytes} byte(s) captured`);
  console.log(`[provoke] positive control tail:\n${tail(SID, 800)}`);

  console.log("\n[provoke] ===== VERDICT =====");
  const controlPass = completed && controlBytes > 200;
  console.log(`[provoke] ${controlPass ? "PASS" : "FAIL"}  positive control produced substantial output (capture harness verified working)`);
  if (!controlPass) {
    console.log("[provoke] INCONCLUSIVE — positive control failed, so the baseline/provocation byte counts above cannot be trusted either way.");
  } else if (provocationTotal === 0 && baselineTotal === 0) {
    console.log("[provoke] RESULT: empty START+END provoked ZERO bytes across all trials, matching the idle baseline (also zero). Vector 1 does NOT provoke output — it collapses; only the human-repaint vector remains live.");
  } else if (provocationTotal > baselineTotal) {
    console.log(`[provoke] RESULT: empty START+END provoked output (${provocationTotal} bytes vs ${baselineTotal} baseline) — Vector 1 IS REAL. This re-assert fires on attempt>1, which is EVERY production give-up (SUBMIT_MAX_ATTEMPTS=4) — see this probe's header comment for why that is a much bigger finding than this card alone.`);
  } else {
    console.log(`[provoke] RESULT: ambiguous — provocation bytes (${provocationTotal}) did not exceed baseline (${baselineTotal}); baseline itself was non-zero (unexpected chatter even at idle). Needs a closer look before concluding either way.`);
  }
} finally {
  console.log("[provoke] cleanup…");
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
  console.log("[provoke] done.");
  setTimeout(() => process.exit(0), 500);
}
