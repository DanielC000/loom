// REAL-CLAUDE STANDALONE PROBE (card 17c98df7) — discriminate the two live candidates `2960c3bf`'s
// deferred-clear specimen left unseparated from static logs:
//   (a) the raw un-bracketed BACKSPACE.repeat(dirty) burst is taken as literal content by an engine
//       that is still reading stdin.
//   (b) the engine had already stopped reading ALL stdin after an earlier large paste — everything
//       written after that point (backspace burst included) just piles up unread in the OS pty buffer.
// EXPERIMENT (the 2960c3bf worker's design, verbatim in substance — see that card and this card's body):
// the next time host.ts's deferred-clear branch (submit()'s `composerDirtyLen > 0 && composerLen === 0`
// branch, NOT a same-message redelivery — currently host.ts:6514-6526, re-anchor by symbol, not line)
// fires, immediately after the backspace burst, force repaint() (Ctrl-L, host.ts's `repaint()`, already
// shipped and otherwise only reachable via a viewer's {type:"repaint"} ws message) and watch for ANY pty
// output. Under (a) the app layer is still reading, so it should redraw. Under (b) nothing comes back.
//
// ⚠️ MANDATORY POSITIVE CONTROL (card DoD-2): under (b) the expected result is SILENCE, and silence is
// also exactly what a probe that never fired, or a repaint that was never written, produces. This probe
// therefore proves repaint() produces observable output on a KNOWN-HEALTHY idle session FIRST — if that
// control fails, every later null result is discarded as inconclusive, never read as a wedge.
//
// METHOD for reproduction attempts: enqueue a large (~44KB, matching the 2960c3bf specimen's own
// composerDirtyLen=44283 reading) bracketed paste via the REAL PtyHost.enqueueStdin() — the same public
// API production submit()/give-up machinery runs through, not a raw writeStdin bypass — sent shortly
// after SessionStart (mirroring production kickoff delivery timing, not a long idle-settled window).
// If GIVE-UP RECOVERY fires (busy falls back to false with no confirming Stop/StopFailure hook), a
// SECOND, genuinely different short message is enqueued immediately — composerDirtyLen>0 && composerLen
// ===0 && not-a-same-message-redelivery is exactly the deferred-clear branch's own trigger condition
// (see host.ts's `isGiveUpRedelivery` check and pty-giveup-clear.mjs scenario (1b) for the identical
// hermetic construction with a fake pty). repaint() fires right after the computed backspace-burst
// write duration, then output is watched for an extended window to see whether the session ever
// recovers on its own (self-resolving "just slow", not (b)) or stays silent like the specimen.
//
// ONE PtyHost instance + ONE hook server + ONE LOOM_HOME for the entire script (sessions are spawned/
// stopped sequentially by distinct sessionId on the SAME host) — PtyHost's own dependencies (e.g.
// claude-settings.js) read LOOM_HOME/LOOM_PORT from process.env at THEIR OWN module-load time, so
// re-pointing those env vars mid-script and re-importing PtyHost under a fresh query-string does NOT
// isolate transitively-imported modules (they resolve to the same cached URL and keep the FIRST value)
// — confirmed by hand: a per-session re-import left claude-settings.js writing into the first session's
// stale temp dir. A single shared host/server for the whole run sidesteps this entirely.
//
// NOT a hermetic CI test — a manual, real-engine investigation (needs a logged-in `claude`). Modeled on
// test/_probe-composer-clear.mjs and test/_probe-empty-paste-provocation.mjs's real-PtyHost standalone
// harness (no daemon needed).
//
// RUN: `pnpm build` (repo root) then `node test/_probe-repaint-wedge.mjs` from packages/daemon.
//      Override the binary with LOOM_CLAUDE_BIN; default is PATH-resolved "claude".
//      Override attempt count with PROBE_ATTEMPTS (default 3).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = 4400;
const ATTEMPTS = process.env.PROBE_ATTEMPTS !== undefined ? Number(process.env.PROBE_ATTEMPTS) : 3;

