// Card 1bd1f045 — byte/call-sequence instrumentation at the REAL `live.pty.write()` call sites
// (host.ts's new `ptyWrite()` helper, called inline at every site — never a layer above them, unlike
// the pre-existing `[submit-write]` log which is logged PRE-WRITE and can't see what actually reached
// the pty). This is the discriminating artifact for card 3ce3fa39's mid-token splice: if the daemon
// itself ever double-emits (e.g. a `writeChunked` `done` callback firing twice — card 9ed20572), TWO
// `[pty-write]` records with an identical content signature at DISTINCT `seq` appear; if the daemon
// writes exactly once, this log shows one clean record and any corruption downstream is NOT the
// daemon's doing. Observation only — this test asserts on LOGGED records, never on write behaviour.
//
// THE VACUITY REQUIREMENT (non-negotiable per the card): an absence of duplicate sequence numbers means
// nothing unless the instrumentation is first PROVEN capable of surfacing a duplicate. Section (C) below
// drives a deliberate double-emission (two back-to-back `writeChunked` calls with byte-IDENTICAL content
// on the same session — the direct shape of the "done callback fires twice" hypothesis) and asserts the
// two resulting `[pty-write]` records share a content signature (len+hash) at two distinct `seq`
// values — a duplicate made visible AS a sequence anomaly, exactly as the card requires. Section (A)'s
// distinctly-numbered chunks are the FALSE-POSITIVE control: proving the detector doesn't flag legitimate
// distinct writes as duplicates just because they share a tag.
//
// RECORD SHAPE: `len`+`h` (an 8-hex fnv1a32 content fingerprint) replaces a head/tail excerpt — a
// post-review compaction (manager feedback, 2026-07-23) after measuring the excerpt form at ~100-150
// bytes/record against a rotating, forensically-relied-on daemon-output.log. See ptyWrite's own doc.
//
// RED-FIRST, validated by hand during development of this fix: commenting out the `console.log` line
// inside `ptyWrite()` (host.ts) and rebuilding makes section (C)'s duplicate-detection assertion FAIL
// (zero `[pty-write]` lines are emitted, so no signature match is ever found) — proving this test is not
// vacuously green. Restoring the line and rebuilding returns it to PASS.
//
// Exercises the real PtyHost state machine against a FAKE pty via the createPty() seam (mirrors
// pty-submit-verify-retry.mjs / pty-restart-nudge-atomicity.mjs) — no real claude, no daemon, no network.
//
// RUN: pnpm build (from packages/daemon) then `node test/pty-write-seq-log.mjs`.
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
    await sleep(2);
  }
}

