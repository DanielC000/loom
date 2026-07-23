// REAL-CLAUDE STANDALONE PROBE (card 0f9268cc, Phase 2 diagnostic) — establish the ACTUAL trigger
// conditions for the CLI's "[Pasted text #N]" collapse, isolated from every Loom write-path choice.
// PtyHost is reused ONLY for spawn/hook/transcript plumbing (identical to _probe-paste-resume.mjs); the
// actual bytes sent to the pty for each case are hand-rolled via host.writeStdin — the SAME raw-passthrough
// primitive a human keystroke/paste uses — deliberately NOT enqueueStdin/submit() (which unconditionally
// bracket-wraps + chunks + verify-retries). This is what makes the experiment "Loom-free": we control
// exactly which bytes reach `claude`, varying ONLY (a) bracket-paste wrap present/absent and (b) body
// size/shape, to see which axis actually triggers the collapse — not any Loom delivery-mechanics choice.
//
// Answers: is the collapse triggered by bracket-paste framing itself (⇒ Loom's OWN unconditional wrap at
// submit()/host.ts:3846 is a CONTRIBUTING cause, and a different feeding strategy could PREVENT it), or a
// transient race independent of how the content is fed (⇒ no Loom prevention lever exists)? Also probes
// PASTE_COLLAPSE_MIN_CHARS=200 (our heuristic) against the real CLI's actual threshold, and repeats the
// large-wrapped case 3x to check for intermittency (a race) vs. determinism (a size/shape rule).
//
// NOT hermetic CI — needs a logged-in `claude`. RUN: `pnpm build` (repo root) then
// `node test/_probe-paste-collapse-trigger.mjs` from packages/daemon.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4402;
const tmpHome = path.join(os.tmpdir(), `loom-collapsetrigger-home-${Date.now()}-${process.pid}`);
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
  res.statusCode = 404;
  res.end("nope");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`[probe] hook server on 127.0.0.1:${PORT}`);