const tmpHome = path.join(os.tmpdir(), `loom-repaintprobe-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "tmp", "settings"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(PORT);

const { PtyHost } = await import("../dist/pty/host.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (s) =>
  s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1B[()][0-9A-Za-z]/g, "").replace(/\x1B[=>]/g, "");

const PTY_WRITE_CHUNK_UNITS = 1024;
const PTY_WRITE_CHUNK_DELAY_MS = 8;

const results = [];
const check = (label, cond, extra) => {
  results.push({ label, pass: !!cond });
  console.log(`[probe] ${cond ? "PASS" : "FAIL"}  ${label}${extra ? `\n    ${extra}` : ""}`);
};

// ---------------------------------------------------------------------------------------------------
// Shared host + hook server for the whole script; sessions are spawned/stopped sequentially by SID.
// ---------------------------------------------------------------------------------------------------
const engineIds = new Map();
const stoppedTurns = new Map();
const busyLog = {};
const events = {
  onEngineSessionId(id, eng) { engineIds.set(id, eng); console.log(`[probe] engineSessionId ${id} -> ${eng}`); },
  onBusy(id, busy) { (busyLog[id] ??= []).push(busy); },
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
  res.statusCode = 404; res.end("nope");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`[probe] hook server on 127.0.0.1:${PORT}`);

const captures = new Map();
const cap = (id) => { let c = captures.get(id); if (!c) { c = { raw: "", bytes: 0 }; captures.set(id, c); } return c; };
const tail = (id, n = 1200) => stripAnsi(cap(id).raw).slice(-n).replace(/\n{2,}/g, "\n");

async function measureWindow(SID, windowLabel, windowMs, action) {
  const c = cap(SID);
  c.bytes = 0;
  if (action) action();
  await sleep(windowMs);
  console.log(`[probe:${SID}] ${windowLabel}: ${c.bytes} byte(s) captured over ${windowMs}ms`);
  return c.bytes;
}

async function waitForStopOrGiveUp(SID, sinceStopped, sinceBusyLen, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const stoppedNow = stoppedTurns.get(SID) || 0;
    if (stoppedNow > sinceStopped) return { outcome: "confirmed", elapsedMs: Date.now() - t0 };
    const log = busyLog[SID] || [];
    if (log.length > sinceBusyLen && log.at(-1) === false) return { outcome: "gave-up", elapsedMs: Date.now() - t0 };
    await sleep(100);
  }
  return { outcome: "timeout", elapsedMs: Date.now() - t0 };
}

const spawnedRepos = [];
async function withSession(label, fn) {
  const SID = `probe-${label}`;
  // fs.mkdtempSync (not a hand-built Date.now()+pid path — clock-path-regression-guard.mjs Tier-B):
  // this function runs once per reproduction attempt within the SAME process, so a per-call collision
  // discriminator is required, not just a per-process one.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `loom-repaintprobe-repo-${label}-`));
  fs.writeFileSync(path.join(repo, "README.md"), "# probe\n");
  execSync(`git init -q && git add . && git -c user.email=p@p -c user.name=p commit -q -m init`, { cwd: repo });
  spawnedRepos.push(repo);

  const geometry = { cols: 120, rows: 40 };
  const sessionEnv = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1", CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1" };
  const permission = { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 };

  host.spawn({ sessionId: SID, cwd: repo, permission, geometry, sessionEnv });
  host.subscribe(SID, { onData: (b) => { const c = cap(SID); c.raw += b.toString("utf8"); c.bytes += b.length; }, onControl() {} });

  try {
    console.log(`[probe:${SID}] spawning real claude…`);
    await sleep(10000);
    if (!engineIds.get(SID)) { console.log(`[probe:${SID}] waiting extra for SessionStart hook…`); await sleep(4000); }
    const gotId = !!engineIds.get(SID);
    check(`${SID}: engine session id captured (real hook relay reached us)`, gotId);
    return await fn({ SID, gotId });
  } finally {
    console.log(`[probe:${SID}] cleanup…`);
    try { host.stop(SID, "hard"); } catch { /* ignore */ }
    await sleep(1200);
  }
}

// ---------------------------------------------------------------------------------------------------
// STEP A — MANDATORY POSITIVE CONTROL: repaint() on a KNOWN-HEALTHY idle session must produce output.
// ---------------------------------------------------------------------------------------------------
let controlPassed = false;
let controlBaseline = 0, controlProvoked = 0;
await withSession("control", async ({ SID }) => {
  console.log("\n[probe] ===== STEP A: POSITIVE CONTROL (repaint on a healthy idle session) =====");
  console.log("[probe] settling idle before baseline…");
  await sleep(6000);
  controlBaseline = await measureWindow(SID, "idle baseline (no action)", 2500, null);
  await sleep(500);
  controlProvoked = await measureWindow(SID, "post-repaint() window", 2500, () => host.repaint(SID));
  controlPassed = controlProvoked > 0 && controlProvoked >= controlBaseline;
  check("STEP A: repaint() produced observable output on a known-healthy idle session (MANDATORY control)",
    controlPassed, `baseline=${controlBaseline}B provoked=${controlProvoked}B`);
});

if (!controlPassed) {
  console.log("\n[probe] ===== VERDICT =====");
  console.log("[probe] INCONCLUSIVE — the mandatory positive control failed: repaint() produced no observable");
  console.log("[probe] output above the idle baseline even on a healthy session. Without this control, a null");
  console.log("[probe] result from a reproduction attempt cannot distinguish 'engine wedged' from 'the probe");
  console.log("[probe] itself is broken' — per the card's DoD-2, no reproduction attempts are run, and no");
  console.log("[probe] candidate is selected.");
  results.forEach((r) => console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.label}`));
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  server.close();
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------------
// STEP B — reproduction attempts: drive the REAL deferred-clear branch, fire repaint() immediately
// after the backspace burst, watch for output.
// ---------------------------------------------------------------------------------------------------
const attemptOutcomes = [];