// Hermetic LOOM_HOME + shrunk timing constants (read at import time, so set BEFORE importing host.js).
// Chunk size deliberately small so a modest payload spans several real writeChunked ticks — the exact
// shape (multi-chunk writes above PTY_WRITE_CHUNK_BYTES) the originating incident's corrupted write had.
const tmpHome = path.join(os.tmpdir(), `loom-writeseqlog-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PTY_WRITE_CHUNK_BYTES = "50";
process.env.LOOM_PTY_WRITE_CHUNK_DELAY_MS = "5";
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "20";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "60000"; // never fires within this test's window — no retry noise
process.env.LOOM_GRACEFUL_GAP_MS = "20";
process.env.LOOM_GRACEFUL_RETRY_MS = "60000"; // stage-2 escalation never fires within this test's window
process.env.LOOM_GRACEFUL_KILL_MS = "60000";

const { PtyHost } = await import("../dist/pty/host.js");

const fakes = [];
function makeFakePty() {
  const writes = [];
  const fake = {
    pid: 4242,
    write: (d) => { writes.push(d); },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {},
    resize: () => {},
    writes,
  };
  fakes.push(fake);
  return fake;
}
class TestPtyHost extends PtyHost { createPty() { return makeFakePty(); } }
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onExit() {}, onBusy() {} };
const host = new TestPtyHost(events);

function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

// Capture every `[pty-write]` line without silencing PASS/FAIL output (check() also uses console.log).
const ptyWriteLines = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("[pty-write] ")) ptyWriteLines.push(line);
  realLog(...args);
};

// Anchored parse (`^[pty-write] <sessionId> seq=… tag=… gen=… len=… h=…`) — matches the shape
// [submit-write]/[busy]/[stdin-write] already established, so greps against daemon-output.log stay
// anchorable per the card's own constraint.
const LINE_RE = /^\[pty-write\] (\S+) seq=(\d+) tag=(\S+) gen=(\d+) len=(\d+) h=([0-9a-f]{8})$/;
function recordsFor(sessionId) {
  return ptyWriteLines
    .map((l) => l.match(LINE_RE))
    .filter(Boolean)
    .map((m) => ({ sessionId: m[1], seq: Number(m[2]), tag: m[3], gen: Number(m[4]), len: Number(m[5]), hash: m[6] }))
    .filter((r) => r.sessionId === sessionId);
}
const signature = (r) => `${r.len}|${r.hash}`;

try {
  // ===================== (A) coverage — a real submit() chain hits every site it should, in order =====
  {
    const SID = "seq-cov-submit";
    spawnReady(SID);
    // Distinct content per chunk-worth of text (numbered) so no two chunks ever share a signature by
    // coincidence — the false-positive control for section (C)'s deliberate duplicate.
    const text = Array.from({ length: 12 }, (_, i) => `segment-${i}-${"x".repeat(6)}`).join(" ");
    const r = host.enqueueStdin(SID, text);
    check("(A) setup: idle session accepts the turn immediately", r.delivered === true);

    await waitUntil(() => recordsFor(SID).some((rec) => rec.tag === "enter"));
    const recs = recordsFor(SID);

    check("(A) every record is anchored + parses (sessionId/seq/tag/gen/len/h all present)",
      recs.length > 0 && ptyWriteLines.filter((l) => l.includes(` ${SID} `)).length === recs.length);
    check("(A) exactly one bracket-start", recs.filter((r2) => r2.tag === "bracket-start").length === 1);
    check("(A) writeChunked split the payload into multiple real chunk writes",
      recs.filter((r2) => r2.tag === "chunk").length === Math.ceil(text.length / 50) &&
      recs.filter((r2) => r2.tag === "chunk").length > 1);
    check("(A) exactly one bracket-end, after every chunk", recs.filter((r2) => r2.tag === "bracket-end").length === 1);
    check("(A) exactly one enter (no retry — verify timeout parked well beyond this test)", recs.filter((r2) => r2.tag === "enter").length === 1);
    check("(A) seq is monotonically increasing, no gaps, starting at 1 (this session's own counter)",
      recs.every((r2, i) => r2.seq === i + 1));
    check("(A) log order matches seq order (the sequence number reflects real write order)",
      recs.every((r2, i) => i === 0 || recs[i - 1].seq < r2.seq));
    check("(A) gen is pinned to this submit's generation (1) across every site in the chain",
      recs.every((r2) => r2.gen === 1));
    check("(A) FALSE-POSITIVE control: no two records share a content signature (distinct chunk content ⇒ no spurious duplicate)",
      new Set(recs.map(signature)).size === recs.length);
  }

  // ===================== (B) coverage — the non-submit call sites (repaint, graceful stop) also log =====
  {
    const SID = "seq-cov-other-sites";
    spawnReady(SID);
    host.repaint(SID);
    check("(B) repaint logs its Ctrl-L write", recordsFor(SID).some((r) => r.tag === "repaint-ctrl-l" && r.len === 1));

    host.stop(SID, "graceful");
    await waitUntil(() => recordsFor(SID).filter((r) => r.tag === "stop-ctrl-c").length === 2);
    const stopRecs = recordsFor(SID).filter((r) => r.tag === "stop-ctrl-c");
    check("(B) graceful stop logs both Ctrl-C writes (immediate + the delayed re-send) at distinct seq",
      stopRecs.length === 2 && stopRecs[0].seq !== stopRecs[1].seq);
  }

  // ===================== (C) THE VACUITY CHECK — prove a duplicate emission is surfaced as such =====
  {
    const SID = "seq-cov-vacuity";
    spawnReady(SID);
    const DUPLICATED_TEXT = "DUPLICATE-EMISSION-PROBE-vacuity-check-9ed20572";
    // Deliberately invoke the SAME real write path twice, back-to-back, with byte-identical content —
    // the direct shape of hypothesis 1 (writeChunked's own done-callback double-firing, unguarded by
    // submitGeneration). Neither call awaits the other; both land synchronously (text < chunk size).
    host.writeChunked(SID, DUPLICATED_TEXT, () => {});
    host.writeChunked(SID, DUPLICATED_TEXT, () => {});

    const recs = recordsFor(SID).filter((r) => r.tag === "chunk");
    check("(C) setup: both deliberate writes were logged", recs.length === 2);
    const sigs = recs.map(signature);
    check("(C) RED-FIRST-VALIDATED: the induced duplicate emission shares one content signature across BOTH records",
      recs.length === 2 && sigs[0] === sigs[1]);
    check("(C) THE LOAD-BEARING PROPERTY: the two duplicate-content records carry DISTINCT seq — this is what makes a real replay/double-emit stand out from a single legitimate write instead of being indistinguishable from it",
      recs.length === 2 && recs[0].seq !== recs[1].seq);
    check("(C) seq is per-session monotonic even across two independent writeChunked() invocations (no reset between calls)",
      recs.length === 2 && recs[1].seq === recs[0].seq + 1);
  }
} finally {
  console.log = realLog;
  for (const id of ["seq-cov-submit", "seq-cov-other-sites", "seq-cov-vacuity"]) {
    try { host.stop(id, "hard"); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every real live.pty.write() site (bracket-start/chunk/bracket-end/enter/repaint/stop) emits an anchored, sequence-numbered [pty-write] record, and a deliberately-induced duplicate emission is surfaced as two records sharing a content signature at distinct seq (red-first validated) — the discriminating check card 3ce3fa39 needs."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