const repo = path.join(os.tmpdir(), `loom-collapsetrigger-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# probe\n");
execSync(`git init -q && git add . && git -c user.email=p@p -c user.name=p commit -q -m init`, { cwd: repo });

const captures = new Map();
const cap = (id) => { let c = captures.get(id); if (!c) { c = { raw: "" }; captures.set(id, c); } return c; };
const tail = (id, n = 2000) => stripAnsi(cap(id).raw).slice(-n).replace(/\n{2,}/g, "\n");

const SID = "probe-collapse-trigger";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

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

/** Build a body of ~targetChars, optionally multi-line, ending in a unique marker. */
function makeBody(targetChars, multiline, marker) {
  if (!multiline) {
    const filler = "x".repeat(Math.max(0, targetChars - marker.length - 1));
    return `${filler} ${marker}`;
  }
  const lineText = "payload line - lorem ipsum dolor sit amet consectetur adipiscing elit\n";
  const lines = Math.max(2, Math.ceil(targetChars / lineText.length));
  return lineText.repeat(lines) + marker;
}

/** Raw human-keystroke-shaped delivery: hand-rolled bytes via writeStdin, optionally bracket-wrapped,
 *  then a separately-written Enter (retried — a lone \r right after a big paste can be dropped, same
 *  hazard host.ts's own submit() documents for its own Enter). NO enqueueStdin/submit() involved anywhere. */
async function rawSendAndEnter(id, body, wrapped, timeoutMs = 45000) {
  const before = stoppedTurns.get(id) || 0;
  const payload = wrapped ? `${BRACKET_PASTE_START}${body}${BRACKET_PASTE_END}` : body;
  host.writeStdin(id, payload);
  await sleep(1500);
  let completed = false;
  for (let attempt = 0; attempt < 5 && !completed; attempt++) {
    host.writeStdin(id, "\r");
    completed = await waitForStop(id, before, timeoutMs / 5);
  }
  await sleep(400);
  return completed;
}

const BARE_RE = /^\[Pasted text #\d+[^\]]*\]$/;
const EMBEDS_RE = /\[Pasted text #\d+[^\]]*\]/;

function classify(recordedText, marker) {
  const t = (recordedText ?? "").trim();
  if (t.includes(marker)) return BARE_RE.test(t) ? "IMPOSSIBLE(marker+bare)" : "FULL";
  if (BARE_RE.test(t)) return "BARE_PLACEHOLDER";
  if (EMBEDS_RE.test(t)) return "EMBEDDED_PLACEHOLDER(no marker)";
  return "OTHER/MISSING";
}

const rows = [];

async function runCase(label, { targetChars, multiline, wrapped }) {
  const marker = `MARK_${label.replace(/[^A-Z0-9]/gi, "")}_${Math.floor(Math.random() * 1e6)}`;
  const body = makeBody(targetChars, multiline, marker);
  console.log(`\n[probe] === ${label}: chars=${body.length} multiline=${multiline} wrapped=${wrapped} marker=${marker} ===`);
  const beforeUserTurns = readTranscript(repo, engineIds.get(SID)).filter((t) => t.role === "user").length;
  const completed = await rawSendAndEnter(SID, body, wrapped);
  console.log(`[probe] ${label} completed=${completed}`);
  console.log(`[probe] ${label} post-turn tail:\n${tail(SID, 900)}`);

  const turns = readTranscript(repo, engineIds.get(SID));
  const userTurns = turns.filter((t) => t.role === "user");
  const newTurns = userTurns.slice(beforeUserTurns);
  const combinedNew = newTurns.map((t) => t.text ?? "").join(" ‖ ");
  const result = classify(combinedNew, marker);
  console.log(`[probe] ${label} newUserTurns=${newTurns.length} classification=${result}`);
  console.log(`[probe] ${label} recorded (first 300 chars): ${JSON.stringify(combinedNew.slice(0, 300))}`);
  rows.push({ label, chars: body.length, multiline, wrapped, newTurns: newTurns.length, result });

  // Settle so the next case starts from a clean idle composer, whatever happened.
  if (!completed) { host.writeStdin(SID, "\x1b"); await sleep(500); }
}

try {
  console.log("[probe] spawning real bare claude…");
  host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv });
  host.subscribe(SID, { onData: (b) => { cap(SID).raw += b.toString("utf8"); }, onControl() {} });
  await sleep(10000);
  if (!engineIds.get(SID)) { console.log("[probe] waiting extra for SessionStart hook…"); await sleep(4000); }
  if (!engineIds.get(SID)) throw new Error("engine session id never captured — cannot proceed");

  // Axis A: WRAPPED, multi-line, across PASTE_COLLAPSE_MIN_CHARS=200.
  await runCase("A-wrapped-multiline-small(~120)", { targetChars: 120, multiline: true, wrapped: true });
  await runCase("B-wrapped-multiline-medium(~250)", { targetChars: 250, multiline: true, wrapped: true });
  // Axis B: WRAPPED, multi-line, LARGE (matches real-incident scale) — repeated 3x for intermittency signal.
  await runCase("C1-wrapped-multiline-large(~5000)", { targetChars: 5000, multiline: true, wrapped: true });
  await runCase("C2-wrapped-multiline-large(~5000)", { targetChars: 5000, multiline: true, wrapped: true });
  await runCase("C3-wrapped-multiline-large(~5000)", { targetChars: 5000, multiline: true, wrapped: true });
  // Axis C: WRAPPED, single-line — does LENGTH ALONE (no newline) ever collapse?
  await runCase("D-wrapped-singleline-short(~150)", { targetChars: 150, multiline: false, wrapped: true });
  await runCase("E-wrapped-singleline-long(~500)", { targetChars: 500, multiline: false, wrapped: true });
  // Axis D: UNWRAPPED — isolates whether bracket-paste framing ITSELF is required for the collapse.
  await runCase("F-unwrapped-singleline-long(~500)", { targetChars: 500, multiline: false, wrapped: false });
  await runCase("G-unwrapped-multiline-medium(~250)", { targetChars: 250, multiline: true, wrapped: false });

  console.log("\n[probe] ================= RESULTS =================");
  console.log("label | chars | multiline | wrapped | newTurns | result");
  for (const r of rows) console.log(`${r.label} | ${r.chars} | ${r.multiline} | ${r.wrapped} | ${r.newTurns} | ${r.result}`);

  const wrappedResults = rows.filter((r) => r.wrapped).map((r) => r.result);
  const unwrappedResults = rows.filter((r) => !r.wrapped).map((r) => r.result);
  const anyCollapse = (arr) => arr.some((r) => r.includes("PLACEHOLDER"));
  console.log(`\n[probe] any WRAPPED case collapsed: ${anyCollapse(wrappedResults)}`);
  console.log(`[probe] any UNWRAPPED case collapsed: ${anyCollapse(unwrappedResults)}`);
  const largeRepeats = rows.filter((r) => r.label.startsWith("C")).map((r) => r.result);
  console.log(`[probe] C1/C2/C3 (same config, repeated) results: ${JSON.stringify(largeRepeats)} — mixed results across identical config = intermittent/race; uniform = deterministic on size/shape`);
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