function buildStrand(sizeChars, tag) {
  const line = `[${tag}] worker_report done - commit a1b2c3d, fixed the composer clear gate. `;
  const lines = [];
  let total = 0;
  let n = 0;
  while (total < sizeChars) {
    const l = `${line}${n++}`;
    lines.push(l);
    total += l.length + 1;
  }
  return lines.join("\n").slice(0, sizeChars);
}

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const label = `attempt${attempt}`;
  console.log(`\n[probe] ===== STEP B: REPRODUCTION ATTEMPT ${attempt}/${ATTEMPTS} =====`);
  const outcome = await withSession(label, async ({ SID }) => {
    // Deliver the large paste SHORTLY after SessionStart (mirrors production kickoff delivery timing —
    // the 2960c3bf specimen's own composerDirtyLen=44283 was read at +4.5s from spawn), not after a long
    // idle-settle window.
    await sleep(500);

    const TEXT1 = buildStrand(44283, `A${attempt}`);
    console.log(`[probe:${SID}] TEXT1 length=${TEXT1.length}`);
    const sinceStopped0 = stoppedTurns.get(SID) || 0;
    const sinceBusyLen0 = (busyLog[SID] || []).length;
    host.enqueueStdin(SID, TEXT1);
    const r1 = await waitForStopOrGiveUp(SID, sinceStopped0, sinceBusyLen0, 20000);
    console.log(`[probe:${SID}] TEXT1 outcome=${r1.outcome} after ${r1.elapsedMs}ms`);

    if (r1.outcome !== "gave-up") {
      return { attempt, reproduced: "no-give-up", detail: r1.outcome, elapsedMs: r1.elapsedMs };
    }

    const dirty = host.getComposerDirtyLen(SID);
    check(`${label}: composerDirtyLen reflects TEXT1's own give-up (${TEXT1.length} chars)`, dirty === TEXT1.length,
      `getComposerDirtyLen=${dirty}`);

    // Enqueue a genuinely DIFFERENT, short message — composerDirtyLen>0 && composerLen===0 && this is
    // NOT a same-message redelivery (no giveUpGen) ⇒ exactly the deferred-clear branch's own trigger
    // condition (host.ts submit(), the `else if (live.composerDirtyLen > 0 && live.composerLen === 0)`
    // branch — mirrors pty-giveup-clear.mjs scenario (1b)'s hermetic construction, here against a real
    // engine instead of a fake pty).
    const TEXT2 = `DIFFERENT_MARKER_${attempt}_${Date.now()} - reply with just the word ACK.`;
    const sinceStopped1 = stoppedTurns.get(SID) || 0;
    const sinceBusyLen1 = (busyLog[SID] || []).length;
    cap(SID).raw = ""; cap(SID).bytes = 0;
    host.enqueueStdin(SID, TEXT2);

    // Wait roughly the backspace burst's own write duration (writeChunked: ceil(dirty/1024) chunks *
    // PTY_WRITE_CHUNK_DELAY_MS), landing just after the burst completes and before TEXT2's own Enter
    // attempt (which needs its own SUBMIT_ENTER_DELAY_MS+pasteSettleExtraMs on top) — so repaint() below
    // tests the app's response to the burst itself, not conflated with TEXT2's own confirmation.
    const expectedBurstMs = Math.ceil(dirty / PTY_WRITE_CHUNK_UNITS) * PTY_WRITE_CHUNK_DELAY_MS + 50;
    await sleep(expectedBurstMs);

    console.log(`[probe:${SID}] firing repaint() ~${expectedBurstMs}ms after the deferred-clear enqueue (immediately after the backspace burst)`);
    const repaintBytes = await measureWindow(SID, `${label}: post-backspace-burst repaint() window`, 5000, () => host.repaint(SID));

    // Now watch for an EXTENDED window to see whether the session ever recovers on its own (self-
    // resolving "just slow", not a true wedge) or stays silent like the 2960c3bf specimen (near-total
    // silence for the rest of that session's life).
    const extendedWaitMs = 45000;
    const r2 = await waitForStopOrGiveUp(SID, sinceStopped1, sinceBusyLen1, extendedWaitMs);
    const totalBytesAfterBurst = cap(SID).bytes;
    console.log(`[probe:${SID}] extended watch (${extendedWaitMs}ms): TEXT2 outcome=${r2.outcome}, total bytes captured since burst=${totalBytesAfterBurst}`);
    console.log(`[probe:${SID}] tail after extended watch:\n${tail(SID, 800)}`);

    let classification;
    if (repaintBytes > 0) {
      classification = "candidate-a-consistent (repaint produced output — app layer was still reading)";
    } else if (repaintBytes === 0 && totalBytesAfterBurst === 0 && r2.outcome === "timeout") {
      classification = "candidate-b-consistent (near-total silence after the burst, matching the specimen)";
    } else {
      classification = "ambiguous (repaint itself silent, but later output/confirmation arrived — not a clean read for either candidate)";
    }
    console.log(`[probe:${SID}] CLASSIFICATION: ${classification}`);

    return {
      attempt, reproduced: "gave-up", dirty, repaintBytes, extendedOutcome: r2.outcome,
      totalBytesAfterBurst, classification,
    };
  });
  attemptOutcomes.push(outcome);
}

