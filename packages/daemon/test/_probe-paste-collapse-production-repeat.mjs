// REAL-CLAUDE STANDALONE PROBE (card 0f9268cc, Phase 2 diagnostic, round 2) — the raw-writeStdin
// with-vs-without-bracket-wrap comparison in _probe-paste-collapse-trigger.mjs came back a clean null (0/9
// collapses, including 3 repeats of a large paste). But that probe's hand-rolled writes don't structurally
// mirror submit()'s ACTUAL choreography: submit() writes BRACKET_PASTE_START and BRACKET_PASTE_END as
// SEPARATE, ISOLATED pty.write calls with the body chunked in between (host.ts:3846-3855), then a
// PACED, VERIFY-RETRIED Enter (sendEnterAndVerify) — not a single glued START+body+END string sliced at
// arbitrary 1024-byte chunk boundaries. This probe instead drives the REAL production path
// (host.enqueueStdin -> submit() -> writeChunked, the EXACT mechanism behind both confirmed 2026-07-22
// tripwire hits) repeated MANY times back-to-back with large multi-line pastes, to establish an empirical
// collapse RATE for the actual mechanism on the CURRENTLY INSTALLED claude version — mirroring this
// project's own established methodology for a suspected race (card b64b3726: pooled n=10 real-engine
// samples). A high rate here would point at submit()'s specific write pattern as implicated; a persistent
// zero (matching round 1) would further support "genuinely rare/racy, no simple content-shape lever."
//
// NOT hermetic CI — needs a logged-in `claude`. RUN: `pnpm build` (repo root) then
// `node test/_probe-paste-collapse-production-repeat.mjs` from packages/daemon.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4403;
const tmpHome = path.join(os.tmpdir(), `loom-collapserepeat-home-${Date.now()}-${process.pid}`);
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

const repo = path.join(os.tmpdir(), `loom-collapserepeat-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# probe\n");
execSync(`git init -q && git add . && git -c user.email=p@p -c user.name=p commit -q -m init`, { cwd: repo });

const captures = new Map();
const cap = (id) => { let c = captures.get(id); if (!c) { c = { raw: "" }; captures.set(id, c); } return c; };
const tail = (id, n = 1500) => stripAnsi(cap(id).raw).slice(-n).replace(/\n{2,}/g, "\n");

const SID = "probe-collapse-repeat";
const geometry = { cols: 120, rows: 40 };
const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

const N = 15; // repeat count — pooled sample, mirrors card b64b3726's n=10 real-engine methodology

async function waitForStop(id, sinceCount, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((stoppedTurns.get(id) || 0) > sinceCount) return true;
    await sleep(250);
  }
  return false;
}

// The REAL production delivery path — identical to a worker report / manager redirect / human Composer
// send. NOT hand-rolled bytes: this is host.enqueueStdin -> submit() -> writeChunked, unmodified.
async function submitAndWait(id, text, timeoutMs = 60000) {
  const before = stoppedTurns.get(id) || 0;
  const rp = host.enqueueStdin(id, text);
  if (!rp.delivered) { console.log(`[probe] WARNING: not immediately delivered: ${JSON.stringify(rp)}`); }
  const completed = await waitForStop(id, before, timeoutMs);
  await sleep(500);
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

function makeLargePaste(marker) {
  const lineText = "payload line - lorem ipsum dolor sit amet consectetur adipiscing elit\n";
  return lineText.repeat(70) + marker; // ~5000 chars, matching real-incident scale
}

const rows = [];

try {
  console.log("[probe] spawning real claude (production submit() path repeat)…");
  host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv });
  host.subscribe(SID, { onData: (b) => { cap(SID).raw += b.toString("utf8"); }, onControl() {} });
  await sleep(10000);
  if (!engineIds.get(SID)) { console.log("[probe] waiting extra for SessionStart hook…"); await sleep(4000); }
  if (!engineIds.get(SID)) throw new Error("engine session id never captured — cannot proceed");

  for (let i = 1; i <= N; i++) {
    const marker = `PRODMARK_${i}_${Math.floor(Math.random() * 1e6)}`;
    const body = makeLargePaste(marker);
    console.log(`\n[probe] === repeat ${i}/${N}: chars=${body.length} marker=${marker} ===`);
    const beforeUserTurns = readTranscript(repo, engineIds.get(SID)).filter((t) => t.role === "user").length;
    const t0 = Date.now();
    const completed = await submitAndWait(SID, body);
    const ms = Date.now() - t0;
    const turns = readTranscript(repo, engineIds.get(SID));
    const userTurns = turns.filter((t) => t.role === "user");
    const newTurns = userTurns.slice(beforeUserTurns);
    const combinedNew = newTurns.map((t) => t.text ?? "").join(" ‖ ");
    const result = classify(combinedNew, marker);
    console.log(`[probe] repeat ${i} completed=${completed} durationMs=${ms} newUserTurns=${newTurns.length} classification=${result}`);
    if (result !== "FULL") {
      console.log(`[probe] repeat ${i} NON-FULL — recorded (first 300 chars): ${JSON.stringify(combinedNew.slice(0, 300))}`);
      console.log(`[probe] repeat ${i} tail:\n${tail(SID, 1200)}`);
    }
    rows.push({ i, chars: body.length, ms, newTurns: newTurns.length, result });
  }

  console.log("\n[probe] ================= RESULTS (production submit() path, repeated) =================");
  console.log("repeat | chars | durationMs | newTurns | result");
  for (const r of rows) console.log(`${r.i} | ${r.chars} | ${r.ms} | ${r.newTurns} | ${r.result}`);
  const collapses = rows.filter((r) => r.result.includes("PLACEHOLDER"));
  console.log(`\n[probe] collapses: ${collapses.length}/${N} (${((collapses.length / N) * 100).toFixed(1)}%)`);
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