// ---------------------------------------------------------------------------------------------------
// VERDICT
// ---------------------------------------------------------------------------------------------------
console.log("\n[probe] ===== VERDICT =====");
console.log(`[probe] positive control: PASS (baseline=${controlBaseline}B, repaint-provoked=${controlProvoked}B)`);
const giveUps = attemptOutcomes.filter((o) => o.reproduced === "gave-up");
const noGiveUps = attemptOutcomes.filter((o) => o.reproduced === "no-give-up");
console.log(`[probe] ${ATTEMPTS} attempt(s): ${giveUps.length} triggered GIVE-UP RECOVERY + deferred-clear branch, ${noGiveUps.length} confirmed normally (no give-up, TEXT1 too fast/small to strand)`);
attemptOutcomes.forEach((o) => {
  if (o.reproduced === "no-give-up") console.log(`  attempt ${o.attempt}: NO GIVE-UP (${o.detail}, ${o.elapsedMs}ms) — deferred-clear branch not exercised this attempt`);
  else console.log(`  attempt ${o.attempt}: GIVE-UP fired, dirty=${o.dirty}, repaintBytes=${o.repaintBytes}, extendedOutcome=${o.extendedOutcome}, totalBytesAfterBurst=${o.totalBytesAfterBurst} — ${o.classification}`);
});

const bConsistent = giveUps.filter((o) => o.classification?.startsWith("candidate-b"));
const aConsistent = giveUps.filter((o) => o.classification?.startsWith("candidate-a"));

if (giveUps.length === 0) {
  console.log(`\n[probe] RESULT: could not reproduce a give-up (the strand's own precondition) in ${ATTEMPTS} attempt(s) — the deferred-clear branch was never exercised, so no candidate can be selected. This is a complete, valid outcome per the card's DoD-3.`);
} else if (bConsistent.length > 0 && aConsistent.length === 0) {
  console.log(`\n[probe] RESULT: candidate (b) selected — ${bConsistent.length}/${giveUps.length} give-up attempt(s) showed near-total silence after the backspace burst, matching the 2960c3bf specimen. The engine had stopped reading stdin; the clear-vs-repaste mechanics are irrelevant.`);
} else if (aConsistent.length > 0 && bConsistent.length === 0) {
  console.log(`\n[probe] RESULT: candidate (a)-consistent in every reproduced give-up (${aConsistent.length}/${giveUps.length}) — repaint() always produced output, meaning the app layer was still reading in every attempt reached. NOTE: this does not prove (a) over (b) for the ORIGINAL specimen — it shows this probe never reproduced a TRUE wedge (every give-up here resolved to a merely-slow-rendering engine, not a dead one); see the per-attempt detail above.`);
} else if (giveUps.length > 0) {
  console.log(`\n[probe] RESULT: mixed/inconclusive across ${giveUps.length} give-up attempt(s) — see per-attempt classification above. Neither candidate is cleanly selected by this run.`);
}

const failures = results.filter((r) => !r.pass).length;
console.log(`\n[probe] ${results.length - failures}/${results.length} check(s) passed.`);

console.log("[probe] final cleanup…");
try { server.close(); } catch { /* ignore */ }
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
for (const repo of spawnedRepos) {
  try {
    const enc = path.resolve(repo).replace(/[^a-zA-Z0-9]/g, "-");
    const projDir = path.join(os.homedir(), ".claude", "projects", enc);
    fs.rmSync(projDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(0);
